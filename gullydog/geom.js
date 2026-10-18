/*
 * geom.js — a small mesh builder for flat-shaded, vertex-coloured, low-poly
 * geometry. No GL here: build() returns packed buffers, so the node tests can
 * count triangles and check normals without a browser.
 *
 * VERTEX FORMAT (32 bytes, interleaved)
 *   0  pos      float32 x3
 *   12 normal   int8 x4 (normalized, w unused)
 *   16 color    uint8 x4 (normalized rgb, a = 255)
 *   20 uv       uint16 x2 (normalized) — into the texture atlas; (0,0) is white
 *   24 ext      uint8 x4: bone, colour slot, emissive, detail
 *   28 ext2     uint8 x4: sway, 0, 0, 0
 *
 * Colour slots: 0 means "use the vertex colour as is". 1..4 multiply the vertex
 * colour by one of the instance's four colours, so one mesh can be every shirt
 * in the crowd. Bones index a per-instance list of 3x4 matrices (see rig.js).
 *
 * Emissive: 1..127 glows in its own colour (signs, bulbs, tail-lights);
 * 128..255 is a window that glows with the warm night colour and is plain dark
 * glass by day. The shader splits the two ranges.
 *
 * Winding is counter-clockwise seen from outside. Every quad is given as
 * bottom-left, bottom-right, top-right, top-left as seen from outside, so a
 * texture always reads left-to-right the right way up.
 */

import { affIdentity, affMul, affFromEuler } from './util.js';

const STRIDE = 32;

export class MeshBuilder {
  constructor(capacity = 1024) {
    // Vertices are written straight into the final interleaved layout; the
    // buffers double when full. Writing JS arrays of numbers and packing at the
    // end cost ~15 M boxed doubles for the city and most of a second.
    this.cap = capacity;
    this.ab = new ArrayBuffer(capacity * STRIDE);
    this.views();
    this.icap = capacity * 2;
    this.idxBuf = new Uint32Array(this.icap);
    this.icount = 0;
    this.count = 0;
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
    this.col = [1, 1, 1];
    this.boneI = 0;
    this.slotI = 0;
    this.emI = 0;
    this.detailV = 0;
    this.swayV = 0;
    this.uvR = null;  // [u0, v0, u1, v1] for the next textured faces, or null
    this.m = affIdentity(new Float64Array(12));
    this.stack = [];
    this.tmp = new Float64Array(12);
  }

  views() {
    this.f32 = new Float32Array(this.ab);
    this.i8 = new Int8Array(this.ab);
    this.u8 = new Uint8Array(this.ab);
    this.u16 = new Uint16Array(this.ab);
  }

  growV() {
    const nab = new ArrayBuffer(this.cap * 2 * STRIDE);
    new Uint8Array(nab).set(new Uint8Array(this.ab));
    this.ab = nab;
    this.cap *= 2;
    this.views();
  }

  pushIdx(a, b, c) {
    if (this.icount + 3 > this.icap) {
      const n = new Uint32Array(this.icap * 2);
      n.set(this.idxBuf);
      this.idxBuf = n;
      this.icap *= 2;
    }
    const I = this.idxBuf;
    I[this.icount++] = a; I[this.icount++] = b; I[this.icount++] = c;
  }

  /** Number of indices so far (three per triangle). */
  get idx() { return { length: this.icount }; }

  /* ---------------------------------------------------------------- state */

  color(c, g, b) {
    if (typeof c === 'number') this.col = [c, g, b];
    else this.col = [c[0], c[1], c[2]];
    return this;
  }
  bone(i) { this.boneI = i; return this; }
  slot(i) { this.slotI = i; return this; }
  emissive(e) { this.emI = e; return this; }
  detail(d) { this.detailV = d; return this; }
  sway(s) { this.swayV = s; return this; }
  uv(r) { this.uvR = r; return this; }

  push() { this.stack.push(Float64Array.from(this.m)); return this; }
  pop() { this.m = this.stack.pop(); return this; }
  translate(x, y, z) {
    affFromEuler(this.tmp, x, y, z, 0, 0, 0, 1);
    affMul(this.m, this.m, this.tmp);
    return this;
  }
  rotate(yaw, pitch = 0, roll = 0) {
    affFromEuler(this.tmp, 0, 0, 0, yaw, pitch, roll, 1);
    affMul(this.m, this.m, this.tmp);
    return this;
  }
  scale(s) {
    affFromEuler(this.tmp, 0, 0, 0, 0, 0, 0, s);
    affMul(this.m, this.m, this.tmp);
    return this;
  }

  /* --------------------------------------------------------------- output */

  vertex(x, y, z, nx, ny, nz, u, v) {
    const m = this.m;
    const px = m[0] * x + m[1] * y + m[2] * z + m[3];
    const py = m[4] * x + m[5] * y + m[6] * z + m[7];
    const pz = m[8] * x + m[9] * y + m[10] * z + m[11];
    let qx = m[0] * nx + m[1] * ny + m[2] * nz;
    let qy = m[4] * nx + m[5] * ny + m[6] * nz;
    let qz = m[8] * nx + m[9] * ny + m[10] * nz;
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
    qx /= l; qy /= l; qz /= l;
    if (this.count >= this.cap) this.growV();
    const o = this.count * STRIDE;
    const f = o >> 2;
    this.f32[f] = px; this.f32[f + 1] = py; this.f32[f + 2] = pz;
    const i8 = this.i8, u8 = this.u8;
    i8[o + 12] = Math.round(qx * 127); i8[o + 13] = Math.round(qy * 127); i8[o + 14] = Math.round(qz * 127); i8[o + 15] = 0;
    const c = this.col;
    u8[o + 16] = c[0] <= 0 ? 0 : c[0] >= 1 ? 255 : Math.round(c[0] * 255);
    u8[o + 17] = c[1] <= 0 ? 0 : c[1] >= 1 ? 255 : Math.round(c[1] * 255);
    u8[o + 18] = c[2] <= 0 ? 0 : c[2] >= 1 ? 255 : Math.round(c[2] * 255);
    u8[o + 19] = 255;
    this.u16[(o + 20) >> 1] = u <= 0 ? 0 : u >= 1 ? 65535 : Math.round(u * 65535);
    this.u16[(o + 22) >> 1] = v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535);
    u8[o + 24] = this.boneI;
    u8[o + 25] = this.slotI;
    u8[o + 26] = this.emI < 0 ? 0 : this.emI > 255 ? 255 : Math.round(this.emI);
    u8[o + 27] = Math.round(Math.max(0, Math.min(1, this.detailV)) * 255);
    u8[o + 28] = Math.round(Math.max(0, Math.min(1, this.swayV)) * 255);
    u8[o + 29] = 0; u8[o + 30] = 0; u8[o + 31] = 0;
    const mn = this.min, mx = this.max;
    if (px < mn[0]) mn[0] = px; if (py < mn[1]) mn[1] = py; if (pz < mn[2]) mn[2] = pz;
    if (px > mx[0]) mx[0] = px; if (py > mx[1]) mx[1] = py; if (pz > mx[2]) mx[2] = pz;
    return this.count++;
  }

  /** Triangle from three local points; flat normal. */
  tri(a, b, c, uvs) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const t = uvs || [0, 0, 0, 0, 0, 0];
    const i0 = this.vertex(a[0], a[1], a[2], nx, ny, nz, t[0], t[1]);
    const i1 = this.vertex(b[0], b[1], b[2], nx, ny, nz, t[2], t[3]);
    const i2 = this.vertex(c[0], c[1], c[2], nx, ny, nz, t[4], t[5]);
    this.pushIdx(i0, i1, i2);
    return this;
  }

  /** Quad p0..p3 = bottom-left, bottom-right, top-right, top-left seen from outside. */
  quad(p0, p1, p2, p3, uvRect) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx === 0 && ny === 0 && nz === 0) {
      // degenerate first triangle; fall back to the other diagonal
      const wx = p3[0] - p0[0], wy = p3[1] - p0[1], wz = p3[2] - p0[2];
      nx = vy * wz - vz * wy; ny = vz * wx - vx * wz; nz = vx * wy - vy * wx;
    }
    const r = uvRect || this.uvR;
    let u0 = 0, v0 = 0, u1 = 0, v1 = 0;
    if (r) { u0 = r[0]; v0 = r[1]; u1 = r[2]; v1 = r[3]; }
    const a = this.vertex(p0[0], p0[1], p0[2], nx, ny, nz, u0, v1);
    const b = this.vertex(p1[0], p1[1], p1[2], nx, ny, nz, u1, v1);
    const c = this.vertex(p2[0], p2[1], p2[2], nx, ny, nz, u1, v0);
    const d = this.vertex(p3[0], p3[1], p3[2], nx, ny, nz, u0, v0);
    this.pushIdx(a, b, c);
    this.pushIdx(a, c, d);
    return this;
  }

  /**
   * Axis-aligned box from min to max corner. opts.skip is a string of faces to
   * omit ('t','b','n','s','e','w' = +Y,-Y,-Z,+Z,+X,-X). opts.uvFace maps a face
   * letter to an atlas rect; other faces are untextured.
   */
  box(x0, y0, z0, x1, y1, z1, opts) {
    const skip = (opts && opts.skip) || '';
    const uf = (opts && opts.uvFace) || null;
    const keep = this.uvR;
    this.uvR = null;
    const R = (f) => (uf && uf[f]) || null;
    if (skip.indexOf('e') < 0) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], R('e'));
    if (skip.indexOf('w') < 0) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], R('w'));
    if (skip.indexOf('t') < 0) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], R('t'));
    if (skip.indexOf('b') < 0) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], R('b'));
    if (skip.indexOf('s') < 0) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], R('s'));
    if (skip.indexOf('n') < 0) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], R('n'));
    this.uvR = keep;
    return this;
  }

  /** Box by centre and full size. */
  boxC(cx, cy, cz, sx, sy, sz, opts) {
    return this.box(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, opts);
  }

  /**
   * A box whose top face is a different size from its bottom face (both centred
   * on the same axis) — torsos, snouts, roofs of shrines.
   * b = [bw, bd] bottom width/depth, t = [tw, td] top width/depth; dz shifts the top.
   */
  taper(cx, y0, cz, bw, bd, y1, tw, td, dz = 0, opts) {
    const skip = (opts && opts.skip) || '';
    const B = [[cx - bw / 2, y0, cz - bd / 2], [cx + bw / 2, y0, cz - bd / 2], [cx + bw / 2, y0, cz + bd / 2], [cx - bw / 2, y0, cz + bd / 2]];
    const T = [[cx - tw / 2, y1, cz - td / 2 + dz], [cx + tw / 2, y1, cz - td / 2 + dz], [cx + tw / 2, y1, cz + td / 2 + dz], [cx - tw / 2, y1, cz + td / 2 + dz]];
    // B/T index: 0 = (-x,-z) 1 = (+x,-z) 2 = (+x,+z) 3 = (-x,+z)
    if (skip.indexOf('s') < 0) this.quad(B[3], B[2], T[2], T[3]);
    if (skip.indexOf('n') < 0) this.quad(B[1], B[0], T[0], T[1]);
    if (skip.indexOf('e') < 0) this.quad(B[2], B[1], T[1], T[2]);
    if (skip.indexOf('w') < 0) this.quad(B[0], B[3], T[3], T[0]);
    if (skip.indexOf('t') < 0) this.quad(T[3], T[2], T[1], T[0]);
    if (skip.indexOf('b') < 0) this.quad(B[0], B[1], B[2], B[3]);
    return this;
  }

  /**
   * Cylinder or frustum along +Y, centred on (cx, cz). Flat-shaded sides unless
   * opts.smooth. opts.caps: 'tb' (default), 't', 'b' or ''.
   */
  cyl(cx, y0, cz, r0, y1, r1, segs = 8, opts) {
    const caps = opts && opts.caps !== undefined ? opts.caps : 'tb';
    const smooth = !!(opts && opts.smooth);
    const a0 = (opts && opts.angle0) || 0;
    const P = (a, y, r) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    for (let i = 0; i < segs; i++) {
      const aa = a0 + (i / segs) * Math.PI * 2, ab = a0 + ((i + 1) / segs) * Math.PI * 2;
      if (smooth) {
        const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
        const n = (a) => [Math.cos(a), slope, Math.sin(a)];
        const na = n(aa), nb = n(ab);
        const i0 = this.vertex(...P(ab, y0, r0), ...nb, 0, 0);
        const i1 = this.vertex(...P(aa, y0, r0), ...na, 0, 0);
        const i2 = this.vertex(...P(aa, y1, r1), ...na, 0, 0);
        const i3 = this.vertex(...P(ab, y1, r1), ...nb, 0, 0);
        this.pushIdx(i0, i1, i2);
        this.pushIdx(i0, i2, i3);
      } else {
        this.quad(P(ab, y0, r0), P(aa, y0, r0), P(aa, y1, r1), P(ab, y1, r1));
      }
      if (caps.indexOf('t') >= 0 && r1 > 0) this.tri([cx, y1, cz], P(ab, y1, r1), P(aa, y1, r1));
      if (caps.indexOf('b') >= 0 && r0 > 0) this.tri([cx, y0, cz], P(aa, y0, r0), P(ab, y0, r0));
    }
    return this;
  }

  /** A cylinder lying along an arbitrary axis from a to b (wheels, pipes, wires). */
  rod(a, b, r, segs = 6, opts) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return this;
    // Build a basis that takes +Y to the rod direction.
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.acos(Math.max(-1, Math.min(1, dy / len)));
    this.push();
    this.translate(a[0], a[1], a[2]);
    this.rotate(yaw, pitch, 0);
    this.cyl(0, 0, 0, r, len, (opts && opts.r1 !== undefined) ? opts.r1 : r, segs, opts);
    this.pop();
    return this;
  }

  /** A wheel: a short smooth cylinder lying along local X, at centre c. */
  wheel(cx, cy, cz, r, w, segs = 10) {
    this.push();
    this.translate(cx, cy, cz);
    this.rotate(0, 0, Math.PI / 2);
    this.cyl(0, -w / 2, 0, r, w / 2, r, segs);
    this.pop();
    return this;
  }

  /** Low-poly sphere (an icosahedron, optionally subdivided once), flat-shaded. */
  sphere(cx, cy, cz, r, detail = 0, sy = 1) {
    const t = (1 + Math.sqrt(5)) / 2;
    let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    verts = verts.map((v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; });
    for (let d = 0; d < detail; d++) {
      const cache = new Map();
      const mid = (a, b) => {
        const k = a < b ? a * 100000 + b : b * 100000 + a;
        if (cache.has(k)) return cache.get(k);
        const p = verts[a], q = verts[b];
        const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        const l = Math.hypot(...m);
        verts.push([m[0] / l, m[1] / l, m[2] / l]);
        cache.set(k, verts.length - 1);
        return verts.length - 1;
      };
      const nf = [];
      for (const [a, b, c] of faces) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      faces = nf;
    }
    const P = (i) => [cx + verts[i][0] * r, cy + verts[i][1] * r * sy, cz + verts[i][2] * r];
    for (const [a, b, c] of faces) this.tri(P(a), P(b), P(c));
    return this;
  }

  /** A four-sided pyramid / spire: base square of half-size h at y0, apex at y1. */
  pyramid(cx, y0, cz, hx, hz, y1, ax = 0, az = 0) {
    const A = [cx + ax, y1, cz + az];
    const p = [[cx - hx, y0, cz - hz], [cx + hx, y0, cz - hz], [cx + hx, y0, cz + hz], [cx - hx, y0, cz + hz]];
    this.tri(p[3], p[2], A);
    this.tri(p[2], p[1], A);
    this.tri(p[1], p[0], A);
    this.tri(p[0], p[3], A);
    return this;
  }

  /** A sloped slab (awning, roof sheet) from edge (a0,a1) down/out to edge (b0,b1), with thickness. */
  slab(a0, a1, b1, b0, thick = 0.04) {
    this.quad(b0, b1, a1, a0);
    // underside
    const d = [0, -thick, 0];
    const add = (p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    this.quad(add(a0), add(a1), add(b1), add(b0));
    return this;
  }

  /* -------------------------------------------------------------- packing */

  get vertexCount() { return this.count; }
  get triangleCount() { return this.icount / 3; }

  /** Append another builder's geometry (already in its own final space). */
  append(other) {
    const base = this.count;
    while (this.count + other.count > this.cap) this.growV();
    new Uint8Array(this.ab, this.count * STRIDE, other.count * STRIDE).set(new Uint8Array(other.ab, 0, other.count * STRIDE));
    this.count += other.count;
    for (let i = 0; i < other.icount; i += 3) this.pushIdx(other.idxBuf[i] + base, other.idxBuf[i + 1] + base, other.idxBuf[i + 2] + base);
    for (let k = 0; k < 3; k++) { this.min[k] = Math.min(this.min[k], other.min[k]); this.max[k] = Math.max(this.max[k], other.max[k]); }
    return this;
  }

  build() {
    const n = this.count;
    const vertices = this.ab.slice(0, n * STRIDE);
    const indices = n > 65535 ? this.idxBuf.slice(0, this.icount) : Uint16Array.from(this.idxBuf.subarray(0, this.icount));
    return {
      vertices, indices, vertexCount: n, indexCount: this.icount,
      bounds: n ? [this.min[0], this.min[1], this.min[2], this.max[0], this.max[1], this.max[2]] : [0, 0, 0, 0, 0, 0],
    };
  }
}

export const VERTEX_STRIDE = STRIDE;

/** Catenary-ish sag: points along a hanging line from a to b, sagging by `sag` at the middle. */
export function hangingLine(a, b, sag, segs) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
  }
  return pts;
}
