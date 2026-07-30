# Architecture

## Shape of the thing

`src/main.js` builds a `Game` object and boots an ordered list of **subsystems**.
Every subsystem is a class with the same optional lifecycle:

```js
class Subsystem {
  constructor(game) {}       // cheap: store refs, allocate nothing heavy
  async init() {}            // build geometry/textures/materials; may await
  fixedUpdate(dt, elapsed) {}// 120 Hz, deterministic. movement, ballistics, AI
  update(dt, elapsed, paused){}// display rate. cameras, animation, VFX, UI
  postRender(dt) {}          // after the draw
  dispose() {}
}
```

`game` is the shared context. It exposes `renderer`, `scene`, `viewmodelScene`,
`camera`, `time`, `input`, `settings`, `bus`, and every booted subsystem by name
(`game.player`, `game.forge`, `game.collision`, …).

**Rules that keep parallel work from colliding:**

1. A subsystem never imports a sibling subsystem. Reach through `game.<name>` or
   publish on `game.bus`. This is what makes any one module rewritable in place.
2. Boot order in `main.js` is also update order. If you need a system to exist
   before yours, check it in `init()` — do not reorder the list unilaterally.
3. `fixedUpdate` must be deterministic: no `Math.random()` without a seeded
   generator, no reads of `time.dt`.
4. Never allocate in `update`/`fixedUpdate`. Scratch vectors go on the instance.

## Boot order

| # | name | file | owns |
|---|------|------|------|
| 1 | `forge` | `core/AssetForge.js` | every procedural texture, material and mesh |
| 2 | `sky` | `render/Sky.js` | sky dome, sun vector, fog, IBL env map |
| 3 | `lighting` | `render/Lighting.js` | sun + cascaded shadows, local light budget |
| 4 | `postfx` | `render/PostFX.js` | HDR targets, the whole post chain |
| 5 | `level` | `world/Level.js` | map geometry, props, spawns |
| 6 | `collision` | `world/Collision.js` | BVH, capsule sweeps, world rays |
| 7 | `particles` | `render/Particles.js` | pooled GPU particles |
| 8 | `decals` | `render/Decals.js` | projected bullet holes / scorch / blood |
| 9 | `audio` | `audio/AudioEngine.js` | procedural WebAudio synthesis + reverb |
| 10 | `ballistics` | `combat/Ballistics.js` | hitscan, projectiles, damage resolution |
| 11 | `player` | `player/Player.js` | movement, camera, health |
| 12 | `weapons` | `player/WeaponSystem.js` | inventory, fire control, recoil, reloads |
| 13 | `viewmodel` | `player/ViewModel.js` | arms/weapon rig and its animation |
| 14 | `ai` | `ai/AIDirector.js` | enemies, navigation, squad behaviour |
| 15 | `hud` | `ui/HUD.js` | crosshair, ammo, hitmarkers, killfeed, minimap |

## Rendering pipeline

`Engine.render()` draws in three stages:

1. **World** — `scene` through the `PostFX` composer into a half-float HDR target.
2. **Post** — AO, bloom, motion blur, then a single grade pass that does the ACES
   fit, LUT-style colour grading, vignette, chromatic aberration, grain and
   sharpen, then SMAA.
3. **View model** — `viewmodelScene` on `LAYER_VIEWMODEL`, drawn by a second
   camera with a 0.008 near plane after depth is cleared. This is why the weapon
   never clips into walls and can hold a tighter FOV than the world.

The renderer's own tone mapping is **off** (`NoToneMapping`) — PostFX owns the
tone curve so grading happens in linear space. If you add a material, author it
for linear/PBR values, not for sRGB eyeballing.

## No binary assets

There are no `.gltf`, `.png` or `.wav` files in this repo, by design. Geometry is
built from Three primitives and `BufferGeometry` surgery; textures are
synthesised on `OffscreenCanvas` / into `DataTexture`s by `AssetForge`; audio is
WebAudio synthesis. Everything is cached in `AssetForge` so two callers asking
for `"concrete"` share one GPU resource.

Consequences to respect:

- `AssetForge` is the only place allowed to create a texture. If you need a new
  material, register a factory (`forge.registerMaterial('rusted-steel', fn)`) and
  ask for it by name.
- Generation happens at boot and must stay inside a few seconds total. Bake to a
  `DataTexture` once rather than doing per-frame canvas work.

## Capture harness

`node tools/screenshot.mjs` boots the game in headless Chromium (WebGL2 through
SwiftShader), drives a fixed list of camera poses, writes PNGs and a
`report.json` with per-shot FPS, draw calls, triangle counts and a flatness
check. It exits non-zero on any console error or a near-uniform frame, so a
black screen fails the run instead of producing a plausible image.

```
node tools/screenshot.mjs --out shots/round4 --only vista,gunplay
```

Add a pose to `SHOTS` in that file when a new subsystem needs its own review
angle.

### What this box actually costs, and why the harness is built this way

Every number here was measured on this sandbox, not assumed. They are unintuitive
enough that anyone tuning the harness will otherwise "fix" the wrong thing.

- **A captured frame costs roughly one minute** at 960×540 with the post chain,
  and scales with pixel count. That is the software rasteriser. It is not a defect
  in the game, and it must never be traded against visual quality. Resolution is
  the dial: 1280×720 roughly doubles it.
- **Frames nobody reads are never rasterised.** Headless Chromium has no
  compositor consuming the swap, so a `settle(40)` loop retires almost no GPU
  work and appears nearly free. This is why per-frame profiler numbers look
  survivable while a capture takes a minute: the profiler times command
  submission, and the cost lands wherever the frame is finally observed.
  `gl.finish()` does not force it either — it returns in 0.13ms and means nothing
  here.
- **Never read the default framebuffer.** `gl.readPixels` on it,
  `drawImage(glCanvas)` into a 2D canvas, `blitFramebuffer` out of it, and
  `page.screenshot` are all the same underlying path, and all cost 60–100 seconds
  per frame. Capture instead renders a frame into a render target via
  `Engine.renderToTarget()` and reads that. Reading a render target is free by
  comparison.
- **`preserveDrawingBuffer: true` quadruples the cost of every frame.** It makes
  the readback cheap and the game slow; not worth it.
- **The post chain's buffers are half-float and already display-encoded.** A byte
  read against a half-float attachment silently returns nothing, which looks
  exactly like a black frame; and the grade pass ends with the sRGB transfer
  function itself, so encoding it again on the way out washes the image. Both
  handled in `readTargetAsBytes`.
- **TAA history is cold in a still.** Only the captured frame is really
  rasterised, so temporal accumulation has one sample. Do not grade single-frame
  temporal artefacts, and do not "fix" TAA based on a screenshot.
- **Run one harness at a time.** Two concurrent runs on four cores make each
  three to five times slower and produce false stall reports.
- **A killed run must not leave Chromium behind.** One orphan spins the rasteriser
  at two cores and silently poisons every later run; both harnesses install
  signal handlers that SIGKILL the browser process.
- **Hot reload is off for harness runs** (`tools/vite.harness.config.js`).
  Otherwise an edit by a concurrent agent reloads the page mid-run and destroys
  the execution context. Both harnesses also send `Cache-Control: no-cache`, so a
  run can never verify a module the browser cached from an earlier one.

`PostFX.renderTo()` exists for this: it renders the chain into the composer's own
buffer instead of the screen and returns it. Whoever owns PostFX must keep that
method working, or captures silently fall back to an ungraded frame — which the
harness reports as an error rather than letting anyone review it.

## Behavioural harness

`node tools/playtest.mjs` is the counterpart for gameplay: it drives real input
through `Input`'s own state and asserts on the simulation rather than on pixels —
distance covered per second of walking, the slide's boost and decay, a sprint into
a wall that stops instead of tunnelling, ammo and reload bookkeeping. It runs at
320×180 with the post chain off, because none of it looks at a pixel, which is
what makes it cheap enough to run in a loop.

```
node tools/playtest.mjs --only walk,slide --port 5801
```

Assertions tagged `spec` cover subsystems that are not written yet: they are the
contract those modules have to satisfy and are expected to fail until they are.
Only `core` failures and console errors fail the run.
