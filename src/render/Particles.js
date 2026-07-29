/**
 * Pooled GPU particle system: muzzle smoke, impact debris, blood, sparks, dust,
 * shell casings, tracers, explosion fireballs.
 *
 * CONTRACT (called from combat + VFX code, must never allocate per-emit):
 *   emit(effectName, position, normalOrDir, opts?)
 *   registerEffect(name, definition)
 */
export class Particles {
  constructor(game) {
    this.game = game;
    this.effects = new Map();
  }

  async init() {}

  registerEffect(name, def) {
    this.effects.set(name, def);
  }

  emit() {}

  update() {}
}
