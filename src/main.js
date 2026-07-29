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

    if (!this.paused) {
      for (let i = 0; i < steps; i++) {
        const fixed = t.fixedStep;
        for (const sys of this.systems) sys.fixedUpdate?.(fixed, t.elapsed);
      }
    }

    // Variable-rate pass: cameras, animation blending, VFX, UI. Runs while paused
    // too so menus animate and the world keeps rendering behind them.
    for (const sys of this.systems) sys.update?.(t.dt, t.elapsed, this.paused);

    this.engine.render();

    for (const sys of this.systems) sys.postRender?.(t.dt);
    this.input.endFrame();
  }
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
    game,
  };
}

main().catch((err) => {
  console.error(err);
  document.getElementById('ui-root').innerHTML =
    `<pre class="fatal">boot failed\n\n${err?.stack || err}</pre>`;
});
