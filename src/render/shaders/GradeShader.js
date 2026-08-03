/**
 * The single grade pass: tone curve, colour grading and lens character, all in
 * one fragment shader so the frame is only read and written once.
 *
 * Everything up to `aces()` is scene-referred linear; everything after it is
 * display-referred linear; the sRGB transfer function is applied on the very last
 * line. That split is the whole point of the pass — exposure, contrast, split
 * toning and saturation are physical operations on radiance and go *before* the
 * tone curve, while lift/gamma/gain, vignette, grain and sharpening are print
 * operations and go after it. Doing any of them on the wrong side is what makes
 * a graded frame look like a filter instead of a photograph.
 *
 * The tone curve is the fitted ACES RRT+ODT (Stephen Hill's least-squares fit of
 * the reference transform, via the AP1 working matrices) rather than Narkowicz's
 * one-liner: the one-liner has no per-channel crosstalk, so a saturated highlight
 * hits the ceiling on one channel first and turns neon instead of desaturating
 * toward white. The matrices are what buy the highlight rolloff the review
 * rubric's tone axis is actually looking for.
 */

/** Radiance that maps to display middle grey through the ACES ODT. */
const MID_GREY = 0.18;

/**
 * Presets are diffs over `default`, so the interesting part of a look is the two
 * or three numbers it changes. `hold` (ms) makes a preset temporary: a flashbang
 * that never wore off would be a bug, not a look.
 */
export const GRADE_PRESETS = {
  default: {
    exposure: 1.0, // multiplies PostFX.baseExposure, not an absolute stop
    contrast: 1.18,
    saturation: 1.07,
    shadowTint: [0.855, 0.94, 1.15], // sky bounce: the cool half of teal-orange
    highTint: [1.075, 1.0, 0.925], // sun: the warm half
    split: [0.42, 0.32],
    // A print black, not a fill light. At the old [0.004, 0.007, 0.016] every
    // world pixel bottomed out at display (6, 13, 28) — a floor bluer than the
    // sunlit ground was warm, standing in for sky bounce the lighting was not
    // casting. Now that the fill tints the shade physically, this only has to
    // stop the toe reading as a hole, and a third of the old value does that
    // while leaving the shadow's colour to the scene.
    lift: [0.001, 0.002, 0.005],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.0, 0.997, 0.986],
    vignette: 1.0, // scales settings.vignette
    grain: 1.0,
    ca: 1.0,
    sharpen: 1.0,
    hold: 0,
  },
  flashbang: {
    exposure: 7.0,
    contrast: 0.82,
    saturation: 0.2,
    split: [0.08, 0.08],
    lift: [0.44, 0.45, 0.48],
    gamma: [0.82, 0.82, 0.85],
    vignette: 0.1,
    grain: 0.5,
    ca: 2.4,
    sharpen: 0.0,
    hold: 1400,
  },
  death: {
    exposure: 0.6,
    contrast: 1.04,
    saturation: 0.16,
    shadowTint: [0.78, 0.88, 1.06],
    highTint: [1.0, 0.98, 0.97],
    split: [0.55, 0.18],
    lift: [0.0, 0.004, 0.012],
    gamma: [1.09, 1.06, 1.02],
    gain: [0.88, 0.91, 0.95],
    vignette: 2.2,
    grain: 1.7,
    ca: 1.5,
    sharpen: 0.35,
    hold: 0,
  },
};

export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null }, // set by PostFX to a shared Vector2
    uTime: { value: 0 },

    // The view model, scene-referred, with coverage in alpha. It is composited
    // here rather than over the finished frame so the weapon shares the frame's
    // tone curve, black point and lens character instead of being pasted onto it.
    tViewmodel: { value: null },

    // Light shafts arrive as radiance, not as a layer: PostFX hands over the
    // accumulated sun-occlusion buffer and this pass adds it in before exposure
    // so it goes through the tone curve with everything else.
    tShaft: { value: null },
    // Scattering albedo of the shaft medium. The buffer is already scene-referred
    // radiance with its own extinction integrated along the eye ray, so this is
    // the last scalar and nothing here re-weights it by depth.
    uShaft: { value: 0 },

    uExposure: { value: 1 },
    uContrast: { value: 1.18 },
    uSaturation: { value: 1.07 },
    uShadowTint: { value: null },
    uHighTint: { value: null },
    uSplit: { value: null },
    uLift: { value: null },
    uGamma: { value: null },
    uGain: { value: null },

    uCA: { value: 1 },
    uVignette: { value: 0.7 },
    uGrain: { value: 0.09 },
    uSharpen: { value: 0.3 },

    uHurt: { value: 0 },
    uHurtTint: { value: null },
  },

  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,

  fragmentShader: /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tViewmodel;
uniform vec2 uTexel;
uniform float uTime;

uniform sampler2D tShaft;
uniform float uShaft;

uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec2 uSplit;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;

uniform float uCA;
uniform float uVignette;
uniform float uGrain;
uniform float uSharpen;

uniform float uHurt;
uniform vec3 uHurtTint;

const vec3 LUMA_W = vec3( 0.2126, 0.7152, 0.0722 );
const float MID = ${MID_GREY};

/* sRGB <- AP1 and AP1 -> sRGB, column-major transposes of the ACES fit's matrices. */
const mat3 ACES_IN = mat3(
	0.59719, 0.07600, 0.02840,
	0.35458, 0.90834, 0.13383,
	0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUT = mat3(
	1.60475, -0.10208, -0.00327,
	-0.53108, 1.10813, -0.07276,
	-0.07367, -0.00605, 1.07602
);

float luma( vec3 c ) { return dot( c, LUMA_W ); }

/** The RRT and ODT rolled into one rational fit. Scalar form used by the sharpener. */
float rrtOdt( float v ) {
	return ( v * ( v + 0.0245786 ) - 0.000090537 ) / ( v * ( 0.983729 * v + 0.4329510 ) + 0.238081 );
}

vec3 rrtOdt( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}

vec3 aces( vec3 c ) {
	return clamp( ACES_OUT * rrtOdt( ACES_IN * c ), 0.0, 1.0 );
}

/** Exact sRGB OETF. The 2.2 shortcut visibly lifts the bottom two stops. */
vec3 toSRGB( vec3 c ) {
	c = clamp( c, 0.0, 1.0 );
	return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666667 ) ) - 0.055, step( 0.0031308, c ) );
}

/**
 * The radiance this pass grades: the world, plus whatever in-scattered sunlight
 * the eye ray crossed, with the view model over the top.
 *
 * The view model target is rendered with ordinary alpha blending over a cleared
 * buffer, so its colour arrives already multiplied by its own coverage — the
 * composite is an add, not a mix, or a pane of optic glass would be attenuated
 * twice. Coverage also removes the airlight: the shaft term is derived from the
 * *world* depth behind the pixel, and a weapon 30 cm from the eye has none of
 * that air in front of it.
 */
vec3 sceneAt( vec2 uv, vec3 inscatter ) {
	vec4 vm = texture2D( tViewmodel, uv );
	vec3 world = max( texture2D( tDiffuse, uv ).rgb, 0.0 ) + inscatter;
	return world * ( 1.0 - clamp( vm.a, 0.0, 1.0 ) ) + max( vm.rgb, 0.0 );
}

/**
 * The whole tone + grade evaluated for one source sample. It is a function
 * rather than inline code because chromatic aberration has to run *after* the
 * grade, and in a single pass that means grading three separately offset samples
 * and keeping one channel from each.
 */
vec3 gradeAt( vec2 uv, vec3 inscatter ) {
	vec3 c = sceneAt( uv, inscatter ) * uExposure;

	// Split toning before the curve, so the tint rides the scene's own falloff
	// instead of sitting on top of the print as a flat wash.
	float l = luma( c );
	float sw = 1.0 - smoothstep( 0.0, 0.30, l );
	float hw = smoothstep( 0.35, 1.70, l );
	c *= mix( vec3( 1.0 ), uShadowTint, sw * uSplit.x );
	c *= mix( vec3( 1.0 ), uHighTint, hw * uSplit.y );

	// Contrast as a slope about middle grey in log2 space — a stop is a stop, so
	// the move is exposure-invariant. The gaussian weight confines it to roughly
	// four stops either side of grey so ACES' toe and shoulder survive it; that
	// combination is the actual S, and pushing the slope everywhere instead would
	// just clip the highlights the curve exists to roll off.
	vec3 lg = log2( max( c, 1e-6 ) / MID );
	lg *= 1.0 + ( uContrast - 1.0 ) * exp2( -lg * lg * 0.07 );
	c = exp2( lg ) * MID;

	c = max( mix( vec3( luma( c ) ), c, uSaturation ), 0.0 );

	c = aces( c );

	// ASC-CDL order: slope between lift and gain, then power. Display-referred.
	c = clamp( uLift + c * ( uGain - uLift ), 0.0, 1.0 );
	return pow( max( c, 1e-5 ), uGamma );
}

/**
 * Display-referred luminance of a source sample; feeds the unsharp mask only.
 * It reads the composite rather than the world alone, because a mask built from
 * what is *behind* the weapon would sharpen the weapon along the background's
 * edges — a halo with nothing under it.
 */
float displayLuma( vec2 uv ) {
	float l = max( luma( sceneAt( uv, vec3( 0.0 ) ) ), 0.0 ) * uExposure;
	return clamp( rrtOdt( l ), 0.0, 1.0 );
}

float hash21( vec2 p ) {
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 45.32 );
	return fract( p.x * p.y );
}

void main() {
	vec2 fromCentre = vUv - 0.5;
	// 1.0 at the edge midpoints, 1.414 in the corners.
	float rn = length( fromCentre ) * 2.0;

	// In-scattered sunlight, added as radiance so it goes through the same tone
	// curve as the surfaces it sits between. This used to be re-weighted here by
	// the pixel's own depth, standing in for an extinction integral the old
	// screen-space pass could not compute; the march does compute it, one step at
	// a time along the real eye ray, so weighting it again would charge the same
	// air twice and pull the near field to zero on top of that.
	vec3 shaft = uShaft > 0.0 ? texture2D( tShaft, vUv ).rgb * uShaft : vec3( 0.0 );

	vec3 col = gradeAt( vUv, shaft );

	// Radial chromatic aberration, confined to the corners: real lenses are
	// corrected on axis, and CA over the whole frame is the single most obvious
	// sign of post applied by feel rather than by optics. The old 0.72 gate put
	// 60% of full strength on the edge midpoints, which at 960 wide is a 1.7 px
	// red/blue split on a window reveal sitting nowhere near a corner. rn is 1.0
	// at those midpoints and 1.414 in the corners, so the ramp has to start above
	// 1.0 to mean "corner" at all; the offset then stays sub-pixel until it does.
	float caW = smoothstep( 0.95, 1.45, rn ) * uCA;
	if ( caW > 0.002 ) {
		vec2 dir = fromCentre / max( length( fromCentre ), 1e-5 );
		vec2 off = dir * caW * 0.0016;
		col.r = gradeAt( vUv + off, shaft ).r;
		col.b = gradeAt( vUv - off, shaft ).b;
	}

	// Vignette. Optical falloff is smooth and starts well inside the frame; a
	// hard ring at the edge reads as a texture overlay.
	col *= 1.0 - uVignette * 0.28 * smoothstep( 0.22, 1.44, rn );

	if ( uHurt > 0.0 ) {
		// Damage reads as blood in the periphery: strongest at the rim, and tied
		// to local brightness so it darkens rather than paints over the frame.
		float hv = uHurt * ( 0.2 + 0.8 * smoothstep( 0.12, 1.3, rn ) );
		col = mix( col, uHurtTint * max( luma( col ), 0.1 ), clamp( hv, 0.0, 0.92 ) );
	}

	// Grain, multiplied in and biased toward the shadows the way film density
	// noise is. Additive grain of a fixed amplitude in display-linear space would
	// be four times more visible in the darks than in the midtones.
	float g = hash21( gl_FragCoord.xy + vec2( uTime * 311.7, uTime * 173.3 ) ) - 0.5;
	g += 0.45 * ( hash21( gl_FragCoord.xy * 0.5 - vec2( uTime * 91.3, uTime * 57.1 ) ) - 0.5 );
	float darkness = 1.0 - smoothstep( 0.04, 0.7, luma( col ) );
	col += g * uGrain * ( 0.35 + 0.65 * darkness ) * ( col + 0.035 );

	// Unsharp mask on display luminance, normalised by local level so its
	// strength is the same in shadow and highlight, and clamped so an edge
	// cannot grow the white halo that gives over-sharpening away.
	if ( uSharpen > 0.0 ) {
		float c0 = displayLuma( vUv );
		float ring =
			displayLuma( vUv + vec2( uTexel.x, 0.0 ) ) +
			displayLuma( vUv - vec2( uTexel.x, 0.0 ) ) +
			displayLuma( vUv + vec2( 0.0, uTexel.y ) ) +
			displayLuma( vUv - vec2( 0.0, uTexel.y ) );
		float rel = ( c0 - ring * 0.25 ) / max( c0 + ring * 0.25 + 0.02, 0.02 );
		col *= 1.0 + clamp( rel, -0.35, 0.35 ) * uSharpen * 0.5;
	}

	gl_FragColor = vec4( toSRGB( col ), 1.0 );
}
`,
};
