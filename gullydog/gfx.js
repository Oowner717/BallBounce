/*
 * gfx.js — the WebGL2 renderer.
 *
 * PASSES
 *   1. instance data  — every bone matrix of every visible creature and vehicle,
 *                       packed into one RGBA32F texture (rig.js layout)
 *   2. shadow map     — sun's-eye depth of the area around the dog
 *   3. sky            — full-screen gradient, sun, stars, moon
 *   4. opaque         — static city chunks (frustum culled), then one instanced
 *                       draw per model type
 *   5. decals         — flat quads on the ground: blob shadows, puddles, rings
 *   6. particles      — points: dust, smoke, scent trails, glows (additive last)
 *
 * Lighting is done in linear space with a filmic curve on the way out. The sky
 * and the fog share colours so the city melts into the haze at the horizon.
 * Up to eight point lights (street lamps at night) are passed per frame.
 */

import { m4, m4Mul, m4Invert, m4LookAt, m4Ortho, frustumPlanes, sphereInFrustum } from './util.js';
import { VERTEX_STRIDE } from './geom.js';

const INST_W = 1024;          // instance texture width in texels
const MAX_LIGHTS = 8;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const MAIN_VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aCol;
layout(location=3) in vec2 aUV;
layout(location=4) in vec4 aExt;
layout(location=5) in vec4 aExt2;
uniform mat4 uVP;
uniform float uTime;
#ifdef SKINNED
uniform sampler2D uInst;
uniform int uBase;
uniform int uStride;
vec4 fetchT(int i) { return texelFetch(uInst, ivec2(i & ${INST_W - 1}, i >> ${Math.log2(INST_W)}), 0); }
#endif
#ifndef DEPTH
uniform mat4 uShadowVP;
out vec3 vPos;
out vec3 vNrm;
out vec3 vCol;
out vec2 vUV;
out float vEm;
out float vDetail;
out vec4 vShadow;
#endif
void main() {
  vec4 p = vec4(aPos, 1.0);
  vec3 n = aNrm;
  vec3 col = aCol.rgb;
#ifdef SKINNED
  int base = uBase + gl_InstanceID * uStride;
  int slot = int(aExt.y + 0.5);
  if (slot > 0) col *= fetchT(base + slot - 1).rgb;
  int b = base + 4 + int(aExt.x + 0.5) * 3;
  vec4 r0 = fetchT(b), r1 = fetchT(b + 1), r2 = fetchT(b + 2);
  vec3 wp = vec3(dot(r0, p), dot(r1, p), dot(r2, p));
  n = vec3(dot(r0.xyz, n), dot(r1.xyz, n), dot(r2.xyz, n));
#else
  vec3 wp = aPos;
#endif
  float sway = aExt2.x;
  if (sway > 0.0) {
    float ph = uTime * 1.6 + wp.x * 0.35 + wp.z * 0.27;
    wp.x += sin(ph) * 0.05 * sway;
    wp.z += cos(ph * 0.83 + 1.7) * 0.04 * sway;
    wp.y += sin(ph * 1.3) * 0.015 * sway;
  }
  gl_Position = uVP * vec4(wp, 1.0);
#ifndef DEPTH
  vPos = wp;
  vNrm = normalize(n);
  vCol = col;
  vUV = aUV;
  vEm = aExt.z;
  vDetail = aExt.w / 255.0;
  vShadow = uShadowVP * vec4(wp + vNrm * 0.06, 1.0);
#endif
}`;

const MAIN_FS = `
precision highp sampler2DShadow;
in vec3 vPos;
in vec3 vNrm;
in vec3 vCol;
in vec2 vUV;
in float vEm;
in float vDetail;
in vec4 vShadow;
uniform sampler2D uAtlas;
uniform sampler2D uNoise;
uniform sampler2DShadow uShadow;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGndCol;
uniform vec3 uFogCol;
uniform float uFogDen;
uniform float uEmScale;
uniform vec3 uWinCol;
uniform float uShadowOn;
uniform float uShadowTexel;
uniform float uExposure;
uniform float uWet;
uniform float uSniff;
uniform float uSat;
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec3 uLightCol[${MAX_LIGHTS}];
uniform int uLightCount;
out vec4 oCol;

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

float shadowAt() {
  vec3 sc = vShadow.xyz / vShadow.w * 0.5 + 0.5;
  if (sc.x <= 0.0 || sc.x >= 1.0 || sc.y <= 0.0 || sc.y >= 1.0 || sc.z >= 1.0) return 1.0;
  float t = uShadowTexel;
  float z = sc.z - 0.0008;
  float s = texture(uShadow, vec3(sc.xy + vec2(-0.6, -0.6) * t, z));
  s += texture(uShadow, vec3(sc.xy + vec2(0.6, -0.6) * t, z));
  s += texture(uShadow, vec3(sc.xy + vec2(-0.6, 0.6) * t, z));
  s += texture(uShadow, vec3(sc.xy + vec2(0.6, 0.6) * t, z));
  vec2 e = smoothstep(0.0, 0.08, sc.xy) * smoothstep(0.0, 0.08, 1.0 - sc.xy);
  return mix(1.0, s * 0.25, e.x * e.y);
}

void main() {
  vec3 tex = texture(uAtlas, vUV).rgb;
  vec3 base = vCol * tex;
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  if (vDetail > 0.0) {
    vec3 an = abs(N);
    vec2 tuv = an.y > 0.6 ? vPos.xz : (an.x > an.z ? vPos.zy : vPos.xy);
    float g = texture(uNoise, tuv * 0.37).r * 0.55 + texture(uNoise, tuv * 0.061).g * 0.45;
    float low = an.y < 0.6 ? (1.0 - smoothstep(0.0, 1.3, vPos.y)) * 0.22 : 0.0;
    base *= mix(1.0, (0.76 + g * 0.48) * (1.0 - low), vDetail);
  }
  vec3 albedo = pow(base, vec3(2.2));
  float wet = uWet * smoothstep(0.55, 0.95, N.y) * step(vPos.y, 0.4);
  albedo *= 1.0 - wet * 0.45;
  float ndl = dot(N, uSunDir);
  float sh = (uShadowOn > 0.5 && ndl > 0.0) ? shadowAt() : 1.0;
  vec3 hemi = mix(uGndCol, uSkyCol, N.y * 0.5 + 0.5);
  float ao = mix(0.6, 1.0, smoothstep(0.0, 1.0, vPos.y + 0.12));
  vec3 light = hemi * ao + uSunCol * max(ndl, 0.0) * sh;
  vec3 V = normalize(uCamPos - vPos);
  vec3 spec = vec3(0.0);
  if (wet > 0.01) {
    vec3 H = normalize(uSunDir + V);
    spec += uSunCol * pow(max(dot(N, H), 0.0), 80.0) * sh * wet * 1.5;
  }
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 L = uLightPos[i].xyz - vPos;
    float r = uLightPos[i].w;
    float d2 = dot(L, L);
    if (d2 < r * r) {
      float att = 1.0 - d2 / (r * r);
      att *= att;
      vec3 Ln = L * inversesqrt(max(d2, 1e-4));
      light += uLightCol[i] * att * (max(dot(N, Ln), 0.0) * 0.8 + 0.2);
      if (wet > 0.01) spec += uLightCol[i] * att * pow(max(dot(N, normalize(Ln + V)), 0.0), 40.0) * wet * 2.0;
    }
  }
  vec3 col = albedo * light + spec;
  if (vEm > 0.5) {
    if (vEm < 127.5) col += albedo * (vEm / 127.0) * uEmScale;
    else col += uWinCol * ((vEm - 128.0) / 127.0);
  }
  float dist = length(vPos - uCamPos);
  float fog = 1.0 - exp(-pow(dist * uFogDen, 1.5));
  col = mix(col, uFogCol, fog);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSat);
  col = mix(col, vec3(lum) * vec3(0.8, 0.88, 1.08), uSniff * 0.8);
  col = aces(col * uExposure);
  oCol = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

const DEPTH_FS = `
out vec4 oCol;
void main() { oCol = vec4(1.0); }`;

const SKY_VS = `
out vec2 vNdc;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SKY_FS = `
in vec2 vNdc;
uniform mat4 uInvVP;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFogCol;
uniform vec3 uMoonDir;
uniform float uNight;
uniform float uExposure;
uniform float uCloud;
uniform float uTime;
uniform float uSniff;
uniform float uSat;
out vec4 oCol;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(vec3(i, 1.0)), b = hash(vec3(i + vec2(1.0, 0.0), 1.0));
  float c = hash(vec3(i + vec2(0.0, 1.0), 1.0)), d = hash(vec3(i + vec2(1.0, 1.0), 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec4 a = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(a.xyz / a.w - uCamPos);
  float h = dir.y;
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  float sd = max(dot(dir, uSunDir), 0.0);
  float sunUp = smoothstep(-0.08, 0.02, uSunDir.y);
  sky += uSunCol * (smoothstep(0.9993, 0.9997, sd) * 18.0 + pow(sd, 10.0) * 0.22 + pow(sd, 3.0) * 0.05) * sunUp;
  if (h > 0.0) {
    // drifting high cloud
    vec2 cp = dir.xz / (h + 0.12) * 1.3 + vec2(uTime * 0.006, uTime * 0.002);
    float cl = vnoise(cp) * 0.55 + vnoise(cp * 2.3) * 0.3 + vnoise(cp * 5.1) * 0.15;
    cl = smoothstep(0.55 - uCloud * 0.35, 0.95, cl) * smoothstep(0.0, 0.25, h);
    vec3 cloudCol = mix(uHorizon * 1.1, uSunCol * 0.35 + uHorizon * 0.8, 0.5) * (1.0 - uNight * 0.85);
    sky = mix(sky, cloudCol, cl * 0.7);
  }
  if (uNight > 0.01 && h > 0.0) {
    vec3 sp = dir * 220.0;
    vec3 cell = floor(sp);
    float r = hash(cell);
    float star = step(0.9965, r) * smoothstep(0.45, 0.0, length(fract(sp) - 0.5));
    sky += vec3(0.9, 0.92, 1.0) * star * uNight * smoothstep(0.02, 0.3, h) * (0.6 + 0.4 * sin(uTime * 3.0 + r * 40.0));
    float md = dot(dir, uMoonDir);
    sky += vec3(0.95, 0.95, 1.0) * smoothstep(0.99955, 0.9997, md) * uNight * 3.0;
    sky += vec3(0.25, 0.3, 0.45) * pow(max(md, 0.0), 30.0) * uNight * 0.25;
  }
  sky = mix(sky, uFogCol, exp(-max(h, 0.0) * 6.0) * 0.85);
  if (h < 0.0) sky = uFogCol;
  float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
  sky = mix(vec3(lum), sky, uSat);
  sky = mix(sky, vec3(lum) * vec3(0.8, 0.88, 1.08), uSniff * 0.8);
  vec3 col = aces(sky * uExposure);
  oCol = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

const PART_VS = `
layout(location=0) in vec4 aPosSize;
layout(location=1) in vec4 aCol;
uniform mat4 uVP;
uniform float uPxScale;
uniform vec3 uCamPos;
uniform float uFogDen;
out vec4 vCol;
void main() {
  vec4 c = uVP * vec4(aPosSize.xyz, 1.0);
  gl_Position = c;
  gl_PointSize = clamp(aPosSize.w * uPxScale / max(c.w, 0.05), 1.0, 300.0);
  float dist = length(aPosSize.xyz - uCamPos);
  float fog = 1.0 - exp(-pow(dist * uFogDen, 1.5));
  // anything brushing past the lens fades instead of filling the screen
  float nearFade = smoothstep(0.6, 2.6, dist);
  vCol = vec4(aCol.rgb, aCol.a * (1.0 - fog) * nearFade);
}`;

const PART_FS = `
in vec4 vCol;
out vec4 oCol;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = clamp(1.0 - dot(d, d) * 4.0, 0.0, 1.0);
  a *= a;
  oCol = vec4(vCol.rgb * vCol.a * a, vCol.a * a);
}`;

const DECAL_VS = `
layout(location=0) in vec4 aA;  // x, y, z, size
layout(location=1) in vec4 aB;  // cos, sin, kind, alpha
layout(location=2) in vec4 aUVr;
layout(location=3) in vec4 aC;  // rgb, aspect
uniform mat4 uVP;
out vec2 vUV;
out vec4 vColA;
out float vKind;
out vec3 vPos;
void main() {
  vec2 q = vec2((gl_VertexID & 1) == 1 ? 1.0 : -1.0, (gl_VertexID & 2) == 2 ? 1.0 : -1.0);
  vec2 s = q * vec2(aA.w, aA.w * aC.w);
  vec2 r = vec2(s.x * aB.x - s.y * aB.y, s.x * aB.y + s.y * aB.x);
  vec3 wp = vec3(aA.x + r.x, aA.y, aA.z + r.y);
  vPos = wp;
  vUV = mix(aUVr.xy, aUVr.zw, q * 0.5 + 0.5);
  vColA = vec4(aC.rgb, aB.w);
  vKind = aB.z;
  gl_Position = uVP * vec4(wp, 1.0);
}`;

const DECAL_FS = `
in vec2 vUV;
in vec4 vColA;
in float vKind;
in vec3 vPos;
uniform sampler2D uAtlas;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uFogCol;
uniform float uFogDen;
uniform float uExposure;
uniform float uNightGlow;
out vec4 oCol;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  float a = texture(uAtlas, vUV).a * vColA.a;
  if (a < 0.003) discard;
  vec3 col;
  if (vKind < 0.5) {
    col = vColA.rgb;                       // shadow / stain: a plain colour
  } else if (vKind < 1.5) {
    vec3 V = normalize(uCamPos - vPos);
    float fres = 0.15 + 0.85 * pow(1.0 - max(V.y, 0.0), 4.0);
    vec3 H = normalize(uSunDir + V);
    float glint = pow(max(H.y, 0.0), 300.0) * 6.0 * step(0.0, uSunDir.y);
    vec3 lin = mix(vec3(0.03, 0.035, 0.04), uSkyCol * 0.9, fres) + uSunCol * glint;
    lin = mix(lin, uFogCol, 1.0 - exp(-pow(length(vPos - uCamPos) * uFogDen, 1.5)));
    col = pow(aces(lin * uExposure), vec3(1.0 / 2.2));
  } else {
    col = vColA.rgb * (1.0 + uNightGlow); // markers: self-lit
  }
  float dist = length(vPos - uCamPos);
  a *= exp(-pow(dist * uFogDen, 1.5));
  oCol = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ helpers */

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader: ' + log + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n').slice(0, 4000));
  }
  return s;
}

function program(gl, vs, fs, defines) {
  const head = COMMON + (defines || []).map((d) => '#define ' + d + '\n').join('');
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, head + vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, head + fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

function meshVAO(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  const S = VERTEX_STRIDE;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.BYTE, true, S, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, S, 16);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.UNSIGNED_SHORT, true, S, 20);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, false, S, 24);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, S, 28);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const b = mesh.bounds;
  const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
  const r = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
  return {
    vao, vb, ib, count: mesh.indexCount,
    type: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    cx, cy, cz, r,
  };
}

/** Per-model instance staging. Each instance is 4 colour texels then 3 texels per bone. */
export class Batch {
  constructor(name, model) {
    this.name = name;
    this.model = model;
    this.strideT = 4 + model.boneCount * 3;
    this.strideF = this.strideT * 4;
    this.data = new Float32Array(this.strideF * 32);
    this.count = 0;
    this.base = 0;
  }
  /** Reserve one instance; returns the float offset where its colours start. */
  alloc() {
    if ((this.count + 1) * this.strideF > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    return this.count++ * this.strideF;
  }
  /** Write the four colour slots (each [r,g,b]) at offset o. */
  colors(o, c0, c1, c2, c3) {
    const d = this.data;
    d[o] = c0[0]; d[o + 1] = c0[1]; d[o + 2] = c0[2]; d[o + 3] = 1;
    d[o + 4] = c1[0]; d[o + 5] = c1[1]; d[o + 6] = c1[2]; d[o + 7] = 1;
    d[o + 8] = c2[0]; d[o + 9] = c2[1]; d[o + 10] = c2[2]; d[o + 11] = 1;
    d[o + 12] = c3[0]; d[o + 13] = c3[1]; d[o + 14] = c3[2]; d[o + 15] = 1;
  }
}

/* ------------------------------------------------------------------ renderer */

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: opts.antialias !== false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.preserve });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.shadowSize = opts.shadowSize || 2048;
    this.shadowHalf = opts.shadowHalf || 34;
    this.batches = new Map();
    this.chunks = [];
    this.far = null;
    this.planes = frustumPlanes(m4());
    this.vp = m4();
    this.invVP = m4();
    this.shadowVP = m4();
    this.lightCount = 0;
    this.lightPos = new Float32Array(MAX_LIGHTS * 4);
    this.lightCol = new Float32Array(MAX_LIGHTS * 3);
    this.particles = new Float32Array(8 * 4096);
    this.partCount = 0;
    this.glows = new Float32Array(8 * 1024);
    this.glowCount = 0;
    this.decals = new Float32Array(16 * 1024);
    this.decalCount = 0;
    this.stats = { chunks: 0, tris: 0, instances: 0, drawCalls: 0 };
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.programs();
    this.buffers();
  }

  programs() {
    const gl = this.gl;
    this.pStatic = program(gl, MAIN_VS, MAIN_FS, []);
    this.pSkinned = program(gl, MAIN_VS, MAIN_FS, ['SKINNED']);
    this.pStaticDepth = program(gl, MAIN_VS, DEPTH_FS, ['DEPTH']);
    this.pSkinnedDepth = program(gl, MAIN_VS, DEPTH_FS, ['DEPTH', 'SKINNED']);
    this.pSky = program(gl, SKY_VS, SKY_FS, []);
    this.pPart = program(gl, PART_VS, PART_FS, []);
    this.pDecal = program(gl, DECAL_VS, DECAL_FS, []);
  }

  buffers() {
    const gl = this.gl;
    this.emptyVAO = gl.createVertexArray();
    // particles
    this.partVAO = gl.createVertexArray();
    gl.bindVertexArray(this.partVAO);
    this.partVB = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partVB);
    gl.bufferData(gl.ARRAY_BUFFER, this.particles.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    // decals (instanced quads)
    this.decalVAO = gl.createVertexArray();
    gl.bindVertexArray(this.decalVAO);
    this.decalVB = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.decalVB);
    gl.bufferData(gl.ARRAY_BUFFER, this.decals.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 64, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    // instance texture
    this.instTex = gl.createTexture();
    this.instRows = 0;
    this.instData = new Float32Array(INST_W * 4 * 64);
    gl.bindTexture(gl.TEXTURE_2D, this.instTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.allocInstTex(64);
    // shadow map
    this.makeShadowMap(this.shadowSize);
  }

  allocInstTex(rows) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.instTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, INST_W, rows, 0, gl.RGBA, gl.FLOAT, null);
    this.instRows = rows;
    if (this.instData.length < INST_W * 4 * rows) this.instData = new Float32Array(INST_W * 4 * rows);
  }

  makeShadowMap(size) {
    const gl = this.gl;
    if (this.shadowTex) { gl.deleteTexture(this.shadowTex); gl.deleteFramebuffer(this.shadowFB); }
    this.shadowSize = size;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* -------------------------------------------------------------- uploads */

  setTextures(atlasCanvas, noiseCanvas) {
    const gl = this.gl;
    const up = (canvas, wrap, aniso) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      if (aniso && this.anisotropy) {
        const max = gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
      }
      return t;
    };
    this.atlas = up(atlasCanvas, gl.CLAMP_TO_EDGE, true);
    this.noise = up(noiseCanvas, gl.REPEAT, true);
  }

  setCity(city) {
    const gl = this.gl;
    this.chunks = city.chunks.map((c) => Object.assign(meshVAO(gl, c.mesh), { i: c.i, j: c.j }));
    this.far = meshVAO(gl, city.far);
    this.cityTris = city.chunks.reduce((n, c) => n + c.mesh.indexCount / 3, 0);
  }

  addModel(name, model) {
    const b = new Batch(name, model);
    b.gpu = meshVAO(this.gl, model.mesh);
    this.batches.set(name, b);
    return b;
  }

  batch(name) { return this.batches.get(name); }

  /* ------------------------------------------------------------- per frame */

  beginFrame() {
    for (const b of this.batches.values()) { b.count = 0; }
    this.partCount = 0;
    this.glowCount = 0;
    this.decalCount = 0;
  }

  setCamera(view, proj, camPos) {
    m4Mul(this.vp, proj, view);
    m4Invert(this.invVP, this.vp);
    frustumPlanes(this.vp, this.planes);
    this.proj = proj;
    this.camPos = camPos;
  }

  visible(x, y, z, r) { return sphereInFrustum(this.planes, x, y, z, r); }

  setLights(list) {
    const n = Math.min(MAX_LIGHTS, list.length);
    for (let i = 0; i < n; i++) {
      const L = list[i];
      this.lightPos[i * 4] = L.x; this.lightPos[i * 4 + 1] = L.y; this.lightPos[i * 4 + 2] = L.z; this.lightPos[i * 4 + 3] = L.r;
      this.lightCol[i * 3] = L.color[0] * L.i; this.lightCol[i * 3 + 1] = L.color[1] * L.i; this.lightCol[i * 3 + 2] = L.color[2] * L.i;
    }
    this.lightCount = n;
  }

  particle(x, y, z, size, r, g, b, a, glow) {
    let arr, n;
    if (glow) { arr = this.glows; n = this.glowCount; if ((n + 1) * 8 > arr.length) return; this.glowCount++; }
    else { arr = this.particles; n = this.partCount; if ((n + 1) * 8 > arr.length) return; this.partCount++; }
    const o = n * 8;
    arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = size;
    arr[o + 4] = r; arr[o + 5] = g; arr[o + 6] = b; arr[o + 7] = a;
  }

  /** kind 0 plain colour (shadows, stains), 1 water, 2 self-lit marker. */
  decal(x, y, z, size, rot, uvRect, r, g, b, a, kind = 0, aspect = 1) {
    if ((this.decalCount + 1) * 16 > this.decals.length) return;
    const o = this.decalCount++ * 16, d = this.decals;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = Math.cos(rot); d[o + 5] = Math.sin(rot); d[o + 6] = kind; d[o + 7] = a;
    d[o + 8] = uvRect[0]; d[o + 9] = uvRect[1]; d[o + 10] = uvRect[2]; d[o + 11] = uvRect[3];
    d[o + 12] = r; d[o + 13] = g; d[o + 14] = b; d[o + 15] = aspect;
  }

  /** Light-space matrix for a sun shining along -sunDir onto the square around (fx, fz). */
  computeShadow(sunDir, fx, fz) {
    const H = this.shadowHalf;
    const up = Math.abs(sunDir[1]) > 0.97 ? [0, 0, 1] : [0, 1, 0];
    // The light's view is anchored to the world origin, so it depends on the sun
    // alone; the box then slides to the dog in whole-texel steps. Anchoring the
    // view to the dog instead keeps the focus at light-space (0,0) forever and
    // every shadow edge crawls as it walks.
    const view = m4LookAt(m4(), sunDir[0] * 150, sunDir[1] * 150, sunDir[2] * 150, 0, 0, 0, up[0], up[1], up[2]);
    const texel = (2 * H) / this.shadowSize;
    const cx = view[0] * fx + view[8] * fz + view[12];
    const cy = view[1] * fx + view[9] * fz + view[13];
    const sx = Math.round(cx / texel) * texel, sy = Math.round(cy / texel) * texel;
    const proj = m4Ortho(m4(), sx - H, sx + H, sy - H, sy + H, 20, 320);
    m4Mul(this.shadowVP, proj, view);
    this.shadowFocus = [fx, fz];
  }

  /* --------------------------------------------------------------- render */

  render(F) {
    const gl = this.gl;
    const st = this.stats;
    st.drawCalls = 0; st.tris = 0; st.chunks = 0; st.instances = 0;

    // 1. pack instance data
    let base = 0;
    for (const b of this.batches.values()) {
      b.base = base;
      base += b.count * b.strideT;
    }
    const rows = Math.max(1, Math.ceil(base / INST_W));
    if (rows > this.instRows) this.allocInstTex(Math.ceil(rows * 1.5));
    for (const b of this.batches.values()) {
      if (b.count) this.instData.set(b.data.subarray(0, b.count * b.strideF), b.base * 4);
      st.instances += b.count;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.instTex);
    if (base > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, INST_W, rows, gl.RGBA, gl.FLOAT, this.instData, 0);

    // 2. shadow pass
    const shadowOn = F.shadows && F.sunDir[1] > 0.05;
    if (shadowOn) this.shadowPass(F);

    // 3. main pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawSky(F);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);

    // static
    let P = this.pStatic;
    gl.useProgram(P.p);
    this.mainUniforms(P, F, shadowOn);
    const maxD = F.drawDistance || 160;
    for (const c of this.chunks) {
      const dx = c.cx - this.camPos[0], dz = c.cz - this.camPos[2];
      if (dx * dx + dz * dz > (maxD + c.r) * (maxD + c.r)) continue;
      if (!sphereInFrustum(this.planes, c.cx, c.cy, c.cz, c.r)) continue;
      gl.bindVertexArray(c.vao);
      gl.drawElements(gl.TRIANGLES, c.count, c.type, 0);
      st.drawCalls++; st.chunks++; st.tris += c.count / 3;
    }
    gl.bindVertexArray(this.far.vao);
    gl.drawElements(gl.TRIANGLES, this.far.count, this.far.type, 0);
    st.drawCalls++;

    // skinned instances (two-sided: cloth and flags are thin)
    P = this.pSkinned;
    gl.useProgram(P.p);
    this.mainUniforms(P, F, shadowOn);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.instTex);
    gl.uniform1i(P.u.uInst, 3);
    for (const b of this.batches.values()) {
      if (!b.count) continue;
      gl.uniform1i(P.u.uBase, b.base);
      gl.uniform1i(P.u.uStride, b.strideT);
      gl.bindVertexArray(b.gpu.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, b.gpu.count, b.gpu.type, 0, b.count);
      st.drawCalls++; st.tris += (b.gpu.count / 3) * b.count;
    }

    // 4. decals
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    if (this.decalCount) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -4);
      P = this.pDecal;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uVP, false, this.vp);
      gl.uniform3fv(P.u.uCamPos, this.camPos);
      gl.uniform3fv(P.u.uSunDir, F.sunDir);
      gl.uniform3fv(P.u.uSunCol, F.sunCol);
      gl.uniform3fv(P.u.uSkyCol, F.skyCol);
      gl.uniform3fv(P.u.uFogCol, F.fogCol);
      gl.uniform1f(P.u.uFogDen, F.fogDen);
      gl.uniform1f(P.u.uExposure, F.exposure);
      gl.uniform1f(P.u.uNightGlow, F.night || 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas);
      gl.uniform1i(P.u.uAtlas, 0);
      gl.bindVertexArray(this.decalVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.decalVB);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.decals, 0, this.decalCount * 16);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.decalCount);
      st.drawCalls++;
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    // 5. particles: soft ones blended, glows added
    if (this.partCount || this.glowCount) {
      P = this.pPart;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uVP, false, this.vp);
      gl.uniform1f(P.u.uPxScale, this.proj[5] * this.canvas.height * 0.5);
      gl.uniform3fv(P.u.uCamPos, this.camPos);
      gl.uniform1f(P.u.uFogDen, F.fogDen);
      gl.bindVertexArray(this.partVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partVB);
      if (this.partCount) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.particles, 0, this.partCount * 8);
        gl.drawArrays(gl.POINTS, 0, this.partCount);
        st.drawCalls++;
      }
      if (this.glowCount) {
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glows, 0, this.glowCount * 8);
        gl.drawArrays(gl.POINTS, 0, this.glowCount);
        st.drawCalls++;
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  mainUniforms(P, F, shadowOn) {
    const gl = this.gl;
    const u = P.u;
    gl.uniformMatrix4fv(u.uVP, false, this.vp);
    gl.uniformMatrix4fv(u.uShadowVP, false, this.shadowVP);
    gl.uniform1f(u.uTime, F.time);
    gl.uniform3fv(u.uCamPos, this.camPos);
    gl.uniform3fv(u.uSunDir, F.sunDir);
    gl.uniform3fv(u.uSunCol, F.sunCol);
    gl.uniform3fv(u.uSkyCol, F.skyCol);
    gl.uniform3fv(u.uGndCol, F.gndCol);
    gl.uniform3fv(u.uFogCol, F.fogCol);
    gl.uniform1f(u.uFogDen, F.fogDen);
    gl.uniform1f(u.uEmScale, F.emScale);
    gl.uniform3fv(u.uWinCol, F.winCol);
    gl.uniform1f(u.uShadowOn, shadowOn ? 1 : 0);
    gl.uniform1f(u.uShadowTexel, 1 / this.shadowSize);
    gl.uniform1f(u.uExposure, F.exposure);
    gl.uniform1f(u.uWet, F.wet || 0);
    gl.uniform1f(u.uSniff, F.sniff || 0);
    gl.uniform1f(u.uSat, F.sat === undefined ? 1 : F.sat);
    gl.uniform4fv(u.uLightPos, this.lightPos);
    gl.uniform3fv(u.uLightCol, this.lightCol);
    gl.uniform1i(u.uLightCount, this.lightCount);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.uniform1i(u.uAtlas, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.uniform1i(u.uNoise, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(u.uShadow, 2);
  }

  shadowPass(F) {
    const gl = this.gl;
    const st = this.stats;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFB);
    gl.viewport(0, 0, this.shadowSize, this.shadowSize);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.6, 3);
    const [fx, fz] = this.shadowFocus;
    const reach = this.shadowHalf + 30;
    let P = this.pStaticDepth;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u.uVP, false, this.shadowVP);
    gl.uniform1f(P.u.uTime, F.time);
    for (const c of this.chunks) {
      const dx = c.cx - fx, dz = c.cz - fz;
      if (Math.abs(dx) > reach + c.r || Math.abs(dz) > reach + c.r) continue;
      gl.bindVertexArray(c.vao);
      gl.drawElements(gl.TRIANGLES, c.count, c.type, 0);
      st.drawCalls++;
    }
    P = this.pSkinnedDepth;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u.uVP, false, this.shadowVP);
    gl.uniform1f(P.u.uTime, F.time);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.instTex);
    gl.uniform1i(P.u.uInst, 3);
    for (const b of this.batches.values()) {
      const n = b.count;
      if (!n) continue;
      gl.uniform1i(P.u.uBase, b.base);
      gl.uniform1i(P.u.uStride, b.strideT);
      gl.bindVertexArray(b.gpu.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, b.gpu.count, b.gpu.type, 0, n);
      st.drawCalls++;
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  drawSky(F) {
    const gl = this.gl;
    const P = this.pSky;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u.uInvVP, false, this.invVP);
    gl.uniform3fv(P.u.uCamPos, this.camPos);
    gl.uniform3fv(P.u.uSunDir, F.sunDir);
    gl.uniform3fv(P.u.uSunCol, F.sunCol);
    gl.uniform3fv(P.u.uZenith, F.zenith);
    gl.uniform3fv(P.u.uHorizon, F.horizon);
    gl.uniform3fv(P.u.uFogCol, F.fogCol);
    gl.uniform3fv(P.u.uMoonDir, F.moonDir);
    gl.uniform1f(P.u.uNight, F.night);
    gl.uniform1f(P.u.uExposure, F.exposure);
    gl.uniform1f(P.u.uCloud, F.cloud || 0);
    gl.uniform1f(P.u.uTime, F.time);
    gl.uniform1f(P.u.uSniff, F.sniff || 0);
    gl.uniform1f(P.u.uSat, F.sat === undefined ? 1 : F.sat);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
  }
}
