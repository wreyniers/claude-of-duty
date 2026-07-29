import * as THREE from 'three';

/**
 * The playable map: geometry, props, spawn points, cover volumes.
 *
 * CONTRACT:
 *   root          : THREE.Group   everything collidable is under here
 *   spawnPoints   : [{position: Vector3, yaw: number}]
 *   enemySpawns   : [{position: Vector3}]
 *   bounds        : THREE.Box3
 *   collidables   : THREE.Object3D[]  meshes Collision should build a BVH over
 */
export class Level {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'level';
    this.spawnPoints = [{ position: new THREE.Vector3(0, 1.7, 8), yaw: 0 }];
    this.enemySpawns = [{ position: new THREE.Vector3(0, 1, -14) }];
    this.bounds = new THREE.Box3(new THREE.Vector3(-60, -2, -60), new THREE.Vector3(60, 30, 60));
    this.collidables = [];
  }

  async init() {
    const { scene, forge } = this.game;
    scene.add(this.root);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160, 1, 1),
      forge.material('default', { color: 0x6f6a63 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.root.add(ground);
    this.collidables.push(ground);

    // A couple of blocks so there is something to shoot at and hide behind.
    for (let i = 0; i < 6; i++) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(3, 3, 3),
        forge.material('default', { color: 0x7c766d })
      );
      box.position.set(Math.cos(i) * 12, 1.5, Math.sin(i * 1.7) * 12 - 6);
      box.castShadow = box.receiveShadow = true;
      this.root.add(box);
      this.collidables.push(box);
    }
  }

  update() {}
}
