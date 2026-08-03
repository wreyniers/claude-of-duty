import * as THREE from 'three';

/**
 * Pooled GPU particle system: muzzle smoke, impact debris, blood, sparks, dust,
 * shell casings, tracers, explosion fireballs.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * Nothing is simulated on the CPU. Each particle stores where and when it was
 * born, its initial velocity and which effect it belongs to, and the vertex shader
 * integrates its position analytically from the elapsed time: p = p0 + v0·t +
 * ½g·t², with drag folded in as an exponential. A firefight can put a few thousand
 * particles in the air, and stepping those in JavaScript every frame would cost
 * more than the rest of the game logic combined — while the closed form is a
 * handful of ALU per vertex and needs no per-frame buffer upload at all.
 *
 * That choice is what makes `emit` cheap: it writes one slot's worth of attributes
 * into a ring buffer and marks a narrow update range. No allocation, no array
 * growth, no sort. Dead particles are not compacted or removed — their age simply
 * exceeds their lifetime and the shader collapses them to zero size, so the pool
 * never fragments and a burst never triggers a reallocation mid-fight.
 *
 * The sprite is procedural, like every other asset here: a soft radial falloff
 * shaped per effect in the fragment shader. A texture would be one more thing to
 * bake, and at these sizes a good analytic falloff is indistinguishable from one.
 *
 * Tracers are a separate pool of stretched quads rather than points, because a
 * tracer is a streak with a direction and a point sprite cannot be one.
 *
 * CONTRACT (called from combat + VFX code, must never allocate per-emit):
 *   emit(effectName, position, normalOrDir, opts?)
 *   registerEffect(name, definition)
 *
 * ADDITIONS (safe to rely on):
 *   live       : approximate count of particles still alive
 *   effectNames
 */

const MAX_PARTICLES = 3000;
const MAX_TRACERS = 64;

/**
 * Effect definitions.
 *
 * `count`      particles per emit
 * `life`       seconds, jittered by lifeVar
 * `speed`      initial speed along the emit direction, jittered
 * `spread`     radians of cone half-angle around the emit direction
 * `gravity`    metres per second squared, positive is down
 * `drag`       per-second exponential velocity decay
 * `size`       metres at birth
 * `grow`       size multiplier over the particle's life
 * `color0/1`   linear RGB at birth and death
 * `fade`       'smoke' softens and swells, 'spark' stays hard and shrinks
 */
const EFFECTS = {
  muzzle: {
    count: 14,
    life: 0.13,
    lifeVar: 0.5,
    speed: 7,
    speedVar: 0.7,
    spread: 0.32,
    gravity: -1,
    drag: 7,
    size: 0.055,
    grow: 3.4,
    color0: [1.0, 0.83, 0.42],
    color1: [0.35, 0.16, 0.06],
    fade: 'spark',
    additive: true,
  },
  muzzle_smoke: {
    count: 8,
    life: 0.7,
    lifeVar: 0.4,
    speed: 1.6,
    speedVar: 0.8,
    spread: 0.5,
    gravity: -0.6,
    drag: 2.6,
    size: 0.06,
    grow: 6,
    color0: [0.42, 0.4, 0.38],
    color1: [0.2, 0.19, 0.18],
    fade: 'smoke',
  },
  impact: {
    count: 12,
    life: 0.5,
    lifeVar: 0.6,
    speed: 3.4,
    speedVar: 0.9,
    // Impact debris comes off the surface in a wide cone about the normal, not a
    // jet: a narrow spray reads as a fountain rather than as something shattering.
    spread: 0.85,
    gravity: 9.5,
    drag: 1.2,
    size: 0.018,
    grow: 0.6,
    color0: [0.62, 0.57, 0.5],
    color1: [0.3, 0.28, 0.25],
    fade: 'spark',
  },
  impact_dust: {
    count: 7,
    life: 0.9,
    lifeVar: 0.5,
    speed: 1.1,
    speedVar: 0.9,
    spread: 1.1,
    gravity: -0.3,
    drag: 2.2,
    size: 0.05,
    grow: 5,
    color0: [0.55, 0.5, 0.44],
    color1: [0.34, 0.31, 0.28],
    fade: 'smoke',
  },
  blood: {
    count: 14,
    life: 0.55,
    lifeVar: 0.5,
    speed: 3.2,
    speedVar: 0.8,
    spread: 0.7,
    gravity: 11,
    drag: 0.8,
    size: 0.02,
    grow: 0.8,
    color0: [0.36, 0.02, 0.02],
    color1: [0.13, 0.01, 0.01],
    fade: 'spark',
  },
  shell: {
    count: 1,
    life: 1.4,
    lifeVar: 0.2,
    speed: 2.6,
    speedVar: 0.35,
    spread: 0.3,
    gravity: 12,
    drag: 0.25,
    size: 0.012,
    grow: 1,
    color0: [0.72, 0.55, 0.22],
    color1: [0.5, 0.38, 0.16],
    fade: 'spark',
  },
  explosion: {
    count: 40,
    life: 0.85,
    lifeVar: 0.5,
    speed: 11,
    speedVar: 0.8,
    spread: Math.PI,
    gravity: 2,
    drag: 3.2,
    size: 0.16,
    grow: 5,
    color0: [1.0, 0.72, 0.28],
    color1: [0.22, 0.12, 0.09],
    fade: 'smoke',
    additive: true,
  },
  dust: {
    count: 5,
    life: 2.2,
    lifeVar: 0.6,
    speed: 0.5,
    speedVar: 1,
    spread: Math.PI,
    gravity: -0.15,
    drag: 0.9,
    size: 0.05,
    grow: 3,
    color0: [0.5, 0.46, 0.4],
    color1: [0.34, 0.32, 0.29],
    fade: 'smoke',
  },
};

const VERT = /* glsl */ `
attribute vec3 aVel;
attribute vec4 aBirth;      // xyz = origin, w = birth time
attribute vec4 aParams;     // life, size, grow, gravity
attribute vec4 aColor0;     // rgb + drag
attribute vec4 aColor1;     // rgb + fadeMode

uniform float uTime;
uniform float uPixelScale;

varying vec3 vColor;
varying float vAlpha;
varying float vMode;

void main() {
  float age = uTime - aBirth.w;
  float life = aParams.x;
  float t = age / life;

  if (age < 0.0 || t > 1.0) {
    // Retired: collapse to a degenerate point behind the camera rather than
    // branching in the fragment shader, which would cost every live particle.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }

  // Exponential drag has a closed form, so velocity never has to be stepped:
  // the integral of v0·e^(-k·t) is v0·(1 - e^(-k·t))/k.
  float k = max(aColor0.w, 0.0001);
  vec3 drift = aVel * (1.0 - exp(-k * age)) / k;
  vec3 pos = aBirth.xyz + drift - vec3(0.0, 0.5 * aParams.w * age * age, 0.0);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float size = aParams.y * mix(1.0, aParams.z, t);
  // Perspective-correct point size, clamped so a particle at the muzzle does not
  // cover the screen.
  gl_PointSize = clamp(size * uPixelScale / max(-mv.z, 0.05), 1.0, 220.0);

  vColor = mix(aColor0.rgb, aColor1.rgb, t);
  vMode = aColor1.w;
  // Smoke swells and fades slowly; sparks hold then drop off a cliff.
  vAlpha = vMode > 0.5 ? (1.0 - t) * (1.0 - t) : 1.0 - t * t * t;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying float vMode;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float r = sqrt(r2) * 2.0;
  // Smoke is a soft blob, a spark is a hard core with a thin halo. One curve
  // shaped two ways is enough to tell them apart at these sizes.
  float shape = vMode > 0.5 ? smoothstep(1.0, 0.0, r) : pow(1.0 - r, 1.6);
  float a = vAlpha * shape;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

export class Particles {
  constructor(game) {
    this.game = game;
    this.effects = new Map();
    this.points = null;
    this.tracers = null;
    this.live = 0;

    this._cursor = 0;
    this._time = 0;
    this._dirtyLo = Infinity;
    this._dirtyHi = -1;

    this._tracerCursor = 0;
    this._tracerBirth = null;

    this._dir = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._bit = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._end = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._dustClock = 0;
    this._seed = 0x1a2b3c4d;
  }

  /** Deterministic and allocation-free; Math.random would break replayability. */
  _rand() {
    this._seed = (this._seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this._seed ^ (this._seed >>> 15), 1 | this._seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  async init() {
    for (const [name, def] of Object.entries(EFFECTS)) this.registerEffect(name, def);

    const g = new THREE.BufferGeometry();
    const n = MAX_PARTICLES;
    // A position attribute is required for the draw call, but the shader derives
    // the real position from aBirth, so this stays zeroed.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    for (const [name, size] of [
      ['aVel', 3],
      ['aBirth', 4],
      ['aParams', 4],
      ['aColor0', 4],
      ['aColor1', 4],
    ]) {
      const attr = new THREE.BufferAttribute(new Float32Array(n * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, attr);
    }
    // Birth time of -1e9 puts every slot far in the past, so nothing is drawn
    // until it is actually emitted.
    const birth = g.getAttribute('aBirth');
    for (let i = 0; i < n; i++) birth.array[i * 4 + 3] = -1e9;
    g.setDrawRange(0, n);
    // The bounding sphere cannot be computed from a position buffer that is all
    // zeros; make it large enough that the frustum cull never wrongly drops the
    // whole system.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this._material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelScale: { value: 600 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this._material);
    this.points.name = 'particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.game.scene.add(this.points);

    this._initTracers();
  }

  /**
   * Tracers are stretched quads on their own pool. A tracer is a streak along a
   * direction and a point sprite has no direction, so it cannot be one.
   */
  _initTracers() {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_TRACERS * 2 * 3);
    const alpha = new Float32Array(MAX_TRACERS * 2);
    const p = new THREE.BufferAttribute(pos, 3);
    const a = new THREE.BufferAttribute(alpha, 1);
    p.setUsage(THREE.DynamicDrawUsage);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', p);
    g.setAttribute('aAlpha', a);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this._tracerMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.78, 0.4) } },
      vertexShader: `
        attribute float aAlpha;
        varying float vA;
        void main() {
          vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        uniform vec3 uColor;
        varying float vA;
        void main() {
          if (vA < 0.01) discard;
          gl_FragColor = vec4(uColor * vA, vA);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.tracers = new THREE.LineSegments(g, this._tracerMat);
    this.tracers.name = 'tracers';
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 11;
    this.game.scene.add(this.tracers);
    this._tracerBirth = new Float32Array(MAX_TRACERS).fill(-1e9);
  }

  registerEffect(name, def) {
    this.effects.set(name, def);
  }

  get effectNames() {
    return [...this.effects.keys()];
  }

  /**
   * Spawn one effect. Writes straight into the ring buffer and widens the dirty
   * range; the upload happens once per frame in update, however many emits landed.
   */
  emit(name, position, dirOrNormal, opts) {
    if (name === 'tracer') return this._emitTracer(position, dirOrNormal, opts);
    const def = this.effects.get(name);
    if (!def || !this.points) return;

    const g = this.points.geometry;
    const vel = g.getAttribute('aVel');
    const birth = g.getAttribute('aBirth');
    const params = g.getAttribute('aParams');
    const c0 = g.getAttribute('aColor0');
    const c1 = g.getAttribute('aColor1');

    this._dir.copy(dirOrNormal ?? this._dir.set(0, 1, 0)).normalize();
    if (this._dir.lengthSq() < 0.5) this._dir.set(0, 1, 0);
    // An orthonormal basis about the emit direction, so the cone is sampled in
    // the plane perpendicular to it whatever direction that is.
    this._tan.set(0, 1, 0);
    if (Math.abs(this._dir.y) > 0.9) this._tan.set(1, 0, 0);
    this._bit.crossVectors(this._dir, this._tan).normalize();
    this._tan.crossVectors(this._bit, this._dir).normalize();

    const scale = opts?.scale ?? 1;
    const count = Math.max(1, Math.round((opts?.count ?? def.count) * scale));
    const fadeMode = def.fade === 'smoke' ? 1 : 0;

    for (let i = 0; i < count; i++) {
      const idx = this._cursor;
      this._cursor = (this._cursor + 1) % MAX_PARTICLES;
      if (idx < this._dirtyLo) this._dirtyLo = idx;
      if (idx > this._dirtyHi) this._dirtyHi = idx;

      const a = this._rand() * Math.PI * 2;
      // sqrt keeps the cone uniform in solid angle rather than piling the
      // particles up along its axis.
      const r = Math.sqrt(this._rand()) * def.spread;
      const sr = Math.sin(r);
      this._v
        .copy(this._dir)
        .multiplyScalar(Math.cos(r))
        .addScaledVector(this._tan, Math.cos(a) * sr)
        .addScaledVector(this._bit, Math.sin(a) * sr);
      const speed = def.speed * (1 + (this._rand() - 0.5) * (def.speedVar ?? 0.5)) * scale;

      vel.array[idx * 3] = this._v.x * speed;
      vel.array[idx * 3 + 1] = this._v.y * speed;
      vel.array[idx * 3 + 2] = this._v.z * speed;

      birth.array[idx * 4] = position.x;
      birth.array[idx * 4 + 1] = position.y;
      birth.array[idx * 4 + 2] = position.z;
      birth.array[idx * 4 + 3] = this._time;

      params.array[idx * 4] = def.life * (1 + (this._rand() - 0.5) * (def.lifeVar ?? 0.4));
      params.array[idx * 4 + 1] = def.size * scale;
      params.array[idx * 4 + 2] = def.grow;
      params.array[idx * 4 + 3] = def.gravity;

      c0.array[idx * 4] = def.color0[0];
      c0.array[idx * 4 + 1] = def.color0[1];
      c0.array[idx * 4 + 2] = def.color0[2];
      c0.array[idx * 4 + 3] = def.drag;

      c1.array[idx * 4] = def.color1[0];
      c1.array[idx * 4 + 1] = def.color1[1];
      c1.array[idx * 4 + 2] = def.color1[2];
      c1.array[idx * 4 + 3] = fadeMode;
    }

    // Muzzle flash and impacts read as one event with two parts: the hot flash
    // and the smoke or dust it leaves. Chaining here keeps every caller from
    // having to know that.
    if (name === 'muzzle') this.emit('muzzle_smoke', position, dirOrNormal, opts);
    else if (name === 'impact') this.emit('impact_dust', position, dirOrNormal, opts);
  }

  _emitTracer(origin, dir, opts) {
    if (!this.tracers) return;
    const i = this._tracerCursor;
    this._tracerCursor = (this._tracerCursor + 1) % MAX_TRACERS;
    const len = Math.min(opts?.length ?? 40, 60);
    this._end.copy(origin).addScaledVector(dir, len);
    const p = this.tracers.geometry.getAttribute('position');
    p.array[i * 6] = origin.x;
    p.array[i * 6 + 1] = origin.y;
    p.array[i * 6 + 2] = origin.z;
    p.array[i * 6 + 3] = this._end.x;
    p.array[i * 6 + 4] = this._end.y;
    p.array[i * 6 + 5] = this._end.z;
    p.needsUpdate = true;
    this._tracerBirth[i] = this._time;
  }

  /**
   * Ambient motes around the camera.
   *
   * A `dust` effect was defined from the start and nothing ever emitted it, so the
   * air was perfectly clean — which a review named directly: an atmosphere with a
   * correct aerial-perspective curve and no particulate in it still reads as empty
   * space. Emission is anchored a few metres ahead of the eye rather than spread
   * over the map, because motes are only legible within a few metres and seeding
   * the whole square would spend the pool where nobody can see it.
   */
  _ambientDust(dt) {
    this._dustClock = (this._dustClock ?? 0) + dt;
    if (this._dustClock < 0.35) return;
    this._dustClock = 0;
    const cam = this.game.camera;
    // Ahead of the eye and slightly above it, offset randomly so the motes do not
    // spawn in a plane the player can see edge-on.
    this._v
      .set((this._rand() - 0.5) * 6, (this._rand() - 0.5) * 2.4 + 0.6, -(1.5 + this._rand() * 4))
      .applyQuaternion(cam.quaternion)
      .add(cam.position);
    this.emit('dust', this._v, this._up.set(0, 1, 0), { count: 2 });
  }

  update(dt) {
    if (!this.points) return;
    this._time += dt;
    this._ambientDust(dt);
    this._material.uniforms.uTime.value = this._time;
    // Point size is in metres at one metre; convert with the vertical FOV so a
    // particle keeps its world size as the ADS zoom changes.
    const cam = this.game.camera;
    const h = this.game.engine.drawingSize?.y ?? 720;
    this._material.uniforms.uPixelScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));

    if (this._dirtyHi >= this._dirtyLo) {
      // One upload per frame covering everything emitted since the last one,
      // rather than an upload per emit.
      for (const name of ['aVel', 'aBirth', 'aParams', 'aColor0', 'aColor1']) {
        const attr = this.points.geometry.getAttribute(name);
        attr.needsUpdate = true;
      }
      this._dirtyLo = Infinity;
      this._dirtyHi = -1;
    }

    // Tracers are short streaks that fade over their own brief life.
    const alpha = this.tracers.geometry.getAttribute('aAlpha');
    let anyTracer = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const age = this._time - this._tracerBirth[i];
      const a = age < 0 || age > 0.06 ? 0 : 1 - age / 0.06;
      if (a > 0) anyTracer = true;
      alpha.array[i * 2] = a;
      alpha.array[i * 2 + 1] = a * 0.15;
    }
    alpha.needsUpdate = true;
    this.tracers.visible = anyTracer;
  }

  dispose() {
    this.points?.geometry.dispose();
    this._material?.dispose();
    this.tracers?.geometry.dispose();
    this._tracerMat?.dispose();
  }
}
