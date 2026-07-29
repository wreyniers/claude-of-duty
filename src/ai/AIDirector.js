/**
 * Enemy spawning, squad coordination, navigation, combat behaviour, ragdolls.
 *
 * CONTRACT:
 *   enemies : Enemy[]
 *   spawnWave(n)
 *   alertAll(position)
 */
export class AIDirector {
  constructor(game) {
    this.game = game;
    this.enemies = [];
  }

  async init() {}

  spawnWave() {}

  alertAll() {}

  fixedUpdate() {}

  update() {}
}
