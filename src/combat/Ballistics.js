import * as THREE from 'three';

/**
 * Hitscan and projectile ballistics: damage falloff over range, per-hitbox
 * multipliers, material penetration, tracers, impact VFX dispatch.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * Two intersection problems are deliberately kept apart. The static world is a
 * BVH over triangles and is queried by `collision.raycast`; bodies are a handful
 * of registered boxes and are queried directly. Merging them would mean rebuilding
 * the BVH whenever anything moved, which for a dozen moving characters is far more
 * work than testing a dozen boxes. Whichever of the two is nearer wins, and that
 * ordering is the whole of "bullets do not pass through walls to hit someone".
 *
 * Damage is a function of range, not a constant, and the curve is per weapon:
 * full damage out to `near`, falling linearly to `floor` at `far`. That single
 * curve is what makes weapon choice mean anything, and it is why a submachine gun
 * loses an exchange it started at forty metres.
 *
 * Penetration is one pass-through, not a general solve. A round that hits a
 * surface tagged thin continues with its damage scaled by the weapon's
 * penetration, once. Recursion here buys nothing a player can perceive and costs
 * a query per bounce.
 *
 * CONTRACT:
 *   fireHitscan(origin, direction, weapon, opts?) -> hit info
 *   spawnProjectile(origin, velocity, def)
 *   registerHitbox(object, {owner, multiplier})
 *
 * ADDITIONS (safe to rely on):
 *   unregisterHitbox(object)
 *   projectiles : live projectile list
 *   bus events: combat:hit, combat:impact, combat:explosion
 */

const MAX_RANGE = 400;

export class Ballistics {
  constructor(game) {
    this.game = game;
    this.hitboxes = new Map();
    this.projectiles = [];

    this._ray = new THREE.Ray();
    this._box = new THREE.Box3();
    this._invMatrix = new THREE.Matrix4();
    this._localRay = new THREE.Ray();
    this._point = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._continueFrom = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
    this._result = {
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      distance: 0,
      object: null,
      owner: null,
      damage: 0,
      penetrated: false,
      zone: 'world',
    };
  }

  async init() {}

  registerHitbox(object, info) {
    this.hitboxes.set(object, info);
  }

  unregisterHitbox(object) {
    this.hitboxes.delete(object);
  }

  /**
   * Damage at a given range. Linear between the two stated distances, because a
   * curve nobody can name is a curve nobody can balance against.
   */
  damageAtRange(weapon, distance) {
    const f = weapon?.falloff;
    const base = weapon?.damage ?? 25;
    if (!f) return base;
    if (distance <= f.near) return base;
    if (distance >= f.far) return f.floor;
    const t = (distance - f.near) / (f.far - f.near);
    return base + (f.floor - base) * t;
  }

  /**
   * Nearest registered body along the ray, or null. Boxes are tested in their own
   * local space so a rotated character is not given an axis-aligned hull.
   */
  _castBodies(origin, direction, maxDist, ignoreOwner) {
    let best = null;
    let bestDist = maxDist;
    for (const [object, info] of this.hitboxes) {
      if (!object.visible || (ignoreOwner && info.owner === ignoreOwner)) continue;
      const geo = object.geometry;
      if (!geo) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      object.updateWorldMatrix(true, false);
      this._invMatrix.copy(object.matrixWorld).invert();
      this._localRay.set(origin, direction).applyMatrix4(this._invMatrix);
      const hit = this._localRay.intersectBox(geo.boundingBox, this._point);
      if (!hit) continue;
      this._point.applyMatrix4(object.matrixWorld);
      const d = origin.distanceTo(this._point);
      if (d >= bestDist) continue;
      bestDist = d;
      best = { object, info, distance: d, point: this._point.clone() };
    }
    return best;
  }

  /**
   * Trace one round. Returns the populated shared result object, or null if the
   * round hit nothing — read it before firing again.
   */
  fireHitscan(origin, direction, weapon, opts = {}) {
    const range = opts.range ?? MAX_RANGE;
    const world = this.game.collision?.raycast(origin, direction, range) ?? null;
    const body = this._castBodies(origin, direction, world ? world.distance : range, opts.shooter);

    if (opts.tracer) {
      const end = this._scratch
        .copy(origin)
        .addScaledVector(direction, body ? body.distance : world ? world.distance : range);
      this.game.particles?.emit('tracer', origin, direction, { length: origin.distanceTo(end) });
    }

    // A body in front of the wall wins; a wall in front of the body stops the
    // round. This ordering is the whole of "no shooting through cover".
    if (body) {
      const r = this._result;
      r.point.copy(body.point);
      r.normal.copy(direction).negate();
      r.distance = body.distance;
      r.object = body.object;
      r.owner = body.info.owner ?? null;
      r.zone = body.info.zone ?? 'torso';
      const zoneMul =
        body.info.multiplier ??
        (r.zone === 'head' ? weapon?.headMultiplier ?? 1.5 : r.zone === 'limb' ? weapon?.limbMultiplier ?? 0.9 : 1);
      r.damage = this.damageAtRange(weapon, body.distance) * zoneMul * (opts.damageScale ?? 1);
      r.penetrated = !!opts.penetrated;

      this.game.particles?.emit('blood', r.point, r.normal);
      this.game.bus.emit('combat:hit', {
        target: r.owner,
        object: r.object,
        damage: r.damage,
        zone: r.zone,
        point: r.point,
        distance: r.distance,
        shooter: opts.shooter ?? null,
      });
      return r;
    }

    if (!world) return null;

    const surface = world.object?.userData?.surface ?? 'concrete';
    this.game.decals?.spawn('bullet', world.point, world.normal, { surface });
    this.game.particles?.emit('impact', world.point, world.normal, { surface });
    this.game.audio?.playAt('impact', world.point, { surface });
    this.game.bus.emit('combat:impact', { point: world.point, normal: world.normal, surface, shooter: opts.shooter ?? null });

    // One pass-through, and only through something tagged thin. Start the
    // continuation a little past the surface so it cannot re-hit the same
    // triangle it just came out of.
    const pen = weapon?.penetration ?? 0;
    if (pen > 0 && world.object?.userData?.thin && !opts.penetrated) {
      this._continueFrom.copy(world.point).addScaledVector(direction, 0.06);
      return this.fireHitscan(this._continueFrom, direction, weapon, {
        ...opts,
        penetrated: true,
        tracer: false,
        range: range - world.distance,
        damageScale: (opts.damageScale ?? 1) * pen,
      });
    }

    const r = this._result;
    r.point.copy(world.point);
    r.normal.copy(world.normal);
    r.distance = world.distance;
    r.object = world.object;
    r.owner = null;
    r.zone = 'world';
    r.damage = 0;
    r.penetrated = !!opts.penetrated;
    return r;
  }

  /**
   * Grenades and anything else that flies. Integrated in the fixed step and swept
   * against the world each step rather than point-tested, so a fast projectile
   * cannot pass through a wall between two positions.
   */
  spawnProjectile(origin, velocity, def = {}) {
    const p = {
      position: origin.clone(),
      velocity: velocity.clone(),
      prev: origin.clone(),
      fuse: def.fuse ?? 3,
      radius: def.radius ?? 0.06,
      bounce: def.bounce ?? 0.32,
      gravity: def.gravity ?? 18,
      damage: def.damage ?? 120,
      blastRadius: def.blastRadius ?? 6,
      kind: def.kind ?? 'grenade',
      alive: true,
    };
    this.projectiles.push(p);
    return p;
  }

  _explode(p) {
    p.alive = false;
    this.game.particles?.emit('explosion', p.position, this._normal.set(0, 1, 0), { radius: p.blastRadius });
    this.game.audio?.playAt('explosion', p.position);
    this.game.bus.emit('combat:explosion', { point: p.position, radius: p.blastRadius, damage: p.damage });

    // Falls off with the square of distance and needs line of sight, so cover
    // actually protects — a flat radius check would make walls decorative.
    const player = this.game.player;
    const targets = [];
    if (player) targets.push({ owner: 'player', position: this._scratch.copy(player.position).setY(player.position.y + 0.9) });
    for (const e of this.game.ai?.enemies ?? []) {
      if (e.position) targets.push({ owner: e, position: e.position });
    }
    for (const t of targets) {
      const d = p.position.distanceTo(t.position);
      if (d > p.blastRadius) continue;
      if (this.game.collision && !this.game.collision.segmentClear(p.position, t.position)) continue;
      const falloff = 1 - (d / p.blastRadius) ** 2;
      const dmg = p.damage * falloff;
      if (t.owner === 'player') {
        this.game.player.damage(dmg, this._scratch.copy(p.position).sub(t.position).normalize());
      } else {
        this.game.bus.emit('combat:hit', { target: t.owner, damage: dmg, zone: 'blast', point: t.position, shooter: 'blast' });
      }
    }
  }

  fixedUpdate(dt) {
    const col = this.game.collision;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.fuse -= dt;
      p.prev.copy(p.position);
      p.velocity.y -= p.gravity * dt;
      this._scratch.copy(p.velocity).multiplyScalar(dt);
      const step = this._scratch.length();

      if (col && step > 1e-5) {
        this._normal.copy(this._scratch).divideScalar(step);
        const hit = col.raycast(p.prev, this._normal, step + p.radius);
        if (hit) {
          // Reflect and lose energy. Grenades that slide to a stop rather than
          // pinballing are what make a bank shot around a corner predictable.
          p.position.copy(hit.point).addScaledVector(hit.normal, p.radius);
          const into = p.velocity.dot(hit.normal);
          p.velocity.addScaledVector(hit.normal, -2 * into).multiplyScalar(p.bounce);
          this.game.audio?.playAt('grenade_bounce', p.position);
        } else {
          p.position.add(this._scratch);
        }
      } else {
        p.position.add(this._scratch);
      }

      if (p.fuse <= 0) {
        this._explode(p);
        this.projectiles.splice(i, 1);
      }
    }
  }
}
