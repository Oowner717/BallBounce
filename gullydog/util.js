/*
 * util.js — small shared helpers: a seeded PRNG, scalar math, colours, and the two
 * matrix flavours the game uses.
 *
 *   mat4  : column-major Float32Array(16), the layout WebGL wants for uniforms.
 *   aff   : row-major 3x4 affine (12 numbers). Row i is [m_i0 m_i1 m_i2 t_i], so a
 *           point transforms as x'_i = dot(row_i, [x y z 1]). That is exactly the
 *           layout the vertex shader reads back out of the bone texture, three
 *           RGBA texels per bone, with no transposition on either side.
 *
 * No DOM here — this file is imported by the node tests.
 */

/* ------------------------------------------------------------------ random */

/**
 * mulberry32. Small, fast, and good enough for gameplay. The state is a single
 * 32-bit integer, exposed so the sim can be hashed and snapshotted.
 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const rng = function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => a >>> 0;
  rng.setState = (s) => { a = s | 0; };
  return rng;
}

/** Deterministic hash of an integer to [0,1). For per-entity variation without an rng. */
export function hash01(n) {
  let t = (n | 0) + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const rand = (rng, a, b) => a + (b - a) * rng();
export const randInt = (rng, a, b) => a + Math.floor((b - a + 1) * rng()); // inclusive
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
export const chance = (rng, p) => rng() < p;

/** Pick from [[weight, value], ...]. */
export function pickWeighted(rng, table) {
  let total = 0;
  for (const row of table) total += row[0];
  let r = rng() * total;
  for (const row of table) {
    r -= row[0];
    if (r <= 0) return row[1];
  }
  return table[table.length - 1][1];
}

/* -------------------------------------------------------------- scalar math */

export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Signed shortest difference b - a. */
export const angleDiff = (a, b) => wrapAngle(b - a);

/** Move v toward target by at most maxDelta. */
export function approach(v, target, maxDelta) {
  if (v < target) return Math.min(v + maxDelta, target);
  return Math.max(v - maxDelta, target);
}

/** Rotate angle a toward target by at most maxDelta, the short way round. */
export function approachAngle(a, target, maxDelta) {
  const d = angleDiff(a, target);
  if (Math.abs(d) <= maxDelta) return target;
  return wrapAngle(a + Math.sign(d) * maxDelta);
}

/** Frame-rate independent exponential smoothing factor for a rate in 1/s. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export const dist2 = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));

/** Heading convention: yaw 0 faces +Z, yaw PI/2 faces +X. */
export const yawOf = (dx, dz) => Math.atan2(dx, dz);

/** Squared distance from point p to segment ab, in the XZ plane. */
export function segDist2(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = clamp01(t);
  const qx = ax + abx * t, qz = az + abz * t;
  return (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
}

/* ------------------------------------------------------------------ colour */

/** '#rrggbb' -> [r,g,b] in 0..1 (sRGB, as authored). */
export function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const scaleRgb = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

export function hsl(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Jitter a colour a little — weathered paint never matches exactly. */
export function jitterRgb(rng, c, amt) {
  const k = 1 + (rng() - 0.5) * amt;
  return [clamp01(c[0] * k + (rng() - 0.5) * amt * 0.3), clamp01(c[1] * k + (rng() - 0.5) * amt * 0.3), clamp01(c[2] * k + (rng() - 0.5) * amt * 0.3)];
}

/* --------------------------------------------------------- affine 3x4 math */

export function affIdentity(o) {
  o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
  o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
  o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
  return o;
}

/** o = a * b. Safe when o aliases a or b. */
export function affMul(o, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const b00 = b[0], b01 = b[1], b02 = b[2], b03 = b[3];
  const b10 = b[4], b11 = b[5], b12 = b[6], b13 = b[7];
  const b20 = b[8], b21 = b[9], b22 = b[10], b23 = b[11];
  o[0] = a00 * b00 + a01 * b10 + a02 * b20;
  o[1] = a00 * b01 + a01 * b11 + a02 * b21;
  o[2] = a00 * b02 + a01 * b12 + a02 * b22;
  o[3] = a00 * b03 + a01 * b13 + a02 * b23 + a03;
  o[4] = a10 * b00 + a11 * b10 + a12 * b20;
  o[5] = a10 * b01 + a11 * b11 + a12 * b21;
  o[6] = a10 * b02 + a11 * b12 + a12 * b22;
  o[7] = a10 * b03 + a11 * b13 + a12 * b23 + a13;
  o[8] = a20 * b00 + a21 * b10 + a22 * b20;
  o[9] = a20 * b01 + a21 * b11 + a22 * b21;
  o[10] = a20 * b02 + a21 * b12 + a22 * b22;
  o[11] = a20 * b03 + a21 * b13 + a22 * b23 + a23;
  return o;
}

/**
 * Rotation R = Ry(yaw) * Rx(pitch) * Rz(roll), uniform scale s, then translation.
 * By the right-hand rule a positive rotation about +X takes +Y toward +Z, so a
 * positive pitch swings a limb hanging along -Y BACKWARD (toward -Z, since models
 * face +Z) and a negative pitch swings it forward. Rigs rely on this sign.
 */
export function affFromEuler(o, tx, ty, tz, yaw, pitch, roll, s = 1) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  // Ry * Rx * Rz
  o[0] = (cy * cz + sy * sx * sz) * s;
  o[1] = (-cy * sz + sy * sx * cz) * s;
  o[2] = (sy * cx) * s;
  o[3] = tx;
  o[4] = (cx * sz) * s;
  o[5] = (cx * cz) * s;
  o[6] = (-sx) * s;
  o[7] = ty;
  o[8] = (-sy * cz + cy * sx * sz) * s;
  o[9] = (sy * sz + cy * sx * cz) * s;
  o[10] = (cy * cx) * s;
  o[11] = tz;
  return o;
}

/** Rotation about a pivot: T(p) * R(yaw,pitch,roll) * T(-p). */
export function affPivot(o, px, py, pz, yaw, pitch, roll) {
  affFromEuler(o, 0, 0, 0, yaw, pitch, roll, 1);
  o[3] = px - (o[0] * px + o[1] * py + o[2] * pz);
  o[7] = py - (o[4] * px + o[5] * py + o[6] * pz);
  o[11] = pz - (o[8] * px + o[9] * py + o[10] * pz);
  return o;
}

/** Transform a point; writes into out[0..2]. */
export function affPoint(out, a, x, y, z) {
  out[0] = a[0] * x + a[1] * y + a[2] * z + a[3];
  out[1] = a[4] * x + a[5] * y + a[6] * z + a[7];
  out[2] = a[8] * x + a[9] * y + a[10] * z + a[11];
  return out;
}

/* -------------------------------------------------------------- mat4 (GL) */

export function m4() {
  const o = new Float32Array(16);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}

export function m4Mul(o, a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let rI = 0; rI < 4; rI++) {
      r[c * 4 + rI] =
        a[rI] * b[c * 4] + a[4 + rI] * b[c * 4 + 1] + a[8 + rI] * b[c * 4 + 2] + a[12 + rI] * b[c * 4 + 3];
    }
  }
  o.set(r);
  return o;
}

export function m4Perspective(o, fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  o.fill(0);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}

export function m4Ortho(o, l, r, b, t, n, f) {
  o.fill(0);
  o[0] = 2 / (r - l);
  o[5] = 2 / (t - b);
  o[10] = -2 / (f - n);
  o[12] = -(r + l) / (r - l);
  o[13] = -(t + b) / (t - b);
  o[14] = -(f + n) / (f - n);
  o[15] = 1;
  return o;
}

export function m4LookAt(o, ex, ey, ez, tx, ty, tz, ux = 0, uy = 1, uz = 0) {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * ex + xy * ey + xz * ez);
  o[13] = -(yx * ex + yy * ey + yz * ez);
  o[14] = -(zx * ex + zy * ey + zz * ez);
  o[15] = 1;
  return o;
}

export function m4Invert(o, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

/** Transform a point by a column-major mat4 with perspective divide. Returns [x,y,z,w]. */
export function m4Project(m, x, y, z) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [cx, cy, cz, cw];
}

/**
 * Six frustum planes from a view-projection matrix, as [a,b,c,d] with the normal
 * pointing inward. A sphere is outside if dot(n,p)+d < -r for any plane.
 */
export function frustumPlanes(m, out) {
  const p = out || [new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4)];
  const set = (i, a, b, c, d) => {
    const l = Math.hypot(a, b, c) || 1;
    p[i][0] = a / l; p[i][1] = b / l; p[i][2] = c / l; p[i][3] = d / l;
  };
  set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
  set(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
  set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
  set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);
  set(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);
  set(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);
  return p;
}

export function sphereInFrustum(planes, x, y, z, r) {
  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
  }
  return true;
}
