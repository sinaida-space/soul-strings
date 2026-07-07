// WebGL2 constellation renderer: starfield + tron grid + strings +
// hand constellation + pluck bursts, composited through a bloom +
// TouchDesigner-style feedback post chain.
//
// Everything that allocates a GPU resource (buffers, textures,
// framebuffers, programs) happens in the constructor or in the
// resize path — `frame()` only updates buffer *contents* and draws.

import * as S from './shaders.js';

const STAR_COUNT = 600;
const STRING_COUNT = 7;
const STRING_SEGMENTS = 40; // quad strip subdivisions along the string
const LANDMARKS = 21;
const HAND_MAX = 2;
const SPARKLE_CAP = 256;
const BURST_CAP = 512; // ~21 concurrent 24-particle bursts

// Standard MediaPipe hand skeleton connections (landmark index pairs).
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const TIP_INDICES = new Set([4, 8, 12, 16, 20]);

const RED = [1.0, 0.164, 0.164];
const WHITE = [1.0, 1.0, 1.0];
const STAR_WHITE = [0.91, 0.90, 1.0];
const ICE_CYAN = [0.62, 0.95, 1.0];

function toNdc(x, y) {
  return [x * 2 - 1, 1 - y * 2];
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + info);
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Program link error: ' + info);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const uniforms = {};
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(program, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

// A small preallocated point-sprite particle pool used both for
// fingertip trailing sparkle and pluck-burst rings. Dead particles
// (life 0) contribute nothing so the draw count never changes.
class ParticlePool {
  constructor(gl, capacity) {
    this.gl = gl;
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.decay = new Float32Array(capacity); // life units / second
    this.size = new Float32Array(capacity);
    this.colorA = new Float32Array(capacity * 3);
    this.colorB = new Float32Array(capacity * 3);
    this.cursor = 0;

    // interleaved GPU scratch: pos(2) life(1) size(1) colorA(3) colorB(3) = 10 floats
    this.stride = 10;
    this.gpuData = new Float32Array(capacity * this.stride);

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.gpuData.byteLength, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = this.stride * 4;
    gl.enableVertexAttribArray(0); // aPos
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); // aLife
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2); // aSize
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(3); // aColorA
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(4); // aColorB
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, stride, 28);
    gl.bindVertexArray(null);
  }

  spawn(x, y, vx, vy, duration, size, colorA, colorB) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = 1.0;
    this.decay[i] = 1.0 / Math.max(duration, 0.001);
    this.size[i] = size;
    this.colorA[i * 3] = colorA[0]; this.colorA[i * 3 + 1] = colorA[1]; this.colorA[i * 3 + 2] = colorA[2];
    this.colorB[i * 3] = colorB[0]; this.colorB[i * 3 + 1] = colorB[1]; this.colorB[i * 3 + 2] = colorB[2];
  }

  update(dt) {
    const cap = this.capacity;
    for (let i = 0; i < cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= this.decay[i] * dt;
      if (this.life[i] < 0) this.life[i] = 0;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.vx[i] *= 0.96;
      this.vy[i] *= 0.96;
    }
  }

  uploadAndDraw(gl, dpr) {
    const cap = this.capacity;
    const g = this.gpuData;
    const st = this.stride;
    for (let i = 0; i < cap; i++) {
      const o = i * st;
      g[o] = this.x[i];
      g[o + 1] = this.y[i];
      g[o + 2] = this.life[i];
      g[o + 3] = this.size[i];
      g[o + 4] = this.colorA[i * 3]; g[o + 5] = this.colorA[i * 3 + 1]; g[o + 6] = this.colorA[i * 3 + 2];
      g[o + 7] = this.colorB[i * 3]; g[o + 8] = this.colorB[i * 3 + 1]; g[o + 9] = this.colorB[i * 3 + 2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, g);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, cap);
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    // HDR-ish color buffer support (float FBOs) — fall back to RGBA8.
    const floatExt = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    this._hdr = !!floatExt;
    this._colorFormat = this._hdr ? gl.RGBA16F : gl.RGBA8;
    this._colorType = this._hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this._initPrograms();
    this._initGeometry();

    this._w = 0; this._h = 0; this._dpr = 1;
    this._fbIndex = 0;
    this._t0 = performance.now();

    // fingertip position history for trailing-sparkle velocity (renderer-local, preallocated)
    this._prevTips = new Float32Array(HAND_MAX * 5 * 2).fill(NaN);

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);
    this._resize();
  }

  // ---------------------------------------------------------------
  // Init: programs
  // ---------------------------------------------------------------
  _initPrograms() {
    const gl = this.gl;
    this.progStar = createProgram(gl, S.starVS, S.starFS);
    this.progGrid = createProgram(gl, S.fullscreenVS, S.gridFS);
    this.progString = createProgram(gl, S.stringVS, S.stringFS);
    this.progHandStar = createProgram(gl, S.handStarVS, S.handStarFS);
    this.progFlat = createProgram(gl, S.flatVS, S.flatFS);
    this.progParticle = createProgram(gl, S.particleVS, S.particleFS);
    this.progBright = createProgram(gl, S.fullscreenVS, S.brightFS);
    this.progBlur = createProgram(gl, S.fullscreenVS, S.blurFS);
    this.progCopy = createProgram(gl, S.fullscreenVS, S.copyFS);
    this.progFeedback = createProgram(gl, S.fullscreenVS, S.feedbackFS);
    this.progFinal = createProgram(gl, S.fullscreenVS, S.finalFS);
  }

  // ---------------------------------------------------------------
  // Init: static + preallocated dynamic geometry
  // ---------------------------------------------------------------
  _initGeometry() {
    const gl = this.gl;

    // Fullscreen triangle (shared by every post pass + grid).
    this.triVAO = gl.createVertexArray();
    const triVBO = gl.createBuffer();
    gl.bindVertexArray(this.triVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, triVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Starfield: static (pos.xy, size, phase, seed) — 6 floats/vertex.
    const starData = new Float32Array(STAR_COUNT * 6);
    for (let i = 0; i < STAR_COUNT; i++) {
      const o = i * 6;
      starData[o] = Math.random() * 2 - 1;
      starData[o + 1] = Math.random() * 2 - 1;
      starData[o + 2] = 1.2 + Math.random() * 2.4; // px size
      starData[o + 3] = Math.random() * Math.PI * 2; // phase
      starData[o + 4] = Math.random(); // seed
      starData[o + 5] = 0; // pad
    }
    this.starVAO = gl.createVertexArray();
    const starVBO = gl.createBuffer();
    gl.bindVertexArray(this.starVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, starVBO);
    gl.bufferData(gl.ARRAY_BUFFER, starData, gl.STATIC_DRAW);
    const starStride = 6 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, starStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, starStride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, starStride, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, starStride, 16);
    gl.bindVertexArray(null);

    // String strip: static (aY, aSide) unit geometry, reused for all 7
    // strings by changing uniforms between draws.
    const rows = STRING_SEGMENTS + 1;
    const stringData = new Float32Array(rows * 2 * 2); // (aY,aSide) per vertex, 2 verts/row
    for (let r = 0; r < rows; r++) {
      const y = r / STRING_SEGMENTS;
      const o = r * 4;
      stringData[o] = y; stringData[o + 1] = -1;
      stringData[o + 2] = y; stringData[o + 3] = 1;
    }
    this.stringVAO = gl.createVertexArray();
    const stringVBO = gl.createBuffer();
    gl.bindVertexArray(this.stringVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, stringVBO);
    gl.bufferData(gl.ARRAY_BUFFER, stringData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 8, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 8, 4);
    gl.bindVertexArray(null);
    this.stringVertCount = rows * 2;

    // Hand landmark stars: dynamic (pos.xy, bright) — preallocated for 2 hands.
    this._handStarData = new Float32Array(HAND_MAX * LANDMARKS * 3);
    this.handStarVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handStarVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this._handStarData.byteLength, gl.DYNAMIC_DRAW);
    this.handStarVAO = gl.createVertexArray();
    gl.bindVertexArray(this.handStarVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handStarVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);

    // Hand bone lines: dynamic (pos.xy) — preallocated for 2 hands * connections * 2 verts.
    const maxLineVerts = HAND_MAX * HAND_CONNECTIONS.length * 2;
    this._handLineData = new Float32Array(maxLineVerts * 2);
    this.handLineVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handLineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this._handLineData.byteLength, gl.DYNAMIC_DRAW);
    this.handLineVAO = gl.createVertexArray();
    gl.bindVertexArray(this.handLineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handLineVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);

    // Particle pools.
    this.sparkles = new ParticlePool(gl, SPARKLE_CAP);
    this.bursts = new ParticlePool(gl, BURST_CAP);
  }

  // ---------------------------------------------------------------
  // Resize: (re)create all FBOs at the new resolution. Only touched
  // from here — never from frame().
  // ---------------------------------------------------------------
  _createFBO(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this._colorFormat, w, h, 0, gl.RGBA, this._colorType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  _destroyFBO(fbo) {
    if (!fbo) return;
    const gl = this.gl;
    gl.deleteFramebuffer(fbo.fbo);
    gl.deleteTexture(fbo.tex);
  }

  _resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const cssW = this.canvas.clientWidth || 1;
    const cssH = this.canvas.clientHeight || 1;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (w === this._w && h === this._h) return;
    this._w = w; this._h = h; this._dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;

    // Destroy old FBOs (if any) before recreating at new size.
    ['scene', 'bright', 'halfA', 'halfB', 'quarterA', 'quarterB'].forEach((k) => this._destroyFBO(this[k]));
    if (this.feedback) this.feedback.forEach((f) => this._destroyFBO(f));

    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);

    this.scene = this._createFBO(w, h);
    this.bright = this._createFBO(hw, hh);
    this.halfA = this._createFBO(hw, hh);
    this.halfB = this._createFBO(hw, hh);
    this.quarterA = this._createFBO(qw, qh);
    this.quarterB = this._createFBO(qw, qh);
    this.feedback = [this._createFBO(w, h), this._createFBO(w, h)];
    this._fbIndex = 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
  }

  // ---------------------------------------------------------------
  // Per-frame dynamic buffer updates (hand geometry + particle spawns)
  // ---------------------------------------------------------------
  _updateHandBuffers(state) {
    const gl = this.gl;
    const hands = (state && state.hands) || [];
    const starData = this._handStarData;
    const lineData = this._handLineData;
    let starCount = 0;
    let lineVerts = 0;

    for (let h = 0; h < hands.length && h < HAND_MAX; h++) {
      const hand = hands[h];
      const lm = hand.landmarks;
      const base = h * LANDMARKS;
      for (let i = 0; i < LANDMARKS; i++) {
        const [nx, ny] = toNdc(lm[i].x, lm[i].y);
        const o = (base + i) * 3;
        starData[o] = nx;
        starData[o + 1] = ny;
        starData[o + 2] = TIP_INDICES.has(i) ? 1.0 : (i === 0 ? 0.5 : 0.35);
        starCount++;
      }
      for (const [a, b] of HAND_CONNECTIONS) {
        const [ax, ay] = toNdc(lm[a].x, lm[a].y);
        const [bx, by] = toNdc(lm[b].x, lm[b].y);
        const o = lineVerts * 2;
        lineData[o] = ax; lineData[o + 1] = ay;
        lineData[o + 2] = bx; lineData[o + 3] = by;
        lineVerts += 2;
      }
    }

    this._handStarCount = starCount;
    this._handLineVerts = lineVerts;

    if (starCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.handStarVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, starData, 0, starCount * 3);
    }
    if (lineVerts > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.handLineVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, lineData, 0, lineVerts * 2);
    }
  }

  _spawnTrailSparkles(state, dt) {
    const hands = (state && state.hands) || [];
    const prev = this._prevTips;
    for (let h = 0; h < hands.length && h < HAND_MAX; h++) {
      const tips = hands[h].tips;
      for (let i = 0; i < 5; i++) {
        const idx = (h * 5 + i) * 2;
        const [nx, ny] = toNdc(tips[i].x, tips[i].y);
        const px = prev[idx], py = prev[idx + 1];
        if (!Number.isNaN(px)) {
          const dx = nx - px, dy = ny - py;
          const speed = Math.hypot(dx, dy) / Math.max(dt, 1 / 240);
          if (speed > 0.6) {
            const n = Math.min(3, Math.floor(speed * 2));
            for (let k = 0; k < n; k++) {
              this.sparkles.spawn(
                nx, ny, dx * 2, dy * 2, 0.4 + Math.random() * 0.2,
                2.5 + Math.random() * 2, STAR_WHITE, ICE_CYAN
              );
            }
          }
        }
        prev[idx] = nx; prev[idx + 1] = ny;
      }
    }
    // clear stale history for hands no longer tracked
    for (let h = hands.length; h < HAND_MAX; h++) {
      for (let i = 0; i < 5; i++) {
        const idx = (h * 5 + i) * 2;
        prev[idx] = NaN; prev[idx + 1] = NaN;
      }
    }
  }

  _spawnPluckBursts(state) {
    const plucks = (state && state.plucks) || [];
    const strings = (state && state.strings) || [];
    for (const p of plucks) {
      const sx = strings[p.string] ? strings[p.string].x : 0.5;
      const [nx, ny] = toNdc(sx, p.y);
      const n = 24;
      for (let k = 0; k < n; k++) {
        const angle = (k / n) * Math.PI * 2;
        const speed = (0.25 + Math.random() * 0.15) * (0.4 + p.vel);
        this.bursts.spawn(
          nx, ny, Math.cos(angle) * speed, Math.sin(angle) * speed,
          0.8, 3 + p.vel * 3, RED, WHITE
        );
      }
    }
  }

  // ---------------------------------------------------------------
  // Draw helpers
  // ---------------------------------------------------------------
  _setUniforms(uniforms, values) {
    const gl = this.gl;
    for (const key in values) {
      const loc = uniforms[key];
      if (loc === undefined || loc === null) continue;
      const v = values[key];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    }
  }

  _drawFullscreen(prog, textures, floats) {
    const gl = this.gl;
    gl.useProgram(prog.program);
    let unit = 0;
    for (const name in textures) {
      const loc = prog.uniforms[name];
      if (loc == null) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[name]);
      gl.uniform1i(loc, unit);
      unit++;
    }
    this._setUniforms(prog.uniforms, floats || {});
    gl.bindVertexArray(this.triVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _blurPass(srcTex, dstFBO, direction) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO.fbo);
    gl.viewport(0, 0, dstFBO.w, dstFBO.h);
    this._drawFullscreen(this.progBlur, { uTex: srcTex }, { uDirection: direction });
  }

  _drawStars(tSec, state) {
    const gl = this.gl;
    const prog = this.progStar;
    gl.useProgram(prog.program);
    this._setUniforms(prog.uniforms, { uTime: tSec, uShimmer: state.shimmer || 0, uDpr: this._dpr });
    gl.bindVertexArray(this.starVAO);
    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);
  }

  _drawGrid(tSec) {
    const gl = this.gl;
    const prog = this.progGrid;
    gl.useProgram(prog.program);
    this._setUniforms(prog.uniforms, { uTime: tSec, uAspect: this._w / this._h });
    gl.bindVertexArray(this.triVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _drawStrings(tSec, state) {
    const gl = this.gl;
    const prog = this.progString;
    gl.useProgram(prog.program);
    gl.bindVertexArray(this.stringVAO);
    const strings = state.strings || [];
    for (let i = 0; i < strings.length; i++) {
      const st = strings[i];
      const [nx] = toNdc(st.x, 0);
      this._setUniforms(prog.uniforms, { uX: nx, uExcite: st.excite, uFreq: st.freq, uTime: tSec });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.stringVertCount);
    }
  }

  _drawHands() {
    const gl = this.gl;
    if (this._handLineVerts > 0) {
      const prog = this.progFlat;
      gl.useProgram(prog.program);
      this._setUniforms(prog.uniforms, { uColor: STAR_WHITE, uAlpha: 0.18 });
      gl.bindVertexArray(this.handLineVAO);
      gl.drawArrays(gl.LINES, 0, this._handLineVerts);
    }
    if (this._handStarCount > 0) {
      const prog = this.progHandStar;
      gl.useProgram(prog.program);
      this._setUniforms(prog.uniforms, { uDpr: this._dpr });
      gl.bindVertexArray(this.handStarVAO);
      gl.drawArrays(gl.POINTS, 0, this._handStarCount);
    }
  }

  _drawParticles() {
    const gl = this.gl;
    const prog = this.progParticle;
    gl.useProgram(prog.program);
    this._setUniforms(prog.uniforms, { uDpr: this._dpr });
    this.sparkles.uploadAndDraw(gl, this._dpr);
    this.bursts.uploadAndDraw(gl, this._dpr);
  }

  // ---------------------------------------------------------------
  // Main entry point — called once per animation frame.
  // ---------------------------------------------------------------
  frame(t, dt, state) {
    const gl = this.gl;
    if (this._w === 0) this._resize();
    const tSec = t * 0.001;

    state = state || { hands: [], strings: [], shimmer: 0, plucks: [] };

    this._updateHandBuffers(state);
    this._spawnTrailSparkles(state, dt);
    this._spawnPluckBursts(state);
    this.sparkles.update(dt);
    this.bursts.update(dt);

    // 1. Scene pass — additive glow layers on black.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.scene.w, this.scene.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    this._drawStars(tSec, state);
    this._drawGrid(tSec);
    this._drawStrings(tSec, state);
    this._drawHands();
    this._drawParticles();

    gl.disable(gl.BLEND);

    // 2. Bright pass (half res).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bright.fbo);
    gl.viewport(0, 0, this.bright.w, this.bright.h);
    this._drawFullscreen(this.progBright, { uScene: this.scene.tex }, { uThreshold: 0.55 });

    // 3. Bloom, half res: bright -> halfA (H) -> halfB (V).
    this._blurPass(this.bright.tex, this.halfA, [1 / this.halfA.w, 0]);
    this._blurPass(this.halfA.tex, this.halfB, [0, 1 / this.halfB.h]);
    // bloomHalf = this.halfB.tex

    // 4. Bloom, quarter res: downsample halfB -> quarterA, blur -> quarterB (H) -> quarterA (V).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.quarterA.fbo);
    gl.viewport(0, 0, this.quarterA.w, this.quarterA.h);
    this._drawFullscreen(this.progCopy, { uTex: this.halfB.tex }, {});
    this._blurPass(this.quarterA.tex, this.quarterB, [1 / this.quarterB.w, 0]);
    this._blurPass(this.quarterB.tex, this.quarterA, [0, 1 / this.quarterA.h]);
    // bloomQuarter = this.quarterA.tex

    // 5. Feedback composite (written before tonemap), ping-ponged.
    const readFB = this.feedback[this._fbIndex];
    const writeFB = this.feedback[1 - this._fbIndex];
    const decay = 0.88 + (0.94 - 0.88) * (state.shimmer || 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, writeFB.fbo);
    gl.viewport(0, 0, writeFB.w, writeFB.h);
    this._drawFullscreen(this.progFeedback, {
      uScene: this.scene.tex,
      uBloomHalf: this.halfB.tex,
      uBloomQuarter: this.quarterA.tex,
      uPrevFeedback: readFB.tex,
    }, { uDecay: decay, uRotation: 0.0008, uScale: 1.0045 });
    this._fbIndex = 1 - this._fbIndex;

    // 6. Final: tonemap + grain + vignette, straight to canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._w, this._h);
    this._drawFullscreen(this.progFinal, { uComposite: writeFB.tex }, { uTime: tSec });
  }
}
