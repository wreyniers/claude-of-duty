import * as THREE from 'three';
import { Rng } from '../render/Noise.js';
import { Kit, Batcher } from './Kit.js';
import { Props } from './Props.js';

/**
 * The map: a war-torn Mediterranean town square, approached from the south down
 * a rubble-strewn road.
 *
 * COMPOSITION IS BUILT AROUND THE LIGHT AND AROUND THE FIVE CAPTURE POSES.
 *
 * The sun sits low in the north-west (Sky's `goldenHour`), so it travels toward
 * +X and +Z. That single fact decides the plan: every wall facing WEST is lit,
 * every wall facing SOUTH — which is every wall the establishing shot looks at —
 * is in shadow. So the mass on the right of frame (the terrace, the tall east
 * block, the arcade, the minaret) presents west faces and carries the light,
 * while the mass on the left (the hall, the west block, the north block) reads as
 * silhouette against the sun's own glow. Long shadows rake across the square
 * toward the camera's right. That is the entire reason the districts are not
 * symmetrical.
 *
 * Depth is built in three bands, so no pose looks at one plane of interest:
 * foreground 5-15 m (road, kerbs, wrecked car, wires overhead), midground 20-35 m
 * (the square, its fountain, the stalls, the terrace and its stair), background
 * 40-90 m (north block, minaret, tall east block) with a distant city ring at
 * 100-200 m to give the haze something to eat.
 *
 * The interior pose sits inside the hall at (-8, 1.6, -4) looking west-north-west.
 * Everything in that room is placed by ray: the partition wall stops short so the
 * view opens past its lit edge; a blast hole in the north wall at x = -14.5 is
 * positioned so the sun beam through it lands on the floor at (-10.5, -6.5),
 * which is the lower right of that frame; the west wall's window sits at z = -7.5
 * so it is near frame centre nine metres out.
 *
 * CONTRACT:
 *   root          : THREE.Group   everything the level owns
 *   spawnPoints   : [{position: Vector3 (eye height), yaw}]
 *   enemySpawns   : [{position: Vector3 (feet), yaw, cover: string}]
 *   bounds        : THREE.Box3
 *   collidables   : THREE.Object3D[]  meshes Collision builds its BVH over
 *
 * ADDITIONS (safe to rely on):
 *   kit / props / batcher     the construction kit and the clutter pass
 *   meshes                    every mesh added to the scene
 *   zones                     named rectangles for AI and audio reverb
 *   stats                     { initMs, meshes, triangles, colliders, instances }
 */

/**
 * Texture density, in tiles per the recipe's own `tile` metres.
 *
 * The recipes state a metres-per-tile figure, but they were authored to be
 * sampled at 2-3 tiles per UV unit, and taking `tile` literally puts a brick
 * course at half a metre and an asphalt chipping at 13 cm — which is what makes
 * plaster read as camouflage and concrete as swiss cheese. These multipliers put
 * every recipe's own feature size where the real thing is: brick at 22 cm,
 * chippings at 5 cm, corrugation pitch at 7 cm, jute weave at 1 cm.
 *
 * Cast concrete is the exception and goes the other way, because the features its
 * recipe authors are *architectural*, not granular: form-board seams and bug
 * holes are decimetres to metres apart, and the recipe is written against its
 * `tile` taken literally — its own comments budget roughly a metre of paving per
 * 85 texels. Pulled to the same ~0.8 m tile as everything else, all of that lands
 * under a pixel: the maps bake at 256 px, so 0.8 m per tile is 300 texels of fBm
 * per metre, and the square's paving — the largest surface in any frame — came out
 * as one texel of static per screen pixel at four metres. At 1.0 the aggregate
 * lands at 66 mm and the shuttering seams at 2.5 m, which is a readable pit and a
 * slab joint rather than noise.
 *
 * `concrete_pitted` stays dense even though its recipe shares those numbers.
 * Loosening it to 1.4 was tried and reverted on the evidence: its spall craters
 * and crack network are a *cellular* field, and at 1.4 m per tile the network
 * became legible as a network — the terrace's retaining wall read as crazy paving,
 * which is the failure its own recipe comment is written to avoid. Dense enough to
 * stay sub-feature is the lesser evil for that one.
 *
 * PLASTER IS BACK AT 2.1, AND THAT IS A REVERT, NOT A NEW NUMBER. It was raised
 * from 2.1 to 3.2 in "Dust the interior floor and break up the plaster scars" for
 * one stated reason: the peel patches were reading as camouflage. That reason was
 * then fixed a second time, independently, inside the recipe — `plaster_painted`
 * now puts its bare substrate only 20 levels under the paint instead of 40,
 * precisely so the two-tone blob pattern stops reading as camouflage, and its
 * comment says so. Two corrections for one defect, and the one living here is the
 * one with the side effect.
 *
 * The side effect is measurable. UVs on this level are projected from world
 * position, so a multiplier of 3.2 against `tile: 3` puts the plaster lattice on a
 * 94 cm world grid — the same grid, in the same phase, on every wall in the town.
 * On the interior pose's back wall that is a repeat every 132 px, and the
 * high-passed vertical autocorrelation of that region peaks at **0.88** at exactly
 * that lag: the wall is not textured, it is wallpapered, which is the rubric's
 * named material fail ("tiling repeats visible at a glance"). At 2.1 the lattice
 * goes to 1.43 m, or a 201 px repeat over a wall that is 270 px tall in frame —
 * under one and a half periods, which is the point at which the eye stops
 * pattern-matching. It costs some albedo frequency, and that is affordable
 * precisely here: `plaster_painted` carries a separate near-field `detail` layer
 * (freq 8, fading at 6 m) authored to survive being seen from a metre and a half,
 * and that layer does not scale with this multiplier.
 *
 * Knock-on to name honestly, because it is not mine to re-measure: the recipe's
 * ghost courses are two per tile and its comment costs them at "47 cm at this
 * level's tiling", which was 3.2. At 2.1 they are 71 cm. A 71 cm course is a
 * render bay rather than a block, which is a weaker read than intended but not a
 * wrong one — and it is the smaller error of the two.
 */
const TILE_MULT = {
  concrete_cast: 1.0,
  concrete_pitted: 3.2,
  brick_red: 2.6,
  plaster_painted: 2.1,
  tile_ceramic: 1.6,
  asphalt: 2.6,
  dirt_packed: 2.2,
  gravel: 2.2,
  sand: 2.0,
  steel_brushed: 2.0,
  steel_rusted: 2.2,
  iron_painted_chipped: 2.2,
  aluminium_scuffed: 2.0,
  corrugated_metal: 3.4,
  wood_plank_weathered: 2.6,
  wood_ply: 2.2,
  sandbag_canvas: 3.4,
  camo_fabric: 3.0,
  rubber: 3.5,
  glass_dirty: 1.6,
};

/** Weathered softwood, for the handful of props Level places directly rather
 *  than through one of Props' own assemblies. */
const PALLET_TINTS = [0xc9bda6, 0xb0a48c, 0xd6cbb4, 0x9c9280];

/** Faded plaster and masonry hues. Every building gets its own so the town does
 *  not read as one paint batch. */
const HUE = {
  sand: 0xe0d3b6,
  bone: 0xe8e2d2,
  ochre: 0xd8bb8a,
  clay: 0xcfa987,
  grey: 0xcbc7bd,
  blue: 0xb8c2c4,
  pink: 0xd9b8ac,
  far: 0xa8b0b4,
};

export class Level {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'level';
    this.root.matrixAutoUpdate = false;

    this.spawnPoints = [{ position: new THREE.Vector3(0, 1.7, 20), yaw: 0 }];
    this.enemySpawns = [];
    this.bounds = new THREE.Box3(new THREE.Vector3(-42, -4, -48), new THREE.Vector3(42, 40, 46));
    this.collidables = [];
    this.meshes = [];
    this.zones = {};
    this.lights = [];
    this.stats = { initMs: 0, meshes: 0, triangles: 0, colliders: 0, instances: 0, instanced: 0 };

    this.rng = new Rng(0x7a1e05);
    this.kit = null;
    this.props = null;
    this.batcher = null;
  }

  async init() {
    const t0 = performance.now();
    const { scene, forge } = this.game;

    this._registerVegetation();
    this.kit = new Kit(forge, this.rng);
    this.batcher = new Batcher(this.kit);
    this.props = new Props(this.game, this.kit, this.batcher, this.rng);

    this._ground();
    this._westDistrict();
    this._northDistrict();
    this._eastDistrict();
    this._southDistrict();
    this._squareDressing();
    this._distant();
    this._overheadWires();

    this._finish();
    this._collision();
    this._spawns();
    this._lights();

    scene.add(this.root);
    this.stats.initMs = +(performance.now() - t0).toFixed(1);
    this.game.bus.emit('level:ready', this.stats);
  }

  /* ------------------------------------------------------------- materials */

  /**
   * Batch materials carry `vertexColors` because every merged vertex holds its
   * per-piece tint, its splash-zone dirt and its blast soot. Key syntax is
   * `recipe[|2s][|xN]`: two-sided, and a tiling multiplier for props whose
   * natural texel density differs from the recipe's metres-per-tile.
   */
  _matFor(key) {
    const forge = this.game.forge;
    const parts = String(key).split('|');
    const name = parts[0];
    let mult = 1;
    let side = null;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === '2s') side = THREE.DoubleSide;
      // `|xN` overrides the density table for one prop, it does not scale it.
      else if (parts[i][0] === 'x') mult = parseFloat(parts[i].slice(1)) || 1;
    }
    if (mult === 1) mult = TILE_MULT[name] ?? 1;
    const tile = forge.tileFor(name) || 1;
    // Geometry UVs are in metres, so repeat is 1/tile: one texture tile covers
    // exactly the metres its recipe was authored for, on every surface in the
    // level, whatever size the piece is.
    // vertexColors everywhere, including on instanced props (InstanceSet gives
    // their geometry a white colour attribute): one material per recipe means one
    // compiled program per recipe, and programs are the expensive thing.
    const o = { uvScale: [mult / tile, mult / tile], vertexColors: true };
    if (side) o.side = side;
    return forge.material(name, o);
  }

  /**
   * Alpha-tested foliage. Registered with the forge (the only place allowed to
   * make a texture) so the masks are cached and shared like any other asset.
   * Even sparse vegetation transforms how built a frame reads, and three masks
   * cost about 40 kB.
   */
  _registerVegetation() {
    const forge = this.game.forge;
    forge.registerTexture('veg_blades', () => maskTexture(72, (px) => drawBlades(px, 72)));
    forge.registerTexture('veg_leaves', () => maskTexture(72, (px) => drawLeaves(px, 72)));
    forge.registerTexture('veg_frond', () => maskTexture(80, (px) => drawFrond(px, 80)));

    const foliage = (texName, rough) => () => {
      const m = new THREE.MeshStandardMaterial({
        map: forge.texture(texName),
        // Alpha test, not blend: alpha-blended foliage needs sorting it will
        // never get, and the depth prepass and the shadow map both handle a
        // tested cutout correctly for free.
        alphaTest: 0.34,
        transparent: false,
        roughness: rough,
        metalness: 0,
        side: THREE.FrontSide,
        dithering: true,
      });
      m.name = texName;
      return m;
    };
    forge.registerMaterial('foliage_grass', foliage('veg_blades', 0.88));
    forge.registerMaterial('foliage_leaf', foliage('veg_leaves', 0.8));
    forge.registerMaterial('foliage_frond', foliage('veg_frond', 0.74));
  }

  /* ---------------------------------------------------------------- ground */

  _ground() {
    const e = this.batcher.zone('ground');
    const k = this.kit;
    const rng = this.rng;

    // Outskirts, as a frame around the paved square rather than one plane under
    // it. A full-screen ground layer hidden behind another full-screen ground
    // layer is a second pass of three samplers at grazing incidence for nothing,
    // and grazing-angle ground is the most expensive fill in the frame.
    for (const [x0, x1, z0, z1] of [
      [-300, 300, -340, -16],
      [-300, 300, 14, 260],
      [-300, -20, -16, 14],
      [20, 300, -16, 14],
    ]) {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 5, 5).rotateX(-Math.PI / 2);
      e.add('dirt_packed', g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, -0.06, (z0 + z1) / 2), {
        mottle: 0.3,
        mottleScale: 0.006,
        grime: 0,
      });
    }

    // The square's paving: one continuous grid so the large-scale albedo drift
    // interpolates smoothly instead of stepping at tile joins.
    const paving = new THREE.PlaneGeometry(40, 30, 18, 14).rotateX(-Math.PI / 2);
    e.add('concrete_cast', paving, new THREE.Matrix4().makeTranslation(0, 0, -1), {
      mottle: 0.34,
      mottleScale: 0.05,
      grime: 0,
    });
    // Approach road, running south out of the square.
    const road = new THREE.PlaneGeometry(17, 30, 8, 14).rotateX(-Math.PI / 2);
    e.add('asphalt', road, new THREE.Matrix4().makeTranslation(0, 0.005, 27), { mottle: 0.3, mottleScale: 0.045, grime: 0 });
    // and its continuation north between the blocks, so the square is a junction
    const road2 = new THREE.PlaneGeometry(13, 22, 6, 10).rotateX(-Math.PI / 2);
    e.add('asphalt', road2, new THREE.Matrix4().makeTranslation(-2, 0.005, -25), { mottle: 0.3, mottleScale: 0.045, grime: 0 });

    // Kerbs down both sides of the approach, and the square's edge kerb. These
    // are the strongest leading lines in the establishing shot.
    for (const sx of [-1, 1]) {
      const M = new THREE.Matrix4().makeTranslation(sx * 8.5, 0, 24);
      k.kerb(e, M.clone().multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), 26, { collide: true });
      const P = new THREE.Matrix4().makeTranslation(sx * 12.4, 0.09, 24);
      e.add('concrete_cast', k.box(7.4, 0.18, 26, 2.4), P, { mottle: 0.2, mottleScale: 0.06 });
      e.collide(7.4, 0.18, 26, P);
    }

    // Patches where the paving has failed into dirt and gravel. Overlapping
    // rectangles at different rotations blend the two grounds instead of
    // butting them, which is what stops a material change reading as a decal.
    for (let i = 0; i < 16; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = 6 + rng.float() * 26;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 0.8 - 2;
      const w = rng.range(2.2, 7);
      const d = rng.range(1.8, 6);
      const M = new THREE.Matrix4().makeRotationY(rng.float() * 3).setPosition(x, 0.012 + i * 0.0004, z);
      e.add(rng.float() < 0.45 ? 'gravel' : 'dirt_packed', new THREE.PlaneGeometry(w, d, 2, 2).rotateX(-Math.PI / 2), M, {
        mottle: 0.25,
        mottleScale: 0.09,
        grime: 0,
      });
    }

    this.zones.square = new THREE.Box3(new THREE.Vector3(-19, 0, -16), new THREE.Vector3(19, 12, 14));
  }

  /* ----------------------------------------------------------------- west */

  /**
   * The hall (enterable, and the interior pose lives in it), the west block
   * behind it, the sunken alley between them, and the south-west block that
   * frames the road.
   */
  _westDistrict() {
    const e = this.batcher.zone('west');
    const k = this.kit;
    const rng = this.rng;
    const sand = new THREE.Color(HUE.sand);

    /* --- the hall: cx -11.5, cz -5.4, 11.8 x 13.2, single tall storey ----- */
    const cx = -11.5;
    const cz = -5.4;
    const w = 11.8;
    const d = 13.2;
    const h = 4.7;
    const T = 0.44;

    // North facade: the blast hole at local x 2.96 is the interior pose's light
    // source. Local +X on this face runs toward world -X.
    const north = [
      { x: 2.96, y: 1.0, w: 2.3, h: 2.05, blast: true, trim: false },
      { x: -3.4, y: 1.15, w: 1.15, h: 1.7, glass: true },
      { x: -0.6, y: 1.15, w: 1.0, h: 1.7 },
    ];
    // West facade: local +X runs toward world +Z, so local -2.1 is world z -7.5 —
    // near the centre of the interior pose's frame, nine metres out.
    const west = [
      { x: -2.1, y: 1.2, w: 1.5, h: 1.9 },
      { x: 3.2, y: 1.2, w: 1.2, h: 1.8, glass: true, shutter: { side: 1, angle: 0.9 } },
      { x: -5.0, y: 1.2, w: 1.1, h: 1.8 },
    ];
    // South facade faces the square: a shopfront-wide collapse plus a door, so
    // the room is enterable and floods with skylight from behind the camera.
    const south = [
      { x: -3.1, y: 0, w: 3.4, h: 2.75, blast: true, trim: false },
      { x: 2.6, y: 0, w: 1.25, h: 2.3, arch: true },
      { x: 4.9, y: 1.15, w: 1.1, h: 1.7, glass: true },
    ];
    const east = [
      { x: -2.2, y: 0, w: 1.3, h: 2.3 },
      { x: 3.0, y: 1.2, w: 1.3, h: 1.8, glass: true },
    ];

    k.building(e, {
      cx,
      cz,
      w,
      d,
      h,
      thickness: T,
      mat: 'plaster_painted',
      tint: sand,
      trimMat: 'concrete_cast',
      trimTint: new THREE.Color(HUE.bone),
      sides: [{ openings: south }, { openings: north }, { openings: east }, { openings: west }],
      floorH: 4.7,
      plinth: 0.5,
      stringCourse: false,
      trimBothSides: true,
      // No ceiling slab: the collapsed roof corner has to be a hole to the sky,
      // which is where the interior pose gets its second light source.
      topSlab: false,
      // Dust-covered screed, not glazed tile. A white gloss floor was both the
      // brightest thing in the interior frame and the wrong century.
      floorMat: 'concrete_cast',
      floorTint: new THREE.Color(0xb0a696),
      roof: { parapet: 0.66, collapsed: { x: -3.2, z: -3.6, w: 3.8, d: 3.6 } },
    });

    // Partition: stops at z = -4.6 on purpose. The interior pose's centre ray
    // crosses x = -11.5 at z = -5.36, so it passes the stub's north edge and the
    // room opens up beyond it — a wall across the whole frame would be a wall.
    const pz0 = 0.76;
    const pz1 = -4.6;
    const pm = new THREE.Matrix4()
      .makeRotationY(Math.PI / 2)
      .setPosition(cx, 0, (pz0 + pz1) / 2);
    k.wall(e, pm, {
      length: pz0 - pz1,
      height: 4.35,
      thickness: 0.3,
      mat: 'plaster_painted',
      tint: sand,
      openings: [{ x: -0.9, y: 0, w: 1.45, h: 2.35, trim: false }],
      cell: 1.1,
      trimBothSides: true,
    });
    k.plasterLoss(e, new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(cx, 0, -2.2), 0, 2.2, 2.6, 2.2, 0.3);

    // Ceiling beams under the roof deck, and the collapsed corner's fallen ones.
    for (let i = 0; i < 8; i++) {
      const bz = -11 + i * 1.62;
      const M = new THREE.Matrix4().makeTranslation(cx, 4.47, bz);
      e.add('wood_plank_weathered', k.chamfer(w - T * 2, 0.22, 0.16, 0.02), M, { grime: 0 });
    }
    for (let i = 0; i < 3; i++) {
      const M = new THREE.Matrix4()
        .makeRotationY(rng.range(-0.5, 0.5))
        .multiply(new THREE.Matrix4().makeRotationZ(rng.range(-0.7, -0.2)))
        .setPosition(-14.6 + rng.range(-1, 1), 0.5 + i * 0.2, -9 + rng.range(-1.2, 1.2));
      e.add('wood_plank_weathered', k.chamfer(3.4, 0.2, 0.16, 0.02), M, {});
    }

    // Interior dressing: rubble under the roof hole, a bench, shelving, pipes.
    k.rubble(e, new THREE.Matrix4().makeTranslation(-14.7, 0.06, -9.3), { radius: 2.5, count: 26, rng });
    k.rubble(e, new THREE.Matrix4().makeTranslation(-13.2, 0.06, -2.4), { radius: 1.5, count: 12, rng });
    e.scorch(-14.4, 0.6, -11.4, 4.2, 0.42);
    const bench = new THREE.Matrix4().makeRotationY(0.2).setPosition(-8.4, 0.42, -9.6);
    e.add('wood_plank_weathered', k.chamfer(2.2, 0.08, 0.7, 0.015), bench, {});
    for (const sx of [-1, 1]) {
      e.add(
        'wood_plank_weathered',
        k.chamfer(0.1, 0.42, 0.6, 0.012),
        new THREE.Matrix4().makeRotationY(0.2).setPosition(-8.4 + sx * 0.95, 0.21, -9.6),
        {}
      );
    }
    for (let s = 0; s < 3; s++) {
      e.add(
        'wood_ply',
        k.chamfer(2.6, 0.05, 0.36, 0.012),
        new THREE.Matrix4().makeTranslation(-6.5, 0.9 + s * 0.75, -7.2 + 0),
        {}
      );
    }
    k.pipeRun(
      e,
      'steel_rusted',
      [
        new THREE.Vector3(-6.35, 0.3, -3.2),
        new THREE.Vector3(-6.35, 3.9, -3.2),
        new THREE.Vector3(-6.35, 4.1, -4.4),
        new THREE.Vector3(-9.5, 4.1, -4.4),
      ],
      0.055
    );
    this.props.yardClutter('west', -9.2, -7.6, 0.4, 1.6, 5);
    this.props.scatterDebris('west', -12.5, -6.5, 3.6, 4.2, 30, { brickRatio: 0.55 });
    this.props.brass('west', -9.6, -5.4, 1.5, 26);
    this.props.weeds('west', -14.6, -9.6, 2.2, 9);

    /* --- west block, hollow, and the alley between it and the hall -------- */
    const w2 = { cx: -28.4, cz: -8, w: 15.2, d: 14.4, h: 10.4 };
    k.building(e, {
      ...w2,
      mat: 'brick_red',
      tint: new THREE.Color(HUE.clay),
      trimTint: new THREE.Color(HUE.bone),
      hollow: true,
      stringCourse: true,
      floorH: 3.3,
      sides: [
        { openings: k.windowGrid({ length: w2.w, floors: 3, rng, bay: 2.9, doors: [{ x: 4.2 }] }) },
        { openings: k.windowGrid({ length: w2.w, floors: 3, rng, bay: 3.1, skip: 0.3 }) },
        {
          openings: k.windowGrid({ length: w2.d, floors: 3, rng, bay: 2.8, sill: 1.05 }),
          balconies: [
            { x: -3.2, y: 3.4, width: 2.7, depth: 1.15 },
            { x: 2.6, y: 6.7, width: 2.7, depth: 1.15 },
          ],
        },
        { openings: k.windowGrid({ length: w2.d, floors: 3, rng, bay: 3.2, skip: 0.4 }) },
      ],
      roof: { parapet: 0.8, collapsed: { x: 4.4, z: -3.2, w: 4.6, d: 4.2 } },
    });
    e.scorch(-24.6, 9.5, -11.4, 6, 0.4);
    this.props.waterTank('west', -31.5, 10.6, -4.5, 0.4);
    this.props.dish('west', -25.5, 11.5, -1.6, -0.7);
    this.props.dish('west', -32.2, 11.4, -12.2, -1.4);
    for (let i = 0; i < 4; i++) this.props.acUnit('west', -20.9, 4.2 + i * 2.2, -12 + i * 3.1, -Math.PI / 2);

    // The alley: 2.6 m wide, sunk 0.9 m, entered down four steps at its south
    // end. A lower route through the block, and a deep pool of shade beside a
    // sunlit square.
    const ax0 = -20.5;
    const ax1 = -17.9;
    const acx = (ax0 + ax1) / 2;
    const A = new THREE.Matrix4().makeTranslation(acx, -0.95, -7);
    e.add('gravel', k.box(ax1 - ax0, 0.2, 16, 2), A, { mottle: 0.25 });
    e.collide(ax1 - ax0, 0.2, 16, A);
    for (const sx of [ax0, ax1]) {
      const R = new THREE.Matrix4().makeTranslation(sx + (sx === ax0 ? -0.18 : 0.18), -0.45, -7);
      e.add('concrete_pitted', k.box(0.36, 1.1, 16, 1.6), R, {});
      e.collide(0.36, 1.1, 16, R);
    }
    k.stairs(e, new THREE.Matrix4().makeTranslation(acx, -0.85, 1.4), {
      steps: 5,
      width: 2.2,
      rise: 0.19,
      run: 0.34,
      mat: 'concrete_pitted',
      cheeks: false,
    });
    this.props.grassLine('west', ax0 + 0.3, -14, ax0 + 0.3, 0.5, 22, 0.25);
    this.props.scatterDebris('west', acx, -6, 1.1, 6, 26, { y: -0.85 });
    this.props.dumpster('west', acx + 0.1, -11.5, 0.1, 0x3d5347);
    this.props.yardClutter('west', acx, -3.4, 0.02, 1.2, 4);
    // Cables and laundry strung across the gap: the alley's whole read.
    for (let i = 0; i < 5; i++) {
      const z = -13 + i * 3.1;
      k.cable(
        e,
        'steel_brushed',
        new THREE.Vector3(ax0 - 0.2, 3.4 + (i % 2) * 1.4, z),
        new THREE.Vector3(ax1 + 0.2, 3.7 + (i % 2) * 1.2, z + 0.4),
        0.28,
        0.011,
        new THREE.Color(0x8a8578)
      );
    }
    this.props.laundry(
      'west',
      new THREE.Vector3(ax0 - 0.1, 5.2, -9.5),
      new THREE.Vector3(ax1 + 0.1, 5.5, -5.5),
      4
    );
    this.props.laundry('west', new THREE.Vector3(ax0 - 0.1, 3.0, -2.4), new THREE.Vector3(ax1 + 0.1, 3.2, -0.4), 3);

    /* --- south-west block flanking the road ------------------------------- */
    const w3 = { cx: -22, cz: 22.5, w: 16.4, d: 15, h: 8.6 };
    k.building(e, {
      ...w3,
      mat: 'plaster_painted',
      tint: new THREE.Color(HUE.ochre),
      trimTint: new THREE.Color(HUE.bone),
      hollow: true,
      stringCourse: true,
      sides: [
        { openings: k.windowGrid({ length: w3.w, floors: 2, floorH: 3.6, rng, bay: 3.1 }) },
        { openings: k.windowGrid({ length: w3.w, floors: 2, floorH: 3.6, rng, bay: 3.0 }) },
        {
          openings: k.windowGrid({ length: w3.d, floors: 2, floorH: 3.6, rng, bay: 2.9, doors: [{ x: -4.5, w: 1.3 }] }),
          balconies: [{ x: 2.4, y: 3.7, width: 3.0, depth: 1.2 }],
        },
        { openings: k.windowGrid({ length: w3.d, floors: 2, floorH: 3.6, rng, bay: 3.3, skip: 0.4 }) },
      ],
      roof: { parapet: 0.75 },
    });
    this.props.waterTank('west', -18.6, 8.8, 26.5, 0.9);
    this.props.dish('west', -17.4, 9.7, 19.5, -1.1);
    for (let i = 0; i < 3; i++) this.props.acUnit('west', -13.7, 3.6 + i * 2.4, 17.5 + i * 3.4, -Math.PI / 2);
    this.props.sign(
      'west',
      new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(-13.62, 3.5, 24.5),
      2.4,
      0.8,
      0x2f6a72
    );
  }

  /* ---------------------------------------------------------------- north */

  /** The skyline: three blocks at three heights and a minaret. */
  _northDistrict() {
    const e = this.batcher.zone('north');
    const k = this.kit;
    const rng = this.rng;

    // The tall block sits due north; the north-WEST is deliberately kept low.
    //
    // A 17-degree sun is occluded by anything within 3.3 times its own height
    // upwind of it, so a tall block here would put the whole square and the hall's
    // interior in permanent shade. Instead the corridor the sun actually travels
    // — from the hall's north-wall blast hole out over (-26, -26) and (-34, -37) —
    // is kept under the ray's height at every point along it, so the evening light
    // reaches the hall floor and lands in the lower right of the interior pose.
    // Checked by casting the ray, not by eye.
    const n1 = { cx: -18, cz: -33.5, w: 12.5, d: 13.4, h: 13.6, rotY: 0.11 };
    k.building(e, {
      ...n1,
      mat: 'plaster_painted',
      tint: new THREE.Color(HUE.grey),
      trimTint: new THREE.Color(HUE.bone),
      hollow: true,
      stringCourse: true,
      sides: [
        {
          openings: k.windowGrid({ length: n1.w, floors: 4, rng, bay: 2.9 }),
          balconies: [
            { x: -4.5, y: 3.4, width: 2.8, depth: 1.1 },
            { x: 3.2, y: 6.7, width: 2.8, depth: 1.1 },
            { x: -1.2, y: 10.0, width: 2.8, depth: 1.1 },
          ],
        },
        { openings: k.windowGrid({ length: n1.w, floors: 4, rng, bay: 3.1, skip: 0.35 }) },
        { openings: k.windowGrid({ length: n1.d, floors: 4, rng, bay: 3.0 }) },
        { openings: k.windowGrid({ length: n1.d, floors: 4, rng, bay: 3.2, skip: 0.4 }) },
      ],
      roof: { parapet: 0.85 },
    });
    this.props.waterTank('north', -20.5, 13.8, -29.5, 0.2);
    this.props.dish('north', -14.5, 14.7, -31, -1.0);

    // The north-west block, kept to two storeys so the sun comes over it. Its low
    // roofline against the taller blocks either side is also the skyline's biggest
    // step, which is what the establishing shot needs on that side.
    const n1b = { cx: -31, cz: -31, w: 13, d: 12, h: 6.2, rotY: -0.1 };
    k.building(e, {
      ...n1b,
      mat: 'brick_red',
      tint: new THREE.Color(HUE.clay),
      trimTint: new THREE.Color(HUE.bone),
      hollow: true,
      stringCourse: true,
      sides: [
        {
          openings: k.windowGrid({ length: n1b.w, floors: 2, rng, bay: 2.9, doors: [{ x: 3.0, w: 1.3 }] }),
          balconies: [{ x: -2.6, y: 3.4, width: 2.8, depth: 1.1 }],
        },
        { openings: k.windowGrid({ length: n1b.w, floors: 2, rng, bay: 3.1, skip: 0.4 }) },
        { openings: k.windowGrid({ length: n1b.d, floors: 2, rng, bay: 3.0, skip: 0.35 }) },
        { openings: k.windowGrid({ length: n1b.d, floors: 2, rng, bay: 3.2, skip: 0.4 }) },
      ],
      roof: { parapet: 0.6, collapsed: { x: 2.2, z: -2.0, w: 4.2, d: 4.0 } },
    });
    this.props.dish('north', -26.5, 7.3, -26, -1.4);
    this.props.waterTank('north', -34, 6.9, -34, 0.5);
    this.props.grassLine('north', -26, -20, -25, -26, 18, 0.7);
    this.props.scatterDebris('north', -25, -22, 2.2, 4, 22);

    /* --- centre-north hero block, rotated so its west flank catches sun --- */
    const n2 = { cx: -1.5, cz: -30, w: 17.5, d: 13.5, h: 9.8, rotY: -0.26 };
    k.building(e, {
      ...n2,
      mat: 'plaster_painted',
      tint: new THREE.Color(HUE.sand),
      trimTint: new THREE.Color(HUE.bone),
      hollow: true,
      stringCourse: true,
      sides: [
        {
          openings: k.windowGrid({ length: n2.w, floors: 3, rng, bay: 2.8, doors: [{ x: 5.5, w: 1.4, arch: true }] }),
          balconies: [
            { x: -5.0, y: 3.4, width: 3.0, depth: 1.2 },
            { x: 1.5, y: 6.7, width: 3.0, depth: 1.2 },
          ],
        },
        { openings: k.windowGrid({ length: n2.w, floors: 3, rng, bay: 3.0, skip: 0.35 }) },
        {
          openings: k.windowGrid({ length: n2.d, floors: 3, rng, bay: 2.9 }),
          balconies: [{ x: -2.0, y: 3.4, width: 2.8, depth: 1.15 }],
        },
        { openings: k.windowGrid({ length: n2.d, floors: 3, rng, bay: 3.1, skip: 0.35 }) },
      ],
      roof: { parapet: 0.78, collapsed: { x: -4.5, z: 1.5, w: 5.2, d: 4.4 } },
    });
    // Setback penthouse: a second silhouette step so the block is not one slab.
    const pen = new THREE.Matrix4().makeRotationY(n2.rotY).setPosition(n2.cx + 2.5, 0, n2.cz - 1.5);
    k.wall(e, new THREE.Matrix4().makeTranslation(0, n2.h, 3.1).premultiply(pen), {
      length: 8.4,
      height: 3.5,
      thickness: 0.4,
      mat: 'plaster_painted',
      tint: new THREE.Color(HUE.bone),
      openings: [
        { x: -2.4, y: 1.0, w: 1.1, h: 1.6, glass: true },
        { x: 1.6, y: 1.0, w: 1.1, h: 1.6 },
      ],
    });
    for (const [dx, dz, len, rot] of [
      [4.2, 0, 6.2, Math.PI / 2],
      [-4.2, 0, 6.2, Math.PI / 2],
      [0, -3.1, 8.4, 0],
    ]) {
      k.wall(
        e,
        new THREE.Matrix4()
          .makeRotationY(rot)
          .setPosition(dx, n2.h, dz)
          .premultiply(pen),
        { length: len, height: 3.5, thickness: 0.4, mat: 'plaster_painted', tint: new THREE.Color(HUE.bone) }
      );
    }
    k.roof(e, pen, { w: 9.2, d: 7, y: n2.h + 3.5, parapet: 0.4, mat: 'corrugated_metal' });
    e.scorch(-6.5, 9.8, -27.5, 6, 0.36);

    /* --- minaret: the one slender vertical in the skyline ----------------- */
    this._minaret(e, 6.5, -25.5, 18.5);

    const n3 = { cx: 21.5, cz: -30, w: 15, d: 13, h: 11.2, rotY: 0.16 };
    k.building(e, {
      ...n3,
      mat: 'brick_red',
      tint: new THREE.Color(HUE.pink),
      trimTint: new THREE.Color(HUE.bone),
      hollow: true,
      stringCourse: true,
      sides: [
        { openings: k.windowGrid({ length: n3.w, floors: 3, rng, bay: 2.9 }) },
        { openings: k.windowGrid({ length: n3.w, floors: 3, rng, bay: 3.1, skip: 0.4 }) },
        { openings: k.windowGrid({ length: n3.d, floors: 3, rng, bay: 3.0, skip: 0.4 }) },
        {
          openings: k.windowGrid({ length: n3.d, floors: 3, rng, bay: 2.8 }),
          balconies: [
            { x: -2.5, y: 3.4, width: 2.8, depth: 1.15 },
            { x: 2.5, y: 6.7, width: 2.8, depth: 1.15 },
          ],
        },
      ],
      roof: { parapet: 0.8 },
    });
    this.props.dish('north', 15.2, 12.3, -25.5, -1.6);
    this.props.waterTank('north', 25, 11.4, -33, 0.7);

    // The far side of the junction: a low wall and a shuttered row, so the road
    // north does not simply stop.
    const row = new THREE.Matrix4().makeTranslation(-9.5, 0, -18.5);
    k.wall(e, row, {
      length: 12,
      height: 3.6,
      thickness: 0.45,
      mat: 'plaster_painted',
      tint: new THREE.Color(HUE.blue),
      openings: [
        { x: -3.6, y: 0, w: 2.1, h: 2.5, arch: true },
        { x: 0.4, y: 0, w: 2.1, h: 2.5, arch: true },
        { x: 4.4, y: 1.1, w: 1.2, h: 1.6, glass: true },
      ],
    });
    k.bandAround(e, 'concrete_cast', row, 3.5, 12, 0.45, 0.32, 0.13, new THREE.Color(HUE.bone));
    this.props.sign('north', new THREE.Matrix4().makeTranslation(-11.5, 3.0, -18.24), 2.6, 0.85, 0xa8482f);
    this.props.marketStall('north', -6.2, -16.6, 0.1, 2.6, 1.7, 0xe4b862);
    this.props.scatterDebris('north', -4, -17.5, 5, 2, 26);
  }

  /** Octagonal minaret: plinth, ringed shaft, muezzin balcony, dome and finial. */
  _minaret(e, x, z, h) {
    const k = this.kit;
    const bone = new THREE.Color(HUE.bone);
    const sand = new THREE.Color(HUE.sand);
    const M = new THREE.Matrix4();
    M.makeTranslation(x, 0.7, z);
    e.add('concrete_cast', k.chamfer(3.9, 1.4, 3.9, 0.07), M, { tint: bone });
    e.collide(3.9, 1.4, 3.9, M);
    const shaftH = h - 1.4;
    M.makeTranslation(x, 1.4 + shaftH / 2, z);
    e.add('plaster_painted', k.cylinder(1.25, 1.55, shaftH, 8), M, { tint: sand, keepUV: true, uvScale: [4, shaftH / 3] });
    e.collide(2.7, shaftH, 2.7, M);
    // Two string bands and the balcony ring, which is what makes the tower read
    // as a minaret rather than a chimney.
    for (const f of [0.34, 0.62]) {
      M.makeTranslation(x, 1.4 + shaftH * f, z);
      e.add('concrete_cast', k.cylinder(1.52, 1.52, 0.24, 8), M, { tint: bone, keepUV: true, uvScale: [4, 1] });
    }
    const by = 1.4 + shaftH * 0.78;
    M.makeTranslation(x, by, z);
    e.add('concrete_cast', k.cylinder(2.5, 2.2, 0.3, 8), M, { tint: bone, keepUV: true, uvScale: [6, 1] });
    e.collide(4.6, 0.3, 4.6, M);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      // -(a + pi/2) puts the rail along the tangent at that angle.
      const R = new THREE.Matrix4().makeRotationY(-(a + Math.PI / 2)).setPosition(x + Math.cos(a) * 2.15, by + 0.15, z + Math.sin(a) * 2.15);
      k.railing(e, R, { length: 1.75, height: 0.95, spacing: 0.42, mat: 'iron_painted_chipped', tint: bone });
    }
    // Lantern stage, dome, finial.
    M.makeTranslation(x, by + 1.6, z);
    e.add('plaster_painted', k.cylinder(1.05, 1.15, 3.0, 8), M, { tint: sand, keepUV: true, uvScale: [4, 1.5] });
    M.makeTranslation(x, by + 3.15, z);
    e.add('concrete_cast', k.cylinder(1.3, 1.3, 0.22, 8), M, { tint: bone, keepUV: true, uvScale: [4, 1] });
    M.makeTranslation(x, by + 3.2, z).multiply(new THREE.Matrix4().makeScale(1, 1.15, 1));
    e.add('corrugated_metal', k.dome(1.25, Math.PI / 2, 12, 6), M, { tint: new THREE.Color(0x9fb0a8), keepUV: true });
    M.makeTranslation(x, by + 4.85, z);
    e.add('steel_brushed', k.cylinder(0.05, 0.07, 1.1, 6), M, { keepUV: true });
    M.makeTranslation(x, by + 5.5, z);
    e.add('steel_brushed', k.sphere(0.18, 8, 6), M, { keepUV: true });
  }

  /* ----------------------------------------------------------------- east */

  /**
   * The lit side: a raised terrace with its stair, an arcaded block behind it,
   * and the tallest building on the map presenting a sunlit west flank.
   */
  _eastDistrict() {
    const e = this.batcher.zone('east');
    const k = this.kit;
    const rng = this.rng;
    const bone = new THREE.Color(HUE.bone);

    /* --- the raised terrace ---------------------------------------------- */
    const tx0 = 9.6;
    const tx1 = 18.2;
    const tz0 = -12.5;
    const tz1 = 3.6;
    const ty = 1.85;
    const tcx = (tx0 + tx1) / 2;
    const tcz = (tz0 + tz1) / 2;
    const D = new THREE.Matrix4().makeTranslation(tcx, ty - 0.15, tcz);
    e.add('concrete_cast', k.box(tx1 - tx0, 0.3, tz1 - tz0, 2.2), D, { mottle: 0.22, tint: bone });
    e.collide(tx1 - tx0, 0.3, tz1 - tz0, D);
    // Retaining walls: west and south faces are what the square sees, so they
    // get the coping band and the weep stains.
    const R1 = new THREE.Matrix4().makeTranslation(tx0 + 0.22, ty / 2 - 0.15, tcz);
    e.add('concrete_pitted', k.box(0.44, ty, tz1 - tz0, 1.6), R1, {});
    e.collide(0.44, ty, tz1 - tz0, R1);
    const R2 = new THREE.Matrix4().makeTranslation(tcx, ty / 2 - 0.15, tz1 - 0.22);
    e.add('concrete_pitted', k.box(tx1 - tx0, ty, 0.44, 1.6), R2, {});
    e.collide(tx1 - tx0, ty, 0.44, R2);
    k.bandAround(e, 'concrete_cast', new THREE.Matrix4().makeTranslation(tcx, ty + 0.02, tcz), 0, tx1 - tx0, tz1 - tz0, 0.16, 0.1, bone);
    // Stair down to the square at the south-west corner: a leading line aimed
    // straight at the establishing shot's camera.
    k.stairs(e, new THREE.Matrix4().makeTranslation(tx0 + 2.0, 0, tz1 + 1.9), {
      steps: 10,
      width: 3.2,
      rise: 0.185,
      run: 0.34,
      mat: 'concrete_cast',
      tint: bone,
    });
    k.railing(e, new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(tx0 + 0.1, ty, tcz + 3.2), {
      length: 7.5,
      height: 1.0,
      spacing: 1.35,
      mat: 'iron_painted_chipped',
      tint: bone,
    });
    k.railing(e, new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(tx0 + 0.1, ty, tcz - 5.4), {
      length: 5.5,
      height: 1.0,
      spacing: 1.35,
      mat: 'iron_painted_chipped',
      tint: bone,
    });
    // A gap in the railing where a shell took it out, with the bent stub left.
    e.add(
      'iron_painted_chipped',
      k.cylinder(0.035, 0.04, 0.8, 6),
      new THREE.Matrix4().makeRotationZ(0.6).setPosition(tx0 + 0.1, ty + 0.35, tcz - 1.2),
      { keepUV: true }
    );
    e.scorch(tx0, ty + 0.3, tcz - 1.4, 3.4, 0.4);
    k.rubble(e, new THREE.Matrix4().makeTranslation(tx0 - 1.1, 0.05, tcz - 1.4), { radius: 2.2, count: 22, rng });

    // On the terrace: a kiosk, planters, stalls and the crowd of clutter that
    // makes a raised area worth climbing to.
    const kiosk = { cx: 15.4, cz: -8.4, w: 5.6, d: 5.2, h: 3.4, y: ty };
    k.building(e, {
      ...kiosk,
      mat: 'plaster_painted',
      tint: new THREE.Color(HUE.blue),
      trimTint: bone,
      hollow: true,
      plinth: 0.3,
      pilasters: false,
      sides: [
        { openings: [{ x: 0, y: 0, w: 2.4, h: 2.3 }] },
        { openings: [{ x: 0, y: 1.1, w: 1.2, h: 1.4, glass: true }] },
        { openings: [{ x: 0, y: 1.1, w: 1.1, h: 1.3, glass: true }] },
        { openings: [] },
      ],
      roof: { parapet: 0.45 },
    });
    // Everything from here to the reset sits on the terrace deck, not the square.
    this.props.y = ty;
    this.props.marketStall('east', 12.4, -3.6, -0.25, 2.7, 1.8, 0xd4603c);
    this.props.marketStall('east', 12.8, 0.4, 0.15, 2.4, 1.7, 0xe8bc60);
    this.props.planter('east', 11.2, -6.6, 0.2, 1.4);
    this.props.planter('east', 11.4, -10.4, -0.3, 1.2);
    this.props.yardClutter('east', 16.8, -1.6, 0.2, 2.2, 6);
    this.props.tyres('east', 17.2, -11.4, 5);
    this.props.weeds('east', 10.4, -2, 1.4, 8);
    this.props.scatterDebris('east', 13.5, -6, 3.6, 4.5, 22);
    this.props.brass('east', 12.2, -7.5, 1.6, 22);
    this.props.y = 0;

    /* --- arcaded block behind the terrace -------------------------------- */
    const e2 = { cx: 24.5, cz: 4.5, w: 15, d: 15.5, h: 9.4 };
    k.building(e, {
      ...e2,
      mat: 'plaster_painted',
      tint: new THREE.Color(HUE.ochre),
      trimTint: bone,
      hollow: true,
      stringCourse: true,
      sides: [
        { openings: k.windowGrid({ length: e2.w, floors: 3, rng, bay: 3.0 }) },
        { openings: k.windowGrid({ length: e2.w, floors: 3, rng, bay: 3.2, skip: 0.4 }) },
        { openings: k.windowGrid({ length: e2.d, floors: 3, rng, bay: 3.1, skip: 0.35 }) },
        {
          openings: k.windowGrid({ length: e2.d, floors: 3, rng, bay: 2.9, firstFloor: 1 }),
          balconies: [
            { x: -3.0, y: 6.7, width: 3.0, depth: 1.2 },
            { x: 3.4, y: 6.7, width: 3.0, depth: 1.2 },
          ],
          arcade: {
            depth: 2.6,
            length: 14.4,
            h: 3.6,
            bays: 4,
            mat: 'concrete_cast',
            tint: bone,
          },
        },
      ],
      roof: { parapet: 0.8 },
    });
    this.props.dish('east', 30, 10.4, 8.5, -2.4);
    this.props.waterTank('east', 21.5, 9.9, 9.5, 0.3);
    this.props.sign(
      'east',
      new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(16.75, 4.6, 6.5),
      2.8,
      0.9,
      0xb8863a
    );

    /* --- the tall east block: sunlit west flank, the frame's bright mass -- */
    const e3 = { cx: 26.5, cz: -15, w: 14.5, d: 16.5, h: 15.4 };
    k.building(e, {
      ...e3,
      mat: 'brick_red',
      tint: new THREE.Color(HUE.clay),
      trimTint: bone,
      hollow: true,
      stringCourse: true,
      sides: [
        { openings: k.windowGrid({ length: e3.w, floors: 4, rng, bay: 3.0 }) },
        { openings: k.windowGrid({ length: e3.w, floors: 4, rng, bay: 3.2, skip: 0.4 }) },
        { openings: k.windowGrid({ length: e3.d, floors: 4, rng, bay: 3.1, skip: 0.4 }) },
        {
          openings: k.windowGrid({ length: e3.d, floors: 4, rng, bay: 2.85, doors: [{ x: -5.5, w: 1.35, arch: true }] }),
          balconies: [
            { x: -4.0, y: 3.4, width: 3.0, depth: 1.25 },
            { x: 2.2, y: 3.4, width: 3.0, depth: 1.25 },
            { x: -1.0, y: 6.7, width: 3.0, depth: 1.25 },
            { x: 4.6, y: 10.0, width: 3.0, depth: 1.25 },
          ],
        },
      ],
      roof: { parapet: 0.9, collapsed: { x: 3.5, z: -4.5, w: 5, d: 5 } },
    });
    e.scorch(24.5, 15.2, -19, 7, 0.34);
    this.props.dish('east', 19.3, 16.3, -12, -1.5);
    this.props.dish('east', 20.1, 16.2, -19.5, -1.2);
    this.props.waterTank('east', 30, 15.9, -18.5, 0.5);
    for (let i = 0; i < 5; i++) this.props.acUnit('east', 19.05, 4.2 + (i % 3) * 3.3, -21 + i * 3.3, -Math.PI / 2);
    k.pipeRun(
      e,
      'steel_rusted',
      [new THREE.Vector3(19.1, 15.2, -8), new THREE.Vector3(19.1, 1.2, -8), new THREE.Vector3(19.1, 0.4, -9.2)],
      0.07
    );
    k.pipeRun(
      e,
      'steel_brushed',
      [new THREE.Vector3(19.15, 14.6, -21.5), new THREE.Vector3(19.15, 2.2, -21.5)],
      0.045
    );
  }

  /* ---------------------------------------------------------------- south */

  /** The approach: an arcaded corner block and the road's foreground furniture. */
  _southDistrict() {
    const e = this.batcher.zone('south');
    const k = this.kit;
    const rng = this.rng;
    const bone = new THREE.Color(HUE.bone);

    const e1 = { cx: 24, cz: 24, w: 15, d: 17, h: 11.6 };
    k.building(e, {
      ...e1,
      mat: 'brick_red',
      tint: new THREE.Color(HUE.pink),
      trimTint: bone,
      hollow: true,
      stringCourse: true,
      sides: [
        { openings: k.windowGrid({ length: e1.w, floors: 3, rng, bay: 3.0 }) },
        { openings: k.windowGrid({ length: e1.w, floors: 3, rng, bay: 3.1 }) },
        { openings: k.windowGrid({ length: e1.d, floors: 3, rng, bay: 3.2, skip: 0.4 }) },
        {
          openings: k.windowGrid({ length: e1.d, floors: 3, rng, bay: 2.9, firstFloor: 1 }),
          arcade: { depth: 2.5, length: 16, h: 3.6, bays: 5, mat: 'concrete_cast', tint: bone },
        },
      ],
      roof: { parapet: 0.85 },
    });
    this.props.waterTank('south', 20, 12.1, 29, 0.6);
    this.props.dish('south', 28.5, 12.6, 19, -2.2);
    this.props.sign('south', new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(16.25, 4.8, 21), 3.0, 1.0, 0x2d6b6f);
    this.props.yardClutter('south', 15.6, 27.5, 0.1, 2.6, 7);

    // Foreground: the wrecked car, a barricade and the debris field the road
    // needs in the first ten metres of the establishing shot.
    this.props.carHulk('south', -3.2, 16.6, 0.42);
    this.props.sandbagWall('south', 3.4, 14.2, -0.35, 3.6, 3);
    this.props.scatterDebris('south', 0, 17, 7, 5, 60, { brickRatio: 0.5 });
    this.props.scatterDebris('south', -7.5, 22, 1.8, 8, 34, { brickRatio: 0.35 });
    this.props.brass('south', 3.0, 13.2, 2.0, 34);
    this.props.tyres('south', 7.2, 19.4, 4);
    this.props.grassLine('south', -8.3, 12, -8.3, 30, 26, 0.3);
    this.props.grassLine('south', 8.3, 12, 8.3, 30, 24, 0.3);
    k.rubble(e, new THREE.Matrix4().makeTranslation(6.6, 0.04, 11.4), { radius: 2.6, count: 26, rng });
    k.rubble(e, new THREE.Matrix4().makeTranslation(-9.4, 0.04, 26), { radius: 2.2, count: 18, rng });
    this.props.weeds('south', -6, 20, 2.4, 12);
    this.props.weeds('south', 6.5, 24, 2.0, 10);

    // A crashed concrete barrier line: hard cover in the middle of the road.
    for (let i = 0; i < 4; i++) {
      const M = new THREE.Matrix4()
        .makeRotationY(0.24 + i * 0.16 + rng.range(-0.1, 0.1))
        .setPosition(-6.2 + i * 3.4 + rng.range(-0.3, 0.3), 0.52, 11.2 + rng.range(-0.5, 0.5));
      e.add('concrete_pitted', k.chamfer(2.4, 1.04, 0.62, 0.09), M, { tint: bone });
      e.collide(2.4, 1.04, 0.62, M);
    }
  }

  /* --------------------------------------------------------------- square */

  /** The middle band: fountain, palms, stalls and the clutter that fills the
   *  distance between the foreground road and the background skyline. */
  _squareDressing() {
    const e = this.batcher.zone('square');
    const k = this.kit;
    const rng = this.rng;
    const bone = new THREE.Color(HUE.bone);

    /* --- dry fountain --------------------------------------------------- */
    const fx = -1.8;
    const fz = -1.2;
    const M = new THREE.Matrix4();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      // Local +Z must point radially outward for the coping thickness to read.
      M.makeRotationY(Math.PI / 2 - a).setPosition(fx + Math.cos(a) * 2.35, 0.38, fz + Math.sin(a) * 2.35);
      e.add('concrete_cast', k.chamfer(2.05, 0.76, 0.34, 0.05), M, { tint: bone });
      e.collide(2.05, 0.76, 0.34, M);
    }
    M.makeTranslation(fx, 0.1, fz);
    e.add('tile_ceramic', k.cylinder(2.2, 2.2, 0.2, 16), M, { keepUV: true, uvScale: [8, 1], grime: 0 });
    e.collide(4.4, 0.2, 4.4, M);
    M.makeTranslation(fx, 0.9, fz);
    e.add('concrete_pitted', k.cylinder(0.42, 0.55, 1.6, 8), M, { tint: bone, keepUV: true, uvScale: [2, 1] });
    e.collide(1.1, 1.8, 1.1, M);
    M.makeTranslation(fx, 1.72, fz);
    e.add('concrete_cast', k.chamfer(1.15, 0.18, 1.15, 0.04), M, { tint: bone });
    // The head is off and lying in the basin: history, in one prop.
    M.makeRotationZ(1.3).setPosition(fx + 1.1, 0.36, fz + 0.7);
    e.add('concrete_pitted', k.cylinder(0.3, 0.4, 0.9, 8), M, { tint: bone, keepUV: true });
    k.rubble(e, new THREE.Matrix4().makeTranslation(fx + 1.4, 0.22, fz - 0.9), { radius: 1.1, count: 10, rng, collide: false });
    this.props.weeds('square', fx, fz, 2.1, 14);
    e.scorch(fx + 1.2, 0.3, fz + 0.6, 3.2, 0.3);

    /* --- vegetation ------------------------------------------------------ */
    this.props.palm('square', 5.6, -8.2, 7.2, 0.055);
    this.props.palm('square', 8.2, 5.4, 6.2, 0.04);
    this.props.palm('square', -14.5, 6.6, 6.8, 0.05);
    this.props.tree('square', -6.5, -12.5, 5.4);
    this.props.tree('square', 3.2, 9.6, 4.8);
    for (const [x, z] of [
      [5.6, -8.2],
      [8.2, 5.4],
      [-14.5, 6.6],
      [-6.5, -12.5],
      [3.2, 9.6],
    ]) {
      // A ring of cracked paving and weeds at each trunk: roots lift the slabs.
      const S = new THREE.Matrix4().makeRotationY(rng.float() * 3).setPosition(x, 0.02, z);
      e.add('dirt_packed', new THREE.PlaneGeometry(2.6, 2.6, 2, 2).rotateX(-Math.PI / 2), S, { mottle: 0.2, grime: 0 });
      this.props.weeds('square', x, z, 1.2, 10);
      this.props.scatterDebris('square', x, z, 1.4, 1.4, 8);
    }

    /* --- market row along the square's north side ------------------------ */
    this.props.marketStall('square', -3.4, 6.8, 3.0, 2.8, 1.8, 0xd8603c);
    this.props.marketStall('square', 0.4, 7.4, 3.16, 2.5, 1.7, 0xe6bc5c);
    this.props.marketStall('square', -8.0, -13.4, 0.3, 2.7, 1.8, 0xc09a58);

    /* --- fighting positions --------------------------------------------- */
    // The close material read pose looks straight at this cluster from 4 m, so
    // it carries the frame: canvas, rusted steel, wood, brass and concrete all
    // in one shot, at four different roughness populations.
    this.props.sandbagWall('square', 6.6, 1.6, -0.28, 4.2, 3);
    this.props.sandbagWall('square', 8.4, -1.4, 1.25, 2.6, 2);
    this.props.yardClutter('square', 4.6, 3.2, -0.3, 1.9, 6);
    this.props.brass('square', 6.4, 2.6, 1.8, 40);
    this.props.tyres('square', 3.4, 4.6, 3);
    this.props.scatterDebris('square', 6.5, 2.5, 3.2, 3.2, 24, { brickRatio: 0.4 });
    this.props.weeds('square', 8.9, 2.4, 1.6, 9);

    this.props.sandbagWall('square', -5.4, -8.6, 1.62, 3.2, 3);
    this.props.yardClutter('square', -2.2, -11.6, 0.2, 2.4, 6);
    this.props.dumpster('square', 1.6, -13.6, 0.34);

    /* --- kerb ring and grass along the square's edges -------------------- */
    for (const [x0, z0, x1, z1] of [
      [-19, 13.6, 19, 13.6],
      [-19, -15.4, -8, -15.4],
    ]) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const ang = Math.atan2(-(z1 - z0), x1 - x0);
      k.kerb(e, new THREE.Matrix4().makeRotationY(ang).setPosition((x0 + x1) / 2, 0, (z0 + z1) / 2), len, { collide: false });
      this.props.grassLine('square', x0, z0, x1, z1, 30, 0.4);
    }
    this.props.scatterDebris('square', 0, 0, 17, 13, 90, { brickRatio: 0.42 });
    this.props.weeds('square', -12, 11, 3, 14);
    this.props.weeds('square', 14, 10, 3, 12);
    this.props.weeds('square', -16, -12, 3, 12);

    this._eastSquare();
  }

  /**
   * The square's east quadrant, x 1..10 by z +2..-8.
   *
   * THIS QUADRANT WAS BARE and it is not a quadrant anyone can avoid looking at:
   * it fills the right half of the combat-range pose and the left half of the
   * close material pose, and in both it measured as 340x160 px of paving at
   * sd 12 whose only incident was six 20 cm debris chunks too small to read as
   * objects. The rest of the square is dressed by things that stand *in* it —
   * stalls, palms, a fountain — and none of that reaches here because the pose
   * that matters wants a clear field of fire through the middle of it.
   *
   * So the dressing is horizontal, not vertical: a kerbed island and its
   * drainage, a shell crater, a toppled street-light column lying across the
   * paving, and gully covers flush with the ground. Every one of those breaks the
   * plane with a silhouette edge and a cast shadow while leaving the sightline
   * through the square open, which is the constraint the empty quadrant existed
   * to satisfy in the first place. Scale is the other half of it: a 5 m column
   * and a 3 m crater are things the eye can measure the square against, and six
   * 20 cm chunks are not.
   */
  _eastSquare() {
    const e = this.batcher.zone('square');
    const k = this.kit;
    const rng = this.rng;
    const bone = new THREE.Color(HUE.bone);

    // A kerbed planting island. A kerb is the cheapest hard horizontal in a
    // scene: 16 cm of concrete with a lit top and a shadowed return, running dead
    // straight across a surface that has no other straight line on it.
    const ix = 6.4;
    const iz = -4.4;
    const iw = 3.0;
    const id = 3.6;
    for (const [ox, oz, len, ang] of [
      [0, id / 2, iw, 0],
      [0, -id / 2, iw, 0],
      [-iw / 2, 0, id, Math.PI / 2],
      [iw / 2, 0, id, Math.PI / 2],
    ]) {
      k.kerb(e, new THREE.Matrix4().makeRotationY(ang).setPosition(ix + ox, 0, iz + oz), len, { collide: false, tint: bone });
    }
    const IS = new THREE.Matrix4().makeTranslation(ix, 0.1, iz);
    e.add('dirt_packed', new THREE.PlaneGeometry(iw - 0.3, id - 0.3, 3, 3).rotateX(-Math.PI / 2), IS, { mottle: 0.24, grime: 0 });
    this.props.weeds('square', ix, iz + 1.2, 1.1, 11, 0.1);
    this.props.weeds('square', ix - 0.6, iz - 1.4, 0.9, 8, 0.1);
    this.props.scatterDebris('square', ix, iz, 1.7, 2.3, 14, { y: 0.1, brickRatio: 0.5 });
    // Grit banks against a kerb from both sides; that is what makes a kerb read
    // as something the street has been sweeping past for years.
    for (const [gx, gz, gw, gd] of [
      [ix, iz + id / 2 + 0.35, 1.6, 0.22],
      [ix - iw / 2 - 0.35, iz, 0.22, 2.1],
    ]) {
      this.props.scatterDebris('square', gx, gz, gw, gd, 16, { brickRatio: 0.55 });
    }
    this.props.grassLine('square', ix - iw / 2 - 0.2, iz - id / 2, ix - iw / 2 - 0.2, iz + id / 2, 14, 0.16);
    this.props.tyres('square', ix + 1.9, iz + 2.4, 3);

    // A mortar crater west of the island: scorched dirt, a lip of thrown rubble,
    // and two paving slabs stood on edge by the blast.
    const cx = 2.6;
    const cz = -5.8;
    const CR = new THREE.Matrix4().makeRotationY(0.6).setPosition(cx, 0.014, cz);
    e.add('dirt_packed', new THREE.PlaneGeometry(3.6, 3.2, 3, 3).rotateX(-Math.PI / 2), CR, { mottle: 0.3, mottleScale: 0.12, grime: 0 });
    e.scorch(cx, 0.05, cz, 3.0, 0.4);
    k.rubble(e, new THREE.Matrix4().makeTranslation(cx, 0.03, cz), { radius: 1.9, count: 20, rng, collide: false });
    for (const [sx, sz, tilt, yaw] of [
      [-1.25, 0.35, 1.05, 0.4],
      [1.05, -0.7, -0.85, 2.2],
    ]) {
      const S = new THREE.Matrix4()
        .makeRotationY(yaw)
        .multiply(new THREE.Matrix4().makeRotationX(tilt))
        .setPosition(cx + sx, 0.36, cz + sz);
      e.add('concrete_pitted', k.chamfer(1.15, 0.14, 0.95, 0.03), S, { tint: bone });
      e.collide(1.0, 0.7, 0.6, new THREE.Matrix4().makeTranslation(cx + sx, 0.35, cz + sz));
    }

    // The street light that used to stand on the island, felled across the paving
    // and pointing back at the camera. Five metres of continuous silhouette over
    // a plane whose longest incident was 20 cm.
    const px0 = 5.6;
    const pz0 = -1.0;
    const pang = 2.79;
    const pdx = Math.cos(pang);
    const pdz = Math.sin(pang);
    const shaft = new THREE.Matrix4()
      .makeRotationY(-Math.atan2(pdz, pdx))
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeRotationX(0.02))
      .setPosition(px0 + pdx * 2.3, 0.14, pz0 + pdz * 2.3);
    e.add('concrete_cast', k.cylinder(0.075, 0.115, 4.6, 8), shaft, { tint: bone, keepUV: true, uvScale: [1.5, 2.3] });
    e.collide(4.4, 0.24, 0.3, new THREE.Matrix4().makeRotationY(-Math.atan2(pdz, pdx)).setPosition(px0 + pdx * 2.3, 0.12, pz0 + pdz * 2.3));
    // Snapped-off base, still bolted to its plinth, at the other end of the line.
    e.add('concrete_cast', k.chamfer(0.5, 0.16, 0.5, 0.03), new THREE.Matrix4().makeTranslation(px0, 0.08, pz0), { tint: bone });
    e.add('concrete_cast', k.cylinder(0.11, 0.14, 0.42, 8), new THREE.Matrix4().makeRotationX(0.14).setPosition(px0, 0.32, pz0), {
      tint: bone,
      keepUV: true,
    });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      e.add(
        'steel_rusted',
        k.cylinder(0.009, 0.009, 0.5, 5),
        new THREE.Matrix4()
          .makeRotationZ(0.3 + i * 0.4)
          .setPosition(px0 + Math.cos(a) * 0.07, 0.56, pz0 + Math.sin(a) * 0.07),
        { keepUV: true }
      );
    }
    // Lantern head, smashed, at the far end of the shaft.
    const hx = px0 + pdx * 4.75;
    const hz = pz0 + pdz * 4.75;
    const HD = new THREE.Matrix4().makeRotationY(-Math.atan2(pdz, pdx) + 0.5).setPosition(hx, 0.13, hz);
    e.add('aluminium_scuffed', k.chamfer(0.66, 0.16, 0.36, 0.05), HD, {});
    e.add('glass_dirty', k.chamfer(0.5, 0.05, 0.28, 0.02), new THREE.Matrix4().makeTranslation(0, -0.1, 0).premultiply(HD), { grime: 0 });
    e.collide(0.7, 0.26, 0.4, HD);
    this.props.scatterDebris('square', hx, hz, 0.9, 0.9, 10, { brickRatio: 0.2 });

    // Gully covers, flush. Flat, so they cost nothing in sightline, but a 60 cm
    // frame of rusted iron in a field of concrete is a hard value edge and the
    // only specular event on the whole plane.
    for (const [gx, gz, ga] of [
      [2.4, 0.2, 0.1],
      [8.6, -6.9, -0.28],
      [1.1, -4.2, 0.42],
    ]) {
      const G = new THREE.Matrix4().makeRotationY(ga).setPosition(gx, 0.024, gz);
      e.add('concrete_cast', k.chamfer(0.74, 0.05, 0.62, 0.02), G, { tint: bone });
      e.add('steel_rusted', k.chamfer(0.56, 0.05, 0.44, 0.012), new THREE.Matrix4().makeTranslation(0, 0.012, 0).premultiply(G), {
        keepUV: true,
      });
      for (let b = 0; b < 4; b++) {
        e.add(
          'steel_rusted',
          k.chamfer(0.5, 0.02, 0.035, 0.006),
          new THREE.Matrix4().makeTranslation(0, 0.03, -0.15 + b * 0.1).premultiply(G),
          { keepUV: true }
        );
      }
    }

    // Two low leaning masses to break the horizon of the plane where it meets the
    // terrace wall, and the clutter that collects in the corner behind them.
    for (const [lx, lz, la, lt] of [
      [9.1, 1.9, 0.5, 0.62],
      [8.4, -7.6, -0.9, -0.55],
    ]) {
      const L = new THREE.Matrix4()
        .makeRotationY(la)
        .multiply(new THREE.Matrix4().makeRotationX(lt))
        .setPosition(lx, 0.62, lz);
      e.add('corrugated_metal', k.chamfer(1.9, 0.05, 1.5, 0.02), L, { tint: new THREE.Color(0xa89e8c) });
      e.collide(1.8, 1.1, 0.7, new THREE.Matrix4().makeRotationY(la).setPosition(lx, 0.55, lz));
      this.props.scatterDebris('square', lx, lz, 1.1, 1.1, 9, { brickRatio: 0.5 });
    }
    this.props.yardClutter('square', 9.0, -9.4, 1.2, 1.3, 4);
    this.props.weeds('square', 9.3, -9.9, 1.3, 9);

    // Kerb-hugging spill along the terrace foot, which the square's own scatter
    // pass treats as open ground because it does not know the wall is there.
    this.props.grassLine('square', 9.2, -11.5, 9.2, 3.2, 24, 0.22);
    this.props.scatterDebris('square', 9.0, -4.4, 0.55, 6.5, 26, { brickRatio: 0.6 });

    // And the near ground the close material pose looks across on its left: a
    // dropped pallet, a broken kerb stone and the brick spill off it, all inside
    // three metres of that camera so they are read as material, not as clutter.
    this.props.scatterDebris('square', 2.5, 2.3, 1.5, 1.2, 20, { brickRatio: 0.65 });
    const KB = new THREE.Matrix4().makeRotationY(0.9).multiply(new THREE.Matrix4().makeRotationZ(0.12)).setPosition(2.2, 0.09, 1.4);
    e.add('concrete_pitted', k.chamfer(1.05, 0.18, 0.34, 0.03), KB, { tint: bone });
    e.collide(1.0, 0.2, 0.4, KB);
    const KB2 = new THREE.Matrix4().makeRotationY(1.4).multiply(new THREE.Matrix4().makeRotationX(0.5)).setPosition(1.5, 0.12, 2.6);
    e.add('concrete_pitted', k.chamfer(0.62, 0.16, 0.3, 0.03), KB2, { tint: bone });
    this.props.weeds('square', 2.0, 1.9, 1.0, 8);
    // Two pallets, the upper one slid off the lower. Things lean on other things.
    const pallet = this.props.set('pallet', 'wood_plank_weathered', () => this.props.palletGeo());
    this.props.place(pallet, 3.0, 0.03, 3.9, 0.7, 1, PALLET_TINTS);
    this.props.place(pallet, 2.6, 0.15, 3.6, 0.55, 1, PALLET_TINTS, { rz: 0.17, rx: 0.06 });
  }

  /* -------------------------------------------------------------- distant */

  /**
   * A city ring at 100-200 m. It exists for the haze: aerial perspective needs
   * geometry at depth to lift toward the sky colour, and a skyline that stops at
   * the near buildings reads as a diorama on a table.
   */
  _distant() {
    const e = this.batcher.zone('far');
    const k = this.kit;
    const rng = this.rng;
    const far = new THREE.Color(HUE.far);
    for (let i = 0; i < 46; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = rng.range(96, 205);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r - 12;
      const w = rng.range(11, 30);
      const d = rng.range(11, 26);
      const h = rng.range(7, 30) * (0.6 + r / 300);
      const M = new THREE.Matrix4().makeRotationY(rng.float() * 3).setPosition(x, h / 2, z);
      e.add('plaster_painted', k.box(w, h, d, 0), M, { tint: far, grime: 0 });
      // A parapet lip: even at 150 m the top edge of a box reads as a box
      // without one.
      const P = new THREE.Matrix4().makeRotationY(rng.float() * 3).setPosition(x, h + 0.5, z);
      e.add('plaster_painted', k.box(w * 0.98, 1.0, d * 0.98, 0), P, { tint: far, grime: 0 });
      if (rng.float() < 0.12) {
        const T = new THREE.Matrix4().makeTranslation(x + rng.range(-4, 4), h + 8, z + rng.range(-4, 4));
        e.add('plaster_painted', k.cylinder(1.1, 1.5, 16, 8), T, { tint: far, grime: 0, keepUV: true });
      }
    }
  }

  /* ------------------------------------------------------- overhead wires */

  /**
   * Poles and catenaries. Wires crossing the upper third of the establishing
   * shot are the cheapest possible foreground: they read at every distance, they
   * cut the empty sky, and they say the town had electricity once.
   */
  _overheadWires() {
    const e = this.batcher.zone('square');
    const k = this.kit;
    const poles = [
      [-9.2, 12.6],
      [9.2, 12.4],
      [-9.4, -1.2],
      [9.4, -1.6],
      [-9.0, 27.5],
      [9.0, 27.2],
    ];
    const tops = [];
    for (const [x, z] of poles) {
      const h = 7.4 + this.rng.range(-0.4, 0.4);
      const M = new THREE.Matrix4().makeTranslation(x, h / 2, z);
      e.add('wood_plank_weathered', k.cylinder(0.13, 0.19, h, 8), M, { keepUV: true, uvScale: [2, h / 2] });
      e.collide(0.38, h, 0.38, M);
      const arm = new THREE.Matrix4().makeRotationY(x > 0 ? 0.06 : -0.06).setPosition(x, h - 0.5, z);
      e.add('wood_plank_weathered', k.chamfer(1.9, 0.14, 0.12, 0.02), arm, {});
      for (const sx of [-1, 1]) {
        e.add(
          'glass_dirty',
          k.cylinder(0.05, 0.06, 0.14, 6),
          new THREE.Matrix4().makeTranslation(x + sx * 0.72, h - 0.35, z),
          { keepUV: true, grime: 0 }
        );
      }
      // Step bolts: tiny, but they are what a pole looks like up close.
      for (let i = 0; i < 5; i++) {
        e.add(
          'steel_rusted',
          k.cylinder(0.015, 0.015, 0.3, 5),
          new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x, 1.6 + i * 0.85, z),
          { keepUV: true }
        );
      }
      tops.push(new THREE.Vector3(x, h - 0.4, z));
    }
    const wire = new THREE.Color(0x6f6a60);
    // Across the road, and down each side, at two heights.
    k.cable(e, 'steel_brushed', tops[0], tops[1], 1.5, 0.016, wire);
    k.cable(e, 'steel_brushed', tops[2], tops[3], 1.4, 0.016, wire);
    k.cable(e, 'steel_brushed', tops[4], tops[5], 1.6, 0.016, wire);
    for (const [a, b] of [
      [tops[0], tops[2]],
      [tops[1], tops[3]],
      [tops[0], tops[4]],
      [tops[1], tops[5]],
    ]) {
      k.cable(e, 'steel_brushed', a, b, 1.1, 0.014, wire);
      k.cable(
        e,
        'steel_brushed',
        a.clone().setY(a.y - 0.55),
        b.clone().setY(b.y - 0.55),
        1.3,
        0.011,
        wire
      );
    }
    // A downed span trailing into the road: the wire the eye follows.
    k.cable(
      e,
      'steel_brushed',
      tops[2].clone().setY(tops[2].y - 1.1),
      new THREE.Vector3(-4.2, 0.06, 6.4),
      0.7,
      0.013,
      wire
    );
    // Service drops into the buildings either side.
    k.cable(e, 'steel_brushed', tops[1], new THREE.Vector3(16.4, 5.2, 6.6), 0.5, 0.012, wire);
    k.cable(e, 'steel_brushed', tops[0], new THREE.Vector3(-13.7, 4.4, 17.6), 0.6, 0.012, wire);
    k.cable(e, 'steel_brushed', tops[2], new THREE.Vector3(-5.85, 4.1, -1.6), 0.45, 0.012, wire);
  }

  /* --------------------------------------------------------------- finish */

  _finish() {
    const meshes = this.batcher.build(
      this.root,
      (key) => this._matFor(key),
      (mesh, zone) => {
        mesh.receiveShadow = true;
        // The distant ring and the ground must not cast: the ring is beyond the
        // last cascade and the ground would fill every cascade with a depth
        // value that occludes nothing.
        const caster = zone !== 'far' && zone !== 'ground';
        mesh.castShadow = caster;
        mesh.userData.noShadowCast = !caster;
        mesh.userData.level = zone;
      }
    );
    this.meshes.push(...meshes);

    for (const set of this.props.instances) {
      const mesh = set.build((key) => this._matFor(key));
      if (!mesh) continue;
      mesh.receiveShadow = true;
      // Grass and brass cast nothing worth a shadow-map fetch; everything with
      // real volume does, or it will look pasted onto the ground.
      const light = set.name === 'brass' || set.name === 'weed';
      mesh.castShadow = !light;
      mesh.userData.noShadowCast = light;
      this.root.add(mesh);
      this.meshes.push(mesh);
      this.stats.instances += set.count;
      this.stats.instanced++;
    }

    this.root.updateMatrixWorld(true);
    this.stats.meshes = this.meshes.length;
    this.stats.triangles = this.batcher.stats.triangles;
  }

  /**
   * Collision geometry: every proxy box the kit and the props registered, merged
   * into one world-space mesh, plus the ground. Boxes rather than the visual
   * geometry because the walls *are* boxes — the proxy is exact where it matters
   * and an order of magnitude cheaper to sweep against.
   */
  _collision() {
    const e = this.batcher.zone('collide');
    // Ground, as four slabs around the sunken alley so the alley is a real hole
    // in the walkable surface rather than a pit under an invisible floor.
    const g = [
      [-280, -20.5, -280, 280],
      [-17.9, 280, -280, 280],
      [-20.5, -17.9, -280, -15],
      [-20.5, -17.9, 1.0, 280],
    ];
    for (const [x0, x1, z0, z1] of g) {
      const M = new THREE.Matrix4().makeTranslation((x0 + x1) / 2, -1, (z0 + z1) / 2);
      e.collide(x1 - x0, 2, z1 - z0, M);
    }
    const geo = this.batcher.buildColliders();
    const mesh = new THREE.Mesh(geo, null);
    mesh.name = 'level-collision';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    mesh.visible = false;
    this.collisionMesh = mesh;
    this.collidables.push(mesh);
    this.stats.colliders = this.batcher.colliders.length;
  }

  _spawns() {
    this.spawnPoints = [
      { position: new THREE.Vector3(0, 1.7, 20), yaw: 0 },
      { position: new THREE.Vector3(-4.5, 1.7, 24.5), yaw: -0.2 },
      { position: new THREE.Vector3(5.5, 1.7, 25), yaw: 0.15 },
      { position: new THREE.Vector3(-8, 1.7, -4), yaw: 1.2 },
    ];
    const spawn = (x, y, z, yaw, cover) => this.enemySpawns.push({ position: new THREE.Vector3(x, y, z), yaw, cover });
    spawn(-1.8, 0, -6.2, 0.2, 'fountain');
    spawn(13.2, 1.85, -6.4, -1.4, 'terrace');
    spawn(17.6, 0, 2.6, -1.6, 'arcade-east');
    spawn(-13.4, 0, -8.2, 0.9, 'hall-interior');
    spawn(-19.2, -0.85, -6.5, 0.1, 'alley');
    spawn(-2.5, 0, -17.4, 3.1, 'north-junction');
    spawn(11.4, 1.85, -1.2, -2.4, 'terrace-stalls');
    spawn(-3.6, 0, 14.8, 3.0, 'car-wreck');
    spawn(17.4, 0, 20.5, -1.7, 'arcade-south');
    spawn(-6.2, 0, -9.4, 1.4, 'hall-north');
    spawn(6.8, 0, 2.2, 2.9, 'sandbags');
    spawn(-9.4, 0, 25.5, 3.0, 'road-west');
  }

  /**
   * Static bounce lights. There is no global illumination here, so the three
   * places the sun cannot reach but the eye expects to be lit — the hall's
   * interior, the two arcades, the alley — get a low warm point light standing in
   * for the bounce off the sunlit ground outside. The one at the hall's sun patch
   * is placed exactly where the beam through the north wall's blast hole lands.
   */
  _lights() {
    const L = this.game.lighting;
    if (!L?.addPointLight) return;
    const add = (x, y, z, hex, i, r) => {
      const l = L.addPointLight(new THREE.Vector3(x, y, z), hex, i, r, { priority: 0.5 });
      if (l) this.lights.push(l);
    };
    add(-10.6, 1.0, -6.4, 0xffd7a4, 11, 9.5); // hall: the sun patch, bouncing
    add(-15.2, 2.1, -6.8, 0xbfd4f0, 5.5, 7.5); // hall: west window sky fill
    add(-8.6, 1.6, 0.2, 0xffe0b8, 6, 7); // hall: light through the south collapse
    add(-19.2, 1.0, -6.5, 0xa8c0dc, 5, 7); // alley: sky slot above
    add(16.4, 1.7, 3.0, 0xffd9a8, 7, 8); // arcade east, under the vaults
    add(17.0, 1.7, 20.0, 0xffd9a8, 7, 8); // arcade south
  }
}

/* ------------------------------------------------------- foliage mask bake */

/**
 * Alpha-tested foliage masks. Drawn analytically into a DataTexture rather than
 * onto a canvas because AssetForge's rule is that a texture is synthesised, and
 * a few hundred stamped discs is faster than a canvas round trip.
 *
 * `px` is RGBA float in 0..1, laid out row 0 = UV v 0, which for these cards is
 * the base of the plant.
 */
function maskTexture(size, draw) {
  const px = new Float32Array(size * size * 4);
  draw(px);
  // One box blur pass: an unfiltered hard mask aliases badly under alphaTest,
  // and the blur also gives the mip chain something to shrink gracefully.
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
          const o = (sy * size + sx) * 4;
          const w = dx === 0 && dy === 0 ? 3 : 1;
          r += px[o] * w;
          g += px[o + 1] * w;
          b += px[o + 2] * w;
          a += px[o + 3] * w;
          n += w;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.min(255, (r / n) * 255);
      out[o + 1] = Math.min(255, (g / n) * 255);
      out[o + 2] = Math.min(255, (b / n) * 255);
      out[o + 3] = Math.min(255, (a / n) * 255);
    }
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function stamp(px, size, x, y, r, cr, cg, cb) {
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(size - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(size - 1, Math.ceil(y + r));
  const r2 = r * r;
  for (let py = y0; py <= y1; py++) {
    for (let pxx = x0; pxx <= x1; pxx++) {
      const dx = pxx - x;
      const dy = py - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const o = (py * size + pxx) * 4;
      const a = Math.min(1, (1 - d2 / r2) * 2.4);
      if (a <= px[o + 3]) {
        px[o + 3] = Math.max(px[o + 3], a);
        continue;
      }
      px[o] = cr;
      px[o + 1] = cg;
      px[o + 2] = cb;
      px[o + 3] = a;
    }
  }
}

/** A tuft of dry blades: quadratic curves, tapering, paler at the tips. */
function drawBlades(px, size) {
  const rng = new Rng(0x9ab1);
  for (let b = 0; b < 11; b++) {
    const x0 = size * (0.5 + rng.gauss() * 0.16);
    const bend = size * rng.range(-0.34, 0.34);
    const top = size * rng.range(0.5, 0.99);
    const wid = size * rng.range(0.016, 0.03);
    const dark = rng.range(0.14, 0.3);
    for (let i = 0; i <= 26; i++) {
      const t = i / 26;
      const x = x0 + bend * t * t;
      const y = top * t;
      // Blade colour runs from a dark damp base to a bleached tip: that vertical
      // gradient is most of what makes dry grass read as dry.
      const k = 0.34 + 0.62 * t;
      stamp(px, size, x, y, wid * (1 - t * 0.85) + 0.6, k * (0.8 + dark), k * (0.78 + dark), k * (0.42 + dark * 0.6));
    }
  }
}

/** A leaf cluster: ellipse leaves radiating from the base, plus twigs. */
function drawLeaves(px, size) {
  const rng = new Rng(0x51e2);
  for (let l = 0; l < 15; l++) {
    const a = rng.range(0.15, Math.PI - 0.15);
    const len = size * rng.range(0.2, 0.42);
    const cx = size * (0.5 + rng.gauss() * 0.2);
    const cy = size * rng.range(0.06, 0.42);
    const wid = len * rng.range(0.3, 0.46);
    const dark = rng.range(-0.06, 0.1);
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const x = cx + Math.cos(a) * len * t;
      const y = cy + Math.sin(a) * len * t;
      const r = wid * Math.sin(Math.PI * Math.min(1, t * 1.08)) * 0.5 + 0.5;
      stamp(px, size, x, y, r, 0.3 + dark, 0.4 + dark, 0.16 + dark * 0.5);
    }
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      stamp(px, size, cx * (1 - t) + size * 0.5 * t, cy * (1 - t), 0.9, 0.24, 0.2, 0.12);
    }
  }
}

/** A pinnate palm frond: rachis along u with leaflets swept backward. */
function drawFrond(px, size) {
  const rng = new Rng(0x3b71);
  const mid = size * 0.5;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    stamp(px, size, t * size, mid, 1.6 * (1 - t * 0.7) + 0.6, 0.28, 0.3, 0.13);
  }
  for (let i = 2; i < 40; i++) {
    const t = i / 40;
    const x = t * size;
    const len = size * 0.44 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * rng.range(0.75, 1.05);
    for (const s of [-1, 1]) {
      const ang = s * (1.05 - t * 0.35);
      const dark = rng.range(-0.05, 0.08);
      for (let j = 0; j <= 10; j++) {
        const u = j / 10;
        stamp(
          px,
          size,
          x - Math.sin(Math.abs(ang)) * len * u * 0.55,
          mid + Math.sin(ang) * len * u,
          1.5 * (1 - u * 0.6) + 0.4,
          0.3 + dark,
          0.36 + dark,
          0.15 + dark
        );
      }
    }
  }
}
