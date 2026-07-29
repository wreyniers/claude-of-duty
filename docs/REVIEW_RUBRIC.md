# Visual review rubric

This is the checklist the review agents grade screenshots against. It exists
because "does it look AAA" is not a gradeable question, but the specific things
that make a modern shooter frame read as AAA *are* gradeable, and a frame that
misses them looks amateur in a way you can name.

## How to run a review

1. `node tools/screenshot.mjs --out shots/<round>` — fails the round outright on
   any console error or a near-flat frame.
2. Read every PNG. Grade each axis below **0–10**. Cite what you actually see in
   the image, with coordinates or a described region. A grade with no cited pixel
   evidence does not count.
3. Any axis under **7** fails the round. Report the *specific pixel-level defect*
   and the *specific technique* that would fix it.

Be harsh. The default verdict is fail. "Looks decent" is a fail. The failure
modes below are the ones that make hobby Three.js scenes instantly identifiable,
and each of them has a named fix — if you cannot name the fix, you have not
diagnosed the problem.

## The axes

### 1. Tone & exposure (0–10)
- Is there a real ACES-style filmic curve, or do bright areas clip to flat white
  and shadows crush to pure black?
- Highlight rolloff: a sunlit surface should desaturate toward white gradually.
- Are shadows *tinted* (sky-blue bounce) rather than neutral grey? Untinted
  shadows are the single most common tell.
- **Fail:** banding in the sky gradient, blown-out sky with no gradient, midtones
  sitting in a narrow grey band.

### 2. Material response (0–10)
- Every surface needs albedo + normal + roughness variation. Uniform roughness
  across a whole wall is a fail.
- Roughness must vary *spatially* — wear on edges, polish where hands touch,
  grime in crevices. Constant-roughness plastic look is a fail.
- Specular: is there a visible highlight that moves with view direction? Is metal
  actually metal (no diffuse, coloured specular)?
- Normal maps must show at correct scale — detail should be readable at 1 m and
  not turn to noise at 10 m.
- **Fail:** anything reading as "flat coloured plastic", tiling repeats visible
  at a glance, normal maps that look like embossed noise.

### 3. Shadows & contact (0–10)
- Every object must be *visually attached to the ground*. A floating look means
  missing contact shadow / AO.
- Shadow penumbra should widen with distance from the contact point.
- Check for peter-panning (shadow detached from the caster's base), acne
  (stippled self-shadow), and cascade seams.
- Indirect occlusion in corners, under ledges, inside recesses.
- **Fail:** hard-edged uniform-width shadows, no AO darkening in corners, visible
  shadow-map pixelation on a nearby surface.

### 4. Composition & scene density (0–10)
- Is there foreground, midground and background? A frame with one plane of
  interest is a fail.
- Silhouette variety: does the skyline have shape, or is it a flat box row?
- Detail density: modern shooters put clutter everywhere — pipes, cables, debris,
  signage, decals, vegetation. Empty floors are a fail.
- Does the geometry look *built* (trim, edges, thickness, bevels) rather than
  primitive boxes with a texture?
- **Fail:** obvious untextured primitives, repeated identical props in a row,
  large empty areas, everything at the same scale.

### 5. Atmosphere & depth (0–10)
- Aerial perspective: distant geometry must lift in value and shift toward the
  sky colour. No fog = flat depth = fail.
- Light shafts / volumetrics where the sun is occluded.
- Airborne particulate: dust motes, haze. A perfectly clean air volume looks
  synthetic.
- **Fail:** distant objects as saturated and contrasty as near ones.

### 6. Post-processing discipline (0–10)
- Bloom must come only from genuinely bright HDR sources and must not veil the
  whole frame.
- Aliasing: check high-contrast silhouette edges at 1:1 pixels. Jaggies are a
  fail; so is TAA smearing/ghosting behind moving objects.
- Grain, chromatic aberration and vignette should be *barely perceptible*
  individually. Overdone post is as much a fail as none.
- **Fail:** whole-frame haze, hard jaggies on rooflines, visible CA on the whole
  image rather than at the corners, plastic over-sharpening halos.

### 7. View model quality (0–10) — `gunplay` shot
- Weapon must have real mechanical detail: separate receiver / barrel / handguard
  / optic / magazine / stock, with visible material differences between them.
- Hands must have believable grip and proportion, and read as skin.
- Weapon lighting should feel keyed and separate from the world without looking
  pasted on.
- Muzzle flash must light the environment, not just draw a sprite.
- **Fail:** a box-shaped gun, one uniform material for the whole weapon, no
  hands, flash that doesn't cast light.

### 8. HUD craft (0–10)
- Typography: correct weight and tracking, no default browser font.
- Crosshair reacts to state (spread while moving, hidden in ADS).
- Hierarchy: ammo, health and hit feedback should be findable without hunting.
- **Fail:** unstyled text, jarring pure-white UI over the frame, anything that
  looks like a debug overlay.

## Verdict format

```
ROUND: <n>   SHOT: <name>
tone 6/10 — sky clips to 255,255,255 across the top third; no rolloff. Needs the
  ACES fit applied before the sky is written, and sun disc intensity dropped.
materials 4/10 — the crate at centre-left is uniform 0.8 roughness; no edge wear.
  Needs a roughness map driven by curvature + a triplanar grunge overlay.
...
VERDICT: FAIL (materials, shadows)
NEXT: <ordered, specific, implementable fixes>
```

## Honest note on the side-by-side

The original brief asked for a blind A/B against real Call of Duty frames. This
repo cannot do that honestly: shipped Call of Duty frames are copyrighted
material that is not present here and that we are not going to obtain, and the
comparison would be rigged anyway — those frames come from hundreds of gigabytes
of photogrammetry-sourced art, offline-baked global illumination and a native
engine budgeted for a dedicated GPU. A procedural browser renderer will not win
that test, and a review agent claiming it did would be telling you what you want
to hear.

What this rubric does instead is grade against the *named techniques* that
produce those frames, which is the part that actually transfers. When an axis
scores 9–10 here, it means that specific technique is present and correctly
tuned — not that the frame is indistinguishable from a shipped AAA title.
