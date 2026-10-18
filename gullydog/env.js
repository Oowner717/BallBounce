/*
 * env.js — the light of the day, as a pure function of the clock and the weather.
 *
 * environment(hours, weather) returns everything the renderer needs: sun and
 * moon directions, sky and fog colours, how bright the lamps and windows are.
 * Colours are authored in sRGB as keyframes over the day and returned in
 * LINEAR space (the shader lights in linear and tone-maps on the way out).
 *
 * The sun rises in the east (+X), crosses high in the southern sky (+Z) and
 * sets in the west. India sits in the tropics; at noon it is nearly overhead.
 */

import { hex, clamp, lerp, smoothstep } from './util.js';

const lin = (c) => [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)];

// [hour, zenith, horizon, fog, sun colour, sun strength, sky ambient, ground ambient, ambient strength, exposure]
const KEYS = [
  [0.0, '#05091a', '#141a30', '#121624', '#000000', 0.0, '#1b2540', '#0c0b0e', 0.55, 1.75],
  [4.8, '#06091a', '#161a30', '#141826', '#000000', 0.0, '#1b2540', '#0c0b0e', 0.55, 1.75],
  [5.6, '#1b2a52', '#7a5a6e', '#4d4552', '#ff8a50', 0.2, '#4d5470', '#2a2422', 0.7, 1.4],
  [6.3, '#4b6fa8', '#f3a865', '#d8a682', '#ffa060', 0.9, '#8f96b5', '#6a5040', 0.75, 1.1],
  [7.6, '#5b8fd6', '#ead4b4', '#d9cdb8', '#ffe2b8', 1.7, '#a6c0e6', '#8a7258', 0.75, 0.88],
  [12.0, '#4a85dc', '#e2dccf', '#d6d1c4', '#fff4e0', 2.1, '#aec8ec', '#9c876a', 0.72, 0.8],
  [16.3, '#5487d2', '#ecd8b4', '#ddcdb0', '#ffdca8', 1.9, '#a8bee0', '#93805e', 0.72, 0.84],
  [17.6, '#4a6fae', '#ffb067', '#e6a77a', '#ff9a4a', 1.45, '#a094b0', '#7a5a46', 0.75, 0.98],
  [18.3, '#2f467e', '#ff7e45', '#c87856', '#ff6a30', 0.7, '#7f7298', '#5a4036', 0.75, 1.2],
  [18.9, '#18234a', '#8d4c66', '#4e3a4c', '#000000', 0.0, '#3e3d64', '#1d171c', 0.7, 1.5],
  [19.8, '#070d22', '#232640', '#1b1d2c', '#000000', 0.0, '#202a48', '#0e0d11', 0.6, 1.7],
  [24.0, '#05091a', '#141a30', '#121624', '#000000', 0.0, '#1b2540', '#0c0b0e', 0.55, 1.75],
].map((k) => [k[0], hex(k[1]), hex(k[2]), hex(k[3]), hex(k[4]), k[5], hex(k[6]), hex(k[7]), k[8], k[9]]);

export const WEATHERS = {
  clear: { fog: 0.0085, cloud: 0.15, sun: 1.0, wet: 0, sat: 1.06, tint: null, rain: 0 },
  hazy: { fog: 0.0125, cloud: 0.3, sun: 0.8, wet: 0, sat: 0.96, tint: '#d8cbb4', rain: 0 },
  rain: { fog: 0.0135, cloud: 1.0, sun: 0.35, wet: 1, sat: 0.9, tint: '#9aa3ad', rain: 1 },
  holi: { fog: 0.0095, cloud: 0.2, sun: 1.0, wet: 0, sat: 1.15, tint: null, rain: 0 },
  diwali: { fog: 0.0105, cloud: 0.1, sun: 0.95, wet: 0, sat: 1.05, tint: '#e8d2b0', rain: 0 },
};

function sample(h) {
  h = ((h % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= h) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = smoothstep(0, 1, clamp((h - a[0]) / (b[0] - a[0]), 0, 1));
  const out = [];
  for (let k = 1; k < a.length; k++) {
    if (Array.isArray(a[k])) out.push([lerp(a[k][0], b[k][0], t), lerp(a[k][1], b[k][1], t), lerp(a[k][2], b[k][2], t)]);
    else out.push(lerp(a[k], b[k], t));
  }
  return out;
}

export function sunDirection(hours) {
  const t = (hours - 6.0) / 12.6;
  const th = Math.PI * t;
  const E = (68 * Math.PI) / 180;
  const x = Math.cos(th), y = Math.sin(th) * Math.sin(E), z = Math.sin(th) * Math.cos(E) * 0.6 + 0.15;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** Street lamps come on a little before dark and go off after dawn. */
export function lampLevel(hours) {
  const h = ((hours % 24) + 24) % 24;
  return Math.max(smoothstep(17.9, 18.8, h), 1 - smoothstep(5.6, 6.5, h));
}

/** Night factor: 0 in daylight, 1 in full night. */
export function nightFactor(hours) {
  const h = ((hours % 24) + 24) % 24;
  return Math.max(smoothstep(18.2, 19.4, h), 1 - smoothstep(5.2, 6.4, h));
}

export function environment(hours, weatherName = 'clear') {
  const Wt = WEATHERS[weatherName] || WEATHERS.clear;
  const [zen, hor, fog, sunC, sunS, skyA, gndA, ambS, exposure] = sample(hours);
  const night = nightFactor(hours);
  let sunDir = sunDirection(hours);
  const moonDir = [-sunDir[0] * 0.8, Math.max(0.35, -sunDir[1]), -sunDir[2] * 0.6 - 0.3];
  const ml = Math.hypot(...moonDir);
  moonDir[0] /= ml; moonDir[1] /= ml; moonDir[2] /= ml;
  const tint = Wt.tint ? hex(Wt.tint) : null;
  const tinted = (c, k) => (tint ? [lerp(c[0], c[0] * tint[0] * 1.2, k), lerp(c[1], c[1] * tint[1] * 1.2, k), lerp(c[2], c[2] * tint[2] * 1.2, k)] : c);
  const overcast = Wt.cloud > 0.8 ? 0.55 : 0;

  let sunCol = lin(sunC).map((v) => v * sunS * Wt.sun);
  let lightDir = sunDir;
  if (sunDir[1] < 0.02) {
    // moonlight takes over as the key light, dim and blue
    lightDir = moonDir;
    sunCol = [0.05, 0.065, 0.1].map((v) => v * night);
  }
  const amb = ambS * (1 - overcast * 0.2);
  const zenith = lin(tinted(zen, overcast));
  const horizon = lin(tinted(hor, overcast + 0.3));
  const fogCol = lin(tinted(fog, overcast + 0.4));
  return {
    hours,
    night,
    sunDir: lightDir,
    trueSunDir: sunDir,
    sunUp: sunDir[1] > 0.02,
    moonDir,
    sunCol,
    skyCol: lin(skyA).map((v) => v * amb * (1 + overcast * 0.35)),
    gndCol: lin(gndA).map((v) => v * amb),
    zenith,
    horizon,
    fogCol,
    fogDen: Wt.fog * (1 + night * 0.15),
    cloud: Wt.cloud,
    exposure,
    emScale: lerp(0.35, 2.4, night),
    winCol: [1.0, 0.72, 0.42].map((v) => v * 1.6 * night),
    lampLevel: lampLevel(hours),
    wet: Wt.wet,
    rain: Wt.rain,
    sat: Wt.sat,
    shadows: sunDir[1] > 0.06,
  };
}
