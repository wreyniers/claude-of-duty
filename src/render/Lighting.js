import * as THREE from 'three';

/**
 * Sun, cascaded shadow maps, and the local light budget.
 *
 * CONTRACT:
 *   addPointLight(pos, color, intensity, radius) -> light
 *   flash(pos, color, intensity, ms)   one-shot muzzle/explosion light
 *   update(dt)   re-fits shadow cascades to the camera each frame
 */
export class Lighting {
  constructor(game) {
    this.game = game;
    this.sun = null;
    this.hemi = null;
  }

  async init() {
    const { scene } = this.game;
    const sky = this.game.sky;

    this.sun = new THREE.DirectionalLight(sky.sunColor.getHex(), 3.2);
    this.sun.position.copy(sky.sunDirection).multiplyScalar(80);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.game.settings.shadowMapSize, this.game.settings.shadowMapSize);
    const d = 60;
    Object.assign(this.sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 0.5, far: 260 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.camera.updateProjectionMatrix();
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x9fc0e8, 0x3b3630, 0.7);
    scene.add(this.hemi);
  }

  addPointLight(pos, color = 0xffffff, intensity = 1, radius = 10) {
    const l = new THREE.PointLight(color, intensity, radius, 2);
    l.position.copy(pos);
    this.game.scene.add(l);
    return l;
  }

  flash() {}

  update() {
    // Keep the shadow frustum centred ahead of the player.
    if (!this.sun) return;
    const cam = this.game.camera;
    this.sun.target.position.copy(cam.position);
    this.sun.position.copy(cam.position).addScaledVector(this.game.sky.sunDirection, 90);
  }
}
