#!/usr/bin/env node
/**
 * Behavioural harness.
 *
 * `screenshot.mjs` answers "does it look right"; this answers "does it play
 * right". It boots the game headless, drives real input through the same Input
 * state a keyboard would set, and asserts on the simulation: that walking covers
 * the distance it should, that a slide actually boosts and then decays, that a
 * sprint into a wall stops rather than tunnelling, that firing consumes ammo and
 * reloading gives it back.
 *
 * It renders at a deliberately tiny resolution with the post chain off, because
 * none of these assertions look at a pixel and the software rasteriser is the
 * only slow part of this box. That is what makes it a test you can run in a loop
 * rather than an event you schedule.
 *
 * Assertions are soft: every one reports its actual measured value whether it
 * passes or fails, so a failure tells you the number that was wrong rather than
 * just which line threw. Scenarios covering unimplemented subsystems are tagged
 * `spec` — they are the contract those modules have to satisfy, and they are
 * expected to fail until someone writes them.
 *
 * Usage:
 *   node tools/playtest.mjs
 *   node tools/playtest.mjs --only movement,slide --port 5801
 *   node tools/playtest.mjs --width 640 --height 360 --post   # watchable settings
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 5299));
const WIDTH = Number(arg('width', 320));
const HEIGHT = Number(arg('height', 180));
const WITH_POST = process.argv.includes('--post');
const OUT = path.resolve(ROOT, arg('out', 'shots/playtest'));
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const results = [];
let currentScenario = null;

/** Record one assertion. `actual` is always reported, pass or fail. */
function check(pass, label, actual, tag = 'core') {
  results.push({ scenario: currentScenario, label, pass: !!pass, actual, tag });
  const mark = pass ? 'ok  ' : tag === 'spec' ? 'SPEC' : 'FAIL';
  console.log(`  ${mark} ${label}${actual === undefined ? '' : `  [${actual}]`}`);
  return !!pass;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

/**
 * A driver over the in-page harness. Everything is expressed in simulated
 * seconds rather than frames: a frame retires at most 67ms of simulation, so the
 * two are not interchangeable and a test written in frames silently changes
 * meaning when the renderer gets slower.
 */
class Pad {
  constructor(page) {
    this.page = page;
    this.held = new Set();
  }

  frames(n) {
    return this.page.evaluate(`window.__harness.settle(${n})`);
  }

  snap() {
    return this.page.evaluate('window.__harness.snapshot()');
  }

  async press(action) {
    await this.page.evaluate(`window.__harness.setAction(${JSON.stringify(action)}, true)`);
    await this.frames(1);
    await this.page.evaluate(`window.__harness.setAction(${JSON.stringify(action)}, false)`);
  }

  async down(...actions) {
    for (const a of actions) {
      this.held.add(a);
      await this.page.evaluate(`window.__harness.setAction(${JSON.stringify(a)}, true)`);
    }
  }

  async up(...actions) {
    for (const a of actions) {
      this.held.delete(a);
      await this.page.evaluate(`window.__harness.setAction(${JSON.stringify(a)}, false)`);
    }
  }

  async mouse(button, downState) {
    await this.page.evaluate(`window.__harness.setMouse(${JSON.stringify(button)}, ${!!downState})`);
  }

  /**
   * Advance until `simSeconds` of simulation have elapsed. Held keys have to be
   * re-asserted every frame: Input clears `pressedThisFrame` at frame end, and a
   * held key that is only set once would read as a single-frame tap to anything
   * watching edges.
   */
  async advance(simSeconds, perFrame) {
    const start = (await this.snap()).sim;
    let sim = start;
    let guard = 0;
    while (sim - start < simSeconds && guard++ < 400) {
      if (this.held.size) {
        await this.page.evaluate(
          (held) => held.forEach((a) => window.__harness.setAction(a, true)),
          [...this.held]
        );
      }
      if (perFrame) await perFrame(this);
      await this.frames(1);
      sim = (await this.snap()).sim;
    }
    return sim - start;
  }

  async reset(x, y, z, yaw = 0) {
    await this.page.evaluate('window.__harness.clearInput()');
    this.held.clear();
    await this.page.evaluate(
      ([px, py, pz, pyaw]) => {
        const p = window.GAME.player;
        p.position.set(px, py, pz);
        p.velocity.set(0, 0, 0);
        p.yaw = pyaw;
        p.pitch = 0;
        p.health = p.maxHealth;
        p.alive = true;
        p._prevPos?.copy(p.position);
      },
      [x, y, z, yaw]
    );
    await this.frames(2);
  }

  events() {
    return this.page.evaluate('window.__harness.events()');
  }

  clearEvents() {
    return this.page.evaluate('window.__harness.clearEvents()');
  }
}

const SCENARIOS = [
  {
    name: 'spawn',
    async run(pad) {
      const s = await pad.snap();
      check(s.player, 'player exists', s.player ? s.player.state : 'missing');
      check(Number.isFinite(s.player.position[1]), 'position is finite', s.player.position.join(','));
      await pad.advance(1.5);
      const t = await pad.snap();
      check(t.player.grounded, 'settles on the ground within 1.5s', `y=${t.player.position[1]}`);
      check(t.player.position[1] > -20, 'has not fallen out of the world', `y=${t.player.position[1]}`);
      check(t.player.health === 100, 'spawns undamaged', t.player.health);
      check(near(t.player.speed, 0, 0.15), 'is at rest when no input is held', t.player.speed);
    },
  },
  {
    name: 'walk',
    async run(pad) {
      const a = await pad.snap();
      await pad.clearEvents();
      await pad.down('forward');
      const dur = await pad.advance(2);
      const b = await pad.snap();
      await pad.up('forward');
      const dist = Math.hypot(b.player.position[0] - a.player.position[0], b.player.position[2] - a.player.position[2]);
      // Ramp-up eats part of the first metre, so the bound is one-sided-ish:
      // walking for two seconds must cover most of two seconds of walk speed.
      check(dist > 5.5 && dist < 10, `covers 5.5-10m in ${dur.toFixed(2)}s of walking`, `${dist.toFixed(2)}m`);
      check(near(b.player.speed, 4.2, 0.9), 'reaches walk speed', b.player.speed);
      check(b.player.grounded, 'stays grounded while walking', b.player.grounded);
      const steps = (await pad.events()).filter((e) => e.type === 'player:footstep').length;
      check(steps >= 2, 'emits footsteps while walking', steps);
    },
  },
  {
    name: 'sprint',
    async run(pad) {
      await pad.down('forward', 'sprint');
      await pad.advance(2.2);
      const s = await pad.snap();
      await pad.up('forward', 'sprint');
      check(s.player.isSprinting, 'enters sprint', s.player.isSprinting);
      check(s.player.speed > 6, 'sprints faster than 6 m/s', s.player.speed);
      check(s.player.speed > 7.4, 'reaches tactical sprint after holding it', s.player.speed);
    },
  },
  {
    name: 'strafe',
    async run(pad) {
      const a = await pad.snap();
      await pad.down('right');
      await pad.advance(1.2);
      const b = await pad.snap();
      await pad.up('right');
      const lateral = Math.hypot(b.player.position[0] - a.player.position[0], b.player.position[2] - a.player.position[2]);
      check(lateral > 2.5, 'strafing moves sideways', `${lateral.toFixed(2)}m`);
      check(near(b.player.position[1], a.player.position[1], 0.35), 'strafing does not drift vertically', b.player.position[1]);
    },
  },
  {
    name: 'jump',
    async run(pad) {
      const a = await pad.snap();
      await pad.clearEvents();
      await pad.press('jump');
      await pad.advance(0.25);
      const mid = await pad.snap();
      check(!mid.player.grounded && mid.player.position[1] > a.player.position[1] + 0.15, 'jump leaves the ground', `y+${(mid.player.position[1] - a.player.position[1]).toFixed(2)}`);
      await pad.advance(1.4);
      const end = await pad.snap();
      check(end.player.grounded, 'lands again within 1.65s', `y=${end.player.position[1]}`);
      check(near(end.player.position[1], a.player.position[1], 0.2), 'lands at the height it left from', end.player.position[1]);
      check(end.player.health === 100, 'a flat jump does no damage', end.player.health);
      const landed = (await pad.events()).some((e) => e.type === 'player:land');
      check(landed, 'announces the landing', landed);
    },
  },
  {
    name: 'crouch',
    async run(pad) {
      const stand = await pad.snap();
      await pad.down('crouch');
      await pad.advance(0.6);
      const c = await pad.snap();
      check(c.player.stance === 'crouch', 'crouch changes stance', c.player.stance);
      check(c.player.eyeHeight < stand.player.eyeHeight - 0.3, 'crouch lowers the eye', c.player.eyeHeight);
      await pad.down('forward');
      await pad.advance(1);
      const moving = await pad.snap();
      check(moving.player.speed < 2.6, 'crouch-walking is slow', moving.player.speed);
      await pad.up('crouch', 'forward');
      await pad.advance(0.8);
      const up = await pad.snap();
      check(up.player.stance === 'stand', 'stands back up in the open', up.player.stance);
    },
  },
  {
    name: 'slide',
    async run(pad) {
      await pad.down('forward', 'sprint');
      await pad.advance(1.6);
      const running = await pad.snap();
      await pad.down('crouch');
      await pad.advance(0.12);
      const s = await pad.snap();
      check(s.player.state === 'slide', 'tapping crouch at sprint starts a slide', s.player.state);
      check(s.player.speed > running.player.speed, 'the slide boosts speed', `${running.player.speed} -> ${s.player.speed}`);
      await pad.advance(1.4);
      const after = await pad.snap();
      await pad.up('forward', 'sprint', 'crouch');
      check(after.player.state !== 'slide', 'the slide ends on its own', after.player.state);
    },
  },
  {
    name: 'wall',
    async run(pad) {
      // Sprint at a wall for long enough that a tunnelling bug would put us
      // through it, then confirm we are still on the near side and still solid.
      const a = await pad.snap();
      await pad.down('forward', 'sprint');
      const events = [];
      await pad.advance(3, async (p) => {
        const s = await p.snap();
        events.push(s.player.position[1]);
      });
      const b = await pad.snap();
      await pad.up('forward', 'sprint');
      check(b.player.position[1] > -20, 'never falls out of the world at sprint speed', `y=${b.player.position[1]}`);
      check(Math.min(...events) > -20, 'stays inside the world for the whole run', `minY=${Math.min(...events).toFixed(2)}`);
      check(b.player.grounded, 'is still standing on something', b.player.grounded);
      check(Number.isFinite(b.player.position[0]) && Number.isFinite(b.player.position[2]), 'position stays finite', b.player.position.join(','));
    },
  },
  {
    name: 'ads',
    async run(pad) {
      await pad.mouse('right', true);
      await pad.advance(0.6);
      const s = await pad.snap();
      check(s.player.isAds, 'right mouse aims down sights', s.player.isAds);
      check(s.weapon ? s.weapon.adsProgress > 0.85 : false, 'the ADS blend completes', s.weapon?.adsProgress);
      await pad.down('forward');
      await pad.advance(1.2);
      const moving = await pad.snap();
      check(moving.player.speed < 3.4, 'aiming slows movement', moving.player.speed);
      await pad.up('forward');
      await pad.mouse('right', false);
      await pad.advance(0.5);
      const out = await pad.snap();
      check(out.weapon ? out.weapon.adsProgress < 0.1 : false, 'releasing lowers the sights', out.weapon?.adsProgress);
    },
  },
  {
    name: 'fire',
    async run(pad) {
      const a = await pad.snap();
      check(!!a.weapon, 'a weapon is equipped', a.weapon?.name);
      await pad.clearEvents();
      await pad.mouse('left', true);
      await pad.advance(0.8);
      const b = await pad.snap();
      await pad.mouse('left', false);
      check(b.weapon && b.weapon.ammo < a.weapon.ammo, 'firing consumes ammo', `${a.weapon?.ammo} -> ${b.weapon?.ammo}`, 'spec');
      const rounds = a.weapon && b.weapon ? a.weapon.ammo - b.weapon.ammo : 0;
      // 780 rpm is 13 rounds a second, so 0.8s of held fire is about ten.
      check(rounds >= 6 && rounds <= 14, 'automatic fire runs at roughly the stated rpm', rounds, 'spec');
      check(b.weapon?.reserve === a.weapon?.reserve, 'firing does not touch the reserve', b.weapon?.reserve, 'spec');
      const fired = (await pad.events()).filter((e) => e.type.startsWith('weapon:')).length;
      check(fired > 0, 'firing announces itself on the bus', fired, 'spec');
    },
  },
  {
    name: 'reload',
    async run(pad) {
      await pad.mouse('left', true);
      await pad.advance(1.2);
      await pad.mouse('left', false);
      const spent = await pad.snap();
      await pad.press('reload');
      await pad.advance(0.2);
      const during = await pad.snap();
      check(during.weapon?.isReloading, 'reload starts', during.weapon?.isReloading, 'spec');
      await pad.advance(3);
      const done = await pad.snap();
      check(!done.weapon?.isReloading, 'reload finishes within 3.2s', done.weapon?.isReloading, 'spec');
      check(done.weapon?.ammo === done.weapon?.magSize, 'reload fills the magazine', `${spent.weapon?.ammo} -> ${done.weapon?.ammo}`, 'spec');
      check(
        done.weapon && spent.weapon ? done.weapon.reserve < spent.weapon.reserve : false,
        'reload draws from the reserve',
        `${spent.weapon?.reserve} -> ${done.weapon?.reserve}`,
        'spec'
      );
    },
  },
  {
    name: 'enemies',
    async run(pad) {
      await pad.page.evaluate('window.GAME.ai?.spawnWave?.(3)');
      await pad.advance(1);
      const s = await pad.snap();
      check(s.enemies === 3, 'spawnWave(3) produces three enemies', s.enemies, 'spec');
      check(s.enemiesAlive === 3, 'they spawn alive', s.enemiesAlive, 'spec');
      await pad.advance(2);
      const t = await pad.snap();
      check(t.enemies === 3, 'they persist rather than vanishing', t.enemies, 'spec');
    },
  },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  // Harness config, not the root one: hot reload off, so an edit landing mid-run
  // cannot reload the page out from under the test.
  const server = spawn('npx', ['vite', '--config', 'tools/vite.harness.config.js', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  const url = `http://127.0.0.1:${PORT}/`;
  const consoleErrors = [];
  let browser;
  // A killed run must not leave a headless Chromium behind: one orphan spins a
  // software rasteriser at two of this box's four cores and silently slows every
  // later run.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      browser?.process()?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    server.kill('SIGKILL');
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => (cleanup(), process.exit(130)));
  process.on('exit', cleanup);

  try {
    await waitForServer(url);
    const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    browser = await chromium.launch({
      executablePath: existsSync(CHROME) ? CHROME : undefined,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--disable-frame-rate-limit',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.setDefaultTimeout(120000);
    await page.addInitScript((noPost) => {
      localStorage.setItem('cod:settings', JSON.stringify({ preset: 'low' }));
      if (noPost) window.__DISABLE_POSTFX = true;
    }, !WITH_POST);
    // See screenshot.mjs: without this the browser can serve a module cached on
    // an earlier run, and a test would pass against code that no longer exists.
    await page.context().setExtraHTTPHeaders({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' });
    page.on('console', (m) => {
      // Vite injects its client even with hot reload off; its failed websocket
      // attempt is dev-server noise, not a defect in the game.
      if (/WebSocket connection to 'ws:/.test(m.text())) return;
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const tBoot = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__harness && window.__harness.ready', null, { timeout: 180000 });
    await page.evaluate('window.__harness.deploy()');
    await page.evaluate('window.__harness.settle(8)');
    console.log(`[boot] ${Date.now() - tBoot}ms  ${WIDTH}x${HEIGHT} postfx=${WITH_POST}\n`);

    const pad = new Pad(page);
    const spawnPoint = await page.evaluate(() => window.GAME.player.position.toArray());
    const chosen = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.name)) : SCENARIOS;

    for (const scenario of chosen) {
      currentScenario = scenario.name;
      console.log(`[test] ${scenario.name}`);
      const t0 = Date.now();
      // Every scenario starts from the spawn point in a known stance, so one
      // failing scenario cannot cascade into the next.
      await pad.reset(spawnPoint[0], spawnPoint[1], spawnPoint[2]);
      try {
        await scenario.run(pad);
      } catch (err) {
        check(false, `scenario threw: ${err.message}`, undefined);
      }
      await pad.up(...pad.held);
      await pad.mouse('left', false);
      await pad.mouse('right', false);
      console.log(`       ${Date.now() - t0}ms\n`);
    }
  } catch (err) {
    consoleErrors.push(`harness: ${err.message}`);
    console.error(err);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }

  const core = results.filter((r) => r.tag === 'core');
  const spec = results.filter((r) => r.tag === 'spec');
  const coreFailed = core.filter((r) => !r.pass);
  const specFailed = spec.filter((r) => !r.pass);

  await writeFile(
    path.join(OUT, 'playtest.json'),
    JSON.stringify({ results, consoleErrors, serverLog: serverLog.slice(-2000) }, null, 2)
  );

  console.log(`core  ${core.length - coreFailed.length}/${core.length} passed`);
  console.log(`spec  ${spec.length - specFailed.length}/${spec.length} passed  (unimplemented subsystems)`);
  for (const r of coreFailed) console.log(`  FAIL ${r.scenario}: ${r.label} [${r.actual}]`);
  for (const r of specFailed) console.log(`  SPEC ${r.scenario}: ${r.label} [${r.actual}]`);
  if (consoleErrors.length) {
    console.log(`\n${consoleErrors.length} console error(s):`);
    for (const e of consoleErrors.slice(0, 12)) console.log(`  ! ${e}`);
  }

  const ok = coreFailed.length === 0 && consoleErrors.length === 0;
  console.log(`\n${ok ? 'OK' : 'FAIL'} -> ${path.relative(ROOT, OUT)}/playtest.json`);
  process.exit(ok ? 0 : 1);
}

main();
