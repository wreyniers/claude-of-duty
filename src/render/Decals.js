/**
 * Projected decals: bullet holes, scorch marks, blood splatter. Backed by a ring
 * buffer of a fixed budget so long firefights cannot leak memory.
 *
 * CONTRACT:
 *   spawn(kind, point, normal, opts?)
 */
export class Decals {
  constructor(game) {
    this.game = game;
  }

  async init() {}

  spawn() {}

  update() {}
}
