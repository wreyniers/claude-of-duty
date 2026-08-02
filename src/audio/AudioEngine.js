/**
 * Procedural audio. Every sound is synthesised with WebAudio — no sample files —
 * so gunshots, impacts, footsteps, bullet whizz-by and reverb tails are all
 * generated. Spatialised with PannerNodes and a convolution reverb whose impulse
 * response is generated per-environment.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * A gunshot is not one sound, and synthesising it as one is why most procedural
 * attempts sound like a click. It is three things that arrive at once and decay at
 * completely different rates: a crack — the supersonic bullet's shock, a few
 * milliseconds of bright broadband noise; a body — the muzzle blast, a low
 * resonant thump with real energy under 200 Hz; and a tail — the environment
 * answering, which is the only part that tells you whether you are in a street or
 * a room. Layering those three with separate envelopes is the whole trick, and the
 * tail comes free because it is the same convolution bus everything else uses.
 *
 * Noise buffers are generated once and shared. Allocating a second of white noise
 * per gunshot at 800 rounds a minute would allocate 140 MB a second; instead a few
 * pre-baked buffers are played from random offsets, which is indistinguishable by
 * ear and costs nothing.
 *
 * Every voice is fire-and-forget: nodes are created, scheduled, and left to be
 * collected when they stop. WebAudio nodes are cheap to create and disconnect
 * themselves on ended, so pooling them buys complexity and no throughput.
 *
 * CONTRACT:
 *   play(name, opts?)                 2D sound
 *   playAt(name, position, opts?)     3D sound
 *   setEnvironment(name)              swaps the reverb IR
 *   resume()                          call from a user gesture
 *
 * ADDITIONS (safe to rely on):
 *   soundNames, masterGain, environment
 */

/** Impulse responses, described rather than sampled. */
const ENVIRONMENTS = {
  street: { time: 1.5, decay: 2.6, damp: 0.42, predelay: 0.012, wet: 0.26 },
  room: { time: 0.7, decay: 3.4, damp: 0.7, predelay: 0.004, wet: 0.34 },
  alley: { time: 1.1, decay: 2.2, damp: 0.3, predelay: 0.008, wet: 0.4 },
  open: { time: 2.4, decay: 1.8, damp: 0.25, predelay: 0.02, wet: 0.16 },
};

/** Per-surface footstep and impact character: filter centre and body pitch. */
const SURFACES = {
  concrete: { hz: 2600, body: 150, q: 1.1, bright: 1 },
  stone: { hz: 2900, body: 170, q: 1.2, bright: 1.05 },
  metal: { hz: 4200, body: 420, q: 6, bright: 1.3 },
  wood: { hz: 1800, body: 220, q: 2.4, bright: 0.85 },
  dirt: { hz: 900, body: 90, q: 0.8, bright: 0.5 },
  sand: { hz: 700, body: 70, q: 0.6, bright: 0.4 },
  glass: { hz: 6000, body: 900, q: 8, bright: 1.4 },
  fabric: { hz: 1200, body: 110, q: 0.7, bright: 0.45 },
};

export class AudioEngine {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.ready = false;
    this.environment = 'street';

    this.masterGain = null;
    this._dry = null;
    this._wet = null;
    this._convolver = null;
    this._noise = null;
    this._irCache = new Map();
    this._lastStep = 0;
    this._seed = 0x2545f491;
  }

  async init() {
    // Contexts start suspended until a gesture; the deploy click resumes it.
    this.game.bus.on('input:locked', () => this.resume());

    const bus = this.game.bus;
    bus.on('weapon:fire', (e) => this._gunshot(e));
    bus.on('weapon:dryfire', () => this.play('dryfire'));
    bus.on('weapon:reload:start', (e) => this._reload(e));
    bus.on('weapon:equip', () => this.play('equip'));
    bus.on('player:footstep', (e) => this.playAt('footstep', e.position, { surface: e.surface, gain: e.sprinting ? 0.9 : 0.55 }));
    bus.on('player:land', (e) => this.playAt('land', e.position, { gain: Math.min(1, 0.3 + e.impact * 0.05) }));
    bus.on('player:jump', (e) => this.playAt('footstep', e.position, { gain: 0.4 }));
    bus.on('player:slide', (e) => this.playAt('slide', e.position));
    bus.on('player:damaged', () => this.play('hurt'));
    bus.on('combat:impact', (e) => this.playAt('impact', e.point, { surface: e.surface }));
    bus.on('combat:explosion', (e) => this.playAt('explosion', e.point));
  }

  _rand() {
    this._seed = (this._seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this._seed ^ (this._seed >>> 15), 1 | this._seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this._build();
      this.ready = true;
    }
    this.ctx.resume?.();
  }

  /**
   * Master chain: everything goes to a dry path and a shared convolution send.
   * One reverb for the whole mix rather than per-voice is both cheaper and more
   * correct — the room is a property of the room, not of each sound in it.
   */
  _build() {
    const ctx = this.ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.7;

    // A limiter in all but name. Twenty overlapping gunshots must not clip the
    // output, and a compressor with a fast attack is the only thing standing
    // between a firefight and distortion.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;

    this.masterGain.connect(limiter);
    limiter.connect(ctx.destination);

    this._dry = ctx.createGain();
    this._dry.connect(this.masterGain);
    this._wet = ctx.createGain();
    this._convolver = ctx.createConvolver();
    this._convolver.connect(this._wet);
    this._wet.connect(this.masterGain);

    this._noise = this._makeNoise(2.0);
    this.setEnvironment(this.environment);
  }

  /** One shared noise buffer, played from random offsets. */
  _makeNoise(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = this._rand() * 2 - 1;
    return buf;
  }

  /**
   * Generate an impulse response: exponentially decaying noise, progressively
   * low-passed so the tail darkens as it dies. Real rooms lose their highs first,
   * and an IR with a flat spectrum is the difference between a space and a hiss.
   */
  _makeIR(def) {
    const key = JSON.stringify(def);
    if (this._irCache.has(key)) return this._irCache.get(key);
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const n = Math.max(1, Math.floor(rate * def.time));
    const pre = Math.floor(rate * def.predelay);
    const buf = ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        if (i < pre) {
          d[i] = 0;
          continue;
        }
        const t = (i - pre) / (n - pre);
        const env = Math.pow(1 - t, def.decay);
        // One-pole low pass whose coefficient tightens with time.
        const a = 1 - def.damp * t;
        lp += a * ((this._rand() * 2 - 1) - lp);
        d[i] = lp * env;
      }
    }
    this._irCache.set(key, buf);
    return buf;
  }

  setEnvironment(name) {
    const def = ENVIRONMENTS[name] ?? ENVIRONMENTS.street;
    this.environment = name;
    if (!this.ctx) return;
    this._convolver.buffer = this._makeIR(def);
    this._wet.gain.value = def.wet;
  }

  /** A panner placed in the world, or null for a 2D sound. */
  _panner(position) {
    if (!position) return null;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 3;
    p.maxDistance = 300;
    p.rolloffFactor = 1.1;
    p.positionX.value = position.x;
    p.positionY.value = position.y;
    p.positionZ.value = position.z;
    return p;
  }

  /**
   * Route one voice to both the dry path and the reverb send. `wet` scales how
   * much of this particular sound reaches the room — a gunshot excites it hard,
   * a footstep barely at all.
   */
  _out(node, panner, wet = 1) {
    const send = this.ctx.createGain();
    send.gain.value = wet;
    if (panner) {
      node.connect(panner);
      panner.connect(this._dry);
      panner.connect(send);
    } else {
      node.connect(this._dry);
      node.connect(send);
    }
    send.connect(this._convolver);
  }

  /** A band-passed burst of the shared noise buffer with an explicit envelope. */
  _noiseBurst(t0, dur, hz, q, gain, panner, wet, type = 'bandpass') {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    // Random start offset: reusing one buffer is only inaudible if each voice
    // reads a different part of it.
    const off = this._rand() * (this._noise.duration - dur - 0.01);
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = hz;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt);
    filt.connect(g);
    this._out(g, panner, wet);
    src.start(t0, Math.max(0, off), dur + 0.02);
    src.stop(t0 + dur + 0.02);
    return g;
  }

  /** A pitched body: a sine or triangle that drops in pitch as it decays. */
  _thump(t0, dur, hz, endHz, gain, panner, wet, type = 'sine') {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    this._out(g, panner, wet);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    return g;
  }

  /**
   * The gunshot: crack, body, tail. Three layers with wildly different decays,
   * which is what separates a rifle report from a click.
   */
  _gunshot(e) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const w = e?.weapon;
    // Heavier calibres sit lower and ring longer.
    const heavy = w?.kind === 'marksman' ? 1.5 : w?.kind === 'smg' ? 0.72 : 1;
    const jitter = 1 + (this._rand() - 0.5) * 0.08;

    // Crack: the supersonic shock. Brief, bright, and the part that carries.
    this._noiseBurst(t, 0.045 * heavy, 3200 / heavy * jitter, 0.8, 0.55, null, 0.8, 'highpass');
    // Body: muzzle blast. Where the weight is.
    this._thump(t, 0.16 * heavy, 190 * heavy * jitter, 48, 0.75, null, 1.0);
    this._noiseBurst(t, 0.11 * heavy, 620 / heavy, 1.4, 0.4, null, 1.0);
    // Mechanism: the bolt cycling, quiet and dry, no reverb send.
    this._noiseBurst(t + 0.02, 0.05, 5200, 3, 0.06, null, 0.05, 'bandpass');
  }

  _reload(e) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = e?.duration ?? 2;
    // Magazine out, magazine in, bolt release — spaced across the animation so
    // the sound and the view model agree about what the hands are doing.
    this._noiseBurst(t + dur * 0.12, 0.05, 2400, 4, 0.13, null, 0.2);
    this._noiseBurst(t + dur * 0.55, 0.07, 1700, 3, 0.18, null, 0.2);
    this._thump(t + dur * 0.58, 0.06, 320, 120, 0.1, null, 0.2);
    if (e?.empty) this._noiseBurst(t + dur * 0.86, 0.06, 3600, 5, 0.16, null, 0.2);
  }

  /** 2D sound: UI, or anything happening at the player's own position. */
  play(name, opts = {}) {
    if (!this.ready) return;
    this._voice(name, null, opts);
  }

  /** 3D sound at a world position. */
  playAt(name, position, opts = {}) {
    if (!this.ready) return;
    this._voice(name, this._panner(position), opts);
  }

  _voice(name, panner, opts) {
    const t = this.ctx.currentTime;
    const s = SURFACES[opts.surface] ?? SURFACES.concrete;
    const gain = opts.gain ?? 1;

    switch (name) {
      case 'footstep': {
        // Rate-limit: several systems can report a step in the same frame and a
        // doubled footstep is instantly recognisable as a bug.
        if (t - this._lastStep < 0.09) return;
        this._lastStep = t;
        this._noiseBurst(t, 0.075, s.hz * 0.5, 1.6, 0.1 * gain * s.bright, panner, 0.25);
        this._thump(t, 0.06, s.body, s.body * 0.5, 0.05 * gain, panner, 0.2);
        break;
      }
      case 'land':
        this._thump(t, 0.13, 110, 45, 0.22 * gain, panner, 0.35);
        this._noiseBurst(t, 0.09, 1400, 1.2, 0.14 * gain, panner, 0.3);
        break;
      case 'slide':
        this._noiseBurst(t, 0.55, 1100, 0.9, 0.16 * gain, panner, 0.4);
        break;
      case 'impact':
        this._noiseBurst(t, 0.06 * (2 - s.bright), s.hz, s.q, 0.3 * gain * s.bright, panner, 0.6);
        this._thump(t, 0.05, s.body, s.body * 0.4, 0.16 * gain, panner, 0.5);
        break;
      case 'grenade_bounce':
        this._noiseBurst(t, 0.04, 2200, 5, 0.12 * gain, panner, 0.3);
        this._thump(t, 0.05, 260, 120, 0.1 * gain, panner, 0.3);
        break;
      case 'explosion':
        // The blast is mostly tail: a long low body under a wide noise front.
        this._thump(t, 1.1, 90, 24, 0.95 * gain, panner, 1.0);
        this._noiseBurst(t, 0.5, 700, 0.6, 0.6 * gain, panner, 1.0);
        this._noiseBurst(t, 0.08, 3800, 0.9, 0.35 * gain, panner, 0.9, 'highpass');
        break;
      case 'dryfire':
        this._noiseBurst(t, 0.035, 4200, 6, 0.12 * gain, panner, 0.1);
        break;
      case 'equip':
        this._noiseBurst(t, 0.09, 2000, 3, 0.1 * gain, panner, 0.2);
        break;
      case 'hurt':
        this._thump(t, 0.22, 140, 60, 0.2 * gain, panner, 0.3, 'triangle');
        this._noiseBurst(t, 0.18, 500, 0.7, 0.12 * gain, panner, 0.3);
        break;
      case 'whizz':
        // A round passing close: a fast doppler sweep, no reverb — it is gone
        // before the room can answer.
        this._thump(t, 0.13, 2400, 700, 0.09 * gain, panner, 0.05, 'triangle');
        break;
      default:
        break;
    }
  }

  get soundNames() {
    return ['footstep', 'land', 'slide', 'impact', 'grenade_bounce', 'explosion', 'dryfire', 'equip', 'hurt', 'whizz'];
  }

  /** Keep the listener on the camera so panning matches what is on screen. */
  update() {
    if (!this.ready) return;
    const cam = this.game.camera;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = cam.position.x;
      l.positionY.value = cam.position.y;
      l.positionZ.value = cam.position.z;
      const e = cam.matrixWorld.elements;
      // Third column negated is the camera's forward; second column is its up.
      l.forwardX.value = -e[8];
      l.forwardY.value = -e[9];
      l.forwardZ.value = -e[10];
      l.upX.value = e[4];
      l.upY.value = e[5];
      l.upZ.value = e[6];
    }
  }

  dispose() {
    this.ctx?.close?.();
    this.ctx = null;
    this.ready = false;
  }
}
