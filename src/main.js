import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { EventBus } from './core/EventBus.js';
import { Input } from './core/Input.js';
import { Settings } from './core/Settings.js';
import { Time } from './core/Time.js';
import { AssetForge } from './core/AssetForge.js';
import { Sky } from './render/Sky.js';
import { Lighting } from './render/Lighting.js';
import { PostFX } from './render/PostFX.js';
import { Particles } from './render/Particles.js';
import { Decals } from './render/Decals.js';
import { Level } from './world/Level.js';
import { Collision } from './world/Collision.js';
import { Player } from './player/Player.js';
import { ViewModel } from './player/ViewModel.js';
import { WeaponSystem } from './player/WeaponSystem.js';
import { Ballistics } from './combat/Ballistics.js';
import { AIDirector } from './ai/AIDirector.js';
import { HUD } from './ui/HUD.js';
import { AudioEngine } from './audio/AudioEngine.js';

/**
 * Shared context handed to every subsystem. Subsystems reach each other through
 * this object and through `bus`; nothing imports a sibling directly, so any one
 * module can be swapped out without touching the others.
 */
class Game {
  constructor(canvas) {
    this.bus = new EventBus();
    this.settings = new Settings(this.bus);
    this.time = new Time(120);
    this.engine = new Engine(canvas, this.settings);
    this.input = new Input(canvas, this.bus);

    this.scene = this.engine.scene;
    this.viewmodelScene = this.engine.viewmodelScene;
    this.camera = this.engine.camera;
    this.renderer = this.engine.renderer;

    this.paused = false;
    this.started = false;
    // Per-system frame profiler, off unless the harness asks for it: the timing
    // calls themselves are cheap, but the branch keeps the hot path clean.
    this.profile = window.__PROFILE
      ? {
          frames: 0,
          totals: new Map(),
          add(name, ms) {
            this.totals.set(name, (this.totals.get(name) || 0) + ms);
          },
          report() {
            const out = [];
            for (const [name, total] of this.totals) out.push({ name, ms: +(total / this.frames).toFixed(2) });
            out.sort((a, b) => b.ms - a.ms);
            return { frames: this.frames, perFrame: out };
          },
          reset() {
            this.frames = 0;
            this.totals.clear();
          },
        }
      : null;
    this.systems = [];
    this.byName = new Map();
    this._raf = 0;
    this._tmpVec = new THREE.Vector3();
  }

  /**
   * Registration order is boot order and also fixed-step update order, which
   * matters: collision must exist before the player queries it, and the view
   * model must update after the camera so it inherits this frame's orientation.
   */
  register(name, system) {
    system.name = name;
    this.systems.push(system);
    this.byName.set(name, system);
    this[name] = system;
    return system;
  }

  get(name) {
    return this.byName.get(name);
  }

  async boot() {
    const order = [
      ['forge', AssetForge],
      ['sky', Sky],
      ['lighting', Lighting],
      ['postfx', PostFX],
      ['level', Level],
      ['collision', Collision],
      ['particles', Particles],
      ['decals', Decals],
      ['audio', AudioEngine],
      ['ballistics', Ballistics],
      ['player', Player],
      ['weapons', WeaponSystem],
      ['viewmodel', ViewModel],
      ['ai', AIDirector],
      ['hud', HUD],
    ];

    for (const [name, Ctor] of order) {
      const sys = this.register(name, new Ctor(this));
      const label = `boot:${name}`;
      performance.mark?.(`${label}:start`);
      try {
        await sys.init?.();
      } catch (err) {
        console.error(`[boot] ${name} failed to init`, err);
        this.bus.emit('boot:error', { name, err });
      }
      this.bus.emit('boot:progress', { name, index: this.systems.length, total: order.length });
      await frameYield();
    }

    // Capture harness escape hatch: lets a run isolate the post chain's cost from
    // everything else without editing settings.
    if (window.__DISABLE_POSTFX && this.postfx) this.postfx.enabled = false;

    this.engine.setHorizontalFov(this.settings.fov);
    this.engine.setViewmodelFov(this.settings.viewmodelFov);

    this.bus.on('settings:changed', (s) => {
      this.engine.setHorizontalFov(s.fov);
      this.engine.resize();
    });

    this.bus.on('input:unlocked', () => {
      if (this.started) this.setPaused(true);
    });

    this.bus.emit('boot:complete');
  }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    this.bus.emit(p ? 'game:paused' : 'game:resumed');
  }

  start() {
    this.started = true;
    this.time.start();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  frame(now) {
    const steps = this.time.beginFrame(now);
    const t = this.time;
    const prof = this.profile;

    if (!this.paused) {
      for (let i = 0; i < steps; i++) {
        const fixed = t.fixedStep;
        for (const sys of this.systems) sys.fixedUpdate?.(fixed, t.elapsed);
      }
    }

    // Variable-rate pass: cameras, animation blending, VFX, UI. Runs while paused
    // too so menus animate and the world keeps rendering behind them.
    if (prof) {
      for (const sys of this.systems) {
        if (!sys.update) continue;
        const t0 = performance.now();
        sys.update(t.dt, t.elapsed, this.paused);
        prof.add(sys.name, performance.now() - t0);
      }
      const t0 = performance.now();
      this.engine.render();
      prof.add('@render', performance.now() - t0);
      prof.add('@render:world+post', this.engine.timings.world);
      prof.add('@render:viewmodel', this.engine.timings.viewmodel);
      if (this.engine.timings.finish !== undefined) prof.add('@render:glFinish', this.engine.timings.finish);
      prof.frames++;
    } else {
      for (const sys of this.systems) sys.update?.(t.dt, t.elapsed, this.paused);
      this.engine.render();
    }

    for (const sys of this.systems) sys.postRender?.(t.dt);
    this.input.endFrame();

    // Kept for anything that wants the frame the loop just drew. Capture itself no
    // longer needs it — it renders its own frame into a target — but a caller that
    // wants exactly this frame's state still has a hook.
    if (this._capturePending) {
      const resolve = this._capturePending;
      this._capturePending = null;
      resolve(captureFrame(this.engine));
    }
  }

  requestCapture() {
    return new Promise((resolve) => {
      this._capturePending = resolve;
    });
  }
}

let snapCanvas = null;
let snapCtx = null;
let captureTarget = null;

/** Half-float bits to Number. Enough for image data; no subnormal handling. */
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const v = e === 0 ? f * 2 ** -24 : e === 0x1f ? (f ? NaN : Infinity) : (f / 1024 + 1) * 2 ** (e - 15);
  return s ? -v : v;
}

/**
 * Read a render target as 8-bit sRGB bytes, whatever its own format is.
 *
 * The post chain's ping-pong buffers are half-float, because 8 bits would band
 * the sky before the grade ever saw it, and a byte read against a half-float
 * attachment returns nothing at all — which looks exactly like a black frame. So
 * the type has to be honoured.
 *
 * Whether to apply the sRGB transfer function is the caller's to know, not
 * something to guess from the buffer: the grade pass ends with the OETF itself,
 * so a graded frame is already display-encoded and encoding it twice lifts the
 * midtones and flattens the contrast — which reads as a washed-out image rather
 * than as a bug. Only the ungraded fallback needs the encode.
 */
function readTargetAsBytes(renderer, target, w, h, displayEncoded) {
  if (target.texture.type !== THREE.HalfFloatType) {
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, px);
    return px;
  }
  const raw = new Uint16Array(w * h * 4);
  renderer.readRenderTargetPixels(target, 0, 0, w, h, raw);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < raw.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, Math.min(1, halfToFloat(raw[i + c])));
      const out = displayEncoded ? v : v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
      px[i + c] = Math.round(out * 255);
    }
    px[i + 3] = 255;
  }
  return px;
}

/**
 * Reads back the live frame and reports both the PNG and the statistics the
 * review rubric's tone axis is graded on. Doing the analysis here rather than in
 * Node means it sees the true framebuffer, including whether anything is actually
 * clipping or crushing.
 *
 * The frame is drawn into a render target and read from there. Do NOT be tempted
 * into reading the canvas instead: any CPU read that touches the default
 * framebuffer costs sixty to a hundred seconds per frame on this sandbox's
 * SwiftShader build, by every route tried — readPixels, drawImage into a 2D
 * canvas, a blit into our own framebuffer, page.screenshot. Reading a render
 * target costs the frame's own render and nothing more. The canvas snapshot
 * survives only as a fallback for the case where the target read comes back
 * empty, because a black PNG that looks like a capture is the worst outcome here.
 */
function captureFrame(engine) {
  const canvas = engine.renderer.domElement;
  const gl = engine.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;

  // Progress is published as each stage begins, not returned at the end: a
  // capture that never finishes is exactly the case worth diagnosing, and a
  // return value cannot report that.
  const t0 = performance.now();
  const stage = (name) => {
    window.__captureProgress = { stage: name, elapsed: +(performance.now() - t0).toFixed(1), width: w, height: h };
  };

  if (!snapCanvas || snapCanvas.width !== w || snapCanvas.height !== h) {
    snapCanvas = document.createElement('canvas');
    snapCanvas.width = w;
    snapCanvas.height = h;
    snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }

  stage('renderToTarget');
  const tRead = performance.now();
  let px = null;
  let path = 'target';
  let flipped = true;
  let graded = true;
  if (!window.__CAPTURE_VIA_CANVAS && engine.renderToTarget) {
    if (!captureTarget || captureTarget.width !== w || captureTarget.height !== h) {
      captureTarget?.dispose();
      captureTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true });
    }
    const rendered = engine.renderToTarget(captureTarget);
    graded = rendered.graded;
    stage('readTarget');
    px = readTargetAsBytes(engine.renderer, rendered.target, w, h, graded);
  }
  // Uniformly transparent black means the read did not see a frame; fall back
  // rather than hand a review agent a black image and call it a capture.
  if (px && px[(h >> 1) * w * 4 + (w >> 1) * 4] === 0 && px[3] === 0 && px[px.length - 2] === 0) px = null;
  if (!px) {
    stage('canvasSnapshot');
    snapCtx.drawImage(canvas, 0, 0);
    px = snapCtx.getImageData(0, 0, w, h).data;
    path = 'canvas';
    flipped = false;
  }
  const tStats = performance.now();
  stage('analyse');

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  let clipped = 0;
  let crushed = 0;
  let sat = 0;
  const hist = new Array(32).fill(0);
  // Every 3rd pixel on each axis: plenty for distribution statistics, ~9x cheaper.
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l;
      sumSq += l * l;
      n++;
      hist[Math.min(31, l / 8) | 0]++;
      if (r > 253 && g > 253 && b > 253) clipped++;
      if (l < 2) crushed++;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx > 0) sat += (mx - mn) / mx;
    }
  }
  const mean = sum / n;
  const tEncode = performance.now();
  stage('encode');
  if (flipped) {
    // readPixels hands back bottom-up rows; PNG wants top-down.
    const img = snapCtx.createImageData(w, h);
    const dst = img.data;
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * row;
      dst.set(px.subarray(src, src + row), y * row);
    }
    snapCtx.putImageData(img, 0, 0);
  }
  const dataUrl = snapCanvas.toDataURL('image/png');
  const tDone = performance.now();
  stage('done');
  return {
    dataUrl,
    width: w,
    height: h,
    path,
    graded,
    cost: {
      // Covers rendering the frame as well as reading it: unobserved frames are
      // never rasterised on this box, so the read is where a frame's real cost
      // lands. Separating the two would report two numbers that mean nothing.
      readback: +(tStats - tRead).toFixed(1),
      analyse: +(tEncode - tStats).toFixed(1),
      encode: +(tDone - tEncode).toFixed(1),
    },
    stats: {
      mean: +mean.toFixed(2),
      stddev: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2),
      clippedPct: +((clipped / n) * 100).toFixed(2),
      crushedPct: +((crushed / n) * 100).toFixed(2),
      meanSaturation: +(sat / n).toFixed(3),
      histogram: hist,
    },
  };
}

function frameYield() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

async function main() {
  const canvas = document.getElementById('viewport');
  const game = new Game(canvas);
  window.GAME = game; // debug + automated screenshot harness hook

  const loading = document.createElement('div');
  loading.className = 'boot-screen';
  loading.innerHTML =
    '<div class="boot-title">CLAUDE<span>OF</span>DUTY</div>' +
    '<div class="boot-bar"><i></i></div>' +
    '<div class="boot-status">initialising</div>';
  document.getElementById('ui-root').appendChild(loading);

  const bar = loading.querySelector('.boot-bar i');
  const status = loading.querySelector('.boot-status');
  game.bus.on('boot:progress', ({ name, index, total }) => {
    bar.style.width = `${(index / total) * 100}%`;
    status.textContent = `building ${name}`;
  });

  await game.boot();

  status.textContent = 'click to deploy';
  bar.style.width = '100%';
  loading.classList.add('ready');

  const deploy = () => {
    loading.remove();
    game.input.requestLock();
    game.setPaused(false);
  };
  loading.addEventListener('click', deploy);
  game.bus.once('input:locked', () => loading.remove());

  game.setPaused(true);
  game.start();

  const busLog = [];
  game.bus.onAny((type, payload) => {
    if (busLog.length > 400) busLog.shift();
    busLog.push({ type, t: +game.time.elapsed.toFixed(3), payload: payload && typeof payload === 'object' ? undefined : payload });
  });

  // The screenshot harness drives the game without a real user: it needs a way
  // to unpause and place the camera deterministically.
  window.__harness = {
    ready: true,
    deploy() {
      loading.remove?.();
      game.setPaused(false);
    },
    settle(frames = 30) {
      return new Promise((res) => {
        let n = frames;
        const tick = () => (n-- <= 0 ? res() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });
    },
    // Split into request + poll rather than one awaited call: Playwright's
    // page.evaluate takes an argument, not a timeout, so an awaited capture that
    // never resolves hangs the whole run with no diagnosis. Polling a field lets
    // the driver apply a real deadline and report which pass stalled.
    captureResult: null,
    requestCapture() {
      this.captureResult = null;
      // Capture draws its own frame into a render target, so it does not need to
      // wait for a rAF and never touches the canvas. Still split into request and
      // poll: the driver has to be able to apply a deadline and report which
      // stage stalled, which an awaited evaluate cannot do.
      this.captureResult = captureFrame(game.engine);
    },
    frameStats() {
      return { fps: Math.round(game.time.fps), frame: game.time.frame, ms: +(game.time.dt * 1000).toFixed(1) };
    },

    // Input injection for the behavioural harness. It writes Input's own state
    // rather than dispatching DOM events because pointer lock cannot be granted
    // in headless Chromium, and Input ignores mouse buttons while unlocked.
    // `pressedThisFrame` is cleared by endFrame, so a set here is seen by exactly
    // one frame — the same one-frame edge a real key press produces.
    setAction(name, down) {
      const code = game.input.bindings[name]?.[0];
      if (!code) return false;
      if (down) {
        game.input.keys.add(code);
        game.input.pressedThisFrame.add(code);
      } else {
        game.input.keys.delete(code);
        game.input.releasedThisFrame.add(code);
      }
      return true;
    },
    setMouse(name, down) {
      game.input.mouse[name] = down;
      if (down) game.input.mousePressed[name] = true;
    },
    look(dx, dy) {
      game.input._lookX += dx;
      game.input._lookY += dy;
    },
    clearInput() {
      game.input.keys.clear();
      game.input.mouse.left = game.input.mouse.right = game.input.mouse.middle = false;
    },

    // Bus tap for the behavioural harness: it asserts that a subsystem announced
    // something (a footstep, a shot, a landing) without having to reach inside
    // that subsystem to check. Bounded so a long run cannot grow without limit.
    /**
     * Where does a frame readback's cost actually come from? Answers three
     * questions in one frame: is it per-call or per-pixel, and does reading a
     * framebuffer we own behave differently from reading the canvas. Kept because
     * this box's readback cost is the binding constraint on every visual review
     * loop, and it needs re-measuring whenever the sandbox changes.
     */
    probeReadback(w = 320, h = 180) {
      const r = game.renderer;
      const gl = r.getContext();
      const out = {};
      const time = (label, fn) => {
        const t = performance.now();
        const v = fn();
        out[label] = +(performance.now() - t).toFixed(1);
        return v;
      };

      const one = new Uint8Array(4);
      time('default_1x1', () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one));
      const small = new Uint8Array(w * h * 4);
      time(`default_${w}x${h}`, () => gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, small));

      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true });
      r.setRenderTarget(rt);
      time('render_to_target', () => r.render(game.scene, game.camera));
      const buf = new Uint8Array(w * h * 4);
      time('target_1x1', () => r.readRenderTargetPixels(rt, 0, 0, 1, 1, one));
      time(`target_${w}x${h}`, () => r.readRenderTargetPixels(rt, 0, 0, w, h, buf));
      r.setRenderTarget(null);
      out.targetHasPixels = buf.some((v) => v > 4);
      rt.dispose();
      return out;
    },

    /** The same probe, but inside the rAF turn that drew — where captures happen. */
    probeReadbackInRaf(w = 320, h = 180) {
      return new Promise((res) => {
        requestAnimationFrame(() => res(this.probeReadback(w, h)));
      });
    },

    events() {
      return busLog.slice();
    },
    clearEvents() {
      busLog.length = 0;
    },

    /**
     * Everything an automated playtest needs to assert on, in one round trip.
     * Sim time is reported separately from frame count: under the software
     * rasteriser a frame retires at most 67ms of simulation, so any assertion
     * with a duration in it has to be written against `sim`, not frames.
     */
    snapshot() {
      const p = game.player;
      const w = game.weapons;
      return {
        frame: game.time.frame,
        sim: +game.time.elapsed.toFixed(3),
        player: p && {
          position: p.position.toArray().map((v) => +v.toFixed(3)),
          velocity: p.velocity.toArray().map((v) => +v.toFixed(3)),
          yaw: +p.yaw.toFixed(3),
          pitch: +p.pitch.toFixed(3),
          state: p.state,
          stance: p.stance,
          speed: +(p.speed ?? 0).toFixed(3),
          eyeHeight: +(p.eyeHeight ?? 0).toFixed(3),
          grounded: !!p.grounded,
          health: +(p.health ?? 0).toFixed(1),
          isAds: !!p.isAds,
          isSprinting: !!p.isSprinting,
        },
        weapon: w?.current && {
          name: w.current.name,
          ammo: w.current.ammo,
          reserve: w.current.reserve,
          magSize: w.current.magSize,
          fireMode: w.current.fireMode,
          isReloading: !!w.isReloading,
          isFiring: !!w.isFiring,
          adsProgress: +(w.adsProgress ?? 0).toFixed(3),
        },
        enemies: (game.ai?.enemies ?? []).length,
        enemiesAlive: (game.ai?.enemies ?? []).filter((e) => e.alive !== false && (e.health ?? 1) > 0).length,
        camera: game.camera.position.toArray().map((v) => +v.toFixed(3)),
      };
    },
    profile() {
      const r = game.profile?.report() ?? null;
      game.profile?.reset();
      return r;
    },
    game,
  };
}

main().catch((err) => {
  console.error(err);
  document.getElementById('ui-root').innerHTML =
    `<pre class="fatal">boot failed\n\n${err?.stack || err}</pre>`;
});
