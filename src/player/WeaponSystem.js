/**
 * Weapon inventory, fire control, recoil, reloads, ammo, attachments.
 *
 * CONTRACT:
 *   current   : weapon instance {name, ammo, magSize, reserve, fireMode, ...}
 *   isReloading, isFiring : boolean
 *   adsProgress : 0..1   view model + FOV blend read this
 *   recoil    : {pitch, yaw}   camera kick in radians, consumed by Player/ViewModel
 *   equip(index) / next() / reload() / fire()
 */
export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.weapons = [];
    this.currentIndex = 0;
    this.adsProgress = 0;
    this.isReloading = false;
    this.isFiring = false;
    this.recoil = { pitch: 0, yaw: 0 };
  }

  async init() {
    this.weapons = [
      { name: 'M4A1', ammo: 30, magSize: 30, reserve: 210, rpm: 780, fireMode: 'auto', damage: 28 },
    ];
  }

  get current() {
    return this.weapons[this.currentIndex];
  }

  equip(i) {
    if (this.weapons[i]) this.currentIndex = i;
  }

  next() {
    this.currentIndex = (this.currentIndex + 1) % this.weapons.length;
  }

  reload() {}

  fire() {}

  update(dt) {
    const wantAds = this.game.input.mouse.right;
    this.adsProgress = Math.max(0, Math.min(1, this.adsProgress + (wantAds ? dt * 5 : -dt * 5)));
  }
}
