import * as THREE from 'three';

/**
 * Modular construction kit: the geometry vocabulary the map is built from.
 *
 * Two ideas carry the whole file.
 *
 * 1. NOTHING IS A SHARP BOX. Every freestanding edge is a real chamfer
 *    (`chamferBox`), and every architectural edge a chamfer alone cannot sell —
 *    a building corner, a roofline, a window reveal — gets *proud trim*: a band
 *    standing 5-13 cm off the wall so the sun catches its return. An unlit
 *    90-degree edge is the loudest tell of primitive geometry, and a highlight
 *    running along an edge is what removes it.
 *
 * 2. UVs ARE PROJECTED FROM WORLD POSITION AT MERGE TIME, not authored per
 *    generator. Generators emit position + normal + index only; `Batcher`
 *    projects each vertex along its normal's dominant axis (walls get u =
 *    lateral, v = height; floors get u = x, v = z). Texture space is therefore
 *    continuous across every piece of every wall: merge the four blocks around a
 *    doorway and the brick courses run through the join, with no per-piece UV
 *    bookkeeping and no seam to find. Materials are asked for at 1/tile repeat so
 *    one texture tile covers the metres its recipe was authored for.
 *
 * CONTRACT:
 *   new Kit(forge, rng)
 *   kit.wall(e, m, spec)        thickness, cut openings, sills, glass, blast holes
 *   kit.building(e, spec)       facades, trim, floor slabs, roof, colliders
 *   kit.stairs / railing / kerb / balcony / arcade / roof / slab
 *   kit.pipeRun / cable / column / rubble / interiorShell / windowGrid
 *   new Batcher(kit)            geometry accumulator -> a few draw calls
 *   new InstanceSet(...)        repeated props -> one draw call
 */

/**
 * What an unlit room is worth against a sunlit facade.
 *
 * Left at the shell's own recipe albedo the interior came out within three levels
 * of the plaster around it, so every opening read as a rectangle painted on the
 * wall rather than a hole through it. There is no global illumination here to
 * work out on its own that the only light reaching a closed room is skylight
 * through the opening itself, so the drop is authored into the shell's tint: a
 * stop and a half under the facade, which is roughly what a camera exposed for
 * the street records through a window.
 */
const INTERIOR_DARK = new THREE.Color(0x46413a);

/**
 * Glass has almost no diffuse albedo — a window is reflection plus whatever is
 * behind it. The recipe's near-white base is authored for a pane read close up,
 * where specular carries it; spread across a facade it lit up under skylight and
 * left the openings brighter than the wall they sit in. Tinting the vertex colour
 * takes the diffuse term down without touching the specular or the reflection,
 * which are the parts that should be doing the work.
 */
const GLASS_DIFFUSE = new THREE.Color(0x555c60);

/* ------------------------------------------------------------ mesh builder */

/**
 * Polygon soup accumulator. Facets carry their own flat normal, which is the
 * whole point: a chamfer only reads as a chamfer if its strip shades separately
 * from the two faces it joins.
 */
class MB {
  constructor() {
    this.p = [];
    this.n = [];
    this.i = [];
  }

  vert(x, y, z, nx, ny, nz) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
  }

  /**
   * Planar polygon, fanned from pts[0]. Winding is derived from the intended
   * normal rather than trusted from the caller — six face orientations times
   * forty generators is too many chances to emit an invisible wall. Only the
   * triangle order is flipped, never the vertex order, because some callers
   * (the arch spandrel) pass a concave polygon whose fan is only valid from
   * pts[0].
   */
  face(pts, nx, ny, nz) {
    let ax = 0;
    let ay2 = 0;
    let az = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      ax += (a[1] - b[1]) * (a[2] + b[2]);
      ay2 += (a[2] - b[2]) * (a[0] + b[0]);
      az += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const flip = ax * nx + ay2 * ny + az * nz < 0;
    const base = this.p.length / 3;
    for (const q of pts) this.vert(q[0], q[1], q[2], nx, ny, nz);
    for (let k = 2; k < pts.length; k++) {
      if (flip) this.i.push(base, base + k, base + k - 1);
      else this.i.push(base, base + k - 1, base + k);
    }
  }

  /**
   * Subdivided quad spanning o + du*s + dv*t. The cells exist so that
   * per-vertex splash dirt and blast scorch have somewhere to live on a wall
   * ten metres long.
   */
  grid(ox, oy, oz, du, dv, nu, nv, nx, ny, nz) {
    const base = this.p.length / 3;
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      for (let i = 0; i <= nu; i++) {
        const s = i / nu;
        this.vert(ox + du[0] * s + dv[0] * t, oy + du[1] * s + dv[1] * t, oz + du[2] * s + dv[2] * t, nx, ny, nz);
      }
    }
    const cx = du[1] * dv[2] - du[2] * dv[1];
    const cy = du[2] * dv[0] - du[0] * dv[2];
    const cz = du[0] * dv[1] - du[1] * dv[0];
    const flip = cx * nx + cy * ny + cz * nz < 0;
    const w = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * w + i;
        const b = a + 1;
        const c = a + w;
        const d = c + 1;
        if (flip) this.i.push(a, c, b, b, c, d);
        else this.i.push(a, b, c, b, d, c);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.i), 1));
    return g;
  }
}

const FACE_DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Axis-aligned box, centred, with its faces subdivided.
 *
 * `cell` is the VERTICAL cell size; horizontally the cells are 2.4x coarser.
 * The subdivision only exists to carry per-vertex splash dirt and blast soot,
 * and the splash gradient is a function of height alone — so spending triangles
 * on horizontal resolution buys nothing, and a wall panel costs less than half
 * what a square grid would.
 */
export function plainBox(w, h, d, cell = 0, invert = false) {
  const mb = new MB();
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const segV = (len) => (cell > 0 ? Math.max(1, Math.min(8, Math.round(len / cell))) : 1);
  const segH = (len) => (cell > 0 ? Math.max(1, Math.min(6, Math.round(len / (cell * 2.4)))) : 1);
  const s = invert ? -1 : 1;
  for (const sx of [1, -1]) mb.grid(sx * hx, -hy, -hz, [0, 0, d], [0, h, 0], segH(d), segV(h), sx * s, 0, 0);
  for (const sy of [1, -1]) mb.grid(-hx, sy * hy, -hz, [w, 0, 0], [0, 0, d], segH(w), segH(d), 0, sy * s, 0);
  for (const sz of [1, -1]) mb.grid(-hx, -hy, sz * hz, [w, 0, 0], [0, h, 0], segH(w), segV(h), 0, 0, sz * s);
  return mb.geometry();
}

/**
 * Chamfered box: 6 inset faces, 12 edge strips, 8 corner triangles. The edge
 * strips are the entire reason this exists — they are the facets that flare when
 * the sun rakes across an edge, and they are what a BoxGeometry can never do.
 */
export function chamferBox(w, h, d, c = 0.03) {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  c = Math.max(0.003, Math.min(c, hx * 0.45, hy * 0.45, hz * 0.45));
  const half = [hx, hy, hz];
  const ins = [hx - c, hy - c, hz - c];
  const mb = new MB();

  for (const [dx, dy, dz] of FACE_DIRS) {
    const axis = dx ? 0 : dy ? 1 : 2;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const sign = dx + dy + dz;
    const pts = [];
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const p = [0, 0, 0];
      p[axis] = sign * half[axis];
      p[u] = su * ins[u];
      p[v] = sv * ins[v];
      pts.push(p);
    }
    mb.face(pts, dx, dy, dz);
  }

  const inv = Math.SQRT1_2;
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const long = 3 - a - b;
    for (const sa of [-1, 1]) {
      for (const sb of [-1, 1]) {
        const mk = (onA, sl) => {
          const p = [0, 0, 0];
          p[a] = onA ? sa * half[a] : sa * ins[a];
          p[b] = onA ? sb * ins[b] : sb * half[b];
          p[long] = sl * ins[long];
          return p;
        };
        const n = [0, 0, 0];
        n[a] = sa * inv;
        n[b] = sb * inv;
        mb.face([mk(true, -1), mk(false, -1), mk(false, 1), mk(true, 1)], n[0], n[1], n[2]);
      }
    }
  }

  const k = 1 / Math.sqrt(3);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        mb.face(
          [
            [sx * hx, sy * ins[1], sz * ins[2]],
            [sx * ins[0], sy * hy, sz * ins[2]],
            [sx * ins[0], sy * ins[1], sz * hz],
          ],
          sx * k,
          sy * k,
          sz * k
        );
      }
    }
  }
  return mb.geometry();
}

/**
 * Chamfered *bar*: the same lit-edge trick as `chamferBox`, but only on the four
 * edges that run along the longest axis, with flat octagonal ends.
 *
 * This exists because trim is where the triangles go. Reveals, string courses,
 * copings, kerbs, treads and mullions are all long thin bars, they accounted for
 * 43% of this map's triangle budget as full chamfer boxes, and the eight corner
 * facets they were paying for sit at the ends — which on a bar of trim are
 * always butted into the next piece. 28 triangles instead of 44, for an edge
 * highlight the eye cannot tell apart.
 */
export function chamferBar(w, h, d, c = 0.03) {
  const half = [w / 2, h / 2, d / 2];
  // Longest axis runs the length of the bar; the other two get chamfered.
  let L = 0;
  if (half[1] > half[L]) L = 1;
  if (half[2] > half[L]) L = 2;
  const a = (L + 1) % 3;
  const b = (L + 2) % 3;
  c = Math.max(0.003, Math.min(c, half[a] * 0.45, half[b] * 0.45));
  const ins = [half[0], half[1], half[2]];
  ins[a] -= c;
  ins[b] -= c;
  const mb = new MB();
  const at = (sl, pa, pb) => {
    const p = [0, 0, 0];
    p[L] = sl * half[L];
    p[a] = pa;
    p[b] = pb;
    return p;
  };

  for (const [axis, other] of [
    [a, b],
    [b, a],
  ]) {
    for (const s of [1, -1]) {
      const n = [0, 0, 0];
      n[axis] = s;
      const q = [];
      for (const sl of [-1, 1]) {
        for (const so of [-1, 1]) {
          const p = [0, 0, 0];
          p[L] = sl * half[L];
          p[axis] = s * half[axis];
          p[other] = so * ins[other];
          q.push(p);
        }
      }
      mb.face([q[0], q[1], q[3], q[2]], n[0], n[1], n[2]);
    }
  }
  const inv = Math.SQRT1_2;
  for (const sa of [-1, 1]) {
    for (const sb of [-1, 1]) {
      const n = [0, 0, 0];
      n[a] = sa * inv;
      n[b] = sb * inv;
      const q = [];
      for (const sl of [-1, 1]) {
        q.push(at(sl, sa * half[a], sb * ins[b]), at(sl, sa * ins[a], sb * half[b]));
      }
      mb.face([q[0], q[1], q[3], q[2]], n[0], n[1], n[2]);
    }
  }
  // Octagonal end caps, in order around the section.
  for (const sl of [1, -1]) {
    const n = [0, 0, 0];
    n[L] = sl;
    mb.face(
      [
        at(sl, ins[a], -half[b]),
        at(sl, half[a], -ins[b]),
        at(sl, half[a], ins[b]),
        at(sl, ins[a], half[b]),
        at(sl, -ins[a], half[b]),
        at(sl, -half[a], ins[b]),
        at(sl, -half[a], -ins[b]),
        at(sl, -ins[a], -half[b]),
      ],
      n[0],
      n[1],
      n[2]
    );
  }
  return mb.geometry();
}

/** Cloth-like sagging quad: awnings, laundry, tarpaulins over rubble. */
export function saggingQuad(w, d, sag, nu = 5, nv = 4) {
  const mb = new MB();
  const pos = [];
  for (let j = 0; j <= nv; j++) {
    const t = j / nv;
    for (let i = 0; i <= nu; i++) {
      const s = i / nu;
      // Product of two arches so the corners stay pinned where they are lashed:
      // that shape is what makes stretched fabric read as fabric and not board.
      pos.push([(s - 0.5) * w, -sag * (Math.sin(Math.PI * s) * 0.65 + 0.35) * Math.sin(Math.PI * t), (t - 0.5) * d]);
    }
  }
  const w1 = nu + 1;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      // Central differences, clamped to one-sided at the hems, so the corner
      // vertices get a real normal instead of a zero-length one.
      const p0 = pos[j * w1 + Math.max(i - 1, 0)];
      const px = pos[j * w1 + Math.min(i + 1, nu)];
      const q0 = pos[Math.max(j - 1, 0) * w1 + i];
      const pz = pos[Math.min(j + 1, nv) * w1 + i];
      const p = pos[j * w1 + i];
      const ax = px[0] - p0[0];
      const ay2 = px[1] - p0[1];
      const by = pz[1] - q0[1];
      const bz = pz[2] - q0[2];
      let nx = ay2 * bz;
      let ny = -ax * bz;
      let nz = ax * by;
      const l = Math.hypot(nx, ny, nz) || 1;
      mb.vert(p[0], p[1], p[2], nx / l, Math.abs(ny / l), nz / l);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * w1 + i;
      mb.i.push(a, a + 1, a + w1, a + 1, a + w1 + 1, a + w1);
      mb.i.push(a, a + w1, a + 1, a + 1, a + w1, a + w1 + 1);
    }
  }
  return mb.geometry();
}

/**
 * Crossed alpha cards, the workhorse for grass, weeds and leaf clusters.
 * Normals are bowed outward from the tuft's axis and biased upward, so a clump
 * shades as a rounded volume rather than as two flat rectangles.
 */
export function crossCards(w, h, cards = 2, bow = 0.55) {
  const mb = new MB();
  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI + 0.2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const base = mb.p.length / 3;
    for (let i = 0; i <= 2; i++) {
      const s = i / 2 - 0.5;
      let nx = cz * s * 2 * bow;
      let nz = -cx * s * 2 * bow;
      const nl = Math.hypot(nx, 1, nz);
      nx /= nl;
      nz /= nl;
      for (let j = 0; j <= 1; j++) mb.vert(cx * s * w, j * h, cz * s * w, nx, 1 / nl, nz);
    }
    for (let i = 0; i < 2; i++) {
      const a0 = base + i * 2;
      mb.i.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);
      mb.i.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
    }
  }
  const g = mb.geometry();
  // Alpha cards are the one case that needs authored UVs: the mask is the shape.
  const n = g.attributes.position.count;
  const uv = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    const idx = v % 6;
    uv[v * 2] = (idx >> 1) / 2;
    uv[v * 2 + 1] = idx & 1;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.userData.keepUV = true;
  return g;
}

/** Single alpha card, pivoted at one edge: palm fronds, banana leaves, signs. */
export function leafCard(len, wid, droop = 0.35, segs = 4) {
  const mb = new MB();
  const base = mb.p.length / 3;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = -droop * t * t * len;
    const x = t * len;
    const hw = (wid / 2) * (0.35 + Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.8);
    const slope = (-2 * droop * t * len) / len;
    const nl = Math.hypot(slope, 1);
    for (const s of [-1, 1]) mb.vert(x, y, s * hw, -slope / nl, 1 / nl, s * 0.12);
  }
  for (let i = 0; i < segs; i++) {
    const a = base + i * 2;
    mb.i.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    mb.i.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = mb.geometry();
  const n = g.attributes.position.count;
  const uv = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    uv[v * 2] = (v >> 1) / segs;
    uv[v * 2 + 1] = v & 1;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.userData.keepUV = true;
  return g;
}

/* ------------------------------------------------------------------ batching */

const _ntmp = new THREE.Matrix3();

/** Bound to one zone of a Batcher; the handle every Kit method emits through. */
class Emitter {
  constructor(batcher, zone) {
    this.batcher = batcher;
    this.zone = zone;
  }
  add(matKey, geometry, matrix, opts) {
    this.batcher.add(this.zone, matKey, geometry, matrix, opts);
    return this;
  }
  box(matKey, w, h, d, matrix, opts) {
    return this.add(matKey, this.batcher.kit.box(w, h, d, opts?.cell ?? 1.4, opts?.invert), matrix, opts);
  }
  chamfer(matKey, w, h, d, c, matrix, opts) {
    return this.add(matKey, this.batcher.kit.chamfer(w, h, d, c), matrix, opts);
  }
  collide(w, h, d, matrix) {
    this.batcher.addCollider(w, h, d, matrix);
    return this;
  }
  scorch(x, y, z, r, s) {
    this.batcher.scorch(x, y, z, r, s);
    return this;
  }
}

/**
 * Collects transformed geometry into per-(zone, material) buckets and merges
 * each bucket into one BufferGeometry.
 *
 * Zones exist for shadows, not tidiness. One merged mesh for the whole map
 * cannot be frustum-culled, so all four shadow cascades would redraw every wall
 * on the map at every resolution. Splitting by district keeps each merged mesh
 * small enough that the near cascade only ever sees the buildings beside the
 * player.
 */
export class Batcher {
  constructor(kit) {
    this.kit = kit;
    this.groups = new Map();
    this.scorches = [];
    this.colliders = [];
    this._zones = new Map();
    this.stats = { entries: 0, triangles: 0, meshes: 0, vertices: 0 };
    const noise = kit?.forge?.noise;
    this._n2 = noise ? (x, y) => noise.perlin2(x, y) : () => 0;
  }

  zone(name) {
    let z = this._zones.get(name);
    if (!z) {
      z = new Emitter(this, name);
      this._zones.set(name, z);
    }
    return z;
  }

  add(zone, matKey, geometry, matrix, opts) {
    const key = `${zone}::${matKey}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { zone, matKey, entries: [], verts: 0, idx: 0 };
      this.groups.set(key, g);
    }
    const tint = opts?.tint;
    g.entries.push({
      geo: geometry,
      m: matrix ? matrix.clone() : new THREE.Matrix4(),
      r: tint ? tint.r : 1,
      g: tint ? tint.g : 1,
      b: tint ? tint.b : 1,
      keepUV: (opts?.keepUV ?? geometry.userData.keepUV) === true,
      us: opts?.uvScale ? opts.uvScale[0] : 1,
      vs: opts?.uvScale ? opts.uvScale[1] : 1,
      grime: opts?.grime ?? 1,
      mottle: opts?.mottle ?? 0,
      mottleScale: opts?.mottleScale ?? 0.035,
    });
    g.verts += geometry.attributes.position.count;
    g.idx += geometry.index ? geometry.index.count : geometry.attributes.position.count;
    this.stats.entries++;
    return this;
  }

  /** Box-shaped collision proxy, in whatever space `matrix` is in. */
  addCollider(w, h, d, matrix) {
    this.colliders.push({ w, h, d, m: matrix.clone() });
  }

  /**
   * A blast centre. Darkens vertex colour on everything within its radius, so
   * soot runs across the wall-to-floor boundary instead of stopping at it —
   * which is the difference between damage and a sticker.
   */
  scorch(x, y, z, r, s = 0.55) {
    this.scorches.push({ x, y, z, r, s });
  }

  /** Merge every bucket. `matFor(matKey, zone)` supplies materials. */
  build(root, matFor, onMesh) {
    const meshes = [];
    for (const g of this.groups.values()) {
      const geo = this._mergeGroup(g);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, matFor(g.matKey, g.zone));
      mesh.name = `${g.zone}.${g.matKey}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      onMesh?.(mesh, g.zone, g.matKey);
      root.add(mesh);
      meshes.push(mesh);
      this.stats.triangles += geo.index.count / 3;
      this.stats.vertices += geo.attributes.position.count;
      this.stats.meshes++;
    }
    return meshes;
  }

  /** All collision proxies as one world-space geometry, or null. */
  buildColliders() {
    if (!this.colliders.length) return null;
    const mb = new MB();
    const v = new THREE.Vector3();
    for (const c of this.colliders) {
      const hx = c.w / 2;
      const hy = c.h / 2;
      const hz = c.d / 2;
      const base = mb.p.length / 3;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            v.set(sx * hx, sy * hy, sz * hz).applyMatrix4(c.m);
            mb.vert(v.x, v.y, v.z, 0, 1, 0);
          }
        }
      }
      // Corner index bits: x = 4, y = 2, z = 1, from the sign loops above.
      const q = (a, b, c2, d) => mb.i.push(base + a, base + b, base + c2, base + a, base + c2, base + d);
      q(0, 1, 3, 2);
      q(4, 6, 7, 5);
      q(0, 4, 5, 1);
      q(2, 3, 7, 6);
      q(0, 2, 6, 4);
      q(1, 5, 7, 3);
    }
    return mb.geometry();
  }

  _mergeGroup(g) {
    const nv = g.verts;
    if (!nv) return null;
    const pos = new Float32Array(nv * 3);
    const nrm = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const col = new Float32Array(nv * 3);
    const idx = nv > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx);
    const sc = this.scorches;
    let vo = 0;
    let io = 0;

    for (const e of g.entries) {
      const src = e.geo;
      const sp = src.attributes.position.array;
      const sn = src.attributes.normal.array;
      const su = e.keepUV && src.attributes.uv ? src.attributes.uv.array : null;
      // A piece may arrive with its own baked vertex colour — edge wear along a
      // chamfer, a contact gradient up a foot. The merge multiplies it into the
      // piece tint rather than replacing it, which is the only way relief that
      // belongs to the *shape* can survive into a merged mesh: nothing
      // downstream knows a panel from a parapet, and a texture cannot know where
      // a fold is.
      const sc2 = src.attributes.color ? src.attributes.color.array : null;
      const count = src.attributes.position.count;
      const m = e.m.elements;
      _ntmp.setFromMatrix4(e.m).invert().transpose();
      const nm = _ntmp.elements;

      for (let i = 0; i < count; i++) {
        const x = sp[i * 3];
        const y = sp[i * 3 + 1];
        const z = sp[i * 3 + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const o3 = (vo + i) * 3;
        pos[o3] = wx;
        pos[o3 + 1] = wy;
        pos[o3 + 2] = wz;

        const ox = sn[i * 3];
        const oy = sn[i * 3 + 1];
        const oz = sn[i * 3 + 2];
        let px = nm[0] * ox + nm[3] * oy + nm[6] * oz;
        let py = nm[1] * ox + nm[4] * oy + nm[7] * oz;
        let pz = nm[2] * ox + nm[5] * oy + nm[8] * oz;
        const nl = Math.hypot(px, py, pz) || 1;
        px /= nl;
        py /= nl;
        pz /= nl;
        nrm[o3] = px;
        nrm[o3 + 1] = py;
        nrm[o3 + 2] = pz;

        const ax = px < 0 ? -px : px;
        const ay = py < 0 ? -py : py;
        const az = pz < 0 ? -pz : pz;
        const o2 = (vo + i) * 2;
        if (su) {
          uv[o2] = su[i * 2] * e.us;
          uv[o2 + 1] = su[i * 2 + 1] * e.vs;
        } else if (ay >= ax && ay >= az) {
          uv[o2] = wx * e.us;
          uv[o2 + 1] = wz * e.vs;
        } else if (ax >= az) {
          uv[o2] = wz * e.us;
          uv[o2 + 1] = wy * e.vs;
        } else {
          uv[o2] = wx * e.us;
          uv[o2 + 1] = wy * e.vs;
        }

        // Splash zone: rain throws grit up the bottom 1.7 m of anything
        // vertical. Free at merge time, and it is most of what makes a wall look
        // like it has stood outdoors for thirty years.
        let f = 1;
        // Large-scale albedo drift. Only safe on continuous surfaces that share
        // vertices (ground slabs, roof decks): across separate wall pieces the
        // interpolation would break at every join.
        if (e.mottle > 0) {
          f *= 1 + e.mottle * (this._n2(wx * e.mottleScale, wz * e.mottleScale) * 0.5 + 0.18);
        }
        if (ay < 0.62 && e.grime > 0) {
          const t = wy < 0 ? 0 : wy > 1.7 ? 1 : wy / 1.7;
          f = 1 - e.grime * 0.28 * (1 - t * t * (3 - 2 * t));
        }
        for (let s = 0; s < sc.length; s++) {
          const d = Math.hypot(wx - sc[s].x, wy - sc[s].y, wz - sc[s].z);
          if (d < sc[s].r) {
            const k = 1 - d / sc[s].r;
            f *= 1 - sc[s].s * k * k;
          }
        }
        col[o3] = e.r * f * (sc2 ? sc2[i * 3] : 1);
        col[o3 + 1] = e.g * f * (sc2 ? sc2[i * 3 + 1] : 1);
        col[o3 + 2] = e.b * f * (sc2 ? sc2[i * 3 + 2] : 1);
      }

      if (src.index) {
        const si = src.index.array;
        for (let i = 0; i < si.length; i++) idx[io + i] = si[i] + vo;
        io += si.length;
      } else {
        for (let i = 0; i < count; i++) idx[io + i] = vo + i;
        io += count;
      }
      vo += count;
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}

/**
 * One draw call for a repeated prop, with per-instance colour so that a row of
 * drums is not a row of clones.
 */
export class InstanceSet {
  constructor(name, geometry, matKey) {
    this.name = name;
    this.geometry = geometry;
    this.matKey = matKey;
    this.items = [];
  }
  push(matrix, color) {
    this.items.push({ m: matrix.clone(), c: color });
    return this;
  }
  get count() {
    return this.items.length;
  }
  build(matFor) {
    if (!this.items.length) return null;
    // A white vertex colour so an instanced prop can share its material — and
    // therefore its compiled program — with the merged batch that uses the same
    // recipe. `vertexColors` with no colour attribute renders black, and a
    // second program per material is minutes of shader compilation on the
    // software rasteriser the capture harness runs on.
    if (!this.geometry.attributes.color) {
      const n = this.geometry.attributes.position.count;
      const white = new Float32Array(n * 3).fill(1);
      this.geometry.setAttribute('color', new THREE.BufferAttribute(white, 3));
    }
    const mesh = new THREE.InstancedMesh(this.geometry, matFor(this.matKey), this.items.length);
    const c = new THREE.Color();
    for (let i = 0; i < this.items.length; i++) {
      mesh.setMatrixAt(i, this.items[i].m);
      // A Color as well as a hex, because instance colour is a linear multiplier
      // over an authored albedo and the useful tints are the ones that do not
      // change its value — which puts at least one channel above 1, and a hex
      // cannot say that. The attribute is float32, so the shader takes it fine.
      const tint = this.items[i].c;
      if (tint && tint.isColor) c.copy(tint);
      else c.setHex(tint ?? 0xffffff);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = `inst.${this.name}`;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

/* ---------------------------------------------------------------------- kit */

export class Kit {
  constructor(forge, rng) {
    this.forge = forge;
    this.rng = rng;
    this._cache = new Map();
  }

  /** Shape cache: the level asks for the same 0.44 m wall block hundreds of times. */
  _shape(key, make) {
    let g = this._cache.get(key);
    if (!g) {
      g = make();
      this._cache.set(key, g);
    }
    return g;
  }

  box(w, h, d, cell = 1.4, invert = false) {
    return this._shape(`b${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)},${cell},${invert ? 1 : 0}`, () =>
      plainBox(w, h, d, cell, invert)
    );
  }

  /**
   * Chamfered box, or a chamfered *bar* when the piece is long and thin. The
   * dispatch is automatic so every call site gets the cheap version where the
   * cheap version is indistinguishable — which is most of the trim on the map.
   */
  chamfer(w, h, d, c = 0.03) {
    const bar = Math.max(w, h, d) / Math.max(1e-4, Math.min(w, h, d)) > 2.6;
    return this._shape(`${bar ? 'r' : 'c'}${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)},${c.toFixed(3)}`, () =>
      bar ? chamferBar(w, h, d, c) : chamferBox(w, h, d, c)
    );
  }

  /** Full 12-edge chamfer, for the few places a bar's flat ends would show. */
  chamferAll(w, h, d, c = 0.03) {
    return this._shape(`c${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)},${c.toFixed(3)}`, () => chamferBox(w, h, d, c));
  }

  /**
   * `hSeg` is only ever worth spending on a piece that carries a vertex-baked
   * gradient along its own axis — a drum shell with grit up its foot, say. A
   * one-segment tube has vertices at its two ends and nothing in between, so any
   * such bake interpolates as a single straight ramp end to end.
   */
  cylinder(rt, rb, h, seg = 10, open = false, hSeg = 1) {
    return this._shape(`y${rt},${rb},${h},${seg},${open ? 1 : 0},${hSeg}`, () =>
      new THREE.CylinderGeometry(rt, rb, h, seg, hSeg, open)
    );
  }

  torus(r, tube, seg = 12, tSeg = 6) {
    return this._shape(`t${r},${tube},${seg},${tSeg}`, () => new THREE.TorusGeometry(r, tube, tSeg, seg));
  }

  sphere(r, w = 10, h = 7) {
    return this._shape(`s${r},${w},${h}`, () => new THREE.SphereGeometry(r, w, h));
  }

  /** Half-dome / cap, for minaret finials and satellite dishes. */
  dome(r, thetaLen = Math.PI / 2, w = 12, h = 6) {
    return this._shape(`d${r},${thetaLen.toFixed(2)},${w},${h}`, () => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, thetaLen));
  }

  /* ------------------------------------------------------------------ walls */

  /**
   * Wall with real thickness and genuinely cut openings.
   *
   * The opening list becomes a rectangular decomposition: vertical strips
   * between opening edges, then vertical gaps inside each strip. Every block is
   * a solid with its own collider, so a doorway is walkable and a sill is
   * something you can rest a rifle on — which a hole painted into a texture can
   * never be.
   *
   * Local frame: length along X centred on 0, thickness along Z centred on 0,
   * base at y = 0. Openings are { x: centre, y: bottom, w, h, arch?, glass?,
   * blast?, trim? }.
   */
  wall(e, m, spec) {
    const {
      length: L,
      height: H,
      thickness: T = 0.44,
      mat = 'plaster_painted',
      openings = [],
      tint,
      collide = true,
      cell = 1.4,
      grime = 1,
      trimMat = 'concrete_cast',
      recess = false,
    } = spec;
    const half = L / 2;
    const cuts = [-half, half];
    for (const o of openings) cuts.push(o.x - o.w / 2, o.x + o.w / 2);
    cuts.sort((a, b) => a - b);
    const uniq = [cuts[0]];
    for (let i = 1; i < cuts.length; i++) if (cuts[i] - uniq[uniq.length - 1] > 0.02) uniq.push(cuts[i]);

    const M = new THREE.Matrix4();
    const emit = (cx, y0, y1, w) => {
      const h = y1 - y0;
      if (h < 0.02 || w < 0.02) return;
      M.makeTranslation(cx, (y0 + y1) / 2, 0).premultiply(m);
      e.add(mat, this.box(w, h, T, cell), M, { tint, grime });
      if (collide) e.collide(w, h, T, M);
    };

    const topOf = (o) => o.y + o.h + (o.arch ? o.w / 2 : 0);
    for (let s = 0; s < uniq.length - 1; s++) {
      const a = uniq[s];
      const b = uniq[s + 1];
      const w = b - a;
      const cx = (a + b) / 2;
      const cover = openings.filter((o) => o.x - o.w / 2 <= a + 0.01 && o.x + o.w / 2 >= b - 0.01).sort((p, q) => p.y - q.y);
      if (!cover.length) {
        emit(cx, 0, H, w);
        continue;
      }
      let cursor = 0;
      for (const o of cover) {
        emit(cx, cursor, o.y, w);
        cursor = Math.max(cursor, topOf(o));
      }
      emit(cx, cursor, H, w);
    }

    for (const o of openings) {
      if (recess) this.recessBack(e, m, o, T);
      if (o.arch) this.archPatch(e, m, o, T, spec.archMat ?? mat, tint);
      if (o.trim !== false) this.openingTrim(e, m, o, T, trimMat, spec.trimTint, spec.trimBothSides === true);
      if (o.glass) this.glazing(e, m, o, T);
      if (o.blast) this.blastRim(e, m, o, T, tint);
      if (o.shutter) this.shutter(e, m, o, T, o.shutter);
    }
  }

  /**
   * Proud reveal around an opening: lintel, sill with a drip nose, two jambs,
   * all chamfered and standing off the wall face. The lit return of a reveal is
   * what tells the eye the wall has thickness at fifty metres, where the actual
   * thickness is a couple of pixels.
   */
  openingTrim(e, m, o, T, mat, tint, both = false) {
    const M = new THREE.Matrix4();
    const w = o.w;
    const jw = 0.13;
    const p = T / 2 + 0.05;
    const put = (x, y, bw, bh, bd, dz) => {
      M.makeTranslation(x, y, dz).premultiply(m);
      e.add(mat, this.chamfer(bw, bh, bd, 0.022), M, { tint });
    };
    // Outer face only unless asked: the inner reveal of a hollow building is
    // behind its interior shell, and reveal trim is the vertex-heaviest thing
    // on a facade.
    for (const sz of both ? [1, -1] : [1]) {
      const dz = sz * p;
      // An arch carries its own head, so it gets no lintel — a straight lintel
      // over an arch is the classic procedural giveaway.
      if (!o.arch) put(o.x, o.y + o.h + 0.09, w + jw * 2 + 0.12, 0.18, 0.15, dz * 1.05);
      put(o.x, o.y - 0.055, w + jw * 2 + 0.18, 0.11, 0.25, dz * 1.2);
      // Jambs only on the storeys a player can read them on. Above about seven
      // metres a 13 cm reveal is under a pixel from anywhere in the map, and
      // reveal trim is the vertex-heaviest thing on a facade by a wide margin.
      if (o.y < 7) for (const sx of [-1, 1]) put(o.x + sx * (w / 2 + jw / 2), o.y + o.h / 2, jw, o.h, 0.1, dz);
    }
  }

  /**
   * The dark volume an opening looks into, closed off at the inner face of the
   * wall.
   *
   * `interiorShell` is supposed to be this, but it sits a further half metre in
   * and measurably does not reach the frame: with the shell tinted to a probe
   * colour the openings on the north block came back at the value of the plaster
   * around them, 151 against 151, unchanged. Whatever the shell is doing, a panel
   * at the back of the reveal is the thing that cannot miss — it is exactly as
   * deep as the wall is thick, so the opening reads as 44 cm of shadowed return
   * and then nothing, which is what a window in a building nobody is standing in
   * looks like from across a square.
   */
  recessBack(e, m, o, T) {
    // Arch heads carry their opening above `h`, and a rectangular panel that
    // stopped at the springing would leave a lit crescent at the top.
    const h = o.h + (o.arch ? o.w / 2 + 0.06 : 0);
    const M = new THREE.Matrix4().makeTranslation(o.x, o.y + h / 2, -T / 2 - 0.05).premultiply(m);
    e.add('concrete_cast', this.box(o.w + 0.08, h + 0.08, 0.1, 0), M, { tint: INTERIOR_DARK, grime: 0 });
  }

  /** Dirty glazing set back in the reveal. Sky reflection in a window is one of
   *  the cheapest large gains available on a facade. */
  glazing(e, m, o, T) {
    // Hung deep in the reveal rather than near the outer face: the shaded return
    // above and beside the pane is most of what says "hole" at thirty metres,
    // where the 44 cm of wall thickness is three pixels of perspective.
    const M = new THREE.Matrix4().makeTranslation(o.x, o.y + o.h / 2, -T * 0.34).premultiply(m);
    e.add('glass_dirty', this.box(o.w - 0.1, o.h - 0.1, 0.02, 0), M, { grime: 0, tint: GLASS_DIFFUSE });
    // Frame: two mullions, so the pane reads as joinery rather than a blue slab.
    const F = new THREE.Matrix4();
    F.makeTranslation(o.x, o.y + o.h * 0.52, -T * 0.3).premultiply(m);
    e.add('wood_plank_weathered', this.chamfer(o.w - 0.1, 0.055, 0.05, 0.012), F, {});
    F.makeTranslation(o.x, o.y + o.h / 2, -T * 0.3).premultiply(m);
    e.add('wood_plank_weathered', this.chamfer(0.05, o.h - 0.1, 0.05, 0.012), F, {});
  }

  /** A louvred shutter hanging off one jamb, half of them at a broken angle. */
  shutter(e, m, o, T, spec) {
    const side = spec.side ?? 1;
    const ang = spec.angle ?? -0.5;
    const M = new THREE.Matrix4()
      .makeTranslation(o.x + side * (o.w / 2 + 0.03), o.y + o.h / 2, T / 2 + 0.06)
      .multiply(new THREE.Matrix4().makeRotationY(side * ang))
      .multiply(new THREE.Matrix4().makeTranslation((-side * o.w) / 4, 0, 0));
    M.premultiply(m);
    e.add('wood_plank_weathered', this.chamfer(o.w / 2, o.h * 0.94, 0.05, 0.014), M, { tint: spec.tint });
    for (let i = 0; i < 4; i++) {
      const S = new THREE.Matrix4()
        .makeTranslation(0, o.h * 0.94 * (i / 4 - 0.375), 0.035)
        .premultiply(M);
      e.add('wood_plank_weathered', this.chamfer(o.w / 2 - 0.05, o.h * 0.12, 0.02, 0.008), S, { tint: spec.tint });
    }
  }

  /**
   * The rim of a shell hole: broken masonry lumps around the edge, exposed
   * rebar, plaster loss showing the brick course beneath, and a scorch registered
   * so the soot bleeds onto the neighbouring geometry.
   */
  blastRim(e, m, o, T, tint) {
    const rng = this.rng;
    const M = new THREE.Matrix4();
    const cx = o.x;
    const cy = o.y + o.h / 2;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const rx = (o.w / 2) * rng.range(0.85, 1.12);
      const ry = (o.h / 2) * rng.range(0.85, 1.12);
      const s = rng.range(0.1, 0.26);
      M.makeTranslation(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, rng.range(-T / 3, T / 3))
        .multiply(new THREE.Matrix4().makeRotationY(rng.float() * 3))
        .multiply(new THREE.Matrix4().makeRotationZ(rng.float() * 3))
        .premultiply(m);
      e.add('brick_red', this.chamfer(s * 1.6, s, T * rng.range(0.5, 0.95), s * 0.2), M, { tint });
    }
    for (let i = 0; i < 3; i++) {
      const len = rng.range(0.35, 0.8);
      M.makeTranslation(cx + rng.range(-o.w / 2, o.w / 2), cy + rng.range(-o.h / 3, o.h / 3), 0)
        .multiply(new THREE.Matrix4().makeRotationY(rng.range(-1, 1)))
        .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-1.4, 1.4)))
        .premultiply(m);
      e.add('steel_rusted', this.cylinder(0.01, 0.011, len, 5), M, { keepUV: true, uvScale: [1, len] });
    }
    this.plasterLoss(e, m, cx, cy, o.w * 1.9, o.h * 1.7, T);
    const w = new THREE.Vector3(cx, cy, T / 2).applyMatrix4(m);
    e.scorch(w.x, w.y, w.z, Math.max(o.w, o.h) * 1.7, 0.5);
  }

  /**
   * Missing plaster showing brick beneath: three overlapping patches at
   * different sizes so the outline is ragged, each with a proud torn lip along
   * its top edge. Sharp material change plus a real lip is what stops this
   * reading as a painted-on stain.
   */
  plasterLoss(e, m, cx, cy, w, h, T) {
    const rng = this.rng;
    const M = new THREE.Matrix4();
    // Four smaller patches rather than three big ones, each with a proud torn
    // lip along its top edge, and the brick weathered down: a full-size clean
    // rectangle of new brick reads as a poster stuck to the wall.
    const brick = new THREE.Color(0x9a8b7e);
    for (let i = 0; i < 4; i++) {
      const pw = w * rng.range(0.3, 0.62);
      const ph = h * rng.range(0.26, 0.6);
      const px = cx + rng.range(-w * 0.3, w * 0.3);
      const py = cy + rng.range(-h * 0.3, h * 0.3);
      M.makeTranslation(px, py, T / 2 - 0.014).premultiply(m);
      e.add('brick_red', this.box(pw, ph, 0.032, 0.9), M, { tint: brick });
      for (const sy of [1, -1]) {
        M.makeTranslation(px + rng.range(-0.1, 0.1), py + (sy * ph) / 2, T / 2 + 0.006).premultiply(m);
        e.add('plaster_painted', this.chamfer(pw * rng.range(0.65, 1.05), 0.06, 0.032, 0.01), M, {});
      }
    }
  }

  /**
   * Semicircular arch head over a rectangular opening of width w. Two spandrels
   * front and back plus a real curved soffit between them, so the arch has
   * depth instead of being a painted horseshoe.
   */
  archPatch(e, m, o, T, mat, tint) {
    const r = o.w / 2;
    const segs = 14;
    const g = this._shape(`arch${r.toFixed(3)},${T.toFixed(3)}`, () => {
      const mb = new MB();
      for (const sz of [1, -1]) {
        for (const side of [1, -1]) {
          const pts = [[side * r, r, (sz * T) / 2]];
          const a0 = side > 0 ? 0 : Math.PI / 2;
          for (let i = 0; i <= segs / 2; i++) {
            const a = a0 + (Math.PI / 2) * (i / (segs / 2));
            pts.push([Math.cos(a) * r, Math.sin(a) * r, (sz * T) / 2]);
          }
          mb.face(pts, 0, 0, sz);
        }
      }
      for (let i = 0; i < segs; i++) {
        const a0 = Math.PI * (i / segs);
        const a1 = Math.PI * ((i + 1) / segs);
        mb.face(
          [
            [Math.cos(a0) * r, Math.sin(a0) * r, T / 2],
            [Math.cos(a1) * r, Math.sin(a1) * r, T / 2],
            [Math.cos(a1) * r, Math.sin(a1) * r, -T / 2],
            [Math.cos(a0) * r, Math.sin(a0) * r, -T / 2],
          ],
          -(Math.cos(a0) + Math.cos(a1)) / 2,
          -(Math.sin(a0) + Math.sin(a1)) / 2,
          0
        );
      }
      return mb.geometry();
    });
    const y0 = o.y + o.h;
    const M = new THREE.Matrix4().makeTranslation(o.x, y0, 0).premultiply(m);
    e.add(mat, g, M, { tint });
    // Block the two arch shoulders so bodies and bullets stop at the curve
    // rather than clipping through it.
    const cw = r * 0.45;
    for (const sx of [-1, 1]) {
      const C = new THREE.Matrix4().makeTranslation(o.x + sx * (r - cw / 2), y0 + r - cw / 2, 0).premultiply(m);
      e.collide(cw, cw, T, C);
    }
  }

  /* ------------------------------------------------------------- structures */

  /** Horizontal slab with chamfered edges: floors, terraces, lintels, signs. */
  slab(e, mat, cx, cy, cz, w, d, t, opts = {}) {
    const M = new THREE.Matrix4();
    if (opts.rotY) M.makeRotationY(opts.rotY);
    M.setPosition(cx, cy, cz);
    e.add(mat, opts.flat ? this.box(w, t, d, opts.cell ?? 2.2) : this.chamfer(w, t, d, opts.c ?? 0.04), M, opts);
    if (opts.collide !== false) e.collide(w, t, d, M);
    return M;
  }

  /** Stair flight with proud treads and a solid cheek either side. */
  stairs(e, m, spec) {
    const { steps = 6, width = 2.6, rise = 0.17, run = 0.31, mat = 'concrete_cast', tint } = spec;
    const M = new THREE.Matrix4();
    for (let i = 0; i < steps; i++) {
      const z = -run * (i + 0.5);
      M.makeTranslation(0, rise * (i + 0.5), z).premultiply(m);
      e.add(mat, this.chamfer(width, rise, run, 0.018), M, { tint });
      const C = new THREE.Matrix4().makeTranslation(0, (rise * (i + 1)) / 2, z).premultiply(m);
      e.collide(width, rise * (i + 1), run, C);
    }
    if (spec.cheeks !== false) {
      const len = run * steps;
      const hh = rise * steps;
      for (const sx of [1, -1]) {
        M.makeTranslation(sx * (width / 2 + 0.11), hh / 2 - 0.05, -len / 2).premultiply(m);
        e.add(mat, this.chamfer(0.22, hh + 0.1, len, 0.03), M, { tint });
      }
    }
  }

  /** Pipe railing: posts plus two rails, all round stock, along local X. */
  railing(e, m, spec) {
    const { length: L, height: h = 1.02, spacing = 1.5, mat = 'steel_rusted', r = 0.028, tint } = spec;
    const n = Math.max(2, Math.round(L / spacing));
    const M = new THREE.Matrix4();
    const post = this.cylinder(r * 1.2, r * 1.4, h, 6);
    for (let i = 0; i <= n; i++) {
      M.makeTranslation(-L / 2 + (L * i) / n, h / 2, 0).premultiply(m);
      e.add(mat, post, M, { tint, keepUV: true, uvScale: [1, h / 2] });
    }
    const rail = this.cylinder(r, r, L, 6);
    const rot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    for (const y of [h - r, h * 0.5]) {
      M.copy(rot).setPosition(0, y, 0).premultiply(m);
      e.add(mat, rail, M, { tint, keepUV: true, uvScale: [1, L / 2] });
    }
  }

  /** Kerb run with the top outer edge knocked off, as poured kerbs are. */
  kerb(e, m, length, opts = {}) {
    const h = opts.height ?? 0.16;
    const w = opts.width ?? 0.34;
    const M = new THREE.Matrix4().makeTranslation(0, h / 2, 0).premultiply(m);
    e.add(opts.mat ?? 'concrete_cast', this.chamfer(length, h, w, 0.035), M, opts);
    if (opts.collide) e.collide(length, h, w, M);
  }

  /** Balcony: slab, underside brackets, railing. Reads as a floor-level marker
   *  from a hundred metres, which is how a facade gets scale. */
  balcony(e, m, spec) {
    const { width: w = 2.6, depth: d = 1.15, mat = 'concrete_cast', tint } = spec;
    const M = new THREE.Matrix4().makeTranslation(0, 0, d / 2).premultiply(m);
    e.add(mat, this.chamfer(w, 0.16, d, 0.03), M, { tint });
    e.collide(w, 0.16, d, M);
    for (const sx of [-1, 0, 1]) {
      const B = new THREE.Matrix4().makeTranslation(sx * (w / 2 - 0.18), -0.2, d * 0.42).premultiply(m);
      e.add(mat, this.chamfer(0.12, 0.3, d * 0.58, 0.02), B, { tint });
    }
    const R = new THREE.Matrix4().makeTranslation(0, 0.08, d - 0.07).premultiply(m);
    this.railing(e, R, {
      length: w - 0.1,
      height: 0.95,
      spacing: 0.4,
      mat: spec.railMat ?? 'iron_painted_chipped',
      tint: spec.railTint,
    });
  }

  /** Sagging catenary between two points. Wires are free depth cues: they cross
   *  the frame, read at any distance, and say "inhabited". */
  cable(e, mat, a, b, sagAmount, radius = 0.018, tint) {
    const pts = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(
        new THREE.Vector3(
          a.x + (b.x - a.x) * t,
          a.y + (b.y - a.y) * t - sagAmount * Math.sin(Math.PI * t),
          a.z + (b.z - a.z) * t
        )
      );
    }
    const len = a.distanceTo(b);
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.min(16, Math.max(6, Math.round(len * 0.5))), radius, 4, false);
    e.add(mat, g, new THREE.Matrix4(), { tint, keepUV: true, uvScale: [1, len / 2] });
  }

  /** Conduit / pipe run through a list of points. */
  pipeRun(e, mat, pts, radius, tint) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone()));
    const len = curve.getLength();
    const g = new THREE.TubeGeometry(curve, Math.max(4, Math.round(len * 1.1)), radius, 6, false);
    e.add(mat, g, new THREE.Matrix4(), { tint, keepUV: true, uvScale: [1, len / 2] });
    return len;
  }

  /** Polygonal column with a base and a capital — an arcade needs both to read. */
  column(e, m, spec) {
    const { h = 3.2, r = 0.24, sides = 8, mat = 'concrete_cast', tint } = spec;
    const M = new THREE.Matrix4().makeTranslation(0, h / 2, 0).premultiply(m);
    e.add(mat, this.cylinder(r * 0.94, r, h, sides), M, { tint, keepUV: true, uvScale: [1.5, h / 2] });
    e.collide(r * 1.8, h, r * 1.8, M);
    for (const [y, hh, rr] of [
      [0.13, 0.26, r * 1.5],
      [h - 0.15, 0.3, r * 1.45],
    ]) {
      const B = new THREE.Matrix4().makeTranslation(0, y, 0).premultiply(m);
      e.add(mat, this.chamfer(rr * 2, hh, rr * 2, 0.03), B, { tint });
    }
  }

  /**
   * Rubble: broken masonry, spalled concrete and rebar. Placed as a pile rather
   * than as scattered singletons, because collapse leaves cones.
   */
  rubble(e, m, spec = {}) {
    const { radius = 1.6, count = 18, mats = ['concrete_pitted', 'brick_red', 'gravel'], tint } = spec;
    const rng = spec.rng ?? this.rng;
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eu = new THREE.Euler();
    const sv = new THREE.Vector3();
    const pv = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = rng.float() * Math.PI * 2;
      const rr = Math.sqrt(rng.float()) * radius;
      const s = rng.range(0.13, 0.42) * (1.2 - rr / radius / 1.6);
      pv.set(Math.cos(a) * rr, Math.max(0.05, (1 - rr / radius) * radius * 0.42 * rng.range(0.4, 1)), Math.sin(a) * rr);
      eu.set(rng.float() * 3, rng.float() * 3, rng.float() * 3);
      q.setFromEuler(eu);
      sv.set(rng.range(0.8, 1.5), rng.range(0.5, 1.05), rng.range(0.8, 1.4));
      M.compose(pv, q, sv).premultiply(m);
      e.add(rng.pick(mats), this.chamfer(s * 2, s * 1.4, s * 1.8, s * 0.16), M, { tint });
    }
    if (spec.rebar !== false) {
      for (let i = 0; i < 4; i++) {
        const a = rng.float() * Math.PI * 2;
        const len = rng.range(0.5, 1.3);
        const P = new THREE.Matrix4()
          .makeTranslation(Math.cos(a) * radius * 0.45, radius * 0.32, Math.sin(a) * radius * 0.45)
          .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.9, 0.9)))
          .multiply(new THREE.Matrix4().makeRotationX(rng.range(-0.5, 0.5)))
          .premultiply(m);
        e.add('steel_rusted', this.cylinder(0.011, 0.012, len, 5), P, { keepUV: true, uvScale: [1, len] });
      }
    }
    if (spec.collide !== false) {
      const C = new THREE.Matrix4().makeTranslation(0, radius * 0.18, 0).premultiply(m);
      e.collide(radius * 1.5, radius * 0.42, radius * 1.5, C);
    }
  }

  /** Inward-facing shell, so a window into a non-enterable building shows a dark
   *  room rather than the backface of the far wall — or straight through it. */
  interiorShell(e, m, w, h, d, mat = 'concrete_cast', tint = INTERIOR_DARK) {
    const M = new THREE.Matrix4().makeTranslation(0, h / 2, 0).premultiply(m);
    e.add(mat, this.box(w, h, d, 0, true), M, { tint, grime: 0 });
  }

  /* --------------------------------------------------------------- facades */

  /**
   * A jittered window grid for one facade: regular enough to read as floors,
   * irregular enough that the eye never finds the pattern. Some bays are
   * blanked, sill heights wander, roughly a third of the panes are gone and half
   * of the survivors carry a shutter.
   */
  windowGrid(spec) {
    const {
      length: L,
      floors = 2,
      floorH = 3.3,
      sill = 0.95,
      w = 1.05,
      h = 1.55,
      bay = 2.7,
      skip = 0.16,
      inset = 1.2,
      doors = [],
      arch = false,
      glass = 0.55,
      shutters = 0.35,
      firstFloor = 0,
    } = spec;
    const rng = spec.rng ?? this.rng;
    const out = [];
    const usable = L - inset * 2;
    const n = Math.max(1, Math.floor(usable / bay));
    const step = usable / n;
    for (let f = firstFloor; f < floors; f++) {
      for (let i = 0; i < n; i++) {
        if (rng.float() < skip) continue;
        const o = {
          x: -usable / 2 + step * (i + 0.5) + rng.range(-0.09, 0.09),
          y: f * floorH + sill + rng.range(-0.05, 0.05),
          w: w * rng.range(0.92, 1.12),
          h: h * rng.range(0.94, 1.08),
          arch: arch && f === 0,
        };
        if (rng.float() < glass) o.glass = true;
        if (rng.float() < shutters) o.shutter = { side: rng.float() < 0.5 ? 1 : -1, angle: rng.range(0.15, 1.3) };
        out.push(o);
      }
    }
    for (const d of doors) out.push({ x: d.x, y: 0, w: d.w ?? 1.15, h: d.h ?? 2.25, arch: d.arch ?? false, door: true });
    return out;
  }

  /**
   * A whole building: four facades with cut openings, plinth and cornice bands,
   * corner pilasters, floor slabs, a parapeted roof, colliders, and an interior
   * shell unless the caller is building a real interior.
   *
   * `sides` is indexed [south (+Z), north (-Z), east (+X), west (-X)].
   */
  building(e, spec) {
    const {
      cx,
      cz,
      w,
      d,
      h,
      rotY = 0,
      thickness: T = 0.44,
      mat = 'plaster_painted',
      tint,
      sides = [],
      floorH = 3.3,
      trimMat = 'concrete_cast',
      plinth = 0.42,
      cornice = true,
      stringCourse = false,
      pilasters = true,
      topSlab = true,
      roof = {},
      hollow = false,
      cell = 1.4,
      y = 0,
    } = spec;

    const base = new THREE.Matrix4().makeRotationY(rotY).setPosition(cx, y, cz);
    const M = new THREE.Matrix4();
    const R90 = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const R180 = new THREE.Matrix4().makeRotationY(Math.PI);
    const R270 = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

    // Each face frame is oriented so its local +Z is the OUTWARD normal and its
    // local +X runs along the wall. Getting the west face's sign wrong would put
    // every reveal, shutter and arcade on that side inside the building.
    const faces = [
      { m: new THREE.Matrix4().makeTranslation(0, 0, d / 2 - T / 2), L: w },
      { m: new THREE.Matrix4().makeTranslation(0, 0, -d / 2 + T / 2).multiply(R180), L: w },
      { m: new THREE.Matrix4().makeTranslation(w / 2 - T / 2, 0, 0).multiply(R90), L: d },
      { m: new THREE.Matrix4().makeTranslation(-w / 2 + T / 2, 0, 0).multiply(R270), L: d },
    ];
    for (let i = 0; i < 4; i++) {
      const s = sides[i];
      M.copy(faces[i].m).premultiply(base);
      this.wall(e, M, {
        length: faces[i].L,
        height: s?.height ?? h,
        thickness: T,
        mat: s?.mat ?? mat,
        openings: s?.openings ?? [],
        tint: s?.tint ?? tint,
        trimMat,
        cell,
        collide: !hollow,
        trimBothSides: spec.trimBothSides === true,
        // Only where there is no room to look into. A building with a real
        // interior has to keep its doorways walkable and its windows glazed onto
        // something the player can actually stand in.
        recess: hollow,
      });
      if (s?.balconies) {
        for (const b of s.balconies) {
          const B = new THREE.Matrix4().makeTranslation(b.x, b.y, T / 2).premultiply(M);
          this.balcony(e, B, b);
        }
      }
      if (s?.arcade) {
        const A = new THREE.Matrix4().makeTranslation(0, 0, T / 2 + s.arcade.depth).premultiply(M);
        this.arcade(e, A, s.arcade);
      }
    }

    if (hollow) {
      const C = new THREE.Matrix4().makeTranslation(0, h / 2, 0).premultiply(base);
      e.collide(w, h, d, C);
      this.interiorShell(e, base, w - T * 2 - 0.05, Math.max(2.4, h - 0.4), d - T * 2 - 0.05, 'concrete_cast', spec.shellTint);
    } else {
      const floors = Math.max(1, Math.round(h / floorH));
      // topSlab false leaves the room open to the roof deck, so a collapsed roof
      // is a hole to the sky rather than a hole above a ceiling.
      for (let f = 0; f <= (topSlab ? floors : floors - 1); f++) {
        const y = Math.min(f * floorH, h - 0.2);
        const S = new THREE.Matrix4().makeTranslation(0, y + 0.08, 0).premultiply(base);
        e.add(spec.floorMat ?? 'concrete_cast', this.box(w - T * 2, 0.16, d - T * 2, 2.4), S, { tint: spec.floorTint });
        e.collide(w - T * 2, 0.16, d - T * 2, S);
      }
    }

    if (pilasters) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          M.makeTranslation(sx * (w / 2 - 0.22), h / 2, sz * (d / 2 - 0.22)).premultiply(base);
          e.add(trimMat, this.chamfer(0.54, h, 0.54, 0.05), M, { tint: spec.trimTint });
        }
      }
    }
    if (plinth > 0) this.bandAround(e, trimMat, base, plinth / 2, w, d, plinth, 0.08, spec.trimTint);
    if (stringCourse) {
      for (let f = 1; f * floorH < h - 0.7; f++) {
        this.bandAround(e, trimMat, base, f * floorH - 0.06, w, d, 0.16, 0.055, spec.trimTint);
      }
    }
    if (cornice) this.bandAround(e, trimMat, base, h - 0.2, w, d, 0.36, 0.14, spec.trimTint);

    this.roof(e, base, {
      w,
      d,
      y: h,
      parapet: roof.parapet ?? 0.72,
      mat: roof.mat ?? 'concrete_pitted',
      copingMat: roof.copingMat ?? trimMat,
      tint: roof.tint,
      collide: !hollow,
      collapsed: roof.collapsed,
    });
    return base;
  }

  /** A proud band wrapping a rectangular footprint: plinth, string course,
   *  cornice, coping. The cheapest "this was designed by someone" signal there is. */
  bandAround(e, mat, base, cy, w, d, h, proud, tint) {
    const M = new THREE.Matrix4();
    for (const sz of [1, -1]) {
      M.makeTranslation(0, cy, sz * (d + proud) * 0.5).premultiply(base);
      e.add(mat, this.chamfer(w + proud * 2, h, proud, 0.028), M, { tint });
    }
    for (const sx of [1, -1]) {
      M.makeTranslation(sx * (w + proud) * 0.5, cy, 0).premultiply(base);
      e.add(mat, this.chamfer(proud, h, d, 0.028), M, { tint });
    }
  }

  /** Flat roof: deck, parapet, coping, and optionally a collapsed hole with
   *  broken slab edges hanging into it. */
  roof(e, base, spec) {
    const { w, d, y, parapet = 0.7, mat = 'concrete_pitted', copingMat = 'concrete_cast', tint, collide = true } = spec;
    const M = new THREE.Matrix4();
    const hole = spec.collapsed;
    if (hole) {
      const hx0 = hole.x - hole.w / 2;
      const hx1 = hole.x + hole.w / 2;
      const hz0 = hole.z - hole.d / 2;
      const hz1 = hole.z + hole.d / 2;
      for (const [x0, x1, z0, z1] of [
        [-w / 2, hx0, -d / 2, d / 2],
        [hx1, w / 2, -d / 2, d / 2],
        [hx0, hx1, -d / 2, hz0],
        [hx0, hx1, hz1, d / 2],
      ]) {
        const sw = x1 - x0;
        const sd = z1 - z0;
        if (sw < 0.05 || sd < 0.05) continue;
        M.makeTranslation((x0 + x1) / 2, y + 0.1, (z0 + z1) / 2).premultiply(base);
        e.add(mat, this.box(sw, 0.2, sd, 2.2), M, { tint });
        if (collide) e.collide(sw, 0.2, sd, M);
      }
      for (let i = 0; i < 5; i++) {
        const t = (i + 0.5) / 5;
        M.makeTranslation(hx0 + hole.w * t, y - 0.04, hz1 - 0.14)
          .multiply(new THREE.Matrix4().makeRotationX(-0.45 + t * 0.55))
          .premultiply(base);
        e.add('concrete_pitted', this.chamfer(hole.w / 5.6, 0.13, 0.72, 0.03), M, { tint });
      }
    } else {
      M.makeTranslation(0, y + 0.1, 0).premultiply(base);
      e.add(mat, this.box(w, 0.2, d, 2.4), M, { tint });
      if (collide) e.collide(w, 0.2, d, M);
    }

    if (parapet > 0) {
      const t = 0.2;
      for (const sz of [1, -1]) {
        M.makeTranslation(0, y + 0.2 + parapet / 2, sz * (d / 2 - t / 2)).premultiply(base);
        e.add(mat, this.box(w, parapet, t, 1.6), M, { tint });
        if (collide) e.collide(w, parapet, t, M);
      }
      for (const sx of [1, -1]) {
        M.makeTranslation(sx * (w / 2 - t / 2), y + 0.2 + parapet / 2, 0).premultiply(base);
        e.add(mat, this.box(t, parapet, d - t * 2, 1.6), M, { tint });
        if (collide) e.collide(t, parapet, d - t * 2, M);
      }
      this.bandAround(e, copingMat, base, y + 0.24 + parapet, w - t, d - t, 0.11, 0.09, tint);
    }
  }

  /**
   * Colonnade in front of a shopfront: an arcaded screen wall, a capital band at
   * the spring line, and a ceiling slab behind. Gives a facade a two-metre-deep
   * shadow band, which is the strongest contrast device available on a sunlit
   * street — and a walkable firing position behind it.
   */
  arcade(e, m, spec) {
    const { length: L, depth: D = 2.4, h = 3.5, bays = 4, mat = 'concrete_cast', tint } = spec;
    const step = L / bays;
    const openings = [];
    const clear = step - 0.72;
    for (let i = 0; i < bays; i++) {
      openings.push({ x: -L / 2 + step * (i + 0.5), y: 0, w: clear, h: h - 0.6 - clear / 2, arch: true, trim: false });
    }
    const M = new THREE.Matrix4().premultiply(m);
    this.wall(e, M, { length: L, height: h + 0.55, thickness: 0.46, mat, openings, tint, cell: 1.2 });
    this.bandAround(e, mat, M, h - 0.6 + 0.09, L, 0.46, 0.16, 0.06, tint);
    const C = new THREE.Matrix4().makeTranslation(0, h + 0.55 - 0.14, -D / 2).premultiply(m);
    e.add(spec.ceilMat ?? 'concrete_pitted', this.box(L, 0.24, D, 2), C, { tint, grime: 0 });
    e.collide(L, 0.24, D, C);
    const F = new THREE.Matrix4().makeTranslation(0, 0.06, -D / 2).premultiply(m);
    e.add(spec.floorMat ?? 'concrete_cast', this.box(L - 0.4, 0.12, D, 1.6), F, { grime: 0.5 });
    e.collide(L - 0.4, 0.12, D, F);
  }
}
