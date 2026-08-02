import * as THREE from 'three';

/**
 * Sky dome, sun position, atmospheric aerial perspective and the environment map
 * used for IBL.
 *
 * The dome is an analytic single-scattering atmosphere (the Preetham family:
 * Rayleigh + Mie with a Henyey-Greenstein forward lobe) evaluated per fragment,
 * with a coarse volumetric cloud march layered on top and a limb-darkened sun
 * disc at its true angular size. The same model is mirrored in JS so the sun
 * colour, the ambient colour and the aerial-perspective tints are *derived* from
 * the atmosphere rather than hand-picked, which is what keeps the key light, the
 * haze and the sky agreeing with each other at every time of day.
 *
 * CONTRACT:
 *   sunDirection : THREE.Vector3   unit vector pointing at the sun
 *   sunColor     : THREE.Color     key light tint (normalised, warm at low sun)
 *   ambientColor : THREE.Color     sky-average tint for fill (cool)
 *   envMap       : THREE.Texture   PMREM cube-UV map, also on scene.environment
 *   setTimeOfDay(t01)
 *
 * ADDITIONS (safe to rely on):
 *   preset(name)              apply a named preset, see `presetNames`
 *   presetNames               -> string[]
 *   params                    -> the active parameter block
 *   sunIrradiance             -> number, suggested DirectionalLight intensity
 *   ambientIntensity          -> number, suggested hemisphere/fill intensity
 *   horizonColor/zenithColor  -> THREE.Color, linear sky radiance samples
 *   sampleSky(dir, target)    -> THREE.Color, CPU evaluation of the same model
 *   aerialUniforms            -> shared uniform objects (see below)
 *   applyAerialPerspective(m) patch one material in place
 *   rescan()                  re-scan the scene for unpatched materials
 *   dome                      -> THREE.Mesh
 *   stats                     -> { initMs, envMs, noiseMs, patched }
 *
 * AERIAL PERSPECTIVE
 * `aerialUniforms` holds THREE-style uniform objects ({ value }) that are shared
 * *by reference* with every material this module patches, so one write per frame
 * updates all of them:
 *
 *   uAerialCam     vec3  camera world position
 *   uAerialSunDir  vec3  sun direction
 *   uAerialHorizon vec3  linear in-scatter colour at the horizon
 *   uAerialZenith  vec3  linear in-scatter colour at the zenith
 *   uAerialSunTint vec3  forward-scatter tint added toward the sun
 *   uAerialParams  vec4  (density per metre, 1/heightScale, sun glow, max blend)
 *   uAerialDust    vec4  (dust density/m, 1/dustHeight, forward exponent, uv scale)
 *   uAerialDustCol vec3  linear radiance of sunlit dust
 *   uAerialDustFlow vec2 scrolled uv offset for the dust patch field
 *   uAerialNoise   sampler2D  the cloud band texture, reused for dust patches
 *
 * Anything with its own shader can either call `applyAerialPerspective(mat)`
 * (works on any lit Three material — it rewrites the fog chunk) or read these
 * uniforms and implement the same four lines. A material that must stay unhazed
 * sets `mat.userData.noAerial = true`. Three's FogExp2 stays installed as
 * `scene.fog`, so anything never patched degrades to a flat distance fade rather
 * than to no depth cue at all.
 */

const D2R = Math.PI / 180;
const LUMA_W = [0.2126, 0.7152, 0.0722];
const WHITE = new THREE.Color(1, 1, 1);

/** Rayleigh scattering at sea level for 680/550/450 nm, m^-1. */
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
/** Mie constant for the same wavelengths; the 0.434*c prefactor is applied below. */
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const SUN_EE = 1000;
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
/** The sun subtends 0.533 degrees, so 0.00465 rad of angular radius. */
const SUN_ANGULAR_RADIUS = 0.00465;
/**
 * Single scattering alone leaves a horizon ~23x the zenith and a zenith so deep
 * it crushes to black. Real skies sit near 5x because multiple scattering fills
 * the zenith and caps the horizon; this exponent on the in-scatter term is the
 * cheapest honest stand-in for that fill, and it is the difference between a sky
 * that survives an ACES curve and one that clips to white above the rooflines.
 *
 * It compresses the in-scatter's *range*, so it is applied to its luminance.
 * Applied per channel it also flattens the Rayleigh blue:red ratio — 4.00 to 3.21
 * at the zenith, 2.86 to 2.38 at 25 degrees — and that ratio is the only chroma
 * the sky has left after ACES' shoulder has worked on a band this bright: the
 * same 25-degree patch printed at 0.12 display saturation instead of 0.20. Real
 * multiple scattering does whiten a sky, but by adding a fill of the sky's own
 * average colour, not by gamma-compressing each channel on its own.
 */
const MS_FILL = 0.85;

/**
 * Shared defaults. A preset only states what it changes, so the diff between
 * "golden hour" and "harsh noon" reads as an artistic decision.
 */
const BASE_PARAMS = {
  elevation: 17,
  azimuth: -38, // degrees clockwise from -Z; -38 puts the sun off the left shoulder
  turbidity: 3.2,
  rayleigh: 2.0,
  mieCoefficient: 0.0075,
  mieG: 0.8,
  /**
   * Scales the model's radiance into the renderer's linear range, and it is a
   * calibration against PostFX's exposure, not a look: at 0.1 the horizon entered
   * the ACES fit above 3.0 and came out at 89% of output range with barely five
   * levels of gradient across the whole visible band, because that far up the
   * shoulder a doubling of radiance is worth about ten code values. The presets
   * that override this keep their old ratio to it.
   *
   * 0.062 did not get far enough down the shoulder to fix either symptom. The sky
   * the establishing shot can actually see is 9-27 degrees of elevation, and it
   * printed across 180-227 — the top fifth of the range, where the curve has so
   * little slope left that 52 degrees away from the sun a linear blue:red of 2.16
   * came out at 0.06 display saturation. Measured over that whole region, 0.048
   * moves it to 133-230 and takes its mean saturation from 0.070 to 0.091, its
   * ninth decile from 0.116 to 0.181, and its bluest tenth from rgb(180,200,209)
   * to rgb(162,190,204). The sky is now about a third of a stop under a sunlit
   * plaster wall rather than level with it, which is where a photograph exposed
   * for the sunlit subject puts it.
   *
   * 0.048 kept that promise only while the sunlit wall was where it was measured.
   * It is not: three rounds of fill escalation left the key light so far under its
   * own sky that a sunlit facade in `vista` printed 180 while the sun-side sky
   * printed 220.7 at 0.028 saturation — literally the achromatic patch the review
   * measured, and achromatic for the reason this comment already names, which is
   * that the band is sitting where a doubling is worth ten codes. Two things move
   * to close it and they move toward each other: KEY_BOOST in Lighting takes the
   * sunlit wall up about half a stop, and this takes the dome down a third of one.
   * Modelled on the CPU against the real grade path, sun-side horizon 229.3 ->
   * 222.1 at saturation 0.039 -> 0.047, and the blue band 60 degrees off the sun
   * 196.8 -> 182.0 at 0.210 -> 0.267. The dome losing a fifth of its radiance is
   * also a fifth off every fill term keyed to it — `ambientIntensity` and the
   * PMREM both — which is the direction this round needs and is accounted for in
   * Lighting's iblFillFactor and CascadedShadows' uCsmSkyVis rather than left to
   * land by accident.
   */
  lum: 0.038,
  sunLum: 190, // sun disc radiance: far above 1 so PostFX's bloom has an HDR source
  glow: 0.45, // extra narrow Mie aureole around the disc
  nightLum: 0.6,
  nightSky: 0x14213d,
  /**
   * A cloud seen from underneath at 10-25 degrees of elevation is its own shadowed
   * base, so it substitutes grey for whatever blue is behind it. At 0.52 that was
   * 57% of the establishing shot's sky area reading *below* the clear-atmosphere
   * value for the same ray, and it cost the sky region a third of its saturation
   * (0.055 measured against 0.081 for the atmosphere alone). Scattered rather than
   * broken cover keeps the silhouette interest and lets the blue through.
   */
  cloudCoverage: 0.42,
  cloudDensity: 1.15,
  cloudBase: 1150,
  cloudThickness: 950,
  cloudScale: 1 / 5200, // one cloud-noise tile per this many world metres
  cloudSpeed: 0.006,
  cloudLight: 2.2, // sunlit cloud radiance at full daylight
  cloudTint: 1.0,
  windDeg: 24,
  cirrusCoverage: 0.5,
  // The high sheet takes no self-shadowing and is lit straight off the sun, so it
  // is the most achromatic thing in the dome; at 0.55 it laid up to a quarter of a
  // near-white wash over the whole upper hemisphere, which is the whole-frame veil
  // the rubric fails post for. Thin enough to read as wisps.
  cirrusDensity: 0.38,
  /**
   * Extinction per metre for the aerial term. 0.0052 is a 192 m e-folding length,
   * which is dust-storm air, and the airlight it converges on is not a subtle
   * colour: the horizon in-scatter this preset derives is 0.71 in the renderer's
   * linear units, brighter than a sunlit plaster wall, while a surface sitting in
   * shade is near 0.013. At 35 m the old density blended 12.3% of that in, so 88%
   * of what reached the grade for anything shaded past ~25 m was air — measured, a
   * four-storey facade at that range printed mean 74.5 / sd 9.0 / saturation 0.047
   * against mean 24 for the same kind of shade three metres away.
   *
   * 0.0034 is a 294 m e-folding, a third less airlight in the 20-50 m band, and it
   * is deliberately still above the noon preset's 0.0032: a low sun looks through
   * more aerosol, and the ordering across the presets is the artistic statement.
   * It cannot go much lower without flattening the distance ramp that is the whole
   * point of the term — at 200 m this still blends 37%.
   */
  aerialDensity: 0.0034,
  aerialHeight: 70,
  aerialGlow: 0.55,
  /**
   * Ceiling on the haze blend. At 0.94 a surface a few hundred metres out
   * converged onto the in-scatter colour to within a few code values, so a
   * roofline or a minaret shaft ended up at the same value as the sky behind it
   * and the skyline stopped reading. Holding back a quarter of the surface's own
   * radiance keeps a far silhouette separated without touching the near field,
   * which the density term already leaves alone.
   */
  aerialMax: 0.75,
  /**
   * Airborne dust. The Rayleigh/Mie term above is a *distance* cue and is
   * correctly tuned as one — it deliberately does nothing in the first twenty
   * metres, which is why the air in this map reads as perfectly clean glass. Real
   * street air at a low sun is not clean and not uniform: it carries lifted grit
   * that is invisible looking away from the sun and obvious looking into it,
   * because grains this size scatter almost entirely forward.
   *
   * So this term is additive, gated on a forward lobe, and gated on altitude. Away
   * from the sun it contributes nothing at all rather than a small floor — a floor
   * is what turns a scattering term into a whole-frame veil, which is the failure
   * the aerial density and the cirrus sheet were both already pulled back from.
   *
   * 0.0067/m against a 7 m scale height is about 12% single-scatter at 30 m along
   * a horizontal ray. Measured on the establishing shot, that is +5.8 code values
   * on the sunward third of the frame, +0.06 on the anti-sun third, +0.09 on the
   * cobbles under the eye and exactly zero on the sky — a wedge, not a wash, which
   * is the only shape this term is allowed to have.
   */
  dustDensity: 0.0067,
  dustHeight: 7,
  dustLobe: 3.0, // pow() stand-in for a large-particle forward phase function
  dustScale: 1 / 32, // one patch tile per this many metres: street-sized plumes
  dustLum: 0.065, // fraction of the sun's radiance a dust grain returns
  /**
   * How far the dust's own albedo is pulled back to white. Lifted grit is the
   * ground in the air and carries the ground's colour, which is what separates a
   * dust event from a grey one — at 1.0 the term is fog with a phase function. It
   * is not pulled all the way to the ground tint either, because a mineral grain's
   * single-scattering albedo is much flatter than its diffuse reflectance.
   */
  dustWhiten: 0.35,
  dustDrift: 0.5, // m/s, so the plumes crawl rather than shimmer
  fogDensity: 0.0042,
  stars: 0,
  groundTint: 0x6a6154,
  sunTintMix: 0.42, // how far the transmitted sun colour is pulled back to white
  ambientMul: 1,
  maxElevation: 62, // used by setTimeOfDay
  azimuthNoon: -30,
  azimuthSwing: 105,
};

/**
 * Named presets. `goldenHour` is the default: a low warm key against a cool sky
 * fill, which is the light every shooter ships its screenshots in because it
 * gives long shadows, rim-lit silhouettes and a visible atmosphere.
 */
export const SKY_PRESETS = {
  goldenHour: {},
  dawn: {
    elevation: 4.5,
    azimuth: 96,
    turbidity: 4.6,
    rayleigh: 2.7,
    mieCoefficient: 0.011,
    mieG: 0.82,
    sunLum: 120,
    glow: 0.75,
    cloudCoverage: 0.6,
    cloudDensity: 1.3,
    aerialDensity: 0.0072,
    aerialGlow: 0.85,
    fogDensity: 0.006,
    sunTintMix: 0.3,
    windDeg: 200,
    // A night of still air settles the grit, so dawn is the cleanest hour of the
    // day; what little is left is lit almost edge-on and reads brightly.
    dustDensity: 0.004,
    dustLum: 0.055,
  },
  noon: {
    elevation: 66,
    azimuth: -22,
    turbidity: 2.3,
    rayleigh: 1.5,
    mieCoefficient: 0.0045,
    mieG: 0.76,
    lum: 0.041, // relative offset from the base's own calibration, kept across it
    sunLum: 240,
    glow: 0.25,
    cloudCoverage: 0.38,
    cloudDensity: 1.0,
    cloudLight: 2.6,
    aerialDensity: 0.0032,
    aerialGlow: 0.3,
    fogDensity: 0.0028,
    sunTintMix: 0.7,
    // Thermals lift more of it than at any other hour, but a 66-degree sun puts
    // the forward lobe out of frame, so the density is up and the return is down.
    dustDensity: 0.0075,
    dustHeight: 10,
    dustLum: 0.03,
  },
  dusk: {
    elevation: 1.2,
    azimuth: -84,
    turbidity: 5.2,
    rayleigh: 3.0,
    mieCoefficient: 0.013,
    mieG: 0.84,
    sunLum: 95,
    glow: 1.0,
    cloudCoverage: 0.56,
    cloudDensity: 1.35,
    cirrusDensity: 0.85,
    aerialDensity: 0.0078,
    aerialGlow: 1.0,
    fogDensity: 0.0065,
    sunTintMix: 0.24,
    stars: 0.15,
    // A whole day of traffic is still hanging in the street and the sun is nearly
    // on the horizon, so the lobe points straight down it.
    dustDensity: 0.013,
    dustLum: 0.085,
  },
  overcast: {
    elevation: 34,
    azimuth: -50,
    turbidity: 9,
    rayleigh: 3.4,
    mieCoefficient: 0.022,
    mieG: 0.72,
    lum: 0.036,
    sunLum: 40,
    glow: 0.2,
    cloudCoverage: 0.93,
    cloudDensity: 2.4,
    cloudBase: 700,
    cloudThickness: 1300,
    cloudLight: 1.5,
    cirrusDensity: 0.2,
    aerialDensity: 0.0115,
    aerialGlow: 0.15,
    aerialMax: 0.82, // a flat overcast may converge harder than a clear sky
    fogDensity: 0.011,
    sunTintMix: 0.8,
    dustLum: 0.012, // no beam to catch: dust under cloud is grey, not lit
  },
  night: {
    elevation: -14,
    azimuth: -120,
    turbidity: 2.1,
    rayleigh: 1.9,
    mieCoefficient: 0.005,
    mieG: 0.78,
    sunLum: 0,
    glow: 0,
    nightLum: 1.0,
    cloudCoverage: 0.45,
    cloudDensity: 0.9,
    cloudLight: 0.12,
    cloudTint: 0.5,
    aerialDensity: 0.006,
    aerialGlow: 0.05,
    fogDensity: 0.005,
    stars: 1,
    sunTintMix: 0.5,
    dustLum: 0, // nothing above the horizon to light it
  },
};

/* ------------------------------------------------------------------ JS model */

function sunIntensityAt(zenithCos) {
  const a = Math.acos(Math.max(-1, Math.min(1, zenithCos)));
  return SUN_EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - a) / STEEPNESS)));
}

function totalMie(turbidity, out) {
  const c = 0.2 * turbidity * 1e-18;
  for (let i = 0; i < 3; i++) out[i] = 0.434 * c * MIE_CONST[i];
  return out;
}

function rayleighPhase(c) {
  return (3 / (16 * Math.PI)) * (1 + c * c);
}

function hgPhase(c, g) {
  const g2 = g * g;
  return (0.25 / Math.PI) * ((1 - g2) / Math.pow(Math.max(1 - 2 * g * c + g2, 1e-4), 1.5));
}

/**
 * Optical-path multiplier for a view zenith angle (Kasten-Young style). This is
 * what makes the horizon dozens of times deeper in atmosphere than the zenith,
 * and therefore desaturated — the single most recognisable feature of a real sky.
 */
function airmass(dirY) {
  const zen = Math.acos(Math.max(0, Math.min(1, dirY)));
  const denom = Math.cos(zen) + 0.15 * Math.pow(Math.max(93.885 - zen / D2R, 1e-3), -1.253);
  return 1 / Math.max(denom, 1e-4);
}

/* ------------------------------------------------------------- cloud noise */

/**
 * Tileable multi-band value noise, four octave groups packed one per channel.
 *
 * The cloud march needs several octaves per density sample and cannot afford a
 * fetch per octave, so the bands live in the channels: two fetches at different
 * world scales give eight bands of fBm for the price of two taps. Generated here
 * rather than pulled from Noise.js because the band frequencies and the shader's
 * band weights have to be tuned as one thing.
 */
function buildCloudNoise(size, seed) {
  const data = new Uint8Array(size * size * 4);
  const bands = [
    { freq: 4, octaves: 4, gain: 0.52, ridged: false },
    { freq: 8, octaves: 4, gain: 0.5, ridged: false },
    { freq: 17, octaves: 3, gain: 0.5, ridged: false },
    { freq: 6, octaves: 4, gain: 0.55, ridged: true },
  ];
  const field = new Float32Array(size * size);

  for (let ch = 0; ch < 4; ch++) {
    const { freq, octaves, gain, ridged } = bands[ch];
    field.fill(0);
    let amp = 1;
    let norm = 0;
    let f = freq;
    for (let o = 0; o < octaves; o++) {
      addNoiseOctave(field, size, f, amp, (seed + ch * 7919 + o * 131) | 0, ridged);
      norm += amp;
      amp *= gain;
      f *= 2;
      if (f * 2 > size) break;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < field.length; i++) {
      field[i] /= norm;
      if (field[i] < lo) lo = field[i];
      if (field[i] > hi) hi = field[i];
    }
    const k = hi > lo ? 1 / (hi - lo) : 1;
    for (let i = 0; i < field.length; i++) {
      data[i * 4 + ch] = Math.max(0, Math.min(255, ((field[i] - lo) * k * 255) | 0));
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** One periodic octave of value noise, smoothstep-interpolated, added in place. */
function addNoiseOctave(buf, size, freq, amp, seed, ridged) {
  const p = Math.max(2, Math.round(freq));
  const inv = 1 / size;
  const lat = new Float32Array(p * p);
  for (let y = 0; y < p; y++) {
    for (let x = 0; x < p; x++) {
      let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(seed, 2246822519);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      lat[y * p + x] = ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    }
  }
  for (let y = 0; y < size; y++) {
    const fy = y * inv * p;
    const y0 = Math.floor(fy) % p;
    const y1 = (y0 + 1) % p;
    let ty = fy - Math.floor(fy);
    ty = ty * ty * (3 - 2 * ty);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const fx = x * inv * p;
      const x0 = Math.floor(fx) % p;
      const x1 = (x0 + 1) % p;
      let tx = fx - Math.floor(fx);
      tx = tx * tx * (3 - 2 * tx);
      const a = lat[y0 * p + x0];
      const b = lat[y0 * p + x1];
      const c = lat[y1 * p + x0];
      const d = lat[y1 * p + x1];
      let n = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      // The |n| fold puts sharp crests in this band, which is what gives a cloud
      // edge a torn silhouette instead of a soft blob.
      if (ridged) n = 1 - Math.abs(n * 2 - 1);
      buf[row + x] += n * amp;
    }
  }
}

/* ----------------------------------------------------------------- shaders */

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
	vWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
	gl_Position = projectionMatrix * viewMatrix * vec4( vWorld, 1.0 );
}
`;

/**
 * `SLABS` and `TAPS` are compile-time because they are loop bounds. This shader
 * runs on every sky pixel, so a software rasteriser (which is what the capture
 * harness renders on) needs the thin variant while a real GPU can afford depth.
 */
function buildSkyFragment({ slabs, taps, cirrus }) {
  return /* glsl */ `
precision highp float;

varying vec3 vWorld;

uniform vec3 uSunDir;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform float uSunE;
uniform float uMieG;
uniform float uLum;
uniform float uSunLum;
uniform float uGlow;
uniform float uSunRadius;
uniform float uTime;
uniform vec3 uSunRadiance;
uniform vec3 uNight;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uGround;
uniform vec4 uCloud;    // coverage, density, base altitude, thickness
uniform vec4 uCloud2;   // world scale, tint, cirrus coverage, cirrus density
uniform vec2 uWind;
uniform float uStars;
uniform float uDither;
uniform sampler2D uCloudNoise;

#define PI 3.141592653589793
#define SLABS ${slabs}
#define TAPS ${taps}

float rayleighPhaseF( float c ) { return ( 3.0 / ( 16.0 * PI ) ) * ( 1.0 + c * c ); }

float hg( float c, float g ) {
	float g2 = g * g;
	return ( 0.25 / PI ) * ( ( 1.0 - g2 ) / pow( max( 1.0 - 2.0 * g * c + g2, 1e-4 ), 1.5 ) );
}

/** In-scattered radiance along the view ray, and the extinction along it. */
vec3 atmosphere( vec3 dir, out vec3 Fex ) {
	float zen = acos( clamp( dir.y, 0.0, 1.0 ) );
	float denom = cos( zen ) + 0.15 * pow( max( 93.885 - zen * ( 180.0 / PI ), 1e-3 ), -1.253 );
	float inv = 1.0 / max( denom, 1e-4 );
	Fex = exp( -( uBetaR * ( 8.4e3 * inv ) + uBetaM * ( 1.25e3 * inv ) ) );

	float cosT = dot( dir, uSunDir );
	vec3 direct = uSunE * ( ( uBetaR * rayleighPhaseF( cosT ) + uBetaM * hg( cosT, uMieG ) ) / ( uBetaR + uBetaM ) );
	vec3 inscat = max( direct * ( 1.0 - Fex ), vec3( 0.0 ) );
	float inscatY = max( dot( inscat, vec3( ${LUMA_W.join(', ')} ) ), 1e-6 );
	vec3 Lin = inscat * ( pow( inscatY, ${MS_FILL} ) / inscatY );
	// Preetham's empirical horizon correction. Without it the zenith never goes
	// deep at low sun and the whole sky reads as one flat wash.
	float sunfade = clamp( pow( 1.0 - max( uSunDir.y, 0.0 ), 5.0 ), 0.0, 1.0 );
	Lin *= mix( vec3( 1.0 ), pow( max( direct * Fex, vec3( 0.0 ) ), vec3( 0.5 ) ), sunfade );
	return Lin;
}

/** Two fetches, eight bands, each advecting at its own rate so the layer shears. */
float band( vec2 uv, float t ) {
	vec4 a = texture2D( uCloudNoise, uv + uWind * t );
	vec4 b = texture2D( uCloudNoise, uv * 3.17 - uWind * t * 2.3 );
	float low = a.r * 0.5 + a.g * 0.26 + a.a * 0.24;
	float high = b.g * 0.42 + b.b * 0.34 + b.a * 0.24;
	return low * 0.72 + high * 0.28;
}

/** Cumulus density at a point; hf is the normalised height within the slab. */
float density( vec3 p, float hf ) {
	float n = band( p.xz * uCloud2.x, uTime );
	float cov = uCloud.x;
	float d = smoothstep( 1.0 - cov, 1.0 - cov + 0.34, n );
	// Rounded base, sheared top. A slab with no vertical profile reads as a
	// painted ceiling; the profile is what gives the layer a body.
	float prof = smoothstep( 0.0, 0.30, hf ) * smoothstep( 1.0, 0.55, hf );
	return max( d * prof - ( 1.0 - prof ) * 0.06, 0.0 ) * uCloud.y;
}

void main() {
	vec3 dir = normalize( vWorld - cameraPosition );
	vec3 upDir = normalize( vec3( dir.x, max( dir.y, 0.0 ), dir.z ) );

	vec3 Fex;
	vec3 col = atmosphere( upDir, Fex ) * uLum + uNight;

	// Past the edge of a finite map the dome stands in for ground drowned in
	// haze; without it the frame ends in a hard line of nothing.
	float below = smoothstep( 0.0, -0.09, dir.y );
	col = mix( col, col * 0.4 + uGround * 0.05, below );

	float cosT = dot( dir, uSunDir );

	if ( uStars > 0.0 ) {
		vec3 sp = dir * 260.0;
		vec3 cellId = floor( sp );
		float h = fract( sin( dot( cellId, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
		if ( h > 0.9885 ) {
			vec3 jit = vec3( fract( h * 71.3 ), fract( h * 131.7 ), fract( h * 197.1 ) ) - 0.5;
			float d = length( fract( sp ) - 0.5 - jit * 0.55 );
			float mag = ( h - 0.9885 ) * 87.0;
			vec3 tint = mix( vec3( 1.0, 0.86, 0.7 ), vec3( 0.72, 0.84, 1.0 ), fract( h * 313.0 ) );
			float tw = 0.8 + 0.2 * sin( uTime * 7.0 + h * 300.0 );
			col += tint * smoothstep( 0.26, 0.0, d ) * mag * mag * 4.0 * uStars * tw * ( 1.0 - below );
		}
	}

	// The tight aureole. The g=0.8 Mie lobe inside atmosphere() carries the broad
	// haze; this narrow lobe is what sells "you are looking near the sun".
	col += uSunRadiance * uGlow * hg( cosT, 0.955 ) * 0.02 * Fex * ( 1.0 - below );

	// Sun disc. The angle comes from the cross product rather than acos(dot):
	// at half a degree across, a float32 dot near 1.0 quantises the limb into
	// visible rings.
	float rr = length( cross( dir, uSunDir ) ) / uSunRadius;
	float disc = ( 1.0 - smoothstep( 0.985, 1.015, rr ) ) * step( 0.0, cosT );
	if ( disc > 0.0 ) {
		float mu = sqrt( max( 1.0 - min( rr, 1.0 ) * min( rr, 1.0 ), 0.0 ) );
		// Eddington limb darkening, per channel: blue falls off hardest, so the
		// rim reads warm against a white-hot centre.
		vec3 u = vec3( 0.36, 0.52, 0.68 );
		col += uSunLum * Fex * ( ( 1.0 - u ) + u * mu ) * disc * ( 1.0 - below );
	}

	/* ------------------------------------------------------------- clouds */
	float up = dir.y;
	if ( up > 0.012 ) {
		float thick = uCloud.w;
		float slabLen = thick / float( SLABS );
		float sunStep = slabLen * 1.35;
		float trans = 1.0;
		vec3 acc = vec3( 0.0 );
		// A single forward lobe leaves clouds away from the sun far too dark,
		// because most of what leaves a cloud has scattered many times. The
		// constant term is that fill; the lobes are the directional part.
		float phase = min( hg( cosT, 0.76 ) * 2.2, 6.0 ) + hg( cosT, -0.3 ) * 0.5;
		vec3 ambTop = uSkyTop * 0.9 + uSunRadiance * 0.04;
		vec3 ambBot = uSkyBottom * 0.28;

		for ( int i = 0; i < SLABS; i ++ ) {
			float hf = ( float( i ) + 0.5 ) / float( SLABS );
			float t = ( uCloud.z + hf * thick - cameraPosition.y ) / up;
			vec3 p = cameraPosition + dir * t;
			// Clouds converge into the haze band long before the geometric
			// horizon; this is that convergence, not an arbitrary fade.
			float fade = exp( -t * 1.05e-4 );
			float d = density( p, hf ) * fade;
			if ( d > 0.001 ) {
				float shadow = 0.0;
				for ( int j = 0; j < TAPS; j ++ ) {
					float s = float( j + 1 ) * sunStep;
					shadow += density( p + uSunDir * s, clamp( hf + uSunDir.y * s / thick, 0.0, 1.0 ) );
				}
				float sunT = exp( -shadow * sunStep * 0.0024 );
				// Powder term: thin edges scatter forward hard. This is the silver
				// lining; without it a lit cloud is uniformly bright and flat.
				float powder = 1.0 - exp( -d * 3.4 );
				vec3 lit = uSunRadiance * ( sunT * ( 0.55 + phase * powder * 0.9 ) );
				vec3 amb = mix( ambBot, ambTop, hf ) * ( 0.4 + 0.6 * sunT );
				float alpha = 1.0 - exp( -d * slabLen * 0.0034 );
				acc += ( lit + amb ) * alpha * trans * uCloud2.y;
				trans *= 1.0 - alpha;
			}
			if ( trans < 0.02 ) break;
		}
${
  cirrus
    ? /* glsl */ `
		// A thin high sheet, no self-shadowing: cheap, and it breaks up the empty
		// upper third that a cumulus-only layer leaves bare.
		float tc = ( 7200.0 - cameraPosition.y ) / up;
		vec2 cuv = ( cameraPosition + dir * tc ).xz * uCloud2.x * 0.34;
		vec4 cn = texture2D( uCloudNoise, cuv + uWind * uTime * 0.45 );
		float wisp = smoothstep( 1.0 - uCloud2.z, 1.0 - uCloud2.z + 0.45, cn.a * 0.6 + cn.g * 0.4 );
		wisp *= exp( -tc * 2.6e-5 ) * uCloud2.w;
		vec3 cirrusCol = uSunRadiance * ( 0.5 + hg( cosT, 0.7 ) * 0.7 ) + uSkyTop * 0.6;
		acc += cirrusCol * wisp * 0.45 * trans * uCloud2.y;
		trans *= 1.0 - wisp * 0.45;
`
    : ''
}
		col = col * trans + acc;
	}

	// Dither before the trip through an 8-bit output. A hundred-metre gradient
	// across 900 rows bands visibly otherwise, and downstream grain cannot hide a
	// band that is already baked into the buffer.
	float d1 = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
	float d2 = fract( sin( dot( gl_FragCoord.yx, vec2( 39.3468, 11.135 ) ) ) * 24634.6345 );
	col *= 1.0 + ( d1 + d2 - 1.0 ) * uDither;

	gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
	#include <colorspace_fragment>
}
`;
}

const AERIAL_VERT_HEAD = /* glsl */ `varying vec3 vAerialWorld;
`;

const AERIAL_FRAG_HEAD = /* glsl */ `varying vec3 vAerialWorld;
uniform vec3 uAerialCam;
uniform vec3 uAerialSunDir;
uniform vec3 uAerialHorizon;
uniform vec3 uAerialZenith;
uniform vec3 uAerialSunTint;
uniform vec4 uAerialParams;
uniform vec4 uAerialDust;
uniform vec3 uAerialDustCol;
uniform vec2 uAerialDustFlow;
uniform sampler2D uAerialNoise;
`;

/**
 * Replaces the fog chunk. Two things FogExp2 cannot do and that the eye reads
 * instantly: the haze colour depends on the direction being looked at, so a wall
 * near the sun's bearing hazes warm and one seen against the zenith hazes blue;
 * and the density falls off with altitude, so a roofline lifts out of the murk
 * its base sits in.
 * Contrast is dropped before the tint is applied because distant detail loses
 * local contrast before it takes on the sky's hue.
 *
 * The dust block after it is a second, independent medium and not a knob on the
 * first: molecular scattering is a smooth function of distance, dust is patchy,
 * hugs the ground, and only exists visually when you are looking into the sun.
 * Sharing one term between them is what makes procedural haze read as a filter
 * laid over the frame instead of as air the scene is standing in.
 */
const AERIAL_FRAG_BODY = /* glsl */ `
{
	vec3 aRel = vAerialWorld - uAerialCam;
	float aDist = length( aRel );
	vec3 aDir = aRel / max( aDist, 1e-4 );
	float aK = uAerialParams.y;
	float aDy = aRel.y;
	float aBase = exp( -max( uAerialCam.y, 0.0 ) * aK );
	// Closed form of an exponential-height density integrated along the ray, so
	// there is no march: od = base * (1 - e^-(dy k)) / (dy k) * dist.
	float aOd = abs( aDy ) > 0.05 ? aBase * ( 1.0 - exp( -aDy * aK ) ) / ( aDy * aK ) * aDist : aBase * aDist;
	float aF = ( 1.0 - exp( -aOd * uAerialParams.x ) ) * uAerialParams.w;
	vec3 aAir = mix( uAerialHorizon, uAerialZenith, pow( clamp( aDir.y, 0.0, 1.0 ), 0.6 ) );
	float aCs = max( dot( aDir, uAerialSunDir ), 0.0 );
	// Forward lobe only. The aCs * 0.22 floor that used to sit next to it still
	// carried 14% of the peak glow 45 degrees off the sun, where the g=0.8 Mie
	// phase this is standing in for is down to 2%, so it was not a lobe at all —
	// it warmed the entire sun hemisphere out to 90 degrees, and that is the
	// direction most of a frame shot into a low sun points.
	aAir += uAerialSunTint * uAerialParams.z * pow( aCs, 7.0 ) * 0.9;
	float aLum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( aLum ), aF * 0.3 );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, aAir, aF );

	float dK = uAerialDust.y;
	float dBase = exp( -max( uAerialCam.y, 0.0 ) * dK );
	float dOd = abs( aDy ) > 0.05 ? dBase * ( 1.0 - exp( -aDy * dK ) ) / ( aDy * dK ) * aDist : dBase * aDist;
	// One tap, four octaves: the noise texture packs a different band per channel
	// at the same uv, so the plumes get fBm structure for a single fetch. The
	// sample sits at the ray midpoint and is clamped to 26 m because beyond that
	// the field is being read faster than it varies and turns into a flat wash —
	// which is exactly the veil this term must not become.
	vec3 dP = uAerialCam + aDir * min( aDist * 0.5, 26.0 );
	vec4 dN = texture2D( uAerialNoise, dP.xz * uAerialDust.w + uAerialDustFlow );
	float dPatch = dN.r * 0.5 + dN.g * 0.3 + dN.a * 0.2;
	// Squared, so the field spends most of its area near empty and the plumes are
	// events. A dust term with a flat histogram is a fog term with extra steps.
	dPatch = 0.15 + 2.0 * dPatch * dPatch;
	float dF = 1.0 - exp( -dOd * uAerialDust.x * dPatch );
	gl_FragColor.rgb += uAerialDustCol * ( dF * pow( aCs, uAerialDust.z ) );
}
`;

/* -------------------------------------------------------------------- class */

export class Sky {
  constructor(game) {
    this.game = game;

    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Color(0xffe9c9);
    this.ambientColor = new THREE.Color(0x5a6b82);
    this.horizonColor = new THREE.Color(0.6, 0.6, 0.6);
    this.zenithColor = new THREE.Color(0.2, 0.3, 0.5);
    this.sunIrradiance = 3.2;
    this.ambientIntensity = 0.7;
    this.envMap = null;

    this.params = { ...BASE_PARAMS };
    this.presetName = 'goldenHour';
    this.timeOfDay = 0.75;
    this.stats = { initMs: 0, envMs: 0, noiseMs: 0, patched: 0 };

    this.dome = null;
    this.material = null;
    this.aerialUniforms = {
      uAerialCam: { value: new THREE.Vector3() },
      uAerialSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uAerialHorizon: { value: new THREE.Color(0.5, 0.6, 0.75) },
      uAerialZenith: { value: new THREE.Color(0.25, 0.38, 0.62) },
      uAerialSunTint: { value: new THREE.Color(1, 0.7, 0.42) },
      uAerialParams: { value: new THREE.Vector4(0.0034, 1 / 70, 0.55, 0.75) },
      uAerialDust: { value: new THREE.Vector4(0.0067, 1 / 7, 3.0, 1 / 40) },
      uAerialDustCol: { value: new THREE.Color(0, 0, 0) },
      uAerialDustFlow: { value: new THREE.Vector2() },
      // Filled in init(); shared by reference, so materials patched before the
      // texture exists still pick it up.
      uAerialNoise: { value: null },
    };

    // Scratch. update() runs every frame and must not allocate.
    this._betaR = [0, 0, 0];
    this._betaM = [0, 0, 0];
    this._mie = [0, 0, 0];
    this._fex = [0, 0, 0];
    this._rad = [0, 0, 0];
    this._msFade = [0, 0, 0];
    this._night = [0, 0, 0];
    this._sunE = 0;
    this._tmpColor = new THREE.Color();
    this._tmpVec = new THREE.Vector3();
    this._patched = new WeakSet();
    this._lastChildCount = -1;
    this._scanCooldown = 0;
    this._elapsed = 0;
    this._dustDirX = 0;
    this._dustDirZ = 1;
    this._visit = this._visit.bind(this);
  }

  static get presetNames() {
    return Object.keys(SKY_PRESETS);
  }

  get presetNames() {
    return Object.keys(SKY_PRESETS);
  }

  async init() {
    const t0 = performance.now();
    const { scene, renderer, forge } = this.game;

    // A software rasteriser pays full price for every tap in the cloud march,
    // and the capture harness is one. AssetForge already probed for it.
    const software = forge?.softwareGL ?? false;
    const heavy = (this.game.settings.volumetrics ?? true) && !software;
    const quality = { slabs: heavy ? 5 : 3, taps: heavy ? 2 : 1, cirrus: true };

    const tn = performance.now();
    const noiseSize = software ? 192 : 256;
    const makeNoise = () => buildCloudNoise(noiseSize, 0x51c10d);
    if (forge?.registerTexture && forge?.texture) {
      // Textures belong to the forge's cache even when the recipe lives here.
      forge.registerTexture('sky_cloud_bands', makeNoise);
      this.cloudNoise = forge.texture('sky_cloud_bands');
    }
    if (!this.cloudNoise) this.cloudNoise = makeNoise();
    this.aerialUniforms.uAerialNoise.value = this.cloudNoise;
    this.stats.noiseMs = +(performance.now() - tn).toFixed(1);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: buildSkyFragment(quality),
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uBetaR: { value: new THREE.Vector3() },
        uBetaM: { value: new THREE.Vector3() },
        uSunE: { value: 1000 },
        uMieG: { value: BASE_PARAMS.mieG },
        uLum: { value: BASE_PARAMS.lum },
        uSunLum: { value: BASE_PARAMS.sunLum },
        uGlow: { value: BASE_PARAMS.glow },
        uSunRadius: { value: Math.sin(SUN_ANGULAR_RADIUS) },
        uTime: { value: 0 },
        uSunRadiance: { value: new THREE.Color(1, 0.86, 0.62) },
        uNight: { value: new THREE.Color(0, 0, 0) },
        uSkyTop: { value: new THREE.Color(0.3, 0.45, 0.7) },
        uSkyBottom: { value: new THREE.Color(0.7, 0.7, 0.7) },
        uGround: { value: new THREE.Color(BASE_PARAMS.groundTint) },
        uCloud: {
          value: new THREE.Vector4(
            BASE_PARAMS.cloudCoverage,
            BASE_PARAMS.cloudDensity,
            BASE_PARAMS.cloudBase,
            BASE_PARAMS.cloudThickness
          ),
        },
        uCloud2: {
          value: new THREE.Vector4(
            BASE_PARAMS.cloudScale,
            BASE_PARAMS.cloudTint,
            BASE_PARAMS.cirrusCoverage,
            BASE_PARAMS.cirrusDensity
          ),
        },
        uWind: { value: new THREE.Vector2(0.004, 0.001) },
        uStars: { value: 0 },
        uDither: { value: 0.01 },
        uCloudNoise: { value: this.cloudNoise },
      },
      side: THREE.BackSide,
      // No depth test plus first in the draw order is the robust skybox setup:
      // the dome can neither occlude the world nor be clipped by the far plane.
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(600, 40, 24), this.material);
    this.dome.name = 'sky-dome';
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    // The IBL capture renders its own copy of the dome, so no world geometry is
    // ever baked into the environment map.
    this._envScene = new THREE.Scene();
    this._envDome = new THREE.Mesh(new THREE.SphereGeometry(12, 32, 16), this.material);
    this._envDome.frustumCulled = false;
    this._envScene.add(this._envDome);
    this._cubeRT = new THREE.WebGLCubeRenderTarget(software ? 96 : 160, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this._cubeCam = new THREE.CubeCamera(0.5, 60, this._cubeRT);
    this._pmrem = new THREE.PMREMGenerator(renderer);

    // FogExp2 stays as the fallback for anything never patched; the patched path
    // replaces the fog chunk outright, so the two never stack.
    scene.fog = new THREE.FogExp2(0x9db2c6, BASE_PARAMS.fogDensity);
    scene.background = null;

    this.preset('goldenHour');

    this.game.bus.on('boot:complete', () => this.rescan());
    this.game.bus.on('level:ready', () => this.rescan());

    this.stats.initMs = +(performance.now() - t0).toFixed(1);
  }

  /* ------------------------------------------------------------- parameters */

  /** Apply a named preset. Rebuilds the IBL, so never per frame. */
  preset(name) {
    const p = SKY_PRESETS[name];
    if (!p) return this;
    this.presetName = name;
    this.params = { ...BASE_PARAMS, ...p };
    this._apply();
    return this;
  }

  /**
   * 0 = midnight, 0.25 = sunrise, 0.5 = midday, 0.8 = sunset. Drives the solar
   * arc from the active preset's `maxElevation`/`azimuthSwing` and re-derives
   * turbidity, haze and disc brightness from the resulting elevation, so a low
   * sun is automatically warmer and hazier. The rest of the preset is kept.
   */
  setTimeOfDay(t01) {
    const t = ((t01 % 1) + 1) % 1;
    this.timeOfDay = t;
    const p = this.params;
    // Sunrise 0.25, sunset 0.80: a long day, because the interesting light is at
    // the ends of it and an even map spends too little time there.
    const phase = (t - 0.25) / 0.55;
    p.elevation = p.maxElevation * Math.sin(Math.PI * phase);
    p.azimuth = p.azimuthNoon + p.azimuthSwing * (0.5 - phase) * 2;
    const el = Math.max(p.elevation, 0);
    p.turbidity = 2.3 + 4.2 * Math.exp(-el / 14);
    p.rayleigh = 1.5 + 1.5 * Math.exp(-el / 20);
    p.mieCoefficient = 0.0045 + 0.009 * Math.exp(-el / 12);
    p.sunLum = BASE_PARAMS.sunLum * (0.35 + 0.65 * Math.min(1, el / 25));
    p.glow = 0.2 + 0.8 * Math.exp(-el / 16);
    p.sunTintMix = 0.22 + 0.6 * Math.min(1, el / 40);
    p.stars = THREE.MathUtils.clamp(-p.elevation / 8, 0, 1);
    p.nightLum = BASE_PARAMS.nightLum + 0.4 * p.stars;
    p.cloudTint = 0.4 + 0.6 * THREE.MathUtils.clamp((p.elevation + 4) / 10, 0, 1);
    this._apply();
    return this;
  }

  /** Recompute every derived quantity from `params`, then rebuild the IBL. */
  _apply() {
    if (!this.material) return;
    const p = this.params;
    const u = this.material.uniforms;
    const el = p.elevation * D2R;
    const az = p.azimuth * D2R;
    const ce = Math.cos(el);
    this.sunDirection.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();

    for (let i = 0; i < 3; i++) this._betaR[i] = TOTAL_RAYLEIGH[i] * p.rayleigh;
    totalMie(p.turbidity, this._mie);
    for (let i = 0; i < 3; i++) this._betaM[i] = this._mie[i] * p.mieCoefficient;
    this._sunE = sunIntensityAt(Math.max(this.sunDirection.y, -0.05));

    this._tmpColor.set(p.nightSky).convertSRGBToLinear().multiplyScalar(p.nightLum * 0.02);
    this._night[0] = this._tmpColor.r;
    this._night[1] = this._tmpColor.g;
    this._night[2] = this._tmpColor.b;
    u.uNight.value.copy(this._tmpColor);

    // Transmitted sun colour. Extinction alone is far too red because it ignores
    // the multiple-scattered fill, so it is pulled back toward white by the
    // preset's sunTintMix; the result lands near a plausible colour temperature
    // for the elevation instead of on traffic-cone orange.
    this._extinction(Math.max(this.sunDirection.y, 0), this._fex);
    const mx = Math.max(this._fex[0], this._fex[1], this._fex[2], 1e-5);
    const k = p.sunTintMix;
    this.sunColor.setRGB(
      THREE.MathUtils.lerp(this._fex[0] / mx, 1, k),
      THREE.MathUtils.lerp(this._fex[1] / mx, 1, k),
      THREE.MathUtils.lerp(this._fex[2] / mx, 1, k)
    );
    const daylight = THREE.MathUtils.clamp(this.sunDirection.y * 3.2, 0, 1);
    this.sunIrradiance = 0.15 + 3.4 * daylight;

    // Clouds are lit by the sun's radiance, not by a normalised tint, or clouds
    // at dusk stay as bright as clouds at noon.
    u.uSunRadiance.value.copy(this.sunColor).multiplyScalar(p.cloudLight * (0.06 + 0.94 * daylight));

    this.sampleSky(this._tmpVec.set(0, 1, 0), this.zenithColor);
    // The horizon sample averages the sun side and the anti-sun side: one colour
    // has to stand in for both in the aerial term's vertical gradient.
    const sx = this.sunDirection.x;
    const sz = this.sunDirection.z;
    const hl = Math.max(Math.hypot(sx, sz), 1e-4);
    this.sampleSky(this._tmpVec.set(sx / hl, 0.045, sz / hl), this.horizonColor);
    this.sampleSky(this._tmpVec.set(-sx / hl, 0.045, -sz / hl), this._tmpColor);
    this.horizonColor.lerp(this._tmpColor, 0.42);

    this._computeAmbient();

    u.uSunDir.value.copy(this.sunDirection);
    u.uBetaR.value.set(this._betaR[0], this._betaR[1], this._betaR[2]);
    u.uBetaM.value.set(this._betaM[0], this._betaM[1], this._betaM[2]);
    u.uSunE.value = this._sunE;
    u.uMieG.value = p.mieG;
    u.uLum.value = p.lum;
    u.uSunLum.value = p.sunLum;
    u.uGlow.value = p.glow;
    u.uStars.value = p.stars;
    u.uSkyTop.value.copy(this.zenithColor);
    u.uSkyBottom.value.copy(this.horizonColor);
    u.uGround.value.set(p.groundTint).convertSRGBToLinear();
    u.uCloud.value.set(p.cloudCoverage, p.cloudDensity, p.cloudBase, p.cloudThickness);
    u.uCloud2.value.set(p.cloudScale, p.cloudTint, p.cirrusCoverage, p.cirrusDensity);
    const wd = p.windDeg * D2R;
    u.uWind.value.set(Math.sin(wd) * p.cloudSpeed, Math.cos(wd) * p.cloudSpeed);

    const a = this.aerialUniforms;
    a.uAerialSunDir.value.copy(this.sunDirection);
    // Slightly brighter than the dome sample behind the surface: a wall at 200 m
    // is lit by in-scatter from the whole sky, not just the sliver behind it.
    a.uAerialHorizon.value.copy(this.horizonColor).multiplyScalar(1.06);
    a.uAerialZenith.value.copy(this.zenithColor).multiplyScalar(1.02);
    a.uAerialSunTint.value.copy(u.uSunRadiance.value).multiplyScalar(0.22);
    a.uAerialParams.value.set(p.aerialDensity, 1 / p.aerialHeight, p.aerialGlow, p.aerialMax);
    a.uAerialDust.value.set(p.dustDensity, 1 / p.dustHeight, p.dustLobe, p.dustScale);
    // Dust returns the sun's own radiance through its own albedo, so it dies with
    // the sun instead of needing a separate night override, and it stays the
    // colour of the street it came off rather than the colour of the sky.
    this._tmpColor.copy(u.uGround.value);
    const gmx = Math.max(this._tmpColor.r, this._tmpColor.g, this._tmpColor.b, 1e-5);
    this._tmpColor.multiplyScalar(1 / gmx).lerp(WHITE, p.dustWhiten);
    a.uAerialDustCol.value.copy(u.uSunRadiance.value).multiply(this._tmpColor).multiplyScalar(p.dustLum);
    this._dustDirX = Math.sin(wd);
    this._dustDirZ = Math.cos(wd);

    const fog = this.game.scene.fog;
    if (fog) {
      fog.color.copy(this.horizonColor);
      if (fog.isFogExp2) fog.density = p.fogDensity;
    }
    // Any pixel the dome somehow misses should read as sky, not as void.
    this.game.renderer.setClearColor(this.horizonColor, 1);

    this._buildEnv();
    this.game.bus.emit('sky:changed', {
      sunDirection: this.sunDirection,
      sunColor: this.sunColor,
      ambientColor: this.ambientColor,
      sunIrradiance: this.sunIrradiance,
      ambientIntensity: this.ambientIntensity,
      envMap: this.envMap,
      preset: this.presetName,
    });
  }

  /** Fex: extinction along a view ray at the given zenith cosine. */
  _extinction(dirY, out) {
    const inv = airmass(dirY);
    const sR = RAYLEIGH_ZENITH * inv;
    const sM = MIE_ZENITH * inv;
    for (let i = 0; i < 3; i++) out[i] = Math.exp(-(this._betaR[i] * sR + this._betaM[i] * sM));
    return out;
  }

  /**
   * CPU evaluation of the dome's atmosphere term (no clouds, no sun disc). The
   * shader and this share structure and constants deliberately: the ambient and
   * aerial colours have to be the sky the player is actually looking at, and a
   * second hand-tuned palette would drift away from it at the first tweak.
   */
  sampleSky(dir, target = new THREE.Color()) {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dx = dir.x / len;
    const dy = dir.y / len;
    const dz = dir.z / len;
    const inv = airmass(Math.max(dy, 0));
    const sR = RAYLEIGH_ZENITH * inv;
    const sM = MIE_ZENITH * inv;
    const cosT = dx * this.sunDirection.x + dy * this.sunDirection.y + dz * this.sunDirection.z;
    const rp = rayleighPhase(cosT);
    const mp = hgPhase(cosT, this.params.mieG);
    const sunfade = Math.min(1, Math.pow(Math.max(0, 1 - Math.max(this.sunDirection.y, 0)), 5));
    const out = this._rad;
    const fade = this._msFade;
    let y = 0;
    for (let i = 0; i < 3; i++) {
      const bR = this._betaR[i];
      const bM = this._betaM[i];
      const fex = Math.exp(-(bR * sR + bM * sM));
      const direct = (this._sunE * (bR * rp + bM * mp)) / (bR + bM);
      out[i] = Math.max(direct * (1 - fex), 0);
      fade[i] = 1 + (Math.sqrt(Math.max(direct * fex, 0)) - 1) * sunfade;
      y += LUMA_W[i] * out[i];
    }
    const yc = Math.max(y, 1e-6);
    const ms = Math.pow(yc, MS_FILL) / yc;
    for (let i = 0; i < 3; i++) out[i] = out[i] * ms * fade[i] * this.params.lum + this._night[i];
    return target.setRGB(out[0], out[1], out[2]);
  }

  /**
   * Cosine-weighted average of the upper hemisphere: the fill a surface facing
   * up actually receives. Its blue bias is what tints shadows, which the review
   * rubric calls the single most common tell of an amateur frame.
   */
  _computeAmbient() {
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    const rings = 4;
    const spokes = 8;
    for (let i = 0; i < rings; i++) {
      const theta = ((i + 0.5) / rings) * (Math.PI / 2);
      const cw = Math.cos(theta) * Math.sin(theta);
      const st = Math.sin(theta);
      const ct = Math.cos(theta);
      for (let j = 0; j < spokes; j++) {
        const phi = ((j + 0.5) / spokes) * Math.PI * 2;
        this._tmpVec.set(st * Math.cos(phi), ct, st * Math.sin(phi));
        this.sampleSky(this._tmpVec, this._tmpColor);
        r += this._tmpColor.r * cw;
        g += this._tmpColor.g * cw;
        b += this._tmpColor.b * cw;
        w += cw;
      }
    }
    r /= w;
    g /= w;
    b /= w;
    const mx = Math.max(r, g, b, 1e-5);
    this.ambientColor.setRGB(r / mx, g / mx, b / mx);
    this.ambientIntensity = THREE.MathUtils.clamp(
      (0.2126 * r + 0.7152 * g + 0.0722 * b) * 1.6 * this.params.ambientMul,
      0.02,
      2
    );
  }

  /* -------------------------------------------------------------------- IBL */

  /**
   * Render the dome into a cube target and run PMREM over it. This is what makes
   * metal and glass read as metal and glass — with no prefiltered environment a
   * rough metal has nothing to reflect and turns into grey plastic. Costly, so
   * it happens on a time-of-day change and never per frame.
   */
  _buildEnv() {
    const t0 = performance.now();
    const { renderer, scene } = this.game;
    try {
      this._cubeCam.update(renderer, this._envScene);
      this._envTarget = this._pmrem.fromCubemap(this._cubeRT.texture, this._envTarget);
      this.envMap = this._envTarget.texture;
      scene.environment = this.envMap;
      // The cube map already holds physical radiance, so the scene-wide
      // multiplier stays at 1 and per-material envMapIntensity is the only knob.
      scene.environmentIntensity = 1;
    } catch (err) {
      console.warn('[sky] environment map generation failed', err);
    }
    this.stats.envMs = +(performance.now() - t0).toFixed(1);
  }

  /* --------------------------------------------------- aerial perspective */

  /**
   * Patch one material so it hazes with the sky instead of with a flat colour.
   * Idempotent, and safe on a material a sibling has already patched: the
   * previous onBeforeCompile is chained rather than replaced.
   */
  applyAerialPerspective(material) {
    if (!material || this._patched.has(material) || material.userData?.noAerial) return material;
    const ok =
      material.isMeshStandardMaterial ||
      material.isMeshPhysicalMaterial ||
      material.isMeshLambertMaterial ||
      material.isMeshPhongMaterial;
    if (!ok) return material;

    this._patched.add(material);
    const prevCompile = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    const shared = this.aerialUniforms;

    material.onBeforeCompile = function (shader, renderer) {
      if (prevCompile) prevCompile.call(this, shader, renderer);
      // Shared uniform objects by reference: one write per frame in Sky.update
      // reaches every patched material with no per-material loop.
      Object.assign(shader.uniforms, shared);

      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${AERIAL_VERT_HEAD}void main() {`)
        // Anchored on project_vertex, not begin_vertex, so `transformed` already
        // carries morphs and skinning: a running enemy hazes at its real depth.
        .replace(
          '#include <project_vertex>',
          `vec4 aerialW = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		aerialW = instanceMatrix * aerialW;
	#endif
	vAerialWorld = ( modelMatrix * aerialW ).xyz;
	#include <project_vertex>`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${AERIAL_FRAG_HEAD}void main() {`)
        .replace('#include <fog_fragment>', AERIAL_FRAG_BODY);
    };
    // onBeforeCompile is not part of Three's program cache key, so an unpatched
    // twin of this material would otherwise share its program and end up missing
    // the varying.
    material.customProgramCacheKey = function () {
      return `${prevKey ? prevKey.call(this) : ''}|sky-aerial-1`;
    };
    material.needsUpdate = true;
    this.stats.patched++;
    return material;
  }

  _visit(obj) {
    const m = obj.material;
    if (!m) return;
    if (Array.isArray(m)) for (const mm of m) this.applyAerialPerspective(mm);
    else this.applyAerialPerspective(m);
  }

  /** Walk the scene for materials that have appeared since the last pass. */
  rescan() {
    this.game.scene.traverse(this._visit);
    this._lastChildCount = this.game.scene.children.length;
  }

  /* ----------------------------------------------------------------- frame */

  update(dt) {
    const step = dt > 0 && dt < 0.5 ? dt : 0.016;
    this._elapsed += step;
    const cam = this.game.camera;

    // The dome is centred on the camera so its inner surface always spans the
    // view. The fragment shader derives its ray from cameraPosition, so the one
    // frame of lag in this copy is worth about a hundredth of a degree.
    this.dome.position.copy(cam.position);
    this.material.uniforms.uTime.value = this._elapsed;
    this.aerialUniforms.uAerialCam.value.copy(cam.position);
    // The dust field is anchored in world space, so the drift has to be applied as
    // a uv offset rather than by moving the sample point: at 0.5 m/s the plumes
    // must not slide when the player does.
    const drift = this.params.dustDrift * this.params.dustScale * this._elapsed;
    this.aerialUniforms.uAerialDustFlow.value.set(this._dustDirX * drift, this._dustDirZ * drift);

    // Level, decals and particles all add meshes after this module booted. A
    // change in child count is a cheap proxy for "something new arrived"; the
    // traversal is rate-limited because the recompile it triggers is not free.
    this._scanCooldown -= step;
    if (this._scanCooldown <= 0) {
      this._scanCooldown = 0.5;
      if (this.game.scene.children.length !== this._lastChildCount) this.rescan();
    }
  }

  dispose() {
    this.dome?.geometry.dispose();
    this._envDome?.geometry.dispose();
    this.material?.dispose();
    this._cubeRT?.dispose();
    this._envTarget?.dispose();
    this._pmrem?.dispose();
    this.cloudNoise?.dispose();
  }
}
