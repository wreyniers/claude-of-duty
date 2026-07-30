import * as THREE from 'three';
import { InstanceSet, crossCards, leafCard, saggingQuad } from './Kit.js';

/**
 * Clutter. This file is the difference between a map and a set.
 *
 * Two placement rules run through everything here, and they are the ones the
 * review rubric fails hobby scenes on:
 *
 *  - NOTHING REPEATS IDENTICALLY. Every instanced prop gets a jittered scale, a
 *    free rotation about its own axis, and a per-instance albedo tint pulled
 *    from a small palette. A row of six identical drums is instantly readable as
 *    a copy-paste; six drums at 0.94-1.08 scale in four faded colours is a yard.
 *  - THINGS LEAN ON OTHER THINGS. Debris collects against kerbs and wall bases,
 *    crates stack against walls, sandbags are laid in courses with the top
 *    course short. Clutter floating in the middle of a floor looks placed;
 *    clutter piled in a corner looks left.
 *
 * Everything repeated is an InstancedMesh (one draw call each); everything
 * unique goes through the Batcher and merges into its district's meshes.
 *
 * CONTRACT:
 *   new Props(game, kit, batcher, rng)
 *   props.sandbagWall(zone, x, z, angle, len, courses)
 *   props.marketStall(...) / carHulk(...) / acUnit(...) / dish(...) / stall(...)
 *   props.scatterDebris(...) / weeds(...) / palm(...) / tree(...)
 *   props.instances  -> InstanceSet[]  (Level builds and adds them)
 */
export class Props {
  constructor(game, kit, batcher, rng) {
    this.game = game;
    this.kit = kit;
    this.bat = batcher;
    this.rng = rng;
    this.instances = [];
    this._sets = new Map();
    // Ground height every placement is measured from. Set it before dressing a
    // raised area (the terrace) and put it back afterwards; the y arguments on
    // these methods are all local to it.
    this.y = 0;
    this.M = new THREE.Matrix4();
    this.Q = new THREE.Quaternion();
    this.E = new THREE.Euler();
    this.S = new THREE.Vector3();
    this.P = new THREE.Vector3();
  }

  /* ------------------------------------------------------------ instancing */

  set(name, matKey, makeGeometry) {
    let s = this._sets.get(name);
    if (!s) {
      s = new InstanceSet(name, makeGeometry(), matKey);
      this._sets.set(name, s);
      this.instances.push(s);
    }
    return s;
  }

  /** Place one instance with jittered scale and a tint from a palette. */
  place(set, x, y, z, ry, scale = 1, palette, extra) {
    const rng = this.rng;
    const s = typeof scale === 'number' ? scale * rng.range(0.93, 1.08) : scale;
    this.E.set(extra?.rx ?? 0, ry, extra?.rz ?? 0);
    this.Q.setFromEuler(this.E);
    if (typeof s === 'number') this.S.setScalar(s);
    else this.S.copy(s);
    this.P.set(x, y + this.y, z);
    this.M.compose(this.P, this.Q, this.S);
    set.push(this.M, palette ? rng.pick(palette) : 0xffffff);
    return this.M;
  }

  /* --------------------------------------------------------------- geometry */

  /** Oil drum: rolled body, two swage rings, a rim and a bung. */
  drumGeo() {
    const k = this.kit;
    return mergeLocal([
      [k.cylinder(0.29, 0.29, 0.86, 12), t(0, 0.43, 0)],
      [k.torus(0.295, 0.028, 12, 5), rx(0, 0.62, 0)],
      [k.torus(0.295, 0.028, 12, 5), rx(0, 0.26, 0)],
      [k.torus(0.29, 0.035, 12, 5), rx(0, 0.85, 0)],
      [k.torus(0.29, 0.035, 12, 5), rx(0, 0.02, 0)],
      [k.cylinder(0.05, 0.05, 0.04, 6), t(0.16, 0.87, 0)],
    ]);
  }

  /** Crate: shell plus corner battens, so the silhouette has a lip. */
  crateGeo(s = 0.62) {
    const k = this.kit;
    const parts = [[k.chamfer(s, s * 0.92, s, 0.014), t(0, (s * 0.92) / 2, 0)]];
    for (const sx of [-1, 1]) {
      parts.push([k.chamfer(0.05, s * 0.92, s * 1.02, 0.008), t(sx * (s / 2), (s * 0.92) / 2, 0)]);
      parts.push([k.chamfer(s * 1.02, s * 0.92, 0.05, 0.008), t(0, (s * 0.92) / 2, sx * (s / 2))]);
    }
    parts.push([k.chamfer(s * 1.04, 0.05, s * 1.04, 0.01), t(0, s * 0.9, 0)]);
    return mergeLocal(parts);
  }

  /** Pallet: two runners and seven deck boards. */
  palletGeo() {
    const k = this.kit;
    const parts = [];
    for (const sz of [-1, 0, 1]) parts.push([k.chamfer(1.15, 0.09, 0.1, 0.01), t(0, 0.045, sz * 0.35)]);
    for (let i = 0; i < 5; i++) parts.push([k.chamfer(1.2, 0.02, 0.12, 0.006), t(0, 0.1, -0.4 + i * 0.2)]);
    return mergeLocal(parts);
  }

  /** Sandbag: a squashed sphere with a tied ear. Laid in courses, never in a grid. */
  bagGeo() {
    const k = this.kit;
    return mergeLocal([
      [k.sphere(0.5, 9, 6), s3(0.62, 0.3, 0.42)],
      [k.sphere(0.5, 6, 4), compose(0.3, 0.02, 0, 0.13, 0.1, 0.09)],
    ]);
  }

  /** Rubble chunk. Sub-metre, angular, chamfered so its edges catch light. */
  chunkGeo() {
    return this.kit.chamfer(0.34, 0.2, 0.26, 0.035);
  }

  brickGeo() {
    return this.kit.chamfer(0.22, 0.07, 0.1, 0.008);
  }

  tyreGeo() {
    return mergeLocal([
      [this.kit.torus(0.3, 0.115, 14, 7), rx(0, 0, 0)],
      [this.kit.cylinder(0.17, 0.17, 0.18, 10), rxq(0, 0, 0)],
    ]);
  }

  /** Spent case: 1 cm of brass. Only ever seen at the player's feet, and that is
   *  exactly where the eye looks for evidence that a fight happened. */
  brassGeo() {
    return mergeLocal([
      [this.kit.cylinder(0.0045, 0.005, 0.039, 6), rxq(0, 0, 0)],
      [this.kit.cylinder(0.0035, 0.0045, 0.012, 6), rxq(0, 0.024, 0)],
    ]);
  }

  /** Jerry can: flat body, three ribs, a spout and a handle. */
  jerryGeo() {
    const k = this.kit;
    const parts = [[k.chamfer(0.35, 0.46, 0.17, 0.03), t(0, 0.23, 0)]];
    for (const sx of [-0.1, 0.1]) parts.push([k.chamfer(0.06, 0.4, 0.19, 0.02), t(sx, 0.23, 0)]);
    parts.push([k.chamfer(0.1, 0.06, 0.1, 0.02), t(0.1, 0.48, 0)]);
    parts.push([k.chamfer(0.3, 0.05, 0.05, 0.02), t(0, 0.5, 0)]);
    return mergeLocal(parts);
  }

  /** Bottled-gas cylinder — a squat coloured accent in a dust-coloured scene. */
  gasGeo() {
    const k = this.kit;
    return mergeLocal([
      [k.cylinder(0.16, 0.16, 0.52, 12), t(0, 0.26, 0)],
      [k.dome(0.16, Math.PI / 2, 12, 5), t(0, 0.52, 0)],
      [k.cylinder(0.055, 0.055, 0.09, 8), t(0, 0.6, 0)],
      [k.torus(0.09, 0.014, 10, 4), rx(0, 0.63, 0)],
    ]);
  }

  /** Air-conditioning unit with a louvred face and a fan hub. Wall furniture is
   *  what stops a facade above the ground floor reading as blank. */
  acGeo() {
    const k = this.kit;
    const parts = [[k.chamfer(0.78, 0.6, 0.4, 0.02), t(0, 0, 0)]];
    for (let i = 0; i < 5; i++) parts.push([k.chamfer(0.66, 0.04, 0.04, 0.008), t(0, -0.2 + i * 0.1, 0.2)]);
    parts.push([k.torus(0.2, 0.022, 12, 4), compose(0, 0.02, 0.21, 1, 1, 1)]);
    parts.push([k.cylinder(0.06, 0.06, 0.06, 8), compose(0, 0.02, 0.2, 1, 1, 1, Math.PI / 2)]);
    for (const sx of [-1, 1]) parts.push([k.chamfer(0.06, 0.1, 0.5, 0.012), t(sx * 0.3, -0.34, -0.05)]);
    return mergeLocal(parts);
  }

  /**
   * Satellite dish on a bracket. Every roofline in the region carries a dozen.
   * The bowl is a squashed hemisphere tipped to face the sky, drawn two-sided
   * because a dish is seen from inside its own aperture as often as outside.
   */
  dishGeo() {
    const k = this.kit;
    return mergeLocal([
      [k.dome(0.42, Math.PI / 2, 14, 5), compose(0, 0.3, 0, 1, 0.42, 1, 1.15)],
      [k.cylinder(0.018, 0.018, 0.36, 6), compose(0, 0.26, 0.1, 1, 1, 1, -0.55)],
      [k.cylinder(0.035, 0.045, 0.52, 8), t(0, 0.0, -0.02)],
      [k.chamfer(0.22, 0.05, 0.22, 0.01), t(0, -0.25, -0.02)],
      [k.sphere(0.045, 6, 4), t(0, 0.42, 0.24)],
    ]);
  }

  /* ------------------------------------------------------------ assemblies */

  /**
   * Sandbag emplacement. Courses are laid with a half-bag offset, each bag
   * rotated a few degrees off true and the top course deliberately short, which
   * is how a real one ends up after someone has been leaning a rifle on it.
   */
  sandbagWall(zone, x, z, angle, length, courses = 3, y = 0) {
    const rng = this.rng;
    const set = this.set('sandbag', 'sandbag_canvas', () => this.bagGeo());
    const bagW = 0.62;
    const per = Math.max(2, Math.round(length / (bagW * 0.9)));
    const dx = Math.cos(angle);
    const dz = -Math.sin(angle);
    for (let c = 0; c < courses; c++) {
      const short = c === courses - 1 ? rng.int(3) : 0;
      const off = (c & 1) * 0.5;
      for (let i = 0; i < per - short; i++) {
        const t2 = (i + off - (per - 1) / 2) * bagW * 0.88;
        this.place(
          set,
          x + dx * t2 + rng.range(-0.03, 0.03),
          y + 0.14 + c * 0.26,
          z + dz * t2 + rng.range(-0.03, 0.03),
          angle + rng.range(-0.13, 0.13),
          rng.range(0.94, 1.07),
          SANDBAG_TINTS,
          { rz: rng.range(-0.08, 0.08) }
        );
      }
    }
    const M = new THREE.Matrix4()
      .makeRotationY(angle)
      .setPosition(x, this.y + y + (courses * 0.26) / 2, z);
    this.bat.zone(zone).collide(length + 0.5, courses * 0.26, 0.66, M);
  }

  /**
   * Market stall: four poles, a sagging awning, a plank counter and produce
   * crates. The awning is the point — a big coloured sagging plane at 2.3 m
   * catches the sun and throws a soft shadow onto the goods below.
   */
  marketStall(zone, x, z, ry, w = 2.6, d = 1.7, awningTint = 0xb4452f) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const rng = this.rng;
    const base = new THREE.Matrix4().makeRotationY(ry).setPosition(x, this.y, z);
    const M = new THREE.Matrix4();
    const h = 2.25 + rng.range(-0.12, 0.12);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        M.makeTranslation(sx * (w / 2), h / 2, sz * (d / 2)).premultiply(base);
        e.add('steel_rusted', k.cylinder(0.035, 0.04, h, 6), M, { keepUV: true, uvScale: [1, h / 2] });
        e.collide(0.12, h, 0.12, M);
      }
    }
    M.makeTranslation(0, h, 0).premultiply(base);
    e.add('camo_fabric|2s', saggingQuad(w + 0.5, d + 0.55, 0.22, 5, 3), M, {
      tint: new THREE.Color(awningTint),
      grime: 0,
    });
    // Counter and its skirt.
    M.makeTranslation(0, 0.86, d * 0.1).premultiply(base);
    e.add('wood_plank_weathered', k.chamfer(w, 0.07, d * 0.72, 0.014), M, {});
    e.collide(w, 0.9, d * 0.72, M);
    M.makeTranslation(0, 0.43, d * 0.1 + d * 0.34).premultiply(base);
    e.add('camo_fabric|2s', k.box(w, 0.86, 0.02, 0), M, { tint: new THREE.Color(awningTint).multiplyScalar(0.7) });
    for (const sx of [-1, 1]) {
      M.makeTranslation(sx * (w / 2 - 0.12), 0.43, d * 0.1).premultiply(base);
      e.add('wood_plank_weathered', k.chamfer(0.08, 0.86, 0.08, 0.012), M, {});
    }
    // Produce: shallow crates on the counter, sacks under it.
    const crate = this.set('crate_small', 'wood_ply|x3', () => this.crateGeo(0.38));
    for (let i = 0; i < 3; i++) {
      const lx = -w / 2 + 0.45 + i * (w / 3.2);
      this.P.set(lx, 0.9, d * 0.1 + rng.range(-0.15, 0.15)).applyMatrix4(base);
      this.place(crate, this.P.x, this.P.y, this.P.z, ry + rng.range(-0.3, 0.3), rng.range(0.85, 1.1), WOOD_TINTS);
    }
    const bag = this.set('sandbag', 'sandbag_canvas', () => this.bagGeo());
    for (let i = 0; i < 3; i++) {
      this.P.set(rng.range(-w / 2, w / 2), 0.14, -d * 0.25).applyMatrix4(base);
      this.place(bag, this.P.x, this.P.y, this.P.z, rng.float() * 3, rng.range(0.9, 1.2), SANDBAG_TINTS);
    }
  }

  /**
   * Burnt-out car hulk. Built from chamfered masses with the roof pressed in and
   * the glazing gone: a wreck reads by silhouette, so the shape gets the effort
   * and the material stays uniformly dark and rough.
   */
  carHulk(zone, x, z, ry, tint = 0x2a2724) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const rng = this.rng;
    const base = new THREE.Matrix4().makeRotationY(ry).setPosition(x, this.y, z);
    const M = new THREE.Matrix4();
    const col = new THREE.Color(tint);
    const put = (g, mat, mm, tt) => e.add(mat, g, mm, { tint: tt ?? col });

    // Body: sill, floor pan, bonnet, boot, crushed cabin.
    M.makeTranslation(0, 0.52, 0).premultiply(base);
    put(k.chamfer(1.76, 0.5, 4.0, 0.06), 'steel_rusted', M);
    M.makeTranslation(0, 0.86, 1.18).premultiply(base);
    put(k.chamfer(1.66, 0.26, 1.5, 0.05), 'steel_rusted', M);
    M.makeTranslation(0, 0.86, -1.5).premultiply(base);
    put(k.chamfer(1.66, 0.3, 0.9, 0.05), 'steel_rusted', M);
    // Cabin: A and C pillars plus a roof panel folded down on one side.
    for (const [sx, sz] of [
      [-1, 0.42],
      [1, 0.42],
      [-1, -1.0],
      [1, -1.0],
    ]) {
      M.makeTranslation(sx * 0.78, 1.12, sz)
        .multiply(new THREE.Matrix4().makeRotationX(sz > 0 ? 0.32 : -0.16))
        .premultiply(base);
      put(k.chamfer(0.12, 0.62, 0.14, 0.02), 'steel_rusted', M);
    }
    M.makeTranslation(-0.1, 1.36, -0.3)
      .multiply(new THREE.Matrix4().makeRotationZ(0.16))
      .multiply(new THREE.Matrix4().makeRotationX(0.05))
      .premultiply(base);
    put(k.chamfer(1.6, 0.08, 1.9, 0.04), 'steel_rusted', M);
    // Arches, bumpers, grille.
    for (const [sx, sz] of [
      [-1, 1.32],
      [1, 1.32],
      [-1, -1.3],
      [1, -1.3],
    ]) {
      M.makeTranslation(sx * 0.86, 0.62, sz).premultiply(base);
      put(k.chamfer(0.1, 0.5, 0.86, 0.05), 'steel_rusted', M);
    }
    for (const sz of [1, -1]) {
      M.makeTranslation(0, 0.62, sz * 2.02).premultiply(base);
      put(k.chamfer(1.7, 0.2, 0.14, 0.04), 'steel_rusted', M);
    }
    // Wheels: two burnt to the rim, two deflated.
    const tyre = this.set('tyre', 'rubber', () => this.tyreGeo());
    let i = 0;
    for (const [sx, sz] of [
      [-1, 1.3],
      [1, 1.3],
      [-1, -1.28],
      [1, -1.28],
    ]) {
      this.P.set(sx * 0.83, 0.3, sz).applyMatrix4(base);
      // rz tips the pancake onto its rim so the axle runs along the car's X;
      // one wheel in three is burnt down flat onto it.
      const flat = i++ % 3 === 0;
      this.S.set(1, 0.95, flat ? 0.78 : 1);
      this.E.set(0, ry, Math.PI / 2);
      this.Q.setFromEuler(this.E);
      this.M.compose(this.P, this.Q, this.S);
      tyre.push(this.M, 0x3b3835);
    }
    const C = new THREE.Matrix4().makeRotationY(ry).setPosition(x, this.y + 0.75, z);
    e.collide(1.9, 1.5, 4.2, C);
    // Scorch under and around it: a burnt car leaves a ring on the road.
    e.scorch(x, this.y + 0.02, z, 3.4, 0.42);
    e.scorch(x, this.y + 1.1, z, 2.2, 0.3);
    for (let j = 0; j < 6; j++) {
      this.P.set(rng.range(-1.4, 1.4), 0.03, rng.range(-2.6, 2.6)).applyMatrix4(base);
      this.place(
        this.set('chunk', 'concrete_pitted', () => this.chunkGeo()),
        this.P.x,
        this.P.y,
        this.P.z,
        rng.float() * 3,
        rng.range(0.4, 0.9),
        DEBRIS_TINTS,
        { rx: rng.range(-0.4, 0.4), rz: rng.range(-0.4, 0.4) }
      );
    }
  }

  /** Skip / dumpster: a big readable box mass, good hard cover. */
  dumpster(zone, x, z, ry, tint = 0x3f5a4a) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const base = new THREE.Matrix4().makeRotationY(ry).setPosition(x, this.y, z);
    const M = new THREE.Matrix4();
    const col = new THREE.Color(tint);
    M.makeTranslation(0, 0.62, 0).premultiply(base);
    e.add('iron_painted_chipped', k.chamfer(2.1, 1.2, 1.25, 0.035), M, { tint: col });
    e.collide(2.1, 1.24, 1.25, M);
    for (const sz of [-1, 1]) {
      M.makeTranslation(0, 1.2, sz * 0.62).premultiply(base);
      e.add('iron_painted_chipped', k.chamfer(2.14, 0.1, 0.1, 0.02), M, { tint: col });
    }
    M.makeTranslation(0, 1.28, -0.1)
      .multiply(new THREE.Matrix4().makeRotationX(-0.22))
      .premultiply(base);
    e.add('iron_painted_chipped', k.chamfer(2.0, 0.07, 1.1, 0.02), M, { tint: col.clone().multiplyScalar(0.9) });
    for (const sx of [-1, 1]) {
      M.makeTranslation(sx * 0.8, 0.1, 0.5).premultiply(base);
      e.add('steel_rusted', k.cylinder(0.1, 0.1, 0.08, 8), new THREE.Matrix4().copy(M).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)), {
        keepUV: true,
      });
    }
  }

  /** Wall-mounted air conditioner with its condensate stain and bracket. */
  acUnit(zone, x, y, z, ry, tint = 0xb9b5ac) {
    const set = this.set('ac', 'aluminium_scuffed', () => this.acGeo());
    this.place(set, x, y, z, ry, 1, [tint, 0xa8a49b, 0xc3bfb4]);
  }

  dish(zone, x, y, z, ry) {
    const set = this.set('dish', 'aluminium_scuffed|2s', () => this.dishGeo());
    this.place(set, x, y, z, ry, this.rng.range(0.85, 1.2), [0xdad6cc, 0xc9c4b6, 0xb0aa9c]);
  }

  /** Water tank on a roof: the other thing every roof in the region carries. */
  waterTank(zone, x, y, z, ry) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const base = new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
    const M = new THREE.Matrix4();
    M.makeTranslation(0, 0.95, 0).premultiply(base);
    e.add('steel_rusted', k.cylinder(0.62, 0.62, 1.1, 12), M, { keepUV: true, uvScale: [2, 0.55] });
    e.collide(1.24, 1.1, 1.24, M);
    M.makeTranslation(0, 1.5, 0).premultiply(base).multiply(new THREE.Matrix4().makeScale(1, 0.42, 1));
    e.add('steel_rusted', k.dome(0.62, Math.PI / 2, 12, 4), M, { keepUV: true });
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      M.makeTranslation(sx * 0.42, 0.2, sz * 0.42).premultiply(base);
      e.add('steel_rusted', k.chamfer(0.07, 0.4, 0.07, 0.012), M, {});
    }
    this.kit.pipeRun(
      e,
      'steel_brushed',
      [new THREE.Vector3(x + 0.5, y + 0.3, z), new THREE.Vector3(x + 0.8, y + 0.1, z), new THREE.Vector3(x + 0.8, y - 1.2, z)],
      0.035
    );
  }

  /**
   * Shop sign: a rusted board on two brackets, tinted an accent colour. A dusty
   * palette needs two or three saturated notes or the whole frame reads grey,
   * and signage is where a real street puts them.
   */
  sign(zone, m, w, h, tint) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const M = new THREE.Matrix4().makeTranslation(0, 0, 0.09).premultiply(m);
    e.add('iron_painted_chipped', k.chamfer(w, h, 0.06, 0.014), M, { tint: new THREE.Color(tint), grime: 0.5 });
    for (const sx of [-1, 1]) {
      const B = new THREE.Matrix4().makeTranslation(sx * (w / 2 - 0.12), 0, 0.045).premultiply(m);
      e.add('steel_rusted', k.chamfer(0.05, h * 0.9, 0.09, 0.01), B, {});
    }
    // A painted band and two blocks: enough to read as lettering at distance
    // without pretending to be a language.
    const A = new THREE.Matrix4().makeTranslation(0, h * 0.06, 0.125).premultiply(m);
    e.add('iron_painted_chipped', k.chamfer(w * 0.82, h * 0.3, 0.02, 0.006), A, {
      tint: new THREE.Color(0xe4dcc6),
      grime: 0.4,
    });
    for (const sx of [-1, 1]) {
      const A2 = new THREE.Matrix4().makeTranslation(sx * w * 0.26, -h * 0.28, 0.125).premultiply(m);
      e.add('iron_painted_chipped', k.chamfer(w * 0.2, h * 0.16, 0.02, 0.006), A2, {
        tint: new THREE.Color(0xd8cba8),
        grime: 0.4,
      });
    }
  }

  /** Laundry strung between two anchors: line, plus shirts hanging with a sag. */
  laundry(zone, a, b, count = 5) {
    const e = this.bat.zone(zone);
    const rng = this.rng;
    this.kit.cable(e, 'steel_brushed', a, b, 0.35, 0.008, new THREE.Color(0xdad6cc));
    const dir = new THREE.Vector3().subVectors(b, a);
    const ry = Math.atan2(dir.x, dir.z) + Math.PI / 2;
    for (let i = 0; i < count; i++) {
      const t2 = (i + 0.5 + rng.range(-0.2, 0.2)) / count;
      const p = new THREE.Vector3().lerpVectors(a, b, t2);
      p.y -= 0.35 * Math.sin(Math.PI * t2);
      const w = rng.range(0.42, 0.72);
      const h = rng.range(0.5, 0.95);
      const M = new THREE.Matrix4()
        .makeRotationY(ry + rng.range(-0.15, 0.15))
        .setPosition(p.x, p.y - h / 2 - 0.02, p.z);
      e.add('camo_fabric|2s', saggingQuad(w, 0.05, 0.02, 3, 1), M, { tint: new THREE.Color(rng.pick(CLOTH_TINTS)) });
      const D = new THREE.Matrix4()
        .makeRotationY(ry + rng.range(-0.15, 0.15))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .setPosition(p.x, p.y - h / 2 - 0.02, p.z);
      e.add('camo_fabric|2s', saggingQuad(w, h, 0.06, 3, 3), D, { tint: new THREE.Color(rng.pick(CLOTH_TINTS)), grime: 0 });
    }
  }

  /* ------------------------------------------------------------ vegetation */

  /**
   * Weed tufts through cracked paving. Sparse vegetation is the single cheapest
   * large gain in "does this look built": three tufts against a kerb do more for
   * a frame than another twenty metres of wall.
   */
  weeds(zone, x, z, radius, count, y = 0, scale = 1) {
    const set = this.set('weed', 'foliage_grass', () => crossCards(0.34, 0.42, 3));
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = Math.sqrt(rng.float()) * radius;
      this.place(
        set,
        x + Math.cos(a) * r,
        y - 0.03,
        z + Math.sin(a) * r,
        rng.float() * Math.PI,
        scale * rng.range(0.55, 1.5),
        GRASS_TINTS,
        { rz: rng.range(-0.12, 0.12) }
      );
    }
  }

  /** Dry grass along a wall base or kerb line. */
  grassLine(zone, x0, z0, x1, z1, count, spread = 0.35) {
    const set = this.set('weed', 'foliage_grass', () => crossCards(0.34, 0.42, 3));
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const t2 = rng.float();
      const nx = z1 - z0;
      const nz = -(x1 - x0);
      const nl = Math.hypot(nx, nz) || 1;
      const off = rng.gauss() * spread;
      this.place(
        set,
        x0 + (x1 - x0) * t2 + (nx / nl) * off,
        -0.03,
        z0 + (z1 - z0) * t2 + (nz / nl) * off,
        rng.float() * Math.PI,
        rng.range(0.5, 1.3),
        GRASS_TINTS,
        { rz: rng.range(-0.15, 0.15) }
      );
    }
  }

  /**
   * Date palm: a ringed tapering trunk with a slight lean and a crown of drooping
   * fronds at two lengths. Silhouette carries it, so the frond count and droop
   * matter more than the leaf texture.
   */
  palm(zone, x, z, height = 6.5, lean = 0.06) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const rng = this.rng;
    const segs = 6;
    let y = this.y;
    let tx = x;
    let tz = z;
    const dirx = Math.cos(rng.float() * 6);
    const dirz = Math.sin(rng.float() * 6);
    for (let i = 0; i < segs; i++) {
      const hs = height / segs;
      const r0 = 0.26 - (0.13 * i) / segs;
      const M = new THREE.Matrix4().makeTranslation(tx, y + hs / 2, tz);
      e.add('wood_plank_weathered', k.cylinder(r0 * 0.92, r0, hs, 8), M, {
        keepUV: true,
        uvScale: [3, hs / 2],
        tint: new THREE.Color(0x8a7a5c),
      });
      // Leaf-scar collar every segment: the stacked diamond pattern is what says
      // "palm" rather than "pole".
      const C = new THREE.Matrix4().makeTranslation(tx, y + hs, tz);
      e.add('wood_plank_weathered', k.cylinder(r0 * 1.16, r0 * 1.16, 0.09, 8), C, {
        keepUV: true,
        tint: new THREE.Color(0x6f6146),
      });
      y += hs;
      tx += dirx * lean * hs;
      tz += dirz * lean * hs;
    }
    e.collide(0.5, height, 0.5, new THREE.Matrix4().makeTranslation(x + dirx * lean * height * 0.4, this.y + height / 2, z + dirz * lean * height * 0.4));
    const crown = new THREE.Vector3(tx, y, tz);
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const pitch = rng.range(-0.15, 0.65);
      const len = rng.range(1.5, 2.5);
      const M = new THREE.Matrix4()
        .makeRotationY(a)
        .multiply(new THREE.Matrix4().makeRotationZ(pitch))
        .setPosition(crown.x, crown.y - 0.1, crown.z);
      e.add('foliage_frond|2s', leafCard(len, len * 0.46, 0.42, 4), M, {
        tint: new THREE.Color(rng.pick(FROND_TINTS)),
        grime: 0,
      });
    }
    // Dead skirt: the collapsed brown fronds that hang under the live crown.
    for (let i = 0; i < 5; i++) {
      const a = rng.float() * Math.PI * 2;
      const M = new THREE.Matrix4()
        .makeRotationY(a)
        .multiply(new THREE.Matrix4().makeRotationZ(-0.9))
        .setPosition(crown.x, crown.y - 0.25, crown.z);
      e.add('foliage_frond|2s', leafCard(1.1, 0.5, 0.5, 3), M, { tint: new THREE.Color(0x776243), grime: 0 });
    }
  }

  /** Scrubby broadleaf: forking trunk, then leaf clusters on the branch ends. */
  tree(zone, x, z, height = 5.2) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const rng = this.rng;
    const trunkH = height * 0.42;
    e.add(
      'wood_plank_weathered',
      k.cylinder(0.16, 0.27, trunkH, 8),
      new THREE.Matrix4().makeTranslation(x, this.y + trunkH / 2, z),
      { keepUV: true, uvScale: [2, trunkH / 2], tint: new THREE.Color(0x6d5c46) }
    );
    e.collide(0.5, trunkH, 0.5, new THREE.Matrix4().makeTranslation(x, this.y + trunkH / 2, z));
    const tips = [];
    const nb = 5;
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const len = height * rng.range(0.34, 0.5);
      const pitch = rng.range(0.5, 1.0);
      const dx = Math.cos(a) * Math.cos(pitch) * len;
      const dz = Math.sin(a) * Math.cos(pitch) * len;
      const dy = Math.sin(pitch) * len;
      const mid = new THREE.Vector3(x + dx / 2, this.y + trunkH + dy / 2, z + dz / 2);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(dx, dy, dz).normalize()
      );
      e.add('wood_plank_weathered', k.cylinder(0.05, 0.11, len, 6), new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), {
        keepUV: true,
        uvScale: [2, len / 2],
        tint: new THREE.Color(0x6d5c46),
      });
      tips.push(new THREE.Vector3(x + dx, this.y + trunkH + dy, z + dz));
    }
    const set = this.set('leafclump', 'foliage_leaf', () => crossCards(1.35, 1.5, 3));
    for (const tip of tips) {
      for (let j = 0; j < 3; j++) {
        this.place(
          set,
          tip.x + rng.range(-0.5, 0.5),
          tip.y - this.y + rng.range(-0.5, 0.3) - 0.7,
          tip.z + rng.range(-0.5, 0.5),
          rng.float() * 3,
          rng.range(0.75, 1.25),
          LEAF_TINTS,
          { rz: rng.range(-0.2, 0.2) }
        );
      }
    }
    e.collide(1.6, 1.6, 1.6, new THREE.Matrix4().makeTranslation(x, this.y + trunkH + height * 0.2, z));
  }

  /** Planter: a chamfered concrete tub with soil and something half-dead in it. */
  planter(zone, x, z, ry, w = 1.3) {
    const e = this.bat.zone(zone);
    const k = this.kit;
    const base = new THREE.Matrix4().makeRotationY(ry).setPosition(x, this.y, z);
    const M = new THREE.Matrix4();
    M.makeTranslation(0, 0.28, 0).premultiply(base);
    e.add('concrete_cast', k.chamfer(w, 0.56, w * 0.72, 0.045), M, {});
    e.collide(w, 0.58, w * 0.72, M);
    M.makeTranslation(0, 0.55, 0).premultiply(base);
    e.add('dirt_packed', k.box(w - 0.14, 0.06, w * 0.72 - 0.14, 0), M, { grime: 0 });
    this.weeds(zone, x, z, w * 0.28, 7, 0.62, 1.25);
  }

  /* ---------------------------------------------------------------- debris */

  /**
   * Scattered debris over an area, biased toward `edge` if one is given so that
   * grit collects along a kerb or wall base instead of sitting in the open.
   */
  scatterDebris(zone, x, z, rx, rz, count, opts = {}) {
    const rng = this.rng;
    const chunk = this.set('chunk', 'concrete_pitted', () => this.chunkGeo());
    const brick = this.set('brick', 'brick_red|x2.5', () => this.brickGeo());
    for (let i = 0; i < count; i++) {
      const bias = opts.bias ?? 0;
      const u = rng.float();
      const px = x + (u * 2 - 1) * rx;
      const pz = z + (rng.float() * 2 - 1) * rz * (1 - bias * Math.abs(u));
      const set = rng.float() < (opts.brickRatio ?? 0.45) ? brick : chunk;
      this.place(set, px, (opts.y ?? 0) + 0.02, pz, rng.float() * 3, rng.range(0.45, 1.35), DEBRIS_TINTS, {
        rx: rng.range(-0.5, 0.5),
        rz: rng.range(-0.5, 0.5),
      });
    }
  }

  /** Spent brass, only ever where a fight would have been fought from. */
  brass(zone, x, z, radius, count) {
    const rng = this.rng;
    const set = this.set('brass', 'steel_brushed', () => this.brassGeo());
    for (let i = 0; i < count; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = Math.sqrt(rng.float()) * radius;
      this.place(set, x + Math.cos(a) * r, 0.006, z + Math.sin(a) * r, rng.float() * 3, rng.range(0.85, 1.15), BRASS_TINTS, {
        rx: Math.PI / 2,
        rz: rng.float() * 3,
      });
    }
  }

  /** Drums, crates, pallets and cans against a wall or in a yard. */
  yardClutter(zone, x, z, ry, spread = 2.4, n = 7) {
    const rng = this.rng;
    const drum = this.set('drum', 'steel_rusted|x1.6', () => this.drumGeo());
    const crate = this.set('crate', 'wood_plank_weathered|x2.4', () => this.crateGeo(0.62));
    const pallet = this.set('pallet', 'wood_plank_weathered|x2.4', () => this.palletGeo());
    const jerry = this.set('jerry', 'iron_painted_chipped', () => this.jerryGeo());
    const gas = this.set('gas', 'iron_painted_chipped', () => this.gasGeo());
    const dirx = Math.cos(ry);
    const dirz = -Math.sin(ry);
    for (let i = 0; i < n; i++) {
      const t2 = (i / Math.max(1, n - 1) - 0.5) * spread * 2;
      const px = x + dirx * t2 + rng.gauss() * 0.3;
      const pz = z + dirz * t2 + rng.gauss() * 0.3;
      const roll = rng.float();
      if (roll < 0.3) {
        this.place(drum, px, 0, pz, rng.float() * 3, 1, DRUM_TINTS);
        this._collideCyl(zone, px, pz, 0.32, 0.88);
      } else if (roll < 0.42) {
        // On its side, because a yard always has one down.
        this.place(drum, px, 0.29, pz, rng.float() * 3, 1, DRUM_TINTS, { rz: Math.PI / 2 });
      } else if (roll < 0.62) {
        const stack = rng.int(2) + 1;
        for (let s = 0; s < stack; s++) {
          this.place(crate, px + rng.range(-0.07, 0.07), s * 0.58, pz + rng.range(-0.07, 0.07), rng.float() * 3, 1, WOOD_TINTS);
        }
        this._collideBox(zone, px, pz, 0.68, stack * 0.58, 0.68);
      } else if (roll < 0.74) {
        this.place(pallet, px, 0.02, pz, rng.float() * 3, 1, WOOD_TINTS);
      } else if (roll < 0.86) {
        this.place(jerry, px, 0, pz, rng.float() * 3, 1, [0x4d5340, 0x565b46, 0x6a5b3c]);
      } else {
        this.place(gas, px, 0, pz, rng.float() * 3, 1, [0xa8531f, 0x2f5566, 0x8b8474]);
      }
    }
  }

  /** Tyres: stacked, leaning, or lying flat in a puddle of grit. */
  tyres(zone, x, z, n = 4) {
    const rng = this.rng;
    const set = this.set('tyre', 'rubber', () => this.tyreGeo());
    let stack = 0;
    for (let i = 0; i < n; i++) {
      if (rng.float() < 0.55) {
        this.place(set, x + rng.range(-0.1, 0.1), 0.12 + stack * 0.2, z + rng.range(-0.1, 0.1), rng.float() * 3, 1, [
          0x2c2a28, 0x35322f, 0x232120,
        ]);
        stack++;
      } else {
        this.place(set, x + rng.range(-1.2, 1.2), 0.3, z + rng.range(-1.2, 1.2), rng.float() * 3, 1, [0x2c2a28, 0x35322f], {
          rz: Math.PI / 2 + rng.range(-0.2, 0.2),
        });
      }
    }
    if (stack) this._collideCyl(zone, x, z, 0.42, stack * 0.2);
  }

  _collideCyl(zone, x, z, r, h) {
    this.bat.zone(zone).collide(r * 1.7, h, r * 1.7, new THREE.Matrix4().makeTranslation(x, this.y + h / 2, z));
  }

  _collideBox(zone, x, z, w, h, d) {
    this.bat.zone(zone).collide(w, h, d, new THREE.Matrix4().makeTranslation(x, this.y + h / 2, z));
  }
}

/* ------------------------------------------------------------------ palettes */

// Faded, dusty, low-chroma: every tint here multiplies an already-authored PBR
// albedo, so anything saturated turns into a toy. The two accent lists (cloth,
// drums) are the exception and exist on purpose.
const SANDBAG_TINTS = [0xbfb69e, 0xa89d84, 0xcfc6ac, 0x968c76, 0xb5aa8e];
const WOOD_TINTS = [0xc9bda6, 0xb0a48c, 0xd6cbb4, 0x9c9280];
const DEBRIS_TINTS = [0xb9b3a8, 0xa39c90, 0xc6c0b4, 0x8e887e, 0xada38f];
const DRUM_TINTS = [0x9b5f3a, 0x4a6b74, 0x8a8474, 0xa8763c, 0x5f6b52, 0xb4ada0];
const CLOTH_TINTS = [0xd8d2c4, 0x6f93a8, 0xc4a86a, 0xa85a4a, 0x8d9b78, 0xe0dcd0];
const GRASS_TINTS = [0xbfb488, 0xa8a072, 0xd2c79c, 0x93906c];
const LEAF_TINTS = [0x8d9a68, 0x7a8a5c, 0xa3a878, 0x6d7a52];
const FROND_TINTS = [0x8f9560, 0x7d8a55, 0xa2a06a, 0x6f7a4c];
const BRASS_TINTS = [0xc8a24c, 0xb08c3c, 0xd6b45e];

/* ------------------------------------------------------- local merge helper */

function t(x, y, z) {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

/** Torus lying flat (it is authored in the XY plane). */
function rx(x, y, z) {
  return new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x, y, z);
}

function rxq(x, y, z) {
  return new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y, z);
}

function s3(sx, sy, sz) {
  return new THREE.Matrix4().makeScale(sx, sy, sz);
}

function compose(x, y, z, sx, sy, sz, rotX = 0) {
  const m = new THREE.Matrix4().makeRotationX(rotX);
  m.scale(new THREE.Vector3(sx, sy, sz));
  m.setPosition(x, y, z);
  return m;
}

/**
 * Merge a handful of sub-shapes into one prop geometry. Separate from Batcher
 * because these are *instanced* props: the merge happens once in local space and
 * the result is uploaded once, then drawn hundreds of times.
 */
function mergeLocal(parts) {
  let nv = 0;
  let ni = 0;
  for (const [g] of parts) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const nmat = new THREE.Matrix3();
  let vo = 0;
  let io = 0;
  for (const [g, m] of parts) {
    const sp = g.attributes.position.array;
    const sn = g.attributes.normal.array;
    const count = g.attributes.position.count;
    const el = m.elements;
    nmat.setFromMatrix4(m).invert().transpose();
    const nm = nmat.elements;
    for (let i = 0; i < count; i++) {
      const x = sp[i * 3];
      const y = sp[i * 3 + 1];
      const z = sp[i * 3 + 2];
      const o = (vo + i) * 3;
      pos[o] = el[0] * x + el[4] * y + el[8] * z + el[12];
      pos[o + 1] = el[1] * x + el[5] * y + el[9] * z + el[13];
      pos[o + 2] = el[2] * x + el[6] * y + el[10] * z + el[14];
      const ax = sn[i * 3];
      const ayy = sn[i * 3 + 1];
      const az = sn[i * 3 + 2];
      let px = nm[0] * ax + nm[3] * ayy + nm[6] * az;
      let py = nm[1] * ax + nm[4] * ayy + nm[7] * az;
      let pz = nm[2] * ax + nm[5] * ayy + nm[8] * az;
      const l = Math.hypot(px, py, pz) || 1;
      nrm[o] = px / l;
      nrm[o + 1] = py / l;
      nrm[o + 2] = pz / l;
      // Local metre projection for every part, including the ones that arrived
      // with 0..1 UVs from a Three primitive. Mixing the two inside one prop is
      // what makes a drum's body and its swage ring show the same rust at two
      // different scales, and texel density has to be uniform to survive a close
      // material read.
      const o2 = (vo + i) * 2;
      const bx = Math.abs(nrm[o]);
      const by = Math.abs(nrm[o + 1]);
      const bz = Math.abs(nrm[o + 2]);
      if (by >= bx && by >= bz) {
        uv[o2] = pos[o];
        uv[o2 + 1] = pos[o + 2];
      } else if (bx >= bz) {
        uv[o2] = pos[o + 2];
        uv[o2 + 1] = pos[o + 1];
      } else {
        uv[o2] = pos[o];
        uv[o2 + 1] = pos[o + 1];
      }
    }
    if (g.index) {
      const si = g.index.array;
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
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.userData.keepUV = true;
  out.computeBoundingSphere();
  return out;
}

export { mergeLocal, CLOTH_TINTS, DRUM_TINTS, DEBRIS_TINTS, GRASS_TINTS };
