/**
 * Quality settings. Read by every render subsystem at init, and re-read on
 * `settings:changed`. Persisted to localStorage so a reload keeps the user's
 * choice.
 */
const PRESETS = {
  low: {
    renderScale: 0.75,
    shadowMapSize: 1024,
    shadowCascades: 2,
    ao: false,
    bloom: true,
    ssr: false,
    taa: false,
    smaa: false,
    motionBlur: false,
    volumetrics: false,
    anisotropy: 4,
    textureSize: 512,
    particleBudget: 256,
    decalBudget: 64,
  },
  medium: {
    renderScale: 1,
    shadowMapSize: 2048,
    shadowCascades: 3,
    ao: true,
    bloom: true,
    ssr: false,
    taa: false,
    smaa: true,
    motionBlur: true,
    volumetrics: false,
    anisotropy: 8,
    textureSize: 1024,
    particleBudget: 1024,
    decalBudget: 128,
  },
  high: {
    renderScale: 1,
    shadowMapSize: 2048,
    shadowCascades: 4,
    ao: true,
    bloom: true,
    ssr: true,
    taa: true,
    smaa: true,
    motionBlur: true,
    volumetrics: true,
    anisotropy: 16,
    textureSize: 2048,
    particleBudget: 2048,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1,
    shadowMapSize: 4096,
    shadowCascades: 4,
    ao: true,
    bloom: true,
    ssr: true,
    taa: true,
    smaa: true,
    motionBlur: true,
    volumetrics: true,
    anisotropy: 16,
    textureSize: 2048,
    particleBudget: 4096,
    decalBudget: 512,
  },
};

export class Settings {
  constructor(bus) {
    this.bus = bus;
    this.preset = 'high';
    this.fov = 90;
    this.exposure = 1.0;
    this.filmGrain = 0.5;
    this.chromaticAberration = 0.5;
    this.vignette = 0.7;
    this.sharpen = 0.6;
    this.motionBlurAmount = 0.55;
    this.viewmodelFov = 62;
    Object.assign(this, PRESETS[this.preset]);
    this.load();
  }

  applyPreset(name) {
    if (!PRESETS[name]) return;
    this.preset = name;
    Object.assign(this, PRESETS[name]);
    this.save();
    this.bus?.emit('settings:changed', this);
  }

  set(key, value) {
    this[key] = value;
    this.save();
    this.bus?.emit('settings:changed', this);
  }

  save() {
    try {
      localStorage.setItem(
        'cod:settings',
        JSON.stringify({
          preset: this.preset,
          fov: this.fov,
          exposure: this.exposure,
          filmGrain: this.filmGrain,
          chromaticAberration: this.chromaticAberration,
          vignette: this.vignette,
          sharpen: this.sharpen,
          motionBlurAmount: this.motionBlurAmount,
        })
      );
    } catch {
      /* private browsing */
    }
  }

  load() {
    try {
      const raw = localStorage.getItem('cod:settings');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.preset && PRESETS[saved.preset]) {
        this.preset = saved.preset;
        Object.assign(this, PRESETS[saved.preset]);
      }
      for (const k of ['fov', 'exposure', 'filmGrain', 'chromaticAberration', 'vignette', 'sharpen', 'motionBlurAmount']) {
        if (typeof saved[k] === 'number') this[k] = saved[k];
      }
    } catch {
      /* corrupt payload, ignore */
    }
  }

  static get presetNames() {
    return Object.keys(PRESETS);
  }
}
