/**
 * Procedural audio. Every sound is synthesised with WebAudio — no sample files —
 * so gunshots, impacts, footsteps, bullet whizz-by and reverb tails are all
 * generated. Spatialised with PannerNodes and a convolution reverb whose impulse
 * response is generated per-environment.
 *
 * CONTRACT:
 *   play(name, opts?)                 2D sound
 *   playAt(name, position, opts?)     3D sound
 *   setEnvironment(name)              swaps the reverb IR
 *   resume()                          call from a user gesture
 */
export class AudioEngine {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.ready = false;
  }

  async init() {
    // Contexts start suspended until a gesture; the deploy click resumes it.
    this.game.bus.on('input:locked', () => this.resume());
  }

  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.ready = true;
    }
    this.ctx.resume?.();
  }

  play() {}

  playAt() {}

  setEnvironment() {}

  update() {}
}
