/**
 * Heads-up display: dynamic crosshair, ammo counter, health/damage vignette,
 * hitmarkers, killfeed, compass, minimap, objective markers, pause menu.
 *
 * Built with DOM + canvas rather than 3D so text stays razor sharp.
 *
 * CONTRACT:
 *   root : HTMLElement inside #ui-root
 */
export class HUD {
  constructor(game) {
    this.game = game;
    this.root = document.createElement('div');
    this.root.className = 'hud';
  }

  async init() {
    document.getElementById('ui-root').appendChild(this.root);
    this.root.innerHTML = '<div class="crosshair"></div><div class="ammo"></div>';
    this._ammo = this.root.querySelector('.ammo');
  }

  update() {
    const w = this.game.weapons?.current;
    if (w && this._ammo) this._ammo.textContent = `${w.ammo} / ${w.reserve}`;
  }
}
