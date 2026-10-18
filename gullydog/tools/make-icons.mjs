#!/usr/bin/env node
/**
 * Gully Dog — icon generator.
 *
 * Rasterises the app icon (Bhura's face on a saffron sun) with plain math and
 * encodes it as RGBA PNG with a hand-rolled encoder on node:zlib. Same approach
 * as orbs/tools/make-icons.mjs: no canvas, no image library, deterministic, so
 * running it twice produces byte-identical files.
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');
const SS = 4; // supersampling per axis

const TARGETS = [
  { file: 'icon-180.png', size: 180, maskable: false },
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  bgTop: hex('#ffb33d'), bgBot: hex('#e8590c'), sun: hex('#ffd76a'),
  coat: hex('#b8763c'), coatDark: hex('#7a4521'), cream: hex('#f1dcb8'),
  ink: hex('#1f1712'), white: hex('#ffffff'), collar: hex('#c0392b'), bell: hex('#f2c94c'), tongue: hex('#e07a8a'),
};

/* ------------------------------------------------------------- shapes */
// All shape tests take normalised coordinates (0..1 across the icon).
const ellipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
function tri(x, y, ax, ay, bx, by, cx, cy) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Colour of the icon at normalised (u, v), with the face scaled by k about the centre. */
function shade(u, v, k) {
  // background: vertical warm gradient with a soft sun disc
  const t = v;
  let col = [0, 1, 2].map((i) => C.bgTop[i] + (C.bgBot[i] - C.bgTop[i]) * t);
  const sd = Math.hypot(u - 0.5, v - 0.47);
  if (sd < 0.36) {
    const a = Math.min(1, (0.36 - sd) * 30) * 0.55;
    col = col.map((c, i) => c + (C.sun[i] - c) * a);
  }
  // map into face space
  const x = 0.5 + (u - 0.5) / k, y = 0.52 + (v - 0.52) / k;
  let face = null;
  // ears: tall Indie triangles, darker inside
  if (tri(x, y, 0.2, 0.44, 0.27, 0.08, 0.42, 0.33) || tri(x, y, 0.8, 0.44, 0.73, 0.08, 0.58, 0.33)) face = C.coat;
  if (tri(x, y, 0.25, 0.38, 0.285, 0.16, 0.38, 0.33) || tri(x, y, 0.75, 0.38, 0.715, 0.16, 0.62, 0.33)) face = C.coatDark;
  // head
  if (ellipse(x, y, 0.5, 0.5, 0.29, 0.27)) face = C.coat;
  // cream blaze and muzzle
  if (ellipse(x, y, 0.5, 0.64, 0.17, 0.13) || tri(x, y, 0.46, 0.36, 0.54, 0.36, 0.5, 0.58)) face = C.cream;
  // collar and bell
  if (y > 0.74 && y < 0.8 && ellipse(x, y, 0.5, 0.7, 0.26, 0.12)) face = C.collar;
  if (circle(x, y, 0.5, 0.815, 0.035)) face = C.bell;
  // eyes with a glint
  for (const ex of [0.39, 0.61]) {
    if (circle(x, y, ex, 0.47, 0.036)) face = C.ink;
    if (circle(x, y, ex + 0.012, 0.458, 0.011)) face = C.white;
  }
  // nose and mouth
  if (ellipse(x, y, 0.5, 0.585, 0.055, 0.038)) face = C.ink;
  if (ellipse(x, y, 0.5, 0.675, 0.035, 0.03) && y > 0.672) face = C.tongue;
  return face || col;
}

function renderIcon(size, maskable) {
  const k = maskable ? 0.78 : 1.0; // keep the face inside the maskable safe circle
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size, v = (py + (sy + 0.5) / SS) / size;
          const c = shade(u, v, k);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS, o = (py * size + px) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------ PNG encoding */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const t of TARGETS) {
  const png = encodePng(renderIcon(t.size, t.maskable), t.size, t.size);
  writeFileSync(join(OUT_DIR, t.file), png);
  console.log(`${t.file.padEnd(24)} ${String(t.size).padStart(3)}x${String(t.size).padEnd(3)} ${t.maskable ? 'maskable' : 'any     '} ${png.length} bytes`);
}
