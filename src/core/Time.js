/**
 * Frame clock with fixed-step accumulation.
 *
 * Rendering runs at display rate; simulation (movement, ballistics, AI) steps at
 * a fixed 120 Hz so physics behaviour does not change with framerate. Anything
 * visual reads `alpha` to interpolate between the last two sim states.
 */
export class Time {
  constructor(fixedHz = 120) {
    this.fixedStep = 1 / fixedHz;
    this.maxFrameTime = 0.1; // clamp: never simulate more than 100ms of catch-up
    this.dt = 0;
    this.elapsed = 0;
    this.frame = 0;
    this.alpha = 0;
    this.scale = 1;
    this.fps = 0;
    this._accumulator = 0;
    this._last = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
  }

  /** Called once before the first frame so the first dt is not the page lifetime. */
  start(now = performance.now()) {
    this._last = now;
  }

  /**
   * Advance the clock. Returns the number of fixed sim steps to run this frame.
   */
  beginFrame(now) {
    const raw = Math.min((now - this._last) / 1000, this.maxFrameTime);
    this._last = now;
    this.dt = raw * this.scale;
    this.elapsed += this.dt;
    this.frame++;

    this._fpsAccum += raw;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.25) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    this._accumulator += this.dt;
    let steps = 0;
    while (this._accumulator >= this.fixedStep && steps < 8) {
      this._accumulator -= this.fixedStep;
      steps++;
    }
    // Once the step cap is hit the accumulator can never drain -- 8 steps retire
    // 67ms but a clamped frame adds up to 100ms -- so it grows without bound and
    // the sim falls permanently further behind the clock. Drop the debt instead:
    // running in slow motion is better than spiralling.
    if (steps === 8) this._accumulator = 0;
    this.alpha = this._accumulator / this.fixedStep;
    return steps;
  }
}
