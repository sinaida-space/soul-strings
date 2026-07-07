// GLSL ES 3.00 source strings for the constellation renderer.
// Kept as plain template strings (no build step) — see render.js for how
// these are compiled/linked and how the post chain is wired together.

// ---------------------------------------------------------------------
// Shared fullscreen-triangle vertex shader (used by every post-process
// pass: bright-pass, blur, feedback composite, final, grid, downsample).
// One triangle covering the viewport, no index buffer needed.
// ---------------------------------------------------------------------
export const fullscreenVS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------
// Starfield — ~600 GL_POINTS, static VBO (pos, size, phase, seed).
// Twinkle + slow drift computed entirely in-shader from uTime.
// ---------------------------------------------------------------------
export const starVS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in float aSize;
layout(location=2) in float aPhase;
layout(location=3) in float aSeed;
uniform float uTime;
uniform float uShimmer;
uniform float uDpr;
out float vTwinkle;
out float vSeed;
void main() {
  // slow independent drift per star, cheap Lissajous-ish wander
  vec2 drift = vec2(sin(uTime * 0.015 + aPhase), cos(uTime * 0.011 + aSeed * 6.2831)) * 0.004;
  vec2 pos = aPos + drift;
  gl_Position = vec4(pos, 0.0, 1.0);
  float tw = 0.5 + 0.5 * sin(uTime * 1.3 + aPhase * 6.2831);
  vTwinkle = tw * (1.0 + uShimmer * 3.0);
  vSeed = aSeed;
  gl_PointSize = aSize * uDpr * (0.75 + tw * 0.5) * (1.0 + uShimmer * 0.5);
}
`;

export const starFS = `#version 300 es
precision highp float;
in float vTwinkle;
in float vSeed;
uniform float uShimmer;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  float alpha = smoothstep(1.0, 0.0, d);
  vec3 white = vec3(0.91, 0.90, 1.0);
  vec3 cyan = vec3(0.62, 0.95, 1.0);
  vec3 col = mix(white, cyan, uShimmer * 0.65 * step(0.5, vSeed));
  float b = alpha * vTwinkle * (0.35 + uShimmer * 1.6);
  fragColor = vec4(col * b, 1.0);
}
`;

// ---------------------------------------------------------------------
// Tron-style grid horizon — fullscreen fragment layer, bottom ~28%.
// Cheap fake-perspective: rows converge via 1/t, columns fan out by
// (1-t). Restrained intensity so it reads as atmosphere, not subject.
// ---------------------------------------------------------------------
export const gridFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
uniform float uAspect;
out vec4 fragColor;
void main() {
  const float horizonY = 0.72; // grid occupies bottom 28% of the frame
  float yd = 1.0 - vUv.y;      // screen-down y: GL varying has y=1 at the top
  if (yd < horizonY) { fragColor = vec4(0.0); return; }
  float t = (yd - horizonY) / (1.0 - horizonY); // 0 at horizon .. 1 at bottom
  float z = 1.0 / (t * 9.0 + 0.06);

  float rows = abs(fract(z * 0.5 - uTime * 0.12) - 0.5);
  float lineH = smoothstep(0.035, 0.0, rows);

  float xc = (vUv.x - 0.5) * uAspect * (1.0 + (1.0 - t) * 9.0);
  float cols = abs(fract(xc * 2.0) - 0.5);
  float lineV = smoothstep(0.05, 0.0, cols) * smoothstep(0.0, 0.12, t);

  float horizonGlow = smoothstep(0.035, 0.0, t) * 1.6;

  vec3 red = vec3(1.0, 0.164, 0.164);
  float intensity = (lineH * 0.5 + lineV * 0.45 + horizonGlow) * 0.25;
  fragColor = vec4(red * intensity, 1.0);
}
`;

// ---------------------------------------------------------------------
// Strings — 7 vertical glowing quads drawn one at a time (static strip
// geometry, per-string uniforms). Standing-wave displacement per spec.
// ---------------------------------------------------------------------
export const stringVS = `#version 300 es
layout(location=0) in float aY;    // 0..1 along the string
layout(location=1) in float aSide; // -1 or +1, quad half-width side
uniform float uX;      // NDC x center of this string
uniform float uExcite;
uniform float uFreq;
uniform float uTime;
out float vSide;
out float vExcite;
void main() {
  float wave = sin(aY * 3.14159265 * 3.0 + uTime * 40.0 * uFreq / 220.0) * sin(aY * 3.14159265);
  float xoff = uExcite * 0.012 * wave;
  float thickness = 0.0022 + uExcite * 0.0035;
  float x = uX + xoff + aSide * thickness;
  float y = aY * 2.0 - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
  vSide = aSide;
  vExcite = uExcite;
}
`;

export const stringFS = `#version 300 es
precision highp float;
in float vSide;
in float vExcite;
out vec4 fragColor;
void main() {
  vec3 core = vec3(1.0, 1.0, 1.0);
  vec3 halo = vec3(1.0, 0.164, 0.164);
  float base = 0.16 + vExcite * 0.9;
  vec3 col = mix(halo, core, 0.28 + vExcite * 0.55);
  fragColor = vec4(col * base, 1.0);
}
`;

// ---------------------------------------------------------------------
// Constellation hand landmarks — point sprites with a 4-point cross
// flare, brighter at fingertips (aBright supplied per-vertex by CPU).
// ---------------------------------------------------------------------
export const handStarVS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in float aBright;
uniform float uDpr;
out float vBright;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = (5.0 + aBright * 9.0) * uDpr;
  vBright = aBright;
}
`;

export const handStarFS = `#version 300 es
precision highp float;
in float vBright;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  float core = smoothstep(0.55, 0.0, d);
  float flareX = smoothstep(0.06, 0.0, abs(c.y)) * smoothstep(1.0, 0.0, abs(c.x));
  float flareY = smoothstep(0.06, 0.0, abs(c.x)) * smoothstep(1.0, 0.0, abs(c.y));
  float flare = max(flareX, flareY) * 0.55;
  float a = core + flare;
  vec3 col = vec3(0.91, 0.90, 1.0);
  fragColor = vec4(col * a * (0.55 + vBright * 0.9), 1.0);
}
`;

// Flat-color line program — used for hand bone lines (~0.18 alpha).
export const flatVS = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const flatFS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 fragColor;
void main() { fragColor = vec4(uColor * uAlpha, 1.0); }
`;

// ---------------------------------------------------------------------
// Shared particle point-sprite program — used for both fingertip
// trailing sparkle and pluck-burst rings (dead particles have life=0
// so they contribute nothing, no need to change draw count).
// ---------------------------------------------------------------------
export const particleVS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in float aLife;
layout(location=2) in float aSize;
layout(location=3) in vec3 aColorA;
layout(location=4) in vec3 aColorB;
uniform float uDpr;
out float vLife;
out vec3 vColor;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = aSize * aLife * uDpr;
  vLife = aLife;
  // life 1.0 at birth -> aColorA, life 0.0 at death -> aColorB (e.g. red -> white)
  vColor = mix(aColorB, aColorA, aLife);
}
`;

export const particleFS = `#version 300 es
precision highp float;
in float vLife;
in vec3 vColor;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = length(c);
  float a = smoothstep(1.0, 0.0, d) * vLife;
  fragColor = vec4(vColor * a, 1.0);
}
`;

// ---------------------------------------------------------------------
// Post chain: bright-pass, separable blur, downsample-copy, feedback
// composite, final tonemap+grain+vignette. All fullscreen-triangle.
// ---------------------------------------------------------------------
export const brightFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
out vec4 fragColor;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  float lum = max(c.r, max(c.g, c.b));
  float w = smoothstep(uThreshold, uThreshold + 0.35, lum);
  fragColor = vec4(c * w, 1.0);
}
`;

// 9-tap separable gaussian. uDirection is a texel-space step vector
// (1/width,0) or (0,1/height) scaled by the caller for each pass.
export const blurFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDirection;
out vec4 fragColor;
void main() {
  float w0 = 0.227027, w1 = 0.1945946, w2 = 0.1216216, w3 = 0.054054, w4 = 0.016216;
  vec3 col = texture(uTex, vUv).rgb * w0;
  col += texture(uTex, vUv + uDirection * 1.0).rgb * w1;
  col += texture(uTex, vUv - uDirection * 1.0).rgb * w1;
  col += texture(uTex, vUv + uDirection * 2.0).rgb * w2;
  col += texture(uTex, vUv - uDirection * 2.0).rgb * w2;
  col += texture(uTex, vUv + uDirection * 3.0).rgb * w3;
  col += texture(uTex, vUv - uDirection * 3.0).rgb * w3;
  col += texture(uTex, vUv + uDirection * 4.0).rgb * w4;
  col += texture(uTex, vUv - uDirection * 4.0).rgb * w4;
  fragColor = vec4(col, 1.0);
}
`;

export const copyFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() { fragColor = vec4(texture(uTex, vUv).rgb, 1.0); }
`;

// TouchDesigner-style feedback: sample the previous composite through
// a slow zoom+rotate around center, decay it, and sum with the fresh
// scene + bloom. Written into the *other* ping-pong slot before tonemap.
export const feedbackFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloomHalf;
uniform sampler2D uBloomQuarter;
uniform sampler2D uPrevFeedback;
uniform float uDecay;
uniform float uRotation;
uniform float uScale;
out vec4 fragColor;
void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloomHalf, vUv).rgb * 0.6 + texture(uBloomQuarter, vUv).rgb * 0.9;

  vec2 c = vUv - 0.5;
  float s = sin(uRotation), co = cos(uRotation);
  c = mat2(co, -s, s, co) * c;
  c *= uScale;
  vec2 fbUv = c + 0.5;
  vec3 fb = texture(uPrevFeedback, fbUv).rgb * uDecay;

  fragColor = vec4(scene + bloom + fb, 1.0);
}
`;

export const finalFS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uComposite;
uniform float uTime;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 c = texture(uComposite, vUv).rgb;
  // ACES-ish filmic tonemap
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  float grain = (hash(vUv * vec2(1920.0, 1080.0) + uTime) - 0.5) * 0.015;
  c += grain;
  vec2 d = vUv - 0.5;
  float vig = smoothstep(0.9, 0.2, dot(d, d) * 2.0);
  c *= mix(0.55, 1.0, vig);
  fragColor = vec4(c, 1.0);
}
`;
