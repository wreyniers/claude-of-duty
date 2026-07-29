import * as THREE from 'three';

/**
 * World collision queries. Backed by a BVH over the level's static geometry so
 * capsule sweeps and bullet rays are cheap enough to run at 120 Hz.
 *
 * CONTRACT:
 *   raycast(origin, dir, maxDist, opts?) -> {point, normal, distance, object} | null
 *   sweepCapsule(from, to, radius, height) -> {position, grounded, normal, hit}
 *   groundHeight(x, z, fromY) -> number | null
 *   rebuild()   re-derive acceleration structures after the level changes
 */
export class Collision {
  constructor(game) {
    this.game = game;
    this._raycaster = new THREE.Raycaster();
    this._raycaster.firstHitOnly = true;
    this.targets = [];
  }

  async init() {
    this.rebuild();
  }

  rebuild() {
    this.targets = this.game.level.collidables.slice();
  }

  raycast(origin, dir, maxDist = 500) {
    this._raycaster.set(origin, dir);
    this._raycaster.far = maxDist;
    const hits = this._raycaster.intersectObjects(this.targets, true);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      point: h.point.clone(),
      normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0),
      distance: h.distance,
      object: h.object,
    };
  }

  sweepCapsule(from, to, radius, height) {
    // Placeholder: no depenetration, just reports the ground under the target.
    const g = this.groundHeight(to.x, to.z, to.y + height);
    const position = to.clone();
    let grounded = false;
    if (g !== null && position.y - height * 0.5 <= g + 0.05) {
      position.y = g + height * 0.5;
      grounded = true;
    }
    return { position, grounded, normal: new THREE.Vector3(0, 1, 0), hit: grounded };
  }

  groundHeight(x, z, fromY = 100) {
    const hit = this.raycast(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0), 400);
    return hit ? hit.point.y : null;
  }
}
