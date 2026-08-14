/*
 * main.js — everything that is not physics: rendering, input, effects, persistence,
 * service-worker glue, and the resilience layer that keeps this thing alive on a phone
 * that never gets a debugger attached.
 *
 * Visual randomness is free here (unlike sim.js). Nothing in this file may feed back into
 * the simulation except through step()'s input argument.
 *
 * RENDERING NOTES that are easy to get wrong and painful to rediscover:
 *   - Trails are faded with 'destination-out' on an OFFSCREEN layer which is then
 *     composited over the background. Painting a translucent black rect over a dark scene
 *     instead leaves permanent grey ghosting.
 *   - Bloom is a ~quarter-res offscreen canvas drawn back upscaled with 'lighter'. The
 *     resample IS the blur. ctx.filter is not reliable on iOS.
 *   - The sim runs in CSS pixels; only the canvas backing store is scaled by devicePixelRatio
 *     (capped at 2). Every force and radius is scaled from a reference dimension inside
 *     sim.js, so an iPhone SE and an iPad feel identical.
 */

/* ========================================================================== */
/* Error capture — installed before anything else can throw                   */
/* ========================================================================== */

const errorBuffer = [];
let errorSeq = 0;

function logError(kind, msg) {
  try {
    const text = String(msg == null ? '(no message)' : msg).slice(0, 160);
    const last = errorBuffer[errorBuffer.length - 1];
    if (last && last.kind === kind && last.msg === text) { last.count++; return; }
    errorBuffer.push({ n: ++errorSeq, kind, msg: text, count: 1 });
    let cap = 12;
    try { cap = CONFIG.debug.errorBufferSize || 12; } catch (_) {}
    while (errorBuffer.length > cap) errorBuffer.shift();
  } catch (_) { /* logging must never be the thing that breaks */ }
}

try {
  window.addEventListener('error', (e) => {
    const where = e && e.filename ? String(e.filename).split('/').pop() + ':' + e.lineno : '';
    logError('err', (e && e.message ? e.message : 'script error') + (where ? ' @' + where : ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    logError('rej', r && r.message ? r.message : String(r));
  });
} catch (_) {}

import { CONFIG } from './config.js';
import {
  createSim, step as simStep, resize as simResize, scatter as simScatter,
  makeRng, loadSave, serializeSave, defaultSave, applySave, deriveStars, filigreeTier,
  palettesUnlockedAt,
} from './sim.js';

/* ========================================================================== */
/* Query flags                                                                */
/* ========================================================================== */

const params = (() => {
  try { return new URLSearchParams(location.search); } catch (_) { return new URLSearchParams(''); }
})();
const SOAK = params.get('soak') === '1';
const FORCE_DEBUG = params.get('debug') === '1';

/* ========================================================================== */
/* Storage — never throws, degrades to "no persistence" in private mode       */
/* ========================================================================== */

const store = {
  available: true,
  get(key) {
    try { return window.localStorage.getItem(key); }
    catch (e) { store.available = false; logError('store', 'read: ' + e.message); return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); return true; }
    catch (e) { store.available = false; logError('store', 'write: ' + e.message); return false; }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); return true; }
    catch (e) { store.available = false; logError('store', 'remove: ' + e.message); return false; }
  },
};

function readSave() {
  const raw = store.get(CONFIG.save.key);
  if (raw == null) return defaultSave(CONFIG);
  return loadSave(raw, CONFIG);
}

let saveTimer = 0;
function writeSave(force) {
  try {
    const payload = serializeSave(sim);
    payload.seenHint = seenHint;
    store.set(CONFIG.save.key, JSON.stringify(payload));
    saveTimer = 0;
  } catch (e) {
    logError('save', e.message);
  }
  if (force) saveTimer = 0;
}

/**
 * Erase everything. Deleting the key alone is not enough: the very next autosave (or the
 * pagehide flush on reload) writes the live state straight back and the wipe silently
 * un-happens. The running session has to be reset too.
 */
function wipeSave() {
  store.remove(CONFIG.save.key);
  try {
    applySave(sim, defaultSave(CONFIG));
    seenHint = false;
    hintFade = 0;
    displayScore = 0;
    sky = deriveStars(defaultSave(CONFIG), CONFIG);
    skyDirty = true;
    palette.cur = null;
    palette.from = palette.to = 0;
    palette.t = 0;
    softResetEffects();
    saveTimer = 0;
  } catch (e) {
    logError('save', 'wipe: ' + e.message);
  }
}

/* ========================================================================== */
/* Colour                                                                     */
/* ========================================================================== */

function hexToRgb(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const v = parseInt(h.length === 3
    ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    : h.slice(0, 6), 16);
  if (!Number.isFinite(v)) return [255, 255, 255];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Blend two hex colours and quantise, so the sprite cache does not thrash while drifting. */
function mixHex(a, b, t, q) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const step = q || 6;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = A[i] + (B[i] - A[i]) * t;
    out[i] = Math.max(0, Math.min(255, Math.round(v / step) * step));
  }
  return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
}

/* -- the active palette: blended between two unlocked colour worlds --------- */

const palette = {
  from: 0, to: 0, t: 0, hold: CONFIG.paletteRules.driftHold, cur: null, key: '',
};

function blendPalettes(A, B, t) {
  const out = {
    name: t < 0.5 ? A.name : B.name,
    bg0: mixHex(A.bg0, B.bg0, t), bg1: mixHex(A.bg1, B.bg1, t),
    fog: mixHex(A.fog, B.fog, t), hud: mixHex(A.hud, B.hud, t),
    hudDim: mixHex(A.hudDim, B.hudDim, t), ring: mixHex(A.ring, B.ring, t),
    star: mixHex(A.star, B.star, t),
    orbHues: [], type: {},
  };
  const n = Math.max(A.orbHues.length, B.orbHues.length);
  for (let i = 0; i < n; i++) {
    out.orbHues.push(mixHex(A.orbHues[i % A.orbHues.length], B.orbHues[i % B.orbHues.length], t));
  }
  for (const k of CONFIG.unlockOrder) out.type[k] = mixHex(A.type[k], B.type[k], t);
  return out;
}

function updatePalette(dt) {
  const R = CONFIG.paletteRules;
  const unlocked = palettesUnlockedAt(sim.level, CONFIG);
  if (palette.cur === null) {
    palette.from = Math.min(sim.paletteIndex, unlocked - 1);
    palette.to = palette.from;
    palette.t = 0;
  }
  const driftAllowed = !CONFIG.paletteRules.driftOnlyWhenCalm || sim.mode === 'CALM';
  if (unlocked > 1 && driftAllowed) {
    if (palette.hold > 0) {
      palette.hold -= dt;
    } else if (palette.t < 1) {
      palette.t += dt / Math.max(1e-6, R.driftPeriod);
      if (palette.t >= 1) {
        palette.t = 1;
        palette.from = palette.to;
        palette.hold = R.driftHold;
        palette.t = 0;
        palette.to = (palette.from + 1) % unlocked;
        sim.paletteIndex = palette.from;
      }
    }
  } else {
    palette.from = palette.to = 0;
    palette.t = 0;
  }
  const A = CONFIG.palettes[Math.min(palette.from, CONFIG.palettes.length - 1)];
  const B = CONFIG.palettes[Math.min(palette.to, CONFIG.palettes.length - 1)];
  const key = palette.from + ':' + palette.to + ':' + Math.round(palette.t * 40);
  if (key !== palette.key) {
    palette.key = key;
    palette.cur = blendPalettes(A, B, palette.t);
  }
  return palette.cur;
}

/* ========================================================================== */
/* Glow sprite cache                                                          */
/* ========================================================================== */

const SPRITE_SIZE = 128;
const spriteCache = new Map();

function glowSprite(hex) {
  let s = spriteCache.get(hex);
  if (s) return s;
  if (spriteCache.size > 220) spriteCache.clear();   // palette drift churns keys slowly
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_SIZE;
  const g = c.getContext('2d');
  const half = SPRITE_SIZE / 2;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  // Colour-dominant, not white-dominant: the bloom pass is what creates white-hot cores
  // where orbs overlap. Baking white into the sprite as well destroys the palette.
  grad.addColorStop(0.00, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.05, rgba(hex, 0.90));
  grad.addColorStop(0.20, rgba(hex, 0.42));
  grad.addColorStop(0.46, rgba(hex, 0.13));
  grad.addColorStop(1.00, rgba(hex, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  spriteCache.set(hex, c);
  return c;
}

/* ========================================================================== */
/* Canvas layers                                                              */
/* ========================================================================== */

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { alpha: false });

const trail = document.createElement('canvas');
const trailCtx = trail.getContext('2d');
const bloomA = document.createElement('canvas');
const bloomACtx = bloomA.getContext('2d');
const bloomB = document.createElement('canvas');
const bloomBCtx = bloomB.getContext('2d');

let cssW = 1, cssH = 1, dpr = 1;
let bloomScale = CONFIG.render.bloomScale;
const safe = { t: 0, r: 0, b: 0, l: 0 };

function readSafeArea() {
  try {
    const cs = getComputedStyle(document.documentElement);
    safe.t = parseFloat(cs.getPropertyValue('--safe-t')) || 0;
    safe.r = parseFloat(cs.getPropertyValue('--safe-r')) || 0;
    safe.b = parseFloat(cs.getPropertyValue('--safe-b')) || 0;
    safe.l = parseFloat(cs.getPropertyValue('--safe-l')) || 0;
  } catch (_) { safe.t = safe.r = safe.b = safe.l = 0; }
}

function measure() {
  let w = 0, h = 0;
  try {
    const rect = canvas.getBoundingClientRect();
    w = rect.width; h = rect.height;
  } catch (_) {}
  if (!(w > 0)) w = window.innerWidth || 390;
  if (!(h > 0)) h = window.innerHeight || 844;
  return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
}

function resizeLayers() {
  const [w, h] = measure();
  dpr = Math.max(1, Math.min(CONFIG.render.dprCap, window.devicePixelRatio || 1));
  cssW = w; cssH = h;
  readSafeArea();

  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  trail.width = canvas.width;
  trail.height = canvas.height;
  trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  rebuildBloom();

  if (sim) simResize(sim, cssW, cssH);
  skyDirty = true;
}

function rebuildBloom() {
  const bw = Math.max(2, Math.round(canvas.width * bloomScale));
  const bh = Math.max(2, Math.round(canvas.height * bloomScale));
  bloomA.width = bw; bloomA.height = bh;
  bloomB.width = Math.max(2, Math.round(bw * 0.5));
  bloomB.height = Math.max(2, Math.round(bh * 0.5));
}

/* ========================================================================== */
/* Sim                                                                        */
/* ========================================================================== */

const seedParam = parseInt(params.get('seed') || '', 10);
const seed = Number.isFinite(seedParam) ? seedParam : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);

let savedState = readSave();
let seenHint = savedState.seenHint === true;

const [iw, ih] = measure();
const sim = createSim({
  config: CONFIG,
  rng: makeRng(seed),
  width: iw, height: ih,
  save: savedState,
});

let sky = deriveStars(savedState, CONFIG);
let skyDirty = true;

resizeLayers();

/* ========================================================================== */
/* Effects layer                                                              */
/* ========================================================================== */

let particles = [];
let popups = [];
let waves = [];
let arcs = [];
let flash = 0;
let flashMax = 0;
let shake = 0;
let celebration = null;    // { text, sub, t, life, big }
let particleBudget = CONFIG.effects.maxParticles;

function softResetEffects() {
  particles.length = 0;
  popups.length = 0;
  waves.length = 0;
  arcs.length = 0;
  flash = 0; shake = 0;
  celebration = null;
  try {
    trailCtx.setTransform(1, 0, 0, 1, 0, 0);
    trailCtx.clearRect(0, 0, trail.width, trail.height);
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } catch (_) {}
  logError('reset', 'effects layer soft-reset');
}

function spawnParticles(x, y, count, speed, color, life, size) {
  const room = particleBudget - particles.length;
  if (room <= 0) return;
  const n = Math.min(count, room);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = speed * (0.35 + Math.random() * 0.85);
    particles.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      t: 0, life: life * (0.7 + Math.random() * 0.6),
      size: size * (0.6 + Math.random() * 0.8),
      color,
    });
  }
}

function addPopup(x, y, text, color, big) {
  if (popups.length > 40) popups.shift();
  // Merge popups landing on nearly the same spot in the same instant.
  for (const p of popups) {
    if (p.t < CONFIG.score.popupMerge && Math.abs(p.x - x) < 22 && Math.abs(p.y - y) < 22) {
      p.merged = (p.merged || 1) + 1;
      p.size = Math.min(p.size * 1.06, 34);
      return;
    }
  }
  popups.push({ x, y, text, color, t: 0, life: CONFIG.effects.popupLife, size: big ? 21 : 15 });
}

function addWave(x, y, r, strength, color) {
  if (waves.length > 28) waves.shift();
  waves.push({ x, y, r0: r * 0.18, r1: r, t: 0, life: CONFIG.effects.shockwaveTime, strength, color });
}

function addArc(x1, y1, x2, y2, color, depth) {
  if (arcs.length > 60) arcs.shift();
  arcs.push({
    x1, y1, x2, y2, t: 0, life: CONFIG.types.CHAIN.arcTime, color,
    delay: (depth || 0) * CONFIG.types.CHAIN.hopDelay,
    seed: Math.random() * 1000,
  });
}

function addFlash(amount) {
  flashMax = Math.max(flashMax, Math.min(CONFIG.effects.flashMaxAlpha, amount));
  flash = CONFIG.effects.flashTime;
}

function addShake(amount) {
  shake = Math.min(CONFIG.effects.shakeMax * scale(), shake + amount);
}

function scale() { return sim.scale; }

/* ---- translate sim events into visuals ----------------------------------- */

function consumeEvents(P) {
  const inten = sim.intensity;
  const loud = inten > CONFIG.intensity.frenzyAbove;
  for (const ev of sim.events) {
    switch (ev.type) {
      case 'impact': {
        const n = Math.round(CONFIG.effects.impactSparks * (0.4 + Math.min(2.2, ev.speed)) * qualityMul());
        spawnParticles(ev.x, ev.y, n, 120 * scale() * Math.min(3, ev.speed), P.fog, 0.42, 1.7 * scale());
        if (ev.speed > 2.2) addShake(1.1 * scale() * Math.min(2.5, ev.speed - 1.5));
        break;
      }
      case 'score':
        addPopup(ev.x, ev.y, formatScore(ev.amount), ev.amount > 900 ? P.ring : P.hud, ev.amount > 900);
        break;
      case 'detonate':
        spawnParticles(ev.x, ev.y, Math.round(CONFIG.effects.detonateSparks * qualityMul()),
          520 * scale(), ev.nova ? P.type.FROST : P.type.VOLATILE, 0.7, 2.3 * scale());
        addFlash(ev.nova ? 0.16 : 0.10);
        addShake(4.5 * scale());
        break;
      case 'shockwave':
        addWave(ev.x, ev.y, ev.r, ev.strength, P.type.VOLATILE);
        break;
      case 'split':
        spawnParticles(ev.x, ev.y, Math.round(8 * qualityMul()), 200 * scale(), P.type.SPLITTER, 0.4, 1.6 * scale());
        break;
      case 'chain':
        addArc(ev.x1, ev.y1, ev.x2, ev.y2, P.type.CHAIN, ev.depth);
        break;
      case 'freeze':
        spawnParticles(ev.x, ev.y, Math.round(4 * qualityMul()), 90 * scale(), P.type.FROST, 0.5, 1.5 * scale());
        break;
      case 'frostBurst':
        addWave(ev.x, ev.y, ev.r, 0.7, P.type.FROST);
        break;
      case 'shatter':
        spawnParticles(ev.x, ev.y, Math.round(CONFIG.effects.shatterSparks * qualityMul()),
          260 * scale(), P.type.FROST, 0.55, 1.9 * scale());
        break;
      case 'prism':
        spawnParticles(ev.x, ev.y, Math.round(5 * qualityMul()), 150 * scale(), P.type.PRISM, 0.35, 1.4 * scale());
        break;
      case 'shardHit':
        spawnParticles(ev.x, ev.y, Math.round(3 * qualityMul()), 140 * scale(), P.type.PRISM, 0.3, 1.3 * scale());
        break;
      case 'gold':
        spawnParticles(ev.x, ev.y, Math.round(14 * qualityMul()), 300 * scale(), P.type.GOLD, 0.8, 2.1 * scale());
        addFlash(0.09);
        break;
      case 'sling':
        addWave(ev.x, ev.y, CONFIG.gather.captureRadius * scale(), 1.2, P.ring);
        spawnParticles(ev.x, ev.y, Math.round(Math.min(30, ev.count * 2) * qualityMul()),
          420 * scale(), P.ring, 0.6, 2 * scale());
        addShake(2.4 * scale());
        break;
      case 'resonance':
        addWave(ev.x, ev.y, 120 * scale(), 1.5, P.star);
        addFlash(0.12);
        break;
      case 'levelup':
        if (ev.level <= CONFIG.levels.maxCelebrated) {
          celebrate('LEVEL ' + ev.level, '', false);
          addFlash(0.08);
        }
        break;
      case 'unlock':
        celebrate(ev.label, 'unlocked', true);
        addFlash(0.14);
        addShake(3 * scale());
        break;
      case 'palette':
        celebrate(ev.name, 'new sky', false);
        break;
      case 'milestone':
        celebrate(ev.kind === 'comet' ? 'COMET' : formatScore(ev.value), 'milestone', true,
          CONFIG.milestones.celebrateTime);
        addFlash(0.18);
        addShake(5 * scale());
        sky = deriveStars(serializeSave(sim), CONFIG);
        skyDirty = true;
        writeSave(true);
        break;
      case 'filigree':
        celebrate('', 'combo record', false);
        break;
      case 'cometSpawn':
        break;
      case 'cometChip':
        spawnParticles(ev.x, ev.y, Math.round(14 * qualityMul()), 320 * scale(), P.star, 0.7, 2 * scale());
        addShake(2 * scale());
        break;
      case 'cometBreak':
        spawnParticles(ev.x, ev.y, Math.round(40 * qualityMul()), 600 * scale(), P.star, 1.1, 2.6 * scale());
        addFlash(0.2);
        addShake(7 * scale());
        break;
      case 'spawn':
      case 'despawn':
      case 'scatter':
      case 'tap':
      case 'fieldDown':
      case 'fieldUp':
      case 'fieldCancel':
      case 'magnetSpike':
      case 'shardBounce':
      default:
        break;
    }
    if (loud && ev.type === 'impact' && ev.speed > 1.4) addFlash(0.035);
  }
}

function celebrate(text, sub, big, life) {
  // An unlock outranks a level-up: do not let a routine flourish stomp one mid-play.
  if (celebration && celebration.big && !big && celebration.t < celebration.life * 0.5) return;
  celebration = {
    text, sub, t: 0, big,
    life: life || (big ? CONFIG.levels.unlockCelebrateTime : CONFIG.levels.levelCelebrateTime),
  };
}

function updateEffects(dt) {
  // Particles
  let w = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.t += dt;
    if (p.t >= p.life) continue;
    p.vx *= 0.965; p.vy *= 0.965;
    p.x += p.vx * dt; p.y += p.vy * dt;
    particles[w++] = p;
  }
  particles.length = w;
  if (particles.length > particleBudget) particles.length = particleBudget;

  w = 0;
  for (let i = 0; i < popups.length; i++) {
    const p = popups[i];
    p.t += dt;
    if (p.t >= p.life) continue;
    popups[w++] = p;
  }
  popups.length = w;

  w = 0;
  for (let i = 0; i < waves.length; i++) {
    const v = waves[i];
    v.t += dt;
    if (v.t >= v.life) continue;
    waves[w++] = v;
  }
  waves.length = w;

  w = 0;
  for (let i = 0; i < arcs.length; i++) {
    const a = arcs[i];
    a.t += dt;
    if (a.t >= a.life + a.delay) continue;
    arcs[w++] = a;
  }
  arcs.length = w;

  if (hintFade > 0) hintFade = Math.max(0, hintFade - dt);
  if (flash > 0) flash = Math.max(0, flash - dt);
  if (flash === 0) flashMax = 0;
  if (shake > 0) shake = Math.max(0, shake - shake * CONFIG.effects.shakeDecay * dt - 0.01);
  if (celebration) {
    celebration.t += dt;
    if (celebration.t >= celebration.life) celebration = null;
  }
}

function qualityMul() {
  return particleBudget / Math.max(1, CONFIG.effects.maxParticles);
}

/* ========================================================================== */
/* Number formatting                                                          */
/* ========================================================================== */

function formatScore(n) {
  const v = Math.floor(n);
  if (!Number.isFinite(v)) return '0';
  if (v < 100000) {
    // Thousands separators without Intl (cheap, and identical everywhere).
    const s = String(v);
    if (s.length <= 3) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ',';
      out += s[i];
    }
    return out;
  }
  if (v < 1e6) return (v / 1000).toFixed(1) + 'k';
  if (v < 1e9) return (v / 1e6).toFixed(2) + 'M';
  if (v < 1e12) return (v / 1e9).toFixed(2) + 'B';
  if (v < 1e15) return (v / 1e12).toFixed(2) + 'T';
  return v.toExponential(2);
}

/* ========================================================================== */
/* Input                                                                      */
/* ========================================================================== */

const pointers = new Map();     // pointerId -> {x, y}
const cancelled = [];
let scatterRequest = false;

// Gesture state
let gestureStart = 0;
let gestureMaxDown = 0;
let gestureMoved = 0;
let lastTwoFingerTap = -99;
let twoFingerTapCount = 0;
let debugOn = FORCE_DEBUG || CONFIG.debug.enabled;
let wipeHold = 0;
let wipeDone = 0;

function canvasPos(e) {
  let rect = { left: 0, top: 0 };
  try { rect = canvas.getBoundingClientRect(); } catch (_) {}
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function onPointerDown(e) {
  try {
    if (SOAK) return;
    const [x, y] = canvasPos(e);
    if (pointers.size === 0) { gestureStart = nowSec(); gestureMaxDown = 0; gestureMoved = 0; }
    pointers.set(e.pointerId, { x, y });
    gestureMaxDown = Math.max(gestureMaxDown, pointers.size);
    if (!seenHint) { seenHint = true; hintFade = CONFIG.input.hintFadeTime; writeSave(true); }
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  } catch (err) { logError('input', err.message); }
}

function onPointerMove(e) {
  try {
    if (SOAK) return;
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const [x, y] = canvasPos(e);
    gestureMoved += Math.abs(x - p.x) + Math.abs(y - p.y);
    p.x = x; p.y = y;
    e.preventDefault();
  } catch (err) { logError('input', err.message); }
}

function endPointer(e, isCancel) {
  try {
    if (SOAK) return;
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    // pointercancel (iOS system gestures), pointerleave and blur must CLEAR the field
    // rather than sling it. A stuck invisible field is the bug you would otherwise report.
    if (isCancel) cancelled.push(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (pointers.size === 0) {
      const dur = nowSec() - gestureStart;
      const still = gestureMoved < 26;
      if (dur < CONFIG.input.debugTapMaxTime && still) {
        if (gestureMaxDown >= CONFIG.input.debugFingers) {
          debugOn = !debugOn;
          twoFingerTapCount = 0;
        } else if (gestureMaxDown === CONFIG.input.scatterFingers) {
          const t = nowSec();
          twoFingerTapCount = (t - lastTwoFingerTap < CONFIG.input.scatterTapWindow) ? twoFingerTapCount + 1 : 1;
          lastTwoFingerTap = t;
          if (twoFingerTapCount >= CONFIG.input.scatterTapCount) {
            twoFingerTapCount = 0;
            scatterRequest = true;
          }
        }
      }
      gestureMaxDown = 0;
    }
    e.preventDefault();
  } catch (err) { logError('input', err.message); }
}

function clearAllFields() {
  for (const id of pointers.keys()) cancelled.push(id);
  pointers.clear();
  gestureMaxDown = 0;
  wipeHold = 0;
}

try {
  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', (e) => endPointer(e, false), { passive: false });
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true), { passive: false });
  canvas.addEventListener('pointerleave', (e) => endPointer(e, true), { passive: false });
  canvas.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && !e.relatedTarget) endPointer(e, true); }, { passive: false });
  window.addEventListener('blur', clearAllFields);
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'd' || e.key === 'D') debugOn = !debugOn;
    else if (e.key === 'r' || e.key === 'R') scatterRequest = true;
  });
} catch (e) { logError('input', 'listener setup: ' + e.message); }

/* ---- soak: synthetic multi-touch for hands-free stress runs --------------- */

const soakPointers = [];
if (SOAK) {
  for (let i = 0; i < CONFIG.input.soakPointers; i++) {
    soakPointers.push({
      id: 900 + i, x: Math.random() * iw, y: Math.random() * ih,
      tx: Math.random() * iw, ty: Math.random() * ih,
      timer: Math.random() * 2, down: true, hold: 0,
    });
  }
}

function updateSoak(dt) {
  for (const p of soakPointers) {
    p.timer -= dt;
    if (p.timer <= 0) {
      p.timer = 0.3 + Math.random() * (2 / Math.max(0.01, CONFIG.input.soakChangeRate));
      if (!p.down) {
        p.down = true;
        p.x = Math.random() * cssW; p.y = Math.random() * cssH;
        p.hold = Math.random() < CONFIG.input.soakHoldChance ? 0.6 + Math.random() * 1.8 : 0;
      } else if (Math.random() < 0.42) {
        p.down = false;
        // Exercise the pointercancel path too, not only clean releases.
        if (Math.random() < 0.3) cancelled.push(p.id);
      } else {
        p.tx = Math.random() * cssW; p.ty = Math.random() * cssH;
        p.hold = Math.random() < CONFIG.input.soakHoldChance ? 0.6 + Math.random() * 1.8 : 0;
      }
    }
    if (!p.down) continue;
    if (p.hold > 0) {
      p.hold -= dt;
      p.x += (Math.random() - 0.5) * 8 * dt;
      p.y += (Math.random() - 0.5) * 8 * dt;
    } else {
      const k = Math.min(1, 7 * dt);
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
    }
  }
  if (Math.random() < 0.0008) scatterRequest = true;
}

function buildInput() {
  const list = [];
  if (SOAK) {
    for (const p of soakPointers) if (p.down) list.push({ id: p.id, x: p.x, y: p.y });
  } else {
    for (const [id, p] of pointers) list.push({ id, x: p.x, y: p.y });
  }
  const input = {
    pointers: list,
    cancelled: cancelled.length ? cancelled.slice() : null,
    scatter: scatterRequest,
  };
  cancelled.length = 0;
  scatterRequest = false;
  return input;
}

/* ========================================================================== */
/* Drawing                                                                    */
/* ========================================================================== */

function drawBackground(P, calm) {
  const g = ctx.createLinearGradient(0, 0, 0, cssH);
  g.addColorStop(0, P.bg0);
  g.addColorStop(1, P.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);

  // The sky: permanent, save-derived, and best seen when nothing is happening.
  const skyAlpha = calm + (1 - calm) * CONFIG.sky.calmOnlyAlpha;
  if (sky.stars.length && skyAlpha > 0.02) {
    const t = sim.time;
    ctx.save();
    if (sky.links.length) {
      ctx.strokeStyle = rgba(P.star, CONFIG.sky.linkAlpha * skyAlpha);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (const [i, j] of sky.links) {
        const a = sky.stars[i], b = sky.stars[j];
        ctx.moveTo(a.x * cssW, a.y * cssH);
        ctx.lineTo(b.x * cssW, b.y * cssH);
      }
      ctx.stroke();
    }
    for (const s of sky.stars) {
      const tw = 1 + CONFIG.render.starTwinkle * Math.sin(t * CONFIG.sky.twinkleRate * 6.28 + (s.seed % 1000) * 0.017);
      const a = Math.min(1, s.mag * tw) * skyAlpha;
      if (a <= 0.01) continue;
      const r = 0.7 + s.mag * 1.4;
      ctx.fillStyle = rgba(P.star, a);
      ctx.beginPath();
      ctx.arc(s.x * cssW, s.y * cssH, r, 0, 6.283);
      ctx.fill();
    }
    ctx.restore();
  }
}

function ballColor(P, b) {
  if (b.type === 'ORB') return P.orbHues[b.hue % P.orbHues.length];
  return P.type[b.type] || P.orbHues[0];
}

/** Glow + core into the TRAIL layer, so movement leaves a streak. */
function drawBallsToTrail(P) {
  const g = trailCtx;
  g.globalCompositeOperation = 'lighter';
  const gs = CONFIG.balls.glowScale;
  for (const b of sim.balls) {
    if (!b.alive) continue;
    const fade = b.fade;
    if (fade <= 0.01) continue;
    const col = b.frozenT > 0 ? P.type.FROST : ballColor(P, b);
    const sprite = glowSprite(col);
    let a = fade;
    if (b.type === 'VOLATILE' && b.inertT > 0) a *= 0.45;
    const pulse = 1 + b.pulse * 0.5;
    const R = b.r * gs * pulse;
    g.globalAlpha = Math.max(0, Math.min(1, a * 0.62));
    g.drawImage(sprite, b.x - R, b.y - R, R * 2, R * 2);
    // Core, drawn tight and in the ball's own colour so it reads as a solid object rather
    // than a smudge — without bleaching the palette out of it.
    // Colour only. The white hot-centre is drawn later, on the crisp stage layer — putting
    // it here made every trail desaturate to grey mush as it faded.
    g.globalAlpha = Math.max(0, Math.min(1, a));
    g.beginPath();
    g.arc(b.x, b.y, b.r * 0.88 * pulse, 0, 6.283);
    g.fillStyle = col;
    g.fill();
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

function drawShardsAndParticlesToTrail(P) {
  const g = trailCtx;
  g.globalCompositeOperation = 'lighter';

  const sr = CONFIG.types.PRISM.shardRadius * scale();
  g.strokeStyle = rgba(P.type.PRISM, 0.9);
  g.lineWidth = Math.max(1, sr * 0.8);
  g.beginPath();
  for (const s of sim.shards) {
    const len = 0.03;
    g.moveTo(s.x, s.y);
    g.lineTo(s.x - s.vx * len, s.y - s.vy * len);
  }
  g.stroke();

  for (const p of particles) {
    const k = 1 - p.t / p.life;
    g.globalAlpha = Math.max(0, Math.min(1, k * k));
    g.fillStyle = p.color;
    g.beginPath();
    g.arc(p.x, p.y, p.size * (0.4 + k * 0.9), 0, 6.283);
    g.fill();
  }

  for (const v of waves) {
    const k = v.t / v.life;
    const r = v.r0 + (v.r1 - v.r0) * (1 - Math.pow(1 - k, 2));
    g.globalAlpha = Math.max(0, (1 - k) * 0.5 * v.strength);
    g.strokeStyle = v.color;
    g.lineWidth = Math.max(1, 3 * (1 - k) * scale());
    g.beginPath();
    g.arc(v.x, v.y, r, 0, 6.283);
    g.stroke();
  }

  for (const a of arcs) {
    if (a.t < a.delay) continue;          // this link has not fired yet
    const k = 1 - (a.t - a.delay) / a.life;
    g.globalAlpha = Math.max(0, k);
    g.strokeStyle = a.color;
    g.lineWidth = Math.max(1, 2.2 * k * scale());
    g.beginPath();
    g.moveTo(a.x1, a.y1);
    const segs = 5;
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const mx = a.x1 + (a.x2 - a.x1) * t;
      const my = a.y1 + (a.y2 - a.y1) * t;
      const j = (Math.sin(a.seed + i * 2.7 + sim.time * 40) * 0.5) * 18 * scale() * (1 - Math.abs(t - 0.5) * 2);
      const nx = -(a.y2 - a.y1), ny = (a.x2 - a.x1);
      const nl = Math.max(1e-3, Math.hypot(nx, ny));
      g.lineTo(mx + (nx / nl) * j, my + (ny / nl) * j);
    }
    g.lineTo(a.x2, a.y2);
    g.stroke();
  }

  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/** Crisp per-type detail, drawn on the stage so it never smears into mush. */
function drawBallDetail(P) {
  const t = sim.time;
  ctx.save();

  // White-hot centres, crisp and un-smeared. Additive so they blow out where orbs pile up.
  ctx.globalCompositeOperation = 'lighter';
  for (const b of sim.balls) {
    if (!b.alive || b.fade <= 0.05) continue;
    let a = b.fade * 0.75;
    if (b.type === 'VOLATILE' && b.inertT > 0) a *= 0.4;
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.44 * (1 + b.pulse * 0.5), 0, 6.283);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  for (const b of sim.balls) {
    if (!b.alive || b.fade <= 0.05) continue;
    const a = b.fade;
    switch (b.type) {
      case 'VOLATILE': {
        if (b.inertT > 0) {
          // Visible recharge: the arc fills as the ball comes back online.
          const k = 1 - b.inertT / CONFIG.types.VOLATILE.inertTime;
          ctx.strokeStyle = rgba(P.type.VOLATILE, 0.75 * a);
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r * 1.5, -Math.PI / 2, -Math.PI / 2 + 6.283 * k);
          ctx.stroke();
        } else {
          ctx.strokeStyle = rgba(P.type.VOLATILE, 0.5 * a);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r * 1.45, 0, 6.283);
          ctx.stroke();
        }
        break;
      }
      case 'SPLITTER': {
        ctx.strokeStyle = rgba(P.type.SPLITTER, 0.7 * a);
        ctx.lineWidth = 1.3;
        const ang = t * 0.6 + b.phase;
        ctx.beginPath();
        ctx.moveTo(b.x - Math.cos(ang) * b.r, b.y - Math.sin(ang) * b.r);
        ctx.lineTo(b.x + Math.cos(ang) * b.r, b.y + Math.sin(ang) * b.r);
        ctx.stroke();
        break;
      }
      case 'MAGNET': {
        const spike = b.spikeT > 0 ? 1 : 0.45;
        ctx.strokeStyle = rgba(P.type.MAGNET, 0.3 * a * spike);
        ctx.lineWidth = 1;
        const lines = CONFIG.types.MAGNET.fieldLines;
        for (let i = 1; i <= lines; i++) {
          const rr = b.r * (1.5 + i * 0.9) * (1 + (b.spikeT > 0 ? 0.12 : 0));
          ctx.beginPath();
          ctx.arc(b.x, b.y, rr, t * 0.5 + i, t * 0.5 + i + 1.5);
          ctx.stroke();
        }
        break;
      }
      case 'PRISM': {
        ctx.strokeStyle = rgba(P.type.PRISM, 0.8 * a);
        ctx.lineWidth = 1.2;
        const ang = t * 0.9 + b.phase;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const A = ang + (i / 3) * 6.283;
          const px = b.x + Math.cos(A) * b.r * 1.25;
          const py = b.y + Math.sin(A) * b.r * 1.25;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case 'CHAIN': {
        ctx.strokeStyle = rgba(P.type.CHAIN, 0.7 * a);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const A = t * 2.2 + b.phase + (i / 4) * 6.283;
          const rr = b.r * (1.35 + 0.18 * Math.sin(t * 6 + i));
          const px = b.x + Math.cos(A) * rr, py = b.y + Math.sin(A) * rr;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        break;
      }
      case 'GOLD': {
        const glints = 4;
        ctx.strokeStyle = rgba(P.type.GOLD, 0.9 * a);
        ctx.lineWidth = 1.1;
        for (let i = 0; i < glints; i++) {
          const A = t * 1.4 + b.phase + (i / glints) * 6.283;
          const r0 = b.r * 1.25, r1 = b.r * (1.75 + 0.35 * Math.sin(t * CONFIG.types.GOLD.glitterRate * 0.3 + i));
          ctx.beginPath();
          ctx.moveTo(b.x + Math.cos(A) * r0, b.y + Math.sin(A) * r0);
          ctx.lineTo(b.x + Math.cos(A) * r1, b.y + Math.sin(A) * r1);
          ctx.stroke();
        }
        break;
      }
      default: break;
    }
    // Frost overlay: crystalline, applied on top of whatever the ball is.
    if (b.frozenT > 0) {
      ctx.strokeStyle = rgba(P.type.FROST, 0.85 * a);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const A = (i / 6) * 6.283 + b.phase;
        const px = b.x + Math.cos(A) * b.r * 1.35;
        const py = b.y + Math.sin(A) * b.r * 1.35;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawComet(P) {
  const c = sim.comet;
  if (!c) return;
  const r = CONFIG.comet.radius * scale();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i + 1 < c.tail.length / 2; i++) {
    const k = i / Math.max(1, c.tail.length / 2);
    ctx.globalAlpha = k * 0.35;
    ctx.fillStyle = P.star;
    ctx.beginPath();
    ctx.arc(c.tail[i * 2], c.tail[i * 2 + 1], r * 0.35 * k, 0, 6.283);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const sprite = glowSprite(P.star);
  const R = r * 2.4;
  ctx.drawImage(sprite, c.x - R, c.y - R, R * 2, R * 2);
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = rgba(P.star, 0.8);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + 6.283 * (c.hp / CONFIG.comet.hp));
  ctx.stroke();
  ctx.restore();
}

/* ---- fields, combo ring, filigree ---------------------------------------- */

/**
 * Where balls actually orbit, solved from the gather constants (see config.gather).
 * Drawing the ring anywhere else makes a working attractor look broken.
 */
function orbitShellRadius() {
  const G = CONFIG.gather;
  const k = G.orbitSpring;
  const r0 = G.orbitRadius * scale();
  const v = G.orbitSpin * scale();
  if (!(k > 0)) return r0;
  return (k * r0 + Math.sqrt(k * k * r0 * r0 + 4 * k * v * v)) / (2 * k);
}

function drawFields(P) {
  const tier = filigreeTier(sim.bestCombo, CONFIG);
  const arcCount = CONFIG.filigree.arcCount[Math.min(tier, CONFIG.filigree.arcCount.length - 1)] || 0;
  const t = sim.time;
  const comboK = sim.comboCount > 0 ? Math.min(1, sim.comboTimer / CONFIG.score.comboWindow) : 0;

  ctx.save();
  for (const f of sim.pointers.values()) {
    const idleR = CONFIG.render.ringRadius * scale();
    const R = idleR + (orbitShellRadius() - idleR) * f.gather;
    const alpha = CONFIG.render.fieldRingAlpha * f.amp;

    ctx.strokeStyle = rgba(P.ring, alpha * (0.5 + 0.5 * f.gather));
    ctx.lineWidth = CONFIG.render.ringWidth * scale() * (0.6 + f.gather * 0.8);
    ctx.beginPath();
    ctx.arc(f.sx, f.sy, R, 0, 6.283);
    ctx.stroke();

    // Combo ring: how much of the window is left before the combo starts shedding.
    if (comboK > 0) {
      ctx.strokeStyle = rgba(P.hud, 0.85 * f.amp);
      ctx.lineWidth = CONFIG.render.ringWidth * scale() * 0.7;
      ctx.beginPath();
      ctx.arc(f.sx, f.sy, R * 1.28, -Math.PI / 2, -Math.PI / 2 + 6.283 * comboK);
      ctx.stroke();
    }

    // Filigree: permanent ornament earned by lifetime best combo. Cosmetic only.
    if (arcCount > 0) {
      ctx.strokeStyle = rgba(P.ring, CONFIG.filigree.alpha * f.amp * 0.8);
      ctx.lineWidth = 1;
      const spin = t * CONFIG.filigree.spinRate;
      for (let i = 0; i < arcCount; i++) {
        const a0 = spin + (i / arcCount) * 6.283;
        ctx.beginPath();
        ctx.arc(f.sx, f.sy, R * 1.5, a0, a0 + 0.34);
        ctx.stroke();
      }
    }

    // Gathering: a faint reach circle so the attractor's pull is legible.
    if (f.gather > 0.05) {
      ctx.strokeStyle = rgba(P.ring, 0.10 * f.gather);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(f.sx, f.sy, CONFIG.gather.radiusGather * scale() * f.gather, 0, 6.283);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ---- HUD ------------------------------------------------------------------ */

let displayScore = 0;
let hintFade = 0;

function drawHud(P, calm) {
  const F = CONFIG.render;
  const alpha = calm * F.hudAlphaCalm + (1 - calm) * F.hudAlphaActive;
  const left = safe.l + F.hudMargin;
  const right = cssW - safe.r - F.hudMargin;
  const top = safe.t + F.hudMargin;
  const cx = (left + right) / 2;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // A soft dark halo behind the HUD text. Without it the numbers are unreadable whenever a
  // bright orb drifts under them, and there is no DOM chrome available to sit them on.
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 9;

  // Score — rolls, never snaps.
  const scoreText = formatScore(displayScore);
  const size = Math.max(26, Math.min(46, cssW * 0.105));
  ctx.font = '600 ' + size + 'px ' + F.fontStack;
  ctx.fillStyle = rgba(P.hud, alpha);
  ctx.fillText(scoreText, cx, top);

  // Combo, right under the score.
  let y = top + size * 1.05;
  if (sim.comboCount > 0) {
    const cs = Math.max(12, size * 0.38);
    ctx.font = '600 ' + cs + 'px ' + F.fontStack;
    const pulse = 0.7 + 0.3 * Math.min(1, sim.comboTimer / CONFIG.score.comboWindow);
    ctx.fillStyle = rgba(P.ring, alpha * pulse);
    ctx.fillText('×' + sim.comboMult.toFixed(2) + '   ' + sim.comboCount, cx, y);
    y += cs * 1.25;
  } else {
    y += Math.max(12, size * 0.38) * 1.25;
  }

  // Level bar.
  const barW = Math.min(200, (right - left) * 0.55);
  const barH = F.levelBarHeight;
  const prog = Math.max(0, Math.min(1, sim.xp / Math.max(1, sim.xpNeeded)));
  ctx.fillStyle = rgba(P.hudDim, alpha * 0.5);
  roundRect(ctx, cx - barW / 2, y, barW, barH, barH / 2);
  ctx.fill();
  ctx.fillStyle = rgba(P.ring, alpha);
  roundRect(ctx, cx - barW / 2, y, Math.max(barH, barW * prog), barH, barH / 2);
  ctx.fill();

  const ls = Math.max(10, size * 0.27);
  ctx.font = '500 ' + ls + 'px ' + F.fontStack;
  ctx.fillStyle = rgba(P.hudDim, alpha);
  ctx.fillText('LV ' + sim.level, cx, y + barH + 5);

  // Floating score popups.
  ctx.textBaseline = 'middle';
  for (const p of popups) {
    const k = p.t / p.life;
    const a = Math.min(1, (1 - k) * 2.2);
    ctx.font = '600 ' + p.size + 'px ' + F.fontStack;
    ctx.fillStyle = rgba(p.color, a * 0.95);
    ctx.fillText(p.text, p.x, p.y - CONFIG.effects.popupRise * scale() * k);
  }

  // Celebration.
  if (celebration) {
    const k = celebration.t / celebration.life;
    const a = Math.min(1, Math.sin(Math.min(1, k * 1.05) * Math.PI) * 1.8);
    const bigSize = Math.max(28, Math.min(64, cssW * (celebration.big ? 0.15 : 0.11)));
    ctx.textAlign = 'center';
    if (celebration.text) {
      ctx.font = '700 ' + bigSize + 'px ' + F.fontStack;
      ctx.fillStyle = rgba(P.hud, a);
      ctx.fillText(celebration.text, cssW / 2, cssH * 0.42);
    }
    if (celebration.sub) {
      ctx.font = '500 ' + bigSize * 0.32 + 'px ' + F.fontStack;
      ctx.fillStyle = rgba(P.ring, a * 0.9);
      ctx.fillText(celebration.sub.toUpperCase(), cssW / 2, cssH * 0.42 + bigSize * 0.75);
    }
  }

  // First run only: a pulsing hint that dies on first contact.
  if ((!seenHint || hintFade > 0) && !SOAK) {
    const out = seenHint ? Math.max(0, hintFade / Math.max(1e-6, CONFIG.input.hintFadeTime)) : 1;
    const pulse = (0.35 + 0.35 * (0.5 + 0.5 * Math.sin(sim.time * 6.283 / CONFIG.input.hintPulsePeriod))) * out;
    ctx.font = '500 ' + Math.max(15, cssW * 0.045) + 'px ' + F.fontStack;
    ctx.fillStyle = rgba(P.hud, pulse);
    ctx.textAlign = 'center';
    ctx.fillText('touch', cssW / 2, cssH * 0.62);
  }

  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

/* ---- debug overlay -------------------------------------------------------- */

const wipeRect = { x: 0, y: 0, w: 0, h: 0 };

function drawDebug(P, physMs, fps) {
  const x = safe.l + 8;
  let y = safe.t + 8;
  const lh = 13;
  const lines = [
    'fps ' + fps.toFixed(0) + '   phys ' + physMs.toFixed(2) + 'ms   draw ' + renderMs.toFixed(2)
      + 'ms   dpr ' + dpr.toFixed(2),
    'balls ' + sim.aliveCount + '/' + sim.softCap + ' (cap ' + CONFIG.population.hardCap + ')'
      + '   shards ' + sim.shards.length,
    'parts ' + particles.length + '/' + particleBudget + '   bloom ' + bloomScale.toFixed(2)
      + '   evDrop ' + sim.eventsDropped,
    'sanitizer ' + sim.sanitizerHits + '   fields ' + sim.pointers.size,
    'I ' + sim.intensity.toFixed(2) + ' ' + sim.mode + '   combo ' + sim.comboCount
      + ' x' + sim.comboMult.toFixed(2),
    'lv ' + sim.level + '  xp ' + Math.floor(sim.xp) + '/' + sim.xpNeeded
      + '  gmul ' + sim.globalMult.toFixed(2),
    'score ' + sim.score + '   best ' + sim.bestCombo + '   stars ' + sky.stars.length,
    'palette ' + (P.name || '?') + '   store ' + (store.available ? 'ok' : 'UNAVAILABLE')
      + (SOAK ? '   SOAK' : ''),
  ];

  ctx.save();
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);

  const errLines = errorBuffer.length
    ? errorBuffer.slice(-6).map((e) => e.kind + ': ' + e.msg + (e.count > 1 ? ' (x' + e.count + ')' : ''))
    : ['errors: none'];
  for (const l of errLines) maxW = Math.max(maxW, ctx.measureText(l).width);

  const boxH = (lines.length + errLines.length + 2) * lh + 30;
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(x - 5, y - 5, maxW + 16, boxH);

  ctx.fillStyle = '#9fe8c0';
  for (const l of lines) { ctx.fillText(l, x, y); y += lh; }
  y += 4;
  ctx.fillStyle = errorBuffer.length ? '#ff9a9a' : '#6f8f7f';
  for (const l of errLines) { ctx.fillText(l, x, y); y += lh; }

  // Save-wipe target: hold a finger on it to erase everything.
  y += 6;
  wipeRect.x = x; wipeRect.y = y; wipeRect.w = 128; wipeRect.h = 20;
  const k = Math.min(1, wipeHold / CONFIG.debug.wipeHoldTime);
  ctx.fillStyle = 'rgba(120,20,20,0.75)';
  ctx.fillRect(wipeRect.x, wipeRect.y, wipeRect.w, wipeRect.h);
  ctx.fillStyle = 'rgba(255,70,70,0.9)';
  ctx.fillRect(wipeRect.x, wipeRect.y, wipeRect.w * k, wipeRect.h);
  ctx.fillStyle = '#fff';
  ctx.fillText(wipeDone > 0 ? 'WIPED' : 'HOLD TO WIPE SAVE', wipeRect.x + 6, wipeRect.y + 5);
  ctx.restore();
}

function updateWipe(dt) {
  if (!debugOn) { wipeHold = 0; return; }
  let inside = false;
  const check = (x, y) => (x >= wipeRect.x && x <= wipeRect.x + wipeRect.w
    && y >= wipeRect.y && y <= wipeRect.y + wipeRect.h);
  for (const p of pointers.values()) if (check(p.x, p.y)) inside = true;
  if (inside) {
    wipeHold += dt;
    if (wipeHold >= CONFIG.debug.wipeHoldTime && wipeDone === 0) {
      wipeSave();
      wipeDone = 1;
      logError('save', 'save wiped by debug overlay');
    }
  } else {
    wipeHold = 0;
  }
  if (wipeDone > 0) wipeDone += dt;
}

/* ========================================================================== */
/* Frame loop                                                                 */
/* ========================================================================== */

let lastTime = 0;
let paused = false;
let needFirstDtClamp = true;
let frameFails = 0;
let physMs = 0;
let renderMs = 0;
const fpsSamples = [];
let fps = 60;

function nowSec() {
  return (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;
}

function adaptQuality() {
  const E = CONFIG.effects;
  if (fps < E.particleShedFps) {
    const target = Math.max(E.particleShedFloor, fps / E.particleShedFps);
    particleBudget = Math.max(
      Math.round(E.maxParticles * E.particleShedFloor),
      Math.round(particleBudget * 0.94 + E.maxParticles * target * 0.06),
    );
  } else if (particleBudget < E.maxParticles) {
    particleBudget = Math.min(E.maxParticles, Math.round(particleBudget * 1.02 + 4));
  }

  const wantBloom = fps < E.bloomShedFps
    ? Math.max(E.bloomMinScale, CONFIG.render.bloomScale * 0.5)
    : CONFIG.render.bloomScale;
  if (Math.abs(wantBloom - bloomScale) > 0.02) {
    bloomScale = wantBloom;
    rebuildBloom();
  }
}

function frame(now) {
  // Scheduled FIRST: a throw below can never stop the loop.
  requestAnimationFrame(frame);

  try {
    const t = now / 1000;
    let dt = lastTime === 0 ? 1 / 60 : t - lastTime;
    lastTime = t;
    if (paused) return;
    if (needFirstDtClamp) { dt = CONFIG.world.resumeDt; needFirstDtClamp = false; }
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, CONFIG.world.maxDt);

    fpsSamples.push(dt);
    if (fpsSamples.length > CONFIG.debug.fpsWindow) fpsSamples.shift();
    let sum = 0;
    for (const s of fpsSamples) sum += s;
    fps = fpsSamples.length ? fpsSamples.length / sum : 60;

    if (SOAK) updateSoak(dt);

    // --- simulation (never skipped, never degraded) ---
    const t0 = nowSec();
    try {
      simStep(sim, dt, buildInput());
    } catch (err) {
      logError('sim', err.message);
    }
    physMs = physMs * 0.9 + (nowSec() - t0) * 1000 * 0.1;

    // --- everything else ---
    try {
      const r0 = nowSec();
      render(dt);
      renderMs = renderMs * 0.9 + (nowSec() - r0) * 1000 * 0.1;
      frameFails = 0;
    } catch (err) {
      frameFails++;
      logError('frame', err.message);
      // Two consecutive render throws: drop the effects layer and keep the sim going.
      if (frameFails >= CONFIG.debug.frameFailSoftReset) {
        frameFails = 0;
        softResetEffects();
      }
    }

    saveTimer += dt;
    if (saveTimer >= CONFIG.save.writeInterval) writeSave(false);
  } catch (err) {
    logError('loop', err && err.message);
  }
}

function render(dt) {
  const P = updatePalette(dt);
  const calmT = 1 - Math.min(1, sim.intensity / Math.max(1e-6, CONFIG.intensity.calmBelow));
  const frenzyT = Math.min(1, Math.max(0, (sim.intensity - CONFIG.intensity.frenzyAbove)
    / Math.max(1e-6, 1 - CONFIG.intensity.frenzyAbove)));

  consumeEvents(P);
  updateEffects(dt);
  updateWipe(dt);
  adaptQuality();

  // Rolling score counter.
  const k = 1 - Math.exp(-dt / Math.max(1e-6, CONFIG.score.rollTau));
  displayScore += (sim.score - displayScore) * k;
  if (Math.abs(sim.score - displayScore) < CONFIG.score.rollSnapBelow) displayScore = sim.score;

  // --- trail layer: fade with destination-out, then draw the glowing stuff -----------
  const fadeBase = calmT > 0
    ? CONFIG.render.trailFadeCalm + (CONFIG.render.trailFade - CONFIG.render.trailFadeCalm) * (1 - calmT)
    : CONFIG.render.trailFade + (CONFIG.render.trailFadeFrenzy - CONFIG.render.trailFade) * frenzyT;
  trailCtx.save();
  trailCtx.setTransform(1, 0, 0, 1, 0, 0);
  trailCtx.globalCompositeOperation = 'destination-out';
  trailCtx.fillStyle = 'rgba(0,0,0,' + Math.max(0.01, Math.min(1, fadeBase)) + ')';
  trailCtx.fillRect(0, 0, trail.width, trail.height);
  trailCtx.restore();

  drawShardsAndParticlesToTrail(P);
  drawBallsToTrail(P);

  // --- bloom: downscale the trail, then composite it back with 'lighter' ------------
  const strength = calmT > 0
    ? CONFIG.render.bloomStrengthCalm + (CONFIG.render.bloomStrength - CONFIG.render.bloomStrengthCalm) * (1 - calmT)
    : CONFIG.render.bloomStrength + (CONFIG.render.bloomStrengthFrenzy - CONFIG.render.bloomStrength) * frenzyT;
  bloomACtx.setTransform(1, 0, 0, 1, 0, 0);
  bloomACtx.clearRect(0, 0, bloomA.width, bloomA.height);
  bloomACtx.drawImage(trail, 0, 0, bloomA.width, bloomA.height);
  if (CONFIG.render.bloomPasses > 1) {
    bloomBCtx.setTransform(1, 0, 0, 1, 0, 0);
    bloomBCtx.clearRect(0, 0, bloomB.width, bloomB.height);
    bloomBCtx.drawImage(bloomA, 0, 0, bloomB.width, bloomB.height);
  }

  // --- stage ------------------------------------------------------------------------
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  const sy = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  ctx.save();
  ctx.translate(sx, sy);

  drawBackground(P, calmT);

  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(trail, 0, 0, cssW, cssH);

  ctx.globalAlpha = strength;
  ctx.drawImage(bloomA, 0, 0, cssW, cssH);
  if (CONFIG.render.bloomPasses > 1) {
    ctx.globalAlpha = strength * 0.7;
    ctx.drawImage(bloomB, 0, 0, cssW, cssH);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  drawComet(P);
  drawBallDetail(P);
  drawFields(P);
  drawHud(P, calmT);

  if (flash > 0) {
    const a = flashMax * (flash / CONFIG.effects.flashTime);
    ctx.fillStyle = rgba(P.fog, a);
    ctx.fillRect(-8, -8, cssW + 16, cssH + 16);
  }

  ctx.restore();

  if (debugOn) drawDebug(P, physMs, fps);
}

/* ========================================================================== */
/* Lifecycle                                                                  */
/* ========================================================================== */

try {
  window.addEventListener('resize', () => { try { resizeLayers(); } catch (e) { logError('resize', e.message); } });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => { try { resizeLayers(); } catch (e) { logError('resize', e.message); } }, 120);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      try { resizeLayers(); } catch (e) { logError('resize', e.message); }
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      paused = true;
      clearAllFields();
      if (CONFIG.save.writeOnHide) writeSave(true);
    } else {
      paused = false;
      needFirstDtClamp = true;   // clamp the first dt after resume, or everything teleports
      lastTime = 0;
    }
  });
  window.addEventListener('pagehide', () => { if (CONFIG.save.writeOnHide) writeSave(true); });
} catch (e) { logError('life', e.message); }

// Expose a small handle for the headless harness and for poking around in Safari's
// inspector. Nothing in the app reads this.
try {
  window.ORBS = {
    sim, CONFIG,
    get errors() { return errorBuffer.slice(); },
    get stats() {
      return {
        fps, physMs, renderMs, balls: sim.aliveCount, particles: particles.length,
        score: sim.score, level: sim.level, combo: sim.comboCount,
        intensity: sim.intensity, mode: sim.mode, sanitizer: sim.sanitizerHits,
        eventsDropped: sim.eventsDropped, stars: sky.stars.length,
        storage: store.available, dpr, bloomScale, particleBudget,
        cssW, cssH, safe: Object.assign({}, safe), palette: palette.cur && palette.cur.name,
      };
    },
    wipe() { wipeSave(); },
    save() { writeSave(true); },
    toggleDebug() { debugOn = !debugOn; },
  };
} catch (_) {}

requestAnimationFrame(frame);
