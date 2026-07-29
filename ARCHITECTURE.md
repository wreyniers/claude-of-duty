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
