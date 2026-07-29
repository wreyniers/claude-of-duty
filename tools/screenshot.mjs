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
  const report = { url, width: WIDTH, height: HEIGHT, shots: [], errors: [], warnings: [] };

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

    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') report.errors.push(text);
      else if (msg.type() === 'warning') report.warnings.push(text);
    });
    page.on('pageerror', (err) => report.errors.push(`pageerror: ${err.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__harness && window.__harness.ready', null, { timeout: 180000 });
    await page.evaluate('window.__harness.deploy()');
    // Let procedural generation, shadow maps and TAA history settle.
    await page.evaluate('window.__harness.settle(120)');

    const shots = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.name)) : SHOTS;

    for (const shot of shots) {
      if (shot.setup) await page.evaluate(shot.setup);
      await page.evaluate(
        ([x, y, z, yaw, pitch]) => {
          const g = window.GAME;
          const p = g.player;
          if (p) {
            p.position.set(x, y - p.eyeHeight, z);
            p.velocity.set(0, 0, 0);
            p.yaw = yaw;
            p.pitch = pitch;
          }
          g.camera.position.set(x, y, z);
          g.camera.rotation.set(pitch, yaw, 0, 'YXZ');
        },
        shot.pose
      );
      await page.evaluate(`window.__harness.settle(${shot.settle ?? 30})`);

      const file = path.join(OUT, `${shot.name}.png`);
      await page.screenshot({ path: file, type: 'png', timeout: 180000, animations: 'allow', caret: 'initial' });

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

      // A frame that is uniformly one colour is almost always a bug, not a look.
      const variance = await page.evaluate(() => {
        const c = document.getElementById('viewport');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        const w = 64;
        const h = 36;
        // Re-read via a downscaled 2D copy of the canvas to avoid GL readback cost.
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const ctx = tmp.getContext('2d');
        ctx.drawImage(c, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let sum = 0;
        let sumSq = 0;
        const n = w * h;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          sum += l;
          sumSq += l * l;
        }
        const mean = sum / n;
        return { mean: +mean.toFixed(2), stddev: +Math.sqrt(sumSq / n - mean * mean).toFixed(2), gl: gl ? 'ok' : 'missing' };
      });

      report.shots.push({ name: shot.name, label: shot.label, file: path.relative(ROOT, file), stats, variance });
      console.log(
        `[shot] ${shot.name.padEnd(12)} fps=${String(stats.fps).padStart(3)} draws=${String(stats.drawCalls).padStart(4)} tris=${String(stats.triangles).padStart(8)} mean=${variance.mean} sd=${variance.stddev}`
      );
      if (variance.stddev < 3) {
        report.errors.push(`shot "${shot.name}" is nearly flat (stddev ${variance.stddev}) — likely a render failure`);
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
