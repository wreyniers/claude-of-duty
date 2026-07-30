import * as THREE from 'three';

/**
 * Weapon inventory, fire control, recoil, reloads, ammo, attachments.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * Fire timing lives in `fixedUpdate` and is driven by an accumulator rather than
 * a countdown reset each frame. A 780 rpm weapon fires every 76.9ms; at any
 * display rate that is a fractional number of frames, so a countdown clamped at
 * zero quietly rounds every weapon's rate down to the frame time. Keeping the
 * remainder is the difference between a rate of fire you can feel and one that
 * drifts with the renderer.
 *
 * Recoil is two separate things, because in this genre it always is. There is a
 * view kick that springs back on its own and reads as impact, and there is a
 * climb that permanently moves the aim and has to be pulled down. Only the second
 * is a skill test; only the first is felt. Model one and you get either a gun that
 * wanders off target with no feedback, or one that shakes but asks nothing.
 *
 * The climb is a fixed sequence of impulses indexed by how far into the magazine
 * you are, with a small jitter on top. That is what makes a weapon learnable: the
 * shape of the climb belongs to the gun, not to the random number generator.
 *
 * CONTRACT:
 *   current   : weapon instance {name, ammo, magSize, reserve, fireMode, ...}
 *   isReloading, isFiring : boolean
 *   adsProgress : 0..1   view model + FOV blend read this
 *   recoil    : {pitch, yaw}   camera kick in radians, consumed by Player/ViewModel
 *   equip(index) / next() / reload() / fire()
 *
 * ADDITIONS (safe to rely on):
 *   spread        : number   current cone half-angle in radians
 *   shotsThisMag  : number   index into the recoil pattern
 *   swapProgress  : 0..1     below 1 while a weapon swap is in flight
 *   lastFireTime  : number   sim seconds
 *   bus events: weapon:fire, weapon:dryfire, weapon:reload:start,
 *               weapon:reload:end, weapon:equip, weapon:ads
 */

/**
 * Weapon definitions. Ranges in metres, times in seconds, angles in radians.
 *
 * `recoilPattern` is the climb per shot as [pitch, yaw]; it is indexed by shot
 * number and the last entry repeats. Real patterns rise hard for the first few
 * rounds and then wander sideways, which is what makes a long burst a different
 * problem from a short one rather than the same problem for longer.
 */
const WEAPONS = [
  {
    name: 'M4A1',
    kind: 'rifle',
    magSize: 30,
    reserve: 210,
    rpm: 780,
    fireMode: 'auto',
    damage: 28,
    falloff: { near: 28, far: 70, floor: 17 },
    headMultiplier: 1.6,
    limbMultiplier: 0.85,
    penetration: 0.35,
    adsTime: 0.24,
    reloadTime: 1.95,
    reloadEmptyTime: 2.55,
    swapTime: 0.55,
    hipSpread: 0.031,
    adsSpread: 0.0016,
    moveSpread: 0.022,
    viewKick: { pitch: 0.021, yaw: 0.008, roll: 0.006 },
    recoilPattern: [
      [0.0042, 0.0006],
      [0.0046, -0.0011],
      [0.0044, 0.0016],
      [0.0038, 0.0021],
      [0.0031, -0.0018],
      [0.0026, -0.0026],
      [0.0022, 0.0024],
      [0.0019, 0.0029],
      [0.0016, -0.0031],
      [0.0014, 0.0027],
    ],
    recoilJitter: 0.0012,
    tracerEvery: 3,
  },
  {
    name: 'MP7',
    kind: 'smg',
    magSize: 40,
    reserve: 240,
    rpm: 950,
    fireMode: 'auto',
    damage: 22,
    falloff: { near: 14, far: 40, floor: 12 },
    headMultiplier: 1.4,
    limbMultiplier: 0.9,
    penetration: 0.2,
    adsTime: 0.18,
    reloadTime: 1.7,
    reloadEmptyTime: 2.3,
    swapTime: 0.45,
    hipSpread: 0.026,
    adsSpread: 0.0029,
    moveSpread: 0.016,
    viewKick: { pitch: 0.014, yaw: 0.009, roll: 0.005 },
    recoilPattern: [
      [0.0028, 0.0009],
      [0.0031, -0.0014],
      [0.0029, 0.0018],
      [0.0025, 0.0022],
      [0.0021, -0.0021],
      [0.0018, -0.0027],
      [0.0016, 0.0026],
      [0.0014, 0.0022],
    ],
    recoilJitter: 0.0016,
    tracerEvery: 4,
  },
  {
    name: 'MK14',
    kind: 'marksman',
    magSize: 20,
    reserve: 120,
    rpm: 300,
    fireMode: 'single',
    damage: 55,
    falloff: { near: 60, far: 140, floor: 42 },
    headMultiplier: 2,
    limbMultiplier: 0.9,
    penetration: 0.6,
    adsTime: 0.3,
    reloadTime: 2.2,
    reloadEmptyTime: 2.9,
    swapTime: 0.65,
    hipSpread: 0.042,
    adsSpread: 0.0006,
    moveSpread: 0.03,
    viewKick: { pitch: 0.05, yaw: 0.012, roll: 0.012 },
    recoilPattern: [
      [0.011, 0.0014],
      [0.012, -0.002],
      [0.0115, 0.0026],
    ],
    recoilJitter: 0.002,
    tracerEvery: 1,
  },
];

/** Mulberry32: seeded, so a recorded playtest replays identically. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.weapons = [];
    this.currentIndex = 0;
    this.adsProgress = 0;
    this.isReloading = false;
    this.isFiring = false;
    this.recoil = { pitch: 0, yaw: 0 };
    this.spread = 0;
    this.shotsThisMag = 0;
    this.swapProgress = 1;
    this.lastFireTime = -99;

    this._sinceShot = 999;
    this._reloadLeft = 0;
    this._swapLeft = 0;
    this._pendingIndex = -1;
    this._burstLeft = 0;
    this._triggerHeld = false;
    this._triggerEdge = false;
    this._rand = rng(0x5eed1234);

    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  async init() {
    this.weapons = WEAPONS.map((def) => ({ ...def, ammo: def.magSize, reserve: def.reserve }));
    this.game.bus.emit('weapon:equip', { weapon: this.current, index: this.currentIndex });
  }

  get current() {
    return this.weapons[this.currentIndex];
  }

  /** Seconds between rounds for the current weapon. */
  get fireInterval() {
    return 60 / (this.current?.rpm ?? 600);
  }

  equip(i) {
    if (!this.weapons[i] || i === this.currentIndex || this._swapLeft > 0) return;
    this._pendingIndex = i;
    this._swapLeft = this.current.swapTime;
    this.isReloading = false;
    this._reloadLeft = 0;
  }

  next() {
    this.equip((this.currentIndex + 1) % this.weapons.length);
  }

  reload() {
    const w = this.current;
    if (!w || this.isReloading || this._swapLeft > 0) return;
    if (w.ammo >= w.magSize || w.reserve <= 0) return;
    this.isReloading = true;
    // An empty gun costs more, because the bolt has to be worked. It is the one
    // piece of weapon handling players consistently notice the absence of.
    this._reloadLeft = w.ammo === 0 ? w.reloadEmptyTime : w.reloadTime;
    this.game.bus.emit('weapon:reload:start', { weapon: w, empty: w.ammo === 0, duration: this._reloadLeft });
  }

  _finishReload() {
    const w = this.current;
    const take = Math.min(w.magSize - w.ammo, w.reserve);
    w.ammo += take;
    w.reserve -= take;
    this.isReloading = false;
    this.shotsThisMag = 0;
    this.game.bus.emit('weapon:reload:end', { weapon: w });
  }

  /**
   * The current spread cone half-angle. Hip fire is a wide cone that aiming
   * closes almost entirely; movement widens both. A cone rather than a random
   * screen offset is what makes spread fall off correctly with range.
   */
  _computeSpread() {
    const w = this.current;
    const p = this.game.player;
    if (!w) return 0;
    const ads = this.adsProgress;
    const base = w.hipSpread + (w.adsSpread - w.hipSpread) * ads;
    const moving = Math.min(1, (p ? p.speed : 0) / 6.5) * w.moveSpread * (1 - 0.55 * ads);
    const airborne = p && !p.grounded ? w.hipSpread * 0.5 * (1 - 0.4 * ads) : 0;
    // A sustained burst opens the cone, and it closes again between shots.
    const heat = Math.min(1, this.shotsThisMag / 12) * w.hipSpread * 0.25 * (1 - 0.7 * ads);
    return base + moving + airborne + heat;
  }

  /** Fire one round, if trigger state and timing allow it. */
  fire() {
    const w = this.current;
    if (!w || this.isReloading || this._swapLeft > 0) return false;
    if (this._sinceShot < this.fireInterval) return false;

    if (w.ammo <= 0) {
      if (this._triggerEdge) {
        this.game.bus.emit('weapon:dryfire', { weapon: w });
        // Reload on an empty trigger pull rather than making the player ask.
        this.reload();
      }
      return false;
    }

    // Keep the remainder, capped at one interval so a long stall cannot bank a
    // burst that then fires all at once.
    this._sinceShot = Math.min(this._sinceShot - this.fireInterval, this.fireInterval);
    w.ammo--;
    this.isFiring = true;
    this.lastFireTime = this.game.time.elapsed;

    const cam = this.game.camera;
    this._origin.copy(cam.position);
    this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion);

    // Sample the cone as a uniform disc perpendicular to aim. Uniform in area,
    // not in radius, or the shots pile into the middle and the cone reads
    // tighter than it is.
    this.spread = this._computeSpread();
    if (this.spread > 0) {
      this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const a = this._rand() * Math.PI * 2;
      const r = Math.sqrt(this._rand()) * this.spread;
      this._dir
        .addScaledVector(this._right, Math.cos(a) * r)
        .addScaledVector(this._up, Math.sin(a) * r)
        .normalize();
    }

    const shot = Math.floor(this.shotsThisMag);
    const tracer = shot % (w.tracerEvery || 1) === 0;
    const hit = this.game.ballistics?.fireHitscan(this._origin, this._dir, w, { tracer, shooter: 'player' }) ?? null;

    this._applyRecoil(w);
    this.shotsThisMag = shot + 1;

    this.game.bus.emit('weapon:fire', {
      weapon: w,
      origin: this._origin,
      direction: this._dir,
      ammo: w.ammo,
      hit,
      tracer,
      ads: this.adsProgress,
    });
    return true;
  }

  /**
   * Kick the view and climb the aim. The kick goes to Player's spring and comes
   * back on its own; the climb is written into pitch and yaw and stays there
   * until the player pulls it down.
   */
  _applyRecoil(w) {
    const p = this.game.player;
    // Shouldering the weapon takes about a third out of both.
    const damp = 1 - 0.35 * this.adsProgress;
    const pat = w.recoilPattern;
    const step = pat[Math.min(Math.floor(this.shotsThisMag), pat.length - 1)];
    const jitter = w.recoilJitter * damp;
    const climbPitch = step[0] * damp + (this._rand() - 0.5) * jitter;
    const climbYaw = step[1] * damp + (this._rand() - 0.5) * jitter * 1.6;

    if (p) {
      p.pitch = THREE.MathUtils.clamp(p.pitch + climbPitch, -1.52, 1.52);
      p.yaw += climbYaw;
      p.punch?.(
        w.viewKick.pitch * damp,
        (this._rand() - 0.5) * w.viewKick.yaw * damp,
        (this._rand() - 0.5) * w.viewKick.roll * damp
      );
    }
    // Published for the view model, which kicks the gun harder than the camera.
    this.recoil.pitch = climbPitch + w.viewKick.pitch * damp;
    this.recoil.yaw = climbYaw;
  }

  fixedUpdate(dt) {
    const input = this.game.input;
    const w = this.current;
    this._sinceShot += dt;

    if (this._swapLeft > 0) {
      this._swapLeft -= dt;
      this.swapProgress = w ? 1 - Math.max(0, this._swapLeft) / w.swapTime : 1;
      if (this._swapLeft <= 0) {
        if (this._pendingIndex >= 0) {
          this.currentIndex = this._pendingIndex;
          this._pendingIndex = -1;
          this.shotsThisMag = 0;
          this.game.bus.emit('weapon:equip', { weapon: this.current, index: this.currentIndex });
        }
        this.swapProgress = 1;
      }
    }

    if (this.isReloading) {
      this._reloadLeft -= dt;
      if (this._reloadLeft <= 0) this._finishReload();
    }

    // Edge-latch the trigger: a frame runs up to eight fixed steps and the mouse
    // state holds across all of them, so a single-shot weapon would otherwise
    // fire eight times off one click.
    const held = input.mouse.left;
    this._triggerEdge = held && !this._triggerHeld;
    const wasHeld = this._triggerHeld;
    this._triggerHeld = held;

    if (input.actionPressed('reload')) this.reload();
    if (input.actionPressed('nextWeapon')) this.next();
    if (input.keyPressed('Digit1')) this.equip(0);
    if (input.keyPressed('Digit2')) this.equip(1);
    if (input.keyPressed('Digit3')) this.equip(2);

    this.isFiring = false;
    if (w && held) {
      if (w.fireMode === 'auto') {
        this.fire();
      } else if (w.fireMode === 'burst') {
        if (this._triggerEdge) this._burstLeft = 3;
        if (this._burstLeft > 0 && this.fire()) this._burstLeft--;
      } else if (this._triggerEdge) {
        this.fire();
      }
    } else if (!held && wasHeld) {
      this._burstLeft = 0;
    }

    // Between shots the cone closes again, so a tapped weapon stays accurate.
    if (!this.isFiring && this.shotsThisMag > 0 && this._sinceShot > 0.35) {
      this.shotsThisMag = Math.max(0, this.shotsThisMag - dt * 12);
    }

    this.spread = this._computeSpread();
  }

  update(dt) {
    const w = this.current;
    const p = this.game.player;
    // Aiming is refused mid-swap, and a tactical sprint has the weapon down, so
    // the blend has somewhere to be other than fully in or fully out.
    const wantAds = this.game.input.mouse.right && this._swapLeft <= 0 && !(p && p.isTacSprinting);
    const rate = w ? 1 / Math.max(0.01, w.adsTime) : 4;
    const before = this.adsProgress;
    this.adsProgress = THREE.MathUtils.clamp(this.adsProgress + (wantAds ? dt * rate : -dt * rate * 1.25), 0, 1);
    if (before < 0.5 !== this.adsProgress < 0.5) {
      this.game.bus.emit('weapon:ads', { ads: this.adsProgress >= 0.5 });
    }

    // Narrow the world FOV while aiming. The zoom is what sells a sight picture,
    // and it has to ride the blend rather than toggle with it.
    const zoom = w ? (w.kind === 'marksman' ? 0.55 : 0.78) : 1;
    this.game.engine.setHorizontalFov(this.game.settings.fov * (1 - (1 - zoom) * this.adsProgress));
  }
}
