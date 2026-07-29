/**
 * Keyboard + pointer-lock mouse input with an action-mapping layer.
 *
 * Mouse deltas accumulate between reads so a 1000 Hz mouse is not decimated by
 * a 60 Hz frame loop: `consumeLook()` returns the summed delta and resets.
 */
const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  interact: ['KeyF'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  nextWeapon: ['KeyQ'],
  swap: ['Digit1', 'Digit2'],
  flashlight: ['KeyL'],
  inspect: ['KeyI'],
  pause: ['Escape'],
  debug: ['Backquote'],
};

export class Input {
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.bus = bus;
    this.bindings = { ...DEFAULT_BINDINGS };
    this.sensitivity = 0.0022;
    this.adsSensitivityScale = 0.65;
    this.invertY = false;

    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.mouse = { left: false, right: false, middle: false };
    this.mousePressed = { left: false, right: false, middle: false };
    this.wheel = 0;
    this.locked = false;

    this._lookX = 0;
    this._lookY = 0;
    this._bound = [];
    this._attach();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._bound.push(() => target.removeEventListener(type, fn, opts));
  }

  _attach() {
    this._on(window, 'keydown', (e) => {
      if (e.repeat) return;
      // Let the browser keep refresh/devtools shortcuts.
      if (!e.metaKey && !e.ctrlKey && e.code !== 'F5' && e.code !== 'F12') e.preventDefault();
      this.keys.add(e.code);
      this.pressedThisFrame.add(e.code);
      this.bus.emit('input:keydown', e.code);
    });

    this._on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
      this.releasedThisFrame.add(e.code);
    });

    this._on(window, 'blur', () => {
      this.keys.clear();
      this.mouse.left = this.mouse.right = this.mouse.middle = false;
    });

    this._on(this.canvas, 'mousedown', (e) => {
      if (!this.locked) return;
      const name = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
      this.mouse[name] = true;
      this.mousePressed[name] = true;
    });

    this._on(window, 'mouseup', (e) => {
      const name = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
      this.mouse[name] = false;
    });

    this._on(this.canvas, 'contextmenu', (e) => e.preventDefault());

    this._on(window, 'wheel', (e) => {
      if (this.locked) {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY);
      }
    }, { passive: false });

    this._on(document, 'mousemove', (e) => {
      if (!this.locked) return;
      this._lookX += e.movementX || 0;
      this._lookY += e.movementY || 0;
    });

    this._on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this._lookX = this._lookY = 0;
      this.bus.emit(this.locked ? 'input:locked' : 'input:unlocked');
    });

    this._on(this.canvas, 'click', () => {
      if (!this.locked) this.requestLock();
    });
  }

  requestLock() {
    const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p?.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  releaseLock() {
    document.exitPointerLock?.();
  }

  /** Raw accumulated mouse delta in radians, cleared on read. */
  consumeLook(sensScale = 1) {
    const s = this.sensitivity * sensScale;
    const out = { x: this._lookX * s, y: this._lookY * s * (this.invertY ? -1 : 1) };
    this._lookX = this._lookY = 0;
    return out;
  }

  action(name) {
    const codes = this.bindings[name];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = this.bindings[name];
    if (!codes) return false;
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  keyPressed(code) {
    return this.pressedThisFrame.has(code);
  }

  /** Normalised WASD vector, x = strafe, y = forward. */
  moveAxis() {
    const x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    const y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  /** Must run at the very end of every frame. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mousePressed.left = this.mousePressed.right = this.mousePressed.middle = false;
    this.wheel = 0;
  }

  dispose() {
    for (const off of this._bound) off();
    this._bound.length = 0;
  }
}
