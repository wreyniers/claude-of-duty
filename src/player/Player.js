import * as THREE from 'three';

/**
 * Player movement and the first-person camera.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * The velocity model is the Quake/Source lineage that every modern shooter still
 * uses, because it is the only one that feels right: acceleration is applied
 * along the wish direction proportionally to how much of the target speed is not
 * yet accounted for in that direction. That single rule gives instant-feeling
 * ground response, air control that rewards strafing, and no hard velocity
 * clamp that would make diagonal motion snap.
 *
 * Stance is a capsule height, not a flag. Crouch, slide and stand differ only in
 * `stanceHeight` / `eyeHeight`, so collision, camera and the view model all read
 * one number and stay in agreement — and standing up is refused when the sweep
 * says the ceiling is too low instead of clipping the head through it.
 *
 * Everything that the eye can see is separated from everything the simulation
 * needs. `fixedUpdate` owns position and velocity at a deterministic 120 Hz;
 * `update` owns the camera and does the bob, lean, view punch and landing dip,
 * interpolating the sim position by `time.alpha` so a 300 Hz display shows 300
 * distinct camera positions rather than 120 stepped ones.
 *
 * Nothing here allocates: every intermediate is a preallocated field, because
 * this runs 120 times a second forever and a Vector3 per step is 120 garbage
 * objects a second for no reason.
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
 *
 * ADDITIONS (safe to rely on):
 *   punch(pitch, yaw, roll)   weapon recoil into the view; springs back
 *   forward / rightVec        unit basis for this frame, updated in fixedUpdate
 *   grounded, isSprinting, isTacSprinting
 *   stanceHeight              full capsule height for the current stance
 *   moveSpeedScale            0..1, what fraction of walk speed the stance allows
 *   lastHitDirection          Vector3, world-space, for the HUD damage indicator
 *   bus events: player:jump, player:land, player:footstep, player:slide,
 *               player:mantle, player:stance, player:damaged, player:died
 */

const GRAVITY = 22;
const JUMP_SPEED = 6.4;

// Target speeds in m/s. Sprint is the CoD "sprint"; tac sprint is the faster
// gun-down state that costs you the ability to fire.
const SPEED_WALK = 4.2;
const SPEED_SPRINT = 6.5;
const SPEED_TAC = 8.1;
const SPEED_CROUCH = 2.1;
const SPEED_ADS = 2.9;
const SPEED_AIR = 4.2;

const ACCEL_GROUND = 95;
const ACCEL_AIR = 16;
const FRICTION = 9.5;
const STOP_SPEED = 1.3;

const STANCE = {
  stand: { height: 1.8, eye: 1.62 },
  crouch: { height: 1.2, eye: 1.04 },
  slide: { height: 1.0, eye: 0.82 },
};

const SLIDE_ENTRY_SPEED = 9.2;
const SLIDE_MIN_TIME = 0.22;
const SLIDE_MAX_TIME = 1.05;
const SLIDE_FRICTION = 2.9;
const SLIDE_REQUIRED_SPEED = 5.2;

const MANTLE_MIN_HEIGHT = 0.42;
const MANTLE_MAX_HEIGHT = 1.75;

// Below this landing speed a drop is free; above the top of the range it is
// fatal. Both ends are generous — punishing a 3 m drop makes a level feel like
// it is made of glass.
const FALL_DAMAGE_MIN_SPEED = 9.5;
const FALL_DAMAGE_MAX_SPEED = 23;

const REGEN_DELAY = 4.5;
const REGEN_RATE = 28;

export class Player {
  constructor(game) {
    this.game = game;

    this.position = new THREE.Vector3(0, 0, 8);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.state = 'stand';
    this.stance = 'stand';
    this.stanceHeight = STANCE.stand.height;
    this.eyeHeight = STANCE.stand.eye;
    this.radius = 0.36;

    this.speed = 0;
    this.grounded = true;
    this.groundNormal = new THREE.Vector3(0, 1, 0);

    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    this.lastHitDirection = new THREE.Vector3();
    this._timeSinceDamage = 999;

    this.isAds = false;
    this.isSprinting = false;
    this.isTacSprinting = false;
    this.moveSpeedScale = 1;

    this.forward = new THREE.Vector3(0, 0, -1);
    this.rightVec = new THREE.Vector3(1, 0, 0);

    // Interpolation endpoints. The camera reads between these, so a render at
    // any rate lands on a real position instead of the last sim tick's.
    this._prevPos = new THREE.Vector3(0, 0, 8);
    this._prevEye = this.eyeHeight;

    this._slideTime = 0;
    this._slideDir = new THREE.Vector3();
    this._sprintHeld = 0;
    this._sinceGrounded = 0;
    this._sinceJump = 999;
    this._crouchHeld = false;
    this._wantJump = false;
    this._wantCrouchEdge = false;
    this._fallSpeed = 0;

    // Mantle is a scripted arc, not a force: the whole point is that it is
    // guaranteed to clear the ledge.
    this._mantle = { active: false, t: 0, dur: 0.34, from: new THREE.Vector3(), to: new THREE.Vector3() };

    // View-only springs, all in radians/metres, all critically damped.
    this._punch = new THREE.Vector3();
    this._punchVel = new THREE.Vector3();
    this._landDip = 0;
    this._landDipVel = 0;
    this._bobPhase = 0;
    this._stepPhase = 0;
    this._lean = 0;
    this._camEye = this.eyeHeight;

    this._wish = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._probeA = new THREE.Vector3();
    this._probeB = new THREE.Vector3();
    this._probeDir = new THREE.Vector3();
    this._sweptPos = new THREE.Vector3();
    this._flat = new THREE.Vector3();
  }

  async init() {
    const spawn = this.game.level?.spawnPoints?.[0];
    if (spawn) {
      this.position.copy(spawn.position);
      this.position.y -= this.eyeHeight;
      this.yaw = spawn.yaw ?? 0;
    }
    this._prevPos.copy(this.position);
    this._syncBasis();
  }

  damage(amount, fromDirection) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this._timeSinceDamage = 0;
    if (fromDirection) this.lastHitDirection.copy(fromDirection);
    this.game.bus.emit('player:damaged', { amount, health: this.health, direction: this.lastHitDirection });
    if (this.health <= 0) {
      this.alive = false;
      this.game.bus.emit('player:died');
    }
  }

  /** Weapon recoil and explosions push the view; it springs back on its own. */
  punch(pitch = 0, yaw = 0, roll = 0) {
    this._punchVel.x += pitch;
    this._punchVel.y += yaw;
    this._punchVel.z += roll;
  }

  _syncBasis() {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    this.forward.set(-s, 0, -c);
    this.rightVec.set(c, 0, -s);
  }

  /**
   * Source-style acceleration: add speed along the wish direction only in
   * proportion to how much of the target is not already there. Capping the added
   * speed at the deficit is what stops diagonal input exceeding the target while
   * still letting an air strafe redirect momentum.
   */
  _accelerate(wishX, wishZ, targetSpeed, accel, dt) {
    const current = this.velocity.x * wishX + this.velocity.z * wishZ;
    const deficit = targetSpeed - current;
    if (deficit <= 0) return;
    const add = Math.min(accel * targetSpeed * dt, deficit);
    this.velocity.x += wishX * add;
    this.velocity.z += wishZ * add;
  }

  _applyFriction(dt, coeff) {
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp < 0.001) {
      this.velocity.x = this.velocity.z = 0;
      return;
    }
    // Friction below the stop speed is computed against the stop speed, not the
    // actual speed, so the last fraction of a metre per second dies quickly
    // instead of trailing off asymptotically into a permanent slow drift.
    const control = sp < STOP_SPEED ? STOP_SPEED : sp;
    const drop = control * coeff * dt;
    const scale = Math.max(0, sp - drop) / sp;
    this.velocity.x *= scale;
    this.velocity.z *= scale;
  }

  /** Target speed for the current stance and modifiers, and the HUD's scale. */
  _targetSpeed() {
    if (this.stance === 'crouch') return SPEED_CROUCH;
    if (this.isAds) return SPEED_ADS;
    if (this.isTacSprinting) return SPEED_TAC;
    if (this.isSprinting) return SPEED_SPRINT;
    return SPEED_WALK;
  }

  _setStance(name) {
    if (this.stance === name) return;
    this.stance = name;
    this.stanceHeight = STANCE[name].height;
    this.eyeHeight = STANCE[name].eye;
    this.game.bus.emit('player:stance', { stance: name });
  }

  /** True when the capsule for `name` fits where we are standing right now. */
  _stanceFits(name) {
    const h = STANCE[name].height;
    const centre = this.position.y + h * 0.5;
    this._from.set(this.position.x, centre, this.position.z);
    this._to.copy(this._from);
    const r = this.game.collision.sweepCapsule(this._from, this._to, this.radius, h);
    // A resolved position that had to move means the capsule was interpenetrating
    // something — i.e. there is no room to grow into.
    return r.position.distanceToSquared(this._to) < 0.0025;
  }

  fixedUpdate(dt) {
    if (!this.game.collision) return;
    this._prevPos.copy(this.position);
    this._prevEye = this.eyeHeight;
    this._syncBasis();

    const input = this.game.input;
    // Edge-triggered input has to be latched: a frame runs up to eight fixed
    // steps and `pressedThisFrame` stays set for all of them, so reading it
    // directly would fire a jump eight times.
    const jumpEdge = input.actionPressed('jump') && !this._wantJump;
    if (jumpEdge) this._wantJump = true;
    const crouchDown = input.action('crouch');
    const crouchEdge = crouchDown && !this._crouchHeld;
    this._crouchHeld = crouchDown;

    this._timeSinceDamage += dt;
    if (this.alive && this.health < this.maxHealth && this._timeSinceDamage > REGEN_DELAY) {
      this.health = Math.min(this.maxHealth, this.health + REGEN_RATE * dt);
    }

    if (this._mantle.active) {
      this._stepMantle(dt);
      this.speed = Math.hypot(this.velocity.x, this.velocity.z);
      return;
    }

    const move = input.moveAxis();
    this._wish
      .set(0, 0, 0)
      .addScaledVector(this.forward, move.y)
      .addScaledVector(this.rightVec, move.x);
    const wishLen = Math.hypot(this._wish.x, this._wish.z);
    const wishX = wishLen > 0 ? this._wish.x / wishLen : 0;
    const wishZ = wishLen > 0 ? this._wish.z / wishLen : 0;

    this.isAds = input.mouse.right && this.stance !== 'slide';
    const wantsSprint = input.action('sprint') && move.y > 0.35 && !this.isAds;
    this.isSprinting = wantsSprint && this.grounded && this.stance !== 'crouch';
    // Tac sprint is the tail of a held sprint, so it takes a moment of committed
    // forward running to reach — you cannot tap into it.
    this.isTacSprinting = this.isSprinting && this._sprintHeld > 0.55 && Math.abs(move.x) < 0.4;
    this._sprintHeld = wantsSprint ? (this._sprintHeld || 0) + dt : 0;

    if (this.stance === 'slide') this._stepSlide(dt, crouchDown);
    else if (crouchEdge && this.grounded && this.speed > SLIDE_REQUIRED_SPEED && this.isSprinting) this._startSlide();
    else if (crouchDown) this._setStance('crouch');
    else if (this.stance === 'crouch' && this._stanceFits('stand')) this._setStance('stand');

    if (this.stance !== 'slide') {
      if (this.grounded) {
        if (wishLen > 0) {
          this._applyFriction(dt, FRICTION * 0.35);
          this._accelerate(wishX, wishZ, this._targetSpeed(), ACCEL_GROUND, dt);
        } else {
          this._applyFriction(dt, FRICTION);
        }
      } else {
        // Air control: a small accel along the wish direction, which is what
        // lets a jump be steered without turning the air into a second ground.
        this._accelerate(wishX, wishZ, SPEED_AIR, ACCEL_AIR, dt);
      }
    }

    this.moveSpeedScale = this._targetSpeed() / SPEED_WALK;

    if (this._wantJump && this._trySpecialJump()) {
      // The arc owns position from here; falling through to gravity and the
      // sweep would fight the endpoints it just captured.
      this._wantJump = false;
      this.speed = 0;
      return;
    }
    if (this._wantJump && this.grounded && this._sinceJump > 0.12) {
      if (this.stance === 'slide') this._endSlide();
      if (this.stance === 'crouch' && this._stanceFits('stand')) this._setStance('stand');
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
      this._sinceJump = 0;
      this._wantJump = false;
      this.game.bus.emit('player:jump', { position: this.position });
    } else if (this._sinceGrounded > 0.2) {
      // Drop a buffered jump rather than firing it late, mid-fall.
      this._wantJump = false;
    }

    this._sinceJump += dt;
    this.velocity.y -= GRAVITY * dt;
    if (this.velocity.y < -60) this.velocity.y = -60;
    if (this.velocity.y < 0) this._fallSpeed = -this.velocity.y;

    const half = this.stanceHeight * 0.5;
    this._from.set(this.position.x, this.position.y + half, this.position.z);
    this._to.set(
      this.position.x + this.velocity.x * dt,
      this.position.y + half + this.velocity.y * dt,
      this.position.z + this.velocity.z * dt
    );

    const swept = this.game.collision.sweepCapsule(this._from, this._to, this.radius, this.stanceHeight);
    // The sweep result object is reused by the next query, so copy out now.
    this._sweptPos.copy(swept.position);
    const wasGrounded = this.grounded;
    const nowGrounded = swept.grounded;
    if (swept.normal) this.groundNormal.copy(swept.normal);

    // Kill velocity into whatever we hit rather than letting it accumulate: a
    // wall we are pressed against must not build up a shove that fires us out
    // sideways the moment the wall ends.
    if (swept.hit && swept.normal) {
      const into = this.velocity.dot(swept.normal);
      if (into < 0) this.velocity.addScaledVector(swept.normal, -into);
    }

    this.position.set(this._sweptPos.x, this._sweptPos.y - half, this._sweptPos.z);

    if (nowGrounded) {
      if (this.velocity.y < 0) this.velocity.y = 0;
      this._sinceGrounded = 0;
      if (!wasGrounded) this._land();
    } else {
      this._sinceGrounded += dt;
    }
    this.grounded = nowGrounded;
    this.state = this._mantle.active
      ? 'mantle'
      : !this.grounded
        ? 'air'
        : this.stance === 'slide'
          ? 'slide'
          : this.stance;

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this._advanceFootsteps(dt);
  }

  _land() {
    const impact = this._fallSpeed;
    this._fallSpeed = 0;
    // Dip proportional to impact, so stepping off a kerb is not the same event
    // as falling off a roof.
    this._landDipVel -= Math.min(impact * 0.06, 0.85);
    this.game.bus.emit('player:land', { position: this.position, impact, stance: this.stance });
    if (impact > FALL_DAMAGE_MIN_SPEED) {
      const t = (impact - FALL_DAMAGE_MIN_SPEED) / (FALL_DAMAGE_MAX_SPEED - FALL_DAMAGE_MIN_SPEED);
      this.damage(Math.min(100, 12 + t * t * 110));
    }
    // Landing out of a sprint into held crouch continues into a slide, which is
    // what makes dropping off a balcony into cover feel continuous.
    if (this._crouchHeld && this.speed > SLIDE_REQUIRED_SPEED) this._startSlide();
  }

  _startSlide() {
    const sp = Math.max(this.speed, 0.001);
    this._slideDir.set(this.velocity.x / sp, 0, this.velocity.z / sp);
    const boost = Math.max(SLIDE_ENTRY_SPEED, sp);
    this.velocity.x = this._slideDir.x * boost;
    this.velocity.z = this._slideDir.z * boost;
    this._slideTime = 0;
    this._setStance('slide');
    this.game.bus.emit('player:slide', { position: this.position, speed: boost });
  }

  _endSlide() {
    this._setStance(this._crouchHeld || !this._stanceFits('stand') ? 'crouch' : 'stand');
  }

  _stepSlide(dt, crouchHeld) {
    this._slideTime += dt;
    // Slope-aware: sliding downhill sustains, uphill dies fast. Gravity along
    // the ground plane is exactly the right term for that.
    const slope = -this.groundNormal.x * this._slideDir.x - this.groundNormal.z * this._slideDir.z;
    const along = slope * GRAVITY * 0.55;
    const sp = Math.max(0, Math.hypot(this.velocity.x, this.velocity.z) - SLIDE_FRICTION * dt + along * dt);
    this.velocity.x = this._slideDir.x * sp;
    this.velocity.z = this._slideDir.z * sp;
    const expired = this._slideTime > SLIDE_MAX_TIME || sp < SPEED_CROUCH * 1.1;
    if (this._slideTime > SLIDE_MIN_TIME && (expired || !crouchHeld || !this.grounded)) this._endSlide();
  }

  /**
   * Mantling and vaulting. Both are the same probe: find a wall in front, find
   * its top, confirm the body fits up there, then play a fixed arc to it. Doing
   * it as an arc rather than an impulse is what guarantees you never fail a
   * ledge you were clearly aiming at.
   */
  _trySpecialJump() {
    const col = this.game.collision;
    const chest = this.position.y + Math.min(0.9, this.stanceHeight * 0.5);
    this._probeA.set(this.position.x, chest, this.position.z);
    this._probeDir.copy(this.forward);
    const wall = col.raycast(this._probeA, this._probeDir, this.radius + 0.55);
    if (!wall || Math.abs(wall.normal.y) > 0.45) return false;

    // Probe down from above the ledge, a little past the face, for its top.
    this._probeB
      .copy(wall.point)
      .addScaledVector(this.forward, 0.42)
      .setY(this.position.y + MANTLE_MAX_HEIGHT + 0.35);
    this._probeDir.set(0, -1, 0);
    const top = col.raycast(this._probeB, this._probeDir, MANTLE_MAX_HEIGHT + 0.5);
    if (!top || top.normal.y < 0.72) return false;

    const rise = top.point.y - this.position.y;
    if (rise < MANTLE_MIN_HEIGHT || rise > MANTLE_MAX_HEIGHT) return false;

    const h = STANCE.stand.height;
    this._to.set(top.point.x, top.point.y + h * 0.5 + 0.02, top.point.z);
    this._from.copy(this._to);
    const fit = col.sweepCapsule(this._from, this._to, this.radius * 0.92, h);
    if (fit.position.distanceToSquared(this._to) > 0.004) return false;

    this._mantle.active = true;
    this._mantle.t = 0;
    // Taller ledges take longer, both because it reads as effort and because a
    // fixed duration makes a 1.7 m mantle look like teleporting.
    this._mantle.dur = 0.26 + rise * 0.12;
    this._mantle.from.copy(this.position);
    this._mantle.to.set(this._to.x, top.point.y + 0.02, this._to.z);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this._setStance('stand');
    this.game.bus.emit('player:mantle', { from: this._mantle.from, to: this._mantle.to, rise });
    return true;
  }

  _stepMantle(dt) {
    const m = this._mantle;
    m.t += dt;
    const k = Math.min(1, m.t / m.dur);
    // Up first, then forward: hands on the ledge, then the body over it. A
    // straight lerp reads as floating diagonally through the corner.
    const up = Math.min(1, k * 1.55);
    const fwd = k * k * (3 - 2 * k);
    this.position.x = m.from.x + (m.to.x - m.from.x) * fwd;
    this.position.z = m.from.z + (m.to.z - m.from.z) * fwd;
    this.position.y = m.from.y + (m.to.y - m.from.y) * (up * up * (3 - 2 * up));
    if (k >= 1) {
      m.active = false;
      this.grounded = true;
      this._sinceGrounded = 0;
      this._fallSpeed = 0;
      this.state = 'stand';
    }
  }

  /**
   * Footsteps are distance-based, not time-based, so they stay in step with the
   * legs at any speed and never machine-gun when you shuffle against a wall.
   */
  _advanceFootsteps(dt) {
    if (!this.grounded || this.stance === 'slide') return;
    const travelled = this.speed * dt;
    if (this.speed < 0.6) return;
    const stride = this.stance === 'crouch' ? 1.15 : this.isSprinting ? 2.05 : 1.72;
    this._stepPhase += travelled / stride;
    if (this._stepPhase >= 1) {
      this._stepPhase -= 1;
      this.game.bus.emit('player:footstep', {
        position: this.position,
        speed: this.speed,
        stance: this.stance,
        sprinting: this.isSprinting,
        // Surface identity is the ground triangle's owner; audio maps it to a
        // material without needing to know anything about the level.
        surface: this.game.collision.raycast(
          this._probeA.set(this.position.x, this.position.y + 0.35, this.position.z),
          this._probeDir.set(0, -1, 0),
          0.7
        )?.object?.userData?.surface,
      });
    }
  }

  update(dt, elapsed, paused) {
    const input = this.game.input;
    if (!paused && this.alive) {
      const look = input.consumeLook(this.isAds ? input.adsSensitivityScale : 1);
      this.yaw -= look.x;
      this.pitch = THREE.MathUtils.clamp(this.pitch - look.y, -1.52, 1.52);
    } else {
      input.consumeLook();
    }

    // Critically damped springs: fast return, no ringing. Recoil that oscillates
    // reads as a bug, not as weight.
    const punchK = 190;
    const punchD = 2 * Math.sqrt(punchK);
    this._punchVel.addScaledVector(this._punch, -punchK * dt);
    this._punchVel.multiplyScalar(Math.max(0, 1 - punchD * dt));
    this._punch.addScaledVector(this._punchVel, dt);

    const dipK = 120;
    this._landDipVel += -dipK * this._landDip * dt;
    this._landDipVel *= Math.max(0, 1 - 2 * Math.sqrt(dipK) * dt);
    this._landDip += this._landDipVel * dt;

    const alpha = this.game.time.alpha;
    const px = this._prevPos.x + (this.position.x - this._prevPos.x) * alpha;
    const py = this._prevPos.y + (this.position.y - this._prevPos.y) * alpha;
    const pz = this._prevPos.z + (this.position.z - this._prevPos.z) * alpha;

    // Eye height is smoothed rather than snapped: an instant crouch is the most
    // obvious tell of an unfinished movement system.
    this._camEye = THREE.MathUtils.damp(this._camEye, this.eyeHeight, 14, dt);

    // Bob is driven by distance, like the footsteps, and damped hard while
    // aiming — a bobbing sight picture is unusable.
    const ads = this.game.weapons?.adsProgress ?? 0;
    const bobScale = (1 - ads * 0.85) * Math.min(1, this.speed / SPEED_WALK);
    if (this.grounded) this._bobPhase += (this.speed * dt) / (this.isSprinting ? 1.02 : 0.86);
    const bobV = Math.sin(this._bobPhase * Math.PI * 2) * 0.021 * bobScale;
    const bobH = Math.sin(this._bobPhase * Math.PI) * 0.017 * bobScale;
    const bobRoll = Math.sin(this._bobPhase * Math.PI) * 0.006 * bobScale;

    // Strafe lean, and a bigger roll while sliding.
    const strafe = this.velocity.x * this.rightVec.x + this.velocity.z * this.rightVec.z;
    const leanTarget = (-strafe / SPEED_SPRINT) * 0.028 + (this.stance === 'slide' ? -0.07 : 0);
    this._lean = THREE.MathUtils.damp(this._lean, leanTarget, 8, dt);

    const cam = this.game.camera;
    cam.position.set(px + this.rightVec.x * bobH, py + this._camEye + bobV + this._landDip, pz + this.rightVec.z * bobH);
    cam.rotation.set(this.pitch + this._punch.x, this.yaw + this._punch.y, this._lean + bobRoll + this._punch.z, 'YXZ');
  }
}
