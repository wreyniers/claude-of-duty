#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 * Boots the game in Chromium (WebGL2 via SwiftShader), drives it from a set of
 * scripted camera poses, and writes PNGs plus a JSON report of console errors and
 * renderer stats. This is what the review agents look at, so it must fail loudly:
 * a black frame or a swallowed exception has to show up in the report rather than
 * quietly producing a plausible-looking image.
 *
 * Usage:
 *   node tools/screenshot.mjs                        # all shots -> shots/
 *   node tools/screenshot.mjs --out shots/round3      # custom output dir
 *   node tools/screenshot.mjs --only vista,gunplay    # subset
 *   node tools/screenshot.mjs --width 1920 --height 1080
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = path.resolve(ROOT, arg('out', 'shots'));
const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 900));
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = Number(arg('port', 5199));
const PRESET = arg('preset', '');
const NO_POST = process.argv.includes('--no-post');
const BUDGET_MS = Number(arg('budget', 120000));
// Frames to run before the first capture. TAA and the shadow cascades need a
// dozen or so to converge; a diagnostic run that only cares about timing can cut
// it to a handful, which on this box is the difference between a run of minutes
// and a run of one minute.
const SETTLE = Number(arg('settle', 40));

/**
 * Each shot is a named camera pose plus optional game-state setup, evaluated in
 * the page. `pose` is [x, y, z, yaw, pitch]. Shots are chosen to expose the
 * things a reviewer must judge: material response, shadow contact, silhouette
 * readability, the view model, muzzle flash, and the HUD in one frame.
 */
const SHOTS = [
  {
    name: 'vista',
    label: 'Wide establishing shot — sky, fog, sun, large-scale composition',
    pose: [0, 1.7, 22, 0, -0.04],
  },
  {
    name: 'materials',
    label: 'Close material read — albedo/normal/roughness detail, contact shadows',
    pose: [3.2, 1.3, 6.5, -0.5, -0.18],
  },
  {
    name: 'gunplay',
    label: 'View model in ADS with muzzle flash and HUD',
    pose: [0, 1.7, 10, 0, -0.02],
    setup: `
      const g = window.GAME;
      g.input.mouse.right = true;
      if (g.weapons) g.weapons.adsProgress = 1;
    `,
    settle: 45,
  },
  {
    name: 'interior',
    label: 'Interior lighting — bounce, occlusion, light shafts',
    pose: [-8, 1.6, -4, 1.2, 0],
  },
  {
    name: 'silhouette',
    label: 'Enemy silhouette readability at combat range',
    pose: [0, 1.7, 4, 0, -0.05],
    setup: `window.GAME.ai?.spawnWave?.(4);`,
    settle: 60,
  },
];

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

/**
 * Place the shot. The player has to be moved as well as the camera: Player owns
 * the camera every frame, so setting the camera alone is undone on the next one.
 */
function applyPose(page, pose) {
  return page.evaluate(
    ([x, y, z, yaw, pitch]) => {
      const g = window.GAME;
      const p = g.player;
      if (p) {
        p.position.set(x, y - p.eyeHeight, z);
        p.velocity.set(0, 0, 0);
        p.yaw = yaw;
        p.pitch = pitch;
        // Player smooths its own eye height and springs, and interpolates
        // between sim ticks; without collapsing those the first frames after a
        // teleport are captured mid-transit from the previous pose.
        p._camEye = p.eyeHeight;
        p._prevPos?.copy(p.position);
        p._landDip = p._landDipVel = 0;
        p._punch?.set(0, 0, 0);
        p._punchVel?.set(0, 0, 0);
      }
      g.camera.position.set(x, y, z);
      g.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    },
    pose
  );
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const dist = path.join(ROOT, 'dist');
  const useBuild = existsSync(path.join(dist, 'index.html')) && process.argv.includes('--dist');
  const server = spawn(
    'npx',
    useBuild
      ? ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1']
      : ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  const url = `http://127.0.0.1:${PORT}/`;
  const report = { url, width: WIDTH, height: HEIGHT, preset: PRESET || 'default', postfx: !NO_POST, shots: [], errors: [], warnings: [], timings: {} };

  let browser;
  try {
    await waitForServer(url);

    // The sandbox ships a specific Chromium build; pin to it rather than letting
    // Playwright look for a revision it would have to download.
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
    // SwiftShader is slow; every wait needs a generous ceiling.
    page.setDefaultTimeout(180000);

    // Settings are read from localStorage at boot, so the preset has to be in
    // place before the module graph runs.
    await page.addInitScript(
      ([preset, noPost]) => {
        if (preset) localStorage.setItem('cod:settings', JSON.stringify({ preset }));
        if (noPost) window.__DISABLE_POSTFX = true;
        window.__PROFILE = true;
      },
      [PRESET, NO_POST]
    );

    // Per-pass timings, so a stall can be attributed instead of guessed at.
    await page.exposeFunction('__report', (label, ms) => {
      report.timings[label] = ms;
    });

    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') report.errors.push(text);
      else if (msg.type() === 'warning') report.warnings.push(text);
    });
    page.on('pageerror', (err) => report.errors.push(`pageerror: ${err.message}`));

    const tBoot = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__harness && window.__harness.ready', null, { timeout: 180000 });
    report.timings.boot = Date.now() - tBoot;
    console.log(`[boot] ${report.timings.boot}ms  preset=${report.preset} postfx=${report.postfx} ${WIDTH}x${HEIGHT}`);

    await page.evaluate('window.__harness.deploy()');
    const tSettle = Date.now();
    // Let procedural generation, shadow maps and TAA history settle.
    await page.evaluate(`window.__harness.settle(${SETTLE})`);
    report.timings.settle = Date.now() - tSettle;
    const warm = await page.evaluate('window.__harness.frameStats()');
    console.log(`[warm] settle${SETTLE}=${report.timings.settle}ms  frame=${warm.frame} ${warm.ms}ms/f ${warm.fps}fps`);
    const prof = await page.evaluate('window.__harness.profile()');
    if (prof) {
      report.profile = prof;
      console.log(`[prof] over ${prof.frames} frames, ms/frame:`);
      for (const p of prof.perFrame.slice(0, 8)) console.log(`         ${p.name.padEnd(12)} ${p.ms}`);
    }

    const shots = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.name)) : SHOTS;

    // Visit every pose before capturing any of them. Each pose brings its own
    // materials into view for the first time, and under SwiftShader a cold
    // shader compile can cost more than a whole capture budget — which made the
    // first shot in the list absorb the cost for all of them and time out while
    // the rest sailed through. Warming here spreads it outside the timed path.
    const tWarm = Date.now();
    for (const shot of shots) {
      await applyPose(page, shot.pose);
      await page.evaluate('window.__harness.settle(3)');
    }
    report.timings.prewarm = Date.now() - tWarm;
    console.log(`[warm] prewarmed ${shots.length} poses in ${report.timings.prewarm}ms`);

    for (const shot of shots) {
      if (shot.setup) await page.evaluate(shot.setup);
      await applyPose(page, shot.pose);
      await page.evaluate(`window.__harness.settle(${shot.settle ?? 12})`);

      const file = path.join(OUT, `${shot.name}.png`);
      // In-page rAF capture, not page.screenshot: see the note in main.js.
      const t0 = Date.now();
      await page.evaluate('window.__harness.requestCapture()');
      let cap;
      try {
        await page.waitForFunction('window.__harness.captureResult !== null', null, { timeout: BUDGET_MS });
        cap = await page.evaluate('window.__harness.captureResult');
      } catch {
        const fs = await page.evaluate('window.__harness.frameStats()').catch(() => null);
        const cp = await page.evaluate('window.__captureProgress ?? null').catch(() => null);
        const where = cp ? ` stalled in capture stage "${cp.stage}" after ${cp.elapsed}ms at ${cp.width}x${cp.height}` : '';
        report.errors.push(
          `shot "${shot.name}" produced no frame within ${BUDGET_MS}ms` +
            (fs ? ` (last frame ${fs.frame}, ${fs.ms}ms, ${fs.fps}fps)` : ' (page unresponsive)') +
            where
        );
        console.log(`[shot] ${shot.name.padEnd(12)} STALLED after ${BUDGET_MS}ms${fs ? ` — frame ${fs.frame} @ ${fs.ms}ms` : ''}${where}`);
        continue;
      }
      report.timings[`capture:${shot.name}`] = Date.now() - t0;
      if (cap.cost) {
        report.timings[`captureCost:${shot.name}`] = cap.cost;
        console.log(
          `[cap ] ${shot.name.padEnd(12)} wall=${report.timings[`capture:${shot.name}`]}ms  via=${cap.path} readback=${cap.cost.readback} analyse=${cap.cost.analyse} encode=${cap.cost.encode}`
        );
      }
      await writeFile(file, Buffer.from(cap.dataUrl.split(',')[1], 'base64'));

      const stats = await page.evaluate(() => {
        const g = window.GAME;
        const i = g.renderer.info;
        return {
          fps: Math.round(g.time.fps),
          drawCalls: i.render.calls,
          triangles: i.render.triangles,
          programs: i.programs?.length ?? 0,
          textures: i.memory.textures,
          geometries: i.memory.geometries,
        };
      });

      const variance = cap.stats;

      report.shots.push({ name: shot.name, label: shot.label, file: path.relative(ROOT, file), stats, variance });
      console.log(
        `[shot] ${shot.name.padEnd(12)} fps=${String(stats.fps).padStart(3)} draws=${String(stats.drawCalls).padStart(4)} tris=${String(stats.triangles).padStart(8)} mean=${variance.mean} sd=${variance.stddev} clip=${variance.clippedPct}% crush=${variance.crushedPct}%`
      );
      if (variance.stddev < 3) {
        report.errors.push(`shot "${shot.name}" is nearly flat (stddev ${variance.stddev}) — likely a render failure`);
      }
      if (variance.clippedPct > 8) {
        report.warnings.push(`shot "${shot.name}" clips to pure white over ${variance.clippedPct}% of frame`);
      }
      if (variance.crushedPct > 12) {
        report.warnings.push(`shot "${shot.name}" crushes to pure black over ${variance.crushedPct}% of frame`);
      }
    }
  } catch (err) {
    report.errors.push(`harness: ${err.message}`);
    report.serverLog = serverLog.slice(-4000);
    console.error(err);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.errors.length ? `FAIL ${report.errors.length} error(s)` : 'OK'} -> ${path.relative(ROOT, OUT)}/report.json`);
  for (const e of report.errors.slice(0, 20)) console.log(`  ! ${e}`);
  process.exit(report.errors.length ? 1 : 0);
}

main();
