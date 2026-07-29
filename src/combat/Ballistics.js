/**
 * Hitscan and projectile ballistics: spread cones, damage falloff over range,
 * per-hitbox multipliers, material penetration, tracers, impact VFX dispatch.
 *
 * CONTRACT:
 *   fireHitscan(origin, direction, weapon, opts?) -> hit info
 *   spawnProjectile(origin, velocity, def)
 *   registerHitbox(object, {owner, multiplier})
 */
export class Ballistics {
  constructor(game) {
    this.game = game;
    this.hitboxes = new Map();
  }

  async init() {}

  registerHitbox(object, info) {
    this.hitboxes.set(object, info);
  }

  fireHitscan(origin, direction, weapon) {
    const hit = this.game.collision.raycast(origin, direction, 400);
    if (hit) {
      this.game.decals.spawn('bullet', hit.point, hit.normal);
      this.game.particles.emit('impact', hit.point, hit.normal);
      const info = this.hitboxes.get(hit.object);
      if (info) {
        this.game.bus.emit('combat:hit', {
          target: info.owner,
          damage: (weapon?.damage ?? 25) * (info.multiplier ?? 1),
          point: hit.point,
        });
      }
    }
    return hit;
  }

  spawnProjectile() {}

  fixedUpdate() {}
}
