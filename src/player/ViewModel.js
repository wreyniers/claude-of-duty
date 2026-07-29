import * as THREE from 'three';
import { LAYER_VIEWMODEL } from '../core/Layers.js';

/**
 * The first-person arms + weapon rig: idle sway, walk bob, ADS transition, recoil
 * animation, reload animation, sprint cant, weapon lowering near walls.
 *
 * Lives in `game.viewmodelScene` on LAYER_VIEWMODEL, rendered by a second camera.
 *
 * CONTRACT:
 *   root : THREE.Group   local space, +Z is toward the player
 *   playAnim(name)
 */
export class ViewModel {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
  }

  async init() {
    const { viewmodelScene } = this.game;
    this.root.traverse((o) => o.layers.set(LAYER_VIEWMODEL));
    viewmodelScene.add(this.root);

    // View model lighting is separate from the world so the gun always reads well.
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-0.6, 1, 0.8);
    key.layers.set(LAYER_VIEWMODEL);
    const fill = new THREE.AmbientLight(0x8899aa, 0.9);
    fill.layers.set(LAYER_VIEWMODEL);
    viewmodelScene.add(key, fill);
  }

  playAnim() {}

  update() {
    const cam = this.game.engine.viewmodelCamera;
    // Keep the rig parented to the camera in world space.
    this.root.position.copy(cam.position);
    this.root.quaternion.copy(cam.quaternion);
  }
}
