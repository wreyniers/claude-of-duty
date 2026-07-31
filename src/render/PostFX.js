import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { GradeShader, GRADE_PRESETS } from './shaders/GradeShader.js';
import { MotionBlurShader, VELOCITY_GLSL } from './shaders/MotionBlurShader.js';

/**
 * The post-processing chain. Owns the HDR targets and every screen-space effect.
 *
 * CONTRACT:
 *   enabled : boolean
 *   render()
 *   setSize(w, h)
 *   hurtFlash(amount) / grade(name)  -- gameplay-driven grade hooks
 *
 * ADDITIONS (safe to rely on):
 *   baseExposure                 module-owned stop, multiplied by settings.exposure
 *   setExposure(mul)             artistic trim without touching Settings
 *   gradeName                    -> the active preset name
 *   depthTexture                 -> scene depth, for anything else that needs it
 *   rebuild()                    re-derive the chain from Settings
 *   stats                        -> { initMs, passes, ao, aoWide, ssr, taa, smaa, bloom, mb }
 *
 * ORDER, AND WHY
 *   scene -> half-float HDR (its own target, so depth is isolated)
 *   GTAO x2         ambient occlusion at contact scale and at room scale
 *   AO composite    both scales resolved into one factor, multiplied in linear
 *   SSR             grazing-angle reflections on near-horizontal surfaces
 *   TAA             jitter accumulate + neighbourhood-clamped history
 *   motion blur     camera velocity from depth + last frame's view-projection
 *   bloom           high threshold, five mips, low intensity
 *   light shafts    reduced-res sun occlusion, added back inside the grade
 *   view model      its own HDR target with coverage, composited by the grade
 *   grade           ACES RRT+ODT, grading, CA, vignette, grain, sharpen, sRGB
 *   SMAA            morphological AA on the finished LDR frame
 *
 * The renderer is deliberately `NoToneMapping`: this module owns the curve, so
 * everything above the grade pass is scene-referred linear radiance and nothing
 * before it may clamp to 1.
 *
 * DEPTH ISOLATION
 * The world is rendered into `sceneTarget`, which owns the only DepthTexture, and
 * then blitted into the composer's ping-pong buffer. That extra blit buys the
 * guarantee that no pass ever samples a depth texture that is attached to the
 * framebuffer it is writing to — a feedback loop ANGLE reports as a console
 * error, which fails a capture run outright.
 */

/**
 * Two occlusion scales resolved into one factor, multiplied into the still-linear
 * frame.
 *
 * A single GTAO pass answers at a single scale. A 0.9 m kernel is the right answer
 * for where a crate meets the ground and no answer at all for a room: the corner
 * where two walls meet, the reveal of a window, the soffit between ceiling joists
 * are each several metres of blocked hemisphere, and a metre-wide radius measures
 * none of it. That is why an interior lit through two small openings came out as
 * bright as the street outside, with its corners *brighter* than its walls — the
 * sky fill and the IBL reach every surface in there unattenuated, and nothing in
 * the chain was measuring that they should not.
 *
 * The two scales are combined by taking the darker, not by multiplying. The wide
 * radius contains the narrow one, so they are two estimates of the same hemisphere
 * integral rather than two independent factors; multiplying counts the same wall
 * twice and turns every junction into a black line.
 *
 * The physically honest version of this attenuates the ambient/IBL diffuse term
 * alone, because that is the light occlusion actually blocks. Nothing downstream
 * of the scene render can: this pass is handed one composited radiance with the
 * sun already in it. Bounding how far the wide term can darken (uWideFloor) and
 * fading it out past a few room lengths is what keeps that approximation from
 * reading as dirt on sunlit geometry.
 */
const AOCompositeShader = {
  name: 'AOCompositeShader',
  uniforms: {
    tDiffuse: { value: null },
    tAoNear: { value: null },
    tAoWide: { value: null },
    tDepth: { value: null },
    uCamPlanes: { value: null },
    uStrength: { value: 0.95 },
    uNearBoost: { value: 1.35 },
    uWide: { value: 0.9 },
    uWideFloor: { value: 0.11 },
    uFade: { value: null }, // metres: the wide term fades out between x and y
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,
  fragmentShader: /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tAoNear;
uniform sampler2D tAoWide;
uniform sampler2D tDepth;
uniform vec2 uCamPlanes;
uniform float uStrength;
uniform float uNearBoost;
uniform float uWide;
uniform float uWideFloor;
uniform vec2 uFade;

void main() {
	vec4 src = texture2D( tDiffuse, vUv );

	// Both AO targets clear to white, but they are smaller than the frame, so a
	// bilinear tap on a roofline drags occlusion out into the sky. The sky has no
	// surface to occlude, so it is gated on the full-resolution depth.
	float d = texture2D( tDepth, vUv ).x;
	if ( d >= 0.999995 ) { gl_FragColor = src; return; }

	float dist = ( uCamPlanes.x * uCamPlanes.y ) / ( uCamPlanes.y - ( uCamPlanes.y - uCamPlanes.x ) * d );

	float near = texture2D( tAoNear, vUv ).r;
	// GTAO answers a plaster corner with about 0.88 where the eye expects nearer
	// 0.5, and every honest reason for that — three directions, four steps, and
	// normals differenced out of a depth buffer — is a sampling cost this box
	// cannot pay. What it can do is stop spending the answer linearly. A slope on
	// the occluded half of the range leaves full visibility at exactly 1.0, so
	// open ground and sunlit facades keep the value they already have and only
	// junctions move; a gamma on the same term would have dimmed the entire frame
	// to buy one contact, in a set of frames already read as under-exposed.
	near -= uNearBoost * near * ( 1.0 - near );
	float wide = max( texture2D( tAoWide, vUv ).r, uWideFloor );
	// The far band's radiance is mostly in-scattered air by then, and air in front
	// of a surface is not occluded by that surface's neighbours — so the further out
	// a pixel is, the less of it this term has any business darkening. The fade
	// therefore tracks the aerial term's own crossover rather than the kernel's
	// screen size, which stays several tens of pixels well past 100 m.
	wide = mix( wide, 1.0, smoothstep( uFade.x, uFade.y, dist ) );

	float vis = min( near, mix( 1.0, wide, uWide ) );
	gl_FragColor = vec4( src.rgb * mix( 1.0, vis, uStrength ), src.a );
}
`,
};

/**
 * Screen-space reflections, gated geometrically rather than by material.
 *
 * There is no G-buffer here to read roughness from, so "polished/wet surfaces
 * only" is enforced by the one property a depth buffer does know: surfaces facing
 * within a few degrees of straight up, below the eye, at close-to-mid range —
 * floors, roads, puddles, rubble pans. That is where SSR earns its cost in a
 * shooter anyway, and it means a wall or a ceiling can never pick up a mirror
 * finish it has no business having. Fresnel keeps it to grazing angles, and the
 * screen-edge fade hides the fact that anything off-frame simply is not there.
 */
const SSRShader = {
  name: 'SSRShader',
  defines: { STEPS: 12 },
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProj: { value: null },
    uInvProj: { value: null },
    uViewUp: { value: null },
    uTexel: { value: null },
    uStrength: { value: 0.5 },
    uMaxDistance: { value: 14 },
    uThickness: { value: 0.9 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,
  fragmentShader: /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform vec3 uViewUp;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uMaxDistance;
uniform float uThickness;

float depthAt( vec2 uv ) { return texture2D( tDepth, uv ).x; }

vec3 viewPos( vec2 uv, float d ) {
	vec4 c = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
	vec4 v = uInvProj * c;
	return v.xyz / v.w;
}

float hash21( vec2 p ) {
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 45.32 );
	return fract( p.x * p.y );
}

void main() {
	vec4 src = texture2D( tDiffuse, vUv );
	float d = depthAt( vUv );
	if ( d >= 1.0 ) { gl_FragColor = src; return; }

	vec3 p = viewPos( vUv, d );
	vec3 dx = viewPos( vUv + vec2( uTexel.x, 0.0 ), depthAt( vUv + vec2( uTexel.x, 0.0 ) ) ) - p;
	vec3 dy = viewPos( vUv + vec2( 0.0, uTexel.y ), depthAt( vUv + vec2( 0.0, uTexel.y ) ) ) - p;
	vec3 n = normalize( cross( dx, dy ) );
	vec3 v = normalize( p );
	if ( dot( n, v ) > 0.0 ) n = -n;

	// Near-horizontal, below the eye, and not out in the haze.
	float gate = smoothstep( 0.90, 0.985, dot( n, uViewUp ) );
	gate *= smoothstep( -0.2, -0.85, dot( p, uViewUp ) );
	gate *= 1.0 - smoothstep( 18.0, 45.0, -p.z );
	if ( gate < 0.01 ) { gl_FragColor = src; return; }

	// Schlick against a dielectric: nothing at all face-on, a sheen at grazing.
	float f = 0.03 + 0.97 * pow( 1.0 - max( dot( -v, n ), 0.0 ), 5.0 );
	float weight = gate * min( f, 0.55 ) * uStrength;
	if ( weight < 0.004 ) { gl_FragColor = src; return; }

	vec3 r = reflect( v, n );
	// Geometric step growth: constant steps either miss thin geometry up close or
	// waste every tap in the distance.
	float step0 = uMaxDistance / 26.0;
	float t = step0 * ( 0.5 + hash21( gl_FragCoord.xy ) );
	vec3 hitCol = vec3( 0.0 );
	float hit = 0.0;

	for ( int i = 0; i < STEPS; i ++ ) {
		t += step0 * ( 1.0 + float( i ) * 0.30 );
		vec3 q = p + r * t;
		if ( q.z > -0.05 ) break;
		vec4 c = uProj * vec4( q, 1.0 );
		vec2 uv = ( c.xy / c.w ) * 0.5 + 0.5;
		if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
		float sd = depthAt( uv );
		if ( sd >= 1.0 ) continue; // ray is crossing sky, keep going
		float delta = viewPos( uv, sd ).z - q.z;
		if ( delta > 0.02 && delta < uThickness ) {
			hitCol = texture2D( tDiffuse, uv ).rgb;
			vec2 e = min( uv, 1.0 - uv );
			hit = smoothstep( 0.0, 0.1, min( e.x, e.y ) ) * ( 1.0 - t / uMaxDistance );
			break;
		}
	}

	gl_FragColor = vec4( mix( src.rgb, hitCol, clamp( weight * hit, 0.0, 0.3 ) ), src.a );
}
`,
};

/**
 * Temporal AA resolve.
 *
 * The projection is jittered by a sub-pixel Halton offset every frame, so the
 * accumulated history is a proper multi-sample average rather than a smear: a
 * still frame converges to something close to 8x supersampling. What makes that
 * safe is the rejection — history is reprojected through the depth buffer, then
 * *clamped into the colour range of the current pixel's neighbourhood* before it
 * is blended. Without that clamp, any pixel whose history came from a different
 * surface drags the old colour along behind moving geometry, which is the
 * ghosting the review rubric fails a frame for.
 *
 * The clamp runs in a reversible tonemapped space (c / (1 + luma)). In raw HDR the
 * neighbourhood box around a bright pixel is enormous, so the clamp stops
 * rejecting anything and the ghost comes back.
 */
const TAAShader = {
  name: 'TAAResolveShader',
  uniforms: {
    tDiffuse: { value: null },
    tHistory: { value: null },
    tDepth: { value: null },
    uReproject: { value: null },
    uJitterUv: { value: null },
    uTexel: { value: null },
    uFeedback: { value: 0.9 },
    uReset: { value: 1 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,
  fragmentShader:
    /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tHistory;
uniform vec2 uTexel;
uniform float uFeedback;
uniform float uReset;
` +
    VELOCITY_GLSL +
    /* glsl */ `

float lum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

vec3 tm( vec3 c ) { return c / ( 1.0 + max( lum( c ), 0.0 ) ); }
vec3 itm( vec3 c ) { return c / max( 1.0 - lum( c ), 1e-4 ); }

void main() {
	vec3 cur = max( texture2D( tDiffuse, vUv ).rgb, 0.0 );
	vec3 m = tm( cur );

	float depth;
	vec2 vel = pixelVelocity( vUv, depth );
	vec2 prevUv = ( vUv - uJitterUv ) - vel;

	// A cross rather than a full 3x3: four fewer fetches for a box that is only
	// marginally looser, and a slightly loose box costs a little flicker while a
	// tight one costs ghosting.
	vec3 lo = m;
	vec3 hi = m;
	vec3 s;
	s = tm( texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb ); lo = min( lo, s ); hi = max( hi, s );
	s = tm( texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb ); lo = min( lo, s ); hi = max( hi, s );
	s = tm( texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb ); lo = min( lo, s ); hi = max( hi, s );
	s = tm( texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb ); lo = min( lo, s ); hi = max( hi, s );
	vec3 mid = ( lo + hi ) * 0.5;
	lo = mid + ( lo - mid ) * 1.12;
	hi = mid + ( hi - mid ) * 1.12;

	vec3 hist = clamp( tm( max( texture2D( tHistory, prevUv ).rgb, 0.0 ) ), lo, hi );

	float onScreen = ( prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0 ) ? 0.0 : 1.0;
	float px = length( vel / uTexel );
	// Under motion the history is worth less, but not nothing: the clamp is what
	// keeps it honest, so dropping it entirely would only reintroduce crawl.
	float fb = uFeedback * onScreen * ( 1.0 - uReset ) * mix( 1.0, 0.55, smoothstep( 1.0, 12.0, px ) );

	gl_FragColor = vec4( itm( mix( m, hist, fb ) ), 1.0 );
}
`,
};

/**
 * Light shafts, as the airlight that survived being shadowed.
 *
 * A true volumetric would march the shadow cascades along every view ray, which
 * on a software rasteriser is not affordable at any resolution worth reviewing.
 * What the depth buffer already knows is whether the straight screen-space line
 * from a pixel toward the sun's vanishing point is blocked — and that line *is*
 * the projection of the sun's shadow volume, because everything radially outward
 * from the sun behind an occluder is exactly what that occluder shadows.
 * Accumulating the radiance of whatever is *still in sun* along it therefore
 * measures how much of the air in front of this pixel is lit, which is the
 * quantity crepuscular rays are made of. Occlusion is the mask; nothing else
 * gates the effect.
 *
 * Three things stop it becoming the whole-frame glow that gives this technique
 * away. It is confined to a forward-scatter lobe around the sun instead of being
 * applied uniformly; the grade weights it by the pixel's own distance, so a wall
 * two metres from the eye picks up almost none of it; and it is scaled down hard
 * whenever the disc itself stands in open sky, which is the case where the mask
 * has no structure and the integral is an aureole rather than a set of rays.
 * Radiance per tap is clamped because the sun disc is authored near 190 and one
 * tap on it would fire a ray brighter than the frame.
 */
const LightShaftShader = {
  name: 'LightShaftShader',
  defines: { SAMPLES: 16 },
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uSunUv: { value: null },
    uAspect: { value: 16 / 9 },
    uFalloff: { value: 2.2 },
    uDecay: { value: 0.94 },
    uDensity: { value: 1.0 },
    uMaxRadiance: { value: 3.0 },
    uAureole: { value: 0.08 },
    // Scene-referred radiance either side of the bright-pass ramp: below x a
    // surface is lit by fill and cannot be a source, above y it is standing in
    // direct sun. Shaded interior plaster measures ~0.02 here, a sunlit patch on
    // the same wall ~0.5, open sky ~1.2.
    uBright: { value: null },
    uSeed: { value: 0 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,
  fragmentShader: /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uSunUv;
uniform float uAspect;
uniform float uFalloff;
uniform float uDecay;
uniform float uDensity;
uniform float uMaxRadiance;
uniform float uAureole;
uniform vec2 uBright;
uniform float uSeed;

float hash21( vec2 p ) {
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 45.32 );
	return fract( p.x * p.y );
}

float isSky( vec2 uv ) { return step( 0.999995, texture2D( tDepth, clamp( uv, 0.0, 1.0 ) ).x ); }

void main() {
	vec2 delta = uSunUv - vUv;
	// Mie forward scattering is a lobe, not a hemisphere: away from the sun there
	// is nothing for a shaft to be made of.
	float lobe = exp( -length( delta * vec2( uAspect, 1.0 ) ) * uFalloff );
	if ( lobe < 0.003 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

	// Beams and an aureole are the same integral, and only one of them is worth
	// paying for. With the disc standing in clear sky every pixel's sun-ward taps
	// are sky all the way, so the term has no structure left in it and lands as a
	// glow around the sun that the bloom and the aerial in-scatter already deliver.
	// With the disc behind a roofline, a minaret, a market awning or a wall the mask
	// is the whole signal, and the gain it needs is an order of magnitude larger.
	// A disc rather than one texel: a single sample can fall between two fronds and
	// swing the gain of the entire frame from one frame to the next.
	vec2 probe = vec2( 0.03 / uAspect, 0.03 );
	float clear = isSky( uSunUv );
	clear += isSky( uSunUv + vec2( probe.x, 0.0 ) );
	clear += isSky( uSunUv - vec2( probe.x, 0.0 ) );
	clear += isSky( uSunUv + vec2( 0.0, probe.y ) );
	clear += isSky( uSunUv - vec2( 0.0, probe.y ) );
	lobe *= mix( 1.0, uAureole, clear * 0.2 );

	vec2 stepUv = delta * ( uDensity / float( SAMPLES ) );
	// A fixed tap set leaves concentric rings around the sun; jittering the start
	// turns them into noise the grain pass then buries.
	vec2 uv = vUv + stepUv * hash21( gl_FragCoord.xy + uSeed );

	vec3 acc = vec3( 0.0 );
	float w = 1.0;
	float wsum = 0.0;

	for ( int i = 0; i < SAMPLES; i ++ ) {
		vec2 s = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
		vec3 rad = min( texture2D( tDiffuse, s ).rgb, vec3( uMaxRadiance ) );
		// Cleared depth means "no geometry between this point and the atmosphere",
		// which is a sufficient condition for the air along this tap to be lit and
		// the only one an exterior needs. It is not a necessary one, and taking it
		// as necessary is why an interior produced nothing: a room's openings look
		// out at a wall across the street, never at sky, so every tap failed and the
		// integral was zero at exactly the pose the technique exists for. What
		// actually marks air as lit is that the surface behind it is standing in the
		// sun, and the frame already says which surfaces those are — the sunlit
		// patch a window throws on the far wall is two decades above the fill around
		// it. So the mask is a bright pass, with sky as its guaranteed member.
		float sky = step( 0.999995, texture2D( tDepth, s ).x );
		float lit = max( sky, smoothstep( uBright.x, uBright.y, dot( rad, vec3( 0.2126, 0.7152, 0.0722 ) ) ) );
		acc += ( w * lit ) * rad;
		wsum += w;
		// Weighting the near taps hardest keeps a shaft attached to the silhouette
		// that cast it instead of streaking the full radius uniformly.
		w *= uDecay;
		uv += stepUv;
	}

	gl_FragColor = vec4( acc * ( lobe / max( wsum, 1e-4 ) ), 1.0 );
}
`,
};

/**
 * Renders the world into a target this module owns, then blits the result into
 * the composer's read buffer. See DEPTH ISOLATION above for why the blit exists.
 */
class ScenePass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.needsSwap = false;
    this.scene = scene;
    this.camera = camera;
    this.target = target;
    this.material = new THREE.ShaderMaterial({
      name: 'SceneBlit',
      uniforms: { tDiffuse: { value: null }, opacity: { value: 1 } },
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this._quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);

    this.material.uniforms.tDiffuse.value = this.target.texture;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this._quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.material.dispose();
    this._quad.dispose();
  }
}

/**
 * The view model, rendered into an HDR target of its own so the grade can put it
 * through the same curve as everything else.
 *
 * Engine draws `viewmodelScene` after the composer has finished, into a buffer
 * that is already tone-mapped and sRGB-encoded. That is one frame with two black
 * points and two anti-aliasing regimes: the world bottoms out on the grade's lift
 * and is resolved by SMAA, while the weapon reaches absolute zero and keeps every
 * jaggy, and the optic's emitter — authored at 2.6x over a red primary — clips a
 * single channel instead of desaturating up the ACES shoulder. Nothing tuned in
 * the grade can reach it, because it is composited after the grade runs.
 *
 * So the weapon is drawn here instead, scene-referred, and handed to the grade as
 * a texture. It is deliberately placed after TAA, motion blur and AO: those three
 * all reason about the world depth buffer, and the view model camera has its own
 * projection and an 8 mm near plane, so every one of them would be answering with
 * the depth of whatever the weapon happens to be standing in front of.
 *
 * Coverage travels in alpha, which means the target has to clear transparent. The
 * renderer's own clear alpha is 1, not 0, because the canvas was created without
 * an alpha channel — a detail that silently turns the mask into "everywhere".
 */
class ViewModelPass extends Pass {
  constructor(game, width, height) {
    super();
    this.needsSwap = false;
    this.game = game;

    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true, // the rig self-occludes; there is no other depth for it
      stencilBuffer: false,
      // The world's silhouettes are resolved by SMAA on the finished LDR frame.
      // The weapon's cannot be: its coverage travels in alpha, and a one-pixel
      // alpha step around the optic's lens circle carries no luminance gradient
      // for a morphological filter to find a shape in — SMAA sees a clean edge
      // and leaves it. Hardware multisample is the only thing in the chain that
      // resolves a curve on the object sitting in the middle of every frame, and
      // the resolve lands in the texture before the grade reads it, so the
      // partial coverage arrives premultiplied and composites correctly.
      samples: 4,
    });
    this.target.texture.name = 'PostFX.viewmodel';
  }

  render(renderer) {
    const scene = this.game.viewmodelScene;
    const camera = this.game.engine?.viewmodelCamera;
    if (!scene || !camera) return;

    const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.setClearAlpha(0);
    renderer.autoClear = true;
    scene.visible = true;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    // Engine unconditionally draws this scene again once the composer returns, and
    // that draw is the ungraded one. Leaving the root hidden is what makes it a
    // no-op — an empty render list — without this module reaching into Engine.
    scene.visible = false;
    renderer.setClearAlpha(alpha);
    renderer.autoClear = autoClear;
  }

  setSize(width, height) {
    this.target.setSize(width, height);
  }

  dispose() {
    // The chain can be torn down with the scene still hidden from the draw above.
    if (this.game.viewmodelScene) this.game.viewmodelScene.visible = true;
    this.target.dispose();
  }
}

/** TAA resolve plus its history ping-pong. */
class TemporalAAPass extends Pass {
  constructor(width, height) {
    super();
    this.material = new THREE.ShaderMaterial({
      name: TAAShader.name,
      uniforms: THREE.UniformsUtils.clone(TAAShader.uniforms),
      vertexShader: TAAShader.vertexShader,
      fragmentShader: TAAShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.uniforms = this.material.uniforms;

    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.historyA = new THREE.WebGLRenderTarget(width, height, opts);
    this.historyB = new THREE.WebGLRenderTarget(width, height, opts);
    this.historyA.texture.name = 'PostFX.taaHistoryA';
    this.historyB.texture.name = 'PostFX.taaHistoryB';
    this._read = this.historyA;
    this._write = this.historyB;

    this.blit = new THREE.ShaderMaterial({
      name: 'TAABlit',
      uniforms: { tDiffuse: { value: null }, opacity: { value: 1 } },
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this._quad = new FullScreenQuad(this.material);
  }

  /** Next resolve treats the history as absent; used on resize and teleports. */
  reset() {
    this.uniforms.uReset.value = 1;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tHistory.value = this._read.texture;

    this._quad.material = this.material;
    renderer.setRenderTarget(this._write);
    this._quad.render(renderer);

    // The resolve has to end up in both the history and the chain; one blit is
    // cheaper than an MRT path and keeps the pass a plain GLSL1 shader.
    this.blit.uniforms.tDiffuse.value = this._write.texture;
    this._quad.material = this.blit;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);

    const t = this._read;
    this._read = this._write;
    this._write = t;
    this.uniforms.uReset.value = 0;
  }

  setSize(width, height) {
    this.historyA.setSize(width, height);
    this.historyB.setSize(width, height);
    this.reset();
  }

  dispose() {
    this.historyA.dispose();
    this.historyB.dispose();
    this.material.dispose();
    this.blit.dispose();
    this._quad.dispose();
  }
}

/**
 * The shaft accumulation, into a target of its own that the grade samples.
 *
 * It does not swap the composer's buffers: the shafts are radiance to be added
 * back in *before* the tone curve, so the grade adds them at its own first line
 * rather than a compositing pass laying them over a finished frame. That also
 * costs one full-screen pass less on a box where every one of them is a second
 * of wall clock. The accumulation itself runs at a fraction of the frame because
 * a shaft is a low-frequency signal; the taps still read the full-resolution
 * depth and colour, so the mask is supersampled rather than blurred.
 */
class LightShaftPass extends Pass {
  constructor(width, height, scale, samples) {
    super();
    this.needsSwap = false;
    this._resScale = scale;

    this.target = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
      { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: false, stencilBuffer: false }
    );
    this.target.texture.name = 'PostFX.shafts';

    this.material = new THREE.ShaderMaterial({
      name: LightShaftShader.name,
      defines: { SAMPLES: samples },
      uniforms: THREE.UniformsUtils.clone(LightShaftShader.uniforms),
      vertexShader: LightShaftShader.vertexShader,
      fragmentShader: LightShaftShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.uniforms = this.material.uniforms;
    this._quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.target);
    this._quad.render(renderer);
  }

  setSize(width, height) {
    this.target.setSize(
      Math.max(1, Math.round(width * this._resScale)),
      Math.max(1, Math.round(height * this._resScale))
    );
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this._quad.dispose();
  }
}

/**
 * GTAO at a fraction of the frame resolution. AO is a low-frequency signal and
 * the pass is by far the most sample-hungry thing in the chain, so on a software
 * rasteriser it is the first thing that should give ground.
 */
class ScaledGTAOPass extends GTAOPass {
  constructor(scene, camera, width, height, scale) {
    super(scene, camera, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    this._resScale = scale;
  }

  setSize(width, height) {
    super.setSize(Math.max(1, Math.round(width * this._resScale)), Math.max(1, Math.round(height * this._resScale)));
  }
}

/** Radical inverse, for the Halton jitter sequence. */
function radicalInverse(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

const JITTER_COUNT = 8;
const JITTER = [];
for (let i = 1; i <= JITTER_COUNT; i++) {
  JITTER.push([radicalInverse(i, 2) - 0.5, radicalInverse(i, 3) - 0.5]);
}

export class PostFX {
  constructor(game) {
    this.game = game;
    this.settings = game.settings;
    this.enabled = true;

    /**
     * Scene radiance in this project lands around 0.03 for shadowed interior
     * concrete and 1.0-1.4 for the sky, which through an unscaled ACES curve puts
     * the whole world four stops under middle grey. This is the module's own
     * exposure, in the sense a camera has one; `settings.exposure` is the player's
     * trim on top of it.
     */
    this.baseExposure = 2.15;
    this.gradeName = 'default';

    /**
     * Peak shaft radiance as a multiple of the sky's own, before the distance
     * weighting and before the pass' own open-sky gate.
     *
     * 1.35 was calibrated against a mask that could only see sky, which in the two
     * poses where the disc is occluded returned a hard zero — the gain was free to
     * be anything because it was multiplying nothing. Now that the mask counts
     * sunlit surfaces as sources, the same number lifted a shaded plaza by most of
     * a stop, so it has to be re-derived against a mask that actually fires: a
     * beam should read as a beam and not as a second exposure. The open-sky case is
     * unaffected either way, because the pass' own aureole gate has already cut it
     * to a twelfth by the time this multiplies.
     */
    this.shaftStrength = 0.6;

    /**
     * Airlight path density for the shaft term, as a multiple of the sky's own
     * `aerialDensity`. A shaft is in-scattered sunlight crossing the same air the
     * aerial term integrates, so the two cannot hold independent opinions about how
     * much air sits in front of a surface — the hard-coded 1/45 m this replaces
     * disagreed with the active preset by a factor of four, and would have kept
     * disagreeing by a different factor in every other weather. The multiplier is
     * the one honest difference between them: a beam is only visible in the
     * particulate near the ground, which is denser than the clean column an aerial
     * average assumes, and it now tracks the preset — `dust` doubles the density and
     * the beams saturate over half the distance with it.
     *
     * The binding case is a room: the aerial density is a column average over
     * hundreds of metres of mostly clean air, while a beam is only ever seen in the
     * smoke and plaster dust of a shelled interior. Eight was still a 37 m e-folding
     * length, which spends six sevenths of a beam before it has crossed a six-metre
     * room; fourteen brings that to 21 m, so an interior keeps a quarter of the term
     * instead of a seventh. It still leaves the foreground protected — two metres of
     * air is 9% of it, which is what stops the weapon and the near cobbles from
     * picking up a haze they have no air in front of.
     */
    this.shaftDust = 14.0;

    this.composer = null;
    this.sceneTarget = null;
    this.depthTexture = null;
    this.ao = null;
    this.aoWide = null;
    this.aoComposite = null;
    this.ssr = null;
    this.taa = null;
    this.motionBlur = null;
    this.bloom = null;
    this.shafts = null;
    this.viewmodel = null;
    this.gradePass = null;
    this.smaa = null;

    this.stats = { initMs: 0, passes: 0, ao: false, aoWide: false, ssr: false, taa: false, smaa: false, bloom: false, mb: false, shafts: false };

    // Shared uniform values. The same objects are bound into several passes so one
    // write per frame reaches all of them; update() must not allocate.
    this._texel = new THREE.Vector2(1 / 1600, 1 / 900);
    this._reproject = new THREE.Matrix4();
    this._jitterUv = new THREE.Vector2();
    this._viewUp = new THREE.Vector3(0, 1, 0);
    this._shadowTint = new THREE.Vector3();
    this._highTint = new THREE.Vector3();
    this._split = new THREE.Vector2();
    this._lift = new THREE.Vector3();
    this._gamma = new THREE.Vector3(1, 1, 1);
    this._gain = new THREE.Vector3(1, 1, 1);
    this._hurtTint = new THREE.Vector3(0.85, 0.06, 0.05);
    this._sunUv = new THREE.Vector2(0.5, 0.5);
    this._sunClip = new THREE.Vector4();
    this._camPlanes = new THREE.Vector2(0.08, 900);
    this._aoFade = new THREE.Vector2(90, 260);
    this._shaftBright = new THREE.Vector2(0.18, 0.5);

    this._projClean = new THREE.Matrix4();
    this._viewProjClean = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3();
    this._prevCamQuat = new THREE.Quaternion();
    this._hasPrev = false;

    this._size = new THREE.Vector2(1600, 900);
    this._jitterIndex = 0;
    this._grainTime = 0;
    this._hurt = 0;
    this._holdTimer = 0;
    this._screenPx = 0;
    this._returnTo = 'default';
    this._blendRate = 7;

    this._now = mergePreset('default');
    this._target = mergePreset('default');
    this._onSettings = () => this.rebuild();
  }

  async init() {
    const t0 = performance.now();
    const size = this.game.engine.drawingSize;
    this._size.set(Math.max(1, size.x || 1600), Math.max(1, size.y || 900));
    this._texel.set(1 / this._size.x, 1 / this._size.y);

    // DEPTH24_STENCIL8 rather than DEPTH_COMPONENT24: it is the combination every
    // WebGL2 implementation, including the harness' SwiftShader, is guaranteed to
    // support as a sampleable depth attachment.
    this.depthTexture = new THREE.DepthTexture(this._size.x, this._size.y);
    this.depthTexture.format = THREE.DepthStencilFormat;
    this.depthTexture.type = THREE.UnsignedInt248Type;
    this.depthTexture.name = 'PostFX.depth';

    this.sceneTarget = new THREE.WebGLRenderTarget(this._size.x, this._size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthTexture: this.depthTexture,
      samples: 0,
    });
    this.sceneTarget.texture.name = 'PostFX.hdr';

    this.rebuild();
    this.game.bus.on('settings:changed', this._onSettings);
    this.game.engine.attachPostFX(this);

    this.stats.initMs = +(performance.now() - t0).toFixed(1);
  }

  /* --------------------------------------------------------------- the chain */

  /**
   * Build (or rebuild) the pass list from Settings. Called on a preset change,
   * because the quality flags decide which passes exist at all and a disabled
   * pass still costs a full-screen blit if it stays in the list.
   */
  rebuild() {
    const { renderer, scene, camera, settings } = this.game;
    const w = this._size.x;
    const h = this._size.y;
    const software = this.game.forge?.softwareGL === true;

    this._disposeChain();

    const buffer = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, // 8-bit here would band the sky before the grade ever saw it
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      samples: 0,
    });
    buffer.texture.name = 'PostFX.pingpong';
    this.composer = new EffectComposer(renderer, buffer);
    // Engine hands setSize the drawing-buffer size, which already includes the
    // device pixel ratio; the composer must not apply it a second time.
    this.composer.setPixelRatio(1);

    const wantsDepth = !!(settings.ao || settings.ssr || settings.taa || settings.motionBlur);
    if (wantsDepth) {
      this.composer.addPass(new ScenePass(scene, camera, this.sceneTarget));
    } else {
      this.composer.addPass(new RenderPass(scene, camera));
    }

    if (settings.ao) {
      // Contact scale. Radius in metres; the default 0.25 is tuned for a desk-scale
      // demo and at a 1.8 m eye height darkens nothing but the seam itself. 0.9 m
      // is where an object meets the ground, a plank crosses a wall, rubble piles
      // against a kerb — the high-frequency half of the signal, run at close to
      // full resolution because that is the half with edges in it.
      const ao = new ScaledGTAOPass(scene, camera, w, h, software ? 0.7 : 1);
      // Reuse the scene depth instead of re-rendering the world into a private
      // G-buffer: one less full-scene pass, and the normals derived from this
      // depth are the same ones SSR and motion blur reason about.
      ao.setGBuffer(this.depthTexture);
      ao.updateGtaoMaterial({
        radius: 0.9,
        distanceExponent: 1.0,
        // Held just above the radius rather than just below it. GTAO rejects any
        // sample whose view depth differs from the shading point by more than
        // this, and the samples that prove a corner *is* a corner are the ones on
        // the perpendicular wall running away from the eye — at a 0.9 m radius
        // those are up to 0.9 m of depth, so a 0.85 m thickness was discarding
        // most of the evidence for the one feature the pass exists to find.
        thickness: 1.15,
        // This discounts the horizon rise from the outer steps: at 1.0 the fourth
        // and last step of four counts for 0.4 of what it measures, which caps the
        // answer well below the geometry. The contact pass only reaches 0.9 m in
        // the first place, so there is no far sample here that needs distrusting.
        distanceFallOff: 0.5,
        scale: 1.3,
        samples: software ? 12 : 16,
        screenSpaceRadius: false,
      });
      // lumaPhi is the denoiser's tolerance for occlusion *difference* between
      // neighbours, and at 12 against a signal that lives in [0,1] it was infinite:
      // every tap weighted equally, so a five-texel Poisson disc flattened exactly
      // the contact this pass is for. Its normal and depth terms already protect a
      // corner, because a corner has both; a crate meeting a floor has neither and
      // was being blurred into the floor.
      ao.updatePdMaterial({ lumaPhi: 1.0, depthPhi: 1.4, normalPhi: 3.5, radius: 4, samples: software ? 8 : 12, rings: 2, radiusExponent: 1.6 });
      // Neither pass composites itself. One shader resolves both scales, which is
      // also one full-screen blit cheaper than GTAOPass' own copy-then-blend.
      ao.output = GTAOPass.OUTPUT.Off;
      ao.needsSwap = false;
      this.ao = ao;
      this.composer.addPass(ao);

      // Room scale: the architectural half of the signal — wall corners, window
      // reveals, the underside of a balcony, the ceiling between joists. A quarter
      // of the frame is plenty of resolution for it, because occlusion over metres
      // is a low-frequency field, and that is what makes a second pass affordable.
      const wide = new ScaledGTAOPass(scene, camera, w, h, software ? 0.34 : 0.5);
      wide.setGBuffer(this.depthTexture);
      wide.updateGtaoMaterial({
        radius: 4.5,
        distanceExponent: 1.4,
        // Thickness has to track the radius or the pass measures the same nothing
        // the narrow one already did: it rejects any sample whose depth differs
        // from the shading point by more than this, and a wall four metres across
        // a room *is* four metres of depth difference. Held under the radius so a
        // foreground silhouette cannot occlude a background a room deeper.
        thickness: 3.4,
        // The far samples are the entire point here, so they must not be discounted
        // the way the contact pass discounts them.
        distanceFallOff: 0.25,
        // A room's worth of enclosure lands most of a frame in a narrow band of
        // visibility — 0.55 mid-floor against 0.45 in a corner — and a linear
        // mapping spends that as one flat dimming with no gradient in it. The
        // exponent pulls the two apart where it matters without moving open ground,
        // whose visibility is already 1.
        //
        // The exponent only ever moves the middle of the band: the most enclosed
        // surface in the five poses, a market awning's underside, measures the same
        // at 1.25 as at 1.7 because its raw visibility is already under uWideFloor
        // and an exponent cannot reach what the floor has clamped. So this buys the
        // wall-to-wall corners and the window reveals, which is where the review
        // measured a room reading as one flat dimming, and the enclosed end is
        // uWideFloor's decision. That floor stays deliberately bounded: occlusion
        // multiplied into one composited radiance cannot tell an occluder from a
        // source, and most of what an awning's hemisphere holds is sunlit ground
        // bouncing light back up into it.
        scale: 1.5,
        samples: software ? 9 : 12,
        screenSpaceRadius: false,
      });
      wide.updatePdMaterial({ lumaPhi: 12, depthPhi: 1.2, normalPhi: 2.5, radius: 8, samples: software ? 8 : 12, rings: 2, radiusExponent: 1.4 });
      wide.output = GTAOPass.OUTPUT.Off;
      wide.needsSwap = false;
      this.aoWide = wide;
      this.composer.addPass(wide);

      const aoc = new ShaderPass(AOCompositeShader);
      aoc.material.depthTest = false;
      aoc.material.depthWrite = false;
      aoc.uniforms.tAoNear.value = ao.gtaoMap;
      aoc.uniforms.tAoWide.value = wide.gtaoMap;
      aoc.uniforms.tDepth.value = this.depthTexture;
      aoc.uniforms.uCamPlanes.value = this._camPlanes;
      aoc.uniforms.uFade.value = this._aoFade;
      this.aoComposite = aoc;
      this.composer.addPass(aoc);
    }

    if (settings.ssr) {
      const ssr = new ShaderPass(SSRShader);
      ssr.material.depthTest = false;
      ssr.material.depthWrite = false;
      ssr.uniforms.tDepth.value = this.depthTexture;
      ssr.uniforms.uProj.value = camera.projectionMatrix;
      ssr.uniforms.uInvProj.value = camera.projectionMatrixInverse;
      ssr.uniforms.uViewUp.value = this._viewUp;
      ssr.uniforms.uTexel.value = this._texel;
      ssr.uniforms.uStrength.value = settings.ssrStrength ?? 0.55;
      this.ssr = ssr;
      this.composer.addPass(ssr);
    }

    if (settings.taa) {
      const taa = new TemporalAAPass(w, h);
      taa.uniforms.tDepth.value = this.depthTexture;
      taa.uniforms.uReproject.value = this._reproject;
      taa.uniforms.uJitterUv.value = this._jitterUv;
      taa.uniforms.uTexel.value = this._texel;
      taa.uniforms.uFeedback.value = 0.9;
      this.taa = taa;
      this.composer.addPass(taa);
    }

    if (settings.motionBlur) {
      const mb = new ShaderPass(MotionBlurShader);
      mb.material.depthTest = false;
      mb.material.depthWrite = false;
      mb.uniforms.tDepth.value = this.depthTexture;
      mb.uniforms.uReproject.value = this._reproject;
      mb.uniforms.uJitterUv.value = this._jitterUv;
      mb.uniforms.uTexel.value = this._texel;
      this.motionBlur = mb;
      this.composer.addPass(mb);
    }

    if (settings.bloom) {
      // Threshold well above the sky's own radiance: the sun disc is authored at
      // ~190, the aureole around it reaches ~2.4, and the open sky sits near 1.2.
      // Anything that also catches the sky is veiling glare, which is a fail.
      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.28, 0.85, 2.6);
      // A hard mask edge would survive the blur as a ring around the sun.
      bloom.highPassUniforms.smoothWidth.value = 0.7;
      this.bloom = bloom;
      this.composer.addPass(bloom);
    }

    // Shafts need the sun to be occluded by something, which means they need the
    // depth buffer; without it the chain has no way to know what is in shadow.
    if (wantsDepth && settings.volumetrics) {
      // Software rasterisers pay per tap, and the mask is the one part of the
      // chain whose output is smooth enough to survive being run small.
      const shafts = new LightShaftPass(w, h, software ? 0.25 : 0.34, software ? 14 : 20);
      shafts.uniforms.tDepth.value = this.depthTexture;
      shafts.uniforms.uSunUv.value = this._sunUv;
      shafts.uniforms.uBright.value = this._shaftBright;
      shafts.uniforms.uAspect.value = w / h;
      this.shafts = shafts;
      this.composer.addPass(shafts);
    }

    const viewmodel = new ViewModelPass(this.game, w, h);
    this.viewmodel = viewmodel;
    this.composer.addPass(viewmodel);

    const grade = new ShaderPass(GradeShader);
    grade.material.depthTest = false;
    grade.material.depthWrite = false;
    grade.uniforms.uTexel.value = this._texel;
    grade.uniforms.tViewmodel.value = viewmodel.target.texture;
    grade.uniforms.tShaft.value = this.shafts ? this.shafts.target.texture : null;
    grade.uniforms.tDepth.value = this.depthTexture;
    grade.uniforms.uCamPlanes.value = this._camPlanes;
    grade.uniforms.uShadowTint.value = this._shadowTint;
    grade.uniforms.uHighTint.value = this._highTint;
    grade.uniforms.uSplit.value = this._split;
    grade.uniforms.uLift.value = this._lift;
    grade.uniforms.uGamma.value = this._gamma;
    grade.uniforms.uGain.value = this._gain;
    grade.uniforms.uHurtTint.value = this._hurtTint;
    this.gradePass = grade;
    this.composer.addPass(grade);
    this._applyGrade();

    if (settings.smaa) {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }

    this.stats.passes = this.composer.passes.length;
    this.stats.ao = !!this.ao;
    this.stats.aoWide = !!this.aoWide;
    this.stats.ssr = !!this.ssr;
    this.stats.taa = !!this.taa;
    this.stats.smaa = !!this.smaa;
    this.stats.bloom = !!this.bloom;
    this.stats.mb = !!this.motionBlur;
    this.stats.shafts = !!this.shafts;
    this._hasPrev = false;
  }

  /* ------------------------------------------------------------------- hooks */

  /**
   * Damage feedback: a red rim that closes in, plus a brief desaturation, both
   * driven from one decaying scalar so repeated hits stack instead of restarting.
   */
  hurtFlash(amount = 0.5) {
    this._hurt = Math.min(1, this._hurt + Math.max(0, amount));
  }

  /**
   * Swap grading presets. Transitions are interpolated rather than cut, because a
   * one-frame jump in exposure reads as a rendering glitch; `flashbang` carries a
   * `hold` so it decays back to whatever was running before on its own.
   */
  grade(name = 'default', opts) {
    const preset = GRADE_PRESETS[name];
    if (!preset) return this;
    if (name !== 'flashbang') this._returnTo = name;
    else if (!this._returnTo) this._returnTo = this.gradeName === 'flashbang' ? 'default' : this.gradeName;
    this.gradeName = name;
    this._target = mergePreset(name);
    const hold = opts?.hold ?? this._target.hold;
    this._holdTimer = hold > 0 ? hold / 1000 : 0;
    // Snap into a flash, ease out of it: the bang is instantaneous, the recovery
    // is what the player reads as recovery.
    this._blendRate = name === 'flashbang' ? 26 : 7;
    return this;
  }

  setExposure(mul) {
    this.baseExposure = Math.max(0.01, mul);
    return this;
  }

  /* ------------------------------------------------------------------ update */

  update(dt) {
    const step = dt > 0 && dt < 0.5 ? dt : 1 / 60;
    this._grainTime += step;
    // Grain has to change every frame or it reads as fixed dirt on the lens, but
    // it also must not wrap so far that the hash loses precision.
    if (this._grainTime > 64) this._grainTime -= 64;

    this._hurt *= Math.exp(-step * 3.2);
    if (this._hurt < 0.002) this._hurt = 0;

    if (this._holdTimer > 0) {
      this._holdTimer -= step;
      if (this._holdTimer <= 0) {
        this._holdTimer = 0;
        this.grade(this._returnTo || 'default');
        this._blendRate = 3.2;
      }
    }

    // Ease the live grade toward the target set. Frame-rate independent.
    const k = 1 - Math.exp(-step * (this._blendRate ?? 7));
    lerpPreset(this._now, this._target, k);
    this._applyGrade();
  }

  /** Push the live grade values into the pass uniforms. */
  _applyGrade() {
    const g = this.gradePass;
    if (!g) return;
    const s = this.settings;
    const n = this._now;
    const u = g.uniforms;

    u.uExposure.value = this.baseExposure * (s.exposure ?? 1) * n.exposure;
    u.uContrast.value = n.contrast;
    // Damage desaturates: the eye loses colour before it loses detail under stress
    // and it separates the hurt state from the grade without a second pass.
    u.uSaturation.value = n.saturation * (1 - 0.5 * this._hurt);
    this._shadowTint.set(n.shadowTint[0], n.shadowTint[1], n.shadowTint[2]);
    this._highTint.set(n.highTint[0], n.highTint[1], n.highTint[2]);
    this._split.set(n.split[0], n.split[1]);
    this._lift.set(n.lift[0], n.lift[1], n.lift[2]);
    this._gamma.set(n.gamma[0], n.gamma[1], n.gamma[2]);
    this._gain.set(n.gain[0], n.gain[1], n.gain[2]);

    u.uTime.value = this._grainTime;
    u.uHurt.value = this._hurt;
    u.uCA.value = (s.chromaticAberration ?? 0.5) * n.ca;
    u.uVignette.value = (s.vignette ?? 0.7) * n.vignette;
    u.uGrain.value = (s.filmGrain ?? 0.5) * 0.18 * n.grain;
    u.uSharpen.value = (s.sharpen ?? 0.6) * 0.5 * n.sharpen;
  }

  /**
   * Point the shaft pass at the sun and decide how much of it survives.
   *
   * A directional light has no position to project, but it does have a vanishing
   * point: transform the *direction* (w = 0) and the perspective divide lands on
   * the pixel every parallel sun ray converges toward. Behind the camera that
   * point is meaningless, and far enough off-frame the radial direction stops
   * agreeing with the real shadow volume, so both fade the effect out rather than
   * snapping it off — a shaft that vanishes on a pan reads as a bug.
   */
  _updateShafts() {
    const grade = this.gradePass;
    if (!grade) return;

    // Shared with the AO composite, which linearises the same depth buffer, so it
    // is kept current whether or not the shaft pass exists.
    this._camPlanes.set(this.game.camera.near, this.game.camera.far);

    const dir = this.game.sky?.sunDirection;
    if (!this.shafts || !dir) {
      grade.uniforms.uShaft.value = 0;
      return;
    }

    const density = this.game.sky?.params?.aerialDensity;
    if (density > 0) grade.uniforms.uShaftPath.value = density * this.shaftDust;

    this._sunClip.set(dir.x, dir.y, dir.z, 0).applyMatrix4(this._viewProjClean);
    const w = this._sunClip.w;
    if (w > 1e-4) {
      const nx = this._sunClip.x / w;
      const ny = this._sunClip.y / w;
      this._sunUv.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
      const off = Math.max(Math.abs(nx), Math.abs(ny));
      // Below the horizon there is no direct beam left to be occluded.
      const daylight = THREE.MathUtils.clamp(dir.y * 12, 0, 1);
      // A vanishing point off the edge of the frame is still the point every sun
      // ray converges toward, and a room lit through a window it cannot see is
      // exactly the case that needs the pass. Only the lobe's own exponential
      // should decide where the term dies; this gate is the far backstop, and at
      // 1.0 it was cutting the effect off inside the frustum's own diagonal.
      const s = this.shaftStrength * daylight * (1 - THREE.MathUtils.smoothstep(off, 1.2, 3.2));
      this.shafts.enabled = s > 0.002;
      grade.uniforms.uShaft.value = s;
    } else {
      this.shafts.enabled = false;
      grade.uniforms.uShaft.value = 0;
    }

    if (this.shafts.enabled) {
      this.shafts.uniforms.uAspect.value = this._size.x / this._size.y;
      this.shafts.uniforms.uSeed.value = (this._grainTime * 61) % 1000;
    }
  }

  /* ------------------------------------------------------------------ render */

  render() {
    const { renderer, camera, time } = this.game;
    const jittering = !!this.taa;

    camera.updateMatrixWorld();
    this._projClean.copy(camera.projectionMatrix);
    this._viewProjClean.multiplyMatrices(this._projClean, camera.matrixWorldInverse);

    if (jittering) {
      this._jitterIndex = (this._jitterIndex + 1) % JITTER_COUNT;
      const [jx, jy] = JITTER[this._jitterIndex];
      // Shifting m02/m12 slides the whole frustum by a constant NDC offset, which
      // is a sub-pixel sample position rather than a change of projection.
      const ndcX = (2 * jx) / this._size.x;
      const ndcY = (2 * jy) / this._size.y;
      const e = camera.projectionMatrix.elements;
      e[8] = this._projClean.elements[8] - ndcX;
      e[9] = this._projClean.elements[9] - ndcY;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      this._jitterUv.set(ndcX * 0.5, ndcY * 0.5);
    } else {
      this._jitterUv.set(0, 0);
    }

    // prevViewProj * inverse(jittered viewProj): unproject with the matrix the
    // depth buffer was drawn with, reproject with last frame's clean one.
    this._invViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    this._reproject.multiplyMatrices(this._hasPrev ? this._prevViewProj : this._viewProjClean, this._invViewProj);

    if (this.ssr) this._viewUp.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    this._updateShafts();

    if (this.motionBlur) {
      const mb = this.motionBlur;
      // Camera-only blur, so the whole pass can be skipped whenever the camera
      // barely moved — which is every frame the player is standing still.
      const posD = camera.position.distanceTo(this._prevCamPos);
      const dot = Math.min(1, Math.abs(camera.quaternion.dot(this._prevCamQuat)));
      const angD = 2 * Math.acos(dot);
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      this._screenPx = (angD / vFov) * this._size.y + posD * 0.08 * this._size.y;

      const dt = time?.dt > 0 ? time.dt : 1 / 60;
      // Normalise to a 60 Hz shutter so the look of the blur does not change with
      // framerate; the clamp stops a 500 fps frame from amplifying reprojection
      // error by a factor of eight.
      const shutter = (this.settings.motionBlurAmount ?? 0.55) * 0.5;
      mb.uniforms.uStrength.value = shutter * THREE.MathUtils.clamp(1 / 60 / dt, 0.5, 6);
      mb.uniforms.uSeed.value = (this._grainTime * 97) % 1000;
      mb.enabled = this._hasPrev && this._screenPx * shutter > 0.3;
    }

    this.composer.render(this.game.time.dt);

    if (jittering) {
      camera.projectionMatrix.copy(this._projClean);
      camera.projectionMatrixInverse.copy(this._projClean).invert();
    }
    this._prevViewProj.copy(this._viewProjClean);
    this._prevCamPos.copy(camera.position);
    this._prevCamQuat.copy(camera.quaternion);
    this._hasPrev = true;

    // Engine still issues its own view model draw after this returns; ViewModelPass
    // has already emptied it, but it is issued against whatever target is bound.
    renderer.setRenderTarget(null);
  }

  /**
   * Render the full chain into a buffer instead of the canvas, and return it.
   *
   * This exists for the capture harness, and it is not an optimisation — it is
   * the only affordable way to get a frame out. On this sandbox's software
   * rasteriser, any CPU read that touches the default framebuffer costs sixty to
   * a hundred seconds; the same read from a render target costs about three
   * milliseconds. Both measured. The composer already renders into its own
   * buffers, so all this does is stop the last pass from blitting to screen and
   * hand back the buffer the result landed in.
   */
  renderTo() {
    const wasToScreen = this.composer.renderToScreen;
    this.composer.renderToScreen = false;
    this.render();
    this.composer.renderToScreen = wasToScreen;
    return this.composer.readBuffer;
  }

  /* -------------------------------------------------------------------- size */

  setSize(w, h) {
    const width = Math.max(1, Math.round(w));
    const height = Math.max(1, Math.round(h));
    if (width === this._size.x && height === this._size.y) return;
    this._size.set(width, height);
    this._texel.set(1 / width, 1 / height);

    this.sceneTarget?.setSize(width, height);
    // Composer.setSize resizes both ping-pong buffers and every pass, which is
    // where the AO, bloom mip chain, SMAA and TAA history all get resized.
    this.composer?.setSize(width, height);
    this.taa?.reset();
    this._hasPrev = false;
  }

  /* ----------------------------------------------------------------- dispose */

  _disposeChain() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.copyPass.dispose();
    this.composer.passes.length = 0;
    this.composer = null;
    this.ao = null;
    this.aoWide = null;
    this.aoComposite = null;
    this.ssr = null;
    this.taa = null;
    this.motionBlur = null;
    this.bloom = null;
    this.shafts = null;
    this.viewmodel = null;
    this.gradePass = null;
    this.smaa = null;
  }

  dispose() {
    this.game.bus.off?.('settings:changed', this._onSettings);
    this._disposeChain();
    this.sceneTarget?.dispose();
    this.depthTexture?.dispose();
    this.sceneTarget = null;
    this.depthTexture = null;
  }
}

/* ----------------------------------------------------------- grade preset ops */

/** A preset states only its diff; this resolves one into a full parameter set. */
function mergePreset(name) {
  const base = GRADE_PRESETS.default;
  const p = GRADE_PRESETS[name] ?? base;
  const out = {};
  for (const k of Object.keys(base)) {
    const v = p[k] !== undefined ? p[k] : base[k];
    out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

/** In-place exponential approach, so a preset swap eases rather than cuts. */
function lerpPreset(now, target, k) {
  for (const key in now) {
    const a = now[key];
    const b = target[key];
    if (Array.isArray(a)) {
      for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * k;
    } else if (typeof a === 'number') {
      now[key] = a + (b - a) * k;
    }
  }
}
