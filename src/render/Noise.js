/**
 * Seeded noise and field synthesis — the numerical layer under AssetForge.
 *
 * Two APIs live here, for two different call patterns:
 *
 *  - Point functions (`perlin2`, `simplex3`, `worley2`, `fbm2`, `ridgedMulti2`,
 *    `warpedFbm2`) for sampling a handful of values, e.g. scattering props.
 *  - Field builders (`fbmField`, `worleyField`, …) that fill a Float32Array the
 *    size of a texture. These exist because the naive "call fbm2 per texel"
 *    version costs octaves x size^2 noise evaluations and blows the boot budget.
 *    Instead each octave is generated at a resolution matched to its own
 *    frequency and the pyramid is accumulated while it is upsampled, so the
 *    total work is ~1.33x the finest octave rather than N x it.
 *
 * Everything is deterministic from an integer seed, and every lattice takes a
 * `period` so the result wraps: these maps get repeated across a 40 m wall, and
 * a lattice that does not wrap reads as a hard seam once per tile.
 */

/** Small, fast, well-distributed 32-bit PRNG. Same seed, same world, forever. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1) {
    this._f = mulberry32(seed);
  }
  float() {
    return this._f();
  }
  range(a, b) {
    return a + (b - a) * this._f();
  }
  int(n) {
    return Math.min(n - 1, (this._f() * n) | 0);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  /** Gaussian-ish via the sum of three uniforms; plenty for jitter. */
  gauss() {
    return (this._f() + this._f() + this._f() - 1.5) * 1.1547;
  }
}

function ihash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function ihash3(x, y, z, seed) {
  let h =
    Math.imul(x | 0, 0x1f1f1f1f) ^
    Math.imul(y | 0, 0x27d4eb2d) ^
    Math.imul(z | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const GRAD2X = new Float32Array(16);
const GRAD2Y = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  GRAD2X[i] = Math.cos(a);
  GRAD2Y[i] = Math.sin(a);
}

// The 12 edge-midpoint gradients of a cube: the standard simplex set.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1,
  -1,
]);

const F3 = 1 / 3;
const G3 = 1 / 6;

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function smooth(t) {
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function wrapi(i, p) {
  return p > 0 ? ((i % p) + p) % p : i;
}
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export class Noise {
  constructor(seed = 1337) {
    this.seed = seed | 0;
    // Worley returns three numbers per sample. Returning an object per texel
    // would allocate millions of times during baking, so the extra outputs land
    // on the instance and the caller reads them immediately after the call.
    this.f2 = 0;
    this.cellId = 0;
    this._cellCache = new Map();
  }

  /** Periodic 2D gradient (Perlin) noise in ~[-1,1]. `period` in lattice cells. */
  perlin2(x, y, period = 0, seed = this.seed) {
    return this.perlin2p(x, y, period, period, seed);
  }

  /**
   * Perlin with independent periods per axis, which is what anisotropic noise
   * needs: brushed metal and wood grain are the same field sampled at 40:1 in x
   * versus y, and both axes still have to wrap.
   */
  perlin2p(x, y, periodX = 0, periodY = 0, seed = this.seed) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const x0 = wrapi(xi, periodX);
    const y0 = wrapi(yi, periodY);
    const x1 = wrapi(xi + 1, periodX);
    const y1 = wrapi(yi + 1, periodY);
    let h = ihash2(x0, y0, seed) & 15;
    const n00 = GRAD2X[h] * fx + GRAD2Y[h] * fy;
    h = ihash2(x1, y0, seed) & 15;
    const n10 = GRAD2X[h] * (fx - 1) + GRAD2Y[h] * fy;
    h = ihash2(x0, y1, seed) & 15;
    const n01 = GRAD2X[h] * fx + GRAD2Y[h] * (fy - 1);
    h = ihash2(x1, y1, seed) & 15;
    const n11 = GRAD2X[h] * (fx - 1) + GRAD2Y[h] * (fy - 1);
    const u = fade(fx);
    const v = fade(fy);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4;
  }

  /** 3D simplex noise in ~[-1,1]. Non-periodic; used for volumetric variation. */
  simplex3(x, y, z, seed = this.seed) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = (ihash3(i, j, k, seed) % 12) * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = (ihash3(i + i1, j + j1, k + k1, seed) % 12) * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = (ihash3(i + i2, j + j2, k + k2, seed) % 12) * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = (ihash3(i + 1, j + 1, k + 1, seed) % 12) * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return n * 32;
  }

  /** Plain fBm. `octaves` band-limited sum of periodic gradient noise, in [-1,1]. */
  fbm2(x, y, { freq = 4, octaves = 5, lacunarity = 2, gain = 0.5, seed = this.seed, period = 0 } = {}) {
    let f = freq;
    let a = 1;
    let sum = 0;
    let norm = 0;
    let p = period || 0;
    for (let o = 0; o < octaves; o++) {
      sum += a * this.perlin2(x * f, y * f, p ? Math.round(p * (f / freq)) : 0, seed + o * 7919);
      norm += a;
      a *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Musgrave ridged multifractal: each octave is 1-|n| squared and weighted by
   * the previous octave, which is what concentrates detail on the ridge lines
   * instead of spreading it evenly. This is the recipe for cracks and eroded
   * rock; a plain |fbm| does not produce the same sharp branching creases.
   */
  ridgedMulti2(x, y, { freq = 4, octaves = 5, lacunarity = 2.07, gain = 0.5, offset = 1, sharp = 2, seed = this.seed, period = 0 } = {}) {
    let f = freq;
    let weight = 1;
    let sum = 0;
    let norm = 0;
    let a = 1;
    for (let o = 0; o < octaves; o++) {
      let n = offset - Math.abs(this.perlin2(x * f, y * f, period ? Math.round(period * (f / freq)) : 0, seed + o * 6151));
      n *= n;
      n *= weight;
      weight = clamp01(n * sharp);
      sum += n * a;
      norm += a;
      a *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Periodic Worley/cellular noise. Returns F1; F2 and the cell id land on the
   * instance (see the note in the constructor). `freq` is cells per unit, and
   * cells wrap on `freq` so the field tiles.
   */
  worley2(x, y, freq = 8, jitter = 0.85, seed = this.seed) {
    const gx = x * freq;
    const gy = y * freq;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    let f1 = 1e9;
    let f2 = 1e9;
    let id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx;
        const cy = iy + dy;
        const h = ihash2(wrapi(cx, freq), wrapi(cy, freq), seed);
        const px = cx + 0.5 + ((h & 0xffff) / 65536 - 0.5) * jitter;
        const py = cy + 0.5 + (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter;
        const ex = px - gx;
        const ey = py - gy;
        const d = ex * ex + ey * ey;
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = h;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    this.f2 = Math.sqrt(f2);
    this.cellId = id;
    return Math.sqrt(f1);
  }

  /**
   * Domain-warped fBm: sample the field at a position displaced by another fBm.
   * This is what turns isotropic blobs into the stretched, marbled, flow-like
   * structures that real weathering has.
   */
  warpedFbm2(x, y, { warp = 0.35, warpFreq = 2, ...opts } = {}) {
    const wx = this.fbm2(x + 5.2, y + 1.3, { ...opts, freq: warpFreq, octaves: 3 });
    const wy = this.fbm2(x - 3.7, y + 9.1, { ...opts, freq: warpFreq, octaves: 3, seed: (opts.seed ?? this.seed) + 5701 });
    return this.fbm2(x + wx * warp, y + wy * warp, opts);
  }

  /** Contract shim: value noise in [-1,1] for callers that just want a number. */
  noise2D(x, y) {
    return this.perlin2(x, y, 0, this.seed);
  }
}

/* ------------------------------------------------------------------ fields */

function pow2ceil(v) {
  let p = 8;
  while (p < v) p *= 2;
  return p;
}

/**
 * Bilinear+smoothstep 2x upsample with wrap. Smoothstep weights hide the grid
 * that plain bilinear leaves behind. `res` is always a power of two here, so the
 * wrap is a mask rather than a modulo — this runs once per octave per material.
 */
function upsample2(src, res) {
  const dst = new Float32Array(res * res * 4);
  const dres = res * 2;
  const m = res - 1;
  // Even destination columns land at fraction 0.75 of one cell, odd at 0.25.
  const T = [smooth(0.75), smooth(0.25)];
  for (let y = 0; y < dres; y++) {
    const y0 = (y - 1) >> 1;
    const ty = T[y & 1];
    const r0 = (y0 & m) * res;
    const r1 = ((y0 + 1) & m) * res;
    const drow = y * dres;
    for (let x = 0; x < dres; x++) {
      const x0 = (x - 1) >> 1;
      const tx = T[x & 1];
      const c0 = x0 & m;
      const c1 = (x0 + 1) & m;
      dst[drow + x] = lerp(lerp(src[r0 + c0], src[r0 + c1], tx), lerp(src[r1 + c0], src[r1 + c1], tx), ty);
    }
  }
  return dst;
}

/**
 * Texels generated per lattice cell before an octave is upsampled to the target
 * size. At 4 a low-frequency octave is built on a 16x16 grid and then magnified
 * 16x, and the interpolation quads show — especially once that field is used as a
 * warp offset, where the quantisation turns into visible stair-steps. 8 puts the
 * reconstruction error below the texel grid at a cost that lands almost entirely
 * on the cheap coarse octaves.
 */
const SAMPLES_PER_CELL = 8;

const MODE_FBM = 0;
const MODE_RIDGE = 1;
const MODE_TURB = 2;

/**
 * One octave of periodic gradient noise, accumulated into `buf`.
 *
 * The lattice index and fade weight for a column are the same on every row, so
 * they are hoisted into small lookup tables. That takes the integer division and
 * the floor out of the inner loop, which is where a full-resolution octave spent
 * most of its time — worth roughly 3x over calling perlin2p per texel.
 */
function addLayer(noise, buf, res, fx, fy, amp, seed, mode) {
  const sx = fx / res;
  const sy = fy / res;
  // Integer lattice offset: shifts the pattern per octave without breaking the
  // wrap (a fractional offset would).
  const ox = ihash2(fx, seed, 0x9e37) % 4096;
  const oy = ihash2(seed, fy, 0x85eb) % 4096;

  const X0 = new Int32Array(res);
  const X1 = new Int32Array(res);
  const U = new Float32Array(res);
  const FX = new Float32Array(res);
  for (let x = 0; x < res; x++) {
    const gx = x * sx + ox;
    const xi = Math.floor(gx);
    const f = gx - xi;
    const x0 = xi % fx;
    X0[x] = x0;
    X1[x] = x0 + 1 === fx ? 0 : x0 + 1;
    U[x] = fade(f);
    FX[x] = f;
  }

  for (let y = 0; y < res; y++) {
    const gy = y * sy + oy;
    const yi = Math.floor(gy);
    const fy0 = gy - yi;
    const fy1 = fy0 - 1;
    const v = fade(fy0);
    const y0 = yi % fy;
    const y1 = y0 + 1 === fy ? 0 : y0 + 1;
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const x0 = X0[x];
      const x1 = X1[x];
      const dx0 = FX[x];
      const dx1 = dx0 - 1;
      let h = ihash2(x0, y0, seed) & 15;
      const n00 = GRAD2X[h] * dx0 + GRAD2Y[h] * fy0;
      h = ihash2(x1, y0, seed) & 15;
      const n10 = GRAD2X[h] * dx1 + GRAD2Y[h] * fy0;
      h = ihash2(x0, y1, seed) & 15;
      const n01 = GRAD2X[h] * dx0 + GRAD2Y[h] * fy1;
      h = ihash2(x1, y1, seed) & 15;
      const n11 = GRAD2X[h] * dx1 + GRAD2Y[h] * fy1;
      const u = U[x];
      let n = (n00 + (n10 - n00) * u + (n01 + (n11 - n01) * u - (n00 + (n10 - n00) * u)) * v) * 1.4;
      if (mode === MODE_RIDGE) {
        n = 1 - Math.abs(n);
        n *= n;
      } else if (mode === MODE_TURB) {
        n = Math.abs(n);
      }
      buf[row + x] += n * amp;
    }
  }
}

/**
 * Tileable fBm into a size x size Float32Array, normalised to [0,1].
 *
 * `mode`: 'fbm' | 'ridge' | 'turbulence'. Octaves above the map's Nyquist limit
 * are dropped rather than aliased into salt-and-pepper.
 */
export function fbmField(noise, size, opts = {}) {
  const { freq = 4, octaves = 5, lacunarity = 2, gain = 0.5, seed = noise.seed, mode = 'fbm' } = opts;
  const m = mode === 'ridge' ? MODE_RIDGE : mode === 'turbulence' ? MODE_TURB : MODE_FBM;
  let fx = Math.max(1, Math.round(freq));
  let fy = Math.max(1, Math.round(opts.freqY ?? freq));
  let res = Math.min(size, pow2ceil(Math.max(fx, fy) * SAMPLES_PER_CELL));
  let buf = new Float32Array(res * res);
  addLayer(noise, buf, res, fx, fy, 1, seed, m);
  let amp = 1;

  for (let o = 1; o < octaves; o++) {
    const nx = Math.max(fx + 1, Math.round(fx * lacunarity));
    const ny = Math.max(fy + 1, Math.round(fy * lacunarity));
    if (Math.max(nx, ny) * 2 > size) break; // above Nyquist for the target map
    fx = nx;
    fy = ny;
    amp *= gain;
    const want = Math.min(size, pow2ceil(Math.max(fx, fy) * SAMPLES_PER_CELL));
    while (res < want) {
      buf = upsample2(buf, res);
      res *= 2;
    }
    addLayer(noise, buf, res, fx, fy, amp, seed + o * 131, m);
  }
  while (res < size) {
    buf = upsample2(buf, res);
    res *= 2;
  }
  return normalizeField(buf);
}

/** Rescale in place so the field spans exactly [0,1]. */
export function normalizeField(buf) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] - lo) * k;
  return buf;
}

/**
 * Tileable cellular noise field.
 *
 * `mode`:
 *   'f1'     distance to the nearest feature point — domes, pebbles, pits
 *   'edge'   F2-F1 — the cell boundary network, i.e. cracks and mortar
 *   'id'     a flat random value per cell — tiles, chips, aggregate grains
 *   'dome'   1-F1 clamped, normalised — rounded stones with dark gaps
 *
 * Feature points are precomputed per cell so the inner loop is two array reads
 * instead of a hash; at 512^2 x 9 cells that difference is a third of a second.
 */
export function worleyField(noise, size, opts = {}) {
  const { freq = 8, jitter = 0.9, mode = 'f1', seed = noise.seed, metric = 'euclid' } = opts;
  const f = Math.max(1, Math.round(freq));
  const px = new Float32Array(f * f);
  const py = new Float32Array(f * f);
  const idv = new Float32Array(f * f);
  for (let cy = 0; cy < f; cy++) {
    for (let cx = 0; cx < f; cx++) {
      const h = ihash2(cx, cy, seed);
      const i = cy * f + cx;
      px[i] = cx + 0.5 + ((h & 0xffff) / 65536 - 0.5) * jitter;
      py[i] = cy + 0.5 + (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter;
      idv[i] = ((h >>> 8) & 0xffff) / 65535;
    }
  }

  const out = new Float32Array(size * size);
  const s = f / size;
  const cheb = metric === 'chebyshev';
  const manh = metric === 'manhattan';
  // Wrapped cell index and the compensating shift, per candidate column. Without
  // these the inner loop does 18 integer divisions per texel and the pass costs
  // more than everything else in a bake put together.
  const WC = new Int32Array(f + 2);
  const WS = new Int32Array(f + 2);
  for (let i = -1; i <= f; i++) {
    const w = ((i % f) + f) % f;
    WC[i + 1] = w;
    WS[i + 1] = i - w;
  }
  const euclid = !cheb && !manh;
  for (let y = 0; y < size; y++) {
    const gy = (y + 0.5) * s;
    const iy = Math.floor(gy);
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) * s;
      const ix = Math.floor(gx);
      let f1 = 1e9;
      let f2 = 1e9;
      let id = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const j = iy + dy + 1;
        const rowOff = WC[j] * f;
        const shiftY = WS[j];
        for (let dx = -1; dx <= 1; dx++) {
          const k = ix + dx + 1;
          const i = rowOff + WC[k];
          const ex = px[i] + WS[k] - gx;
          const ey = py[i] + shiftY - gy;
          // Squared distance for the comparison; the root is taken once, after.
          const d = euclid ? ex * ex + ey * ey : cheb ? Math.max(Math.abs(ex), Math.abs(ey)) : Math.abs(ex) + Math.abs(ey);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            id = idv[i];
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
      if (euclid) {
        f1 = Math.sqrt(f1);
        f2 = Math.sqrt(f2);
      }
      const o = y * size + x;
      out[o] = mode === 'id' ? id : mode === 'edge' ? f2 - f1 : mode === 'dome' ? Math.max(0, 1 - f1 * 1.6) : f1;
    }
  }
  if (mode !== 'id') normalizeField(out);
  return out;
}

/** Sample a field with wrapping bilinear filtering at continuous coords. */
export function sampleWrap(field, size, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const a = ((x0 % size) + size) % size;
  const b = ((x0 + 1) % size + size) % size;
  const c = (((y0 % size) + size) % size) * size;
  const d = (((y0 + 1) % size + size) % size) * size;
  return lerp(lerp(field[c + a], field[c + b], tx), lerp(field[d + a], field[d + b], tx), ty);
}

/**
 * Texture-space domain warp: resample `src` displaced by two offset fields.
 * Cheaper than warping the noise domain per octave and visually equivalent once
 * the warp is smooth, which it is here.
 */
export function warpField(src, size, wx, wy, amount = 12) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      out[i] = sampleWrap(src, size, x + (wx[i] - 0.5) * amount, y + (wy[i] - 0.5) * amount);
    }
  }
  return out;
}

/** Separable box blur with wrap, `passes` of it approximating a Gaussian. */
export function blurField(src, size, radius = 2, passes = 2) {
  const n = size * size;
  let a = Float32Array.from(src);
  let b = new Float32Array(n);
  const r = Math.max(1, radius | 0);
  const inv = 1 / (r * 2 + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + ((((k % size) + size) % size))];
      for (let x = 0; x < size; x++) {
        b[row + x] = sum * inv;
        sum += a[row + ((x + r + 1) % size)] - a[row + ((x - r + size) % size)];
      }
    }
    let t = a;
    a = b;
    b = t;
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[((((k % size) + size) % size)) * size + x];
      for (let y = 0; y < size; y++) {
        b[y * size + x] = sum * inv;
        sum += a[((y + r + 1) % size) * size + x] - a[((y - r + size) % size) * size + x];
      }
    }
    t = a;
    a = b;
    b = t;
  }
  return a;
}

/**
 * Sobel normal map from a height field, packed RGBA with the height in alpha.
 *
 * Sobel (not a 2-tap difference) because the 3x3 kernel is noticeably less
 * jagged on the diagonal features that cellular noise produces, and the height
 * rides along in A so parallax/POM consumers do not need a second upload.
 */
export function sobelNormalRGBA(height, size, strength = 1) {
  const out = new Uint8Array(size * size * 4);
  const w = size;
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * w;
    const y0 = y * w;
    const yp = ((y + 1) % size) * w;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const h00 = height[ym + xm];
      const h10 = height[ym + x];
      const h20 = height[ym + xp];
      const h01 = height[y0 + xm];
      const h21 = height[y0 + xp];
      const h02 = height[yp + xm];
      const h12 = height[yp + x];
      const h22 = height[yp + xp];
      const dx = h00 + 2 * h01 + h02 - (h20 + 2 * h21 + h22);
      const dy = h00 + 2 * h10 + h20 - (h02 + 2 * h12 + h22);
      // Scale by size so a given height amplitude reads the same at any map
      // resolution: the gradient is per-texel, the surface slope is per-metre.
      const nx = dx * strength * size * 0.002;
      const ny = dy * strength * size * 0.002;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y0 + x) * 4;
      out[o] = (nx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = clamp01(height[y0 + x]) * 255;
    }
  }
  return out;
}

const AO_DIRS = 8;

/**
 * Horizon-based AO from the height field.
 *
 * For each texel, march a few steps along 8 directions and keep the largest
 * slope found — that is the horizon angle, and the fraction of the hemisphere it
 * blocks is the occlusion. Computed at half resolution because AO is inherently
 * low-frequency and this is the single most expensive step in a bake; upsampled
 * with smoothstep weights so no grid shows.
 */
export function horizonAOField(height, size, opts = {}) {
  const { relief = 0.4, steps = 4, spread = 0.035, strength = 1 } = opts;
  const r = Math.max(32, size >> 1);
  const small = new Float32Array(r * r);
  const k = size / r;
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      let s = 0;
      const sx = x * k;
      const sy = y * k;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += height[((sy + j) | 0) * size + ((sx + i) | 0)];
      small[y * r + x] = s / (k * k);
    }
  }

  // Precompute the march as integer texel offsets with their slope weights. The
  // taps are nearest-neighbour rather than bilinear: at this radius the sampling
  // error is well below the AO's own frequency content and it makes the whole
  // pass ~3x cheaper, which matters because this runs 24 times at boot.
  const maxDist = Math.max(2, spread * r);
  const tapX = new Int32Array(AO_DIRS * steps);
  const tapY = new Int32Array(AO_DIRS * steps);
  const tapW = new Float32Array(AO_DIRS * steps);
  for (let d = 0; d < AO_DIRS; d++) {
    const a = (d / AO_DIRS) * Math.PI * 2;
    for (let s = 1; s <= steps; s++) {
      const dist = (s / steps) * maxDist;
      const t = d * steps + (s - 1);
      tapX[t] = Math.round(Math.cos(a) * dist);
      tapY[t] = Math.round(Math.sin(a) * dist);
      tapW[t] = (relief * r) / dist;
    }
  }

  const ao = new Float32Array(r * r);
  const mask = r - 1; // r is a power of two, so wrapping is a mask
  const invDirs = 1 / AO_DIRS;
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      const h0 = small[y * r + x];
      let occ = 0;
      for (let d = 0; d < AO_DIRS; d++) {
        let horizon = 0;
        for (let s = 0; s < steps; s++) {
          const t = d * steps + s;
          const hs = small[(((y + tapY[t]) & mask) * r) + ((x + tapX[t]) & mask)];
          const slope = (hs - h0) * tapW[t];
          if (slope > horizon) horizon = slope;
        }
        occ += horizon / (1 + horizon); // slope -> [0,1) hemisphere fraction
      }
      ao[y * r + x] = clamp01(1 - occ * invDirs * strength);
    }
  }

  const out = new Float32Array(size * size);
  const inv = r / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out[y * size + x] = sampleWrap(ao, r, (x + 0.5) * inv - 0.5, (y + 0.5) * inv - 0.5);
  }
  return out;
}

/** Curvature (convex>0, concave<0) from the height Laplacian — edge-wear masks. */
export function curvatureField(height, size, radius = 2) {
  const blurred = blurField(height, size, radius, 2);
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = height[i] - blurred[i];
  return out;
}

/** In-place S-curve around `pivot`; the workhorse for tightening a mask. */
export function contrastField(field, amount = 2, pivot = 0.5) {
  for (let i = 0; i < field.length; i++) {
    const v = (field[i] - pivot) * amount + pivot;
    field[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return field;
}

export function remapField(field, lo, hi) {
  for (let i = 0; i < field.length; i++) field[i] = lo + (hi - lo) * field[i];
  return field;
}
