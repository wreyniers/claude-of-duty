/**
 * Camera-velocity motion blur.
 *
 * There is no velocity buffer in this renderer, and adding one would mean a
 * second pass over every mesh. Instead the per-pixel velocity is reconstructed:
 * depth gives the world position behind the pixel, and last frame's
 * view-projection says where that position used to be on screen. One matrix
 * multiply per pixel, no extra geometry pass. The trade is that only *camera*
 * motion is captured — a sprinting enemy does not smear against a still
 * background — which for a first-person shooter is the 90% that matters, since
 * almost all apparent motion comes from the player's own look and strafe.
 *
 * The blur length is clamped hard, in UV, before any tap is taken. Reprojected
 * velocity is wrong at silhouette edges (the depth behind the pixel belongs to
 * the near surface, the colour half a tap away belongs to the far one), and the
 * error grows with length; a long smear turns that error into the streaking that
 * reads instantly as a broken effect.
 */

/**
 * Shared by the TAA resolve, which needs exactly the same reprojection. Both
 * passes are handed the same matrix and jitter objects by PostFX, so there is one
 * definition of "where was this pixel last frame" in the chain.
 *
 * uReproject is prevViewProjection * inverse(currentJitteredViewProjection): the
 * inverse must be the jittered one because that is the matrix the depth buffer
 * was rasterised with, while the previous side must be unjittered or the sample
 * pattern would show up as velocity.
 */
export const VELOCITY_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uReproject;
uniform vec2 uJitterUv;

/** Screen-space motion of this pixel since the last frame, in UV. */
vec2 pixelVelocity( vec2 uv, out float depth ) {
	// Sky has no depth of its own. Reprojecting it just inside the far plane is
	// what makes a pan smear the clouds instead of leaving them pinned.
	depth = min( texture2D( tDepth, uv ).x, 0.999995 );
	vec4 clip = vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
	vec4 prev = uReproject * clip;
	vec2 prevUv = ( prev.xy / prev.w ) * 0.5 + 0.5;
	return ( uv - uJitterUv ) - prevUv;
}
`;

export const MotionBlurShader = {
  name: 'MotionBlurShader',

  defines: {
    TAPS: 9,
  },

  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uReproject: { value: null }, // shared Matrix4, owned by PostFX
    uJitterUv: { value: null }, // shared Vector2, owned by PostFX
    uTexel: { value: null }, // shared Vector2
    uStrength: { value: 0.55 },
    uMaxRadius: { value: 0.013 }, // UV; ~21 px at 1600 wide
    uSeed: { value: 0 },
  },

  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,

  fragmentShader:
    /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uMaxRadius;
uniform float uSeed;
` +
    VELOCITY_GLSL +
    /* glsl */ `

float hash21( vec2 p ) {
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 45.32 );
	return fract( p.x * p.y );
}

void main() {
	float depth;
	vec2 vel = pixelVelocity( vUv, depth ) * uStrength;

	float len = length( vel );
	float minLen = 0.9 * length( uTexel );
	if ( len < minLen ) {
		// Under a pixel of movement there is nothing to integrate, and taking taps
		// anyway would only soften a still frame.
		gl_FragColor = texture2D( tDiffuse, vUv );
		return;
	}

	vel *= min( 1.0, uMaxRadius / len );

	// Jittering the tap offsets per pixel turns the banding a fixed tap set leaves
	// on a wide blur into noise, which the grain pass then hides.
	float j = hash21( gl_FragCoord.xy + uSeed );
	vec3 acc = vec3( 0.0 );
	for ( int i = 0; i < TAPS; i ++ ) {
		float t = ( ( float( i ) + j ) / float( TAPS ) ) - 0.5;
		acc += texture2D( tDiffuse, vUv + vel * t ).rgb;
	}

	gl_FragColor = vec4( acc / float( TAPS ), 1.0 );
}
`,
};
