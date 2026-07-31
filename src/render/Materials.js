import * as THREE from 'three';
import { clamp01, smoothstep } from './Noise.js';

/**
 * The material library: one recipe per surface, each authored as a story about
 * how that surface got worn rather than as a colour with noise on it.
 *
 * A recipe paints into a `Bake` (see AssetForge): a height field, a linear-RGB
 * albedo field, roughness, metalness, an AO multiplier and an alpha. AssetForge
 * then derives the normal map from the height by Sobel and the AO from the same
 * height by a horizon march, so all three maps describe the same surface.
 *
 * The rule every recipe follows, because it is the thing the review rubric
 * fails hardest on: roughness is never constant. Every surface has at least
 * three roughness populations — the intact surface, the part hands/feet/weather
 * have polished, and the part where grime or corrosion has accumulated — and the
 * transitions between them are as sharp or as soft as the physical process is.
 *
 * Shape of a recipe:
 *   tile        metres of world per texture tile (advice for level building)
 *   uvScale     default texture.repeat, i.e. tiles per UV unit
 *   normalScale strength of the derived normal map on the material
 *   size        map size multiplier over forge.mapSize
 *   physical    use MeshPhysicalMaterial (cloth sheen, glass)
 *   mat         extra material parameters
 *   macro       world-space large-scale variation (false disables)
 *   detail      near-field second normal/roughness layer at N x the base UV
 *   heal        world-space gate for the damage this recipe writes to b.damage
 *   dust        strength of the up-facing dust film (false disables)
 *   translucency thin-surface transmission for a sheet the sun gets through
 *   build(b)    paint the fields
 *
 * The last four are all world-space: they are things about a surface that a
 * tiling texture cannot know — which way this face points, how close the camera
 * is, whether *this* stretch of wall is the damaged one. They are declared here
 * and applied by the macro shader in AssetForge; a recipe only says how much.
 */

const fr = (x) => x - Math.floor(x);
/** Triangle wave in [0,1]; the basis for every regular ridge/rib/lug pattern. */
const tri = (x) => Math.abs(fr(x) * 2 - 1);

function s2l(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB hex -> linear RGB triple. Recipes name colours the way an artist would. */
function lin(hex) {
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}

function mixc(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Palette pick from a 0..1 selector. Clamped: an id of exactly 1 must not index off the end. */
function pick(arr, t) {
  const i = (t * arr.length) | 0;
  return arr[i >= arr.length ? arr.length - 1 : i];
}

function hash01(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Lattice sampler for brick / tile / plank patterns. Results land on a shared
 * scratch object instead of a returned literal: these are called once per texel
 * per material and a fresh object each time would be millions of allocations
 * during a bake.
 */
const CELL = { fx: 0, fy: 0, col: 0, row: 0, edge: 0, id: 0 };
function cell(u, v, cols, rows, stagger = 0, jitter = 0) {
  const ry = v * rows;
  const row = Math.floor(ry);
  const shift = (row & 1) * 0.5 * stagger + (jitter ? hash01(row, 3.1) * jitter : 0);
  const bx = u * cols + shift;
  const col = Math.floor(bx);
  CELL.fx = bx - col;
  CELL.fy = ry - row;
  CELL.col = col;
  CELL.row = row;
  // Distance to the nearest cell border, expressed in UV units so a mortar
  // width means the same thing whatever the aspect of the cell.
  CELL.edge = Math.min(Math.min(CELL.fx, 1 - CELL.fx) / cols, Math.min(CELL.fy, 1 - CELL.fy) / rows);
  CELL.id = hash01(col, row);
  return CELL;
}

const R_MIN = 0.045;
const rgh = (v) => (v < R_MIN ? R_MIN : v > 1 ? 1 : v);

export const MATERIAL_RECIPES = {
  /* ------------------------------------------------------------- masonry */

  concrete_cast: {
    tile: 2.5,
    uvScale: 3,
    normalScale: 0.85,
    macro: { scale: 0.062, albedo: 0.2, rough: 0.17, grime: 0.26, patch: 0.14, patchFreq: 0.32, runs: 0.42, runFreq: 1.2 },
    // The single largest surface in the frame and the one the camera stands on, so
    // it is the surface that most needs something under a one-metre read: at
    // 2.5 m a tile the base map is about a centimetre a texel, which is five
    // screen pixels of the same value at knee height.
    detail: { freq: 9, normal: 0.5, rough: 0.2, fade: 7 },
    build(b) {
      // gain above 0.5 deliberately: a mathematically clean fBm spectrum reads as
      // soft cloud at texture scale, and cement grain is not soft.
      const grain = b.fbm({ freq: 12, octaves: 6, gain: 0.62 });
      // freq 5, not 3: a mask with two blobs per tile is a shape the eye memorises
      // and then sees repeating. Several smaller features per tile do not read as a
      // motif, and the genuinely large-scale variation comes from the world-space
      // macro term instead, which never repeats.
      const damp = b.warp(b.fbm({ freq: 5, octaves: 4, seed: 91 }), { freq: 3, amount: b.size * 0.05 });
      const voids = b.cells({ freq: 22, jitter: 1, mode: 'f1', seed: 707 });
      // Every cell of a cellular field has a feature point, so using F1 raw puts a
      // pit in every cell and the result reads as perforated metal. The cell id
      // gates which cells got a bug hole and how big it is.
      const voidId = b.cells({ freq: 22, jitter: 1, mode: 'id', seed: 707 });
      const agg = b.cells({ freq: 38, mode: 'id', seed: 1301 });
      const base = lin(0x9a9389);
      const wet = lin(0x4e4a41);
      const pale = lin(0xb7b0a0);
      const grimy = lin(0x413d35);
      b.normalStrength = 0.85;
      b.aoRelief = 0.32;
      b.each((i, u, v) => {
        // Form-board seams: cast concrete remembers the shuttering it was poured
        // against, and those horizontal lines are most of what says "cast".
        // One board line per tile, not two: at a metre per tile, two reads as
        // planking rather than as shuttering.
        const seam =
          smoothstep(0.014, 0, Math.abs(tri(v) - 1)) * 0.8 + smoothstep(0.005, 0, Math.abs(tri(u * 0.5) - 1)) * 0.12;
        const pit = voidId[i] > 0.66 ? smoothstep(0.055 + (voidId[i] - 0.66) * 0.14, 0.01, voids[i]) : 0;
        const g = grain[i];
        const stain = clamp01(damp[i] * 1.5 - 0.35);
        b.height[i] = 0.62 + (g - 0.5) * 0.34 - pit * 0.55 - seam * 0.24;
        let c = mixc(base, wet, stain * 0.7);
        // Exposed sand grains: only on the parts the cement skin has worn off, and
        // only in the top eighth of the cell field. At the density this recipe is
        // tiled at on the square — a metre of paving per 85 texels — a wider gate
        // put a bright grain every 8 cm across the largest surface in the frame,
        // and forty metres of that reads as television static rather than as
        // concrete. Same reason the grain's own albedo swing is halved: the
        // mid-scale patch term in the macro shader is what should carry the
        // variation here, because it is the one that does not repeat.
        c = mixc(c, pale, agg[i] > 0.88 ? (agg[i] - 0.88) * 2.4 * smoothstep(0.45, 0.85, g) : 0);
        c = mixc(c, grimy, pit * 0.55 + seam * 0.3);
        b.rgb(i, ...c);
        b.scale(i, 0.91 + g * 0.19);
        // Traffic and rain polish the raised, exposed parts; the recessed
        // laitance dust and the air voids stay chalky.
        const polish = smoothstep(0.5, 0.95, g) * (1 - stain);
        b.rough[i] = rgh(0.8 - polish * 0.3 + stain * 0.12 + pit * 0.18 + seam * 0.1);
        b.aoMul[i] = 1 - pit * 0.3 - seam * 0.12;
      });
    },
  },

  concrete_pitted: {
    tile: 2.5,
    uvScale: 3,
    normalScale: 1.5,
    macro: { scale: 0.06, albedo: 0.17, rough: 0.15, grime: 0.3, patch: 0.14, patchFreq: 0.3, runs: 0.45, runFreq: 1.3 },
    detail: { freq: 9, normal: 0.55, rough: 0.24, fade: 7 },
    // Every mask in a tiling texture tiles, including the one that exists to make
    // the damage regional — so at 2.5 m a tile the "regional" gate repeated twice
    // across a 4 m pedestal and painted the identical crack network on all of it.
    // The bake now writes what is damage into b.damage and the world-space gate
    // decides where damage happens at all, which is the only place that decision
    // can be made without a seam.
    heal: { amount: 0.92, threshold: 0.46, rough: 0.66, tint: 0x8b8880, normal: 0.85 },
    build(b) {
      const spall = b.cells({ freq: 13, jitter: 1, mode: 'f1', seed: 21 });
      const spallId = b.cells({ freq: 13, jitter: 1, mode: 'id', seed: 21 });
      const cracks = b.warp(b.cells({ freq: 8, mode: 'edge', seed: 88 }), { freq: 4, amount: b.size * 0.035 });
      const grain = b.fbm({ freq: 16, octaves: 6, gain: 0.6, seed: 5 });
      const agg = b.cells({ freq: 34, mode: 'id', seed: 1301 });
      const region = b.fbm({ freq: 1.7, octaves: 3, seed: 1777 });
      const face = lin(0x8b8880);
      const core = lin(0x9d968a);
      const dark = lin(0x3a3732);
      b.normalStrength = 1.3;
      b.aoRelief = 0.65;
      /**
       * A spall is a conchoidal fracture: the cement skin lets go along a plane and
       * leaves a shallow floor behind a near-vertical wall. The wall is the whole
       * read — it is the only thing that gives the pit a lit side and a shadowed
       * one, and a pit shaded from a soft bowl instead is a flat grey disc however
       * deep it is. So the transition band is under a third of the radius, and the
       * radius comes off the cell id: identically sized pits on an even lattice is
       * the other half of what made this read as crazy paving.
       */
      const craterAt = (i) => {
        const id = spallId[i];
        if (id < 0.58) return 0;
        const rad = 0.13 + (id - 0.58) * 0.62;
        return smoothstep(rad, rad * 0.72, spall[i]);
      };
      const crackAt = (i) => smoothstep(0.055, 0.006, cracks[i]) * smoothstep(0.5, 0.72, region[i]);
      b.each((i) => {
        b.height[i] = 0.72 + (grain[i] - 0.5) * 0.22 - craterAt(i) * 0.62 - crackAt(i) * 0.3;
      });
      // Curvature separates the crater rims from their floors; the rim is where
      // the cement skin broke away and the aggregate is proud and sharp.
      const cv = b.curv(b.height, 2);
      b.each((i) => {
        const crater = craterAt(i);
        const crack = crackAt(i);
        const rim = clamp01(cv[i] * 16);
        const stone = agg[i] > 0.7 ? (agg[i] - 0.7) * 3.3 : 0;
        let c = mixc(face, core, crater * 0.85);
        c = mixc(c, lin(0xb8ad9c), stone * crater);
        c = mixc(c, dark, crack * 0.9);
        b.rgb(i, ...c);
        b.scale(i, 0.82 + grain[i] * 0.36);
        b.rough[i] = rgh(0.6 + crater * 0.32 + crack * 0.3 + rim * 0.16 - smoothstep(0.5, 1, grain[i]) * 0.14);
        b.aoMul[i] = 1 - crater * 0.32 - crack * 0.4;
        b.damage[i] = clamp01(crater * 0.95 + crack);
      });
    },
  },

  brick_red: {
    tile: 2,
    uvScale: 2,
    normalScale: 1.25,
    macro: { scale: 0.05, albedo: 0.16, rough: 0.1, grime: 0.3, tint: 0x59503f, patch: 0.12, patchFreq: 0.68, runs: 0.5, runFreq: 1.7 },
    build(b) {
      const clay = b.fbm({ freq: 22, octaves: 4 });
      const grit = b.fbm({ freq: 36, octaves: 3, seed: 41 });
      const effl = b.warp(b.fbm({ freq: 4, octaves: 4, seed: 313 }), { freq: 3, amount: b.size * 0.05 });
      const red = [lin(0x7d3a2b), lin(0x8f4b34), lin(0x6a2f26), lin(0x94553c), lin(0x5d2f2a)];
      const mortarC = lin(0xa6a29a);
      const chalk = lin(0xc9c6bc);
      b.normalStrength = 1.2;
      b.aoRelief = 0.75;
      b.aoSpread = 0.05;
      b.each((i, u, v) => {
        const c = cell(u, v, 4, 9, 1);
        const face = smoothstep(0.004, 0.013, c.edge);
        // A few bricks are chipped at a corner: the mask is per-brick, so it
        // never straddles a mortar joint the way a plain noise mask would.
        const chip = c.id > 0.87 ? smoothstep(0.05, 0.012, c.edge) * smoothstep(0.4, 0.75, clay[i]) : 0;
        b.height[i] = 0.3 + face * 0.42 + face * (clay[i] - 0.5) * 0.12 + (1 - face) * grit[i] * 0.14 - chip * 0.3;
        const tone = pick(red, c.id);
        let col = mixc(tone, lin(0x8a6a52), clay[i] * 0.22);
        col = mixc(mortarC, col, face);
        // Efflorescence: salts leach through the mortar and dust the joint and
        // the brick above it, chalky and much rougher than the fired face.
        const bloom = clamp01(effl[i] * 1.5 - 0.55) * (1 - face * 0.55);
        col = mixc(col, chalk, bloom * 0.7);
        b.rgb(i, ...col);
        b.scale(i, 0.9 + clay[i] * 0.2);
        const fired = 0.66 + clay[i] * 0.14 - smoothstep(0.6, 1, clay[i]) * 0.1;
        b.rough[i] = rgh(face * fired + (1 - face) * 0.94 + bloom * 0.2 + chip * 0.18);
        b.metal[i] = 0;
        b.aoMul[i] = 1 - (1 - face) * 0.3;
      });
    },
  },

  plaster_painted: {
    tile: 3,
    uvScale: 2.5,
    normalScale: 0.5,
    macro: { scale: 0.045, albedo: 0.17, rough: 0.13, grime: 0.3, tint: 0x5c5347, patch: 0.13, patchFreq: 0.55, runs: 0.5, runFreq: 1.5 },
    // Lower than the ground recipes: limewash over plaster is genuinely smooth,
    // and what a close read wants back is the trowel stipple, not aggregate.
    detail: { freq: 8, normal: 0.34, rough: 0.14, fade: 6 },
    build(b) {
      const trowel = b.warp(b.fbm({ freq: 5, octaves: 4 }), { freq: 2, amount: b.size * 0.11 });
      const stipple = b.fbm({ freq: 40, octaves: 2, seed: 71 });
      // A torn paint edge is neither round nor smooth. A cell field gives round
      // blobs however hard it is warped, so the peel mask is a warped fBm pushed
      // through a tight threshold — irregular outline, ragged rim.
      const peel = b.warp(b.fbm({ freq: 6, octaves: 4, seed: 909 }), { freq: 13, amount: b.size * 0.022 });
      const cracks = b.ridge({ freq: 4, octaves: 5, seed: 17 });
      // Crack damage is regional. A ridge network left ungated covers every square
      // metre of every wall in the town at the same density, and a pattern that
      // uniform stops reading as cracking and starts reading as wallpaper — which
      // is exactly what it did once the peel blotches were no longer hiding it.
      const zone = b.warp(b.fbm({ freq: 3, octaves: 3, seed: 421 }), { freq: 2, amount: b.size * 0.08 });
      const paint = lin(0xb6b9ae);
      // Only 20 levels below the paint, not 40. Lime plaster under limewash is
      // barely darker than the wash — what actually distinguishes them is sheen.
      // A 40-level step at a 16 cm blob scale, thresholded near-binary, is a
      // two-tone pattern, and a two-tone pattern at that size on a wall reads as
      // camouflage: it was the loudest thing in the interior frame and it made
      // every facade in the establishing shot look mottled.
      const under = lin(0xa39a89);
      b.normalStrength = 0.55;
      b.aoRelief = 0.4;
      b.each((i) => {
        // Peeling is a hard-edged event: the paint film either is there or is
        // not, so the mask keeps its tight transition and the roughness jumps
        // across it — a soft blend there is what makes procedural paint look like
        // a decal. The threshold is high, though: bare patches are a minority of
        // a painted wall, and at a third of the surface they stop being damage and
        // become the pattern.
        const bare = smoothstep(0.7, 0.755, peel[i] + (trowel[i] - 0.5) * 0.18);
        // A crack in a paint film is a line, not a channel: the threshold is high
        // and narrow so only the ridge crest survives, and the regional gate keeps
        // whole stretches of wall intact.
        const crack = smoothstep(0.76, 0.94, cracks[i]) * smoothstep(0.46, 0.68, zone[i]);
        b.height[i] = 0.58 + (trowel[i] - 0.5) * 0.14 + (stipple[i] - 0.5) * 0.05 - bare * 0.06 - crack * 0.22;
        let c = mixc(paint, under, bare);
        c = mixc(c, lin(0x8a8271), crack * 0.75);
        b.rgb(i, ...c);
        b.scale(i, 0.94 + trowel[i] * 0.12);
        b.rough[i] = rgh((1 - bare) * (0.36 + stipple[i] * 0.1) + bare * 0.9 + crack * 0.2);
        b.aoMul[i] = 1 - crack * 0.3 - bare * 0.08;
      });
    },
  },

  tile_ceramic: {
    tile: 1.6,
    uvScale: 2,
    normalScale: 0.9,
    macro: { scale: 0.08, albedo: 0.09, rough: 0.06, grime: 0.34, tint: 0x4f4a3d, patch: 0.12, patchFreq: 0.7, runs: 0.34 },
    dust: { rough: 0.3, metal: 0.2 },
    mat: { envMapIntensity: 1.25 },
    build(b) {
      const craze = b.ridge({ freq: 26, octaves: 3, seed: 55 });
      const body = b.fbm({ freq: 30, octaves: 3, seed: 12 });
      const grout = b.fbm({ freq: 44, octaves: 2, seed: 99 });
      const glaze = [lin(0xd9d4c6), lin(0xc8c9c2), lin(0xd2c9b6), lin(0xbfc4c1)];
      const groutC = lin(0x938d80);
      b.normalStrength = 0.8;
      b.aoRelief = 0.9;
      b.aoSpread = 0.045;
      b.each((i, u, v) => {
        const c = cell(u, v, 6, 6, 0);
        const face = smoothstep(0.003, 0.011, c.edge);
        const chip = c.id > 0.9 ? smoothstep(0.035, 0.008, c.edge) : 0;
        // Fired tiles dome very slightly; the highlight sliding off that curve is
        // what stops a tiled floor reading as a printed grid.
        const dome = Math.sin(Math.PI * c.fx) * Math.sin(Math.PI * c.fy);
        b.height[i] = 0.42 + face * (0.4 + dome * 0.06) + (1 - face) * grout[i] * 0.12 - chip * 0.35;
        const t = pick(glaze, c.id);
        let col = mixc(groutC, t, face);
        col = mixc(col, lin(0xb9ac96), chip * 0.9);
        const dirt = (1 - face) * (0.35 + grout[i] * 0.4);
        col = mixc(col, lin(0x4a453b), dirt * 0.55);
        b.rgb(i, ...col);
        // The widest roughness spread in the library: fired glaze against
        // cementitious grout is a genuine 0.12 -> 0.94 step.
        const hair = smoothstep(0.62, 0.9, craze[i]) * face;
        b.rough[i] = rgh(face * (0.12 + body[i] * 0.05) + (1 - face) * 0.94 + hair * 0.3 + chip * 0.7);
        b.aoMul[i] = 1 - (1 - face) * 0.4 - chip * 0.2;
      });
    },
  },

  /* ------------------------------------------------------------- ground */

  asphalt: {
    tile: 4,
    uvScale: 3,
    normalScale: 1.15,
    macro: { scale: 0.04, albedo: 0.18, rough: 0.18, grime: 0.16, tint: 0x6a6558, patch: 0.17, patchFreq: 0.26, runs: 0.2 },
    detail: { freq: 10, normal: 0.5, rough: 0.2, fade: 7 },
    build(b) {
      const aggId = b.cells({ freq: 30, mode: 'id', seed: 3 });
      const aggH = b.cells({ freq: 30, mode: 'dome', jitter: 1, seed: 3 });
      const tar = b.fbm({ freq: 9, octaves: 5, seed: 61 });
      const cracks = b.ridge({ freq: 5, octaves: 5, seed: 404 });
      const bitumen = lin(0x35342f);
      const stone = lin(0x7d7a74);
      const pale = lin(0x9c968c);
      b.normalStrength = 1.0;
      b.aoRelief = 0.55;
      b.each((i) => {
        const crack = smoothstep(0.62, 0.94, cracks[i]);
        // Where the bitumen has worn off, the aggregate stands proud; where it
        // has not, the stones are drowned and the surface is smooth and glossy.
        const worn = smoothstep(0.36, 0.8, tar[i]);
        const proud = aggH[i] * worn;
        b.height[i] = 0.5 + proud * 0.4 + (tar[i] - 0.5) * 0.1 - crack * 0.45;
        let c = mixc(bitumen, stone, proud * 0.9);
        c = mixc(c, pale, aggId[i] > 0.72 ? proud * (aggId[i] - 0.72) * 3 : 0);
        c = mixc(c, lin(0x17171a), crack * 0.8);
        b.rgb(i, ...c);
        b.scale(i, 0.8 + aggId[i] * 0.4);
        b.rough[i] = rgh(0.9 - (1 - worn) * 0.42 + proud * 0.06 + crack * 0.05);
        b.aoMul[i] = 1 - crack * 0.4;
      });
    },
  },

  dirt_packed: {
    tile: 4,
    uvScale: 3,
    normalScale: 1.0,
    macro: { scale: 0.05, albedo: 0.18, rough: 0.1, grime: 0.1, patch: 0.17, patchFreq: 0.3, runs: 0.15 },
    detail: { freq: 9, normal: 0.45, rough: 0.18, fade: 6 },
    build(b) {
      const clods = b.cells({ freq: 15, mode: 'dome', jitter: 1, seed: 7 });
      const grit = b.fbm({ freq: 30, octaves: 3, seed: 8 });
      const cracks = b.ridge({ freq: 6, octaves: 5, seed: 202 });
      const damp = b.fbm({ freq: 3, octaves: 4, seed: 77 });
      const dry = lin(0x8a7355);
      const wet = lin(0x4a3a2b);
      const dust = lin(0xa3906c);
      b.normalStrength = 0.95;
      b.aoRelief = 0.5;
      b.each((i) => {
        const crack = smoothstep(0.6, 0.92, cracks[i]);
        b.height[i] = 0.45 + clods[i] * 0.3 + (grit[i] - 0.5) * 0.1 - crack * 0.3;
        let c = mixc(dry, wet, clamp01(damp[i] * 1.3 - 0.2));
        c = mixc(c, dust, smoothstep(0.4, 0.95, clods[i]) * 0.5);
        c = mixc(c, lin(0x2f2419), crack * 0.7);
        b.rgb(i, ...c);
        b.scale(i, 0.88 + grit[i] * 0.25);
        // Compacted, walked-on ground goes slick; loose dust between the clods
        // stays maximally rough.
        const packed = smoothstep(0.35, 0.9, clods[i]) * (1 - damp[i] * 0.4);
        b.rough[i] = rgh(0.95 - packed * 0.24 + crack * 0.03 - damp[i] * 0.08);
        b.aoMul[i] = 1 - crack * 0.3;
      });
    },
  },

  gravel: {
    tile: 2.5,
    uvScale: 3,
    normalScale: 1.7,
    macro: { scale: 0.06, albedo: 0.14, rough: 0.08, grime: 0.12, patch: 0.17, patchFreq: 0.8, runs: 0.32, runFreq: 1.9 },
    detail: { freq: 8, normal: 0.4, rough: 0.16, fade: 5 },
    build(b) {
      const dome = b.cells({ freq: 13, mode: 'dome', jitter: 1, seed: 31 });
      const sid = b.cells({ freq: 13, mode: 'id', jitter: 1, seed: 31 });
      const micro = b.fbm({ freq: 34, octaves: 3, seed: 5 });
      const fill = b.fbm({ freq: 8, octaves: 4, seed: 66 });
      const stones = [lin(0x8d887c), lin(0x6d675e), lin(0x9c9080), lin(0x585349), lin(0xa39a88)];
      const grit = lin(0x6f6555);
      b.normalStrength = 1.6;
      b.aoRelief = 0.95;
      b.aoSpread = 0.05;
      b.each((i) => {
        const d = dome[i];
        b.height[i] = 0.18 + d * 0.72 + (micro[i] - 0.5) * 0.08;
        const onStone = smoothstep(0.06, 0.3, d);
        let c = mixc(grit, pick(stones, sid[i]), onStone);
        c = mixc(c, lin(0x3c362e), (1 - onStone) * 0.5);
        b.rgb(i, ...c);
        b.scale(i, 0.88 + micro[i] * 0.25 + fill[i] * 0.1);
        // Stone crowns are rain-polished, their flanks are not, and the dust
        // trapped between them is the roughest thing in the frame.
        const crown = smoothstep(0.55, 0.95, d);
        b.rough[i] = rgh(0.95 - crown * 0.3 - onStone * 0.08 + (micro[i] - 0.5) * 0.06);
        b.aoMul[i] = 1 - (1 - onStone) * 0.45;
      });
    },
  },

  sand: {
    tile: 3,
    uvScale: 4,
    normalScale: 0.8,
    macro: { scale: 0.07, albedo: 0.11, rough: 0.07, grime: 0.06, patch: 0.14, patchFreq: 0.22, runs: 0.1 },
    detail: { freq: 12, normal: 0.35, rough: 0.12, fade: 5 },
    build(b) {
      const drift = b.fbm({ freq: 3, octaves: 4, seed: 19 });
      const grain = b.fbm({ freq: 48, octaves: 2, seed: 23 });
      const coarse = b.cells({ freq: 40, mode: 'id', seed: 91 });
      const dry = lin(0xc4a97a);
      const damp = lin(0x8f7549);
      b.normalStrength = 0.75;
      b.aoRelief = 0.35;
      b.each((i, u, v) => {
        // Wind ripples: a sine train whose phase is pushed around by a low
        // frequency field, which is what gives real ripples their wander.
        const phase = u * 8 + drift[i] * 1.9 + v * 1.5;
        const rip = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
        b.height[i] = 0.35 + rip * 0.36 + (grain[i] - 0.5) * 0.05;
        const c = mixc(dry, damp, clamp01((1 - rip) * 0.5 * drift[i] * 1.6));
        b.rgb(i, ...c);
        b.scale(i, 0.9 + grain[i] * 0.22);
        // Quartz glints: a small fraction of texels get a much lower roughness,
        // which reads as sparkle in sunlight instead of as a uniform matte sheet.
        const glint = coarse[i] > 0.965 ? 0.4 : 0;
        b.rough[i] = rgh(0.78 - rip * 0.08 + (grain[i] - 0.5) * 0.12 - glint);
      });
    },
  },

  /* ------------------------------------------------------------- metals */

  steel_brushed: {
    tile: 1.5,
    uvScale: 2,
    normalScale: 0.4,
    macro: { scale: 0.09, albedo: 0.07, rough: 0.1, grime: 0.14, patch: 0.06, patchFreq: 0.9, runs: 0.16 },
    dust: { rough: 0.34, metal: 0.5 },
    mat: { envMapIntensity: 1.5 },
    build(b) {
      // Brushing is anisotropic by definition: the same field sampled ~40:1
      // across versus along the grain. Isotropic noise on metal never reads as
      // brushed, it reads as dirty.
      const brush = b.fbm({ freq: 3, freqY: 90, octaves: 3 });
      const fine = b.fbm({ freq: 5, freqY: 110, octaves: 2, seed: 44 });
      const dings = b.cells({ freq: 16, jitter: 1, mode: 'f1', seed: 12 });
      const dingId = b.cells({ freq: 16, jitter: 1, mode: 'id', seed: 12 });
      const steel = lin(0xb7bbbf);
      b.normalStrength = 0.35;
      b.aoRelief = 0.2;
      b.each((i) => {
        // Sparse: a dent in every cell is a lattice, and the eye reads lattices.
        const ding = dingId[i] > 0.78 ? smoothstep(0.07, 0.015, dings[i]) : 0;
        b.height[i] = 0.55 + (brush[i] - 0.5) * 0.14 + (fine[i] - 0.5) * 0.06 - ding * 0.4;
        b.rgb(i, ...steel);
        b.scale(i, 0.92 + brush[i] * 0.16 - ding * 0.2);
        // Tight enough to hold a highlight on a 5 cm tube. Brushed steel at 0.4
        // roughness has a lobe wider than a railing is thick, so every tap of the
        // env map lands on the same value and the tube renders as a flat line —
        // which is exactly how a pipe stops reading as metal.
        b.rough[i] = rgh(0.13 + brush[i] * 0.15 + fine[i] * 0.05 + ding * 0.3);
        // Metal, so metalness 1 and no diffuse: the colour lives in the specular.
        b.metal[i] = 1 - ding * 0.2;
      });
    },
  },

  steel_rusted: {
    tile: 2,
    uvScale: 2.5,
    normalScale: 1.4,
    macro: { scale: 0.055, albedo: 0.15, rough: 0.1, grime: 0.2, tint: 0x5a3a24, patch: 0.15, patchFreq: 0.85, runs: 0.42, runFreq: 2.1 },
    dust: { rough: 0.34, metal: 0.5 },
    mat: { envMapIntensity: 1.35 },
    build(b) {
      const bloom = b.warp(b.fbm({ freq: 4, octaves: 5, seed: 3 }), { freq: 2, amount: b.size * 0.07 });
      const flake = b.fbm({ freq: 26, octaves: 4, seed: 81 });
      const runs = b.fbm({ freq: 22, freqY: 3, octaves: 4, seed: 17 });
      const pit = b.cells({ freq: 18, jitter: 1, mode: 'f1', seed: 5 });
      const pitId = b.cells({ freq: 18, jitter: 1, mode: 'id', seed: 5 });
      const bare = lin(0x8a9096);
      const rustA = lin(0x8e441b);
      const rustB = lin(0xa85f28);
      const rustC = lin(0x402413);
      b.normalStrength = 1.3;
      b.aoRelief = 0.6;
      b.each((i) => {
        // Rust starts at pits and runs downhill in streaks; the streak field is
        // stretched along v so it reads as gravity, not as blotch.
        const deep = pitId[i] > 0.7 ? smoothstep(0.12, 0.01, pit[i]) : 0;
        const corr = clamp01(bloom[i] * 1.6 - 0.45 + runs[i] * 0.35 + deep * 0.6);
        const hard = smoothstep(0.3, 0.62, corr);
        b.height[i] = 0.6 + (flake[i] - 0.5) * 0.1 + hard * (flake[i] - 0.35) * 0.4 - deep * 0.35;
        let c = bare;
        c = mixc(c, mixc(rustA, rustB, flake[i]), hard);
        c = mixc(c, rustC, hard * smoothstep(0.55, 0.15, flake[i]) * 0.8);
        b.rgb(i, ...c);
        // The bare steel between the blooms has to stay tight: on a 7 cm stall
        // pole almost the whole silhouette is that steel, and it is the only thing
        // that can carry a highlight down the length of the tube.
        b.rough[i] = rgh(0.19 + flake[i] * 0.07 + hard * 0.56);
        // Iron oxide is not a metal, but a rusted pole that drops to metalness 0.1
        // has no specular left at all and reads as terracotta. Compact oxide over
        // steel keeps some of it, so the floor is 0.28 rather than zero.
        b.metal[i] = 1 - hard * 0.72;
        b.aoMul[i] = 1 - hard * 0.15;
      });
    },
  },

  iron_painted_chipped: {
    tile: 2,
    uvScale: 2.5,
    normalScale: 1.0,
    macro: { scale: 0.07, albedo: 0.12, rough: 0.1, grime: 0.2, patch: 0.12, patchFreq: 0.9, runs: 0.34, runFreq: 2.2 },
    // A gloss coat that faces the sky is the one place a dust film changes the
    // read completely: without it the horizontal faces mirror the zenith.
    dust: { rough: 0.42, metal: 0.55 },
    // Industrial enamel over steel is a gloss coat, and the env map is where its
    // highlight comes from. Without this the top rail of a balcony railing has no
    // specular event anywhere along its run.
    mat: { envMapIntensity: 1.45 },
    build(b) {
      // The chip outline is warped so it is not a disc; the id field decides
      // which cells have lost paint at all.
      const chips = b.warp(b.cells({ freq: 11, jitter: 1, mode: 'f1', seed: 61 }), { freq: 16, amount: b.size * 0.018 });
      const chipId = b.cells({ freq: 11, jitter: 1, mode: 'id', seed: 61 });
      const orange = b.fbm({ freq: 20, octaves: 3, seed: 9 });
      const scratch = b.fbm({ freq: 70, freqY: 6, octaves: 2, seed: 33 });
      const paint = lin(0x515a46);
      const paint2 = lin(0x3b4235);
      const iron = lin(0x5c5d60);
      const rust = lin(0x7d4a28);
      b.normalStrength = 1.0;
      b.aoRelief = 0.45;
      b.each((i) => {
        // A chip is a step in a paint film a few tenths of a millimetre thick:
        // the transition has to be almost binary, and the roughness has to jump
        // with it. This is the "sharp roughness break at a chipped edge" case.
        const inside = chipId[i] > 0.58 ? smoothstep(0.26, 0.2, chips[i]) : 0;
        const rim = chipId[i] > 0.58 ? smoothstep(0.2, 0.3, chips[i]) * smoothstep(0.36, 0.28, chips[i]) : 0;
        // Hands, sleeves and weather burnish a railing along the scratch grain
        // until the paint film there is polished rather than merely intact.
        const burnish = smoothstep(0.55, 0.95, scratch[i]);
        b.height[i] = 0.66 - inside * 0.3 + (orange[i] - 0.5) * 0.06 - scratch[i] * 0.04;
        let c = mixc(paint, paint2, orange[i]);
        c = mixc(c, iron, inside);
        c = mixc(c, rust, rim * 0.8 + inside * orange[i] * 0.35);
        b.rgb(i, ...c);
        // What a chip exposes is corroded iron, not a polished panel: 0.62, not the
        // 0.24 this had. At 0.24 with metalness near 1 the chip mask stopped being
        // damage and became a mirror — every chip on the wrecked car took the sun
        // as a hard blown white blotch three stops over a sunlit plaster wall, over
        // a body sitting at a tenth of that. Enamel keeps its own gloss; it is a
        // dielectric with F0 pinned at 0.04 and cannot blow out the same way.
        b.rough[i] = rgh(
          (1 - inside) * (0.26 + orange[i] * 0.09 - burnish * 0.1) + inside * 0.62 + rim * 0.45 + scratch[i] * 0.04
        );
        // Paint is a dielectric, so its own metalness stays 0 — but where the film
        // has burnished thin the steel underneath starts to show through, and that
        // partial metal is what gives the polished stretches a coloured highlight
        // instead of a white one. Partial is the operative word: this is a hint of
        // metal under a worn coat, not exposed bright steel.
        b.metal[i] = clamp01(inside * 0.45 * (1 - rim * 0.6) + burnish * 0.12 * (1 - inside));
        b.aoMul[i] = 1 - inside * 0.2;
      });
    },
  },

  aluminium_scuffed: {
    tile: 1.5,
    uvScale: 2,
    normalScale: 0.45,
    macro: { scale: 0.1, albedo: 0.06, rough: 0.12, grime: 0.12, patch: 0.05, patchFreq: 1.0, runs: 0.14 },
    dust: { rough: 0.3, metal: 0.45 },
    mat: { envMapIntensity: 1.5 },
    build(b) {
      const swirl = b.warp(b.fbm({ freq: 4, freqY: 48, octaves: 3 }), { freq: 5, amount: b.size * 0.05 });
      const scuff = b.fbm({ freq: 24, octaves: 3, seed: 71 });
      const gouge = b.fbm({ freq: 60, freqY: 8, octaves: 2, seed: 5 });
      const alu = lin(0xc6c9cd);
      b.normalStrength = 0.4;
      b.aoRelief = 0.18;
      b.each((i) => {
        b.height[i] = 0.55 + (swirl[i] - 0.5) * 0.1 - gouge[i] * 0.06;
        b.rgb(i, ...alu);
        b.scale(i, 0.94 + scuff[i] * 0.1);
        // Scuffing is directional abrasion over a polished base, so most of the
        // surface stays tight and the scuffs are the rough minority.
        b.rough[i] = rgh(0.14 + swirl[i] * 0.24 + scuff[i] * 0.09 + gouge[i] * 0.18);
        b.metal[i] = 1;
      });
    },
  },

  corrugated_metal: {
    tile: 2.5,
    uvScale: 2,
    normalScale: 1.1,
    macro: { scale: 0.06, albedo: 0.12, rough: 0.1, grime: 0.22, tint: 0x6a4a2c, patch: 0.14, patchFreq: 0.75, runs: 0.5, runFreq: 2.4 },
    dust: { rough: 0.36, metal: 0.5 },
    build(b) {
      const spangle = b.cells({ freq: 22, mode: 'id', seed: 12 });
      const rustF = b.fbm({ freq: 13, freqY: 3, octaves: 4, seed: 88 });
      const dent = b.fbm({ freq: 12, octaves: 3, seed: 4 });
      const zinc = lin(0x9aa0a4);
      const rust = lin(0x7e4726);
      const rustDark = lin(0x452a1c);
      b.normalStrength = 1.0;
      b.aoRelief = 0.5;
      b.each((i, u, v) => {
        // Trapezoidal profile, not a sine: rolled sheet has flats on the crown
        // and the valley, and the flat is where the specular streak comes from.
        const t = tri(u * 6);
        const rib = smoothstep(0.12, 0.88, t);
        b.height[i] = 0.15 + rib * 0.75 + (dent[i] - 0.5) * 0.08;
        // Water sits in the valleys, so that is where the zinc fails first.
        const corr = clamp01(rustF[i] * 1.5 - 0.98 + (1 - rib) * 0.5);
        const hard = smoothstep(0.26, 0.62, corr);
        const c = mixc(zinc, mixc(rust, rustDark, dent[i]), hard);
        b.rgb(i, ...c);
        // Galvanising spangle: the zinc crystal mottle, which is the tell that
        // this is hot-dip sheet and not painted steel.
        b.scale(i, 0.92 + spangle[i] * 0.16);
        b.rough[i] = rgh(0.38 + spangle[i] * 0.16 + hard * 0.5);
        b.metal[i] = 1 - hard * 0.85;
        b.aoMul[i] = 1 - (1 - rib) * 0.18;
      });
    },
  },

  /* --------------------------------------------------------------- wood */

  wood_plank_weathered: {
    tile: 2,
    uvScale: 2,
    normalScale: 1.15,
    macro: { scale: 0.06, albedo: 0.14, rough: 0.1, grime: 0.24, tint: 0x554836, patch: 0.14, patchFreq: 0.85, runs: 0.28, runFreq: 2.2 },
    build(b) {
      const grain = b.warp(b.fbm({ freq: 3, freqY: 64, octaves: 5 }), { freq: 4, amount: b.size * 0.02 });
      const fibre = b.fbm({ freq: 8, freqY: 120, octaves: 2, seed: 51 });
      const knots = b.cells({ freq: 5, jitter: 1, mode: 'f1', seed: 303 });
      const knotId = b.cells({ freq: 5, jitter: 1, mode: 'id', seed: 303 });
      const split = b.fbm({ freq: 6, freqY: 90, octaves: 3, seed: 77 });
      const pale = lin(0x8d8272);
      const mid = lin(0x6b543a);
      const dark = lin(0x40311f);
      b.normalStrength = 1.05;
      b.aoRelief = 0.7;
      b.aoSpread = 0.045;
      b.each((i, u, v) => {
        const c = cell(u, v, 2, 5, 0, 1.7);
        const face = smoothstep(0.002, 0.009, c.edge);
        const g = grain[i];
        // Weathering erodes the soft early wood and leaves the hard grain proud,
        // which is why old timber feels ribbed along the grain.
        const ring = Math.abs(g - 0.5) * 2;
        // A knot in every cell is a polka dot pattern; a board has one or two.
        const knot = knotId[i] > 0.82 ? smoothstep(0.14, 0.04, knots[i]) : 0;
        const crack = smoothstep(0.82, 0.97, split[i]) * face;
        b.height[i] = 0.35 + face * (0.4 + ring * 0.16 + fibre[i] * 0.06) - knot * 0.12 - crack * 0.3;
        let col = mixc(mid, pale, 0.35 + c.id * 0.5);
        col = mixc(col, dark, ring * 0.55 + knot * 0.75);
        col = mixc(col, lin(0x2a2118), (1 - face) * 0.85 + crack * 0.6);
        b.rgb(i, ...col);
        b.scale(i, 0.9 + fibre[i] * 0.2);
        // Nail heads near each plank end: small, metal, and the one place on the
        // plank with a specular highlight. Cheap detail, big readability payoff.
        const ndx = Math.min(Math.abs(c.fx - 0.07), Math.abs(c.fx - 0.93)) / 0.028;
        const ndy = (c.fy - 0.5) / 0.075;
        const nail = smoothstep(1, 0.6, Math.sqrt(ndx * ndx + ndy * ndy));
        const centre = 1 - Math.abs(c.fy - 0.5) * 2;
        b.rough[i] = rgh(
          face * (0.9 - smoothstep(0.3, 1, centre) * 0.24 - (1 - ring) * 0.06) + (1 - face) * 0.95 + crack * 0.05
        );
        if (nail > 0) {
          b.mix(i, lin(0x55565a), nail);
          b.rough[i] = rgh(b.rough[i] * (1 - nail) + 0.42 * nail);
          b.metal[i] = nail * 0.9;
          b.height[i] -= nail * 0.06;
        }
        b.aoMul[i] = 1 - (1 - face) * 0.45 - crack * 0.25;
      });
    },
  },

  wood_ply: {
    tile: 2.4,
    uvScale: 2.5,
    normalScale: 0.5,
    macro: { scale: 0.07, albedo: 0.12, rough: 0.09, grime: 0.2, tint: 0x5b4c36, patch: 0.13, patchFreq: 0.9, runs: 0.26 },
    build(b) {
      // Rotary-cut veneer: wide, cathedral-shaped figure, and almost no relief
      // because the sheet is sanded flat. Distinct from plank in every axis.
      const swirl = b.warp(b.fbm({ freq: 2, freqY: 20, octaves: 4 }), { freq: 2, amount: b.size * 0.14 });
      const sand = b.fbm({ freq: 44, freqY: 12, octaves: 2, seed: 27 });
      const patch = b.fbm({ freq: 6, octaves: 3, seed: 5 });
      const birch = lin(0xbb9c6e);
      const figure = lin(0x8a6a44);
      const glue = lin(0x6e5636);
      b.normalStrength = 0.45;
      b.aoRelief = 0.3;
      b.each((i, u, v) => {
        const rings = Math.abs(Math.sin(swirl[i] * Math.PI * 7));
        const seam = smoothstep(0.004, 0.014, Math.min(fr(v * 2), 1 - fr(v * 2)));
        b.height[i] = 0.58 + rings * 0.09 + (sand[i] - 0.5) * 0.05 - (1 - seam) * 0.2;
        let c = mixc(birch, figure, rings * 0.85);
        c = mixc(c, glue, (1 - seam) * 0.85);
        c = mixc(c, lin(0x9a8258), patch[i] * 0.3);
        b.rgb(i, ...c);
        // Sanded and part-sealed: the glue-sized areas take a sheen, the open
        // grain does not, and the sanding scratches modulate both.
        b.rough[i] = rgh(0.68 - rings * 0.16 + sand[i] * 0.1 + (1 - seam) * 0.2);
        b.aoMul[i] = 1 - (1 - seam) * 0.3;
      });
    },
  },

  /* ------------------------------------------------------- soft surfaces */

  sandbag_canvas: {
    // 1.6 m per tile, not 1: at the level's density that put the weave at 1.3 cm,
    // which is a third of a pixel on a bag three metres away — so a course of
    // sandbags averaged out to flat grey however carefully the weave was authored.
    // The weave is the micro layer here; what has to survive to 10 m is the fold
    // and seam relief, and both are authored an order of magnitude larger.
    tile: 1.6,
    uvScale: 3,
    normalScale: 1.7,
    physical: true,
    mat: { sheen: 0.4, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xd8c398) },
    macro: { scale: 0.34, albedo: 0.15, rough: 0.08, grime: 0.24, tint: 0x6a5c3f, patch: 0.18, patchFreq: 1.6, runs: 0.2, runFreq: 3.2 },
    build(b) {
      const fuzz = b.fbm({ freq: 34, octaves: 3 });
      // Folds are the read at every distance a sandbag is seen from: a filled bag
      // is a slack sack, and the creases where the cloth gathers are 10 cm long,
      // not 1 cm. Ridged and warped so they branch and taper like fabric instead
      // of pooling like noise.
      const folds = b.warp(b.ridge({ freq: 3.5, octaves: 3, seed: 15 }), { freq: 3, amount: b.size * 0.07 });
      const slack = b.fbm({ freq: 2, octaves: 3, seed: 51 });
      const dust = b.fbm({ freq: 9, octaves: 4, seed: 62 });
      const jute = lin(0xa2814a);
      const jute2 = lin(0x796038);
      const bleach = lin(0xc2a978);
      const grime = lin(0x5d5340);
      b.normalStrength = 1.6;
      b.aoRelief = 1.0;
      b.aoSpread = 0.05;
      b.each((i, u, v) => {
        // Plain weave: alternating cells decide which thread is on top, and each
        // thread's cross-section is a half-sine. That interlock is what makes
        // burlap read as woven rather than as bumpy.
        const T = 16;
        const tx = u * T;
        const ty = v * T;
        const cx = Math.floor(tx);
        const cy = Math.floor(ty);
        const px = Math.sin(Math.PI * (tx - cx));
        const py = Math.sin(Math.PI * (ty - cy));
        const warpTop = ((cx + cy) & 1) === 0;
        const w = warpTop ? px * 0.9 + py * 0.2 : py * 0.9 + px * 0.2;
        // The sewn edge: a raised welt with the cloth gathered and pinched either
        // side of it. One per tile, and it is the only straight line on an
        // otherwise entirely soft object — which is what makes the object read as
        // a sewn bag rather than as a smooth ellipsoid.
        const sv = Math.abs(tri(v * 0.5) - 1);
        const welt = smoothstep(0.05, 0.012, sv);
        const gather = smoothstep(0.11, 0.05, sv) * (1 - welt);
        const crease = smoothstep(0.5, 0.86, folds[i]);
        b.height[i] =
          0.34 + w * 0.16 + slack[i] * 0.26 + (fuzz[i] - 0.5) * 0.05 - crease * 0.34 + welt * 0.22 - gather * 0.14;
        // Tone belongs to the thread, not to the cell: jute is spun in uneven
        // hanks, so the colour runs the length of each strand. Keying off cell
        // parity instead gives a checkerboard, which no woven thing has.
        let c = mixc(jute, jute2, warpTop ? hash01(cx, 5.7) * 0.7 : 0.25 + hash01(cy, 11.3) * 0.7);
        // Sun bleaches the parts that stand proud and dirt collects in the creases:
        // that pairing is what gives a khaki bag its chroma range instead of one
        // flat tint, which is the reading that made these look like grey plastic.
        c = mixc(c, bleach, smoothstep(0.45, 0.95, slack[i]) * 0.55 + welt * 0.25);
        c = mixc(c, grime, clamp01(dust[i] * 1.2 - 0.25) * (1 - w * 0.5) * 0.8 + crease * 0.45);
        b.rgb(i, ...c);
        b.scale(i, 0.84 + fuzz[i] * 0.24 + slack[i] * 0.12);
        // Thread crowns are abraded smooth by handling; the interstices hold
        // dust and stay maximally rough.
        b.rough[i] = rgh(0.95 - smoothstep(0.5, 1, w) * 0.14 - welt * 0.1 + crease * 0.04 + (fuzz[i] - 0.5) * 0.08);
        b.aoMul[i] = 1 - (1 - clamp01(w)) * 0.25 - crease * 0.4 - gather * 0.2;
      });
    },
  },

  camo_fabric: {
    tile: 1.2,
    uvScale: 3,
    normalScale: 0.85,
    physical: true,
    mat: { sheen: 0.3, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xa8a487) },
    macro: { scale: 0.16, albedo: 0.1, rough: 0.07, grime: 0.18, tint: 0x5b5540, patch: 0.1, patchFreq: 1.4, runs: 0.18 },
    // Cotton duck at awning weight passes something like a quarter of what lands on
    // it. This recipe is every sheet in the level — awnings, laundry, stall skirts —
    // and a sheet is nearly always seen from the side the sun is not on, so the
    // transmitted term is most of what the material is for. Not `transmission` on the
    // physical material: that costs a full-scene refraction pass, and a thin opaque
    // weave scatters rather than refracts anyway.
    translucency: { amount: 0.3, wrap: 0.25 },
    // A tarp is slack cloth, not a shelf, and it holds no dust worth modelling.
    dust: false,
    build(b) {
      const blob = b.warp(b.fbm({ freq: 3, octaves: 4 }), { freq: 4, amount: b.size * 0.06 });
      const blob2 = b.warp(b.fbm({ freq: 5, octaves: 4, seed: 44 }), { freq: 3, amount: b.size * 0.05 });
      const nap = b.fbm({ freq: 40, octaves: 2, seed: 8 });
      const khaki = lin(0x8d8256);
      const olive = lin(0x4e5335);
      const brown = lin(0x5a4630);
      const black = lin(0x272a20);
      b.normalStrength = 0.8;
      b.aoRelief = 0.4;
      b.each((i, u, v) => {
        // Twill: the diagonal rib of the weave, plus a fine cross thread. Fabric
        // needs a directional micro-structure or it looks like painted paper.
        const twill = tri((u + v) * 46);
        const cross = tri((u - v) * 60) * 0.4;
        b.height[i] = 0.45 + twill * 0.14 + cross * 0.06 + (nap[i] - 0.5) * 0.06;
        // Four-tone camo from two warped fields thresholded at different levels.
        let c = khaki;
        c = mixc(c, olive, smoothstep(0.46, 0.52, blob[i]));
        c = mixc(c, brown, smoothstep(0.6, 0.66, blob2[i]) * 0.9);
        c = mixc(c, black, smoothstep(0.72, 0.78, blob[i] * 0.6 + blob2[i] * 0.5));
        b.rgb(i, ...c);
        b.scale(i, 0.9 + nap[i] * 0.2);
        // Dyed-dark areas absorb more and scatter less: measurably rougher, and
        // the rib crowns catch the sheen.
        const dark = 1 - clamp01((c[0] + c[1] + c[2]) * 2.6);
        b.rough[i] = rgh(0.76 + dark * 0.1 - smoothstep(0.6, 1, twill) * 0.1 + (nap[i] - 0.5) * 0.06);
        b.aoMul[i] = 1 - (1 - twill) * 0.2;
      });
    },
  },

  rubber: {
    tile: 1,
    uvScale: 4,
    normalScale: 1.2,
    physical: true,
    // Rubber is the textbook rough dielectric, and a rough dielectric with no
    // retroreflective term is indistinguishable from matte black plastic. A broad,
    // weak sheen is what puts the dull grazing-angle sit-up back on it.
    mat: { sheen: 0.22, sheenRoughness: 0.9, sheenColor: new THREE.Color(0x8e8c88) },
    macro: { scale: 0.2, albedo: 0.08, rough: 0.09, grime: 0.16, patch: 0.08, patchFreq: 1.6, runs: 0.12 },
    build(b) {
      const micro = b.fbm({ freq: 46, octaves: 2 });
      const bloom = b.fbm({ freq: 9, octaves: 4, seed: 39 });
      // 0.038 linear, not the 0.010 this was. Carbon-black rubber is the darkest
      // common material on a street and it is still three to five percent — at one
      // percent a tyre has no albedo left for the sky fill to land on and renders as
      // a hole in the frame with the grade's blue lift showing through it.
      const black = lin(0x37383a);
      const grey = lin(0x5c5d5a);
      b.normalStrength = 1.1;
      b.aoRelief = 0.5;
      b.each((i, u, v) => {
        // Moulded diamond tread: two crossed triangle waves, hard shoulders. Half
        // the frequency it was, with a narrower groove: at the old pitch the grooves
        // met before the blocks had any width and the tread read as a wireframe
        // crosshatch laid over the tyre rather than as moulded blocks.
        const a = tri((u + v) * 3.5);
        const c2 = tri((u - v) * 3.5);
        const lug = smoothstep(0.12, 0.3, Math.min(a, c2));
        b.height[i] = 0.28 + lug * 0.55 + (micro[i] - 0.5) * 0.08;
        // Antiozonant bloom: the grey haze that migrates out of old rubber.
        const haze = clamp01(bloom[i] * 1.4 - 0.55) * (1 - lug * 0.5);
        b.rgb(i, ...mixc(black, grey, haze * 0.7));
        b.scale(i, 0.95 + micro[i] * 0.12);
        // Lug crowns are burnished by contact; the moulded valleys never are.
        b.rough[i] = rgh(0.9 - smoothstep(0.55, 1, lug) * 0.32 + haze * 0.06 + (micro[i] - 0.5) * 0.08);
        b.aoMul[i] = 1 - (1 - lug) * 0.25;
      });
    },
  },

  glass_dirty: {
    tile: 2,
    uvScale: 2,
    normalScale: 0.22,
    physical: true,
    mat: {
      transparent: true,
      opacity: 1, // the map's alpha carries the dirt, so opacity stays open
      ior: 1.52,
      specularIntensity: 1,
      envMapIntensity: 1.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    },
    macro: { scale: 0.3, albedo: 0.05, rough: 0.1, grime: 0.08, patch: 0.06, patchFreq: 1.2, runs: 0.3, runFreq: 2.6 },
    build(b) {
      const film = b.warp(b.fbm({ freq: 7, octaves: 5 }), { freq: 3, amount: b.size * 0.05 });
      const runs = b.fbm({ freq: 26, freqY: 3, octaves: 3, seed: 61 });
      const spots = b.cells({ freq: 26, jitter: 1, mode: 'f1', seed: 9 });
      const spotId = b.cells({ freq: 26, jitter: 1, mode: 'id', seed: 9 });
      const glass = lin(0xd6dedd);
      const dirt = lin(0x8b8474);
      b.normalStrength = 0.3;
      b.aoRelief = 0.1;
      b.aoStrength = 0.35;
      b.each((i) => {
        const grime = clamp01(film[i] * 1.3 - 0.35 + runs[i] * 0.3);
        const spot = spotId[i] > 0.6 ? smoothstep(0.09 + (spotId[i] - 0.6) * 0.12, 0.02, spots[i]) : 0;
        b.height[i] = 0.5 + grime * 0.04 + spot * 0.03;
        b.rgb(i, ...mixc(glass, dirt, grime * 0.7 + spot * 0.3));
        // The whole point of dirty glass: roughness goes from mirror to matte
        // across a few centimetres, so the reflection breaks up in patches.
        b.rough[i] = rgh(0.05 + grime * 0.4 + spot * 0.35);
        b.alpha[i] = clamp01(0.16 + grime * 0.55 + spot * 0.45);
      });
    },
  },

  /* -------------------------------------------------- weapon + character */

  gun_polymer: {
    tile: 0.3,
    uvScale: 6,
    normalScale: 0.85,
    macro: false,
    build(b) {
      const stip = b.cells({ freq: 40, mode: 'dome', jitter: 1, seed: 4 });
      const flow = b.fbm({ freq: 9, octaves: 4, seed: 66 });
      const wear = b.fbm({ freq: 3, octaves: 3, seed: 21 });
      const poly = lin(0x333436);
      const warm = lin(0x413a30);
      b.normalStrength = 0.9;
      b.aoRelief = 0.45;
      b.each((i) => {
        b.height[i] = 0.42 + stip[i] * 0.34 + (flow[i] - 0.5) * 0.06;
        b.rgb(i, ...mixc(poly, warm, flow[i] * 0.35));
        b.scale(i, 0.84 + stip[i] * 0.3);
        // Moulded stipple, then hand wear: the raised stipple tops are burnished
        // where the grip is held and the valleys keep their mould texture.
        const hand = smoothstep(0.45, 0.9, wear[i]);
        const crown = smoothstep(0.4, 0.95, stip[i]);
        b.rough[i] = rgh(0.66 - crown * 0.14 - hand * crown * 0.22 + (flow[i] - 0.5) * 0.06);
        b.aoMul[i] = 1 - (1 - crown) * 0.2;
      });
    },
  },

  gun_steel_blued: {
    tile: 0.3,
    uvScale: 6,
    normalScale: 0.35,
    macro: false,
    mat: { envMapIntensity: 1.3 },
    build(b) {
      const turn = b.fbm({ freq: 3, freqY: 96, octaves: 2 });
      const wear = b.warp(b.fbm({ freq: 4, octaves: 4, seed: 12 }), { freq: 3, amount: b.size * 0.04 });
      const scratch = b.fbm({ freq: 80, freqY: 5, octaves: 2, seed: 3 });
      const blued = lin(0x15171b);
      const steel = lin(0x8c9095);
      b.normalStrength = 0.3;
      b.aoRelief = 0.15;
      b.each((i) => {
        b.height[i] = 0.55 + (turn[i] - 0.5) * 0.05 - scratch[i] * 0.05;
        // Bluing is an oxide conversion, not a coating: worn areas are still
        // steel, so metalness stays 1 and only albedo and roughness change. Wear
        // is tight and follows the machining marks — a soft cloud of it reads as
        // frost on the receiver.
        const worn = smoothstep(0.76, 0.95, wear[i] * 0.75 + turn[i] * 0.35);
        b.rgb(i, ...mixc(blued, steel, worn));
        b.rough[i] = rgh(0.2 + turn[i] * 0.07 - worn * 0.07 + scratch[i] * 0.12);
        b.metal[i] = 1;
      });
    },
  },

  gun_aluminium_anodized: {
    tile: 0.3,
    uvScale: 6,
    normalScale: 0.4,
    macro: false,
    mat: { envMapIntensity: 1.25 },
    build(b) {
      const blast = b.fbm({ freq: 40, octaves: 2 });
      const edge = b.fbm({ freq: 5, octaves: 4, seed: 91 });
      const rail = b.fbm({ freq: 60, freqY: 6, octaves: 2, seed: 7 });
      const anod = lin(0x202224);
      const alu = lin(0xb9bdc1);
      b.normalStrength = 0.4;
      b.aoRelief = 0.2;
      b.each((i) => {
        b.height[i] = 0.55 + (blast[i] - 0.5) * 0.07 - rail[i] * 0.04;
        // Type III anodising is a hard matte oxide over aluminium; where it has
        // rubbed through, the bright metal shows and the roughness drops hard.
        const through = smoothstep(0.84, 0.97, edge[i] * 0.8 + rail[i] * 0.35);
        b.rgb(i, ...mixc(anod, alu, through));
        b.rough[i] = rgh(0.46 + blast[i] * 0.1 - through * 0.24);
        b.metal[i] = 1;
      });
    },
  },

  skin: {
    tile: 0.5,
    uvScale: 6,
    normalScale: 0.55,
    physical: true,
    mat: {
      sheen: 0.25,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0xffcdb2),
      envMapIntensity: 0.9,
    },
    macro: false,
    build(b) {
      const pores = b.cells({ freq: 46, jitter: 1, mode: 'f1', seed: 17 });
      const creases = b.warp(b.fbm({ freq: 7, freqY: 18, octaves: 4, seed: 5 }), { freq: 5, amount: b.size * 0.02 });
      const blotch = b.fbm({ freq: 4, octaves: 4, seed: 55 });
      const hair = b.fbm({ freq: 34, freqY: 34, octaves: 2, seed: 71 });
      const mid = lin(0xba8b6c);
      const pale = lin(0xd0a889);
      const red = lin(0xa95f4c);
      b.normalStrength = 0.6;
      b.aoRelief = 0.4;
      b.each((i) => {
        const pore = smoothstep(0.16, 0.03, pores[i]);
        const crease = smoothstep(0.72, 0.95, creases[i]);
        b.height[i] = 0.6 - pore * 0.16 - crease * 0.2 + (hair[i] - 0.5) * 0.04;
        let c = mixc(mid, pale, blotch[i] * 0.85);
        c = mixc(c, red, clamp01(blotch[i] * 1.5 - 0.55) * 0.7 + crease * 0.3);
        b.rgb(i, ...c);
        b.scale(i, 0.94 + hair[i] * 0.12 - pore * 0.1);
        // Sebum sits on the raised areas and creases stay dry: that gradient is
        // what stops skin reading as painted rubber.
        b.rough[i] = rgh(0.5 - smoothstep(0.55, 0.95, blotch[i]) * 0.16 + crease * 0.12 + pore * 0.06);
        b.aoMul[i] = 1 - pore * 0.15 - crease * 0.2;
      });
    },
  },
};

/**
 * Names a level or view model might plausibly ask for, mapped onto a recipe.
 * AssetForge also substring-matches against these, so `crate_wood_01` lands on
 * weathered plank instead of the flat grey fallback.
 */
export const MATERIAL_ALIASES = {
  default: 'concrete_cast',
  concrete: 'concrete_cast',
  concretefloor: 'concrete_cast',
  floor: 'concrete_cast',
  kerb: 'concrete_cast',
  wall: 'plaster_painted',
  plaster: 'plaster_painted',
  stucco: 'plaster_painted',
  brick: 'brick_red',
  masonry: 'brick_red',
  road: 'asphalt',
  tarmac: 'asphalt',
  asphalt: 'asphalt',
  ground: 'dirt_packed',
  terrain: 'dirt_packed',
  mud: 'dirt_packed',
  rubble: 'gravel',
  stone: 'gravel',
  sandbag: 'sandbag_canvas',
  burlap: 'sandbag_canvas',
  canvas: 'sandbag_canvas',
  cloth: 'camo_fabric',
  fabric: 'camo_fabric',
  camo: 'camo_fabric',
  uniform: 'camo_fabric',
  tyre: 'rubber',
  tire: 'rubber',
  rubber: 'rubber',
  glass: 'glass_dirty',
  window: 'glass_dirty',
  metal: 'steel_brushed',
  steel: 'steel_brushed',
  pipe: 'steel_brushed',
  rust: 'steel_rusted',
  rusty: 'steel_rusted',
  barrel: 'steel_rusted',
  drum: 'steel_rusted',
  iron: 'iron_painted_chipped',
  painted: 'iron_painted_chipped',
  paint: 'iron_painted_chipped',
  door: 'iron_painted_chipped',
  container: 'iron_painted_chipped',
  aluminium: 'aluminium_scuffed',
  aluminum: 'aluminium_scuffed',
  corrugated: 'corrugated_metal',
  roof: 'corrugated_metal',
  shack: 'corrugated_metal',
  fence: 'corrugated_metal',
  wood: 'wood_plank_weathered',
  plank: 'wood_plank_weathered',
  timber: 'wood_plank_weathered',
  crate: 'wood_plank_weathered',
  pallet: 'wood_plank_weathered',
  ply: 'wood_ply',
  plywood: 'wood_ply',
  board: 'wood_ply',
  tile: 'tile_ceramic',
  ceramic: 'tile_ceramic',
  sand: 'sand',
  dirt: 'dirt_packed',
  gravel: 'gravel',
  polymer: 'gun_polymer',
  plastic: 'gun_polymer',
  grip: 'gun_polymer',
  gunmetal: 'gun_steel_blued',
  blued: 'gun_steel_blued',
  receiver: 'gun_steel_blued',
  barrelsteel: 'gun_steel_blued',
  anodized: 'gun_aluminium_anodized',
  anodised: 'gun_aluminium_anodized',
  rail: 'gun_aluminium_anodized',
  optic: 'gun_aluminium_anodized',
  handguard: 'gun_aluminium_anodized',
  bolt: 'gun_steel_blued',
  muzzle: 'gun_steel_blued',
  suppressor: 'gun_steel_blued',
  magazine: 'gun_polymer',
  mag: 'gun_polymer',
  stock: 'gun_polymer',
  lens: 'glass_dirty',
  buttpad: 'rubber',
  sleeve: 'camo_fabric',
  glove: 'camo_fabric',
  skin: 'skin',
  hand: 'skin',
  hands: 'skin',
  forearm: 'skin',
  flesh: 'skin',
  face: 'skin',
};

/**
 * Bake priority. AssetForge works down this list under a wall-clock budget, so
 * the surfaces that carry the establishing shot are guaranteed to be resident
 * and anything left over is baked on first request.
 */
export const BAKE_ORDER = [
  'concrete_cast',
  'asphalt',
  'brick_red',
  'plaster_painted',
  'concrete_pitted',
  'steel_rusted',
  'iron_painted_chipped',
  'corrugated_metal',
  'wood_plank_weathered',
  'dirt_packed',
  'gravel',
  'sandbag_canvas',
  'steel_brushed',
  'gun_polymer',
  'gun_steel_blued',
  'skin',
  'glass_dirty',
  'tile_ceramic',
  'sand',
  'wood_ply',
  'camo_fabric',
  'rubber',
  'aluminium_scuffed',
  'gun_aluminium_anodized',
];
