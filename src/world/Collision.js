import * as THREE from 'three';

/**
 * World collision: a static BVH over the level's collision geometry, with
 * capsule sweeps and world rays cheap enough to run every one of the 120 fixed
 * steps a second.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * Triangles live in flat Float32Arrays — nine floats of vertex data plus a plane
 * normal per triangle — and the BVH is six floats and two ints per node in more
 * flat arrays. No objects, no Vector3 per triangle, so a sweep touches a few
 * hundred contiguous floats instead of chasing a few hundred pointers. Nothing
 * in the query path allocates: every scratch vector is a field, the candidate
 * list is a preallocated Int32Array, and results come from a small ring of
 * reusable objects.
 *
 * Movement is resolve-after-advance, substepped: the motion is split so no
 * substep is longer than 0.7 of the capsule radius (which is what makes
 * tunnelling at sprint speed impossible, not a smaller fixed step), and after
 * each substep the capsule is pushed out of every triangle it overlaps along the
 * real separation axis. Pushing along the separation axis rather than the
 * triangle normal is what makes an edge or a corner behave: a normal-only push
 * launches you off the end of a wall.
 *
 * CONTRACT:
 *   raycast(origin, dir, maxDist, opts?) -> {point, normal, distance, object} | null
 *   sweepCapsule(from, to, radius, height) -> {position, grounded, normal, hit}
 *   groundHeight(x, z, fromY) -> number | null
 *   rebuild()
 *
 * ADDITIONS (safe to rely on):
 *   slopeLimitDeg / stepHeight / skin     tunables, applied on the next query
 *   overlapAABB(min, max, cb)             visit triangles in a box
 *   closestPoint(p, maxDist, out)         nearest surface point, or null
 *   segmentClear(a, b, radius?)           line-of-sight test for AI
 *   stats  { triangles, nodes, buildMs, rayQueries, sweepQueries, maxDepth }
 *
 * `from`/`to` in sweepCapsule are the capsule's CENTRE, and `height` is its full
 * height, matching what Player passes. The returned object is reused: read it or
 * copy out of it before the next eight calls.
 */

const LEAF_SIZE = 6;
const MAX_CANDIDATES = 2048;
const EPS = 1e-6;

export class Collision {
  constructor(game) {
    this.game = game;

    this.slopeLimitDeg = 48;
    this.stepHeight = 0.42;
    this.stepDown = 0.34;
    this.skin = 0.006;
    this.pushIterations = 4;

    this.count = 0;
    this.tri = null; // 9 floats per triangle
    this.nrm = null; // 3 floats per triangle (unit plane normal)
    this.triObj = null; // source object index per triangle
    this.objects = [];

    this.nodeMin = null;
    this.nodeMax = null;
    this.nodeA = null; // left child, or first triangle for a leaf
    this.nodeN = null; // 0 = internal, else triangle count
    this.triIdx = null;
    this.nodes = 0;

    this.stats = { triangles: 0, nodes: 0, buildMs: 0, rayQueries: 0, sweepQueries: 0, maxDepth: 0 };

    // Query scratch. Nothing below this line is allowed to allocate.
    this._cand = new Int32Array(MAX_CANDIDATES);
    this._stack = new Int32Array(256);
    this._cent = null;
    this._hit = { t: 0, tri: -1, nx: 0, ny: 0, nz: 0 };
    this._cp = new Float64Array(6); // closest pair: segment point, triangle point
    this._v = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._alt = new THREE.Vector3();
    this._nrmOut = new THREE.Vector3();
    this._ring = [];
    this._ringAt = 0;
    for (let i = 0; i < 8; i++) {
      this._ring.push({ position: new THREE.Vector3(), grounded: false, normal: new THREE.Vector3(0, 1, 0), hit: false, object: null });
    }
  }

  async init() {
    this.rebuild();
    // The level is static, but decals/props may register more later.
    this.game.bus?.on?.('level:rebuilt', () => this.rebuild());
  }

  get cosSlope() {
    return Math.cos((this.slopeLimitDeg * Math.PI) / 180);
  }

  /* ----------------------------------------------------------------- build */

  /**
   * Pull every triangle out of `level.collidables` into world space and build the
   * tree. Called once at boot; safe to call again if the level changes.
   */
  rebuild() {
    const t0 = performance.now();
    const roots = this.game.level?.collidables ?? [];
    const meshes = [];
    for (const root of roots) {
      root.updateWorldMatrix?.(true, true);
      root.traverse?.((o) => {
        if ((o.isMesh || o.isInstancedMesh) && o.geometry?.attributes?.position) meshes.push(o);
      });
      if (!root.traverse && root.isMesh) meshes.push(root);
    }

    let total = 0;
    for (const m of meshes) {
      const g = m.geometry;
      total += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
    total |= 0;

    this.objects = meshes;
    this.count = total;
    if (!total) {
      this.stats = { ...this.stats, triangles: 0, nodes: 0, buildMs: +(performance.now() - t0).toFixed(2) };
      return;
    }

    this.tri = new Float32Array(total * 9);
    this.nrm = new Float32Array(total * 3);
    this.triObj = new Int32Array(total);
    this._cent = new Float32Array(total * 3);

    const v = this._v;
    let w = 0;
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const g = mesh.geometry;
      const pos = g.attributes.position;
      const idx = g.index;
      const n = idx ? idx.count : pos.count;
      const mat = mesh.matrixWorld;
      const identity = isIdentity(mat.elements);
      for (let i = 0; i < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(i + k) : i + k;
          v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
          if (!identity) v.applyMatrix4(mat);
          this.tri[w * 9 + k * 3] = v.x;
          this.tri[w * 9 + k * 3 + 1] = v.y;
          this.tri[w * 9 + k * 3 + 2] = v.z;
        }
        const o = w * 9;
        const e1x = this.tri[o + 3] - this.tri[o];
        const e1y = this.tri[o + 4] - this.tri[o + 1];
        const e1z = this.tri[o + 5] - this.tri[o + 2];
        const e2x = this.tri[o + 6] - this.tri[o];
        const e2y = this.tri[o + 7] - this.tri[o + 1];
        const e2z = this.tri[o + 8] - this.tri[o + 2];
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz);
        if (l > EPS) {
          nx /= l;
          ny /= l;
          nz /= l;
        } else {
          ny = 1;
        }
        this.nrm[w * 3] = nx;
        this.nrm[w * 3 + 1] = ny;
        this.nrm[w * 3 + 2] = nz;
        this._cent[w * 3] = (this.tri[o] + this.tri[o + 3] + this.tri[o + 6]) / 3;
        this._cent[w * 3 + 1] = (this.tri[o + 1] + this.tri[o + 4] + this.tri[o + 7]) / 3;
        this._cent[w * 3 + 2] = (this.tri[o + 2] + this.tri[o + 5] + this.tri[o + 8]) / 3;
        this.triObj[w] = mi;
        w++;
      }
    }
    this.count = w;

    this._buildBVH();
    this.stats.triangles = this.count;
    this.stats.nodes = this.nodes;
    this.stats.buildMs = +(performance.now() - t0).toFixed(2);
    this.game.bus?.emit?.('collision:ready', this.stats);
  }

  /**
   * Median-of-centroids split on the longest axis of the centroid bounds, which
   * is within a few percent of a full SAH build on axis-aligned level geometry
   * and builds an order of magnitude faster.
   */
  _buildBVH() {
    const n = this.count;
    const maxNodes = 2 * n + 1;
    this.nodeMin = new Float32Array(maxNodes * 3);
    this.nodeMax = new Float32Array(maxNodes * 3);
    this.nodeA = new Int32Array(maxNodes);
    this.nodeN = new Int32Array(maxNodes);
    this.triIdx = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.triIdx[i] = i;

    this.nodes = 1;
    let depth = 0;
    // (node, start, end, depth) quadruples.
    const stack = new Int32Array(256 * 4);
    let sp = 0;
    stack[sp++] = 0;
    stack[sp++] = 0;
    stack[sp++] = n;
    stack[sp++] = 0;

    while (sp > 0) {
      const d = stack[--sp];
      const end = stack[--sp];
      const start = stack[--sp];
      const node = stack[--sp];
      if (d > depth) depth = d;

      this._fitNode(node, start, end);
      const cnt = end - start;
      if (cnt <= LEAF_SIZE || d > 40) {
        this.nodeA[node] = start;
        this.nodeN[node] = cnt;
        continue;
      }

      // Centroid bounds pick the axis; the box bounds would be biased by big
      // triangles straddling the split.
      let cminx = Infinity;
      let cminy = Infinity;
      let cminz = Infinity;
      let cmaxx = -Infinity;
      let cmaxy = -Infinity;
      let cmaxz = -Infinity;
      for (let i = start; i < end; i++) {
        const t = this.triIdx[i] * 3;
        const cx = this._cent[t];
        const cy = this._cent[t + 1];
        const cz = this._cent[t + 2];
        if (cx < cminx) cminx = cx;
        if (cy < cminy) cminy = cy;
        if (cz < cminz) cminz = cz;
        if (cx > cmaxx) cmaxx = cx;
        if (cy > cmaxy) cmaxy = cy;
        if (cz > cmaxz) cmaxz = cz;
      }
      const ex = cmaxx - cminx;
      const ey = cmaxy - cminy;
      const ez = cmaxz - cminz;
      let axis = 0;
      let lo = cminx;
      let hi = cmaxx;
      if (ey > ex && ey >= ez) {
        axis = 1;
        lo = cminy;
        hi = cmaxy;
      } else if (ez > ex && ez > ey) {
        axis = 2;
        lo = cminz;
        hi = cmaxz;
      }
      let mid = start;
      if (hi - lo > 1e-7) {
        const split = (lo + hi) * 0.5;
        let i = start;
        let j = end - 1;
        while (i <= j) {
          if (this._cent[this.triIdx[i] * 3 + axis] < split) i++;
          else {
            const tmp = this.triIdx[i];
            this.triIdx[i] = this.triIdx[j];
            this.triIdx[j] = tmp;
            j--;
          }
        }
        mid = i;
      }
      // Degenerate split (all centroids coincident): halve by index instead of
      // recursing forever on the same set.
      if (mid === start || mid === end) mid = (start + end) >> 1;

      const left = this.nodes;
      this.nodes += 2;
      this.nodeA[node] = left;
      this.nodeN[node] = 0;
      stack[sp++] = left;
      stack[sp++] = start;
      stack[sp++] = mid;
      stack[sp++] = d + 1;
      stack[sp++] = left + 1;
      stack[sp++] = mid;
      stack[sp++] = end;
      stack[sp++] = d + 1;
    }
    this.stats.maxDepth = depth;
  }

  _fitNode(node, start, end) {
    let minx = Infinity;
    let miny = Infinity;
    let minz = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    let maxz = -Infinity;
    for (let i = start; i < end; i++) {
      const o = this.triIdx[i] * 9;
      for (let k = 0; k < 3; k++) {
        const x = this.tri[o + k * 3];
        const y = this.tri[o + k * 3 + 1];
        const z = this.tri[o + k * 3 + 2];
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (z < minz) minz = z;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        if (z > maxz) maxz = z;
      }
    }
    const b = node * 3;
    this.nodeMin[b] = minx;
    this.nodeMin[b + 1] = miny;
    this.nodeMin[b + 2] = minz;
    this.nodeMax[b] = maxx;
    this.nodeMax[b + 1] = maxy;
    this.nodeMax[b + 2] = maxz;
  }

  /* ------------------------------------------------------------------ rays */

  /**
   * Nearest hit along a ray. Returns a fresh result object (rays are fired by
   * bullets and by AI line-of-sight, which keep the point for a decal) or null.
   * `opts.frontOnly` ignores back faces; `opts.skip` is an object to ignore.
   */
  raycast(origin, dir, maxDist = 500, opts) {
    this.stats.rayQueries++;
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    if (!this._rayCast(origin.x, origin.y, origin.z, dir.x / dl, dir.y / dl, dir.z / dl, maxDist, opts?.frontOnly === true))
      return null;
    const h = this._hit;
    return {
      point: new THREE.Vector3(origin.x + (dir.x / dl) * h.t, origin.y + (dir.y / dl) * h.t, origin.z + (dir.z / dl) * h.t),
      normal: new THREE.Vector3(h.nx, h.ny, h.nz),
      distance: h.t,
      object: this.objects[this.triObj[h.tri]] ?? null,
      triangle: h.tri,
    };
  }

  /** Height of the surface under (x, z), or null if nothing is below fromY. */
  groundHeight(x, z, fromY = 200) {
    if (!this.count) return null;
    if (!this._rayCast(x, fromY, z, 0, -1, 0, 1000, false)) return null;
    return fromY - this._hit.t;
  }

  /** Unobstructed line between two points, optionally as a thick ray. */
  segmentClear(a, b, radius = 0) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < EPS) return true;
    if (radius <= 0) return !this._rayCast(a.x, a.y, a.z, dx / len, dy / len, dz / len, len, false);
    // Cheap thick test: the axis plus four offsets on the plane normal to it.
    let ux = -dz;
    let uy = 0;
    let uz = dx;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < EPS) {
      ux = 1;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const vx = uy * dz - uz * dy;
    const vy = uz * dx - ux * dz;
    const vz = ux * dy - uy * dx;
    const vl = Math.hypot(vx, vy, vz) || 1;
    for (const [ox, oy, oz] of [
      [0, 0, 0],
      [ux * radius, 0, uz * radius],
      [-ux * radius, 0, -uz * radius],
      [(vx / vl) * radius, (vy / vl) * radius, (vz / vl) * radius],
      [(-vx / vl) * radius, (-vy / vl) * radius, (-vz / vl) * radius],
    ]) {
      if (this._rayCast(a.x + ox, a.y + oy, a.z + oz, dx / len, dy / len, dz / len, len, false)) return false;
    }
    return true;
  }

  _rayCast(ox, oy, oz, dx, dy, dz, maxDist, frontOnly) {
    if (!this.count) return false;
    const idx = 1 / (dx || 1e-20);
    const idy = 1 / (dy || 1e-20);
    const idz = 1 / (dz || 1e-20);
    let best = maxDist;
    let bestTri = -1;
    const stack = this._stack;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp];
      const b = node * 3;
      // Slab test. NaN from a 0*Infinity term cannot happen here because the
      // reciprocals are clamped away from infinity above.
      let t0 = (this.nodeMin[b] - ox) * idx;
      let t1 = (this.nodeMax[b] - ox) * idx;
      let tmin = t0 < t1 ? t0 : t1;
      let tmax = t0 < t1 ? t1 : t0;
      t0 = (this.nodeMin[b + 1] - oy) * idy;
      t1 = (this.nodeMax[b + 1] - oy) * idy;
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1);
      tmax = Math.min(tmax, t0 < t1 ? t1 : t0);
      t0 = (this.nodeMin[b + 2] - oz) * idz;
      t1 = (this.nodeMax[b + 2] - oz) * idz;
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1);
      tmax = Math.min(tmax, t0 < t1 ? t1 : t0);
      if (tmax < 0 || tmin > tmax || tmin > best) continue;

      const cnt = this.nodeN[node];
      if (cnt === 0) {
        const l = this.nodeA[node];
        stack[sp++] = l;
        stack[sp++] = l + 1;
        continue;
      }
      const start = this.nodeA[node];
      for (let i = start; i < start + cnt; i++) {
        const ti = this.triIdx[i];
        const t = this._rayTri(ti, ox, oy, oz, dx, dy, dz, best, frontOnly);
        if (t >= 0) {
          best = t;
          bestTri = ti;
        }
      }
    }

    if (bestTri < 0) return false;
    this._hit.t = best;
    this._hit.tri = bestTri;
    // Report the normal facing the ray, so a hit from inside a wall still gives
    // a usable decal orientation.
    const s = this.nrm[bestTri * 3] * dx + this.nrm[bestTri * 3 + 1] * dy + this.nrm[bestTri * 3 + 2] * dz > 0 ? -1 : 1;
    this._hit.nx = this.nrm[bestTri * 3] * s;
    this._hit.ny = this.nrm[bestTri * 3 + 1] * s;
    this._hit.nz = this.nrm[bestTri * 3 + 2] * s;
    return true;
  }

  /** Möller-Trumbore. Returns the hit distance or -1. */
  _rayTri(ti, ox, oy, oz, dx, dy, dz, maxT, frontOnly) {
    const o = ti * 9;
    const ax = this.tri[o];
    const ay = this.tri[o + 1];
    const az = this.tri[o + 2];
    const e1x = this.tri[o + 3] - ax;
    const e1y = this.tri[o + 4] - ay;
    const e1z = this.tri[o + 5] - az;
    const e2x = this.tri[o + 6] - ax;
    const e2y = this.tri[o + 7] - ay;
    const e2z = this.tri[o + 8] - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (frontOnly ? det < EPS : det > -EPS && det < EPS) return -1;
    const inv = 1 / det;
    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-7 || u > 1 + 1e-7) return -1;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-5 && t < maxT ? t : -1;
  }

  /* -------------------------------------------------------------- overlaps */

  /** Triangle indices whose AABB overlaps the box, into the scratch list. */
  _gather(minx, miny, minz, maxx, maxy, maxz) {
    let n = 0;
    if (!this.count) return 0;
    const stack = this._stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const b = node * 3;
      if (
        this.nodeMin[b] > maxx ||
        this.nodeMax[b] < minx ||
        this.nodeMin[b + 1] > maxy ||
        this.nodeMax[b + 1] < miny ||
        this.nodeMin[b + 2] > maxz ||
        this.nodeMax[b + 2] < minz
      )
        continue;
      const cnt = this.nodeN[node];
      if (cnt === 0) {
        const l = this.nodeA[node];
        stack[sp++] = l;
        stack[sp++] = l + 1;
        continue;
      }
      const start = this.nodeA[node];
      for (let i = start; i < start + cnt && n < MAX_CANDIDATES; i++) this._cand[n++] = this.triIdx[i];
    }
    return n;
  }

  /** Public sweep of the tree: cb(triangleIndex) for everything in the box. */
  overlapAABB(min, max, cb) {
    const n = this._gather(min.x, min.y, min.z, max.x, max.y, max.z);
    for (let i = 0; i < n; i++) cb(this._cand[i]);
    return n;
  }

  /** Nearest surface point to p within maxDist. Writes `out`, returns it or null. */
  closestPoint(p, maxDist = 2, out = new THREE.Vector3()) {
    const n = this._gather(p.x - maxDist, p.y - maxDist, p.z - maxDist, p.x + maxDist, p.y + maxDist, p.z + maxDist);
    let best = maxDist * maxDist;
    let found = false;
    for (let i = 0; i < n; i++) {
      const d2 = this._closestTri(this._cand[i], p.x, p.y, p.z);
      if (d2 < best) {
        best = d2;
        out.set(this._cp[3], this._cp[4], this._cp[5]);
        found = true;
      }
    }
    return found ? out : null;
  }

  /* ---------------------------------------------------------------- sweeps */

  /**
   * Move a capsule from `from` to `to`, sliding along whatever it hits.
   *
   * The returned object is one of eight pooled records — copy out of it rather
   * than storing the reference.
   */
  sweepCapsule(from, to, radius = 0.36, height = 1.8, opts) {
    this.stats.sweepQueries++;
    const res = this._ring[this._ringAt++ & 7];
    res.grounded = false;
    res.hit = false;
    res.normal.set(0, 1, 0);
    res.object = null;

    const r = Math.max(0.02, radius);
    const halfSeg = Math.max(0.001, height / 2 - r);
    const pos = this._pos.copy(from);

    if (!this.count) {
      res.position.copy(to);
      return res;
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    // No substep longer than 0.7 r: this, not the size of the fixed timestep, is
    // what makes tunnelling impossible at sprint speed or after a frame hitch.
    // A request longer than the substep budget can cover is clamped short rather
    // than stretched, because a teleport through a wall is worse than falling
    // behind by a frame.
    const steps = Math.max(1, Math.min(96, Math.ceil(len / (r * 0.7))));
    const reach = Math.min(len, steps * r * 0.7);
    const k = len > 1e-9 ? reach / len / steps : 0;
    const sx = dx * k;
    const sy = dy * k;
    const sz = dz * k;

    let bestNy = -2;
    let anyHit = false;
    for (let s = 0; s < steps; s++) {
      pos.x += sx;
      pos.y += sy;
      pos.z += sz;
      const ny = this._depenetrate(pos, r, halfSeg);
      if (ny > -1.5) {
        anyHit = true;
        if (ny > bestNy) {
          bestNy = ny;
          res.normal.copy(this._nrmOut);
        }
      }
    }
    res.hit = anyHit;

    // Step-up: if the slide lost most of the requested horizontal motion, try the
    // same move lifted by a kerb height. Cheap because it is only attempted on
    // the frames where the player is actually against something.
    const wantH = Math.hypot(dx, dz);
    if (wantH > 1e-4) {
      const gotH = Math.hypot(pos.x - from.x, pos.z - from.z);
      if (gotH < wantH * 0.72 && opts?.stepUp !== false) {
        const lift = this.stepHeight;
        const alt = this._alt.set(from.x, from.y + lift, from.z);
        this._depenetrate(alt, r, halfSeg);
        for (let s = 0; s < steps; s++) {
          alt.x += sx;
          alt.y += sy;
          alt.z += sz;
          this._depenetrate(alt, r, halfSeg);
        }
        const altH = Math.hypot(alt.x - from.x, alt.z - from.z);
        // Only accept the lift if it bought real ground: there has to be a
        // walkable surface under the raised capsule within a step height,
        // otherwise this is climbing a wall.
        if (altH > gotH + 0.01) {
          const foot = alt.y - halfSeg - r;
          const gh = this._downProbe(alt.x, alt.y - halfSeg, alt.z, r + lift + 0.1);
          if (gh !== null && gh <= foot + lift + 0.05 && gh >= foot - lift - 0.05) {
            pos.copy(alt);
            pos.y = gh + halfSeg + r;
            res.grounded = true;
            res.normal.set(0, 1, 0);
          }
        }
      }
    }

    if (bestNy >= this.cosSlope) res.grounded = true;

    // Ground snap: hold the capsule on the surface while walking down a slope or
    // a stair, but never while moving up, or a jump would be glued to the floor.
    const rising = dy > 0.002;
    if (!res.grounded && !rising) {
      const foot = pos.y - halfSeg - r;
      const gh = this._downProbe(pos.x, pos.y - halfSeg, pos.z, r + this.stepDown);
      if (gh !== null && gh <= foot + 0.02 && gh >= foot - this.stepDown) {
        pos.y = gh + halfSeg + r;
        res.grounded = true;
        res.normal.set(0, 1, 0);
      }
    }

    res.position.copy(pos);
    return res;
  }

  /** Downward probe from a point; returns the surface height or null. */
  _downProbe(x, y, z, dist) {
    if (!this._rayCast(x, y, z, 0, -1, 0, dist, false)) return null;
    return y - this._hit.t;
  }

  /**
   * Push the capsule out of everything it overlaps. Returns the largest contact
   * normal Y found (so the caller can decide "grounded"), or -2 for no contact.
   *
   * Triangles are resolved one at a time against the live position rather than
   * accumulated against the original: overlapping a wall and a floor at once
   * needs the second push to see the result of the first, or the capsule pops
   * through the corner between them.
   */
  _depenetrate(pos, r, halfSeg) {
    let bestNy = -2;
    for (let iter = 0; iter < this.pushIterations; iter++) {
      const n = this._gather(
        pos.x - r - 0.05,
        pos.y - halfSeg - r - 0.05,
        pos.z - r - 0.05,
        pos.x + r + 0.05,
        pos.y + halfSeg + r + 0.05,
        pos.z + r + 0.05
      );
      let pushed = false;
      for (let i = 0; i < n; i++) {
        const ti = this._cand[i];
        const d2 = this._closestSegTri(ti, pos.x, pos.y - halfSeg, pos.z, pos.x, pos.y + halfSeg, pos.z);
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2);
        let ax = this._cp[0] - this._cp[3];
        let ay = this._cp[1] - this._cp[4];
        let az = this._cp[2] - this._cp[5];
        let al = Math.hypot(ax, ay, az);
        if (al < 1e-5) {
          // Dead centre on the face: no separation direction to recover, so use
          // the plane normal, oriented away from the triangle.
          ax = this.nrm[ti * 3];
          ay = this.nrm[ti * 3 + 1];
          az = this.nrm[ti * 3 + 2];
          al = 1;
          const rel =
            (pos.x - this.tri[ti * 9]) * ax + (pos.y - this.tri[ti * 9 + 1]) * ay + (pos.z - this.tri[ti * 9 + 2]) * az;
          if (rel < 0) {
            ax = -ax;
            ay = -ay;
            az = -az;
          }
        } else {
          ax /= al;
          ay /= al;
          az /= al;
        }
        const push = r - d + this.skin;
        pos.x += ax * push;
        pos.y += ay * push;
        pos.z += az * push;
        pushed = true;
        if (ay > bestNy) {
          bestNy = ay;
          this._nrmOut.set(ax, ay, az);
        }
      }
      if (!pushed) break;
    }
    return bestNy;
  }

  /* --------------------------------------------------- distance primitives */

  /** Squared distance from a point to triangle ti; closest point into _cp[3..5]. */
  _closestTri(ti, px, py, pz) {
    const o = ti * 9;
    const ax = this.tri[o];
    const ay = this.tri[o + 1];
    const az = this.tri[o + 2];
    const bx = this.tri[o + 3];
    const by = this.tri[o + 4];
    const bz = this.tri[o + 5];
    const cx = this.tri[o + 6];
    const cy = this.tri[o + 7];
    const cz = this.tri[o + 8];

    // Ericson, Real-Time Collision Detection 5.1.5: Voronoi region walk.
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return this._cpTri(px, py, pz, ax, ay, az);

    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return this._cpTri(px, py, pz, bx, by, bz);

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      return this._cpTri(px, py, pz, ax + abx * v, ay + aby * v, az + abz * v);
    }

    const cpx = px - cx;
    const cpy = py - cy;
    const cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return this._cpTri(px, py, pz, cx, cy, cz);

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      return this._cpTri(px, py, pz, ax + acx * w, ay + acy * w, az + acz * w);
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      return this._cpTri(px, py, pz, bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return this._cpTri(px, py, pz, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
  }

  _cpTri(px, py, pz, qx, qy, qz) {
    this._cp[0] = px;
    this._cp[1] = py;
    this._cp[2] = pz;
    this._cp[3] = qx;
    this._cp[4] = qy;
    this._cp[5] = qz;
    const dx = px - qx;
    const dy = py - qy;
    const dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Squared distance between a segment and a triangle, with the closest pair in
   * _cp (segment point first, triangle point second).
   *
   * The minimum is attained either at a segment endpoint against the triangle,
   * or between the segment and one of the three edges — unless the segment
   * crosses the triangle, which is checked first and reported as zero distance
   * with the crossing point.
   */
  _closestSegTri(ti, p0x, p0y, p0z, p1x, p1y, p1z) {
    const dx = p1x - p0x;
    const dy = p1y - p0y;
    const dz = p1z - p0z;
    const segLen = Math.hypot(dx, dy, dz);
    if (segLen > EPS) {
      const t = this._rayTri(ti, p0x, p0y, p0z, dx / segLen, dy / segLen, dz / segLen, segLen, false);
      if (t >= 0) {
        const hx = p0x + (dx / segLen) * t;
        const hy = p0y + (dy / segLen) * t;
        const hz = p0z + (dz / segLen) * t;
        // Both points coincide; the caller falls back to the plane normal.
        this._cp[0] = hx;
        this._cp[1] = hy;
        this._cp[2] = hz;
        this._cp[3] = hx;
        this._cp[4] = hy;
        this._cp[5] = hz;
        return 0;
      }
    }

    let best = Infinity;
    let bsx = 0;
    let bsy = 0;
    let bsz = 0;
    let btx = 0;
    let bty = 0;
    let btz = 0;
    const take = (d2) => {
      if (d2 < best) {
        best = d2;
        bsx = this._cp[0];
        bsy = this._cp[1];
        bsz = this._cp[2];
        btx = this._cp[3];
        bty = this._cp[4];
        btz = this._cp[5];
      }
    };
    take(this._closestTri(ti, p0x, p0y, p0z));
    take(this._closestTri(ti, p1x, p1y, p1z));

    const o = ti * 9;
    for (let k = 0; k < 3; k++) {
      const a = o + k * 3;
      const b = o + ((k + 1) % 3) * 3;
      take(
        this._segSeg(
          p0x,
          p0y,
          p0z,
          p1x,
          p1y,
          p1z,
          this.tri[a],
          this.tri[a + 1],
          this.tri[a + 2],
          this.tri[b],
          this.tri[b + 1],
          this.tri[b + 2]
        )
      );
    }
    this._cp[0] = bsx;
    this._cp[1] = bsy;
    this._cp[2] = bsz;
    this._cp[3] = btx;
    this._cp[4] = bty;
    this._cp[5] = btz;
    return best;
  }

  /** Ericson 5.1.9: closest points between two segments, into _cp. */
  _segSeg(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
    const d1x = q1x - p1x;
    const d1y = q1y - p1y;
    const d1z = q1z - p1z;
    const d2x = q2x - p2x;
    const d2y = q2y - p2y;
    const d2z = q2z - p2z;
    const rx = p1x - p2x;
    const ry = p1y - p2y;
    const rz = p1z - p2z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    let s = 0;
    let t = 0;
    if (a <= EPS && e <= EPS) {
      s = t = 0;
    } else if (a <= EPS) {
      t = clamp01(f / e);
    } else {
      const c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= EPS) {
        s = clamp01(-c / a);
      } else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z;
        const denom = a * e - b * b;
        s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = clamp01(-c / a);
        } else if (t > 1) {
          t = 1;
          s = clamp01((b - c) / a);
        }
      }
    }
    const c1x = p1x + d1x * s;
    const c1y = p1y + d1y * s;
    const c1z = p1z + d1z * s;
    const c2x = p2x + d2x * t;
    const c2y = p2y + d2y * t;
    const c2z = p2z + d2z * t;
    this._cp[0] = c1x;
    this._cp[1] = c1y;
    this._cp[2] = c1z;
    this._cp[3] = c2x;
    this._cp[4] = c2y;
    this._cp[5] = c2z;
    const ddx = c1x - c2x;
    const ddy = c1y - c2y;
    const ddz = c1z - c2z;
    return ddx * ddx + ddy * ddy + ddz * ddz;
  }

  dispose() {
    this.tri = this.nrm = this.triIdx = null;
    this.nodeMin = this.nodeMax = this.nodeA = this.nodeN = null;
    this.objects = [];
    this.count = 0;
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isIdentity(e) {
  return (
    e[0] === 1 &&
    e[5] === 1 &&
    e[10] === 1 &&
    e[15] === 1 &&
    e[1] === 0 &&
    e[2] === 0 &&
    e[3] === 0 &&
    e[4] === 0 &&
    e[6] === 0 &&
    e[7] === 0 &&
    e[8] === 0 &&
    e[9] === 0 &&
    e[11] === 0 &&
    e[12] === 0 &&
    e[13] === 0 &&
    e[14] === 0
  );
}
