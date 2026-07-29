import * as THREE from 'three';

/**
 * Player movement and the first-person camera.
 *
 * CONTRACT:
 *   position   : Vector3   feet position
 *   velocity   : Vector3
 *   yaw, pitch : number    radians
 *   state      : 'stand'|'crouch'|'prone'|'slide'|'air'|'mantle'
 *   speed      : number    current horizontal speed (HUD + viewmodel sway read this)
 *   health, maxHealth
 *   eyeHeight  : number
 *   damage(amount, fromDirection)
 *   isAds      : boolean
 */
export class Player {
  constructor(game) {
    this.game = game;
    this.position = new THREE.Vector3(0, 0, 8);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.state = 'stand';
    this.speed = 0;
    this.health = 100;
    this.maxHealth = 100;
    this.eyeHeight = 1.62;
    this.radius = 0.36;
    this.isAds = false;
    this.isSprinting = false;
  }

  async init() {
    const spawn = this.game.level.spawnPoints[0];
    if (spawn) {
      this.position.copy(spawn.position);
      this.position.y -= this.eyeHeight;
      this.yaw = spawn.yaw ?? 0;
    }
  }

  damage(amount) {
    this.health = Math.max(0, this.health - amount);
    this.game.bus.emit('player:damaged', { amount, health: this.health });
    if (this.health <= 0) this.game.bus.emit('player:died');
  }

  fixedUpdate(dt) {
    const input = this.game.input;
    const move = input.moveAxis();

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3()
      .addScaledVector(forward, move.y)
      .addScaledVector(right, move.x);
    if (wish.lengthSq() > 0) wish.normalize();

    this.isSprinting = input.action('sprint') && move.y > 0.1;
    const target = this.isSprinting ? 7.2 : 4.6;

    this.velocity.x = THREE.MathUtils.damp(this.velocity.x, wish.x * target, 12, dt);
    this.velocity.z = THREE.MathUtils.damp(this.velocity.z, wish.z * target, 12, dt);
    this.velocity.y -= 22 * dt;

    const next = this.position.clone().addScaledVector(this.velocity, dt);
    const swept = this.game.collision.sweepCapsule(
      this.position.clone().setY(this.position.y + 0.9),
      next.clone().setY(next.y + 0.9),
      this.radius,
      1.8
    );
    if (swept.grounded) {
      this.position.set(swept.position.x, swept.position.y - 0.9, swept.position.z);
      this.velocity.y = 0;
      if (input.action('jump')) this.velocity.y = 7.6;
    } else {
      this.position.copy(next);
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  update() {
    const input = this.game.input;
    this.isAds = input.mouse.right;

    const look = input.consumeLook(this.isAds ? input.adsSensitivityScale : 1);
    this.yaw -= look.x;
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.y, -1.5, 1.5);

    const cam = this.game.camera;
    cam.position.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
