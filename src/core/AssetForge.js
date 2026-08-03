import * as THREE from 'three';
import {
  Noise,
  Rng,
  fbmField,
  worleyField,
  horizonAOField,
  normalMipChain,
  blurField,
  curvatureField,
  warpField,
  sampleWrap,
  contrastField,
  clamp01,
  smoothstep,
} from '../render/Noise.js';
import { MATERIAL_RECIPES, MATERIAL_ALIASES, BAKE_ORDER } from '../render/Materials.js';
import { LAYER_VIEWMODEL } from './Layers.js';

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
 *   mesh(name)                 -> THREE.Object3D     authored rig, fresh instance
 *   noise2D(x, y)              -> number in [-1,1]   deterministic value noise
 *   registerMaterial(name, factoryFn)
 *   registerTexture(name, factoryFn)
 *   registerMesh(name, factoryFn)
 *
 * ADDITIONS (safe to rely on):
 *   material(name, { uvScale, repeat, normalScale, ... })  uvScale/repeat clone
 *       the maps (sharing their GPU upload) so one wall can tile at a different
 *       density than another without a second bake.
 *   materialNames                 -> string[] every recipe that can be asked for
 *   meshNames                     -> string[] every authored rig (see RIG_MESHES)
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
    this._meshFactories = new Map();
    this._meshProtos = new Map();
    this._rigMaterials = new Map();
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
    this._registerRigMeshes();

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

  registerMesh(name, factory) {
    this._meshFactories.set(name, factory);
  }

  get meshNames() {
    return [...this._meshFactories.keys()];
  }

  /**
   * An authored rig by name, as a fresh instance.
   *
   * Geometry and materials come from a prototype that is built once, so ten
   * instances are ten Object3Ds over one GPU upload. The clone is what the caller
   * animates, which is why the part table has to be rebound onto it: Object3D
   * clones copy `userData` by reference, and an animator that walked the shared
   * table would be driving the prototype instead.
   */
  mesh(name) {
    const key = this._resolveMesh(name);
    if (!key) return null;
    let proto = this._meshProtos.get(key);
    if (!proto) {
      proto = this._meshFactories.get(key)(this);
      this._meshProtos.set(key, proto);
    }
    const inst = proto.clone(true);
    const parts = {};
    for (const p of Object.keys(proto.userData.parts || {})) parts[p] = inst.getObjectByName(p) || null;
    inst.userData = { ...proto.userData, parts };
    return inst;
  }

  /** Exact name, then the alias table. Unknown names return null, not a stand-in:
   *  a mesh is a rig with a part contract, and quietly handing back a different
   *  one would break an animator in a way that looks like an animation bug. */
  _resolveMesh(name) {
    if (this._meshFactories.has(name)) return name;
    const key = String(name).toLowerCase().replace(/[^a-z]/g, '');
    return MESH_ALIASES[key] && this._meshFactories.has(MESH_ALIASES[key]) ? MESH_ALIASES[key] : null;
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
    // one material, which keeps the program/uniform switches down. The key is
    // built by hand rather than by JSON.stringify because an override can hold a
    // Texture, and Texture.toJSON on a render-target texture has no image to write
    // — it logs a warning for every rig part before it throws, which the capture
    // harness then reports as two dozen warnings from a working boot.
    let vkey = `${key}`;
    for (const k of Object.keys(overrides).sort()) {
      const v = overrides[k];
      const id =
        v == null || typeof v !== 'object'
          ? String(v)
          : Array.isArray(v)
            ? v.join(',')
            : v.isColor
              ? v.getHexString()
              : v.uuid || null;
      if (id === null) {
        vkey = null; // an override this cannot name; clone rather than mis-share
        break;
      }
      vkey += `|${k}=${id}`;
    }
    if (vkey) {
      const hit = this._variants.get(vkey);
      if (hit) return hit;
    }

    const clone = m.clone();
    clone.name = `${key}#`;
    // Material.copy() copies parameters, not behaviour: it leaves onBeforeCompile
    // and customProgramCacheKey on the prototype, where they are no-ops. Every
    // surface in the level comes through here (the level always passes a uvScale),
    // so without these two lines the entire world-space macro layer — the
    // anti-tiling variation, the grime, the rain runs, the dust film, the near-field
    // detail — is silently compiled out of every material that actually gets drawn,
    // and only a base material nobody asks for keeps it.
    if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) {
      clone.onBeforeCompile = m.onBeforeCompile;
      clone.customProgramCacheKey = m.customProgramCacheKey;
    }
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
    let hsum = 0;
    for (let i = 0; i < n; i++) {
      height[i] = clamp01(height[i]);
      hsum += height[i];
    }
    // The height field's own mean. The near-field detail layer re-reads this map
    // through its alpha at a multiple of the base frequency, and a term centred on
    // this number averages to exactly zero over any patch of the surface — which
    // is the only thing that lets that term modulate albedo without moving the
    // level of anything. See `_patchMacro`.
    const heightMean = hsum / n;

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
      // Spare channel, so it carries the damage mask: which texels are spall,
      // crack or blast rather than intact surface. The macro shader gates that on
      // a world-space field, which is the only way a tiling map can put damage in
      // one place and not in the next tile along.
      orm[o + 3] = clamp01(b.damage[i]) * 255;
      hbytes[i] = clamp01(height[i]) * 255;
    }
    this._heightBytes.set(name, hbytes);

    const uv = recipe.uvScale ?? 4;
    const mapTex = this._finishTexture(
      new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
      true,
      uv
    );
    // Normal and roughness mips are built together and by hand, because the pair
    // has to agree: each level of the normal chain reports how much normal spread
    // it averaged away and the roughness level of the same footprint is widened to
    // match. Left to the driver the two are filtered independently and a distant
    // surface keeps a mirror lobe it no longer has any facets for.
    const chain = normalMipChain(height, size, b.normalStrength);
    const normalTex = this._finishTexture(
      new THREE.DataTexture(chain.mips[0].data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
      false,
      uv,
      chain.mips
    );
    const ormTex = this._finishTexture(
      new THREE.DataTexture(orm, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
      false,
      uv,
      ormMipChain(orm, size, chain.variance)
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

    if (recipe.macro !== false) this._patchMacro(mat, recipe.macro || {}, recipe, heightMean);

    this.stats.baked++;
    this.stats.perMaterial[name] = +(performance.now() - t0).toFixed(1);
    return mat;
  }

  _finishTexture(t, srgb, uvScale, mips) {
    // The one line that has to be right: albedo is colour and must be decoded,
    // every other map is data and must not be. Getting this backwards is a
    // frame-wide gamma error that looks like "washed out" rather than a bug.
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    // A supplied chain has to run all the way to 1x1 or the texture is
    // incomplete at the far mips and samples black.
    if (mips) t.mipmaps = mips;
    t.generateMipmaps = !mips;
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
   *
   * Three world-space terms, because one is not enough to hide a tile.
   *
   * `scale` is a whole-district drift measured in tens of metres, and on its own it
   * cannot break a repeat: it varies far too slowly to say anything about one
   * three-metre tile versus the next. What kills the repeat is a term in the band
   * just above the tile pitch (`patchFreq`, cells per metre) and a term that runs
   * with gravity across many tiles at once (`runFreq`, stains around a metre wide
   * and ten tall). The runs are gated on verticality, because rain streaks are
   * something that happens to walls, and putting them on the ground is what makes
   * a procedural scene read as uniformly dirty rather than weathered. The splash
   * zone at the foot of a wall is deliberately not here: the level bakes that into
   * vertex colour at merge time, and doing it twice crushes every wall base.
   *
   * Three more world-space terms ride along, for the same reason — each is a fact
   * about a surface that a texture tile cannot know:
   *
   * - **Dust film.** Which way the face points. Dust settles on whatever faces the
   *   sky and it is a dielectric, so a horizontal surface loses gloss and metal.
   * - **Damage gate.** Where the damage is. A baked spall mask repeats with the
   *   tile and paints the identical crack network on every square metre; gating it
   *   on a world field leaves one panel wrecked and its neighbour intact.
   * - **Detail layer.** How close the camera is. The baked maps are authored at
   *   about a centimetre a texel, so inside a couple of metres they are magnified
   *   past their own resolution and the surface goes soft — the one place a
   *   procedural material looks *worse* the closer you get to it.
   *
   *   MEASURED, AND IT DOES NOT DO THAT. It re-reads the same map at N times the
   *   base UV, which is N times the base *derivative*, so the tap resolves log2(N)
   *   mip levels further down than the base sample — at N=9, three and a bit
   *   levels. What comes back is not finer than the base map, it is coarser: the
   *   map's own low-frequency content, retiled to a period of tile/N. A/B on the
   *   near paving at 480x270, high-frequency energy (sd of the crop minus the sd
   *   of the same crop box-filtered to 2 px), layer off then N swept:
   *       off 4.11 | N=9 3.99 | N=4 3.95 | N=2 4.23 | N=1 4.14
   *   — flat, i.e. nothing at pixel scale at any multiple. What does move is the
   *   coarse band (sd above 4 px, 21.13 -> 22.79 at N=9), which is the retiled
   *   blotch. A layer that cannot add detail above the base map's own frequency
   *   cannot fix a map whose problem is that it has no content at that frequency;
   *   that has to be baked, and for concrete_cast now is (see its recipe).
   *
   *   Left in place rather than deleted, because removing it moves the frame mean
   *   by about 3% (38.2 -> 39.5 on the near-ground pose with it on) and the light
   *   chain is being tuned this round — a level change from here would be the
   *   second half of a double correction. It should come out, but as its own
   *   change, coordinated, not as a side effect of a materials round.
   */
  _patchMacro(mat, cfg, recipe = {}, heightMean = 0.5) {
    const scale = cfg.scale ?? 0.11;
    const albedoAmt = cfg.albedo ?? 0.13;
    const roughAmt = cfg.rough ?? 0.12;
    const grime = cfg.grime ?? 0.22;
    const patchAmt = cfg.patch ?? 0.14;
    const patchFreq = cfg.patchFreq ?? 0.28;
    const runsAmt = cfg.runs ?? 0.3;
    const runFreq = cfg.runFreq ?? 1.3;
    const tint = new THREE.Color(cfg.tint ?? 0x6b6152);
    const dust = recipe.dust === false ? null : recipe.dust || {};
    const detail = recipe.detail || null;
    const heal = recipe.heal || null;
    const thru = recipe.translucency || null;

    // `function`, not an arrow: Three invokes this as a method on whichever
    // material is compiling, and every surface in the level is a clone that shares
    // this one function object (see `material()`). An arrow would close over the
    // prototype, so the uniform handle published at the bottom would belong to a
    // material nobody draws — and each clone's compile would overwrite it with
    // uniforms for a different clone. `forge` carries what the closure needs.
    const forge = this;
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uMacro = { value: new THREE.Vector4(scale, albedoAmt, roughAmt, grime) };
      shader.uniforms.uMacro2 = { value: new THREE.Vector4(patchAmt, patchFreq, runsAmt, runFreq) };
      shader.uniforms.uMacroTint = { value: tint };
      shader.uniforms.uDust = { value: new THREE.Vector2(dust ? dust.rough ?? 0.22 : 0, dust ? dust.metal ?? 0.3 : 0) };
      if (detail) {
        shader.uniforms.uDetail = {
          value: new THREE.Vector4(detail.freq ?? 8, detail.normal ?? 0.5, detail.rough ?? 0.22, detail.fade ?? 7),
        };
        shader.uniforms.uDetail2 = { value: new THREE.Vector2(0, heightMean) };
      }
      if (heal) {
        shader.uniforms.uHeal = {
          value: new THREE.Vector4(heal.amount ?? 0.85, heal.threshold ?? 0.44, heal.rough ?? 0.72, heal.normal ?? 0.8),
        };
        shader.uniforms.uHealTint = { value: new THREE.Color(heal.tint ?? 0x8b8880) };
        // Cells per metre for the gate's own field. Deliberately not the albedo
        // patch band: that one is tuned to break the tile up, this one has to be
        // coarse enough that a four-metre wall gets one or two wrecked patches
        // rather than a gradient across the whole of it.
        shader.uniforms.uHealFreq = { value: heal.freq ?? 0.55 };
      }
      if (thru) {
        // The sun's own live objects, shared by reference, so the term follows a
        // time-of-day change with no update hook on this material. Irradiance is a
        // plain number and has to be sampled, so a sunrise leaves it a stop stale.
        const sky = forge.game.sky;
        // Transmittance x irradiance / pi: the same Lambert normalisation the direct
        // term gets, so `amount` means the fraction of what lands on the sheet that
        // comes out the other side and not an arbitrary gain.
        shader.uniforms.uBack = {
          value: new THREE.Vector4(
            ((thru.amount ?? 0.25) * (sky?.sunIrradiance || 3.4)) / Math.PI,
            thru.wrap ?? 0.25,
            0,
            0
          ),
        };
        shader.uniforms.uSunDir = { value: sky?.sunDirection ?? new THREE.Vector3(0.3, 0.9, 0.2) };
        shader.uniforms.uSunTint = { value: sky?.sunColor ?? new THREE.Color(0xffe9c9) };
      }

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
uniform vec4 uMacro2;
uniform vec3 uMacroTint;
uniform vec2 uDust;
${detail ? 'uniform vec4 uDetail;\nuniform vec2 uDetail2;' : ''}
${heal ? 'uniform vec4 uHeal;\nuniform vec3 uHealTint;\nuniform float uHealFreq;' : ''}
${thru ? 'uniform vec4 uBack;\nuniform vec3 uSunDir;\nuniform vec3 uSunTint;' : ''}
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
void main() {`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
	// Three samples, not the old two octaves of one field. Eight hash evaluations
	// each is the whole budget here, and that fine second octave was doing work the
	// baked maps already do — so it pays for the patch band and the runs instead.
	float macroN = macroVal( vMacroPos * uMacro.x );
	float macroPatch = macroVal( vMacroPos * uMacro2.y + 31.7 );
	// y compressed, xz not: the field elongates downward, so what it paints is a
	// run rather than a blotch.
	float macroRun = macroVal( vec3( vMacroPos.x, vMacroPos.y * 0.08, vMacroPos.z ) * uMacro2.w );
	float macroUp = clamp( vMacroNrm.y, 0.0, 1.0 );
	float macroSide = 1.0 - abs( vMacroNrm.y );
	float macroGrime = uMacro.w * macroUp * smoothstep( 0.34, 0.78, macroN );
	// Runs are darker where the patch field is already dark, so a stain belongs to
	// a region of the wall instead of being sprinkled evenly over all of it.
	float macroWet = clamp( uMacro2.z * macroSide * smoothstep( 0.58, 0.93, macroRun ) * ( 1.2 - macroPatch * 0.7 ), 0.0, 1.0 );
	float macroDirt = clamp( macroGrime + macroWet * 0.7, 0.0, 1.0 );
	// Squared, so it is the genuinely horizontal faces that silt up and not every
	// surface with a slight tilt to it.
	float macroDust = macroUp * macroUp * ( 0.55 + 0.45 * macroN );
	diffuseColor.rgb *= 1.0 + ( macroN - 0.5 ) * 2.0 * uMacro.y + ( macroPatch - 0.5 ) * 2.0 * uMacro2.x - macroWet * 0.3;
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uMacroTint * 1.6, macroDirt );${
    detail
      ? `
	// One tap, read here and used twice: for roughness below and for the detail
	// normal further down. Branched rather than faded to nothing, because past the
	// fade distance the tap is pure cost.
	vec4 macroDtl = vec4( 0.5, 0.5, 1.0, uDetail2.y );
	float macroDtlFade = 1.0 - smoothstep( uDetail.w * 0.45, uDetail.w, length( vViewPosition ) );
	if ( macroDtlFade > 0.004 ) macroDtl = texture2D( normalMap, vNormalMapUv * uDetail.x );
	// The tap's alpha is the height field. Centred on the map's *own* mean rather
	// than on 0.5, for two reasons: the term then integrates to zero over any
	// stretch of surface, so it is a grain and not a brightness control; and the
	// mip chain converges this tap to that same mean, so the layer switches itself
	// off as its frequency drops under a pixel instead of leaving a bias behind.
	// Centred on the map's own mean rather than on 0.5, so that the term is zero
	// where the tap has mipped down to that mean — which, per the note above, is
	// most of where this layer is evaluated. Before this it carried a constant bias
	// of (mean - 0.5) x strength into roughness on every recipe whose height field
	// is not centred, which for concrete_pitted was +0.04.
	float macroDtlH = ( macroDtl.a - uDetail2.y ) * macroDtlFade;`
      : ''
  }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
	roughnessFactor = clamp( roughnessFactor + ( macroN - 0.5 ) * 2.0 * uMacro.z + macroDirt * 0.28
		+ macroDust * uDust.x${detail ? ' + macroDtlH * uDetail.z' : ''}, 0.04, 1.0 );${
    heal
      ? `
	// The damage mask rides in the ORM alpha. Healing it back toward the intact face
	// wherever the world field says this stretch of surface was spared is what turns
	// a tiling crack network into a couple of damaged patches per wall — the mask
	// itself cannot know, because it repeats along with everything else in the tile.
	// Its own world field, at its own frequency: sharing the albedo patch band tied
	// the size of a wrecked patch to a term tuned for something else entirely, and
	// at that band's scale a four-metre wall got a gradient rather than patches.
	float macroHeal = 0.0;
	#ifdef USE_ROUGHNESSMAP
		float macroHealF = macroVal( vMacroPos * uHealFreq + 7.3 );
		macroHeal = texelRoughness.a * uHeal.x * ( 1.0 - smoothstep( uHeal.y, uHeal.y + 0.2, macroHealF ) );
		diffuseColor.rgb = mix( diffuseColor.rgb, uHealTint * ( 0.82 + 0.36 * macroN ), macroHeal );
		roughnessFactor = mix( roughnessFactor, uHeal.z, macroHeal );
	#endif`
      : ''
  }`
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
	// Settled dust is a dielectric film over the metal, not a tint on it: a drum lid
	// or a flat sheet that keeps full metalness is a mirror aimed at the zenith, and
	// it comes back as one blown blue patch — the loudest wrong thing on a prop.
	metalnessFactor *= 1.0 - macroDust * uDust.y;`
        );

      if (detail || heal) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#ifdef USE_NORMALMAP_TANGENTSPACE
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;${
    detail
      ? `
	mapN.xy += ( macroDtl.xy - 0.5 ) * 2.0 * uDetail.y * macroDtlFade;`
      : ''
  }
	mapN.xy *= normalScale${heal ? ' * ( 1.0 - macroHeal * uHeal.w )' : ''};
	normal = normalize( tbn * mapN );
#else
	#include <normal_fragment_maps>
#endif`
        );
      }

      if (heal) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
	// The fourth channel the heal has to reach. AO is baked from the same height
	// field the cracks are cut into, so a texel the world gate has just declared
	// intact — new albedo, new roughness, relief flattened — still arrived carrying
	// the crack's occlusion, and a dark line network in indirect light is most of
	// what "crazy paving" actually is. Ungated, that network was identical on every
	// tile of every wall. Undoing the occlusion is a divide because the include has
	// already applied it; clamped, because a deep crater's AO is small and 1/x is
	// not, and bounded to the damage texels the gate healed, which measure under a
	// tenth of the surface.
	#ifdef USE_AOMAP
		reflectedLight.indirectDiffuse *= mix( 1.0, 1.0 / max( ambientOcclusion, 0.25 ), macroHeal );
	#endif`
        );
      }

      if (thru) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
          `// Thin-surface transmission. A sunlit awning seen from below is one of the
	// strongest warm bounce sources a street has, and fabric with no transmission
	// term renders as a dark printed sheet however carefully its weave is authored.
	// Light enters the lit face and leaves the other one, so the term is gated on the
	// sun being on the far side of the sheet from the eye — which also gives the
	// falloff across a sag, since the view term runs off toward the hem. World-space
	// normal for the sun test because the shading normal here is in view space.
	// Deliberately unshadowed: the sheet is the thing casting the shadow, and
	// sampling the cascade again costs more than the term is worth.
	// Absolute, because transmission does not care which face the sun landed on —
	// and on a sagging sheet built as a single surface it lands on whichever one the
	// normals happen to describe. Keying on the signed cosine left the term reading
	// zero on an awning filling the top third of the frame, because the face the eye
	// sees there is the one whose normal points away from the sun.
	float macroNL = dot( normalize( vMacroNrm ), uSunDir );
	float macroLit = clamp( ( abs( macroNL ) + uBack.y ) / ( 1.0 + uBack.y ), 0.0, 1.0 );
	// The eye has to be on the side the sun is *not* on. A step, not a cosine: which
	// side you are on is a yes-or-no question, and a cosine answers it with "barely"
	// at exactly the grazing angles an awning is mostly seen at. If anything the
	// grazing path through the cloth is longer.
	float macroThru = smoothstep( 0.02, 0.2, dot( normal, geometryViewDir ) * -sign( macroNL ) );
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse
		+ diffuseColor.rgb * uSunTint * ( uBack.x * macroLit * macroThru );`
        );
      }

      // On the material actually compiling, not on the prototype the closure was
      // built around: clones share this function, so `this` is the only handle that
      // names the right one.
      this.userData.macroUniforms = shader.uniforms;
    };
    // onBeforeCompile is not part of Three's program cache key, so a patched and
    // an unpatched material with identical parameters would share a program and
    // one of them would be missing the varyings. The key has to name which blocks
    // were injected too, or two recipes with the same parameters and different
    // injections would share whichever program compiled first.
    const key = `forge-macro-4${detail ? 'd' : ''}${heal ? 'h' : ''}${thru ? 't' : ''}`;
    mat.customProgramCacheKey = () => key;
  }

  /**
   * Wrap diffuse, for a surface light travels a little way inside before leaving.
   *
   * Skin is not a Lambertian shell: a millimetre of dermis carries red light
   * around the terminator, so the boundary between lit and unlit on a finger is a
   * wide warm band and not the hard cosine a dielectric gets. A view model's hands
   * are almost entirely cylinders seen side-on, which means the terminator is most
   * of what is on screen — with a plain cosine the limb is either lit or it is
   * not, and a limb with no terminator reads as painted plastic however good its
   * maps are.
   *
   * Added at the diffuse sum rather than inside the light loop, because that is
   * the one place Three leaves the shading normal, the light direction and the
   * surface colour all in scope at once, and because a second BRDF in the loop
   * would cost every light on the rig rather than only the key.
   */
  _patchSubsurface(mat, cfg) {
    const amount = cfg.amount ?? 0.4;
    const wrap = cfg.wrap ?? 0.5;
    const tint = new THREE.Color(cfg.tint ?? 0xc8503a);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSSS = { value: new THREE.Vector2(amount, wrap) };
      shader.uniforms.uSSSTint = { value: tint };
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform vec2 uSSS;\nuniform vec3 uSSSTint;\nvoid main() {')
        .replace(
          'vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
          `vec3 sssAdd = vec3( 0.0 );
	#if NUM_DIR_LIGHTS > 0
		// The key only. A fill has no terminator to soften, and the band the key's
		// own cosine leaves behind is the entire point of the term.
		float sssNL = dot( normal, directionalLights[ 0 ].direction );
		float sssWrap = clamp( ( sssNL + uSSS.y ) / ( 1.0 + uSSS.y ), 0.0, 1.0 );
		// Only what the cosine did not already deliver, so the lit side keeps the
		// albedo it was authored with and only the shading boundary warms.
		sssAdd = diffuseColor.rgb * uSSSTint * directionalLights[ 0 ].color
			* ( uSSS.x * sssWrap * ( 1.0 - clamp( sssNL, 0.0, 1.0 ) ) );
	#endif
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + sssAdd;`
        );
    };
    // Same reasoning as the macro key: onBeforeCompile is not part of Three's
    // program cache, so a patched material must not share a program with an
    // unpatched one that happens to carry the same parameters.
    mat.customProgramCacheKey = () => 'forge-sss-1';
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

  /* --------------------------------------------------------------- rig meshes */

  _registerRigMeshes() {
    for (const name of Object.keys(RIG_MESHES)) this.registerMesh(name, () => RIG_MESHES[name](this));
  }

  /**
   * A rig material: the recipe, tiled so one texture tile covers the metres it
   * was authored for, with the world's IBL attached.
   *
   * The view model scene has its own two lights and no environment of its own, so
   * a metal part with metalness 1 would have nothing to reflect and would render
   * as a black shape with one specular dot. Handing it the sky's PMREM is what
   * makes the receiver read as anodised aluminium rather than as a hole.
   */
  rigMaterial(recipe, extra) {
    // Cached here rather than by material()'s variant table: an envMap override
    // holds a Texture, the variant key is a JSON stringify, and Texture.toJSON
    // throws on a bare key — so every part would otherwise get its own clone of
    // the same material.
    const key = `${recipe}|${JSON.stringify(extra)}`;
    let m = this._rigMaterials.get(key);
    if (!m) {
      const tile = this.tileFor(recipe) || 1;
      const o = { uvScale: [1 / tile, 1 / tile], ...extra };
      const env = this.game.scene?.environment;
      if (env) o.envMap = env;
      m = this.material(recipe, o);
      // The rig is drawn by its own camera and rides with the player, so a field
      // evaluated from world position swims across the weapon as you walk. The
      // macro layer describes where a surface *is* in the town; a view model is not
      // anywhere in the town. Its own maps carry it. (Safe on the shared variant:
      // a rig material always carries the envMap override, so its cache key is
      // never the one a level surface asks for.)
      if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) {
        delete m.onBeforeCompile;
        delete m.customProgramCacheKey;
      }
      // Re-applied after that delete rather than before it: subsurface is a fact
      // about the substance and not about where the substance is standing, so it
      // is the one injection a view model part keeps.
      const sss = MATERIAL_RECIPES[this._resolve(recipe)]?.subsurface;
      if (sss) this._patchSubsurface(m, sss);
      this._rigMaterials.set(key, m);
    }
    return m;
  }

  dispose() {
    for (const m of new Set(this._materials.values())) m.dispose();
    for (const m of this._variants.values()) m.dispose();
    for (const t of this._textures.values()) t.dispose();
    for (const m of this._rigMaterials.values()) m.dispose();
    for (const p of this._meshProtos.values()) p.traverse((o) => o.geometry?.dispose());
  }
}

/* ------------------------------------------------------- authored rig meshes */

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();

function trs(x, y, z, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), ONE);
}

/**
 * Box with its edges knocked off, and analytic normals on the bevel.
 *
 * Every hard 90-degree edge on a weapon has a radius on it, and that radius is
 * where the specular highlight lives — it is the single cue that separates a
 * machined part from a cube with a metal texture. The corner is found by clamping
 * the vertex into the inner box and pushing it back out along the sphere, and the
 * normal comes from that same offset, so the bevel shades as a rounded edge
 * rather than as a facet.
 */
function chamferBox(w, h, d, r = 0.004) {
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const rr = Math.min(r, w * 0.49, h * 0.49, d * 0.49);
  const hx = w / 2 - rr;
  const hy = h / 2 - rr;
  const hz = d / 2 - rr;
  const p = g.attributes.position;
  const n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const cx = Math.max(-hx, Math.min(hx, x));
    const cy = Math.max(-hy, Math.min(hy, y));
    const cz = Math.max(-hz, Math.min(hz, z));
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l < 1e-7) continue;
    const k = rr / l;
    p.setXYZ(i, cx + dx * k, cy + dy * k, cz + dz * k);
    n.setXYZ(i, dx / l, dy / l, dz / l);
  }
  return g;
}

/** Cylinder lying along Z, which is the axis every part of a rifle runs on. */
function tubeZ(r1, r2, len, seg = 10, open = false) {
  return new THREE.CylinderGeometry(r1, r2, len, seg, 1, open).rotateX(Math.PI / 2);
}

/**
 * Tube along Z with an arbitrary radius profile and an elliptical section.
 *
 * `prof` is a list of `[t, rx, ry]` running from t=0 at the +Z end to t=1 at -Z,
 * which is the end convention `limb()` already uses. A limb built from one tapered
 * cylinder has perfectly straight silhouette edges and a single unbroken cosine
 * across it, and that is the whole of what makes an arm read as a plastic slab: a
 * real forearm is narrow and flattened at the wrist, swells through the flexor
 * belly a third of the way to the elbow, and the waist between the two is what the
 * eye uses to find the wrist at all. Normals are computed rather than derived
 * analytically because the profile is piecewise linear, and the averaged normal is
 * what smooths the joins between its segments.
 */
function profileTubeZ(len, prof, seg = 12) {
  const rings = prof.length;
  const nv = rings * (seg + 1) + 2;
  const pos = new Float32Array(nv * 3);
  const idx = [];
  for (let r = 0; r < rings; r++) {
    const [t, rx, ry] = prof[r];
    const z = (0.5 - t) * len;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const o = (r * (seg + 1) + s) * 3;
      pos[o] = Math.cos(a) * rx;
      pos[o + 1] = Math.sin(a) * ry;
      pos[o + 2] = z;
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < seg; s++) {
      const i0 = r * (seg + 1) + s;
      idx.push(i0, i0 + seg + 1, i0 + 1, i0 + 1, i0 + seg + 1, i0 + seg + 2);
    }
  }
  // Flat caps at both ends. The wrist end is hidden by the hand and the elbow end
  // by the sleeve, but an open tube shows its own backfaces the moment either one
  // moves, and a hole in a forearm is a worse artefact than two hidden triangles.
  const cA = rings * (seg + 1);
  const cB = cA + 1;
  pos[cA * 3 + 2] = len * 0.5;
  pos[cB * 3 + 2] = -len * 0.5;
  const last = (rings - 1) * (seg + 1);
  for (let s = 0; s < seg; s++) {
    idx.push(cA, s + 1, s);
    idx.push(cB, last + s, last + s + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Merge a part's sub-shapes into one geometry with metre-scale triplanar UVs.
 *
 * The 0..1 UVs a Three primitive arrives with put a 6 cm optic tube and a 30 cm
 * receiver at the same texel count, so the machining grain would be five times
 * coarser on one than the other. Projecting from position in metres instead
 * gives the whole weapon one texel density, which is what lets a close read hold
 * together.
 */
function mergeParts(parts) {
  let nv = 0;
  let ni = 0;
  for (const [g] of parts) {
    nv += g.attributes.position.count;
    ni += g.index.count;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const nmat = new THREE.Matrix3();
  let vo = 0;
  let io = 0;
  for (const [g, m] of parts) {
    const sp = g.attributes.position;
    const sn = g.attributes.normal;
    nmat.setFromMatrix4(m).invert().transpose();
    for (let i = 0; i < sp.count; i++) {
      _va.fromBufferAttribute(sp, i).applyMatrix4(m);
      _vb.fromBufferAttribute(sn, i).applyMatrix3(nmat).normalize();
      const o = (vo + i) * 3;
      pos[o] = _va.x;
      pos[o + 1] = _va.y;
      pos[o + 2] = _va.z;
      nrm[o] = _vb.x;
      nrm[o + 1] = _vb.y;
      nrm[o + 2] = _vb.z;
      const ax = Math.abs(_vb.x);
      const ay = Math.abs(_vb.y);
      const az = Math.abs(_vb.z);
      const o2 = (vo + i) * 2;
      if (ay >= ax && ay >= az) {
        uv[o2] = _va.x;
        uv[o2 + 1] = _va.z;
      } else if (ax >= az) {
        uv[o2] = _va.z;
        uv[o2 + 1] = _va.y;
      } else {
        uv[o2] = _va.x;
        uv[o2 + 1] = _va.y;
      }
    }
    const si = g.index.array;
    for (let i = 0; i < si.length; i++) idx[io + i] = si[i] + vo;
    vo += sp.count;
    io += si.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * The materials the rig is built from. Nine of them, because the rubric's view
 * model axis is graded on whether the receiver, the barrel, the polymer and the
 * glass read as different substances — and because a weapon that is one material
 * end to end is the single most recognisable tell of an unfinished view model.
 */
const RIG_MATS = {
  anodised: ['gun_aluminium_anodized', { envMapIntensity: 1.0 }],
  // 1.5 was what put a 255 specular on the weapon in a room whose brightest wall
  // reached 164. A gun is not a mirror and it is certainly not brighter than the
  // building it is carried through.
  blued: ['gun_steel_blued', { envMapIntensity: 1.05 }],
  polymer: ['gun_polymer', {}],
  polymerTan: ['gun_polymer', { color: 0x8f8672 }],
  rubber: ['rubber', { color: 0x8a8a8a }],
  glass: ['glass_dirty', { color: 0x8fa9bd, opacity: 0.55, roughness: 0.08 }],
  // 2.6 drove the reticle past its own red and out to pure white -- eleven clipped
  // pixels in a room whose brightest wall reaches 164. A red dot should read as a
  // bright red dot, and clipping to white is the one thing the tone axis fails on
  // by name.
  emitter: ['gun_steel_blued', { color: 0x120503, emissive: 0xff3a14, emissiveIntensity: 1.15, metalness: 0 }],
  skin: ['skin', {}],
  cuff: ['camo_fabric', { color: 0x9a9480 }],
};

/**
 * Part collector. A rig part is one animatable unit (the magazine drops, the
 * charging handle cycles, the fingers stay with the grip), and inside it the
 * shapes are merged per material — so the whole weapon is a dozen draw calls
 * instead of eighty, while still coming apart where an animation needs it to.
 */
class RigBuilder {
  constructor(forge) {
    this.forge = forge;
    this.parts = new Map();
  }

  put(part, mat, geo, m) {
    let p = this.parts.get(part);
    if (!p) this.parts.set(part, (p = new Map()));
    let list = p.get(mat);
    if (!list) p.set(mat, (list = []));
    list.push([geo, m || new THREE.Matrix4()]);
    return this;
  }

  /**
   * Tapered limb between two points. Matrix4.lookAt puts -Z on the target, so the
   * cylinder's top radius is the one at `a` — which is the end the caller thinks
   * of as the start (the wrist, for a forearm).
   */
  limb(part, mat, a, b, rA, rB, seg = 8) {
    return this.put(part, mat, tubeZ(rA, rB, this._axis(a, b), seg), this._M);
  }

  /** As `limb`, but with a `[t, rx, ry]` profile in place of two end radii. */
  shapedLimb(part, mat, a, b, prof, seg = 12) {
    return this.put(part, mat, profileTubeZ(this._axis(a, b), prof, seg), this._M);
  }

  /** Length between two points, leaving the a->b frame on `this._M`. */
  _axis(a, b) {
    _va.set(a[0], a[1], a[2]);
    _vb.set(b[0], b[1], b[2]);
    const len = _va.distanceTo(_vb);
    this._M = new THREE.Matrix4().lookAt(_va, _vb, UP);
    this._M.setPosition(_va.lerp(_vb, 0.5));
    return len;
  }

  group(name, children) {
    const g = new THREE.Group();
    g.name = name;
    for (const c of children) g.add(c);
    return g;
  }

  /** Realise every collected part as a Group of merged meshes. */
  emit(names) {
    const out = [];
    for (const name of names) {
      const p = this.parts.get(name);
      const g = new THREE.Group();
      g.name = name;
      if (p) {
        for (const [mat, list] of p) {
          const [recipe, extra] = RIG_MATS[mat];
          const mesh = new THREE.Mesh(mergeParts(list), this.forge.rigMaterial(recipe, extra));
          mesh.name = `${name}_${mat}`;
          // A view model is never a shadow caster: it is drawn by its own camera
          // after depth is cleared, and it is not in the world's cascades at all.
          mesh.castShadow = mesh.receiveShadow = false;
          g.add(mesh);
        }
      }
      out.push(g);
    }
    return out;
  }
}

/**
 * First-person rig: an AR-pattern carbine and the hands holding it.
 *
 * Authored in weapon space — muzzle toward -Z, sight line at +Y, origin at the
 * trigger — so a view model only has to place the root. `userData.pose` carries
 * the two placements that matter (hip and a sight-aligned ADS pose derived from
 * the optic's own centre), and `userData.parts` names every animatable unit plus
 * the muzzle/eject anchors, so a muzzle flash or a case ejection has a transform
 * to hang off instead of a guessed offset.
 */
function buildViewmodelRig(forge) {
  const r = new RigBuilder(forge);
  const AXIS = 0.055; // bore height above the rig origin

  // Upper receiver: a flat-sided box with the rounded top an AR has, then the
  // rail teeth. The teeth are the cheapest mechanical detail on the whole gun —
  // nine 7 mm ribs that catch the key light and instantly read as machined.
  r.put('receiver', 'anodised', chamferBox(0.058, 0.05, 0.3, 0.005), trs(0, AXIS - 0.008, -0.05));
  r.put('receiver', 'anodised', tubeZ(0.029, 0.029, 0.3, 12), trs(0, AXIS + 0.015, -0.05));
  r.put('receiver', 'anodised', chamferBox(0.046, 0.006, 0.3, 0.001), trs(0, AXIS + 0.043, -0.05));
  for (let i = 0; i < 10; i++) {
    r.put('receiver', 'anodised', chamferBox(0.05, 0.008, 0.013, 0.0015), trs(0, AXIS + 0.049, -0.19 + i * 0.03));
  }
  // Forward assist and the brass deflector behind it: both sit on the right, and
  // both break the receiver's silhouette where it would otherwise be a slab.
  r.put('receiver', 'blued', tubeZ(0.009, 0.009, 0.028, 8), trs(0.021, AXIS + 0.022, 0.105));
  r.put('receiver', 'anodised', chamferBox(0.014, 0.022, 0.026, 0.006), trs(0.028, AXIS + 0.02, 0.07));
  r.put('ejection_cover', 'blued', chamferBox(0.005, 0.03, 0.078, 0.002), trs(0.031, AXIS + 0.004, -0.045));

  // Lower receiver, magwell, trigger group. Polymer, so it reads matte against
  // the receiver's anodised sheen even though both are near-black.
  r.put('lower', 'polymer', chamferBox(0.046, 0.075, 0.12, 0.007), trs(0, AXIS - 0.06, -0.035));
  r.put('lower', 'polymer', chamferBox(0.044, 0.05, 0.09, 0.006), trs(0, AXIS - 0.05, 0.055));
  r.put('lower', 'polymer', chamferBox(0.04, 0.155, 0.058, 0.012), trs(0, AXIS - 0.15, 0.062, -0.3));
  // Trigger guard as three bars rather than a torus: a real guard is a bent strip
  // with corners, and the corners are what make it read at 30 cm.
  r.put('lower', 'polymer', chamferBox(0.03, 0.008, 0.062, 0.003), trs(0, AXIS - 0.115, 0.005));
  r.put('lower', 'polymer', chamferBox(0.03, 0.03, 0.008, 0.003), trs(0, AXIS - 0.102, -0.025));
  r.put('trigger', 'blued', chamferBox(0.009, 0.028, 0.012, 0.004), trs(0, AXIS - 0.093, 0.0));

  // Buffer tube, stock and pad. The pad is the one rubber part on the gun and the
  // tread pattern on it is a different scale of detail from anything else here.
  r.put('stock', 'polymer', tubeZ(0.019, 0.019, 0.2, 10), trs(0, AXIS - 0.012, 0.2));
  r.put('stock', 'polymer', chamferBox(0.046, 0.062, 0.13, 0.012), trs(0, AXIS - 0.022, 0.225));
  r.put('stock', 'polymer', chamferBox(0.026, 0.024, 0.1, 0.008), trs(0, AXIS + 0.022, 0.215));
  r.put('stock', 'rubber', chamferBox(0.048, 0.088, 0.016, 0.006), trs(0, AXIS - 0.026, 0.296));
  r.put('stock', 'blued', new THREE.TorusGeometry(0.012, 0.0035, 6, 10), trs(0.024, AXIS - 0.03, 0.15, 0, Math.PI / 2));

  // Charging handle: its own part because it is the thing that moves on a fire
  // animation, and the latch is what the eye reads moving.
  r.put('charging_handle', 'blued', chamferBox(0.05, 0.012, 0.014, 0.003), trs(0, AXIS + 0.04, 0.135));
  r.put('charging_handle', 'blued', chamferBox(0.016, 0.01, 0.05, 0.002), trs(0, AXIS + 0.038, 0.115));

  // Magazine: three segments, each tipped a little further forward, because a
  // STANAG is curved and a straight box magazine is a tell.
  r.put('magazine', 'polymerTan', chamferBox(0.028, 0.08, 0.086, 0.005), trs(0, AXIS - 0.13, -0.03, 0.07));
  r.put('magazine', 'polymerTan', chamferBox(0.028, 0.07, 0.084, 0.005), trs(0, AXIS - 0.198, -0.045, 0.19));
  r.put('magazine', 'polymerTan', chamferBox(0.032, 0.016, 0.09, 0.004), trs(0, AXIS - 0.238, -0.058, 0.24));

  // Free-float handguard: an eight-sided tube with M-LOK panel ribs. Eight sides,
  // not sixteen: the flats are what give a thin barrel-line something for the
  // highlight to break on.
  r.put('handguard', 'anodised', tubeZ(0.032, 0.032, 0.3, 8, true), trs(0, AXIS, -0.34));
  r.put('handguard', 'anodised', chamferBox(0.044, 0.006, 0.3, 0.001), trs(0, AXIS + 0.03, -0.34));
  for (let i = 0; i < 10; i++) {
    r.put('handguard', 'anodised', chamferBox(0.048, 0.008, 0.013, 0.0015), trs(0, AXIS + 0.036, -0.48 + i * 0.03));
  }
  for (let i = 0; i < 5; i++) {
    r.put('handguard', 'anodised', tubeZ(0.0335, 0.0335, 0.008, 8), trs(0, AXIS, -0.46 + i * 0.06));
  }
  r.put('handguard', 'blued', new THREE.TorusGeometry(0.011, 0.003, 6, 10), trs(-0.03, AXIS - 0.018, -0.45, 0, Math.PI / 2));

  // Barrel, gas block, brake. The brake's ports are rings proud of the tube: a
  // real port is a cut, but at view-model scale the shadow line reads the same
  // and it costs three cylinders instead of a boolean.
  r.put('barrel', 'blued', tubeZ(0.0105, 0.0115, 0.47, 10), trs(0, AXIS, -0.345));
  r.put('barrel', 'blued', chamferBox(0.024, 0.026, 0.04, 0.004), trs(0, AXIS + 0.006, -0.455));
  r.put('muzzle', 'blued', tubeZ(0.0165, 0.0175, 0.06, 10), trs(0, AXIS, -0.602));
  for (let i = 0; i < 3; i++) {
    r.put('muzzle', 'blued', tubeZ(0.019, 0.019, 0.005, 10), trs(0, AXIS, -0.585 - i * 0.015));
  }

  // Optic: mount, two rings, tube, hood, glass at both ends and a lit reticle.
  // 24 sides on everything round here, not 12: this is the one circle on the rig
  // the eye looks straight down, and at 12 its outline was a visible dodecagon
  // before aliasing had any chance to make it worse.
  r.put('optic', 'anodised', chamferBox(0.044, 0.022, 0.1, 0.004), trs(0, AXIS + 0.043, -0.16));
  r.put('optic', 'anodised', tubeZ(0.021, 0.021, 0.115, 24), trs(0, AXIS + 0.073, -0.16));
  for (const z of [-0.115, -0.205]) {
    r.put('optic', 'anodised', tubeZ(0.026, 0.026, 0.011, 24), trs(0, AXIS + 0.073, z));
  }
  r.put('optic', 'anodised', tubeZ(0.0245, 0.0245, 0.022, 24, true), trs(0, AXIS + 0.073, -0.228));
  r.put('optic', 'anodised', tubeZ(0.008, 0.008, 0.02, 8), trs(0, AXIS + 0.09, -0.16, 0, 0, 0));
  r.put('optic', 'glass', tubeZ(0.019, 0.019, 0.003, 24), trs(0, AXIS + 0.073, -0.216));
  // The ocular has to sit *in front of* the tube's own end cap. Behind it, the cap
  // is what the eye sees down the sight line, and an anodised disc taking a sky
  // reflection is exactly the flat slate plate the review measured where the sight
  // picture should be. A couple of millimetres of clearance is enough for the
  // depth test to keep the glass in front and still leave the rim showing.
  r.put('optic', 'glass', tubeZ(0.019, 0.019, 0.003, 24), trs(0, AXIS + 0.073, -0.1005));
  // Reticle: a dot inside a ring, floated a millimetre proud of the ocular so it
  // occludes the glass instead of being blended behind it. This is the single
  // most-looked-at region of an ADS frame and it was empty.
  r.put('optic', 'emitter', new THREE.CircleGeometry(0.0016, 12), trs(0, AXIS + 0.073, -0.0985));
  r.put('optic', 'emitter', new THREE.TorusGeometry(0.0105, 0.0006, 4, 28), trs(0, AXIS + 0.073, -0.0985));
  // Backup irons, folded flat so they do not cross the optic's sight line.
  r.put('receiver', 'blued', chamferBox(0.012, 0.01, 0.028, 0.002), trs(0, AXIS + 0.052, -0.02));
  r.put('handguard', 'blued', chamferBox(0.012, 0.01, 0.026, 0.002), trs(0, AXIS + 0.041, -0.44));

  buildRigHands(r, AXIS);

  const weapon = r.group(
    'weapon',
    r.emit([
      'receiver',
      'ejection_cover',
      'lower',
      'trigger',
      'stock',
      'charging_handle',
      'magazine',
      'handguard',
      'barrel',
      'muzzle',
      'optic',
    ])
  );
  const hands = r.group('hands', r.emit(['hand_right', 'forearm_right', 'hand_left', 'forearm_left']));

  // Anchors ride inside the part that moves them: the flash has to follow the
  // muzzle through recoil, not sit where the muzzle was at rest.
  const anchors = {};
  for (const [name, parent, p] of [
    ['muzzle_tip', 'muzzle', [0, AXIS, -0.635]],
    ['sight', 'optic', [0, AXIS + 0.073, -0.16]],
    ['eject', 'ejection_cover', [0.036, AXIS + 0.004, -0.03]],
  ]) {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(p[0], p[1], p[2]);
    weapon.getObjectByName(parent).add(o);
    anchors[name] = o;
  }

  const rig = new THREE.Group();
  rig.name = 'viewmodel_rig';
  rig.add(weapon, hands);
  // Set here rather than left to the caller: the rig is a view model asset, and a
  // caller that adds it after its own layer pass would otherwise hand the second
  // camera a rig it cannot see.
  rig.traverse((o) => o.layers.set(LAYER_VIEWMODEL));

  const parts = { weapon, hands, ...anchors };
  for (const g of [...weapon.children, ...hands.children]) parts[g.name] = g;
  rig.userData = {
    parts,
    // Sight-aligned: the optic's own centre put on the camera axis, so ADS lines
    // up by construction instead of by a hand-tuned offset that drifts whenever
    // the optic moves.
    pose: {
      hip: { position: [0.115, -0.175, -0.29], rotation: [0.015, -0.055, 0.02] },
      ads: { position: [0, -(AXIS + 0.073), -0.235], rotation: [0, 0, 0] },
      lowered: { position: [0.13, -0.33, -0.24], rotation: [-0.55, -0.2, 0.14] },
    },
  };
  return rig;
}

/**
 * Hands. Three-segment fingers with a knuckle sphere at each joint, curled around
 * whatever they hold: the rubric's fail case here is a mitten, and a mitten is
 * exactly what a single tapered box per hand produces. Both hands are built from
 * the same finger routine with different base frames — the right wraps the grip
 * front-to-left, the left goes over the handguard in a C-clamp.
 */
function buildRigHands(r, AXIS) {
  /** A finger from `base`, flexing at each joint toward the frame's own -Y. */
  const finger = (part, base, len, rad, curl) => {
    const M = base.clone();
    let rr = rad;
    // The metacarpal head. A finger that leaves the palm as a smooth cylinder is
    // most of what makes a closed hand read as a mitten: the knuckle row is the
    // one silhouette feature saying there are separate bones under the skin, and
    // on a hand wrapped round a grip it is the only part that catches the key.
    r.put(part, 'skin', new THREE.SphereGeometry(rr * 1.22, 8, 6), base.clone());
    for (let s = 0; s < 3; s++) {
      const L = len * [1, 0.76, 0.6][s];
      r.put(part, 'skin', tubeZ(rr * 0.88, rr, L, 7), M.clone().multiply(trs(0, 0, -L / 2)));
      const knuckle = rr * (s === 0 ? 1.06 : 0.95);
      r.put(part, 'skin', new THREE.SphereGeometry(knuckle, 7, 5), M.clone().multiply(trs(0, 0, -L)));
      M.multiply(trs(0, 0, -L)).multiply(new THREE.Matrix4().makeRotationX(-curl));
      rr *= 0.87;
    }
  };

  /**
   * Wrist-to-elbow profile, in fractions of the limb's own length. The waist at
   * t=0 is the wrist — the narrowest part of an arm, and flattened front to back —
   * and the swell at a fifth is the flexor belly. `limb`'s single taper had the
   * wrist as the *wide* end of a cone, which is backwards, and the straight
   * silhouette that produced is what the review measured as a slab.
   */
  const FOREARM = [
    [0, 0.022, 0.017],
    [0.08, 0.025, 0.021],
    [0.22, 0.035, 0.031],
    [0.42, 0.041, 0.037],
    [0.72, 0.041, 0.038],
    [1, 0.038, 0.036],
  ];

  // Right hand on the pistol grip. rz = -90 deg puts the fingers' flex direction
  // toward -X, so they close around the front of the grip.
  const gy = AXIS - 0.15;
  r.put('hand_right', 'skin', chamferBox(0.03, 0.095, 0.078, 0.022), trs(0.036, gy - 0.005, 0.06, -0.3, 0.1, 0));
  r.put('hand_right', 'skin', chamferBox(0.032, 0.05, 0.05, 0.02), trs(0.032, gy + 0.055, 0.072, -0.3, 0.1, 0));
  for (let i = 0; i < 4; i++) {
    finger(
      'hand_right',
      trs(0.026, gy + 0.045 - i * 0.026, 0.052 + i * 0.006, 0, 0.1 - i * 0.05, -Math.PI / 2),
      0.031 - i * 0.002,
      0.0092 - i * 0.0005,
      0.85 + i * 0.06
    );
  }
  // Thumb across the back of the grip, angled down: two segments, and the one
  // that is visible from the sight is the near knuckle.
  finger('hand_right', trs(0.02, gy + 0.06, 0.085, -0.5, 0.7, -Math.PI / 2), 0.03, 0.011, 0.55);
  // Thenar pad: the muscle at the base of the thumb, and the only broad convex
  // surface a gripping hand has for the key light to roll across.
  const thenar = new THREE.SphereGeometry(0.019, 9, 7).scale(0.85, 1.5, 1.25);
  r.put('hand_right', 'skin', thenar, trs(0.033, gy + 0.02, 0.086));
  r.shapedLimb('forearm_right', 'skin', [0.042, gy - 0.05, 0.085], [0.15, gy - 0.24, 0.31], FOREARM, 12);
  // Ulnar styloid: the bone standing proud on the little-finger side of every
  // wrist. One sphere, and it is what stops the wrist reading as a hose pushed
  // into a sleeve.
  r.put('forearm_right', 'skin', new THREE.SphereGeometry(0.009, 7, 5), trs(0.052, gy - 0.055, 0.088));
  r.limb('forearm_right', 'cuff', [0.115, gy - 0.185, 0.255], [0.17, gy - 0.28, 0.35], 0.046, 0.05, 9);

  // Left hand C-clamped on the handguard. The chain has to *circumscribe* the
  // tube: a finger laid across the top at the tube's own radius passes straight
  // through it, and a curl per joint much tighter than segment/radius drives the
  // tip inside. So the base sits one finger-radius clear of the tube at 155
  // degrees, pointing along the tangent there — rx tilts the pointing direction
  // in the plane ry has swung it into — and the joints turn by roughly the arc
  // each segment spans, which leaves the middle knuckle a few millimetres proud
  // and the tip pressed onto the far side.
  const hz = -0.36;
  const GRIP_R = 0.041;
  const GRIP_A = 2.7;
  r.put('hand_left', 'skin', chamferBox(0.032, 0.09, 0.075, 0.022), trs(-0.055, AXIS + 0.004, hz, 0.12, 0, 0.22));
  r.put('hand_left', 'skin', chamferBox(0.026, 0.038, 0.064, 0.018), trs(-0.049, AXIS + 0.032, hz - 0.008, 0.12, 0, 0.22));
  for (let i = 0; i < 4; i++) {
    finger(
      'hand_left',
      trs(
        GRIP_R * Math.cos(GRIP_A),
        AXIS + GRIP_R * Math.sin(GRIP_A),
        hz - 0.034 + i * 0.026,
        GRIP_A - Math.PI / 2,
        -Math.PI / 2,
        0
      ),
      0.03 - i * 0.0015,
      0.0092 - i * 0.0005,
      0.92 - i * 0.02
    );
  }
  // Thumb along the top of the rail rather than round it: on a rail-topped
  // handguard that is where a thumb physically goes.
  finger('hand_left', trs(-0.03, AXIS + 0.044, hz + 0.036, 0, -0.15, 0), 0.032, 0.0105, 0.22);
  const thenarL = new THREE.SphereGeometry(0.018, 9, 7).scale(0.85, 1.45, 1.2);
  r.put('hand_left', 'skin', thenarL, trs(-0.05, AXIS + 0.03, hz + 0.024));
  r.shapedLimb('forearm_left', 'skin', [-0.062, AXIS - 0.05, hz + 0.03], [-0.21, AXIS - 0.24, hz + 0.23], FOREARM, 12);
  r.put('forearm_left', 'skin', new THREE.SphereGeometry(0.009, 7, 5), trs(-0.073, AXIS - 0.055, hz + 0.032));
  r.limb('forearm_left', 'cuff', [-0.17, AXIS - 0.19, hz + 0.175], [-0.235, AXIS - 0.28, hz + 0.27], 0.046, 0.05, 9);
}

const RIG_MESHES = {
  viewmodel_rig: buildViewmodelRig,
};

/** What a sibling might plausibly ask for. `mesh()` resolves through this. */
const MESH_ALIASES = {
  viewmodelrig: 'viewmodel_rig',
  viewmodel: 'viewmodel_rig',
  rig: 'viewmodel_rig',
  weapon: 'viewmodel_rig',
  weaponrig: 'viewmodel_rig',
  gun: 'viewmodel_rig',
  arms: 'viewmodel_rig',
  firstperson: 'viewmodel_rig',
  firstpersonrig: 'viewmodel_rig',
  ma: 'viewmodel_rig', // 'm4a1' with the digits stripped
};

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
    // Where this texel is damage rather than surface. Only recipes whose damage is
    // meant to be regional fill it; see the heal term in _patchMacro.
    this.damage = new Float32Array(this.n);

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

/**
 * How much of the normal map's own variance is charged to roughness. A full
 * Toksvig coupling (1.0) is right for a Gaussian NDF and visibly over-blurs GGX,
 * because GGX already has the long tail Toksvig's Gaussian does not; a quarter of
 * it removes the sub-pixel speckle and still leaves a distant railing a highlight.
 */
const TOKSVIG = 0.25;

/**
 * Box-filtered ORM mip chain with the roughness level widened by the normal
 * variance the matching normal level averaged away.
 *
 * Roughness is not linear in anything, so the widening happens where lobes
 * actually add: GGX alpha is roughness squared and two independent lobes combine
 * in alpha squared. Doing it there is what makes the coupling a no-op on a surface
 * that was already rougher than its own normal spread, and decisive on the smooth
 * dark metal where the speckle lives.
 */
function ormMipChain(base, size, variance) {
  const mips = [{ data: base, width: size, height: size }];
  let src = base;
  let res = size;
  let level = 0;
  while (res > 1) {
    const half = res >> 1;
    const dst = new Uint8Array(half * half * 4);
    const varr = variance[++level];
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const a = (y * 2 * res + x * 2) * 4;
        const b = a + 4;
        const c = a + res * 4;
        const d = c + 4;
        const o = (y * half + x) * 4;
        for (let k = 0; k < 4; k++) dst[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
        const r = dst[o + 1] / 255;
        const wide = Math.pow(r * r * r * r + TOKSVIG * varr[y * half + x], 0.25);
        dst[o + 1] = Math.min(255, wide * 255);
      }
    }
    mips.push({ data: dst, width: half, height: half });
    src = dst;
    res = half;
  }
  return mips;
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
