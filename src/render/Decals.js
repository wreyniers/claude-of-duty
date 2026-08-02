import * as THREE from 'three';

/**
 * Projected decals: bullet holes, scorch marks, blood splatter. Backed by a ring
 * buffer of a fixed budget so long firefights cannot leak memory.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * One InstancedMesh, one draw call, a fixed budget, and a ring cursor. The
 * alternative — a mesh per hit, or clipping decal geometry against the surfaces it
 * lands on — is what most hobby implementations reach for, and it costs a draw
 * call and a geometry build per bullet. At a few hundred rounds a minute that is
 * the frame budget gone, for marks that are two centimetres across.
 *
 * A quad offset along the surface normal rather than clipped geometry means a
 * decal on a corner can poke into the air, which is the accepted trade: the
 * offset is a millimetre and a half, small enough that the artefact is invisible
 * at any range you can see the hole from, and polygon-clipping every impact
 * against the BVH would cost more than the shot itself.
 *
 * The mark is drawn procedurally in the fragment shader from a per-instance seed,
 * so no two holes are identical and nothing has to be baked. Depth writes are off
 * and a small polygon offset keeps them off the z-fighting knife edge.
 *
 * CONTRACT:
 *   spawn(kind, point, normal, opts?)
 *
 * ADDITIONS (safe to rely on):
 *   budget, live
 */

const BUDGET = 320;

/** Per-kind look. `kind` reaches the shader as a float and branches there. */
const KINDS = {
  bullet: { id: 0, size: 0.075, life: 0, color: [0.06, 0.055, 0.05] },
  scorch: { id: 1, size: 0.75, life: 0, color: [0.05, 0.045, 0.04] },
  blood: { id: 2, size: 0.3, life: 26, color: [0.29, 0.02, 0.02] },
};

const VERT = /* glsl */ `
attribute vec4 aMeta;   // seed, kindId, birth, life
varying vec2 vUv;
varying vec4 vMeta;
void main() {
  vUv = uv;
  vMeta = aMeta;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vMeta;
uniform float uTime;
uniform vec3 uBullet;
uniform vec3 uScorch;
uniform vec3 uBlood;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;

  float seed = vMeta.x;
  float kind = vMeta.y;
  // A round hole reads as a sticker. Perturbing the radius by angle with a couple
  // of octaves is what makes the rim look broken instead of cut.
  float ang = atan(d.y, d.x);
  float wobble = noise(vec2(ang * 2.4 + seed * 31.0, seed * 7.0)) * 0.22
               + noise(vec2(ang * 6.1 + seed * 13.0, seed * 3.0)) * 0.1;

  float a;
  vec3 col;
  if (kind < 0.5) {
    // Bullet hole: a dark core, a bright bruised rim where the surface spalled,
    // and a scatter of small chips outside it.
    float hole = smoothstep(0.42 + wobble, 0.2 + wobble, r);
    float rim = smoothstep(0.78 + wobble, 0.4 + wobble, r) - hole;
    float chips = step(0.86, noise(d * 34.0 + seed * 19.0)) * smoothstep(1.0, 0.55, r);
    a = clamp(hole + rim * 0.55 + chips * 0.5, 0.0, 1.0);
    col = mix(uBullet * 2.6, uBullet, hole);
  } else if (kind < 1.5) {
    float body = smoothstep(1.0, 0.15, r + wobble * 0.5);
    a = body * (0.55 + 0.45 * noise(d * 9.0 + seed * 5.0));
    col = uScorch;
  } else {
    // Splatter: a main pool plus a few satellite droplets thrown outward.
    float pool = smoothstep(0.55 + wobble, 0.15, r);
    float spray = step(0.82, noise(d * 12.0 + seed * 23.0)) * smoothstep(1.0, 0.4, r);
    a = clamp(pool + spray * 0.7, 0.0, 1.0);
    col = uBlood;
  }

  // A finite life fades the mark out rather than popping it; life 0 is permanent
  // until the ring buffer reuses the slot.
  float life = vMeta.w;
  if (life > 0.0) {
    float age = uTime - vMeta.z;
    if (age > life) discard;
    a *= 1.0 - smoothstep(life * 0.6, life, age);
  }

  a *= smoothstep(1.0, 0.86, r);
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class Decals {
  constructor(game) {
    this.game = game;
    this.budget = BUDGET;
    this.live = 0;
    this.mesh = null;

    this._cursor = 0;
    this._time = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 0, 1);
    this._roll = new THREE.Quaternion();
    this._seed = 0x9e3779b9;
  }

  _rand() {
    this._seed = (this._seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this._seed ^ (this._seed >>> 15), 1 | this._seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  async init() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const meta = new THREE.InstancedBufferAttribute(new Float32Array(BUDGET * 4), 4);
    meta.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aMeta', meta);

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBullet: { value: new THREE.Vector3(...KINDS.bullet.color) },
        uScorch: { value: new THREE.Vector3(...KINDS.scorch.color) },
        uBlood: { value: new THREE.Vector3(...KINDS.blood.color) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Decals sit on the surface they mark, so they need to lose the z-fight
      // deliberately rather than by luck.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.InstancedMesh(geo, this._material, BUDGET);
    this.mesh.name = 'decals';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    // Park every slot at zero scale so nothing is drawn before it is spawned.
    this._scale.set(0, 0, 0);
    this._m.compose(this._pos.set(0, -1e4, 0), this._q.identity(), this._scale);
    for (let i = 0; i < BUDGET; i++) this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.game.scene.add(this.mesh);
  }

  /**
   * Place a mark. The quad is oriented so its +Z faces along the surface normal
   * and rolled by a random angle, because a wall of holes all at the same
   * rotation reads as a repeated sticker however good the mark itself is.
   */
  spawn(kind, point, normal, opts) {
    if (!this.mesh) return;
    const def = KINDS[kind] ?? KINDS.bullet;
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % BUDGET;
    this.live = Math.min(this.live + 1, BUDGET);

    const size = (opts?.size ?? def.size) * (0.75 + this._rand() * 0.5);
    // Align the quad's +Z to the surface normal, then roll about that normal.
    this._q.setFromUnitVectors(this._up, normal);
    this._roll.setFromAxisAngle(normal, this._rand() * Math.PI * 2);
    this._q.premultiply(this._roll);

    // Lift off the surface by a hair: enough to clear the depth buffer's slope,
    // small enough to be invisible from any range the mark itself is visible at.
    this._pos.copy(point).addScaledVector(normal, 0.0015);
    this._scale.set(size, size, size);
    this._m.compose(this._pos, this._q, this._scale);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;

    const meta = this.mesh.geometry.getAttribute('aMeta');
    meta.array[i * 4] = this._rand();
    meta.array[i * 4 + 1] = def.id;
    meta.array[i * 4 + 2] = this._time;
    meta.array[i * 4 + 3] = def.life;
    meta.needsUpdate = true;
  }

  update(dt) {
    this._time += dt;
    if (this._material) this._material.uniforms.uTime.value = this._time;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this._material?.dispose();
  }
}
