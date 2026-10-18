/*
 * textures.js — everything painted, painted once.
 *
 * One 2048x2048 atlas holds every shop sign, ad, number plate, the clock face,
 * rangoli and the soft decal shapes, plus a pure-white corner that untextured
 * geometry samples. The LAYOUT is pure (node can compute it, so the city mesh
 * gets its UVs in tests); PAINTING needs a canvas.
 *
 * A second small texture is tileable noise, sampled in world space for grime,
 * asphalt grain and plaster.
 *
 * Signs carry Devanagari when the device has a font for it. That is checked by
 * pixels, not assumed: drawing a Devanagari letter and a private-use codepoint
 * gives identical pixels when both fall back to the same missing-glyph box.
 */

import { SHOP_TYPES, UPPER_SIGNS, WALL_ADS } from './data.js';
import { makeRng } from './util.js';

export const ATLAS_SIZE = 2048;
const PAD = 4;

/**
 * Shelf packer, tallest first. Returns rects in pixels and in UV (inset half a
 * texel so bilinear filtering never reads a neighbour).
 */
export function atlasLayout() {
  const S = ATLAS_SIZE;
  const items = [];
  const place = (key, w, h) => items.push([key, w, h]);
  place('white', 16, 16);
  place('decal:soft', 64, 64);
  place('decal:ring', 64, 64);
  place('decal:puddle', 96, 96);
  place('decal:stain', 64, 64);
  place('decal:paw', 32, 32);
  place('decal:spark', 32, 32);
  for (let i = 0; i < 4; i++) place('rangoli:' + i, 128, 128);
  place('clock', 128, 128);
  place('truck', 256, 128);
  place('route', 256, 48);
  place('autostand', 256, 64);
  place('mandi', 256, 64);
  place('chai', 256, 64);
  place('police', 128, 48);
  for (let i = 0; i < 4; i++) place('plate:' + i, 128, 32);
  place('shutter', 64, 64);
  place('brick', 128, 128);
  place('tiles', 64, 64);
  for (const [type, T] of Object.entries(SHOP_TYPES)) {
    for (let i = 0; i < T.name.length; i++) place('sign:' + type + ':' + i, 400, 100);
  }
  for (let i = 0; i < UPPER_SIGNS.length; i++) place('upper:' + i, 336, 72);
  for (let i = 0; i < WALL_ADS.length; i++) place('ad:' + i, 256, 160);
  items.sort((a, b) => b[2] - a[2] || b[1] - a[1]);
  const px = {};
  let x = 0, y = 0, rowH = 0;
  for (const [key, w, h] of items) {
    if (x + w > S) { x = 0; y += rowH + PAD; rowH = 0; }
    if (y + h > S) throw new Error('atlas full at ' + key);
    px[key] = [x, y, w, h];
    x += w + PAD;
    rowH = Math.max(rowH, h);
  }
  const uv = {};
  for (const [k, [rx, ry, w, h]] of Object.entries(px)) {
    uv[k] = [(rx + 0.5) / S, (ry + 0.5) / S, (rx + w - 0.5) / S, (ry + h - 0.5) / S];
  }
  // the white block is sampled at a single point; keep it well inside
  uv.white = [4 / S, 4 / S, 12 / S, 12 / S];
  return { size: S, px, uv };
}

/* ------------------------------------------------------------------ painting */

function hasDevanagari(doc) {
  try {
    const c = doc.createElement('canvas');
    c.width = 48; c.height = 48;
    const g = c.getContext('2d');
    const probe = (ch) => {
      g.clearRect(0, 0, 48, 48);
      g.fillStyle = '#000';
      g.font = '36px sans-serif';
      g.fillText(ch, 4, 38);
      return g.getImageData(0, 0, 48, 48).data;
    };
    const a = probe('क'), b = probe('');
    let diff = 0, ink = 0;
    for (let i = 3; i < a.length; i += 4) { if (a[i] !== b[i]) diff++; if (a[i] > 0) ink++; }
    return ink > 20 && diff > 20;
  } catch (e) {
    return false;
  }
}

const SIGN_FONTS = ['Arial Black', 'Impact', 'Verdana', 'Trebuchet MS', 'Georgia', 'Tahoma'];
const HI_FONT = '"Noto Sans Devanagari", "Kohinoor Devanagari", "Devanagari Sangam MN", "Mangal", "Nirmala UI", sans-serif';

function fitText(g, text, font, size, maxW) {
  let s = size;
  g.font = font(s);
  while (g.measureText(text).width > maxW && s > 8) {
    s -= 1;
    g.font = font(s);
  }
  return s;
}

function paintSign(g, r, name, hi, sub, bg, fg, rng, devanagari) {
  const [x, y, w, h] = r;
  g.save();
  g.translate(x, y);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // weathering: a darker band at the bottom, a few streaks
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = fg;
  g.lineWidth = 5;
  g.strokeRect(5, 5, w - 10, h - 10);
  const fam = SIGN_FONTS[Math.floor(rng() * SIGN_FONTS.length)];
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (devanagari && hi) {
    fitText(g, hi, (s) => `bold ${s}px ${HI_FONT}`, 28, w - 64);
    g.fillText(hi, w / 2, h * 0.24);
    fitText(g, name.toUpperCase(), (q) => `bold ${q}px "${fam}", sans-serif`, 32, w - 64);
    g.fillText(name.toUpperCase(), w / 2, h * 0.56);
    fitText(g, sub, (q) => `${q}px "${fam}", sans-serif`, 14, w - 80);
    g.globalAlpha = 0.9;
    g.fillText(sub, w / 2, h * 0.84);
  } else {
    fitText(g, name.toUpperCase(), (q) => `bold ${q}px "${fam}", sans-serif`, 40, w - 64);
    g.fillText(name.toUpperCase(), w / 2, h * 0.42);
    fitText(g, sub, (q) => `${q}px "${fam}", sans-serif`, 18, w - 80);
    g.globalAlpha = 0.9;
    g.fillText(sub, w / 2, h * 0.78);
  }
  g.globalAlpha = 1;
  // a couple of little flourishes painters love: dots either side
  g.beginPath();
  g.arc(26, h / 2, 6, 0, Math.PI * 2);
  g.arc(w - 26, h / 2, 6, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function paintRangoli(g, r, seed) {
  const [x, y, w, h] = r;
  const rng = makeRng(seed);
  const cx = x + w / 2, cy = y + h / 2;
  const cols = ['#ff2d55', '#ffcc00', '#34c759', '#ff9500', '#5ac8fa', '#af52de', '#ffffff'];
  const petals = 6 + Math.floor(rng() * 6);
  for (let ring = 5; ring >= 1; ring--) {
    g.fillStyle = cols[Math.floor(rng() * cols.length)];
    const rr = (ring / 5) * (w / 2 - 4);
    for (let k = 0; k < petals; k++) {
      const a = (k / petals) * Math.PI * 2 + ring * 0.3;
      g.beginPath();
      g.ellipse(cx + Math.cos(a) * rr * 0.55, cy + Math.sin(a) * rr * 0.55, rr * 0.45, rr * 0.2, a, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx, cy, w * 0.08, 0, Math.PI * 2);
  g.fill();
}

function radial(g, r, inner, outer) {
  const [x, y, w, h] = r;
  const grad = g.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, w / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
}

export function paintAtlas(layout, doc) {
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = layout.size;
  const g = canvas.getContext('2d');
  const P = layout.px;
  const rng = makeRng(1234);
  const devanagari = hasDevanagari(doc);

  // Transparent by default (decals rely on it); opaque regions paint their own background.
  g.clearRect(0, 0, layout.size, layout.size);
  g.fillStyle = '#ffffff';
  g.fillRect(...P.white);

  // decals (white shapes; colour comes from the instance)
  radial(g, P['decal:soft'], 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
  {
    const [x, y, w] = P['decal:ring'];
    const grad = g.createRadialGradient(x + w / 2, y + w / 2, w * 0.28, x + w / 2, y + w / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,1)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, w, w);
  }
  {
    const [x, y, w] = P['decal:puddle'];
    g.save();
    g.translate(x + w / 2, y + w / 2);
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const rr = (w / 2 - 6) * (0.78 + 0.22 * Math.sin(a * 3 + 1) * Math.cos(a * 2));
      if (k === 0) g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.filter = 'blur(2px)';
    g.fill();
    g.filter = 'none';
    g.restore();
  }
  {
    const [x, y, w] = P['decal:stain'];
    for (let k = 0; k < 9; k++) {
      const a = rng() * Math.PI * 2, d = rng() * w * 0.25;
      const grad = g.createRadialGradient(x + w / 2 + Math.cos(a) * d, y + w / 2 + Math.sin(a) * d, 0, x + w / 2 + Math.cos(a) * d, y + w / 2 + Math.sin(a) * d, w * (0.12 + rng() * 0.15));
      grad.addColorStop(0, 'rgba(255,255,255,0.8)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(x, y, w, w);
    }
  }
  {
    const [x, y, w] = P['decal:paw'];
    g.fillStyle = '#fff';
    g.beginPath();
    g.ellipse(x + w / 2, y + w * 0.62, w * 0.2, w * 0.17, 0, 0, Math.PI * 2);
    for (const [dx, dy] of [[-0.24, -0.08], [-0.08, -0.22], [0.08, -0.22], [0.24, -0.08]]) {
      g.moveTo(x + w / 2 + dx * w + w * 0.07, y + w * 0.38 + dy * w);
      g.ellipse(x + w / 2 + dx * w, y + w * 0.38 + dy * w, w * 0.075, w * 0.09, 0, 0, Math.PI * 2);
    }
    g.fill();
  }
  {
    const [x, y, w] = P['decal:spark'];
    radial(g, P['decal:spark'], 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    g.fillStyle = '#fff';
    g.fillRect(x + w / 2 - 1, y + 2, 2, w - 4);
    g.fillRect(x + 2, y + w / 2 - 1, w - 4, 2);
  }
  for (let i = 0; i < 4; i++) paintRangoli(g, P['rangoli:' + i], 77 + i * 31);

  // the clock face of the Ghanta Ghar
  {
    const [x, y, w] = P.clock;
    const cx = x + w / 2, cy = y + w / 2;
    g.fillStyle = '#3a2a1a';
    g.fillRect(x, y, w, w);
    g.fillStyle = '#f7f0d8';
    g.beginPath(); g.arc(cx, cy, w * 0.44, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3a2a1a'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, w * 0.44, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#2b2118';
    g.font = 'bold 13px Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const numerals = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    numerals.forEach((n, k) => {
      const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
      g.fillText(n, cx + Math.cos(a) * w * 0.34, cy + Math.sin(a) * w * 0.34);
    });
    g.lineCap = 'round';
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + w * 0.16, cy - w * 0.1); g.stroke(); // hour hand: ~10 past 2
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + w * 0.08, cy - w * 0.28); g.stroke();
  }

  const banner = (key, bg, fg, text, font) => {
    const [x, y, w, h] = P[key];
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    g.fillStyle = fg;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    fitText(g, text, (s) => `bold ${s}px ${font || '"Arial Black", sans-serif'}`, h * 0.6, w - 16);
    g.fillText(text, x + w / 2, y + h / 2 + 1);
  };
  // HORN OK PLEASE, with the flowers truck painters put either side
  {
    const [x, y, w, h] = P.truck;
    g.fillStyle = '#f4c430'; g.fillRect(x, y, w, h);
    g.fillStyle = '#c0392b'; g.fillRect(x, y, w, 18); g.fillRect(x, y + h - 18, w, 18);
    g.fillStyle = '#1a5fb4';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 30px "Arial Black", Impact, sans-serif';
    g.fillText('HORN', x + w / 2, y + 40);
    g.font = 'bold 16px Georgia, serif';
    g.fillStyle = '#c0392b';
    g.fillText('OK', x + w / 2, y + 63);
    g.fillStyle = '#1a5fb4';
    g.font = 'bold 26px "Arial Black", Impact, sans-serif';
    g.fillText('PLEASE', x + w / 2, y + 88);
    for (const fx of [x + 26, x + w - 26]) {
      for (let k = 0; k < 6; k++) {
        g.fillStyle = ['#e91e63', '#ff9800', '#4caf50'][k % 3];
        g.beginPath(); g.arc(fx + Math.cos(k) * 10, y + 64 + Math.sin(k) * 10, 7, 0, Math.PI * 2); g.fill();
      }
    }
  }
  banner('route', '#111111', '#ffb000', '42  CHOWK - STATION', '"Courier New", monospace');
  banner('autostand', '#1e4d8c', '#ffffff', 'AUTO STAND');
  banner('mandi', '#2e7d32', '#ffffff', 'SABZI MANDI');
  banner('chai', '#5b2a86', '#ffd400', devanagari ? 'चाय  •  CHAI' : 'CHAI  •  TEA');
  banner('police', '#ffffff', '#c62828', 'POLICE');
  const plates = ['DL 3C AB 4721', 'MH 01 BZ 0912', 'UP 32 GT 5588', 'KA 05 MN 2046'];
  plates.forEach((t, i) => banner('plate:' + i, i === 1 ? '#f5d300' : '#f4f4f4', '#111111', t, '"Arial Narrow", Arial, sans-serif'));
  {
    const [x, y, w, h] = P.shutter;
    for (let k = 0; k < h; k += 4) {
      g.fillStyle = k % 8 === 0 ? '#9a9d9f' : '#7d8083';
      g.fillRect(x, y + k, w, 4);
    }
  }
  {
    const [x, y, w, h] = P.brick;
    g.fillStyle = '#b8b0a2'; g.fillRect(x, y, w, h);
    for (let row = 0; row < 16; row++) {
      for (let col = -1; col < 6; col++) {
        const bx = x + col * 24 + (row % 2) * 12, by = y + row * 8;
        g.fillStyle = `hsl(${12 + rng() * 10}, ${45 + rng() * 15}%, ${36 + rng() * 10}%)`;
        g.fillRect(Math.max(x, bx + 1), by + 1, Math.min(22, x + w - bx - 1), 6);
      }
    }
  }
  {
    const [x, y, w, h] = P.tiles;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        g.fillStyle = (i + j) % 2 ? '#d7d0c0' : '#c4b9a4';
        g.fillRect(x + i * 16, y + j * 16, 16, 16);
      }
    }
  }
  for (const [type, T] of Object.entries(SHOP_TYPES)) {
    for (let i = 0; i < T.name.length; i++) {
      const [bg, fg] = T.signs[i % T.signs.length];
      paintSign(g, P['sign:' + type + ':' + i], T.name[i], T.hi[i], T.sub[i % T.sub.length], bg, fg, rng, devanagari);
    }
  }
  UPPER_SIGNS.forEach(([en, hi, bg, fg], i) => {
    const [x, y, w, h] = P['upper:' + i];
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.strokeStyle = fg; g.lineWidth = 3; g.strokeRect(x + 4, y + 4, w - 8, h - 8);
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (devanagari) {
      fitText(g, hi, (s) => `bold ${s}px ${HI_FONT}`, 22, w - 30);
      g.fillText(hi, x + w / 2, y + h * 0.32);
      fitText(g, en, (s) => `bold ${s}px Verdana, sans-serif`, 20, w - 30);
      g.fillText(en, x + w / 2, y + h * 0.72);
    } else {
      fitText(g, en, (s) => `bold ${s}px Verdana, sans-serif`, 30, w - 30);
      g.fillText(en, x + w / 2, y + h / 2);
    }
  });
  WALL_ADS.forEach(([l1, l2, bg, fg], i) => {
    const [x, y, w, h] = P['ad:' + i];
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.globalAlpha = 0.18; g.fillStyle = '#000';
    for (let k = 0; k < 30; k++) g.fillRect(x + rng() * w, y + rng() * h, 2 + rng() * 10, 1 + rng() * 3);
    g.globalAlpha = 1;
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    fitText(g, l1, (s) => `bold ${s}px Impact, "Arial Black", sans-serif`, 46, w - 20);
    g.fillText(l1, x + w / 2, y + h * 0.4);
    fitText(g, l2, (s) => `bold ${s}px Verdana, sans-serif`, 18, w - 20);
    g.fillText(l2, x + w / 2, y + h * 0.75);
  });
  return { canvas, devanagari };
}

/** Tileable value noise: R fine, G coarse, B speckle. 256x256. */
export function paintNoise(doc) {
  const N = 256;
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = N;
  const g = canvas.getContext('2d');
  const img = g.createImageData(N, N);
  const rng = makeRng(99);
  const lattice = (cells) => {
    const v = new Float32Array(cells * cells);
    for (let i = 0; i < v.length; i++) v[i] = rng();
    return (x, y) => {
      const fx = (x / N) * cells, fy = (y / N) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i, j) => v[((j % cells + cells) % cells) * cells + ((i % cells + cells) % cells)];
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  };
  const o1 = lattice(32), o2 = lattice(64), o3 = lattice(128), c1 = lattice(4), c2 = lattice(8), c3 = lattice(16);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fine = o1(x, y) * 0.5 + o2(x, y) * 0.3 + o3(x, y) * 0.2;
      const coarse = c1(x, y) * 0.5 + c2(x, y) * 0.3 + c3(x, y) * 0.2;
      const speck = rng() < 0.04 ? 0 : rng() < 0.08 ? 1 : 0.5;
      const i = (y * N + x) * 4;
      img.data[i] = Math.round(fine * 255);
      img.data[i + 1] = Math.round(coarse * 255);
      img.data[i + 2] = Math.round(speck * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
