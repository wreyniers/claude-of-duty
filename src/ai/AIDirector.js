import * as THREE from 'three';
import { Rng } from '../render/Noise.js';

/**
 * Enemy spawning, squad coordination, navigation, combat behaviour, deaths.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * Nothing here existed before this round: `spawnWave` had an empty body and
 * `enemies` was always `[]`, which meant the `silhouette` capture pose — the one
 * that exists solely to grade enemy readability at combat range, and whose setup
 * is literally `window.GAME.ai.spawnWave(4)` — had never once had a character in
 * it. Composition was being graded on a frame missing the subjects it was framed
 * for, and the head/torso/limb multipliers in Ballistics had nothing to hit.
 *
 * THE RIG IS A FORGE ASSET, NOT GEOMETRY BUILT HERE. `init()` registers
 * `enemy_soldier` through `forge.registerMesh` and instances it with
 * `forge.mesh()`, the same path ViewModel takes for `viewmodel_rig`. That buys
 * the prototype/clone split for free: four enemies are four Object3D trees over
 * one set of GPU uploads. This module is the animation and behaviour layer over
 * that, which is the split that lets the character be re-authored without
 * touching a line of AI.
 *
 * EVERY MATERIAL IS AN EXISTING RECIPE THROUGH `forge.rigMaterial`, AND THAT IS A
 * PERFORMANCE DECISION, NOT A LAZY ONE. The capture harness prewarms the five
 * poses *before* a shot's setup runs, so a wave spawned in the silhouette setup
 * arrives with its shaders cold, inside that shot's own 180 s budget, on a
 * software rasteriser where one cold compile has previously cost more than a
 * whole capture. Cloth is `camo_fabric` and `sandbag_canvas`, boots are `rubber`,
 * the face is `skin`, gloves and the weapon are the `gun_*` set — every one of
 * them already compiled for the view model or the level, and a tint is a uniform
 * rather than a define, so nine tinted variants add nine materials and zero
 * programs.
 *
 * SILHOUETTE IS THE POINT, so the character is authored for the read at 10-40 m
 * rather than for a close-up:
 *   - the helmet dome is deliberately narrower than the shoulders and sits above
 *     a visible neck gap, so head and shoulders separate into three notches
 *     instead of one blob;
 *   - the rifle crosses the body at an angle and the muzzle breaks the outline,
 *     which is what says "armed" at 20 m where a face is four pixels;
 *   - nothing is symmetrical: staggered feet, a bladed torso, one arm forward on
 *     the handguard;
 *   - three loadouts (helmet / capped leader with a whip antenna / shemagh) and
 *     three uniform tints, because four identical props in a row is its own
 *     rubric failure;
 *   - and the value scheme is internally contrasted — dark headgear, mid
 *     uniform, light webbing, so a figure reads against the sunlit plaster of the
 *     north block *and* against the shadowed south faces, instead of being tuned
 *     to one backdrop and vanishing into the other.
 *
 * WAVE PLACEMENT IS SCORED AGAINST THE MAP, NOT AGAINST THE CAMERA. Posts come
 * from `level.enemySpawns`, ranked by how much of the southern approach corridor
 * they can actually see (`collision.segmentClear` against the BVH), how far down
 * that corridor they sit, and how far off its axis they are. That is what a
 * defending squad does, and it is stable: it does not depend on where the player
 * happens to be standing at the instant `spawnWave` is called, which for the
 * capture harness is the *previous* shot's pose because setup runs before the
 * pose is applied.
 *
 * DEFENDERS HOLD. An enemy will reposition inside `ROAM_LIMIT` of its post and no
 * further. A squad that abandons cover to walk at the player turns a still into a
 * lottery — the frame is captured somewhere in four seconds of simulation — and
 * it is also worse behaviour.
 *
 * CONTRACT:
 *   enemies : Enemy[]
 *   spawnWave(n)
 *   alertAll(position)
 *
 * ADDITIONS (safe to rely on):
 *   root         : THREE.Group   every body in the scene
 *   despawnAll()
 *   bus events: ai:spawn, ai:alert, ai:death
 */

/* --------------------------------------------------------------- tunables */

const EYE = 1.55; // enemy eye height above its feet
const BODY_RADIUS = 0.34;
const BODY_HEIGHT = 1.78;

const THINK_STEPS = 8; // fixed steps between one enemy's perception updates (15 Hz)
const ROAM_LIMIT = 4.5; // metres a defender will stray from its post
const MOVE_SPEED = 2.6;
const TURN_RATE = 5.2; // rad/s
const SIGHT_RANGE = 85;
const FOV_COS = -0.15; // ~99 degrees to either side; a soldier is not a camera

const REACTION = 0.42; // seconds between seeing and being on target
const SHOT_INTERVAL = 0.86; // deliberate aimed fire, not a hose
const SPREAD = 0.045; // radians, cone half-angle before the per-enemy bias
const SUPPRESS_TIME = 1.05;
const LOS_GIVEUP = 3.0;
const DEATH_TIME = 1.05;

/**
 * The AI's weapon. Damage is deliberately below the player's: `Ballistics`
 * resolves this through the same falloff curve, and a squad of four on full auto
 * at ten metres would end a capture pose in under a second.
 */
const AI_WEAPON = {
  name: 'ak_pattern',
  damage: 13,
  falloff: { near: 18, far: 65, floor: 6 },
  headMultiplier: 1.5,
  limbMultiplier: 0.85,
  penetration: 0.3,
};

const S = {
  IDLE: 'idle',
  ALERT: 'alert',
  COVER: 'cover',
  ENGAGE: 'engage',
  SUPPRESSED: 'suppressed',
  DEAD: 'dead',
};

/**
 * Three kits. `head` selects which of the prototype's mutually exclusive headgear
 * groups is shown, `kit` which of the optional back-mounted parts are. Tints are
 * multipliers over an already-authored albedo, so they sit near white and shift
 * hue rather than darkening: `camo_fabric` bakes at roughly 0.12 linear and a
 * "dark olive" 0x6f7355 multiplier would take a whole uniform to 0.02, which is
 * crush, not camouflage.
 */
const LOADOUTS = [
  {
    uniform: 0xb9bda2,
    webbing: 0xd6c7a0,
    gear: 0x8f9479,
    head: 'hg_helmet',
    kit: ['kit_pack'],
  },
  {
    uniform: 0xe2d8b4,
    webbing: 0x8e9377,
    gear: 0x6f7561,
    head: 'hg_cap',
    kit: ['kit_antenna', 'kit_pack'],
  },
  {
    uniform: 0xc2b6a4,
    webbing: 0xf0e6cc,
    gear: 0xa39a80,
    head: 'hg_shemagh',
    kit: [],
  },
];

const HEADGEAR = ['hg_helmet', 'hg_cap', 'hg_shemagh'];
const KIT = ['kit_antenna', 'kit_pack'];

export class AIDirector {
  constructor(game) {
    this.game = game;
    this.enemies = [];

    this.root = new THREE.Group();
    this.root.name = 'ai_bodies';

    // Hitboxes live outside the scene graph on purpose. `Ballistics._castBodies`
    // needs a Mesh with geometry and `visible === true`, and anything visible in
    // `game.scene` is drawn. Parenting them to a detached root keeps
    // `updateWorldMatrix(true, false)` correct — it walks up to this identity
    // group — while costing not one triangle of raster.
    this.hitRoot = new THREE.Group();
    this.hitRoot.name = 'ai_hitboxes';

    this.rng = new Rng(0x5170e1);
    this._proto = null;
    this._posts = null;
    this._tick = 0;

    // Scratch. Nothing in fixedUpdate/update below is allowed to allocate.
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._onHit = null;
  }

  async init() {
    const forge = this.game.forge;
    if (forge?.registerMesh) {
      forge.registerMesh('enemy_soldier', (f) => buildSoldierRig(f));
      // Instanced once here rather than on the first spawn: geometry synthesis is
      // a boot cost everywhere else in this project, and the one place a wave is
      // ever spawned is inside a capture shot's own time budget.
      this._proto = forge.mesh('enemy_soldier');
    } else {
      console.error('[ai] forge has no registerMesh; the silhouette pose will be empty');
    }

    this.game.scene?.add(this.root);

    // Ballistics resolves a hit and publishes it; who owns the health is the
    // owner's business. This is the only wiring the two systems need.
    this._onHit = (ev) => {
      const e = ev?.target;
      if (e && e.isEnemy && e.alive) this._damage(e, ev.damage ?? 0, ev.zone, ev.shooter);
    };
    this.game.bus?.on?.('combat:hit', this._onHit);
  }

  /* ------------------------------------------------------------ spawning */

  /**
   * Put `n` enemies onto the map's defended positions.
   *
   * Posts are ranked once and cached: the ranking is a property of the level and
   * the approach it was built around, not of the moment. A post takes a second
   * body before a worse post takes its first, so four enemies read as two fire
   * teams holding two positions rather than four sentries scattered one deep.
   */
  spawnWave(n = 4) {
    if (!this._proto) return [];
    const posts = this._posts ?? (this._posts = this._rankPosts());
    if (!posts.length) return [];

    const out = [];
    for (let i = 0; i < n; i++) {
      const post = posts[i % posts.length];
      const rank = Math.floor(i / posts.length); // 0 = on the post, 1+ = flanking it
      const slot = this._slotFor(post, rank, i);
      const e = this._makeEnemy(post, slot, this.enemies.length);
      // A wave is a squad being committed, not a patrol being surprised. It comes
      // in alert and looking, which is both what the word means and what stops the
      // outcome depending on which way a spawn point's authored yaw happens to
      // face at the moment it is used.
      e.state = S.ALERT;
      if (this.game.player) {
        e.lastKnown.copy(this.game.player.position);
        e.hasLastKnown = true;
      }
      this.enemies.push(e);
      out.push(e);
    }
    this.game.bus?.emit?.('ai:spawn', { count: out.length, total: this.enemies.length });
    return out;
  }

  /**
   * Score every enemy spawn by how well it covers the southern approach, and keep
   * the best ones that are not on top of each other.
   *
   * Three terms. Line of sight to the corridor the player walks up, because a post
   * that cannot see the approach is not defending it. Distance down that corridor,
   * banded so a post at the player's feet or eighty metres away is not chosen over
   * one at engagement range. And lateral offset from the corridor's axis, which is
   * what separates a position fronting the square from one covering a side arcade.
   */
  _rankPosts() {
    const level = this.game.level;
    const col = this.game.collision;
    const spawns = level?.enemySpawns ?? [];
    if (!spawns.length) return [];

    const start = level?.spawnPoints?.[0]?.position ?? new THREE.Vector3(0, 1.7, 20);
    const corridor = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      corridor.push(new THREE.Vector3(start.x * (1 - t), 1.55, start.z + (-8 - start.z) * t));
    }

    const a = new THREE.Vector3();
    const scored = [];
    for (const post of spawns) {
      a.set(post.position.x, post.position.y + EYE, post.position.z);
      let seen = 0;
      if (col?.segmentClear) {
        for (const c of corridor) if (col.segmentClear(a, c)) seen++;
      } else {
        seen = corridor.length;
      }
      if (seen === 0) continue; // covers nothing the player will walk through

      const d = post.position.distanceTo(start);
      const range = 1 - Math.min(1, Math.abs(d - 27) / 20);
      const lateral = Math.min(1, Math.abs(post.position.x - start.x) / 18);
      scored.push({ post, score: seen / corridor.length + range - lateral * 0.8 });
    }
    scored.sort((p, q) => q.score - p.score);

    // Greedy spread. Two posts six metres apart are one post as far as the eye is
    // concerned, and stacking a wave into one corner wastes half of it.
    const kept = [];
    for (const s of scored) {
      let ok = true;
      for (const k of kept) {
        if (k.position.distanceTo(s.post.position) < 6) {
          ok = false;
          break;
        }
      }
      if (ok) kept.push(s.post);
      if (kept.length >= 5) break;
    }
    return kept.length ? kept : spawns.slice(0, 4);
  }

  /**
   * Where the `rank`-th body on a post actually stands. Rank 0 takes the post.
   * Anyone after that is offset along the post's lateral axis by a fire-team
   * spacing, alternating sides, and the offset is only accepted if the ground is
   * there, the position is not inside a wall, and the post can still see it.
   */
  _slotFor(post, rank, index) {
    const out = post.position.clone();
    if (rank === 0) return out;

    const col = this.game.collision;
    const side = index % 2 === 0 ? 1 : -1;
    const right = Math.cos(post.yaw ?? 0) * side;
    const fwd = -Math.sin(post.yaw ?? 0) * side;
    const spacing = 2.4 + rank * 1.1;

    for (const push of [spacing, -spacing, spacing * 0.6, -spacing * 0.6]) {
      this._v.set(post.position.x + right * push, post.position.y, post.position.z + fwd * push);
      const g = col?.groundHeight ? col.groundHeight(this._v.x, this._v.z, post.position.y + 3) : post.position.y;
      if (g == null || Math.abs(g - post.position.y) > 1.2) continue;
      this._v.y = g;
      this._v2.set(this._v.x, g + 0.95, this._v.z);
      if (col?.closestPoint && col.closestPoint(this._v2, 0.55, this._v3)) continue; // inside something
      this._v3.set(post.position.x, post.position.y + EYE, post.position.z);
      this._v2.y = g + EYE;
      if (col?.segmentClear && !col.segmentClear(this._v3, this._v2)) continue;
      return out.copy(this._v);
    }
    return out;
  }

  _makeEnemy(post, slot, index) {
    const forge = this.game.forge;
    const rig = forge.mesh('enemy_soldier');
    const parts = rig.userData.parts;
    const kit = LOADOUTS[index % LOADOUTS.length];

    // One prototype, three silhouettes: show this kit's headgear and back gear and
    // hide the rest. A hidden mesh costs nothing, and it is far cheaper than three
    // prototypes' worth of geometry for a wave that only ever shows four bodies.
    for (const name of HEADGEAR) if (parts[name]) parts[name].visible = name === kit.head;
    for (const name of KIT) if (parts[name]) parts[name].visible = kit.kit.includes(name);

    // Tints are per instance, so the clone's shared materials have to be replaced
    // rather than mutated — mutating would recolour every enemy at once.
    const tint = {
      uniform: forge.rigMaterial('camo_fabric', { color: kit.uniform, uvScale: [3, 3] }),
      webbing: forge.rigMaterial('sandbag_canvas', { color: kit.webbing, uvScale: [2.6, 2.6] }),
      gear: forge.rigMaterial('camo_fabric', { color: kit.gear, uvScale: [2.2, 2.2] }),
    };
    rig.traverse((o) => {
      if (!o.isMesh) return;
      const slotName = o.userData.slot;
      if (slotName && tint[slotName]) o.material = tint[slotName];
      // Unlike the view model, a body in the world is a shadow caster, and the
      // contact shadow under its boots is most of what stops it floating.
      o.castShadow = true;
      o.receiveShadow = true;
    });

    // Which shoulder this one shoots off. Everything asymmetric about the pose —
    // the hip blade, the resting torso twist, which foot is forward — hangs off
    // this one sign, so two adjacent bodies are mirror images rather than clones.
    const blade = (index % 2 === 0 ? 1 : -1) * this.rng.range(0.26, 0.46);

    const e = {
      isEnemy: true,
      id: index,
      root: rig,
      parts,
      post,
      slot,
      position: slot.clone(),
      target: slot.clone(),
      yaw: post.yaw ?? 0,
      targetYaw: post.yaw ?? 0,
      health: 100,
      maxHealth: 100,
      alive: true,
      state: S.IDLE,
      stateT: 0,
      hasLos: false,
      losLostT: 0,
      lastKnown: new THREE.Vector3(),
      hasLastKnown: false,
      aimPitch: 0,
      weaponUp: 0,
      fireCd: REACTION + this.rng.range(0.15, 0.5),
      walkPhase: this.rng.range(0, Math.PI * 2),
      speed: 0,
      deathT: 0,
      deathDir: this.rng.float() < 0.5 ? -1 : 1,
      // A squad where every rifle shoots the same is a squad that either always
      // hits or always misses. A fixed per-enemy bias inside the cone is what
      // makes one of them the dangerous one.
      biasX: this.rng.gauss() * SPREAD * 0.8,
      biasY: this.rng.gauss() * SPREAD * 0.8,
      stanceBias: blade,
      thinkPhase: index % THINK_STEPS,
      hitboxes: [],
      hitGroup: null,
      // Base pose, in radians. Animation is a delta on these so a walk cycle or a
      // flinch never fights the stance the body was authored standing in.
      base: {
        thighL: blade > 0 ? -0.15 : 0.13,
        thighR: blade > 0 ? 0.13 : -0.15,
        shinL: blade > 0 ? 0.19 : -0.04,
        shinR: blade > 0 ? -0.04 : 0.19,
        chestYaw: 0.22 * Math.sign(blade),
        chestPitch: 0.06,
      },
    };

    rig.position.copy(slot);
    rig.rotation.y = e.yaw;
    this.root.add(rig);
    this._applyBase(e);

    // Three boxes, because Ballistics carries head/torso/limb multipliers and a
    // single capsule makes all three of them dead code.
    const hg = new THREE.Group();
    hg.position.copy(slot);
    hg.rotation.y = e.yaw;
    this.hitRoot.add(hg);
    e.hitGroup = hg;
    const addBox = (w, h, d, y, z, zone) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
      m.position.set(0, y, z);
      m.updateMatrix();
      hg.add(m);
      this.game.ballistics?.registerHitbox?.(m, { owner: e, zone });
      e.hitboxes.push(m);
    };
    addBox(0.26, 0.3, 0.28, 1.62, 0, 'head');
    addBox(0.52, 0.66, 0.34, 1.16, 0, 'torso');
    addBox(0.46, 0.9, 0.36, 0.46, 0, 'limb');
    addBox(0.62, 0.36, 0.3, 1.4, 0, 'limb'); // arms out to the sides of the chest

    return e;
  }

  despawnAll() {
    for (const e of this.enemies) {
      for (const h of e.hitboxes) {
        this.game.ballistics?.unregisterHitbox?.(h);
        h.geometry.dispose();
      }
      e.hitGroup?.parent?.remove(e.hitGroup);
      e.root.parent?.remove(e.root);
    }
    this.enemies.length = 0;
  }

  /* ------------------------------------------------------------ behaviour */

  /** Everyone alive turns toward `position` and starts looking for a target. */
  alertAll(position) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (position) {
        e.lastKnown.copy(position);
        e.hasLastKnown = true;
      }
      if (e.state === S.IDLE) this._setState(e, S.ALERT);
    }
    this.game.bus?.emit?.('ai:alert', { position });
  }

  fixedUpdate(dt) {
    if (!this.enemies.length) return;
    this._tick++;
    const player = this.game.player;

    for (const e of this.enemies) {
      e.stateT += dt;

      if (e.state === S.DEAD) {
        e.deathT = Math.min(DEATH_TIME, e.deathT + dt);
        continue;
      }

      // Perception is the expensive half — a BVH ray per enemy — so it runs at
      // 15 Hz on a per-enemy phase rather than 120 Hz all at once. Steering and
      // aiming stay on the full step, which is what they are felt through.
      if ((this._tick + e.thinkPhase) % THINK_STEPS === 0) this._think(e, player, dt * THINK_STEPS);

      this._act(e, player, dt);
      this._locomote(e, dt);

      // Turn toward whatever the state decided to face. Rate-limited rather than
      // snapped: a body that changes facing instantly reads as a billboard.
      const d = wrapPi(e.targetYaw - e.yaw);
      const step = TURN_RATE * dt;
      e.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;

      e.hitGroup.position.copy(e.position);
      e.hitGroup.rotation.y = e.yaw;
    }
  }

  /** Perception: can this enemy see the player, and does that change its mind. */
  _think(e, player, dt) {
    const col = this.game.collision;
    let los = false;

    if (player && player.alive !== false) {
      this._eye.set(e.position.x, e.position.y + EYE, e.position.z);
      this._aim.set(player.position.x, player.position.y + (player.eyeHeight ?? 1.7) * 0.72, player.position.z);
      const dist = this._eye.distanceTo(this._aim);
      if (dist < SIGHT_RANGE) {
        this._dir.copy(this._aim).sub(this._eye).normalize();
        // The vision cone only gates a soldier who does not know there is a fight.
        // Once alerted he is sweeping his sector and the squad is sharing contacts,
        // so gating on instantaneous facing would mean a body whose spawn yaw
        // happens to point away never turns around — which is not a soldier, it is
        // a turret with a blind spot.
        const facing = -Math.sin(e.yaw) * this._dir.x - Math.cos(e.yaw) * this._dir.z;
        if (e.state !== S.IDLE || facing > FOV_COS) {
          los = col?.segmentClear ? col.segmentClear(this._eye, this._aim) : true;
        }
      }
    }

    e.hasLos = los;
    if (los) {
      e.losLostT = 0;
      e.lastKnown.copy(player.position);
      e.hasLastKnown = true;
      if (e.state === S.IDLE || e.state === S.ALERT || e.state === S.COVER) this._setState(e, S.ENGAGE);
    } else {
      e.losLostT += dt;
      if (e.state === S.ENGAGE && e.losLostT > LOS_GIVEUP) this._setState(e, S.COVER);
    }
  }

  /** The state machine proper: what the body wants to do this step. */
  _act(e, player, dt) {
    switch (e.state) {
      case S.IDLE:
        e.targetYaw = e.post.yaw ?? 0;
        e.weaponUp = approach(e.weaponUp, 0, dt * 2.5);
        e.target.copy(e.slot);
        break;

      case S.ALERT:
        if (e.hasLastKnown) e.targetYaw = yawTo(e.position, e.lastKnown);
        e.weaponUp = approach(e.weaponUp, 0.55, dt * 3.2);
        e.target.copy(e.slot);
        if (e.stateT > 0.9) this._setState(e, e.hasLos ? S.ENGAGE : S.COVER);
        break;

      case S.COVER:
        // Fall back onto the post and hold it. A defender that walks the whole
        // map at the player is neither good behaviour nor a stable frame. Standing
        // down is a long fuse and it goes to IDLE, not back to ALERT: bouncing
        // between the two is a loop that changes nothing except which comment
        // explains it.
        e.target.copy(e.slot);
        if (e.hasLastKnown) e.targetYaw = yawTo(e.position, e.lastKnown);
        e.weaponUp = approach(e.weaponUp, 0.5, dt * 3);
        if (e.position.distanceTo(e.slot) < 0.35 && e.stateT > 12) this._setState(e, S.IDLE);
        break;

      case S.ENGAGE: {
        e.target.copy(e.slot);
        e.weaponUp = approach(e.weaponUp, 1, dt * 4);
        if (player) {
          // Bladed, not square. A rifleman stands at an angle to his firing line
          // and squares only his shoulders, so the hips give a three-quarter
          // presentation while the weapon still points at the threat. Standing
          // four bodies dead-on to the camera is both wrong and the flattest
          // silhouette a figure can have.
          e.targetYaw = yawTo(e.position, player.position) + e.stanceBias;
          const dy = player.position.y + (player.eyeHeight ?? 1.7) * 0.72 - (e.position.y + EYE);
          const flat = Math.hypot(player.position.x - e.position.x, player.position.z - e.position.z);
          e.aimPitch = approach(e.aimPitch, Math.atan2(dy, Math.max(0.4, flat)), dt * 6);
        }
        e.fireCd -= dt;
        if (e.hasLos && e.weaponUp > 0.85 && e.fireCd <= 0 && player && player.alive !== false) {
          this._fire(e, player);
          e.fireCd = SHOT_INTERVAL + this.rng.range(-0.16, 0.34);
        }
        break;
      }

      case S.SUPPRESSED:
        // Head down behind the post. No fire, and the aim decays, so a suppressed
        // enemy has to re-acquire rather than snapping back on target.
        e.target.copy(e.slot);
        e.weaponUp = approach(e.weaponUp, 0.35, dt * 3);
        e.aimPitch = approach(e.aimPitch, 0, dt * 2);
        if (e.stateT > SUPPRESS_TIME) {
          e.fireCd = Math.max(e.fireCd, REACTION);
          this._setState(e, e.hasLos ? S.ENGAGE : S.COVER);
        }
        break;
    }
  }

  /**
   * Steering against the static BVH. `sweepCapsule` is the same query the player
   * moves through, so an enemy cannot walk through a wall the player cannot, and
   * the ground it stands on is the ground the player stands on.
   */
  _locomote(e, dt) {
    this._v.copy(e.target).sub(e.position);
    this._v.y = 0;
    const dist = this._v.length();
    if (dist < 0.12) {
      e.speed = approach(e.speed, 0, dt * 8);
      return;
    }
    // Hold the sector. Anything past this is a different post's problem.
    if (e.target.distanceTo(e.post.position) > ROAM_LIMIT) {
      e.speed = approach(e.speed, 0, dt * 8);
      return;
    }

    const want = Math.min(MOVE_SPEED, dist * 3);
    e.speed = approach(e.speed, want, dt * 6);
    this._v.multiplyScalar(e.speed * dt / Math.max(dist, 1e-4));

    const col = this.game.collision;
    if (col?.sweepCapsule) {
      const half = BODY_HEIGHT * 0.5;
      this._v2.set(e.position.x, e.position.y + half, e.position.z);
      this._v3.copy(this._v2).add(this._v);
      const r = col.sweepCapsule(this._v2, this._v3, BODY_RADIUS, BODY_HEIGHT);
      e.position.set(r.position.x, r.position.y - half, r.position.z);
    } else {
      e.position.add(this._v);
    }
    e.walkPhase += (e.speed / 0.78) * dt * Math.PI;
  }

  /**
   * One aimed round. Ballistics owns the trace, the impact and the falloff; what
   * it does not own is the player, who is not a registered hitbox — so the same
   * ray is tested against the player capsule here and the nearer of the two wins,
   * exactly the ordering `_castBodies` uses for everything else.
   */
  _fire(e, player) {
    const cy = Math.cos(e.yaw);
    const sy = Math.sin(e.yaw);
    // Muzzle from the pose rather than from the rig's world matrix: the matrix is
    // a display-rate frame behind the sim, and a round that comes out of last
    // frame's gun is a round that clips this frame's wall.
    this._muzzle.set(e.position.x - sy * 0.46 + cy * 0.1, e.position.y + 1.42, e.position.z - cy * 0.46 - sy * 0.1);

    this._aim.set(player.position.x, player.position.y + (player.eyeHeight ?? 1.7) * 0.62, player.position.z);
    this._dir.copy(this._aim).sub(this._muzzle).normalize();

    // Cone about the aim axis: the fixed per-enemy bias plus a shot-to-shot term.
    const ax = -this._dir.z;
    const az = this._dir.x;
    const al = Math.hypot(ax, az) || 1;
    const ox = e.biasX + this.rng.gauss() * SPREAD;
    const oy = e.biasY + this.rng.gauss() * SPREAD;
    this._dir.x += (ax / al) * ox;
    this._dir.z += (az / al) * ox;
    this._dir.y += oy;
    this._dir.normalize();

    const hit = this.game.ballistics?.fireHitscan?.(this._muzzle, this._dir, AI_WEAPON, {
      shooter: e,
      tracer: true,
    });
    this.game.audio?.playAt?.('rifle_distant', this._muzzle);

    const wall = hit ? hit.distance : Infinity;
    const t = rayCapsule(this._muzzle, this._dir, player.position, player.stanceHeight ?? 1.8, 0.34);
    if (t != null && t < wall && player.damage) {
      const dmg = this.game.ballistics?.damageAtRange?.(AI_WEAPON, t) ?? AI_WEAPON.damage;
      this._v.copy(this._dir).negate();
      player.damage(dmg, this._v);
    }
  }

  _damage(e, amount, zone, shooter) {
    e.health -= amount;
    // A round through the head ends it whatever the falloff says. Ballistics
    // already applied the head multiplier; this is the separate promise that a
    // headshot is not merely good value.
    if (e.health <= 0 || zone === 'head') return this._die(e, shooter);
    if (e.state !== S.SUPPRESSED) this._setState(e, S.SUPPRESSED);
    if (!e.hasLastKnown && this.game.player) {
      e.lastKnown.copy(this.game.player.position);
      e.hasLastKnown = true;
    }
  }

  _die(e, killer) {
    e.health = 0;
    e.alive = false;
    e.speed = 0;
    this._setState(e, S.DEAD);
    e.deathT = 0;
    for (const h of e.hitboxes) this.game.ballistics?.unregisterHitbox?.(h);
    this.game.bus?.emit?.('ai:death', { enemy: e, killer });
  }

  _setState(e, state) {
    if (e.state === state) return;
    // Acquiring a target costs time even when the target was already there. Set
    // here rather than in the ENGAGE branch so every route into it pays.
    if (state === S.ENGAGE) e.fireCd = Math.max(e.fireCd, REACTION);
    e.state = state;
    e.stateT = 0;
  }

  /* ---------------------------------------------------------- presentation */

  update(dt) {
    if (!this.enemies.length) return;
    const d = Math.min(dt, 0.1);

    for (const e of this.enemies) {
      const p = e.parts;
      e.root.position.copy(e.position);
      e.root.rotation.y = e.yaw;

      if (e.state === S.DEAD) {
        this._poseDeath(e);
        continue;
      }

      // Weapon carry: one pivot above the shoulder line takes both arms and the
      // rifle together, which is the whole reason low-ready and shouldered are the
      // same rig. Rotating the arms alone would tear the hands off the handguard.
      if (p.aim) p.aim.rotation.x = 0.62 * (1 - e.weaponUp) - e.aimPitch * e.weaponUp;

      // Crouch under fire, and settle back down. Read off the state rather than
      // keyed, so it holds for as long as the state does.
      const crouch = e.state === S.SUPPRESSED ? 0.17 : 0;
      if (p.pelvis) {
        p.pelvis.position.y = approach(p.pelvis.position.y, 0.93 - crouch, d * 6);
        p.pelvis.rotation.y = Math.sin(e.walkPhase) * 0.06 * clamp01(e.speed);
      }
      // The hips carry the stance bias, so the shoulders have to come back off it
      // or the rifle would point wherever the feet do. Three quarters of the way,
      // not all of it: a shooter's shoulders sit slightly open too, and that
      // residual is what keeps the chest from reading as a flat plate.
      const chestYaw = e.base.chestYaw * (1 - e.weaponUp) - e.stanceBias * 0.75 * e.weaponUp;
      if (p.chest) {
        p.chest.rotation.y = chestYaw;
        p.chest.rotation.x = e.base.chestPitch + crouch * 1.4;
      }
      // The head leads the turn, which is the cheapest thing that makes a body
      // look like it is paying attention rather than being rotated by a script.
      if (p.head) {
        const lead = wrapPi(e.targetYaw - e.yaw);
        p.head.rotation.y = -chestYaw * 0.6 + THREE.MathUtils.clamp(lead, -0.7, 0.7);
        p.head.rotation.x = -e.aimPitch * 0.5;
      }

      // Walk cycle. Amplitude follows speed so a standing body is genuinely still
      // rather than idling on the spot at one percent.
      const amp = clamp01(e.speed / MOVE_SPEED);
      const sw = Math.sin(e.walkPhase) * 0.62 * amp;
      const sw2 = Math.sin(e.walkPhase + Math.PI) * 0.62 * amp;
      if (p.thigh_l) p.thigh_l.rotation.x = e.base.thighL + sw;
      if (p.thigh_r) p.thigh_r.rotation.x = e.base.thighR + sw2;
      if (p.shin_l) p.shin_l.rotation.x = e.base.shinL + Math.max(0, -sw) * 1.1;
      if (p.shin_r) p.shin_r.rotation.x = e.base.shinR + Math.max(0, -sw2) * 1.1;
    }
  }

  /**
   * Death that reads at forty metres, which means it has to change the
   * silhouette, not just the animation. The body folds at the waist and goes down
   * across its own facing, so what was a vertical notch in the skyline becomes a
   * horizontal mass on the ground — legible even when the figure is thirty pixels
   * tall and the limbs are one pixel wide.
   */
  _poseDeath(e) {
    const t = clamp01(e.deathT / DEATH_TIME);
    const s = t * t * (3 - 2 * t);
    const p = e.parts;
    if (p.pelvis) {
      p.pelvis.position.y = 0.93 - s * 0.62;
      p.pelvis.rotation.z = s * 1.35 * e.deathDir;
      p.pelvis.rotation.x = s * 0.5;
    }
    if (p.chest) {
      p.chest.rotation.x = e.base.chestPitch + s * 0.55;
      p.chest.rotation.y = e.base.chestYaw * (1 - s) + s * 0.5 * e.deathDir;
    }
    if (p.head) {
      p.head.rotation.x = s * 0.6;
      p.head.rotation.y = -s * 0.8 * e.deathDir;
    }
    if (p.aim) p.aim.rotation.x = 0.62 + s * 0.9;
    if (p.thigh_l) p.thigh_l.rotation.x = e.base.thighL - s * 0.85;
    if (p.thigh_r) p.thigh_r.rotation.x = e.base.thighR - s * 0.35;
    if (p.shin_l) p.shin_l.rotation.x = e.base.shinL + s * 1.5;
    if (p.shin_r) p.shin_r.rotation.x = e.base.shinR + s * 0.9;
  }

  _applyBase(e) {
    const p = e.parts;
    if (p.pelvis) p.pelvis.position.y = 0.93;
    if (p.thigh_l) p.thigh_l.rotation.x = e.base.thighL;
    if (p.thigh_r) p.thigh_r.rotation.x = e.base.thighR;
    if (p.shin_l) p.shin_l.rotation.x = e.base.shinL;
    if (p.shin_r) p.shin_r.rotation.x = e.base.shinR;
    if (p.chest) {
      p.chest.rotation.y = e.base.chestYaw;
      p.chest.rotation.x = e.base.chestPitch;
    }
    if (p.aim) p.aim.rotation.x = 0.62;
  }

  dispose() {
    if (this._onHit) this.game.bus?.off?.('combat:hit', this._onHit);
    this.despawnAll();
    this.root.parent?.remove(this.root);
  }
}

/* ----------------------------------------------------------------- helpers */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function approach(v, target, rate) {
  const d = target - v;
  const step = Math.abs(d) * Math.min(1, rate);
  return Math.abs(d) <= step ? target : v + Math.sign(d) * step;
}

function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Yaw that points a -Z-forward body from `from` at `to`, matching Player's convention. */
function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/**
 * Distance along a ray to a vertical capsule, or null. Used for exactly one
 * thing: the player, who is the only body in the game that Ballistics does not
 * carry a hitbox for. Solved as a ray/infinite-cylinder quadratic clamped to the
 * capsule's segment, with the two hemispheres tested separately.
 */
function rayCapsule(origin, dir, feet, height, radius) {
  const y0 = feet.y + radius;
  const y1 = feet.y + Math.max(height - radius, radius + 0.01);
  const px = origin.x - feet.x;
  const pz = origin.z - feet.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  let best = null;

  if (a > 1e-8) {
    const b = 2 * (px * dir.x + pz * dir.z);
    const c = px * px + pz * pz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0) continue;
        const y = origin.y + dir.y * t;
        if (y >= y0 && y <= y1 && (best == null || t < best)) best = t;
      }
    }
  }

  for (const cy of [y0, y1]) {
    const oy = origin.y - cy;
    const b = 2 * (px * dir.x + oy * dir.y + pz * dir.z);
    const c = px * px + oy * oy + pz * pz - radius * radius;
    const disc = b * b - 4 * c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const t of [(-b - sq) / 2, (-b + sq) / 2]) {
      if (t < 0) continue;
      const y = origin.y + dir.y * t;
      if (cy === y0 ? y <= y0 : y >= y1) {
        if (best == null || t < best) best = t;
      }
    }
  }
  return best;
}

/* -------------------------------------------------------- rig construction */

const _M = new THREE.Matrix4();
const _Q = new THREE.Quaternion();
const _E = new THREE.Euler();
const _A = new THREE.Vector3();
const _B = new THREE.Vector3();
const _ONE = new THREE.Vector3(1, 1, 1);

function trs(x, y, z, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _Q.setFromEuler(_E.set(rx, ry, rz, 'YXZ')), _ONE);
}

function box(w, h, d) {
  return new THREE.BoxGeometry(w, h, d);
}

function sph(r, w = 8, h = 6) {
  return new THREE.SphereGeometry(r, w, h);
}

/** Cylinder along Z: `rNear` at +Z, `rFar` at -Z, so it pairs with `_axis` below. */
function tubeZ(rNear, rFar, len, seg = 8) {
  const g = new THREE.CylinderGeometry(rFar, rNear, len, seg, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

function dome(r, seg = 10, arc = 0.56) {
  return new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.55)), 0, Math.PI * 2, 0, Math.PI * arc);
}

/**
 * Merge a list of `[geometry, matrix]` into one buffer. Same trick AssetForge
 * uses for the view model: a rig part is one animatable unit, and inside it every
 * shape sharing a material collapses into a single draw.
 */
function mergeGeos(list) {
  let vc = 0;
  let ic = 0;
  for (const [g] of list) {
    vc += g.attributes.position.count;
    ic += g.index.count;
  }
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  for (const [g, m] of list) {
    if (m) g.applyMatrix4(m);
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    const a = g.index.array;
    for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo;
    vo += g.attributes.position.count;
    io += a.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * Which forge recipe each named material slot resolves to.
 *
 * `uniform`, `webbing` and `gear` are re-bound per instance for the tint; the
 * rest are asked for with the *exact* recipe and override the view model already
 * uses, so they come back as the same cached material object and cost neither a
 * bake nor a program.
 */
const SLOTS = {
  uniform: ['camo_fabric', { uvScale: [3, 3] }],
  webbing: ['sandbag_canvas', { uvScale: [2.6, 2.6] }],
  gear: ['camo_fabric', { uvScale: [2.2, 2.2] }],
  boot: ['rubber', { color: 0x8a8a8a }],
  skin: ['skin', {}],
  glove: ['gun_polymer', {}],
  gunmetal: ['gun_steel_blued', { envMapIntensity: 1.5 }],
  gunbody: ['gun_aluminium_anodized', { envMapIntensity: 1.4 }],
};

class SoldierBuilder {
  constructor(forge) {
    this.forge = forge;
    this.parts = new Map();
  }

  put(part, slot, geo, m) {
    let p = this.parts.get(part);
    if (!p) this.parts.set(part, (p = new Map()));
    let list = p.get(slot);
    if (!list) p.set(slot, (list = []));
    list.push([geo, m]);
    return this;
  }

  /** Tapered limb between two points, `rA` at `a`. */
  limb(part, slot, a, b, rA, rB, seg = 8) {
    _A.set(a[0], a[1], a[2]);
    _B.set(b[0], b[1], b[2]);
    const len = _A.distanceTo(_B);
    _M.lookAt(_A, _B, new THREE.Vector3(0, 1, 0));
    _M.setPosition(_A.lerp(_B, 0.5));
    return this.put(part, slot, tubeZ(rA, rB, len, seg), _M.clone());
  }

  /** Realise one named part as a Group of merged meshes, one per material slot. */
  build(name) {
    const g = new THREE.Group();
    g.name = name;
    const p = this.parts.get(name);
    if (!p) return g;
    for (const [slot, list] of p) {
      const [recipe, extra] = SLOTS[slot];
      const mesh = new THREE.Mesh(mergeGeos(list), this.forge.rigMaterial(recipe, extra));
      mesh.name = `${name}_${slot}`;
      mesh.userData.slot = slot;
      g.add(mesh);
    }
    return g;
  }
}

/**
 * The enemy soldier.
 *
 * Authored feet-at-origin, facing -Z, so a body only has to set `position` and
 * `rotation.y` from the same yaw convention Player uses. 1.82 m to the crown.
 *
 * The hierarchy exists for the four things that actually have to move: the
 * pelvis (crouch and collapse), the chest (the bladed stance and the fold at the
 * waist), the aim pivot above the shoulder line (both arms and the rifle as one
 * unit, so low-ready and shouldered are the same rig rather than two poses), and
 * the four leg segments (the walk, and the knees folding under a body going
 * down). Everything else is merged into whichever of those it hangs from.
 */
function buildSoldierRig(forge) {
  const r = new SoldierBuilder(forge);

  /* legs. Origins at the joints so a rotation is a rotation, not a translation. */
  for (const side of [-1, 1]) {
    const t = side < 0 ? 'thigh_l' : 'thigh_r';
    const s = side < 0 ? 'shin_l' : 'shin_r';
    r.limb(t, 'uniform', [0, 0, 0], [0, -0.44, 0], 0.108, 0.082, 8);
    r.put(t, 'uniform', sph(0.084, 8, 6).scale(1, 0.85, 1), trs(0, -0.44, 0));
    // Thigh rig on the strong side: a drop holster is a 15 cm notch on an
    // otherwise smooth leg, and at 20 m a notch is worth more than a face.
    if (side > 0) {
      r.put(t, 'webbing', box(0.085, 0.15, 0.07), trs(0.105, -0.22, 0.015));
      r.put(t, 'webbing', box(0.05, 0.06, 0.05), trs(0.105, -0.12, 0.015));
    }
    r.limb(s, 'uniform', [0, 0, 0], [0, -0.4, 0], 0.082, 0.056, 8);
    // Trouser blousing over the boot top: the flare is the tell that these are
    // fatigues and not tights.
    r.limb(s, 'uniform', [0, -0.3, 0], [0, -0.4, 0], 0.062, 0.082, 8);
    r.put(s, 'boot', box(0.125, 0.11, 0.27), trs(0, -0.455, -0.035));
    r.put(s, 'boot', box(0.11, 0.06, 0.09), trs(0, -0.485, -0.19));
    r.put(s, 'boot', tubeZ(0.062, 0.062, 0.11, 8), trs(0, -0.36, 0, Math.PI / 2));
  }

  /* pelvis */
  r.put('pelvis', 'uniform', sph(0.17, 10, 7).scale(1.02, 0.74, 0.72), trs(0, -0.05, 0));
  // Vertical-axis tubes are authored along Z and stood up by the rx = pi/2 in
  // their placement matrix, which sends local Y to world Z. So the oval squash on
  // every one of them is on Y, not on Z: on Z it would shorten the part instead.
  r.put('pelvis', 'webbing', tubeZ(0.175, 0.175, 0.08, 12).scale(1, 0.74, 1), trs(0, 0.045, 0, Math.PI / 2));
  r.put('pelvis', 'webbing', box(0.1, 0.11, 0.075), trs(0.13, -0.01, 0.115));
  r.put('pelvis', 'webbing', box(0.1, 0.11, 0.075), trs(-0.13, -0.01, 0.115));
  r.put('pelvis', 'webbing', box(0.09, 0.1, 0.07), trs(-0.16, -0.02, -0.06));

  /* chest. Origin at the lower ribs; the aim pivot sits on the shoulder line. */
  // The torso runs the whole way from inside the belt to the shoulder line. It
  // was worth measuring rather than eyeballing: at 0.34 long it left a 25 cm hole
  // between the pelvis mass and the ribs, which at 10 m is a body you can see
  // through.
  r.put('chest', 'uniform', tubeZ(0.15, 0.195, 0.56, 12).scale(1, 0.7, 1), trs(0, 0.02, 0, Math.PI / 2));
  r.put('chest', 'uniform', sph(0.107, 9, 7).scale(1, 0.86, 0.95), trs(0.196, 0.255, 0));
  r.put('chest', 'uniform', sph(0.107, 9, 7).scale(1, 0.86, 0.95), trs(-0.196, 0.255, 0));
  // Plate carrier: a hard-edged shell a size larger than the torso inside it.
  // The step where it ends above the waist is the strongest horizontal in the
  // whole silhouette, and it is what stops a soldier reading as a bollard.
  r.put('chest', 'gear', tubeZ(0.198, 0.208, 0.34, 12).scale(1, 0.66, 1), trs(0, 0.1, 0, Math.PI / 2));
  r.put('chest', 'gear', box(0.3, 0.3, 0.05), trs(0, 0.1, -0.145));
  r.put('chest', 'gear', box(0.3, 0.3, 0.05), trs(0, 0.1, 0.14));
  r.put('chest', 'webbing', box(0.085, 0.125, 0.06), trs(0, 0.09, -0.185));
  r.put('chest', 'webbing', box(0.085, 0.125, 0.06), trs(0.095, 0.085, -0.175));
  r.put('chest', 'webbing', box(0.075, 0.1, 0.055), trs(-0.1, 0.1, -0.17));
  r.put('chest', 'webbing', box(0.07, 0.055, 0.05), trs(0.135, 0.22, -0.1));
  // Shoulder straps, which give the neck something to come out of.
  r.put('chest', 'gear', box(0.085, 0.055, 0.2), trs(0.14, 0.285, -0.02));
  r.put('chest', 'gear', box(0.085, 0.055, 0.2), trs(-0.14, 0.285, -0.02));

  /* optional back kit, shown per loadout */
  r.put('kit_pack', 'gear', box(0.29, 0.32, 0.17), trs(0, 0.15, 0.21));
  r.put('kit_pack', 'webbing', box(0.24, 0.09, 0.03), trs(0, 0.06, 0.3));
  r.put('kit_pack', 'webbing', box(0.11, 0.13, 0.09), trs(0.1, 0.28, 0.24));
  r.limb('kit_antenna', 'gunmetal', [0.15, 0.28, 0.16], [0.19, 0.86, 0.31], 0.007, 0.004, 5);

  /* head: neck, skull, jaw. Origin at the neck base. */
  r.put('head', 'skin', tubeZ(0.055, 0.052, 0.1, 8), trs(0, 0.045, 0, Math.PI / 2));
  r.put('head', 'skin', sph(0.097, 10, 8).scale(0.92, 1.06, 1), trs(0, 0.155, 0));
  r.put('head', 'skin', sph(0.072, 8, 6).scale(0.88, 0.8, 0.9), trs(0, 0.115, -0.045));
  // Face wrap. Most of the head is covered on every loadout, which is both what
  // the reference looks like and what keeps a 4-pixel face from reading as a
  // bright pink dot on an otherwise dark figure.
  r.put('head', 'gear', sph(0.086, 9, 7).scale(0.99, 0.72, 0.99), trs(0, 0.1, -0.038));

  /* headgear: three mutually exclusive silhouettes over the same skull */
  r.put('hg_helmet', 'gear', dome(0.126, 12, 0.58).scale(1, 0.96, 1.07), trs(0, 0.152, 0.004));
  r.put('hg_helmet', 'gear', tubeZ(0.132, 0.128, 0.032, 12).scale(1, 1.06, 1), trs(0, 0.138, 0.004, Math.PI / 2));
  r.put('hg_helmet', 'gunmetal', box(0.055, 0.03, 0.045), trs(0, 0.205, -0.115));
  r.put('hg_helmet', 'webbing', box(0.018, 0.075, 0.016), trs(0.098, 0.1, -0.015));

  r.put('hg_cap', 'gear', dome(0.104, 10, 0.5).scale(1.02, 0.86, 1.04), trs(0, 0.168, 0.002));
  r.put('hg_cap', 'gear', box(0.145, 0.017, 0.085), trs(0, 0.163, -0.115, -0.12));

  r.put('hg_shemagh', 'webbing', sph(0.132, 10, 8).scale(1, 0.94, 1.04), trs(0, 0.158, 0.008));
  r.put('hg_shemagh', 'webbing', box(0.15, 0.2, 0.06), trs(0.025, 0.03, 0.105, 0.25, 0, 0.2));
  r.put('hg_shemagh', 'webbing', tubeZ(0.1, 0.115, 0.09, 9), trs(0, 0.055, 0.02, Math.PI / 2));

  /* arms. Origins at the shoulders, in the aim pivot's space. */
  r.limb('arm_r', 'uniform', [0, 0, 0], [0.06, -0.24, 0.02], 0.076, 0.058, 8);
  r.put('arm_r', 'uniform', sph(0.058, 8, 6), trs(0.06, -0.24, 0.02));
  r.limb('arm_r', 'uniform', [0.06, -0.24, 0.02], [-0.09, -0.14, -0.12], 0.058, 0.045, 8);
  r.put('arm_r', 'glove', box(0.07, 0.095, 0.085), trs(-0.11, -0.13, -0.145, 0.2, 0.3, 0));

  r.limb('arm_l', 'uniform', [0, 0, 0], [0.181, -0.137, -0.193], 0.076, 0.058, 8);
  r.put('arm_l', 'uniform', sph(0.058, 8, 6), trs(0.181, -0.137, -0.193));
  r.limb('arm_l', 'uniform', [0.181, -0.137, -0.193], [0.27, -0.095, -0.395], 0.058, 0.044, 8);
  r.put('arm_l', 'glove', box(0.065, 0.09, 0.1), trs(0.285, -0.09, -0.415, 0.1, -0.35, 0));

  /* the rifle. Origin at the trigger, muzzle toward -Z. */
  r.put('weapon', 'gunbody', box(0.048, 0.072, 0.29), trs(0, 0.03, -0.05));
  r.put('weapon', 'gunbody', tubeZ(0.027, 0.027, 0.075, 8), trs(0, 0.052, 0.13));
  r.put('weapon', 'gunbody', box(0.042, 0.012, 0.24), trs(0, 0.07, -0.05));
  r.put('weapon', 'gunmetal', tubeZ(0.03, 0.03, 0.24, 8), trs(0, 0.035, -0.31));
  r.put('weapon', 'gunmetal', tubeZ(0.011, 0.0095, 0.16, 7), trs(0, 0.035, -0.5));
  r.put('weapon', 'gunmetal', tubeZ(0.017, 0.015, 0.055, 8), trs(0, 0.035, -0.6));
  r.put('weapon', 'gunmetal', box(0.03, 0.055, 0.02), trs(0, 0.075, -0.42));
  // Grip and magazine. The magazine is two segments tipped forward because a
  // straight box hanging under a rifle is the giveaway of an untouched primitive.
  r.put('weapon', 'gunbody', box(0.034, 0.125, 0.045), trs(0, -0.055, 0.045, 0.3));
  r.put('weapon', 'gunbody', box(0.028, 0.115, 0.07), trs(0, -0.075, -0.045, 0.12));
  r.put('weapon', 'gunbody', box(0.028, 0.095, 0.065), trs(0, -0.17, -0.07, 0.34));
  r.put('weapon', 'gunbody', box(0.032, 0.03, 0.055), trs(0, -0.225, -0.09, 0.42));
  // Stock and optic: the two things that make the outline unmistakably a rifle
  // from behind and from the side respectively.
  r.put('weapon', 'gunbody', box(0.036, 0.055, 0.2), trs(0, 0.02, 0.21));
  r.put('weapon', 'gunbody', box(0.042, 0.085, 0.022), trs(0, 0.005, 0.315));
  r.put('weapon', 'gunmetal', box(0.03, 0.032, 0.085), trs(0, 0.098, -0.03));
  r.put('weapon', 'gunmetal', tubeZ(0.021, 0.021, 0.062, 8), trs(0, 0.118, -0.03));

  /* assembly */
  const root = new THREE.Group();
  root.name = 'enemy_soldier';

  const pelvis = r.build('pelvis');
  pelvis.position.set(0, 0.93, 0);
  root.add(pelvis);

  const thighL = r.build('thigh_l');
  thighL.position.set(-0.098, -0.02, 0);
  const shinL = r.build('shin_l');
  shinL.position.set(0, -0.44, 0);
  thighL.add(shinL);
  const thighR = r.build('thigh_r');
  thighR.position.set(0.098, -0.02, 0);
  const shinR = r.build('shin_r');
  shinR.position.set(0, -0.44, 0);
  thighR.add(shinR);
  pelvis.add(thighL, thighR);

  const chest = r.build('chest');
  chest.position.set(0, 0.3, 0);
  pelvis.add(chest);

  const head = r.build('head');
  head.position.set(0, 0.3, 0);
  chest.add(head);
  for (const name of HEADGEAR) head.add(r.build(name));
  for (const name of KIT) chest.add(r.build(name));

  const aim = new THREE.Group();
  aim.name = 'aim';
  aim.position.set(0, 0.2, 0);
  chest.add(aim);

  const armL = r.build('arm_l');
  armL.position.set(-0.2, 0, 0);
  const armR = r.build('arm_r');
  armR.position.set(0.2, 0, 0);
  const weapon = r.build('weapon');
  weapon.position.set(0.09, -0.1, -0.17);
  weapon.rotation.set(0, -0.09, 0.05);
  aim.add(armL, armR, weapon);

  // THE PART TABLE ON THE PROTOTYPE HOLDS NAMES, NOT OBJECTS, AND THAT IS LOAD
  // BEARING. `Object3D.copy` in three 0.180 does
  // `userData = JSON.parse(JSON.stringify(source.userData))`, and `JSON.stringify`
  // honours `toJSON` — so a table of live Object3Ds makes every clone serialise
  // the entire rig, materials and textures included. That is where the harness's
  // standing "THREE.Texture: Unable to serialize Texture" warnings come from, and
  // sixteen parts across four bodies would multiply them. `forge.mesh()` only ever
  // reads the *keys* off the prototype and re-resolves each one with
  // `getObjectByName` on the clone, so booleans carry exactly as much information
  // and cost nothing to copy.
  root.userData.parts = {};
  for (const name of [
    'pelvis',
    'chest',
    'head',
    'aim',
    'weapon',
    'arm_l',
    'arm_r',
    'thigh_l',
    'thigh_r',
    'shin_l',
    'shin_r',
    ...HEADGEAR,
    ...KIT,
  ]) {
    root.userData.parts[name] = true;
  }
  return root;
}
