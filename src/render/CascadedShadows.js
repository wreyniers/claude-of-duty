import * as THREE from 'three';
import { LAYER_WORLD } from '../core/Layers.js';

/**
 * Cascaded shadow maps for the sun.
 *
 * CONTRACT (Lighting owns the instance; other systems reach it as
 * `game.lighting.csm`):
 *   lights            : THREE.DirectionalLight[]  one per cascade, all in scene
 *   sun               : the cascade-0 light — this is the one carrying radiance
 *   update(camera, sunDir)  refit + snap every cascade for this frame
 *   patchMaterial(mat)      inject cascade select + PCSS into a lit material
 *   setCascadeCount(n) / setShadowDistance(m) / setDebug(bool)
 *   setSkyVisibility(soffit, open, power)  diffuse-IBL orientation weight
 *   stats             : { renders, refits, cascades }
 *
 * HOW IT WORKS
 * Each cascade is a real DirectionalLight so that Three's shadow pass keeps
 * doing the parts it is already good at: per-cascade frustum culling, alpha-test
 * depth materials, skinned casters, map allocation. What Three cannot do is pick
 * a cascade and filter it well, so the fragment side of the standard material is
 * rewritten: only cascade 0 adds the sun's radiance (the other lights exist
 * purely to carry a shadow map, and run at zero intensity so that even the
 * unpatched fallback path stays energy-correct), and the shadow term it uses is
 * a blend of the cascade the fragment lands in and its neighbour.
 *
 * Two things stop the classic shimmer. The slice is bounded by a *sphere*, which
 * is invariant under camera rotation, and both its radius and its centre are
 * quantised — radius to a step, centre to whole shadow texels along the light's
 * own axes — so panning the camera slides the depth map by integer texels
 * instead of resampling a slightly different grid every frame. That same
 * quantisation gives a free optimisation: if a cascade's fit is bit-identical to
 * last frame it only needs re-rendering to catch moving casters, so far cascades
 * can be staggered across frames.
 */

// 12-tap Poisson disk (unit radius), rotated per pixel so the 12 samples cover
// different angles on neighbouring pixels; 12 fixed taps alone band visibly.
const DISK_GLSL = `vec2[12](
		vec2( -0.3260, -0.4060 ), vec2( -0.8400, -0.0740 ), vec2( -0.6960,  0.4570 ),
		vec2( -0.2030,  0.6210 ), vec2(  0.9620, -0.1950 ), vec2(  0.4730, -0.4800 ),
		vec2(  0.5190,  0.7670 ), vec2(  0.1850, -0.8930 ), vec2(  0.5070,  0.0640 ),
		vec2(  0.8960,  0.4120 ), vec2( -0.3220, -0.9330 ), vec2( -0.7920, -0.5980 )
	)`;

const DEBUG_TINT = [
  'vec3( 1.0, 0.45, 0.40 )',
  'vec3( 0.45, 1.0, 0.50 )',
  'vec3( 0.45, 0.60, 1.0 )',
  'vec3( 1.0, 0.90, 0.40 )',
];

const CHUNK = 'lights_fragment_begin';
const DIR_BLOCK_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const DIR_BLOCK_END = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';

const MAPS_CHUNK = 'lights_fragment_maps';
const IBL_DIFFUSE_LINE = 'iblIrradiance += getIBLIrradiance( geometryNormal );';

export class CascadedShadows {
  constructor(game, opts = {}) {
    this.game = game;
    this.settings = game.settings;

    this.lights = [];
    this.sun = null;

    this.shadowDistance = opts.shadowDistance ?? 108;
    // Nearest cascade starts a little in front of the near plane; there is no
    // point spending texels on the 20 cm in front of the eye.
    this.shadowNear = opts.shadowNear ?? 0.55;
    // Practical split: 0 is uniform (wastes the near field), 1 is logarithmic
    // (starves the mid field where most of a firefight happens).
    this.lambda = opts.lambda ?? 0.72;
    // Apparent angular size of the sun, exaggerated ~6x over the real 0.0093 rad
    // because a physically correct penumbra is invisible at game distances.
    this.softness = opts.softness ?? 0.055;
    // Depth bias in shadow texels: constant + slope-scaled. Both are expressed
    // in texels so they follow each cascade's world texel size automatically.
    this.constantBias = opts.constantBias ?? 1.1;
    this.slopeBias = opts.slopeBias ?? 2.6;
    // Normal-offset bias, also in texels, applied by Three in the vertex shader.
    this.normalBias = opts.normalBias ?? 1.35;
    this.casterExtrude = opts.casterExtrude ?? 55;

    const soft = game.forge?.softwareGL === true;
    this.taps = soft ? 8 : 12;
    this.tapsFar = soft ? 5 : 8;
    // Blocker search only pays for itself where the penumbra is readable.
    this.pcssCascades = 2;

    this.stats = { renders: 0, refits: 0, cascades: 0 };
    this.debug = false;

    this.uniforms = {
      uCsmSplit: { value: new THREE.Vector4(1, 1, 1, 1) },
      uCsmBand: { value: new THREE.Vector4(1, 1, 1, 1) },
      uCsmTexel: { value: new THREE.Vector4(0.01, 0.01, 0.01, 0.01) },
      uCsmRange: { value: new THREE.Vector4(100, 100, 100, 100) },
      uCsmRadius: { value: new THREE.Vector4(1, 1.4, 2.0, 2.6) },
      uCsmRadiusMax: { value: new THREE.Vector4(4.5, 5.5, 6.5, 7.5) },
      uCsmMapSize: { value: new THREE.Vector4(2048, 2048, 1024, 1024) },
      uCsmParams: { value: new THREE.Vector4(this.constantBias, this.slopeBias, this.softness, this.shadowDistance) },
      // Ceiling on the slope-scaled bias, in metres. Without it the far cascades'
      // coarse texels ask for a metre of bias and the shadow slides off its owner.
      uCsmBiasMax: { value: new THREE.Vector4(0.05, 0.08, 0.14, 0.2) },
      /**
       * Orientation weight for the *diffuse* half of the IBL: (soffit, open sky,
       * falloff exponent), evaluated against Three's own hemisphere weight
       * `0.5 + 0.5 * worldNormal.y`.
       *
       * Sky's env cube is a dome and nothing else — no buildings, no ground
       * geometry, and its below-horizon band is 0.4x the horizon radiance, which
       * is brighter than paving reflects. So every surface in a walled square is
       * handed the irradiance of an unobstructed field, and at golden hour that
       * is worse than merely too much: the dome's brightest band is the horizon,
       * so the integral over a *vertical* normal's hemisphere came out 1.36x the
       * one over a horizontal normal. Measured on this preset it delivered 1.007
       * to a wall against 1.006 to the floor and 0.778 to a soffit — an inverted,
       * near-isotropic fill that cancelled the hemisphere light's orientation
       * step and left every surface in one band whatever way it faced.
       *
       * Occluding the diffuse integral and not the specular lobe is the honest
       * split rather than a convenience: a mirror direction is one ray that for a
       * visible surface mostly escapes, while the diffuse term is the whole
       * hemisphere, which is exactly what the geometry we do not put in the cube
       * blocks. It also costs nothing on the reflections the metals need.
       *
       * That one-way split is also why these are weights and not fractions, and
       * why the open-sky figure is allowed past 1. Lighting's envFillScale is held
       * at 0.64 to keep reflected sky off the oil drum's lid, and that trim lands
       * on diffuse and specular alike; multiplying it back here restores the fill
       * on the only half that was never the problem, and it is the only lever in
       * this renderer that can brighten shade without touching a highlight.
       *
       * Both figures went up again after four of five captures graded 1.5-2 stops
       * under. The soffit term moved most (0.45 -> 0.72) because down-facing
       * surfaces were the worst of it — an awning underside at rgb(32,31,26), an
       * interior ceiling at 44.8 — and because 0.45 was reading a soffit as though
       * the ground below it were as dark as the sky above is bright, which under a
       * golden-hour sun over pale paving it is not. Net of envFillScale a
       * sky-facing surface now takes 1.25 of the dome's diffuse irradiance and a
       * soffit 0.46, against 0.88 and 0.29. Past-unit on the open end is the
       * bounce off the sunlit facades that the dome cube does not contain; the
       * step between the two orientations narrows from 3.1:1 to 2.7:1, which is
       * still a plain orientation read and closer to what a walled square with a
       * bright floor actually delivers.
       */
      uCsmSkyVis: { value: new THREE.Vector3(0.72, 1.95, 3.2) },
      uCsmDebug: { value: 0 },
    };

    this._patched = [];
    this._glslKey = '';
    this._parsGlsl = '';
    this._dirGlsl = '';
    this._mapsGlsl = '';
    this._warned = false;

    this._fits = [];
    this._frame = 0;

    // Scratch: update() runs every frame and must not allocate.
    this._dir = new THREE.Vector3(0, 1, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._axisX = new THREE.Vector3();
    this._axisY = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._center = new THREE.Vector3();
  }

  async init() {
    this.setCascadeCount(THREE.MathUtils.clamp(this.settings.shadowCascades | 0 || 3, 1, 4));
    this.game.bus?.on('settings:changed', () => {
      this.setCascadeCount(THREE.MathUtils.clamp(this.settings.shadowCascades | 0 || 3, 1, 4));
    });
  }

  get count() {
    return this.lights.length;
  }

  /**
   * Only the outermost cascade drops to half resolution. Its slice is an order of
   * magnitude deeper than cascade 0's, so it is the one place where halving the
   * map costs nothing visible — and it is what keeps a software rasteriser from
   * drawing four full-resolution depth passes a frame.
   */
  _mapSizeFor(index, count) {
    const base = THREE.MathUtils.clamp(this.settings.shadowMapSize || 2048, 512, 4096);
    const cap = this.game.forge?.softwareGL === true ? 1024 : 4096;
    const scale = count > 2 && index === count - 1 ? 0.5 : 1;
    return THREE.MathUtils.clamp(Math.round(base * scale), 512, cap);
  }

  setCascadeCount(n) {
    if (n === this.lights.length) {
      let same = true;
      for (let i = 0; i < n; i++) same = same && this.lights[i].shadow.mapSize.x === this._mapSizeFor(i, n);
      if (same) return;
    }

    for (const l of this.lights) {
      l.shadow.map?.dispose();
      l.removeFromParent();
      l.target.removeFromParent();
    }
    this.lights.length = 0;
    this._fits.length = 0;

    const scene = this.game.scene;
    for (let i = 0; i < n; i++) {
      const light = new THREE.DirectionalLight(0xffffff, i === 0 ? 3 : 0);
      light.name = `sun-cascade-${i}`;
      light.castShadow = true;
      light.shadow.mapSize.setScalar(this._mapSizeFor(i, n));
      // Bias is applied per fragment in the injected sampler, not here; leaving
      // Three's constant bias in would double-count it.
      light.shadow.bias = 0;
      light.shadow.normalBias = 0.02;
      light.shadow.intensity = 1;
      light.shadow.autoUpdate = false; // staggered by hand, see update()
      light.shadow.needsUpdate = true;
      // The view model lives on its own layer; it must never appear in a world
      // shadow map, or the player's arms shadow the floor in front of them.
      light.shadow.camera.layers.set(LAYER_WORLD);
      light.matrixAutoUpdate = true;
      scene.add(light, light.target);
      this.lights.push(light);

      this._fits.push({
        center: new THREE.Vector3(),
        radius: 0,
        texel: 0.01,
        range: 100,
        near: 0,
        far: 100,
        interval: i === 0 ? 1 : i + 1,
        dirty: true,
      });
    }

    this.sun = this.lights[0];
    this.stats.cascades = n;
    this._buildGlsl();
    for (const mat of this._patched) mat.needsUpdate = true;
  }

  setShadowDistance(m) {
    this.shadowDistance = Math.max(20, m);
  }

  setDebug(on) {
    this.debug = !!on;
    this.uniforms.uCsmDebug.value = on ? 1 : 0;
  }

  /** Uniform-only, so no recompile: safe to drive from a settings change. */
  setSkyVisibility(soffit, open, power) {
    this.uniforms.uCsmSkyVis.value.set(soffit, open, power);
  }

  /* ------------------------------------------------------------ shader side */

  _buildGlsl() {
    const n = this.count;
    const c = ['x', 'y', 'z', 'w'];
    const key = `${n}-${this.taps}-${this.tapsFar}-${this.pcssCascades}`;
    if (key === this._glslKey) return;
    this._glslKey = key;

    const filter = (taps) => `
float csmFilter${taps}( sampler2D map, vec3 co, float radius, float mapSize, float zb, vec2 rot ) {
	float k = radius / mapSize;
	float sum = 0.0;
	for ( int t = 0; t < ${taps}; t ++ ) {
		vec2 o = csmDisk[ t ];
		sum += texture2DCompare( map, co.xy + vec2( o.x * rot.x - o.y * rot.y, o.x * rot.y + o.y * rot.x ) * k, co.z - zb );
	}
	return sum * ${(1 / taps).toFixed(6)};
}`;

    // Outside the shadow-map guards: an unlit-by-shadows material still receives
    // the env map, so it still needs the weight, and the uniform has to be
    // declared wherever the function is.
    let src = `
uniform vec3 uCsmSkyVis;
float csmSkyVisibility( float worldNy ) {
	float w = clamp( 0.5 + 0.5 * worldNy, 0.0, 1.0 );
	return mix( uCsmSkyVis.x, uCsmSkyVis.y, pow( w, uCsmSkyVis.z ) );
}

#ifdef USE_SHADOWMAP
#if NUM_DIR_LIGHT_SHADOWS >= ${n}
#define CSM_ACTIVE
uniform vec4 uCsmSplit;
uniform vec4 uCsmBand;
uniform vec4 uCsmTexel;
uniform vec4 uCsmRange;
uniform vec4 uCsmRadius;
uniform vec4 uCsmRadiusMax;
uniform vec4 uCsmMapSize;
uniform vec4 uCsmParams;
uniform vec4 uCsmBiasMax;
uniform float uCsmDebug;

vec3 gCsmTint = vec3( 1.0 );

const vec2 csmDisk[12] = ${DISK_GLSL};
${filter(this.taps)}
${this.taps === this.tapsFar ? '' : filter(this.tapsFar)}
// Average depth of whatever is between this fragment and the sun. The distance
// from it to the receiver is what sets the penumbra width, which is the whole
// reason a shadow can be sharp where an object touches the floor and soft two
// metres up the wall behind it.
float csmBlocker( sampler2D map, vec3 co, float radius, float mapSize, float zb ) {
	float k = radius / mapSize;
	float sum = 0.0;
	float hits = 0.0;
	for ( int t = 0; t < 4; t ++ ) {
		float d = unpackRGBAToDepth( texture2D( map, co.xy + csmDisk[ t * 3 ] * k ) );
		if ( d < co.z - zb ) { sum += d; hits += 1.0; }
	}
	float d = unpackRGBAToDepth( texture2D( map, co.xy ) );
	if ( d < co.z - zb ) { sum += d; hits += 1.0; }
	return hits > 0.0 ? sum / hits : -1.0;
}
`;

    for (let i = 0; i < n; i++) {
      const s = c[i];
      const pcss = i < this.pcssCascades;
      const taps = i < 2 ? this.taps : this.tapsFar;
      src += `
float csmCascade${i}( float slope, vec2 rot ) {
	vec4 sc = vDirectionalShadowCoord[ ${i} ];
	vec3 co = sc.xyz / sc.w;
	if ( co.z > 1.0 || any( lessThan( co.xy, vec2( 0.0 ) ) ) || any( greaterThan( co.xy, vec2( 1.0 ) ) ) ) return 1.0;
	// Slope-scaled: a surface seen edge-on by the sun spans many depth units per
	// texel, and biasing for the worst case everywhere is what peter-pans.
	float zb = min( uCsmTexel.${s} * ( uCsmParams.x + slope * uCsmParams.y ), uCsmBiasMax.${s} ) / uCsmRange.${s};
	float r = uCsmRadius.${s};`;
      if (pcss) {
        src += `
	float bl = csmBlocker( directionalShadowMap[ ${i} ], co, uCsmRadiusMax.${s}, uCsmMapSize.${s}, zb );
	if ( bl < 0.0 ) return 1.0; // nothing occluding: skip ${taps} taps on the lit majority of the frame
	r = clamp( ( co.z - bl ) * uCsmRange.${s} * uCsmParams.z / uCsmTexel.${s}, uCsmRadius.${s}, uCsmRadiusMax.${s} );`;
      }
      src += `
	return csmFilter${taps}( directionalShadowMap[ ${i} ], co, r, uCsmMapSize.${s}, zb, rot );
}`;
    }

    src += `
float csmShadow( vec3 nrm, vec3 ldir, float depth ) {
	float ndl = clamp( dot( nrm, ldir ), 0.0, 1.0 );
	float slope = clamp( sqrt( 1.0 - ndl * ndl ) / max( ndl, 0.2 ), 0.0, 3.0 );
	// Interleaved gradient noise: a per-pixel kernel rotation that costs one
	// fract chain and turns the 12-tap banding into dither the AA pass eats.
	float a = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	vec2 rot = vec2( cos( a ), sin( a ) );
	float s = 1.0;
`;
    for (let i = 0; i < n; i++) {
      const s = c[i];
      const last = i === n - 1;
      // The last cascade is the fallthrough: anything past its split is faded out
      // below, so there is no point testing for it.
      const head = last ? (i ? 'else {' : '	{') : `${i ? 'else ' : '	'}if ( depth < uCsmSplit.${s} ) {`;
      src += `${i ? ' ' : ''}${head}
		s = csmCascade${i}( slope, rot );
		gCsmTint = ${DEBUG_TINT[i]};`;
      if (!last) {
        src += `
		float b${i} = uCsmBand.${s};
		if ( depth > uCsmSplit.${s} - b${i} ) {
			// Overlap band: both cascades are valid here, so cross-fade rather
			// than switch — a hard switch shows as a seam wherever the two
			// cascades disagree about penumbra width.
			s = mix( s, csmCascade${i + 1}( slope, rot ), clamp( ( depth - ( uCsmSplit.${s} - b${i} ) ) / b${i}, 0.0, 1.0 ) );
		}`;
      }
      src += `
	}`;
    }
    src += `
	// Let the last cascade dissolve rather than end on a straight edge.
	return mix( s, 1.0, smoothstep( uCsmParams.w * 0.86, uCsmParams.w, depth ) );
}
#endif
#endif
`;
    this._parsGlsl = `#define CSM_CASCADES ${n}\n${src}`;

    const chunk = THREE.ShaderChunk[CHUNK];
    const a = chunk.indexOf(DIR_BLOCK_START);
    const b = chunk.indexOf(DIR_BLOCK_END);
    this._dirGlsl = a > 0 && b > a ? chunk.slice(0, a) + DIR_LIGHT_BLOCK + chunk.slice(b) : '';

    // Rewrite the one line rather than restate the chunk, so a Three release that
    // adds a lightmap or anisotropy branch to it keeps working.
    const maps = THREE.ShaderChunk[MAPS_CHUNK];
    this._mapsGlsl = maps.includes(IBL_DIFFUSE_LINE)
      ? maps.replace(
          IBL_DIFFUSE_LINE,
          'iblIrradiance += getIBLIrradiance( geometryNormal ) * csmSkyVisibility( inverseTransformDirection( geometryNormal, viewMatrix ).y );'
        )
      : '';
  }

  /**
   * Chain onto whatever the material already does — AssetForge assigns its own
   * onBeforeCompile for macro variation, and clobbering it would strip the
   * world-space grime off every surface in the level.
   */
  patchMaterial(mat) {
    if (!mat || mat.userData.csm) return false;
    const lit =
      mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial;
    if (!lit) return false;
    if (!this._dirGlsl) {
      if (!this._warned) {
        this._warned = true;
        console.warn('[csm] lights_fragment_begin layout changed; falling back to stock shadows');
      }
      return false;
    }

    mat.userData.csm = true;
    const prevCompile = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey;

    mat.onBeforeCompile = (shader, renderer) => {
      if (prevCompile) prevCompile.call(mat, shader, renderer);
      for (const k in this.uniforms) shader.uniforms[k] = this.uniforms[k];
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <shadowmap_pars_fragment>', `#include <shadowmap_pars_fragment>\n${this._parsGlsl}`)
        .replace(`#include <${CHUNK}>`, this._dirGlsl);
      if (this._mapsGlsl) {
        shader.fragmentShader = shader.fragmentShader.replace(`#include <${MAPS_CHUNK}>`, this._mapsGlsl);
      }
    };
    // onBeforeCompile is invisible to Three's program cache, so a patched and an
    // otherwise identical unpatched material would share one program.
    mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|csm${this._glslKey}`;
    mat.needsUpdate = true;
    this._patched.push(mat);
    return true;
  }

  /* -------------------------------------------------------------- fit + snap */

  update(camera, sunDir) {
    const n = this.count;
    if (!n) return;
    this._frame++;

    this._dir.copy(sunDir);
    if (this._dir.lengthSq() < 1e-6) this._dir.set(0.3, 0.9, 0.2);
    this._dir.normalize();
    // Three builds the shadow view with lookAt and the camera's own up vector;
    // pick the same fallback it would need when the sun is at the zenith.
    const upZ = Math.abs(this._dir.y) > 0.985;
    this._up.set(0, upZ ? 0 : 1, upZ ? 1 : 0);

    this._axisX.crossVectors(this._up, this._dir).normalize();
    this._axisY.crossVectors(this._dir, this._axisX).normalize();

    const e = camera.matrixWorld.elements;
    this._fwd.set(-e[8], -e[9], -e[10]).normalize();

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const tanH = tanV * camera.aspect;
    const k2 = tanH * tanH + tanV * tanV;

    const near = Math.max(camera.near, this.shadowNear);
    const far = Math.max(near + 1, this.shadowDistance);
    const u = this.uniforms;
    u.uCsmParams.value.set(this.constantBias, this.slopeBias, this.softness, far);

    let prevSplit = near;
    for (let i = 0; i < n; i++) {
      const f = this._splitAt(i + 1, n, near, far);
      const fit = this._fits[i];

      // Bounding sphere of the slice, centred on the view axis: the one fit that
      // does not change size or shape as the camera turns.
      let zc = 0.5 * (prevSplit + f) * (1 + k2);
      let r;
      if (zc >= f) {
        zc = f;
        r = f * Math.sqrt(k2);
      } else {
        const dz = zc - prevSplit;
        r = Math.sqrt(prevSplit * prevSplit * k2 + dz * dz);
      }
      r *= 1.02;

      // Quantise the radius, or the world size of a texel drifts every frame and
      // snapping the centre to it buys nothing.
      const step = Math.max(0.25, r * 0.0625);
      r = Math.ceil(r / step) * step;

      const size = this.lights[i].shadow.mapSize.x;
      const texel = (2 * r) / size;

      this._center.copy(camera.position).addScaledVector(this._fwd, zc);
      // Snap along the light's own axes so the depth map slides by whole texels.
      const sx = this._center.dot(this._axisX);
      const sy = this._center.dot(this._axisY);
      this._center
        .addScaledVector(this._axisX, Math.round(sx / texel) * texel - sx)
        .addScaledVector(this._axisY, Math.round(sy / texel) * texel - sy);

      const changed =
        Math.abs(fit.radius - r) > 1e-5 || fit.center.distanceToSquared(this._center) > 1e-8 || fit.texel !== texel;

      // A cascade whose fit is unchanged only needs redrawing to catch movers, so
      // the far ones can lag a few frames. Cascade 0 always redraws: that is the
      // one carrying character contact shadows.
      const due = changed || this._frame % fit.interval === 0;
      const light = this.lights[i];
      light.shadow.needsUpdate = due;
      if (!due) {
        prevSplit = f;
        continue;
      }
      this.stats.renders++;
      if (changed) this.stats.refits++;

      fit.center.copy(this._center);
      fit.radius = r;
      fit.texel = texel;

      // Pull the light back far enough that a caster above the slice still shows
      // up in the map, and keep near/far tight around it for depth precision.
      const back = r + this.casterExtrude;
      light.position.copy(this._center).addScaledVector(this._dir, back);
      light.target.position.copy(this._center);
      light.shadow.camera.up.copy(this._up);

      const cam = light.shadow.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 0.05;
      cam.far = back + r + 2;
      cam.updateProjectionMatrix();
      fit.near = cam.near;
      fit.far = cam.far;
      fit.range = cam.far - cam.near;

      // Normal-offset bias is a world-space push along the surface normal, so it
      // has to track this cascade's texel size or it either does nothing at 60 m
      // or lifts the shadow off the caster at 2 m. Capped for the same reason the
      // depth bias is: past ~10 cm it starts eating the contact shadow.
      light.shadow.normalBias = Math.min(texel * this.normalBias, 0.1);

      const comp = COMPONENTS[i];
      u.uCsmSplit.value[comp] = f;
      u.uCsmBiasMax.value[comp] = THREE.MathUtils.clamp(texel * 3.5, 0.015, 0.2);
      // Overlap band widens with the cascade so it is always a few texels across.
      u.uCsmBand.value[comp] = Math.max(0.6, (f - prevSplit) * 0.12);
      u.uCsmTexel.value[comp] = texel;
      u.uCsmRange.value[comp] = fit.range;
      u.uCsmMapSize.value[comp] = size;
      u.uCsmRadius.value[comp] = 1.0 + i * 0.55;
      u.uCsmRadiusMax.value[comp] = 4.0 + i * 1.1;

      prevSplit = f;
    }

    // Unused vector components must still read as "beyond the last cascade".
    for (let i = n; i < 4; i++) {
      const comp = COMPONENTS[i];
      u.uCsmSplit.value[comp] = far;
      u.uCsmBand.value[comp] = 1;
      const last = COMPONENTS[n - 1];
      u.uCsmTexel.value[comp] = u.uCsmTexel.value[last];
      u.uCsmRange.value[comp] = u.uCsmRange.value[last];
      u.uCsmMapSize.value[comp] = u.uCsmMapSize.value[last];
      u.uCsmBiasMax.value[comp] = u.uCsmBiasMax.value[last];
    }
  }

  /** Mixed logarithmic / uniform split, the standard practical scheme. */
  _splitAt(i, n, near, far) {
    const p = i / n;
    const log = near * Math.pow(far / near, p);
    const uni = near + (far - near) * p;
    return this.lambda * log + (1 - this.lambda) * uni;
  }

  dispose() {
    for (const l of this.lights) {
      l.shadow.map?.dispose();
      l.removeFromParent();
      l.target.removeFromParent();
    }
    this.lights.length = 0;
  }
}

const COMPONENTS = ['x', 'y', 'z', 'w'];

/**
 * Replacement for the directional-light section of lights_fragment_begin.
 * Cascade 0 is the only one that adds radiance; the rest are shadow-map
 * carriers. Any directional light beyond the cascade set keeps stock behaviour,
 * so a sibling adding a fill light does not break.
 */
const DIR_LIGHT_BLOCK = `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#if defined( CSM_ACTIVE )
	float csmS;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

	#if defined( CSM_ACTIVE ) && ( UNROLLED_LOOP_INDEX < CSM_CASCADES )

		#if ( UNROLLED_LOOP_INDEX == 0 )

			directionalLight = directionalLights[ 0 ];
			getDirectionalLightInfo( directionalLight, directLight );

			csmS = ( directLight.visible && receiveShadow ) ? csmShadow( geometryNormal, directLight.direction, vViewPosition.z ) : 1.0;
			directLight.color *= ( uCsmDebug > 0.5 ) ? mix( gCsmTint, gCsmTint * 0.25, 1.0 - csmS ) : vec3( csmS );

			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		#endif

	#else

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	#endif

	}
	#pragma unroll_loop_end

#endif

`;
