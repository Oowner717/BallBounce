#!/usr/bin/env node
/**
 * Orbs — icon generator.
 *
 * Rasterises the app icon with plain math (no canvas, no image library) and
 * encodes it as 8-bit RGBA PNG with a hand-rolled encoder built on node:zlib
 * only. Deterministic: running it twice produces byte-identical files.
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ config */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');

/** Supersampling factor. Rendered at size*SS then box-downsampled. */
const SS = 4;

const TARGETS = [
  { file: 'icon-180.png', size: 180, maskable: false },
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

/** App palette. */
const PALETTE = {
  cyan: '#67e8f9',
  violet: '#a78bfa',
  gold: '#fbbf24',
  rose: '#fb7185',
  mint: '#6ee7b7',
};

/** Background vertical gradient (top -> bottom). */
const BG_TOP = '#05060a';
const BG_BOTTOM = '#0a0c16';

/** Faint large radial wash so the plate never reads as flat black. */
const BG_GLOW_COLOR = '#1b2444';
const BG_GLOW_CX = 0.5;
const BG_GLOW_CY = 0.42;
const BG_GLOW_R = 0.62;
const BG_GLOW_GAIN = 0.34;

/**
 * Orb falloff tuning. Each orb is an intense small core blown out to white-hot
 * by the tone map, sitting inside a wide soft halo that carries the colour.
 * The halo's inverse-square-squared profile has fat tails, so it doubles as the
 * bloom spill without needing a third term.
 */
const HALO_RATIO = 1.0; // halo radius as a multiple of the orb radius
const HALO_GAIN = 2.45;
const CORE_RATIO = 0.42; // core radius as a multiple of the orb radius
const CORE_GAIN = 6.0;
const EXPOSURE = 1.0;

/**
 * Orb cluster, in normalised canvas units (0..1). Deliberately off-centre:
 * one dominant orb, two mid, four small.
 */
const ORBS = [
  { x: 0.395, y: 0.455, r: 0.150, color: PALETTE.cyan },
  { x: 0.660, y: 0.318, r: 0.092, color: PALETTE.violet },
  { x: 0.638, y: 0.648, r: 0.080, color: PALETTE.gold },
  { x: 0.288, y: 0.722, r: 0.050, color: PALETTE.rose },
  { x: 0.788, y: 0.500, r: 0.038, color: PALETTE.mint },
  { x: 0.238, y: 0.248, r: 0.031, color: PALETTE.violet },
  { x: 0.492, y: 0.822, r: 0.025, color: PALETTE.cyan },
];

/**
 * Maskable safe zone: everything meaningful must sit inside the centred circle
 * of diameter 0.8. We shrink the cluster to this fraction of the canvas and
 * centre it; the background still runs edge to edge.
 */
const MASKABLE_CLUSTER_DIAMETER = 0.62;
/** Visual extent of an orb as a multiple of its core radius, for fitting. */
const ORB_EXTENT = 1.45;

/* ------------------------------------------------------------- small utils */

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Inverse of the tone map, so untouched background survives it unchanged. */
function untonemap(c) {
  return -Math.log(1 - Math.min(c, 0.9995)) / EXPOSURE;
}

function srgbByte(c) {
  const v = Math.round(Math.max(0, Math.min(1, c)) * 255);
  return v;
}

/* --------------------------------------------------------- layout for mask */

/** Returns the orb list transformed for the requested variant. */
function layoutOrbs(maskable) {
  if (!maskable) return ORBS;

  // Bounding circle of the cluster's meaningful content.
  let cx = 0;
  let cy = 0;
  let wsum = 0;
  for (const o of ORBS) {
    const w = o.r * o.r;
    cx += o.x * w;
    cy += o.y * w;
    wsum += w;
  }
  cx /= wsum;
  cy /= wsum;

  let maxExtent = 0;
  for (const o of ORBS) {
    const d = Math.hypot(o.x - cx, o.y - cy) + o.r * ORB_EXTENT;
    if (d > maxExtent) maxExtent = d;
  }

  const k = MASKABLE_CLUSTER_DIAMETER / (2 * maxExtent);
  return ORBS.map((o) => ({
    x: 0.5 + (o.x - cx) * k,
    y: 0.5 + (o.y - cy) * k,
    r: o.r * k,
    color: o.color,
  }));
}

/* -------------------------------------------------------------- rasteriser */

/**
 * Renders one icon and returns a tightly packed RGBA Uint8Array of
 * size*size*4 bytes, fully opaque.
 */
function renderIcon(size, maskable) {
  const hi = size * SS;
  const acc = new Float32Array(hi * hi * 3);

  const top = hexToRgb(BG_TOP).map(untonemap);
  const bot = hexToRgb(BG_BOTTOM).map(untonemap);
  const wash = hexToRgb(BG_GLOW_COLOR).map(untonemap);

  // --- background: vertical gradient + wide radial wash -------------------
  const gr = BG_GLOW_R * hi;
  const gcx = BG_GLOW_CX * hi;
  const gcy = BG_GLOW_CY * hi;
  for (let y = 0; y < hi; y++) {
    const t = hi > 1 ? y / (hi - 1) : 0;
    const r0 = top[0] + (bot[0] - top[0]) * t;
    const g0 = top[1] + (bot[1] - top[1]) * t;
    const b0 = top[2] + (bot[2] - top[2]) * t;
    for (let x = 0; x < hi; x++) {
      const dx = (x + 0.5 - gcx) / gr;
      const dy = (y + 0.5 - gcy) / gr;
      const q = 1 + dx * dx + dy * dy;
      const w = (BG_GLOW_GAIN / (q * Math.sqrt(q)));
      const i = (y * hi + x) * 3;
      acc[i] = r0 + wash[0] * w;
      acc[i + 1] = g0 + wash[1] * w;
      acc[i + 2] = b0 + wash[2] * w;
    }
  }

  // --- orbs: additive core + halo ----------------------------------------
  const orbs = layoutOrbs(maskable);
  for (const orb of orbs) {
    const [cr, cg, cb] = hexToRgb(orb.color);
    const ox = orb.x * hi;
    const oy = orb.y * hi;
    const coreR = orb.r * hi * CORE_RATIO;
    const haloR = orb.r * hi * HALO_RATIO;
    // Beyond this the halo contributes < ~1/2000 of a code value.
    const reach = haloR * 16;
    const x0 = Math.max(0, Math.floor(ox - reach));
    const x1 = Math.min(hi - 1, Math.ceil(ox + reach));
    const y0 = Math.max(0, Math.floor(oy - reach));
    const y1 = Math.min(hi - 1, Math.ceil(oy + reach));
    const coreCut = coreR * 3.2; // exp(-3.2^2) is below float noise

    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - oy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - ox;
        const d2 = dx * dx + dy * dy;

        // Wide soft halo: 1 / (1 + (d/haloR)^2)^2
        const hq = 1 + d2 / (haloR * haloR);
        let amt = HALO_GAIN / (hq * hq);

        // Intense small core: exp(-(d/coreR)^2)
        if (d2 < coreCut * coreCut) {
          amt += CORE_GAIN * Math.exp(-d2 / (coreR * coreR));
        }

        const i = (y * hi + x) * 3;
        acc[i] += cr * amt;
        acc[i + 1] += cg * amt;
        acc[i + 2] += cb * amt;
      }
    }
  }

  // --- tone map + box downsample -----------------------------------------
  const out = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let sy = 0; sy < SS; sy++) {
        const row = (y * SS + sy) * hi;
        for (let sx = 0; sx < SS; sx++) {
          const i = (row + x * SS + sx) * 3;
          sr += 1 - Math.exp(-acc[i] * EXPOSURE);
          sg += 1 - Math.exp(-acc[i + 1] * EXPOSURE);
          sb += 1 - Math.exp(-acc[i + 2] * EXPOSURE);
        }
      }
      const o = (y * size + x) * 4;
      out[o] = srgbByte(sr / n);
      out[o + 1] = srgbByte(sg / n);
      out[o + 2] = srgbByte(sb / n);
      out[o + 3] = 255; // iOS composites the touch icon on white; stay opaque
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

/** [length BE][type ascii][data][crc BE] where the CRC covers type+data. */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Encodes RGBA bytes as an 8-bit, colour type 6, non-interlaced PNG. */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, o + 1);
  }

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------- main */

mkdirSync(OUT_DIR, { recursive: true });
for (const t of TARGETS) {
  const png = encodePng(renderIcon(t.size, t.maskable), t.size, t.size);
  const path = join(OUT_DIR, t.file);
  writeFileSync(path, png);
  console.log(
    `${t.file.padEnd(24)} ${String(t.size).padStart(3)}x${String(t.size).padEnd(3)} ` +
      `${t.maskable ? 'maskable' : 'any     '} ${png.length} bytes`
  );
}
