import * as THREE from 'three';
import {
  Noise,
  Rng,
  fbmField,
  worleyField,
  horizonAOField,
  sobelNormalRGBA,
  blurField,
  curvatureField,
  warpField,
  sampleWrap,
  contrastField,
  clamp01,
  smoothstep,
} from '../render/Noise.js';
import { MATERIAL_RECIPES, MATERIAL_ALIASES, BAKE_ORDER } from '../render/Materials.js';

/**
 * Procedural asset factory.
 *
 * This project ships no binary art. Every texture, material and mesh is
 * synthesised at load time, which means the look is authored in code and there
 * is nothing to download. AssetForge is the single owner of that synthesis so
 * results are cached and shared: ask for the same material twice and you get the
 * same GPU resource.
 *
 * CONTRACT (other systems depend on these):
 *   material(name, overrides?) -> THREE.Material     cached PBR material by name
 *   texture(name, opts?)       -> THREE.Texture      cached texture by name
 *   noise2D(x, y)              -> number in [-1,1]   deterministic value noise
 *   registerMaterial(name, factoryFn)
 *   registerTexture(name, factoryFn)
 *
 * ADDITIONS (safe to rely on):
 *   material(name, { uvScale, repeat, normalScale, ... })  uvScale/repeat clone
 *       the maps (sharing their GPU upload) so one wall can tile at a different
 *       density than another without a second bake.
 *   materialNames                 -> string[] every recipe that can be asked for
 *   tileFor(name)                 -> metres per texture tile the recipe assumes
 *   heightTexture(name)           -> R8 height map (also in normalMap.a)
 *   noise                         -> Noise instance (perlin2/simplex3/worley2/fbm2)
 *   rng                           -> seeded Rng for scatter decisions
 *   stats                         -> { initMs, baked, lazy, textures, bytes }
 *
 * WHAT A BAKE PRODUCES
 * Six maps are synthesised per material — albedo, normal, roughness, metalness,
 * AO and height — and uploaded as three textures, because roughness/metalness/AO
 * are single-channel data that packs into one RGB texture exactly the way glTF
 * packs ORM, and height rides in the normal map's alpha. Three samples them from
 * the same GPU texture, so this is 3 uploads and 3 samplers per material instead
 * of 6 of each.
 *
 * Normals come from the height field by Sobel and AO from the same height field
 * by a horizon march, so the three never disagree: a bump that shows in the
 * albedo has a matching slope and a matching contact darkening.
 */
export class AssetForge {
  constructor(game) {
    this.game = game;
    this.settings = game.settings;
    this.maxAnisotropy = game.engine.maxAnisotropy;
    this._materials = new Map();
    this._textures = new Map();
    this._materialFactories = new Map();
    this._textureFactories = new Map();
    this._heightBytes = new Map();
    this._variants = new Map();

    this.seed = 0x5eed1e;
    this.noise = new Noise(this.seed);
    this.rng = new Rng(this.seed);

    // Detail maps are tiled at roughly a metre per tile, so 256 is ~4 mm per
    // texel — enough for a close read. Large-scale variation is added in the
    // shader instead of by baking bigger maps, which is both cheaper and free of
    // tiling. Hero surfaces (the view model, skin) bake at 2x.
    this.mapSize = clampPow2(this.settings.forgeMapSize ?? this.settings.textureSize >> 2, 64, 256);
    this.budgetMs = this.settings.forgeBudgetMs ?? 2000;

    // Anisotropic filtering is nearly free on a GPU and ruinous on a software
    // rasteriser, which is what the headless capture harness runs on: 16 taps x
    // 3 samplers x a full-screen grazing-angle floor is seconds per frame. Cap it
    // when there is no real GPU underneath.
    this.softwareGL = detectSoftwareGL(game.renderer);
    this.anisotropy = Math.min(this.settings.anisotropy, this.maxAnisotropy, this.softwareGL ? 4 : 16);

    this._aliasKeys = Object.keys(MATERIAL_ALIASES).sort((a, b) => b.length - a.length);
    this.stats = { initMs: 0, baked: 0, lazy: 0, textures: 0, bytes: 0, perMaterial: {} };

    this._installFavicon();
  }

  /**
   * The page ships no icon file, so the browser requests /favicon.ico, gets a
   * 404, and logs a console error — which the capture harness counts as a failed
   * run. Since this project's rule is that every asset is generated rather than
   * shipped, generate this one too. Done in the constructor because the request
   * goes out around DOMContentLoaded, before init() would finish.
   */
  _installFavicon() {
    try {
      if (typeof document === 'undefined' || document.querySelector('link[rel~="icon"]')) return;
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      g.fillStyle = '#12141a';
      g.fillRect(0, 0, 32, 32);
      g.strokeStyle = '#d8e24a';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(16, 16, 9, 0, Math.PI * 2);
      g.moveTo(16, 2);
      g.lineTo(16, 11);
      g.moveTo(16, 21);
      g.lineTo(16, 30);
      g.moveTo(2, 16);
      g.lineTo(11, 16);
      g.moveTo(21, 16);
      g.lineTo(30, 16);
      g.stroke();
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = c.toDataURL('image/png');
      document.head.appendChild(link);
    } catch {
      /* no DOM (worker/test): nothing to install */
    }
  }

  async init() {
    const t0 = performance.now();

    for (const name of Object.keys(MATERIAL_RECIPES)) {
      this.registerMaterial(name, () => this._bake(name));
    }
    // 'default' is an alias, not its own recipe: delegate so both names share one
    // baked material instead of paying for the same texture set twice.
    this.registerMaterial('default', () => this.material('concrete_cast'));
    this._registerUtilityTextures();

    // Bake in priority order under a wall-clock budget. Everything stays
    // available: whatever the budget does not cover is baked on first request,
    // which for a material no map actually uses means never.
    for (const name of BAKE_ORDER) {
      if (!MATERIAL_RECIPES[name]) continue;
      if (performance.now() - t0 > this.budgetMs) {
        this.stats.lazy++;
        continue;
      }
      this.material(name);
    }

    this.stats.initMs = +(performance.now() - t0).toFixed(1);
    this.game.bus.emit('forge:ready', this.stats);
  }

  get materialNames() {
    return Object.keys(MATERIAL_RECIPES);
  }

  tileFor(name) {
    return MATERIAL_RECIPES[this._resolve(name)]?.tile ?? 1;
  }

  /**
   * A variant tiled at the recipe's intended metres-per-tile for a surface of the
   * given world size with 0..1 UVs — which is what every Three primitive has.
   * Without this a 40 m wall built from a PlaneGeometry stretches one tile across
   * the whole thing and no amount of texture detail survives.
   */
  tiledFor(name, worldWidth, worldHeight = worldWidth) {
    const tile = this.tileFor(name) || 1;
    const sx = Math.max(0.25, Math.round((worldWidth / tile) * 2) / 2);
    const sy = Math.max(0.25, Math.round((worldHeight / tile) * 2) / 2);
    return this.material(name, { uvScale: [sx, sy] });
  }

  registerMaterial(name, factory) {
    this._materialFactories.set(name, factory);
  }

  registerTexture(name, factory) {
    this._textureFactories.set(name, factory);
  }

  /**
   * Map a requested name onto a recipe. Exact hit first, then the alias table,
   * then a substring match — a sibling asking for `concrete_wall_a` gets cast
   * concrete rather than the flat grey fallback, which is the difference between
   * a frame that reads as intentional and one that reads as unfinished.
   */
  _resolve(name) {
    if (this._materialFactories.has(name)) return name;
    if (MATERIAL_ALIASES[name]) return MATERIAL_ALIASES[name];
    const key = String(name).toLowerCase().replace(/[^a-z]/g, '');
    // Longest alias first, or `sandbag_wall` would match the `sand` alias.
    for (const alias of this._aliasKeys) {
      if (key.includes(alias)) return MATERIAL_ALIASES[alias];
    }
    for (const recipe of Object.keys(MATERIAL_RECIPES)) {
      const head = recipe.split('_')[0];
      if (key.includes(head)) return recipe;
    }
    return 'default';
  }

  material(name, overrides) {
    const key = this._resolve(name);
    let m = this._materials.get(key);
    if (!m) {
      const f = this._materialFactories.get(key) || this._materialFactories.get('default');
      m = f(this);
      if (!m.name) m.name = key;
      this._materials.set(key, m);
    }
    if (!overrides) return m;

    // Variant cache: two props asking for the same tint at the same tiling share
    // one material, which keeps the program/uniform switches down.
    let vkey = null;
    try {
      vkey = `${key}|${JSON.stringify(overrides)}`;
      const hit = this._variants.get(vkey);
      if (hit) return hit;
    } catch {
      /* non-serialisable override (a Texture, a Color) — just clone */
    }

    const clone = m.clone();
    clone.name = `${key}#`;
    const uvScale = overrides.uvScale ?? overrides.repeat;
    for (const [k, v] of Object.entries(overrides)) {
      if (k === 'uvScale' || k === 'repeat') continue;
      // Colour-valued properties hold Color instances. Assigning a raw hex
      // number over one destroys the instance and the material renders black,
      // so route those through .set() instead.
      if (clone[k] && clone[k].isColor) clone[k].set(v);
      else if (k === 'normalScale' && typeof v === 'number') clone.normalScale.set(v, v);
      else if (clone[k] && clone[k].isVector2 && Array.isArray(v)) clone[k].set(v[0], v[1]);
      else clone[k] = v;
    }
    if (uvScale != null) this._retile(clone, uvScale);
    clone.needsUpdate = true;
    if (vkey) this._variants.set(vkey, clone);
    return clone;
  }

  /** Re-tile a material's maps. Cloned textures share `source`: no re-upload. */
  _retile(mat, scale) {
    const sx = Array.isArray(scale) ? scale[0] : scale;
    const sy = Array.isArray(scale) ? scale[1] : scale;
    const seen = new Map();
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
      const t = mat[slot];
      if (!t) continue;
      let c = seen.get(t);
      if (!c) {
        c = t.clone();
        c.repeat.set(sx, sy);
        c.needsUpdate = true;
        seen.set(t, c);
      }
      mat[slot] = c;
    }
  }

  texture(name) {
    let t = this._textures.get(name);
    if (!t) {
      const f = this._textureFactories.get(name);
      if (!f) return null;
      t = f(this);
      t.anisotropy = this.anisotropy;
      this._textures.set(name, t);
      this.stats.textures++;
    }
    return t;
  }

  /** Deterministic value noise; seeded so every reload produces the same world. */
  noise2D(x, y) {
    return this.noise.perlin2(x, y);
  }

  /** Standalone R8 height map. Built on demand — most callers use normalMap.a. */
  heightTexture(name) {
    const key = this._resolve(name);
    const id = `${key}.height`;
    if (this._textures.has(id)) return this._textures.get(id);
    if (!this._heightBytes.has(key)) this.material(key);
    const bytes = this._heightBytes.get(key);
    if (!bytes) return null;
    const size = Math.sqrt(bytes.length) | 0;
    const t = new THREE.DataTexture(bytes, size, size, THREE.RedFormat, THREE.UnsignedByteType);
    this._finishTexture(t, false, MATERIAL_RECIPES[key]?.uvScale ?? 4);
    this._textures.set(id, t);
    return t;
  }

  /* ------------------------------------------------------------------ baking */

  _bake(name) {
    const t0 = performance.now();
    const recipe = MATERIAL_RECIPES[name];
    const size = clampPow2(this.mapSize * (recipe.size ?? 1), 64, 1024);
    const b = new Bake(this, size, hashName(name) ^ this.seed);
    recipe.build(b);

    const n = size * size;
    const height = b.height;
    for (let i = 0; i < n; i++) height[i] = clamp01(height[i]);

    const ao = horizonAOField(height, size, {
      relief: b.aoRelief,
      strength: b.aoStrength,
      spread: b.aoSpread,
      steps: size > 256 ? 4 : 3,
    });

    const albedo = new Uint8Array(n * 4);
    const orm = new Uint8Array(n * 4);
    const hbytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      albedo[o] = encodeSrgb(b.albedo[i * 3]);
      albedo[o + 1] = encodeSrgb(b.albedo[i * 3 + 1]);
      albedo[o + 2] = encodeSrgb(b.albedo[i * 3 + 2]);
      albedo[o + 3] = clamp01(b.alpha[i]) * 255;
      orm[o] = clamp01(ao[i] * b.aoMul[i]) * 255;
      // Roughness floor: a true 0 gives a delta-function highlight that
      // fireflies through the bloom threshold on any sub-pixel geometry.
      orm[o + 1] = Math.max(0.035, Math.min(1, b.rough[i])) * 255;
      orm[o + 2] = clamp01(b.metal[i]) * 255;
      orm[o + 3] = 255;
      hbytes[i] = clamp01(height[i]) * 255;
    }
    this._heightBytes.set(name, hbytes);

    const uv = recipe.uvScale ?? 4;
    const mapTex = this._finishTexture(
      new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
      true,
      uv
    );
    const ormTex = this._finishTexture(
      new THREE.DataTexture(orm, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
      false,
      uv
    );
    const normalTex = this._finishTexture(
      new THREE.DataTexture(
        sobelNormalRGBA(height, size, b.normalStrength),
        size,
        size,
        THREE.RGBAFormat,
        THREE.UnsignedByteType
      ),
      false,
      uv
    );
    this._textures.set(`${name}.albedo`, mapTex);
    this._textures.set(`${name}.orm`, ormTex);
    this._textures.set(`${name}.normal`, normalTex);
    this.registerTexture(`${name}.albedo`, () => mapTex);
    this.registerTexture(`${name}.orm`, () => ormTex);
    this.registerTexture(`${name}.normal`, () => normalTex);
    this.stats.textures += 3;
    this.stats.bytes += n * 12;

    const Ctor = recipe.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const mat = new Ctor({
      map: mapTex,
      normalMap: normalTex,
      // ORM packing: aoMap reads .r, roughnessMap .g, metalnessMap .b. One
      // texture, three samplers, no wasted upload.
      roughnessMap: ormTex,
      metalnessMap: ormTex,
      aoMap: ormTex,
      // The maps carry the absolute values; these stay at 1 so nothing scales
      // them down behind the recipe's back.
      roughness: 1,
      metalness: 1,
      normalScale: new THREE.Vector2(recipe.normalScale ?? 1, recipe.normalScale ?? 1),
      dithering: true, // large flat walls band badly in 8-bit without it
      ...(recipe.mat || {}),
    });
    mat.name = name;
    mat.userData.forge = { name, tile: recipe.tile ?? 1, uvScale: uv, size };

    if (recipe.macro !== false) this._patchMacro(mat, recipe.macro || {});

    this.stats.baked++;
    this.stats.perMaterial[name] = +(performance.now() - t0).toFixed(1);
    return mat;
  }

  _finishTexture(t, srgb, uvScale) {
    // The one line that has to be right: albedo is colour and must be decoded,
    // every other map is data and must not be. Getting this backwards is a
    // frame-wide gamma error that looks like "washed out" rather than a bug.
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = this.anisotropy;
    t.repeat.set(uvScale, uvScale);
    t.needsUpdate = true;
    return t;
  }

  /**
   * Large-scale variation, injected with onBeforeCompile.
   *
   * A baked map repeats; the eye finds the repeat in about a second on a big
   * wall. The fix is a second, much lower frequency signal that is not locked to
   * the UV tile at all — so it is evaluated from world position in 3D, which
   * makes it triplanar by construction (no UV, no projection seams, works on any
   * face orientation) and costs no texture memory. MeshStandardMaterial has no
   * uniform for "multiply albedo and bias roughness by a world-space field",
   * hence the injection rather than a material parameter.
   *
   * The same field also drives a downward-facing grime term keyed on the world
   * normal, because dirt accumulates on up-facing surfaces and that vertical cue
   * is most of what makes a surface look weathered rather than tinted.
   */
  _patchMacro(mat, cfg) {
    const scale = cfg.scale ?? 0.11;
    const albedoAmt = cfg.albedo ?? 0.13;
    const roughAmt = cfg.rough ?? 0.12;
    const grime = cfg.grime ?? 0.22;
    const tint = new THREE.Color(cfg.tint ?? 0x6b6152);

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uMacro = { value: new THREE.Vector4(scale, albedoAmt, roughAmt, grime) };
      shader.uniforms.uMacroTint = { value: tint };

      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec3 vMacroPos;\nvarying vec3 vMacroNrm;\nvoid main() {')
        .replace(
          '#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\n\tvMacroNrm = normalize( mat3( modelMatrix ) * objectNormal );'
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
	vec4 macroW = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		macroW = instanceMatrix * macroW;
	#endif
	vMacroPos = ( modelMatrix * macroW ).xyz;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          `varying vec3 vMacroPos;
varying vec3 vMacroNrm;
uniform vec4 uMacro;
uniform vec3 uMacroTint;
float macroHash( vec3 p ) {
	p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float macroVal( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( macroHash( i ), macroHash( i + vec3( 1, 0, 0 ) ), f.x ),
		mix( macroHash( i + vec3( 0, 1, 0 ) ), macroHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( macroHash( i + vec3( 0, 0, 1 ) ), macroHash( i + vec3( 1, 0, 1 ) ), f.x ),
		mix( macroHash( i + vec3( 0, 1, 1 ) ), macroHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
// Two octaves, not three: each octave is eight hash evaluations per pixel, and
// this runs on every world fragment. The third octave was worth ~0.1 of the
// signal and a third of the cost.
float macroField( vec3 p ) {
	return macroVal( p ) * 0.68 + macroVal( p * 2.71 ) * 0.32;
}
void main() {`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
	float macroN = macroField( vMacroPos * uMacro.x );
	float macroS = macroN - 0.5;
	float macroUp = clamp( vMacroNrm.y, 0.0, 1.0 );
	float macroGrime = uMacro.w * macroUp * smoothstep( 0.34, 0.78, macroN );
	diffuseColor.rgb *= 1.0 + macroS * 2.0 * uMacro.y;
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uMacroTint * 1.6, macroGrime );`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
	roughnessFactor = clamp( roughnessFactor + macroS * 2.0 * uMacro.z + macroGrime * 0.3, 0.04, 1.0 );`
        );

      mat.userData.macroUniforms = shader.uniforms;
    };
    // onBeforeCompile is not part of Three's program cache key, so a patched and
    // an unpatched material with identical parameters would share a program and
    // one of them would be missing the varyings. This key keeps them apart.
    mat.customProgramCacheKey = () => 'forge-macro-1';
  }

  /* ------------------------------------------------- generic small textures */

  _registerUtilityTextures() {
    // Siblings (particles, post, decals) routinely want a tileable noise or a
    // soft sprite mask. Registering them here means `forge.texture('noise')`
    // never returns null and no one is tempted to create a texture elsewhere.
    const noiseTex = () => {
      const s = 128;
      const data = new Uint8Array(s * s * 4);
      const f1 = fbmField(this.noise, s, { freq: 8, octaves: 5, seed: 11 });
      const f2 = fbmField(this.noise, s, { freq: 16, octaves: 4, seed: 977 });
      const f3 = worleyField(this.noise, s, { freq: 12, mode: 'edge', seed: 5501 });
      for (let i = 0; i < s * s; i++) {
        const o = i * 4;
        data[o] = f1[i] * 255;
        data[o + 1] = f2[i] * 255;
        data[o + 2] = f3[i] * 255;
        data[o + 3] = ((this.noise.perlin2(i * 0.37, i * 0.11) * 0.5 + 0.5) * 255) | 0;
      }
      const t = new THREE.DataTexture(data, s, s, THREE.RGBAFormat, THREE.UnsignedByteType);
      return this._finishTexture(t, false, 1);
    };
    this.registerTexture('noise', noiseTex);
    this.registerTexture('noise_rgba', noiseTex);

    this.registerTexture('softdisc', () => {
      const s = 64;
      const data = new Uint8Array(s * s * 4);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const dx = (x + 0.5) / s - 0.5;
          const dy = (y + 0.5) / s - 0.5;
          const d = Math.sqrt(dx * dx + dy * dy) * 2;
          const a = Math.pow(clamp01(1 - d), 2.2);
          const o = (y * s + x) * 4;
          data[o] = data[o + 1] = data[o + 2] = 255;
          data[o + 3] = a * 255;
        }
      }
      const t = new THREE.DataTexture(data, s, s, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.needsUpdate = true;
      return t;
    });
  }

  dispose() {
    for (const m of new Set(this._materials.values())) m.dispose();
    for (const m of this._variants.values()) m.dispose();
    for (const t of this._textures.values()) t.dispose();
  }
}

/**
 * The scratch pad a recipe paints into: one Float32 field per PBR channel plus
 * the height field that normals and AO are derived from. Recipes get the field
 * builders as short methods so a surface reads as a recipe rather than as noise
 * plumbing.
 */
class Bake {
  constructor(forge, size, seed) {
    this.forge = forge;
    this.size = size;
    this.n = size * size;
    this.noise = new Noise(seed);
    this.rng = new Rng(seed >>> 1);
    this.inv = 1 / size;

    this.height = new Float32Array(this.n).fill(0.5);
    this.albedo = new Float32Array(this.n * 3);
    this.rough = new Float32Array(this.n).fill(0.7);
    this.metal = new Float32Array(this.n);
    this.aoMul = new Float32Array(this.n).fill(1);
    this.alpha = new Float32Array(this.n).fill(1);

    this.normalStrength = 1;
    this.aoRelief = 0.4;
    this.aoStrength = 1;
    this.aoSpread = 0.035;
  }

  /**
   * A recipe's `seed:` is a local label, not a global one. Folding the bake's own
   * seed in keeps two materials that both happen to say `seed: 7` from sharing the
   * identical field, which shows up as correlated swirl direction across
   * unrelated surfaces.
   */
  _seed(opts) {
    return opts.seed === undefined ? opts : { ...opts, seed: (this.noise.seed + Math.imul(opts.seed | 0, 7919)) | 0 };
  }

  fbm(opts = {}) {
    return fbmField(this.noise, this.size, this._seed(opts));
  }
  ridge(opts = {}) {
    return fbmField(this.noise, this.size, { ...this._seed(opts), mode: 'ridge' });
  }
  turb(opts = {}) {
    return fbmField(this.noise, this.size, { ...this._seed(opts), mode: 'turbulence' });
  }
  cells(opts = {}) {
    return worleyField(this.noise, this.size, this._seed(opts));
  }
  blur(f, r = 2, passes = 2) {
    return blurField(f, this.size, r, passes);
  }
  curv(f, r = 2) {
    return curvatureField(f, this.size, r);
  }
  /** Domain warp: displace `f` by a low-frequency field. Cracks stop looking round. */
  warp(f, { freq = 3, amount = 10, seed = 7 } = {}) {
    const wx = this.fbm({ freq, octaves: 3, seed });
    const wy = this.fbm({ freq, octaves: 3, seed: seed + 4177 });
    return warpField(f, this.size, wx, wy, amount);
  }
  contrast(f, amount, pivot = 0.5) {
    return contrastField(f, amount, pivot);
  }
  sample(f, x, y) {
    return sampleWrap(f, this.size, x, y);
  }

  /** Iterate every texel: fn(index, u, v) with u,v in [0,1). */
  each(fn) {
    const s = this.size;
    const inv = this.inv;
    for (let y = 0; y < s; y++) {
      const v = y * inv;
      const row = y * s;
      for (let x = 0; x < s; x++) fn(row + x, x * inv, v);
    }
  }

  rgb(i, r, g, b) {
    const o = i * 3;
    this.albedo[o] = r;
    this.albedo[o + 1] = g;
    this.albedo[o + 2] = b;
  }

  /** Blend the current albedo toward a linear colour by t. */
  mix(i, c, t) {
    const o = i * 3;
    this.albedo[o] += (c[0] - this.albedo[o]) * t;
    this.albedo[o + 1] += (c[1] - this.albedo[o + 1]) * t;
    this.albedo[o + 2] += (c[2] - this.albedo[o + 2]) * t;
  }

  scale(i, k) {
    const o = i * 3;
    this.albedo[o] *= k;
    this.albedo[o + 1] *= k;
    this.albedo[o + 2] *= k;
  }
}

const SRGB_LUT_N = 4096;
const SRGB_LUT = new Uint8Array(SRGB_LUT_N + 1);
for (let i = 0; i <= SRGB_LUT_N; i++) {
  const c = i / SRGB_LUT_N;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  SRGB_LUT[i] = Math.round(clamp01(s) * 255);
}

/**
 * Recipes author albedo as linear reflectance (that is what PBR maths wants and
 * what the ARCHITECTURE note about linear authoring means), but an 8-bit sRGB
 * texture is what the GPU should store, or the dark end loses all its precision.
 * Encode on the way out; the sampler decodes on the way back in.
 */
function encodeSrgb(c) {
  return SRGB_LUT[(clamp01(c) * SRGB_LUT_N) | 0];
}

/** True for SwiftShader / llvmpipe style contexts, where per-tap cost is real. */
function detectSoftwareGL(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /swiftshader|software|llvmpipe|basic render/i.test(name);
  } catch {
    return false;
  }
}

function clampPow2(v, lo, hi) {
  let p = lo;
  while (p * 2 <= Math.min(hi, Math.max(lo, v))) p *= 2;
  return p;
}

function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { Bake, encodeSrgb, smoothstep };
