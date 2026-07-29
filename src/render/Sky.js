import * as THREE from 'three';

/**
 * Sky dome, sun position, atmospheric fog and the environment map used for IBL.
 *
 * CONTRACT:
 *   sunDirection : THREE.Vector3   unit vector pointing at the sun
 *   sunColor     : THREE.Color
 *   ambientColor : THREE.Color
 *   envMap       : THREE.Texture   assigned to scene.environment
 *   setTimeOfDay(t01)
 */
export class Sky {
  constructor(game) {
    this.game = game;
    this.sunDirection = new THREE.Vector3(-0.45, 0.62, 0.38).normalize();
    this.sunColor = new THREE.Color(0xffe9c9);
    this.ambientColor = new THREE.Color(0x5a6b82);
    this.envMap = null;
  }

  async init() {
    const scene = this.game.scene;
    scene.background = new THREE.Color(0x8fa9c4);
    scene.fog = new THREE.FogExp2(0x9db2c6, 0.008);
  }

  setTimeOfDay() {}

  update() {}
}
