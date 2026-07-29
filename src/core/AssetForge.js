import * as THREE from 'three';

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
  }

  async init() {
    this.registerMaterial('default', () => new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.8 }));
  }

  registerMaterial(name, factory) {
    this._materialFactories.set(name, factory);
  }

  registerTexture(name, factory) {
    this._textureFactories.set(name, factory);
  }

  material(name, overrides) {
    let m = this._materials.get(name);
    if (!m) {
      const f = this._materialFactories.get(name) || this._materialFactories.get('default');
      m = f(this);
      m.name = name;
      this._materials.set(name, m);
    }
    if (overrides) {
      const clone = m.clone();
      for (const [k, v] of Object.entries(overrides)) {
        // Colour-valued properties hold Color instances. Assigning a raw hex
        // number over one destroys the instance and the material renders black,
        // so route those through .set() instead.
        if (clone[k] && clone[k].isColor) clone[k].set(v);
        else clone[k] = v;
      }
      return clone;
    }
    return m;
  }

  texture(name) {
    let t = this._textures.get(name);
    if (!t) {
      const f = this._textureFactories.get(name);
      if (!f) return null;
      t = f(this);
      t.anisotropy = Math.min(this.settings.anisotropy, this.maxAnisotropy);
      this._textures.set(name, t);
    }
    return t;
  }

  /** Deterministic value noise; seeded so every reload produces the same world. */
  noise2D(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return (s - Math.floor(s)) * 2 - 1;
  }

  dispose() {
    for (const m of this._materials.values()) m.dispose();
    for (const t of this._textures.values()) t.dispose();
  }
}
