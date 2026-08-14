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
    try { cap = CFG.debug.errorBufferSize || 12; } catch (_) {}
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

import { CONFIG as BASE_CONFIG } from './config.js';
import {
  createSim, step as simStep, resize as simResize, scatter as simScatter,
  makeRng, loadSave, serializeSave, defaultSave, applySave, deriveStars, filigreeTier,
  applyUpgrade, upgradeForLevel,
} from './sim.js';

/* ========================================================================== */
/* Query flags                                                                */
/* ========================================================================== */

// Reads go through CFG, not the imported config. createSim deep-clones what it is handed
// and level upgrades MUTATE that clone, so the renderer must read the same live object the
// simulation does — otherwise every visual upgrade would silently do nothing.
let CFG = BASE_CONFIG;

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
  const raw = store.get(CFG.save.key);
  if (raw == null) return defaultSave(CFG);
  return loadSave(raw, CFG);
}

let saveTimer = 0;
function writeSave(force) {
  // ?soak=1 drives hours of synthetic max-strength input. Persisting that would overwrite
  // the player's real progress with a stress run's numbers.
  if (SOAK) { saveTimer = 0; return; }
  try {
    const payload = serializeSave(sim);
    payload.seenHint = seenHint;
    store.set(CFG.save.key, JSON.stringify(payload));
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
  store.remove(CFG.save.key);
  try {
    applySave(sim, defaultSave(CFG));
    seenHint = false;
    hintFade = 0;
    displayScore = 0;
    sky = deriveStars(defaultSave(CFG), CFG);
    palette.cur = null;
    palette.key = '';
    palette.from = palette.to = 0;
    palette.t = 0;
    palette.fromP = null; palette.rush = 0;
    plateKey = ''; platesReady = false;
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

/** max(rgb) - min(rgb). A cheap, hue-agnostic stand-in for chroma. */
function chromaOf(hex) {
  const c = hexToRgb(hex);
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

/**
 * Push a colour away from its own luminance — more saturated at s > 0, greyer at s < 0.
 *
 * Hue-exact and clip-proof: if the scaled vector would run past 255 the whole vector is
 * rescaled and the residual is paid out as a uniform lightness lift, so a bright red goes
 * pale rather than sliding to orange. It is a mathematical no-op on greys, which is why
 * Monochrome stays pure at every level while every other world deepens.
 */
function chroma(hex, sat, q) {
  if (!(sat > -0.999) || sat === 0) return hex;
  const c = hexToRgb(hex);
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  let k = 1 + sat, hi = 0;
  for (let i = 0; i < 3; i++) hi = Math.max(hi, L + (c[i] - L) * k);
  const lift = hi > 255 ? (hi - 255) : 0;
  if (hi > 255) k *= 255 / hi;
  const step = q || 6;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = L + (c[i] - L) * k + lift * 0.5;
    out[i] = Math.max(0, Math.min(255, Math.round(v / step) * step));
  }
  return '#' + out.map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Blend two colours without passing through putty.
 *
 * A straight sRGB lerp between distant hues collapses through grey at the midpoint: Ember's
 * #ff8a3d halfway to Deep Sea's #38bdf8 is #9aa49e, a dead putty that looked like the screen
 * had been left in the sun. Restoring the chroma the pair implies turns that midpoint into a
 * real sea-green, so a crossfade between worlds reads as weather rather than as a fault.
 */
function blendChroma(a, b, t, q) {
  const mixed = mixHex(a, b, t, q);
  const ca = chromaOf(a), cb = chromaOf(b);
  const want = ca + (cb - ca) * t;
  const have = chromaOf(mixed);
  if (have < 1 || want <= have) return mixed;
  return chroma(mixed, (want / have - 1) * CFG.paletteRules.blendChromaKeep, q);
}

function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
}

/* -- the active palette: blended between two unlocked colour worlds --------- */

const palette = {
  from: 0, to: 0, t: 0, hold: CFG.paletteRules.driftHold, cur: null, key: '',
  fromP: null,      // snapshot of what was literally on screen when a rush started, so it never jumps
  rush: 0,          // 1 while crossfading into a world that was just unlocked
  rushId: 0,        // bumped per rush, so the cache key cannot collide across two of them
};

// Where the light-front of a new world starts from: your fingertip, if you have one down.
let lastTouchX = 0, lastTouchY = 0;
let wash = null;    // { t, life, x, y, c1, c2 }

function blendPalettes(A, B, t, q) {
  // Backgrounds and HUD greys use a plain lerp: re-saturating a near-black reads as a colour
  // cast on the whole screen. Everything that is meant to BE a colour uses blendChroma.
  const out = {
    name: t < 0.5 ? A.name : B.name,
    bg0: mixHex(A.bg0, B.bg0, t, q), bg1: mixHex(A.bg1, B.bg1, t, q),
    fog: blendChroma(A.fog, B.fog, t, q), hud: mixHex(A.hud, B.hud, t, q),
    hudDim: mixHex(A.hudDim, B.hudDim, t, q), ring: blendChroma(A.ring, B.ring, t, q),
    star: blendChroma(A.star, B.star, t, q),
    orbHues: [], type: {},
  };
  const n = Math.max(A.orbHues.length, B.orbHues.length);
  for (let i = 0; i < n; i++) {
    out.orbHues.push(blendChroma(A.orbHues[i % A.orbHues.length], B.orbHues[i % B.orbHues.length], t, q));
  }
  for (const k of CFG.unlockOrder) out.type[k] = blendChroma(A.type[k], B.type[k], t, q);
  return out;
}

/**
 * The levelled colour grade: the continuous half of colour progression.
 *
 * Hue is the discrete channel — it moves only when a world unlocks. Chroma, depth and spread
 * are continuous, running a little at every one of the hundred levels, so the world you are in
 * at level 80 is a deeper, richer, more separated version of the one you started in even when
 * it is nominally the same world. It costs nothing per frame: it happens inside the palette
 * rebuild, which is already cached behind a key.
 */
function gradePalette(P, g) {
  if (g <= 0.001) return P;
  const R = CFG.paletteRules;
  P.bg0 = mixHex(P.bg0, '#000000', g * R.gradeDepth);
  P.bg1 = mixHex(P.bg1, P.fog, g * R.gradeHorizon);
  const n = P.orbHues.length;
  for (let i = 0; i < n; i++) {
    // Fan the orb hues apart in lightness as well as saturation, so a crowded late screen
    // reads as a population with depth rather than one colour repeated 150 times.
    const f = n > 1 ? i / (n - 1) : 0.5;
    const toward = f > 0.5 ? '#ffffff' : '#000000';
    const fan = mixHex(P.orbHues[i], toward, Math.abs(f - 0.5) * R.gradeSpread * g);
    P.orbHues[i] = chroma(fan, g * R.gradeChroma);
  }
  for (const k of CFG.unlockOrder) P.type[k] = chroma(P.type[k], g * R.gradeChroma);
  P.hud = chroma(P.hud, g * R.gradeChroma * 0.5);
  P.ring = chroma(P.ring, g * R.gradeChroma * 0.5);
  P.star = chroma(P.star, g * R.gradeChroma * 0.5);
  return P;
}

function updatePalette(dt) {
  const R = CFG.paletteRules;
  // sim.palettesUnlocked, not palettesUnlockedAt(sim.level): the applied count is the authority.
  // Deriving it from the level instead meant the debug menu could grant a world that the renderer
  // then refused to show, because the level had not moved with it.
  const unlocked = Math.max(1, Math.min(CFG.palettes.length, sim.palettesUnlocked));
  if (palette.cur === null) {
    palette.from = Math.min(sim.paletteIndex, unlocked - 1);
    // Aiming `to` at `from` meant the 45s hold AND the 95s crossfade that followed it both
    // blended Ember with Ember: 140 seconds of drift machinery producing no colour change at all.
    palette.to = unlocked > 1 ? (palette.from + 1) % unlocked : palette.from;
    palette.t = 0;
  }
  const rushing = palette.rush > 0;
  const driftAllowed = rushing || !R.driftOnlyWhenCalm || sim.mode === 'CALM';
  if ((unlocked > 1 || rushing) && driftAllowed) {
    if (palette.hold > 0 && !rushing) {
      palette.hold -= dt;
    } else if (palette.t < 1) {
      palette.t += dt / Math.max(1e-6, rushing ? R.unlockDriftPeriod : R.driftPeriod);
      if (palette.t >= 1) {
        palette.from = palette.to;
        palette.t = 0;
        palette.fromP = null;
        palette.hold = rushing ? R.unlockHold : R.driftHold;
        palette.rush = 0;
        palette.to = (palette.from + 1) % Math.max(1, unlocked);
        sim.paletteIndex = palette.from;
      }
    }
  } else if (unlocked <= 1) {
    palette.from = palette.to = 0;
    palette.t = 0;
  }
  const A = palette.fromP || CFG.palettes[Math.min(palette.from, CFG.palettes.length - 1)];
  const B = CFG.palettes[Math.min(palette.to, CFG.palettes.length - 1)];
  // Smoothstep the rush so it eases in and out; ambient drift is far too slow to need it.
  const tb = rushing ? palette.t * palette.t * (3 - 2 * palette.t) : palette.t;
  const g = Math.max(0, Math.min(1, (sim.level - 1) / Math.max(1, R.gradeFullLevel - 1)));
  // Coarser colour quantisation during a rush: a 9s crossfade churns glow sprites faster than
  // anything else in the game, and halving the distinct-colour count halves that churn.
  const q = rushing ? R.unlockMixStep : 6;
  const key = palette.rushId + ':' + palette.from + ':' + palette.to
    + ':' + Math.round(tb * 40) + ':' + Math.round(g * 20) + ':' + q;
  // `|| !palette.cur` is load-bearing: a wipe resets from/to/t to values that can produce
  // the SAME key, so a key-only check would never rebuild and every later frame would throw
  // on a null palette — a permanently frozen screen with the sim still running underneath.
  if (key !== palette.key || !palette.cur) {
    palette.key = key;
    palette.cur = gradePalette(blendPalettes(A, B, tb, q), g);
  }
  return palette.cur;
}

/**
 * A world you just unlocked has to arrive while you can still see the word that announced it.
 *
 * Before this, "NEW SKY" changed nothing on screen: ambient drift sat on a 45s hold and then
 * took 95s to reach the NEXT palette in a round robin, so the world you had just been given
 * was the last one you would see — up to 25 minutes later. Twelve of these across a run, and
 * not one of them was an event.
 */
function retargetPalette() {
  // sim.palettesUnlocked, not palettesUnlockedAt(sim.level): the applied count is the authority.
  // Deriving it from the level instead meant the debug menu could grant a world that the renderer
  // then refused to show, because the level had not moved with it.
  const unlocked = Math.max(1, Math.min(CFG.palettes.length, sim.palettesUnlocked));
  const nx = CFG.palettes[Math.min(unlocked - 1, CFG.palettes.length - 1)];
  if (!nx) return;
  palette.fromP = palette.cur;      // start from exactly what is on screen, so nothing jumps
  palette.from = palette.to;
  palette.to = unlocked - 1;
  palette.t = 0;
  palette.hold = 0;
  palette.rush = 1;
  palette.rushId++;
  wash = {
    t: 0, life: CFG.paletteRules.unlockWashTime,
    x: lastTouchX || cssW / 2, y: lastTouchY || cssH * 0.5,
    c1: nx.ring, c2: nx.star,
  };
}

/* ========================================================================== */
/* Glow sprite cache                                                          */
/* ========================================================================== */

const SPRITE_SIZE = 128;
const spriteCache = new Map();

// Help-sheet display lists, keyed by section id + width. Declared up here beside the other
// render caches because resizeLayers clears it, and resizeLayers runs during module init —
// long before the help block further down has been evaluated.
const layoutCache = new Map();

function glowSprite(hex) {
  let s = spriteCache.get(hex);
  if (s) return s;
  if (spriteCache.size > CFG.render.spriteCacheMax) spriteCache.clear();   // an unlock rush churns keys fast
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

/* -- atmosphere plates ------------------------------------------------------
 * The background used to be a two-stop gradient allocated fresh EVERY FRAME, plus flat star
 * dots, and nothing at all existed below about 62% of the screen height. These four bitmaps
 * hold everything that is slow to draw and almost never changes: the gradient, a horizon glow,
 * colour clouds, and a noise tile to stop near-black gradients banding on an OLED panel.
 *
 * They are rendered at half CSS size and upscaled. Everything on them is a soft gradient, so
 * the resample is free blur — the same argument the bloom pass already makes. Per-frame cost
 * for the whole sky is one drawImage, against four gradient allocations and 88 arc fills.
 */
const skyPlate = document.createElement('canvas');       // gradient + horizon + nebula + grain
const skyPlateCtx = skyPlate.getContext('2d');
const skyPlateCalm = document.createElement('canvas');   // the same, desaturated, for CALM
const skyPlateCalmCtx = skyPlateCalm.getContext('2d');
const nebPlate = document.createElement('canvas');       // clouds only, transparent, for FRENZY
const nebPlateCtx = nebPlate.getContext('2d');
const vigPlate = document.createElement('canvas');       // pure black vignette, palette-independent
const vigPlateCtx = vigPlate.getContext('2d');

let plateKey = '';
let plateDirty = 0;        // bitmask: 1 skyPlate, 2 skyPlateCalm, 4 nebPlate
let platesReady = false;
let grainCanvas = null;

/** Plate pixel size: covers the shake overfill, floored so a tiny window still gets a plate. */
function plateSize() {
  const S = CFG.sky;
  const m = CFG.effects.shakeMax * scale() + 2;
  return [
    Math.max(S.plateScaleMin, Math.round((cssW + m * 2) * S.plateScale)),
    Math.max(S.plateScaleMin, Math.round((cssH + m * 2) * S.plateScale)),
  ];
}

/**
 * A white noise tile. White with a random ALPHA, never a grey fill: a grey fill composited
 * additively would lift the black floor by its own mean, and the black floor is what makes the
 * additive trails read as the brightest thing on screen.
 */
function grainTile() {
  if (grainCanvas) return grainCanvas;
  const S = CFG.sky;
  const n = Math.max(4, S.grainTile | 0);
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const img = g.createImageData(n, n);
  const d = img.data;
  for (let i = 0; i < n * n; i++) {
    d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255;
    d[i * 4 + 3] = (Math.random() * S.grainAmp) | 0;
  }
  g.putImageData(img, 0, 0);
  grainCanvas = c;
  return c;
}

/** Steps 2 and 3 of the plate — the horizon glow and the colour clouds. Shared by three plates. */
function paintAtmosphere(g, P, pw, ph) {
  const S = CFG.sky;
  g.globalCompositeOperation = 'lighter';
  // Anchored BELOW the frame so only the top of the falloff shows: it reads as light coming
  // from under the world rather than as a circle somebody drew near the bottom.
  const hy = ph * S.horizonY, hr = ph * S.horizonRadius;
  const hg = g.createRadialGradient(pw * 0.5, hy, 0, pw * 0.5, hy, hr);
  hg.addColorStop(0.00, rgba(P.fog, S.horizonAlpha));
  hg.addColorStop(0.55, rgba(P.fog, S.horizonAlpha * 0.35));
  hg.addColorStop(1.00, rgba(P.fog, 0));
  g.fillStyle = hg;
  g.fillRect(0, 0, pw, ph);

  // Clouds cycle fog -> ring -> star, so every world brings its own weather and it crossfades
  // with the palette drift for free. Spots are fixed rather than save-derived: a brand-new
  // player has no milestones and therefore no stars, and still deserves a sky with something in it.
  const cols = [P.fog, P.ring, P.star];
  const n = Math.max(0, Math.min(S.nebulaMax, S.nebulaCount | 0));
  for (let i = 0; i < n; i++) {
    const sp = S.nebulaSpots[i % S.nebulaSpots.length];
    const cx = sp[0] * pw, cy = sp[1] * ph;
    const r = Math.max(1, S.nebulaRadius * Math.min(pw, ph) * sp[2]);
    const col = cols[i % cols.length];
    const ng = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    ng.addColorStop(0.00, rgba(col, S.nebulaAlpha));
    ng.addColorStop(S.nebulaMidStop, rgba(col, S.nebulaAlpha * S.nebulaMidMul));
    ng.addColorStop(1.00, rgba(col, 0));
    g.fillStyle = ng;
    g.fillRect(0, 0, pw, ph);
  }
  g.globalCompositeOperation = 'source-over';
}

function buildPlate(canvasEl, g, P, opaque) {
  const S = CFG.sky;
  const [pw, ph] = plateSize();
  if (canvasEl.width !== pw || canvasEl.height !== ph) { canvasEl.width = pw; canvasEl.height = ph; }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, pw, ph);
  if (opaque) {
    // Four stops, not two. The mid stop sits above the halfway mix so the top of the screen
    // stays properly dark — the balls need black to burn against — while the bottom finally
    // has a colour in it at all.
    const grad = g.createLinearGradient(0, 0, 0, ph);
    grad.addColorStop(0.00, P.bg0);
    grad.addColorStop(S.bgMidStop, mixHex(P.bg0, P.bg1, S.bgMidMix));
    grad.addColorStop(0.78, P.bg1);
    grad.addColorStop(1.00, mixHex(P.bg1, P.fog, S.bgFloorMix));
    g.fillStyle = grad;
    g.fillRect(0, 0, pw, ph);
  }
  paintAtmosphere(g, P, pw, ph);
  if (opaque && S.grainAlpha > 0) {
    const pat = g.createPattern(grainTile(), 'repeat');
    if (pat) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = S.grainAlpha;
      g.fillStyle = pat;
      g.fillRect(0, 0, pw, ph);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
  }
}

function buildVigPlate() {
  const S = CFG.sky;
  const [pw, ph] = plateSize();
  if (vigPlate.width !== pw || vigPlate.height !== ph) { vigPlate.width = pw; vigPlate.height = ph; }
  const g = vigPlateCtx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, pw, ph);
  const mx = Math.max(pw, ph);
  const vg = g.createRadialGradient(pw / 2, ph / 2, mx * S.vignetteInner, pw / 2, ph / 2, mx * S.vignetteOuter);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = vg;
  g.fillRect(0, 0, pw, ph);
}

function plateKeyFor() {
  const S = CFG.sky;
  return palette.key + '|' + lastW + 'x' + lastH + '|' + S.nebulaCount + '|' + S.nebulaAlpha
    + '|' + S.horizonAlpha + '|' + S.grainAlpha + '|' + S.calmChromaDrop;
}

function ensurePlates(P) {
  const key = plateKeyFor();
  if (key !== plateKey) { plateKey = key; plateDirty = 7; }
  const calmP = () => {
    const S = CFG.sky;
    const c = Object.assign({}, P);
    c.bg0 = chroma(P.bg0, -S.calmChromaDrop);
    c.bg1 = chroma(P.bg1, -S.calmChromaDrop);
    return c;
  };
  if (!platesReady) {
    buildPlate(skyPlate, skyPlateCtx, P, true);
    buildPlate(skyPlateCalm, skyPlateCalmCtx, calmP(), true);
    buildPlate(nebPlate, nebPlateCtx, P, false);
    if (!vigPlate.width || vigPlate.width < 2) buildVigPlate();
    plateDirty = 0;
    platesReady = true;
    return;
  }
  // One plate per frame. Two full rebuilds landing on the same frame is the only spike here,
  // and a plate that is one frame stale is invisible: the colour delta per palette-key step
  // is smaller than one quantisation step.
  if (plateDirty & 1) { buildPlate(skyPlate, skyPlateCtx, P, true); plateDirty &= ~1; }
  else if (plateDirty & 2) { buildPlate(skyPlateCalm, skyPlateCalmCtx, calmP(), true); plateDirty &= ~2; }
  else if (plateDirty & 4) { buildPlate(nebPlate, nebPlateCtx, P, false); plateDirty &= ~4; }
}

let cssW = 1, cssH = 1, dpr = 1;
let bloomScale = CFG.render.bloomScale;
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

let lastW = -1, lastH = -1, lastDpr = -1;

function resizeLayers(force) {
  const [w, h] = measure();
  const d = Math.max(1, Math.min(CFG.render.dprCap, window.devicePixelRatio || 1));
  // Insets can change without the size changing, so read them before the guard.
  readSafeArea();
  // iOS fires resize and visualViewport-resize liberally — scrolling chrome, the keyboard,
  // rotation settling — and most of them report the same size. Assigning canvas.width at
  // all resets the bitmap even to the same value, which would wipe the accumulated trail
  // layer and reallocate four backing stores for nothing.
  if (!force && w === lastW && h === lastH && d === lastDpr) return;
  lastW = w; lastH = h; lastDpr = d;
  dpr = d;
  cssW = w; cssH = h;

  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  trail.width = canvas.width;
  trail.height = canvas.height;
  trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  rebuildBloom();
  // The plates are sized from cssW/cssH, so they are stale the moment those change.
  plateKey = ''; platesReady = false;
  buildVigPlate();
  layoutCache.clear();   // every op in it was measured against the old width

  if (sim) simResize(sim, cssW, cssH);
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
  config: BASE_CONFIG,
  rng: makeRng(seed),
  width: iw, height: ih,
  save: savedState,
});

CFG = sim.config;                 // from here on, the live upgraded config
let sky = deriveStars(savedState, CFG);

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
let flashCol = null;
let flashAdd = false;
let shake = 0;
let celebration = null;    // { text, sub, t, life, big }
let vortexRings = [];      // live double-tap wells, drawn as counter-rotating arcs
let converts = [];         // a ball changing type: old colour collapsing, new colour blooming out
let tracers = [];          // a line from the announcement to the thing it names
let capGlory = 0;          // countdown on the level-100 display
let particleBudget = CFG.effects.maxParticles;
let uiDt = 1 / 60;            // real seconds this frame, for hold timers (see frame())
let shakeX = 0, shakeY = 0;   // this frame's shake offset, so the sky can lag behind it
// Atmosphere detail tier, shed before physics ever is: 2 = everything, 1 = no FRENZY cloud
// flare, 0 = also no CALM desaturation pass, fewer stars, no constellation lines. The vignette
// is never shed — it is one blit and it carries the whole contrast story.
let bgTier = 2;

let softResets = 0;

function softResetEffects() {
  particles.length = 0;
  popups.length = 0;
  waves.length = 0;
  arcs.length = 0;
  vortexRings.length = 0;
  converts.length = 0;
  tracers.length = 0;
  proofs.length = 0;
  wash = null;
  shooting = null;
  flash = 0; shake = 0;
  celebration = null;
  // A throw between ctx.save() and ctx.restore() leaks state-stack entries every frame.
  // Unwind a bounded number of them and re-establish a known-good transform.
  try {
    for (let i = 0; i < 16; i++) ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  } catch (_) {}
  try {
    trailCtx.setTransform(1, 0, 0, 1, 0, 0);
    trailCtx.clearRect(0, 0, trail.width, trail.height);
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } catch (_) {}
  // Drop derived render state so the next frame rebuilds it. Without this a reset cannot
  // recover from a corrupt palette, which is the exact case that wedged the renderer.
  palette.cur = null;
  palette.key = '';
  palette.fromP = null; palette.rush = 0;
  plateKey = ''; platesReady = false;
  spriteCache.clear();
  // Counted rather than logged: the ring buffer is small, and a reset message evicting the
  // error that CAUSED it is how you lose the only evidence you had.
  softResets++;
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

let popupBudget = 0;

function addPopup(x, y, text, color, big, amount) {
  // Merge first: a cascade lands dozens of hits in one small area, and one growing number
  // reads far better than forty overlapping ones.
  const r = CFG.effects.popupMergeRadius * scale();
  for (const p of popups) {
    if (p.t < CFG.score.popupMerge * 4 && Math.abs(p.x - x) < r && Math.abs(p.y - y) < r) {
      p.amount = (p.amount || 0) + (amount || 0);
      p.text = formatScore(p.amount);
      p.size = Math.min(p.size * 1.05, 30);
      p.t = Math.min(p.t, CFG.effects.popupLife * 0.25);   // restart its rise
      return;
    }
  }
  // Then rate-limit. Score here is mostly aesthetic, so past the budget only the big ones
  // are worth interrupting the picture for.
  if (popupBudget <= 0 && !big) return;
  popupBudget -= 1;
  if (popups.length >= CFG.effects.popupMax) popups.shift();
  popups.push({
    x, y, text, color, amount: amount || 0, t: 0,
    life: CFG.effects.popupLife, size: big ? 21 : 15,
  });
}

function addWave(x, y, r, strength, color) {
  if (waves.length > 28) waves.shift();
  waves.push({ x, y, r0: r * 0.18, r1: r, t: 0, life: CFG.effects.shockwaveTime, strength, color });
}

function addArc(x1, y1, x2, y2, color, depth) {
  if (arcs.length > 60) arcs.shift();
  arcs.push({
    x1, y1, x2, y2, t: 0, life: CFG.types.CHAIN.arcTime, color,
    delay: (depth || 0) * CFG.types.CHAIN.hopDelay,
    seed: Math.random() * 1000,
  });
}

function addFlash(amount, col, additive) {
  flashMax = Math.max(flashMax, Math.min(CFG.effects.flashMaxAlpha, amount));
  flash = CFG.effects.flashTime;
  flashCol = col || null;
  // An impact keeps the old veil. A reward is a LIFT: veiling the screen at the exact moment
  // something good happens dims the HUD, the balls and the reward itself, which is backwards.
  flashAdd = !!additive;
}

function addShake(amount) {
  shake = Math.min(CFG.effects.shakeMax * scale(), shake + amount);
}

function scale() { return sim.scale; }

/* ---- translate sim events into visuals ----------------------------------- */

function consumeEvents(P) {
  const inten = sim.intensity;
  const loud = inten > CFG.intensity.frenzyAbove;
  for (const ev of sim.events) {
    switch (ev.type) {
      case 'impact': {
        const n = Math.round(CFG.effects.impactSparks * (0.4 + Math.min(2.2, ev.speed)) * qualityMul());
        spawnParticles(ev.x, ev.y, n, 120 * scale() * Math.min(3, ev.speed), P.fog, 0.42, 1.7 * scale());
        if (ev.speed > 2.2) addShake(1.1 * scale() * Math.min(2.5, ev.speed - 1.5));
        break;
      }
      case 'score':
        addPopup(ev.x, ev.y, formatScore(ev.amount), ev.amount > 900 ? P.ring : P.hud,
          ev.amount > 900, ev.amount);
        break;
      case 'detonate':
        spawnParticles(ev.x, ev.y, Math.round(CFG.effects.detonateSparks * qualityMul()),
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
        spawnParticles(ev.x, ev.y, Math.round(CFG.effects.shatterSparks * qualityMul()),
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
      case 'pulse':
        addWave(ev.x, ev.y, ev.r, 1.5, P.ring);
        addWave(ev.x, ev.y, ev.r * 0.55, 1.1, P.hud);
        spawnParticles(ev.x, ev.y, Math.round(22 * qualityMul()), 520 * scale(), P.ring, 0.5, 2.1 * scale());
        addShake(CFG.tap.pulseShake * scale());
        addFlash(0.07);
        break;
      case 'vortex':
        vortexRings.push({ x: ev.x, y: ev.y, r: ev.r, t: 0, life: ev.life });
        spawnParticles(ev.x, ev.y, Math.round(16 * qualityMul()), 180 * scale(), P.type.MAGNET, 0.8, 1.9 * scale());
        break;
      case 'vortexEnd':
        addWave(ev.x, ev.y, CFG.tap.vortexRadius * scale() * 0.8, 1.0, P.type.MAGNET);
        spawnParticles(ev.x, ev.y, Math.round(18 * qualityMul()), 420 * scale(), P.type.MAGNET, 0.6, 2 * scale());
        break;
      case 'sling':
        addWave(ev.x, ev.y, CFG.gather.captureRadius * scale(), 1.2, P.ring);
        spawnParticles(ev.x, ev.y, Math.round(Math.min(30, ev.count * 2) * qualityMul()),
          420 * scale(), P.ring, 0.6, 2 * scale());
        addShake(2.4 * scale());
        break;
      case 'resonance':
        addWave(ev.x, ev.y, 120 * scale(), 1.5, P.star);
        addFlash(0.12);
        break;
      case 'levelup':
        // The one moment a wordless toy has any business pointing at its own documentation:
        // the first time something happened that the player did not ask for. Once, ever.
        if (!sim.seenHelp && helpBreadcrumb === 0) helpBreadcrumb = CFG.help.breadcrumbTime;
        // Deliberately nothing. sim.js pushes `levelup` immediately AFTER `upgrade`, and every
        // level from 2 to the cap has an upgrade, so the celebration this used to raise was
        // always stomped by the one already on screen — it had never once run. The level number
        // now lives in the persistent line under the bar, where it can be read at leisure.
        break;
      case 'upgrade': {
        // Every level hands over something with a name. Ball types and colour worlds get
        // the loud treatment; the rest still announce themselves.
        const up = (CFG.upgrades || []).find((u) => u.id === ev.id) || null;
        const loud = ev.kind === 'type' || ev.kind === 'palette';
        const tint = upgradeTint(P, up);
        celebrate(ev.palette || ev.label, ev.kind === 'type' ? 'new ball' :
          (ev.kind === 'palette' ? 'new sky' : ''), loud, 0, tint);
        addFlash(loud ? CFG.effects.flashUpgradeAlpha : CFG.effects.flashMinorAlpha, tint, true);
        spawnParticles(cssW / 2, cssH * 0.42, Math.round(CFG.effects.upgradeBurst * qualityMul()),
          340 * scale(), tint, 0.7, 2.0 * scale());
        if (loud) addShake(3 * scale());
        // A new world has to arrive while the word announcing it is still on screen.
        if (ev.kind === 'palette') retargetPalette();
        // ...and a sky upgrade has to be visible in the sky it changed, this frame.
        if (up && up.path && up.path.indexOf('sky.') === 0) { plateKey = ''; platesReady = false; }
        queueProof(P, up, tint);
        break;
      }
      case 'convert': {
        // An ORB becoming something else. Drawn as a transmutation rather than a spawn, because
        // that is exactly what it is: the same ball, now a different kind of ball.
        const col = P.type[ev.ballType] || P.hud;
        if (converts.length > 12) converts.shift();
        converts.push({ x: ev.x, y: ev.y, r: ev.r, t: 0, life: CFG.proof.convertTime, col });
        addWave(ev.x, ev.y, 26 * scale(), 0.8, col);
        spawnParticles(ev.x, ev.y, Math.round(12 * qualityMul()), 200 * scale(), col, 0.6, 1.9 * scale());
        // While the name is still on screen, draw the eye from the word to the thing it names.
        if (celebration) {
          if (tracers.length > 12) tracers.shift();
          tracers.push({ x: ev.x, y: ev.y, t: 0, life: CFG.proof.tracerTime, col });
        }
        break;
      }
      case 'levelcap':
        // Drawn by its own pass, not through `celebration` — an ordinary level flourish
        // arriving in the same frame would otherwise stomp the one moment that matters.
        capGlory = CFG.levels.capCelebrateTime;
        celebration = null;
        addFlash(0.22);
        addShake(9 * scale());
        break;
      case 'milestone':
        celebrate(ev.kind === 'comet' ? 'COMET' : formatScore(ev.value), 'milestone', true,
          CFG.milestones.celebrateTime);
        addFlash(0.18);
        addShake(5 * scale());
        sky = deriveStars(serializeSave(sim), CFG);
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

function celebrate(text, sub, big, life, tint) {
  // An unlock outranks a level-up: do not let a routine flourish stomp one mid-play.
  if (celebration && celebration.big && !big && celebration.t < celebration.life * 0.5) return;
  celebration = {
    text, sub, t: 0, big, tint: tint || null,
    life: life || (big ? CFG.levels.unlockCelebrateTime : CFG.levels.levelCelebrateTime),
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

  popupBudget = Math.min(CFG.effects.popupRate, popupBudget + CFG.effects.popupRate * dt);
  if (hintFade > 0) hintFade = Math.max(0, hintFade - dt);
  if (lastUpShown) lastUpT += dt;
  if (wash) { wash.t += dt; if (wash.t >= wash.life) wash = null; }
  updateShooting(dt, 1 - Math.min(1, sim.intensity / Math.max(1e-6, CFG.intensity.calmBelow)));
  w = 0;
  for (let i = 0; i < proofs.length; i++) {
    const pr = proofs[i];
    pr.t += dt;
    if (pr.t >= pr.life) continue;
    proofs[w++] = pr;
  }
  proofs.length = w;

  w = 0;
  for (let i = 0; i < converts.length; i++) {
    const c = converts[i];
    c.t += dt;
    if (c.t >= c.life) continue;
    converts[w++] = c;
  }
  converts.length = w;

  w = 0;
  for (let i = 0; i < tracers.length; i++) {
    const tr = tracers[i];
    tr.t += dt;
    if (tr.t >= tr.life) continue;
    tracers[w++] = tr;
  }
  tracers.length = w;

  let vw = 0;
  for (let i = 0; i < vortexRings.length; i++) {
    const v = vortexRings[i];
    v.t += dt;
    if (v.t >= v.life) continue;
    vortexRings[vw++] = v;
  }
  vortexRings.length = vw;
  if (capGlory > 0) capGlory = Math.max(0, capGlory - dt);
  if (flash > 0) flash = Math.max(0, flash - dt);
  if (flash === 0) { flashMax = 0; flashCol = null; flashAdd = false; }
  if (shake > 0) shake = Math.max(0, shake - shake * CFG.effects.shakeDecay * dt - 0.01);
  if (celebration) {
    celebration.t += dt;
    if (celebration.t >= celebration.life) celebration = null;
  }
}

function qualityMul() {
  return particleBudget / Math.max(1, CFG.effects.maxParticles);
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
// One-finger tap powers. Recognition lives here because it needs a clock; the sim just
// receives the resulting taps and stays deterministic.
const pendingTaps = [];
let lastTapTime = -99;
let lastTapX = 0, lastTapY = 0;
let debugOn = FORCE_DEBUG || CFG.debug.enabled;
let wipeHold = 0;
let wipeDone = 0;
let cornerHold = 0;
let cornerArmed = true;   // Cleared once a hold fires, so one long press is one toggle.

function canvasPos(e) {
  let rect = { left: 0, top: 0 };
  try { rect = canvas.getBoundingClientRect(); } catch (_) {}
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function onPointerDown(e) {
  try {
    if (SOAK) return;
    const [x, y] = canvasPos(e);
    // Help is checked FIRST and swallows everything: a thumb reading a page must not also be
    // playing the toy underneath it.
    if (helpDown(x, y)) { e.preventDefault(); return; }
    if (upgradeMenuHit(x, y)) { e.preventDefault(); return; }
    if (debugButtonHit(x, y)) { e.preventDefault(); return; }
    if (pointers.size === 0) { gestureStart = nowSec(); gestureMaxDown = 0; gestureMoved = 0; }
    pointers.set(e.pointerId, { x, y });
    lastTouchX = x; lastTouchY = y;   // a new world's light-front is thrown from your fingertip
    gestureMaxDown = Math.max(gestureMaxDown, pointers.size);
    if (!seenHint) { seenHint = true; hintFade = CFG.input.hintFadeTime; writeSave(true); }
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  } catch (err) { logError('input', err.message); }
}

function onPointerMove(e) {
  try {
    if (SOAK) return;
    if (help.open) { const [hx, hy] = canvasPos(e); helpMove(hx, hy); e.preventDefault(); return; }
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
    if (help.open) { helpUp(); e.preventDefault(); return; }
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    // pointercancel (iOS system gestures), pointerleave and blur must CLEAR the field
    // rather than sling it. A stuck invisible field is the bug you would otherwise report.
    if (isCancel) cancelled.push(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (pointers.size === 0) {
      const dur = nowSec() - gestureStart;
      const still = gestureMoved < 26;
      // ONE finger, quick, barely moved: a tap power rather than a flick of the field.
      if (gestureMaxDown === 1 && dur < CFG.tap.maxTime && gestureMoved < CFG.tap.maxMove) {
        const [tx, ty] = canvasPos(e);
        const t = nowSec();
        const near = Math.hypot(tx - lastTapX, ty - lastTapY) < CFG.tap.maxMove * 4;
        const isDouble = (t - lastTapTime) < CFG.tap.doubleWindow && near;
        pendingTaps.push({ x: tx, y: ty, double: isDouble });
        // Consume the pair, so a triple tap is tap + vortex + tap rather than two vortices.
        lastTapTime = isDouble ? -99 : t;
        lastTapX = tx; lastTapY = ty;
      }
      if (dur < CFG.input.debugTapMaxTime && still) {
        if (gestureMaxDown >= CFG.input.debugFingers) {
          debugOn = !debugOn;
          if (!debugOn) upgradeMenu.open = false;
          twoFingerTapCount = 0;
        } else if (gestureMaxDown === CFG.input.upgradeMenuFingers && debugOn) {
          // The phone has no keyboard, so the upgrade menu needs a gesture of its own.
          upgradeMenu.open = !upgradeMenu.open;
        } else if (gestureMaxDown === CFG.input.scatterFingers) {
          const t = nowSec();
          twoFingerTapCount = (t - lastTwoFingerTap < CFG.input.scatterTapWindow) ? twoFingerTapCount + 1 : 1;
          lastTwoFingerTap = t;
          if (twoFingerTapCount >= CFG.input.scatterTapCount) {
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
    if (e.key === '?' || e.key === 'h' || e.key === 'H') { if (help.open) closeHelp(); else openHelp(null, 0); }
    else if (e.key === 'Escape') { if (help.open) closeHelp(); }
    else if (help.open && e.key === 'ArrowDown') help.scroll += 60;
    else if (help.open && e.key === 'ArrowUp') help.scroll -= 60;
    else if (help.open) { /* the sheet has the keyboard */ }
    else if (e.key === 'd' || e.key === 'D') debugOn = !debugOn;
    else if (e.key === 'u' || e.key === 'U') { upgradeMenu.open = !upgradeMenu.open; if (upgradeMenu.open) debugOn = true; }
    else if (e.key === 'r' || e.key === 'R') scatterRequest = true;
    else if (e.key === 'ArrowRight') upgradeMenu.page++;
    else if (e.key === 'ArrowLeft') upgradeMenu.page--;
  });
} catch (e) { logError('input', 'listener setup: ' + e.message); }

/* ---- soak: synthetic multi-touch for hands-free stress runs --------------- */

const soakPointers = [];
if (SOAK) {
  for (let i = 0; i < CFG.input.soakPointers; i++) {
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
      p.timer = 0.3 + Math.random() * (2 / Math.max(0.01, CFG.input.soakChangeRate));
      if (!p.down) {
        p.down = true;
        p.x = Math.random() * cssW; p.y = Math.random() * cssH;
        p.hold = Math.random() < CFG.input.soakHoldChance ? 0.6 + Math.random() * 1.8 : 0;
      } else if (Math.random() < 0.42) {
        p.down = false;
        // Exercise the pointercancel path too, not only clean releases.
        if (Math.random() < 0.3) cancelled.push(p.id);
      } else {
        p.tx = Math.random() * cssW; p.ty = Math.random() * cssH;
        p.hold = Math.random() < CFG.input.soakHoldChance ? 0.6 + Math.random() * 1.8 : 0;
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
  if (Math.random() < 0.012) {
    pendingTaps.push({ x: Math.random() * cssW, y: Math.random() * cssH, double: Math.random() < 0.35 });
  }
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
    taps: pendingTaps.length ? pendingTaps.slice() : null,
    scatter: scatterRequest,
  };
  cancelled.length = 0;
  pendingTaps.length = 0;
  scatterRequest = false;
  return input;
}

/* ========================================================================== */
/* Drawing                                                                    */
/* ========================================================================== */

/**
 * The whole sky, in blits.
 *
 * ORDERING RULE that must never be "tidied": every line of this runs BEFORE the additive trail
 * composite. Move the vignette after it and it dims the balls and the HUD too, and the change
 * reads to a player as "the game got darker" rather than "the frame closed in".
 */
function drawBackground(P, calmT, frenzyT) {
  ensurePlates(P);
  // Overfill by the shake amplitude: the whole scene is drawn under a translate during a
  // shake, so filling exactly (0,0,cssW,cssH) leaves an unpainted strip at the trailing
  // edge which smears last frame's pixels.
  const m = CFG.effects.shakeMax * scale() + 2;
  const W = cssW + m * 2, H = cssH + m * 2;

  ctx.drawImage(skyPlate, -m, -m, W, H);
  // Quiet desaturates the ROOM, never the balls. They keep every bit of their colour against a
  // sky that has gone grey around them, which is most of what makes CALM feel like a held breath.
  if (calmT > 0.02 && bgTier > 0) {
    ctx.globalAlpha = calmT;
    ctx.drawImage(skyPlateCalm, -m, -m, W, H);
    ctx.globalAlpha = 1;
  }
  // ...and chaos makes the clouds flare. Zero cost at rest: the branch never runs outside FRENZY.
  if (frenzyT > 0.02 && bgTier > 1) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = CFG.sky.nebulaFrenzyGain * frenzyT;
    ctx.drawImage(nebPlate, -m, -m, W, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // A new world announces itself as an expanding front of its own light, thrown from wherever
  // your finger was. Composited 'lighter' so it lifts the scene instead of veiling it.
  if (wash) {
    const k = Math.min(1, wash.t / wash.life);
    const a = Math.sin(k * Math.PI) * CFG.paletteRules.unlockWashAlpha;
    const rad = Math.max(1, Math.hypot(cssW, cssH) * 1.15 * (1 - Math.pow(1 - k, 4)));
    const g2 = ctx.createRadialGradient(wash.x, wash.y, 0, wash.x, wash.y, rad);
    g2.addColorStop(0.00, rgba(wash.c1, 0));
    g2.addColorStop(0.86, rgba(wash.c1, a * 0.55));
    g2.addColorStop(0.94, rgba(wash.c2, a));
    g2.addColorStop(1.00, rgba(wash.c1, 0));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g2;
    ctx.fillRect(-m, -m, W, H);
    ctx.restore();
  }

  drawStars(P, calmT);
  drawVignette(calmT, frenzyT);
}

/**
 * The stars: permanent, save-derived, and best seen when nothing is happening.
 *
 * Two changes from flat dots. They are drawn as soft sprites at three alpha buckets instead of
 * 88 individually-built rgba strings, and they parallax against the screen shake instead of
 * translating with it in perfect lockstep — which read as a decal stuck to the glass.
 */
function drawStars(P, calmT) {
  const S = CFG.sky;
  const skyAlpha = wash ? 1 : calmT + (1 - calmT) * S.calmOnlyAlpha;
  if (!sky.stars.length || skyAlpha <= 0.02) return;
  const t = sim.time;
  const n = bgTier === 0 ? Math.min(sky.stars.length, S.shedStars) : sky.stars.length;
  ctx.save();
  // Counter-translate by a fraction of the shake: the sky is far away, so it should lag.
  ctx.translate(-shakeX * S.parallax, -shakeY * S.parallax);
  if (sky.links.length && bgTier > 0) {
    ctx.strokeStyle = rgba(P.star, S.linkAlpha * skyAlpha);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (const [i, j] of sky.links) {
      const a = sky.stars[i], b = sky.stars[j];
      if (!a || !b) continue;
      ctx.moveTo(a.x * cssW, a.y * cssH);
      ctx.lineTo(b.x * cssW, b.y * cssH);
    }
    ctx.stroke();
  }
  // One fillStyle for the whole field, one path per alpha bucket. Rounding alpha to a handful
  // of buckets is invisible on a star and removes 88 string builds and 88 state changes.
  const buckets = Math.max(1, S.alphaBuckets | 0);
  for (let bi = 0; bi < buckets; bi++) {
    const lo = bi / buckets, hi = (bi + 1) / buckets;
    const a = (lo + hi) * 0.5 * skyAlpha;
    if (a <= 0.012) continue;
    let any = false;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const st = sky.stars[i];
      const tw = 1 + CFG.render.starTwinkle * Math.sin(t * S.twinkleRate * 6.28 + (st.seed % 1000) * 0.017);
      const m2 = Math.min(1, st.mag * tw);
      if (m2 < lo || m2 >= hi) continue;
      const r = 0.7 + st.mag * 1.4;
      ctx.moveTo(st.x * cssW + r, st.y * cssH);
      ctx.arc(st.x * cssW, st.y * cssH, r, 0, 6.283);
      any = true;
    }
    if (any) { ctx.fillStyle = rgba(P.star, a); ctx.fill(); }
  }
  // A soft halo under the field, so stars read as light rather than as pixels. One extra pass
  // over the same paths at a large radius would be expensive, so it is folded into the brightest
  // bucket only — the dim ones do not carry a visible halo anyway.
  const glow = S.starGlow;
  if (glow > 1.001 && bgTier > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba(P.star, 0.05 * skyAlpha * (glow - 1));
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const st = sky.stars[i];
      if (st.mag < 0.5) continue;
      const r = (0.7 + st.mag * 1.4) * 3.4 * glow;
      ctx.moveTo(st.x * cssW + r, st.y * cssH);
      ctx.arc(st.x * cssW, st.y * cssH, r, 0, 6.283);
    }
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  if (shooting) drawShooting(P, skyAlpha);
  ctx.restore();
}

/**
 * A shooting star. The only thing in the game that rewards sitting still and not touching
 * anything, so it fires in CALM and nowhere else — if it could happen mid-rally it would be
 * just another particle in a screen already full of them.
 */
let shooting = null;

function updateShooting(dt, calmT) {
  const S = CFG.sky;
  if (shooting) {
    shooting.t += dt;
    if (shooting.t >= S.shootingTime) shooting = null;
    return;
  }
  if (calmT < 0.999 || sim.untouchedTime < CFG.intensity.calmSettleTime) return;
  if (Math.random() >= S.shootingChancePerSec * dt) return;
  const diag = Math.hypot(cssW, cssH);
  const ang = (Math.random() * 0.7 + 0.25) * Math.PI;      // down and across, never straight up
  shooting = {
    t: 0,
    x0: Math.random() * cssW, y0: Math.random() * cssH * 0.5,
    dx: Math.cos(ang), dy: Math.abs(Math.sin(ang)) * 0.55,
    len: diag * S.shootingLength,
    travel: diag * 0.55,
  };
}

function drawShooting(P, skyAlpha) {
  const S = CFG.sky;
  const k = shooting.t / S.shootingTime;
  const a = Math.sin(k * Math.PI) * S.shootingAlpha * skyAlpha;
  if (a <= 0.01) return;
  const x = shooting.x0 + shooting.dx * shooting.travel * k;
  const y = shooting.y0 + shooting.dy * shooting.travel * k;
  const tx = x - shooting.dx * shooting.len;
  const ty = y - shooting.dy * shooting.len;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(x, y, tx, ty);
  g.addColorStop(0, rgba(P.star, a));
  g.addColorStop(1, rgba(P.star, 0));
  ctx.strokeStyle = g;
  ctx.lineWidth = 1.6 * scale();
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.restore();
}

/**
 * The frame closing in. One black bitmap and one alpha, and it carries more of the CALM/FRENZY
 * contrast than anything else in the renderer — because it makes every orb read brighter in
 * FRENZY without adding a single lumen to a stack that already clips. Pure black, pure
 * source-over, so it can never tint a palette colour. Never shed: it is one blit.
 */
function drawVignette(calmT, frenzyT) {
  const S = CFG.sky;
  const a = calmT > 0
    ? S.vignetteCalm + (S.vignette - S.vignetteCalm) * (1 - calmT)
    : S.vignette + (S.vignetteFrenzy - S.vignette) * frenzyT;
  if (a <= 0.01 || vigPlate.width < 2) return;
  const m = CFG.effects.shakeMax * scale() + 2;
  ctx.globalAlpha = Math.min(1, a);
  ctx.drawImage(vigPlate, -m, -m, cssW + m * 2, cssH + m * 2);
  ctx.globalAlpha = 1;
}

/**
 * How many of the palette's orb hues are in play.
 *
 * Hoisted once per frame into `orbHueN` rather than recomputed inside ballColor, which runs
 * about three hundred times a frame across two passes.
 */
function orbHueCount(P) {
  const F = CFG.render;
  return Math.max(1, Math.min(P.orbHues.length,
    F.orbHueBase + Math.floor(sim.palettesUnlocked / F.orbHuePerPalettes)));
}
let orbHueN = CFG.render.orbHueBase;

function ballColor(P, b) {
  if (b.type === 'ORB') return P.orbHues[b.hue % orbHueN];
  return P.type[b.type] || P.orbHues[0];
}

/** Glow + core into the TRAIL layer, so movement leaves a streak. */
function drawBallsToTrail(P) {
  const g = trailCtx;
  g.globalCompositeOperation = 'lighter';
  const gs = CFG.balls.glowScale;
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

  const sr = CFG.types.PRISM.shardRadius * scale();
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
          const k = 1 - b.inertT / CFG.types.VOLATILE.inertTime;
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
        const lines = CFG.types.MAGNET.fieldLines;
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
          const r0 = b.r * 1.25, r1 = b.r * (1.75 + 0.35 * Math.sin(t * CFG.types.GOLD.glitterRate * 0.3 + i));
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

function drawVortices(P) {
  if (vortexRings.length === 0) return;
  const t = sim.time;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const v of vortexRings) {
    const k = v.t / Math.max(1e-6, v.life);
    const a = Math.min(1, Math.sin(Math.min(1, k * 1.02) * Math.PI) * 2.2);
    if (a <= 0.01) continue;
    // Three arcs winding inward: reads as something actively pulling, not a static ring.
    for (let i = 0; i < 3; i++) {
      const rr = v.r * (1 - i * 0.22) * (1 - k * 0.45);
      const spin = t * (2.6 + i * 0.9) * (i % 2 ? -1 : 1);
      ctx.strokeStyle = rgba(i === 1 ? P.ring : P.type.MAGNET, a * (0.5 - i * 0.11));
      ctx.lineWidth = Math.max(1, (2.6 - i * 0.6) * scale());
      ctx.beginPath();
      ctx.arc(v.x, v.y, Math.max(2, rr), spin, spin + 2.1);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(P.ring, a * 0.5);
    ctx.beginPath();
    ctx.arc(v.x, v.y, Math.max(1, 4 * scale() * (1 - k)), 0, 6.283);
    ctx.fill();
  }
  ctx.restore();
}

function drawComet(P) {
  const c = sim.comet;
  if (!c) return;
  const r = CFG.comet.radius * scale();
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
  ctx.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + 6.283 * (c.hp / CFG.comet.hp));
  ctx.stroke();
  ctx.restore();
}

/* ---- fields, combo ring, filigree ---------------------------------------- */

/**
 * Where balls actually orbit, solved from the gather constants (see config.gather).
 * Drawing the ring anywhere else makes a working attractor look broken.
 */
function orbitShellRadius() {
  const G = CFG.gather;
  const k = G.orbitSpring;
  const r0 = G.orbitRadius * scale();
  const v = G.orbitSpin * scale();
  if (!(k > 0)) return r0;
  return (k * r0 + Math.sqrt(k * k * r0 * r0 + 4 * k * v * v)) / (2 * k);
}

function drawFields(P) {
  const tier = filigreeTier(sim.bestCombo, CFG);
  const arcCount = CFG.filigree.arcCount[Math.min(tier, CFG.filigree.arcCount.length - 1)] || 0;
  const t = sim.time;
  const comboK = sim.comboCount > 0 ? Math.min(1, sim.comboTimer / CFG.score.comboWindow) : 0;

  ctx.save();
  for (const f of sim.pointers.values()) {
    const idleR = CFG.render.ringRadius * scale();
    const R = idleR + (orbitShellRadius() - idleR) * f.gather;
    const alpha = CFG.render.fieldRingAlpha * f.amp;

    ctx.strokeStyle = rgba(P.ring, alpha * (0.5 + 0.5 * f.gather));
    ctx.lineWidth = CFG.render.ringWidth * scale() * (0.6 + f.gather * 0.8);
    ctx.beginPath();
    ctx.arc(f.sx, f.sy, R, 0, 6.283);
    ctx.stroke();

    // Combo ring: how much of the window is left before the combo starts shedding.
    if (comboK > 0) {
      ctx.strokeStyle = rgba(P.hud, 0.85 * f.amp);
      ctx.lineWidth = CFG.render.ringWidth * scale() * 0.7;
      ctx.beginPath();
      ctx.arc(f.sx, f.sy, R * 1.28, -Math.PI / 2, -Math.PI / 2 + 6.283 * comboK);
      ctx.stroke();
    }

    // Filigree: permanent ornament earned by lifetime best combo. Cosmetic only.
    if (arcCount > 0) {
      ctx.strokeStyle = rgba(P.ring, CFG.filigree.alpha * f.amp * 0.8);
      ctx.lineWidth = 1;
      const spin = t * CFG.filigree.spinRate;
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
      ctx.arc(f.sx, f.sy, CFG.gather.radiusGather * scale() * f.gather, 0, 6.283);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ---- HUD ------------------------------------------------------------------ */

let displayScore = 0;
let hintFade = 0;

/**
 * The colour an upgrade announces itself in.
 *
 * The point is to link the word to the thing: WIDER BLAST arrives in volatile-red, DEEP FREEZE
 * in frost-blue, so the name is attached to the ball it changes before you have finished reading
 * it. Anything without a thing of its own falls back to a role colour.
 */
function upgradeTint(P, up) {
  if (!up) return P.hud;
  if (up.kind === 'type' && up.type) return P.type[up.type] || P.hud;
  if (up.kind === 'palette') {
    const nx = CFG.palettes[Math.min(sim.palettesUnlocked - 1, CFG.palettes.length - 1)];
    return nx ? nx.ring : P.ring;
  }
  if (up.path && up.path.indexOf('types.') === 0) {
    const k = up.path.split('.')[1];
    if (P.type[k]) return P.type[k];
  }
  if (up.kind === 'gesture') return P.ring;
  if (up.kind === 'visual') return P.star;
  if (up.kind === 'score') return P.type.GOLD;
  return P.hud;
}

// The just-earned upgrade, held under the level bar long enough to be read. Tracked from
// sim.lastUpgrade rather than latched off the event, so the line is right even on a frame where
// the event itself was dropped.
let lastUpShown = null;
let lastUpT = 0;
const lastUpRect = { x: 0, y: 0, w: 0, h: 0 };

/**
 * The Proof: an upgrade that changes a distance draws itself at that distance.
 *
 * This generalises the one legibility pattern the game already had that worked. The tap pulse
 * event carries its own radius and the renderer draws exactly that, which is why WIDE PULSE is
 * among the only upgrades you can actually see. Everything measured in reference pixels now does
 * the same on the frame it is earned: a ghost ring at the old value, a bright ring at the new
 * one, drawn where you were last touching.
 */
let proofs = [];

function queueProof(P, up, tint) {
  if (!up || !up.path) return;
  const row = foldUpgrades().find((r) => r.path === up.path);
  if (!row || row.unit !== 'px') return;
  const before = readPath(sim.config, up.path);
  // applyUpgrade has already run by the time the event is consumed, so the value on the config
  // IS the new one; the old one is recovered from this upgrade's own operation.
  let old = before;
  if (typeof up.mul === 'number' && up.mul !== 0) old = before / up.mul;
  else if (typeof up.add === 'number') old = before - up.add;
  if (!Number.isFinite(old) || Math.abs(before - old) < 0.5) return;
  if (proofs.length > 4) proofs.shift();
  proofs.push({
    x: lastTouchX || cssW / 2, y: lastTouchY || cssH * 0.5,
    r0: old * scale(), r1: before * scale(),
    t: 0, life: CFG.proof.ringTime, col: tint || P.ring,
  });
}

function drawProofs(P) {
  if (!proofs.length) return;
  ctx.save();
  for (const p of proofs) {
    const k = Math.min(1, p.t / p.life);
    const a = Math.sin(k * Math.PI) * 0.9;
    if (a <= 0.01) continue;
    const e = 1 - Math.pow(1 - k, 3);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(P.hudDim, a * 0.35);
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2, p.r0), 0, 6.283); ctx.stroke();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = rgba(p.col, a);
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2, p.r0 + (p.r1 - p.r0) * e), 0, 6.283); ctx.stroke();
  }
  ctx.restore();
}

/** The transmutation: the old colour collapsing inward, the new one blooming out of it. */
function drawConverts(P) {
  if (!converts.length) return;
  ctx.save();
  const old = P.orbHues[0];
  for (const c of converts) {
    const k = Math.min(1, c.t / c.life);
    const e = 1 - (1 - k) * (1 - k);
    ctx.lineWidth = 2.0 * scale();
    ctx.strokeStyle = rgba(old, 0.7 * (1 - k));
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r * (3.0 - 2.0 * e), 0, 6.283);
    ctx.stroke();
    ctx.strokeStyle = rgba(c.col, 0.85 * (1 - k));
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r * (1.0 + 1.2 * e), 0, 6.283);
    ctx.stroke();
  }
  ctx.restore();
}

/** A bowed line from the announcement to the ball it is announcing. */
function drawTracers(P) {
  if (!tracers.length) return;
  const sx = cssW / 2;
  const sy = cssH * 0.42 + 26;
  ctx.save();
  ctx.lineWidth = 1;
  for (const t of tracers) {
    const k = Math.min(1, t.t / t.life);
    const a = Math.sin(k * Math.PI) * 0.5;
    if (a <= 0.01) continue;
    const dx = t.x - sx, dy = t.y - sy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const bow = CFG.proof.tracerBow * scale();
    const mx = (sx + t.x) / 2 - (dy / len) * bow;
    const my = (sy + t.y) / 2 + (dx / len) * bow;
    ctx.strokeStyle = rgba(t.col, a);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, t.x, t.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHud(P, calm) {
  const F = CFG.render;
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
    const pulse = 0.7 + 0.3 * Math.min(1, sim.comboTimer / CFG.score.comboWindow);
    ctx.fillStyle = rgba(P.ring, alpha * pulse);
    ctx.fillText('×' + sim.comboMult.toFixed(2) + '   ' + sim.comboCount, cx, y);
    y += cs * 1.25;
  } else {
    y += Math.max(12, size * 0.38) * 1.25;
  }

  // Level bar.
  const barW = Math.min(200, (right - left) * 0.55);
  const barH = F.levelBarHeight;
  const prog = sim.atLevelCap ? 1 : Math.max(0, Math.min(1, sim.xp / Math.max(1, sim.xpNeeded)));
  ctx.fillStyle = rgba(P.hudDim, alpha * 0.5);
  roundRect(ctx, cx - barW / 2, y, barW, barH, barH / 2);
  ctx.fill();
  ctx.fillStyle = rgba(P.ring, alpha);
  roundRect(ctx, cx - barW / 2, y, Math.max(barH, barW * prog), barH, barH / 2);
  ctx.fill();

  const ls = Math.max(10, size * 0.27);
  ctx.font = '500 ' + ls + 'px ' + F.fontStack;
  ctx.fillStyle = rgba(P.hudDim, alpha);
  ctx.fillText(sim.atLevelCap ? 'LV ' + sim.level + ' — MAX' : 'LV ' + sim.level, cx, y + barH + 5);

  // What you were just given, in its own colour, for as long as it takes to look up.
  if (sim.lastUpgrade && sim.lastUpgrade !== lastUpShown) { lastUpShown = sim.lastUpgrade; lastUpT = 0; }
  if (lastUpShown && lastUpT < F.lastUpgradeTime) {
    const out = lastUpT > F.lastUpgradeTime - F.lastUpgradeFade
      ? (F.lastUpgradeTime - lastUpT) / F.lastUpgradeFade : 1;
    const us = ls * F.lastUpgradeScale;
    ctx.font = '600 ' + us + 'px ' + F.fontStack;
    ctx.fillStyle = rgba(upgradeTint(P, lastUpShown), alpha * out * 0.95);
    const ly = y + barH + 5 + ls * 1.35;
    ctx.fillText(lastUpShown.label, cx, ly);
    const w = ctx.measureText(lastUpShown.label).width + 24;
    lastUpRect.x = cx - w / 2; lastUpRect.y = ly - 4; lastUpRect.w = w; lastUpRect.h = us + 10;
  } else {
    lastUpRect.w = 0;
  }

  // Floating score popups.
  ctx.textBaseline = 'middle';
  for (const p of popups) {
    const k = p.t / p.life;
    const a = Math.min(1, (1 - k) * 2.2);
    ctx.font = '600 ' + p.size + 'px ' + F.fontStack;
    ctx.fillStyle = rgba(p.color, a * 0.95);
    ctx.fillText(p.text, p.x, p.y - CFG.effects.popupRise * scale() * k);
  }

  // Celebration.
  if (celebration) {
    const k = celebration.t / celebration.life;
    const a = Math.min(1, Math.sin(Math.min(1, k * 1.05) * Math.PI) * 1.8);
    const bigSize = Math.max(28, Math.min(64, cssW * (celebration.big ? 0.15 : 0.11)));
    ctx.textAlign = 'center';
    if (celebration.text) {
      ctx.font = '700 ' + bigSize + 'px ' + F.fontStack;
      // The word arrives in the colour of the thing it names, so the name is attached to the
      // thing before you have finished reading it.
      ctx.fillStyle = rgba(celebration.tint || P.hud, a);
      ctx.fillText(celebration.text, cssW / 2, cssH * 0.42);
    }
    if (celebration.sub) {
      ctx.font = '500 ' + bigSize * 0.32 + 'px ' + F.fontStack;
      ctx.fillStyle = rgba(P.ring, a * 0.9);
      ctx.fillText(celebration.sub.toUpperCase(), cssW / 2, cssH * 0.42 + bigSize * 0.75);
    }
  }

  // Level 100: the one moment this thing shouts. Its own pass, above everything, driven
  // only by capGlory so no other celebration can interrupt it.
  if (capGlory > 0) {
    const k = 1 - capGlory / Math.max(1e-6, CFG.levels.capCelebrateTime);
    // Swell in fast, hold, ease out — rather than a symmetric blip that is dim at both ends.
    const a = k < 0.12 ? k / 0.12 : (k > 0.78 ? Math.max(0, (1 - k) / 0.22) : 1);
    const cx2 = cssW / 2, cy2 = cssH * 0.44;
    const spread = 0.35 + 0.9 * Math.min(1, k * 1.6);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const rays = 24;
    for (let i = 0; i < rays; i++) {
      const ang = (i / rays) * 6.283 + sim.time * 0.28;
      const len = Math.max(cssW, cssH) * spread;
      const grad = ctx.createLinearGradient(cx2, cy2, cx2 + Math.cos(ang) * len, cy2 + Math.sin(ang) * len);
      grad.addColorStop(0, rgba(i % 2 ? P.ring : P.hud, a * 0.55));
      grad.addColorStop(1, rgba(P.ring, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = (i % 2 ? 2.0 : 3.4) * scale();
      ctx.beginPath();
      ctx.moveTo(cx2, cy2);
      ctx.lineTo(cx2 + Math.cos(ang) * len, cy2 + Math.sin(ang) * len);
      ctx.stroke();
    }
    for (let i = 0; i < 4; i++) {
      const rr = (0.08 + 0.42 * k + i * 0.11) * Math.max(cssW, cssH);
      ctx.strokeStyle = rgba(i % 2 ? P.hud : P.ring, a * (0.7 - i * 0.15));
      ctx.lineWidth = (4.0 - i * 0.8) * scale();
      ctx.beginPath();
      ctx.arc(cx2, cy2, rr, 0, 6.283);
      ctx.stroke();
    }
    const halo = ctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, Math.max(cssW, cssH) * 0.45);
    halo.addColorStop(0, rgba(P.hud, a * 0.30));
    halo.addColorStop(1, rgba(P.hud, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 18;
    const big = Math.max(52, Math.min(112, cssW * 0.27));
    ctx.font = '700 ' + big + 'px ' + F.fontStack;
    ctx.fillStyle = rgba('#ffffff', a);
    ctx.fillText('100', cx2, cy2);
    ctx.font = '700 ' + big * 0.21 + 'px ' + F.fontStack;
    ctx.fillStyle = rgba(P.ring, a);
    ctx.fillText('LEVEL CAP', cx2, cy2 - big * 0.62);
    ctx.font = '600 ' + big * 0.17 + 'px ' + F.fontStack;
    ctx.fillStyle = rgba(P.hud, a * 0.95);
    ctx.fillText('EVERY UPGRADE UNLOCKED', cx2, cy2 + big * 0.58);
    ctx.font = '500 ' + big * 0.135 + 'px ' + F.fontStack;
    ctx.fillStyle = rgba(P.hudDim, a * 0.95);
    ctx.fillText('KEEP PLAYING — THE NUMBER NEVER STOPS', cx2, cy2 + big * 0.82);
    ctx.restore();
  }

  // First run only: a pulsing hint that dies on first contact.
  if ((!seenHint || hintFade > 0) && !SOAK) {
    const out = seenHint ? Math.max(0, hintFade / Math.max(1e-6, CFG.input.hintFadeTime)) : 1;
    const pulse = (0.35 + 0.35 * (0.5 + 0.5 * Math.sin(sim.time * 6.283 / CFG.input.hintPulsePeriod))) * out;
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

/* ========================================================================== */
/* Help                                                                       */
/*                                                                            */
/* The one screen in this game allowed to use words. It is drawn on the same  */
/* canvas as everything else — there is no DOM in this app and there is not   */
/* about to be one for a help screen.                                         */
/*                                                                            */
/* What it deliberately does NOT contain: settings, an account, a FAQ, a      */
/* search box, a changelog, a troubleshooting page or a palette picker. A toy */
/* with no accounts, no settings and no network has no business shipping the  */
/* sections that exist to serve those things. It also never explains the      */
/* three type resonances — those are meant to be found.                       */
/* ========================================================================== */

const HELP = [
  {
    id: 'start', title: 'start here', gloss: 'what this is',
    blocks: [
      { kind: 'prose', text: 'There is nothing to win and nothing to lose.' },
      { kind: 'prose', text: 'Touch the screen and the orbs move away from your finger. Hold still and they gather into an orbit around it. Lift, and they are thrown.' },
      { kind: 'prose', text: 'That is the whole thing. Everything else is decoration you earn by playing.' },
      { kind: 'prose', text: 'Left alone for ten seconds, it goes quiet on its own.' },
    ],
  },
  {
    id: 'touch', title: 'touch', gloss: 'how to play',
    blocks: [
      { kind: 'row', name: 'swipe', text: 'Orbs are pushed away from your finger, and carried along with it. Swipe fast and they fling.' },
      { kind: 'row', name: 'hold still', text: 'Your finger becomes an attractor. Orbs fall into orbit around it. The ring shows where that orbit will settle.' },
      { kind: 'row', name: 'let go', text: 'Everything you gathered is slung outward. The longer you held it, the harder it goes.' },
      { kind: 'row', name: 'tap', text: 'A sharp pulse outward from that point.' },
      { kind: 'row', name: 'tap twice', text: 'A vortex. A spinning well that stays behind for a moment after your finger has gone.' },
      { kind: 'row', name: 'more fingers', text: 'Every finger is its own field. Up to ten.' },
      { kind: 'row', name: 'two fingers, three taps', text: 'Scatters everything back out, if the screen has gone lopsided.' },
    ],
  },
  {
    id: 'screen', title: 'on screen', gloss: 'what the numbers mean',
    blocks: [
      { kind: 'row', name: 'the number at the top', text: 'Your score. It is mainly aesthetic. Nothing is ever spent, and nothing is ever lost.' },
      { kind: 'row', name: 'the multiplier', text: 'Your combo. It counts moments of contact in quick succession and multiplies what they are worth. It lapses if the screen goes still.' },
      { kind: 'row', name: 'the bar', text: 'Progress to your next level. Every level hands you one named upgrade, and its name stays under the bar for a few seconds afterward. Touch that name to see what it did.' },
      { kind: 'row', name: 'the ring at your finger', text: 'How far your gather reaches, and where the orbit sits. It grows ornaments as your best combo grows.' },
      { kind: 'row', name: 'the stars', text: 'One for each milestone you have passed. It is your own sky, drawn from your save.' },
      { kind: 'row', name: 'a comet', text: 'Rare, and only while things are busy. Hit it enough and it breaks. Entirely optional.' },
    ],
  },
  {
    id: 'orbs', title: 'the orbs', gloss: 'eight kinds of ball',
    blocks: [
      { kind: 'orb', type: 'ORB', text: 'The plain one. Most of what you see.' },
      { kind: 'orb', type: 'VOLATILE', text: 'Struck hard, it detonates and shoves everything nearby. Then it goes dark while it recharges.' },
      { kind: 'orb', type: 'SPLITTER', text: 'Struck hard, it splits in two. The children can split again.' },
      { kind: 'orb', type: 'MAGNET', text: 'Pulls its neighbours in, gently. Struck hard, it yanks.' },
      { kind: 'orb', type: 'PRISM', text: 'Struck hard, it throws shards outward. Shards score on whatever they touch.' },
      { kind: 'orb', type: 'CHAIN', text: 'Struck hard, it jolts the nearest orbs with an arc, and those jolt others.' },
      { kind: 'orb', type: 'FROST', text: 'Struck hard, it freezes its neighbours. They shatter free a moment later.' },
      { kind: 'orb', type: 'GOLD', text: 'Rare. Worth a great deal, and jumps your combo several steps at once.' },
      { kind: 'note', text: 'An effect only fires on an orb still carrying energy from your finger. That is why an untouched screen goes quiet instead of going forever.' },
    ],
  },
  {
    id: 'upgrades', title: 'upgrades', gloss: 'everything you have earned',
    blocks: [
      { kind: 'prose', text: 'One every level, ninety-nine in all. Here is what they have added up to.' },
      { kind: 'note', text: 'Tap any row to watch it.' },
      { kind: 'bars' },
      { kind: 'worlds' },
      { kind: 'earned' },
    ],
  },
  {
    id: 'run', title: 'your run', gloss: 'where you are up to',
    blocks: [
      { kind: 'stats' },
      { kind: 'note', text: 'None of this is a target.' },
    ],
  },
  {
    id: 'about', title: 'about', gloss: 'no accounts, no ads, no network',
    blocks: [
      { kind: 'prose', text: 'A quiet physics toy. Small glowing balls in almost no gravity.' },
      { kind: 'prose', text: 'No accounts, no ads, no notifications, no network. No fail states, no timers, no streaks. Nothing punishes you for stopping.' },
      { kind: 'prose', text: 'Made to be played for two minutes or for an hour.' },
      { kind: 'prose', text: 'Your progress is saved on this device, in this browser. It is written every few seconds, and whenever you leave. Nothing is sent anywhere.' },
      { kind: 'prose', text: 'Add it to your home screen and it runs full screen, and offline.' },
      { kind: 'prose', text: 'If the screen ever stutters it quietly draws fewer sparks. It never slows the orbs down.' },
      { kind: 'erase' },
      { kind: 'note', text: '' },
    ],
  },
];

/* -- what each upgradeable number IS, in plain words ------------------------
 * Twenty rows reading MORE ORBS is noise. One row reading "orbs on screen 30 -> 150" is
 * information. Group order is the order they are shown in.
 */
const PATH_INFO = {
  'field.radius':               ['push reach', 'px', 'your touch'],
  'field.flingGain':            ['fling power', '', 'your touch'],
  'gather.radiusGather':        ['gather reach', 'px', 'your touch'],
  'gather.slingBase':           ['sling force', '', 'your touch'],
  'tap.pulseRadius':            ['pulse reach', 'px', 'your touch'],
  'tap.pulseImpulse':           ['pulse force', '', 'your touch'],
  'tap.vortexRadius':           ['vortex reach', 'px', 'your touch'],
  'tap.vortexSpin':             ['vortex spin', '', 'your touch'],
  'tap.vortexTime':             ['vortex life', 's', 'your touch'],
  'render.ringRadius':          ['ring size', 'px', 'your touch'],

  'population.softCapBase':     ['orbs on screen', '', 'the orbs'],
  'balls.glowScale':            ['halo size', '×', 'the orbs'],

  'types.VOLATILE.blastRadius':  ['blast reach', 'px', 'volatile'],
  'types.VOLATILE.blastImpulse': ['blast force', '', 'volatile'],
  'types.VOLATILE.inertTime':    ['recharge', 's', 'volatile'],
  'effects.detonateSparks':      ['blast sparks', '', 'volatile'],

  'types.SPLITTER.splitSpeed':   ['split speed', '', 'splitter'],
  'types.SPLITTER.cooldown':     ['split cooldown', 's', 'splitter'],
  'types.SPLITTER.childRadius':  ['child size', '×', 'splitter'],
  'types.SPLITTER.inheritSpeed': ['child speed', '×', 'splitter'],

  'types.MAGNET.pull':          ['pull', '', 'magnet'],
  'types.MAGNET.pullRadius':    ['pull reach', 'px', 'magnet'],
  'types.MAGNET.spikePull':     ['yank', '', 'magnet'],
  'types.MAGNET.fieldLines':    ['field lines', '', 'magnet'],

  'types.PRISM.shards':         ['shards', '', 'prism'],
  'types.PRISM.shardSpeed':     ['shard speed', '', 'prism'],
  'types.PRISM.shardLife':      ['shard life', 's', 'prism'],
  'effects.shatterSparks':      ['shatter sparks', '', 'prism'],

  'types.CHAIN.targets':        ['arcs per jolt', '', 'chain'],
  'types.CHAIN.range':          ['arc reach', 'px', 'chain'],
  'types.CHAIN.depth':          ['arc depth', '', 'chain'],
  'types.CHAIN.impulse':        ['arc force', '', 'chain'],

  'types.FROST.maxTargets':     ['orbs frozen', '', 'frost'],
  'types.FROST.radius':         ['freeze reach', 'px', 'frost'],
  'types.FROST.freezeTime':     ['ice hold', 's', 'frost'],
  'types.FROST.shatterImpulse': ['shatter force', '', 'frost'],

  'types.GOLD.weight':          ['gold in the pool', '', 'gold'],
  'types.GOLD.comboJump':       ['gold combo jump', '', 'gold'],
  'types.GOLD.scoreFlat':       ['gold worth', '', 'gold'],

  'render.trailFade':           ['trail length', '', 'the look'],
  'render.trailFadeCalm':       ['quiet trails', '', 'the look'],
  'render.bloomStrength':       ['bloom', '×', 'the look'],
  'render.bloomStrengthCalm':   ['quiet bloom', '×', 'the look'],
  'render.bloomStrengthFrenzy': ['loud bloom', '×', 'the look'],
  'render.starTwinkle':         ['twinkle', '×', 'the look'],
  'effects.impactSparks':       ['impact sparks', '', 'the look'],
  'effects.shockwaveTime':      ['shockwave life', 's', 'the look'],
  'effects.maxParticles':       ['spark ceiling', '', 'the look'],
  'filigree.alpha':             ['ring ornament', '×', 'the look'],
  'comet.chancePerSec':         ['comets', '/s', 'the look'],
  'paletteRules.driftPeriod':   ['world drift', 's', 'the look'],

  'sky.nebulaCount':            ['clouds', '', 'the sky'],
  'sky.nebulaAlpha':            ['cloud depth', '', 'the sky'],
  'sky.horizonAlpha':           ['horizon', '', 'the sky'],
  'sky.vignette':               ['dark edges', '', 'the sky'],
  'sky.vignetteFrenzy':         ['edges in chaos', '', 'the sky'],
  'sky.maxStars':               ['room for stars', '', 'the sky'],
  'sky.baseMag':                ['star brightness', '', 'the sky'],
  'sky.starGlow':               ['star halo', '×', 'the sky'],
  'sky.linksPerStars':          ['constellations', '', 'the sky'],
  'sky.shootingChancePerSec':   ['shooting stars', '/s', 'the sky'],

  'score.globalMultBase':       ['everything is worth', '×', 'score'],
  'score.comboMultScale':       ['combo curve', '', 'score'],
};

const BAR_GROUPS = ['your touch', 'the orbs', 'volatile', 'splitter', 'magnet', 'prism',
  'chain', 'frost', 'gold', 'the look', 'the sky', 'score'];

/** Read a dotted path off an object, the same walk applyUpgrade uses. */
function readPath(root, path) {
  const parts = path.split('.');
  let node = root;
  for (const seg of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[seg];
  }
  return node;
}

/**
 * Fold the whole upgrade table into one row per NUMBER, once at boot.
 *
 * `base` is the pristine value, `cap` the value after every contributing upgrade has applied in
 * order, and `ups` the upgrades that touch it. Nothing here ever changes, so it is built once.
 */
let barRows = null;
function foldUpgrades() {
  if (barRows) return barRows;
  const byPath = new Map();
  for (const u of (BASE_CONFIG.upgrades || [])) {
    if (!u.path || !PATH_INFO[u.path]) continue;
    let r = byPath.get(u.path);
    if (!r) {
      r = { path: u.path, base: readPath(BASE_CONFIG, u.path), ups: [] };
      byPath.set(u.path, r);
    }
    r.ups.push(u);
  }
  for (const r of byPath.values()) {
    let v = r.base;
    for (const u of r.ups.slice().sort((a, b) => a.level - b.level)) {
      if (typeof u.mul === 'number') v *= u.mul;
      else if (typeof u.add === 'number') v += u.add;
      else if (typeof u.set === 'number') v = u.set;
    }
    r.cap = v;
    const info = PATH_INFO[r.path];
    r.name = info[0]; r.unit = info[1]; r.group = info[2];
  }
  barRows = [...byPath.values()];
  barRows.sort((a, b) => {
    const g = BAR_GROUPS.indexOf(a.group) - BAR_GROUPS.indexOf(b.group);
    return g !== 0 ? g : a.ups[0].level - b.ups[0].level;
  });
  return barRows;
}

/** Numbers a person can read. Not a formatter for scores — those roll and are huge. */
function helpNum(v, unit) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  let t;
  if (a >= 100) t = String(Math.round(v));
  else if (a >= 10) t = v.toFixed(1).replace(/\.0$/, '');
  else if (a >= 1) t = v.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
  else t = v.toFixed(3).replace(/0$/, '');
  return unit === '×' ? t + '×' : (unit ? t + ' ' + unit : t);
}

/** Greedy word wrap on measureText. Never splits a word. */
function wrapText(c, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const t = line + ' ' + words[i];
    if (c.measureText(t).width <= maxW) line = t;
    else { lines.push(line); line = words[i]; }
  }
  lines.push(line);
  return lines;
}

/* -- help state ------------------------------------------------------------- */

const help = {
  open: false,
  t: 0,             // 0..1 open animation
  section: null,    // null = contents
  scroll: 0,
  vel: 0,
  drag: null,       // { id, lastY, moved, t0 }
  hit: [],          // tappable rows laid out this frame: { x, y, w, h, act, arg }
  demo: null,       // { row, t }
  eraseHold: 0,
  eraseDone: 0,
};
let helpCornerHold = 0;
let helpCornerArmed = true;
let helpBreadcrumb = 0;     // one-shot pulse on the help corner after the first level-up ever

function helpUnit() {
  const H = CFG.help;
  return Math.max(H.unitMin, Math.min(H.unitMax, H.unit * cssW / 390));
}

function helpPanel() {
  const H = CFG.help;
  const w = Math.min(cssW - safe.l - safe.r - H.panelMargin * 2, H.panelMaxW);
  const x = (cssW - w) / 2;
  const y = safe.t + H.panelMargin;
  const h = cssH - safe.b - H.panelMargin - y;
  return { x, y, w, h };
}

function openHelp(sectionId, scrollTo) {
  help.open = true;
  help.section = sectionId || null;
  help.scroll = scrollTo || 0;
  help.vel = 0;
  help.drag = null;
  help.demo = null;
  help.eraseHold = 0;
  debugOn = false;
  upgradeMenu.open = false;
  clearAllFields();
  if (!sim.seenHelp) { sim.seenHelp = true; writeSave(true); }
}

function closeHelp() {
  help.open = false;
  help.section = null;
  help.demo = null;
  help.drag = null;
}

/* -- the door: a hold in the bottom-right corner ---------------------------- */

function updateHelpCorner(dt) {
  const H = CFG.help;
  if (helpBreadcrumb > 0) helpBreadcrumb = Math.max(0, helpBreadcrumb - dt);
  if (help.open) { helpCornerHold = 0; helpCornerArmed = true; return; }
  const s = H.cornerSize;
  const x0 = cssW - safe.r - s, y0 = cssH - safe.b - s;
  let inside = false;
  for (const p of pointers.values()) {
    if (p.x >= x0 && p.x <= x0 + s && p.y >= y0 && p.y <= y0 + s) inside = true;
  }
  if (!inside) { helpCornerHold = 0; helpCornerArmed = true; return; }
  helpCornerHold += dt;
  if (helpCornerArmed && helpCornerHold >= H.holdTime) {
    helpCornerArmed = false;
    // Clear the holding field rather than letting it sling: opening a menu must never
    // also throw the orbit you happened to have gathered under your thumb.
    clearAllFields();
    openHelp(null, 0);
  }
}

/** The filling ring under your fingertip, and the one-shot breadcrumb after your first level. */
function drawHelpCorner(P) {
  if (help.open) return;
  const H = CFG.help;
  const s = H.cornerSize;
  const cx = cssW - safe.r - s * 0.5;
  const cy = cssH - safe.b - s * 0.5;
  const r = s * 0.34;
  let k = -1;
  if (helpCornerArmed && helpCornerHold > H.holdArcDelay) {
    k = (helpCornerHold - H.holdArcDelay) / Math.max(1e-6, H.holdTime - H.holdArcDelay);
  } else if (helpBreadcrumb > 0) {
    // Not a progress arc — a slow breath, so it reads as an invitation and not as a countdown.
    const a = Math.sin((1 - helpBreadcrumb / CFG.help.breadcrumbTime) * Math.PI * 3) * 0.5 + 0.5;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(P.ring, 0.10 + 0.28 * a);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = rgba(P.ring, 0.25 + 0.45 * a);
    ctx.font = '600 ' + Math.round(r * 1.05) + 'px ' + CFG.render.fontStack;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', cx, cy + 1);
    ctx.restore();
    return;
  }
  if (k <= 0) return;
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = rgba(P.ring, 0.18);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = rgba(P.ring, 0.85);
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, k));
  ctx.stroke();
  ctx.restore();
}

/* -- layout ----------------------------------------------------------------- */

/**
 * Turn a section into a flat list of draw ops plus a content height, ONCE.
 *
 * Cached by id and width. Re-measuring eight sections of prose and sixty stat rows every frame,
 * for content that cannot change, is the single easiest way to ship a help screen that halves
 * the frame budget on the device it is meant to help on.
 */
function layoutSection(id, w) {
  const key = id + ':' + Math.round(w) + ':' + Math.round(helpUnit() * 4);
  const hit = layoutCache.get(key);
  if (hit) return hit;

  const H = CFG.help;
  const u = helpUnit();
  const lh = u * H.lineHeight;
  const pad = u * 0.95;
  const iw = w - pad * 2;
  const ops = [];
  let y = 0;
  const c = ctx;

  const prose = (text, alpha, size) => {
    c.font = '400 ' + (size || u * 0.92) + 'px ' + CFG.render.fontStack;
    for (const ln of wrapText(c, text, iw)) {
      ops.push({ op: 'text', x: pad, y, s: ln, size: size || u * 0.92, weight: '400', col: 'hud', a: alpha });
      y += lh;
    }
    y += lh * 0.35;
  };

  if (id === null || id === 'contents') {
    y += u * 0.5;
    for (const sec of HELP) {
      ops.push({ op: 'rowbg', x: pad * 0.4, y, w: w - pad * 0.8, h: H.rowH - 6 });
      ops.push({ op: 'text', x: pad, y: y + H.rowH * 0.20, s: sec.title, size: u, weight: '600', col: 'hud', a: 0.95 });
      ops.push({ op: 'text', x: pad, y: y + H.rowH * 0.56, s: sec.gloss, size: u * 0.85, weight: '400', col: 'hud', a: 0.6 });
      ops.push({ op: 'hit', x: 0, y, w, h: H.rowH, act: 'section', arg: sec.id });
      y += H.rowH;
    }
    y += u;
    const out = { ops, height: y };
    layoutCache.set(key, out);
    return out;
  }

  const sec = HELP.find((s) => s.id === id);
  if (!sec) return { ops: [], height: 0 };

  for (const b of sec.blocks) {
    if (b.kind === 'prose') { prose(b.text, 0.78); }

    else if (b.kind === 'note') {
      if (!b.text) continue;
      c.font = '400 ' + (u * 0.85) + 'px ' + CFG.render.fontStack;
      y += lh * 0.3;
      for (const ln of wrapText(c, b.text, iw)) {
        ops.push({ op: 'text', x: pad, y, s: ln, size: u * 0.85, weight: '400', col: 'hudDim', a: 0.9 });
        y += u * 1.35;
      }
      y += lh * 0.4;
    }

    else if (b.kind === 'row') {
      ops.push({ op: 'text', x: pad, y, s: b.name, size: u, weight: '600', col: 'hud', a: 0.95 });
      y += lh * 1.05;
      prose(b.text, 0.74);
      y += lh * 0.15;
    }

    else if (b.kind === 'orb') {
      const sw = u * 0.85;
      ops.push({ op: 'swatch', x: pad + sw * 0.6, y: y + u * 0.42, r: sw * 0.55, type: b.type });
      ops.push({ op: 'text', x: pad + sw * 1.7, y, s: b.type, size: u * 0.95, weight: '600', col: 'type', type: b.type, a: 1 });
      y += lh * 1.05;
      c.font = '400 ' + (u * 0.9) + 'px ' + CFG.render.fontStack;
      for (const ln of wrapText(c, b.text, iw - sw * 1.7)) {
        ops.push({ op: 'text', x: pad + sw * 1.7, y, s: ln, size: u * 0.9, weight: '400', col: 'hud', a: 0.74 });
        y += lh;
      }
      y += lh * 0.3;
    }

    else if (b.kind === 'bars') {
      let group = '';
      for (const r of foldUpgrades()) {
        if (r.group !== group) {
          group = r.group;
          y += u * 0.6;
          ops.push({ op: 'text', x: pad, y, s: group, size: u * 0.8, weight: '600', col: 'hudDim', a: 0.95, upper: true });
          y += u * 1.5;
        }
        ops.push({ op: 'bar', x: pad, y, w: iw, row: r });
        ops.push({ op: 'hit', x: 0, y, w, h: H.barRowH, act: 'demo', arg: r.path });
        y += H.barRowH;
      }
      y += u;
    }

    else if (b.kind === 'worlds') {
      ops.push({ op: 'text', x: pad, y, s: 'colour worlds', size: u * 0.8, weight: '600', col: 'hudDim', a: 0.95, upper: true });
      y += u * 1.6;
      const per = Math.max(2, Math.floor(iw / (u * 5.2)));
      const cw = iw / per;
      const chH = u * 3.2;
      for (let i = 0; i < BASE_CONFIG.palettes.length; i++) {
        const col = i % per, row = Math.floor(i / per);
        ops.push({ op: 'world', x: pad + col * cw, y: y + row * chH, w: cw - u * 0.35, h: chH - u * 0.5, i });
      }
      y += Math.ceil(BASE_CONFIG.palettes.length / per) * chH + u * 0.2;
      prose('Every few levels unlocks one forever. The screen drifts between the ones you own.', 0.55, u * 0.85);
    }

    else if (b.kind === 'earned') {
      ops.push({ op: 'text', x: pad, y, s: 'earned', size: u * 0.8, weight: '600', col: 'hudDim', a: 0.95, upper: true });
      y += u * 1.6;
      ops.push({ op: 'earned', x: pad, y, w: iw, u });
      // Height is resolved at draw time against the live save, so reserve from the live count.
      const owned = sim.appliedUpgrades ? sim.appliedUpgrades.size : 0;
      y += (Math.min(owned, 99) + 1) * (u * 2.5);
      prose('What is coming is not listed. It arrives when it arrives.', 0.55, u * 0.85);
    }

    else if (b.kind === 'stats') {
      ops.push({ op: 'stats', x: pad, y, w: iw, u });
      y += 8 * (u * 2.0) + u;
    }

    else if (b.kind === 'erase') {
      y += u * 0.8;
      ops.push({ op: 'erase', x: pad, y, w: iw, h: u * 2.2 });
      ops.push({ op: 'hit', x: 0, y, w, h: u * 2.2, act: 'erase' });
      y += u * 3.4;
      ops.push({ op: 'text', x: pad, y, s: '99 upgrades · ' + BASE_CONFIG.palettes.length
        + ' colour worlds · 8 kinds of orb', size: u * 0.8, weight: '400', col: 'hudDim', a: 0.85 });
      y += u * 2;
    }
  }
  const out = { ops, height: y + u };
  layoutCache.set(key, out);
  return out;
}

/* -- drawing ---------------------------------------------------------------- */

function helpColour(P, op) {
  if (op.col === 'hudDim') return P.hudDim;
  if (op.col === 'type') return op.type === 'ORB' ? P.orbHues[0] : (P.type[op.type] || P.hud);
  return P.hud;
}

function formatPlayed(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's';
}

function drawHelp(P, dt) {
  const H = CFG.help;
  const e = help.t;
  if (e <= 0.001) return;
  const pan = helpPanel();
  const u = helpUnit();
  const slide = (1 - e) * 16;

  ctx.save();
  // No shadow inside the sheet: the HUD needs its halo because it floats over bright orbs with
  // nothing to sit on. The sheet IS something to sit on, and a blur on forty lines of list is
  // pure waste on the device this is meant to run well on.
  ctx.shadowBlur = 0;
  const sheetA = help.demo ? (H.demoSheetAlpha + (1 - H.demoSheetAlpha) * (1 - help.demoFadeK)) : 1;
  ctx.fillStyle = 'rgba(0,0,0,' + (H.veilAlpha * e * sheetA) + ')';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.globalAlpha = e * sheetA;
  ctx.translate(0, slide);

  ctx.fillStyle = 'rgba(0,0,0,' + H.sheetAlpha + ')';
  roundRect(ctx, pan.x, pan.y, pan.w, pan.h, 14);
  ctx.fill();
  ctx.strokeStyle = rgba(P.ring, 0.30);
  ctx.lineWidth = 1;
  roundRect(ctx, pan.x + 0.5, pan.y + 0.5, pan.w - 1, pan.h - 1, 14);
  ctx.stroke();

  // --- header, pinned -------------------------------------------------------
  const sec = help.section ? HELP.find((s) => s.id === help.section) : null;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 ' + (u * 1.05) + 'px ' + CFG.render.fontStack;
  ctx.fillStyle = rgba(P.hud, 0.95);
  ctx.fillText(sec ? sec.title : 'help', pan.x + pan.w / 2, pan.y + H.headerH / 2);
  ctx.strokeStyle = rgba(P.hudDim, 0.35);
  ctx.beginPath();
  ctx.moveTo(pan.x + u, pan.y + H.headerH);
  ctx.lineTo(pan.x + pan.w - u, pan.y + H.headerH);
  ctx.stroke();

  help.hit.length = 0;
  const back = { x: pan.x, y: pan.y, w: H.headerH, h: H.headerH };
  const close = { x: pan.x + pan.w - H.headerH, y: pan.y, w: H.headerH, h: H.headerH };
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = rgba(P.hud, 0.7);
  if (sec) {
    const bx = back.x + H.headerH * 0.55, by = back.y + H.headerH / 2;
    ctx.beginPath();
    ctx.moveTo(bx + 4, by - 6); ctx.lineTo(bx - 3, by); ctx.lineTo(bx + 4, by + 6);
    ctx.stroke();
    help.hit.push({ ...back, act: 'back' });
  }
  const kx = close.x + H.headerH / 2, ky = close.y + H.headerH / 2;
  ctx.beginPath();
  ctx.moveTo(kx - 6, ky - 6); ctx.lineTo(kx + 6, ky + 6);
  ctx.moveTo(kx + 6, ky - 6); ctx.lineTo(kx - 6, ky + 6);
  ctx.stroke();
  help.hit.push({ ...close, act: 'close' });

  // --- body, clipped and scrolled -------------------------------------------
  const bodyY = pan.y + H.headerH;
  const bodyH = pan.h - H.headerH;
  const lay = layoutSection(help.section, pan.w);
  help.maxScroll = Math.max(0, lay.height - bodyH + u);

  ctx.save();
  roundRect(ctx, pan.x, bodyY, pan.w, bodyH, 2);
  ctx.clip();
  ctx.translate(pan.x, bodyY - help.scroll + u * 0.6);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const op of lay.ops) {
    // Cull anything scrolled out of view — the upgrades section is over a thousand ops long.
    const oy = op.y - help.scroll + u * 0.6;
    if (oy > bodyH + 80 || oy < -140) {
      if (op.op === 'hit') continue;
      if (op.op !== 'earned' && op.op !== 'stats') continue;
    }
    drawHelpOp(P, op, u, pan, bodyY, bodyH);
  }
  ctx.restore();

  // scroll indicator
  if (help.maxScroll > 1) {
    const frac = bodyH / (bodyH + help.maxScroll);
    const th = Math.max(24, bodyH * frac);
    const tt = bodyY + (bodyH - th) * Math.max(0, Math.min(1, help.scroll / help.maxScroll));
    ctx.fillStyle = rgba(P.hudDim, 0.35 * Math.min(1, help.scrollGlow || 0));
    roundRect(ctx, pan.x + pan.w - 5, tt, 2.5, th, 1.25);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawHelpOp(P, op, u, pan, bodyY, bodyH) {
  const H = CFG.help;
  switch (op.op) {
    case 'text': {
      ctx.font = op.weight + ' ' + op.size + 'px ' + CFG.render.fontStack;
      ctx.fillStyle = rgba(helpColour(P, op), op.a);
      ctx.fillText(op.upper ? op.s.toUpperCase() : op.s, op.x, op.y);
      break;
    }
    case 'rowbg': {
      ctx.fillStyle = rgba(P.hudDim, 0.10);
      roundRect(ctx, op.x, op.y, op.w, op.h, 8);
      ctx.fill();
      break;
    }
    case 'swatch': {
      const unlocked = op.type === 'ORB' || sim.unlocked.indexOf(op.type) >= 0;
      const col = op.type === 'ORB' ? P.orbHues[0] : (P.type[op.type] || P.hud);
      ctx.beginPath();
      ctx.arc(op.x, op.y, op.r, 0, 6.283);
      if (unlocked) { ctx.fillStyle = rgba(col, 0.95); ctx.fill(); }
      else { ctx.strokeStyle = rgba(P.hudDim, 0.7); ctx.lineWidth = 1.2; ctx.stroke(); }
      break;
    }
    case 'bar': {
      const r = op.row;
      const cur = readPath(sim.config, r.path);
      const owned = r.ups.filter((x) => sim.appliedUpgrades.has(x.id)).length;
      const lo = Math.min(r.base, r.cap), hi = Math.max(r.base, r.cap);
      const span = Math.max(1e-9, hi - lo);
      const k = Math.max(0, Math.min(1, (cur - lo) / span));
      ctx.font = '600 ' + (u * 0.92) + 'px ' + CFG.render.fontStack;
      ctx.fillStyle = rgba(P.hud, 0.92);
      ctx.fillText(r.name, op.x, op.y);
      ctx.textAlign = 'right';
      ctx.fillStyle = rgba(P.ring, 0.95);
      ctx.fillText(helpNum(cur, r.unit), op.x + op.w, op.y);
      ctx.textAlign = 'left';
      const by = op.y + u * 1.5;
      const bw = op.w * 0.62;
      ctx.fillStyle = rgba(P.hudDim, 0.30);
      roundRect(ctx, op.x, by, bw, 2, 1); ctx.fill();
      if (k > 0.001) {
        ctx.fillStyle = rgba(P.ring, 0.9);
        roundRect(ctx, op.x, by - 1, Math.max(4, bw * k), 4, 2); ctx.fill();
      }
      // One pip per contributing upgrade, lit if you own it. This is the row that says
      // "you have two of the four things that ever touch this number".
      const n = r.ups.length;
      for (let i = 0; i < n; i++) {
        const px = op.x + bw * ((i + 1) / n);
        ctx.fillStyle = rgba(P.ring, sim.appliedUpgrades.has(r.ups[i].id) ? H.barPipAlpha : H.barPipAlphaLocked);
        ctx.beginPath(); ctx.arc(px, by + 1.5, 2.1, 0, 6.283); ctx.fill();
      }
      ctx.font = '400 ' + (u * 0.78) + 'px ' + CFG.render.fontStack;
      ctx.fillStyle = rgba(P.hudDim, 0.9);
      ctx.textAlign = 'right';
      ctx.fillText(owned + '/' + n + '   ' + helpNum(r.base, '') + ' → ' + helpNum(r.cap, ''), op.x + op.w, by - 2);
      ctx.textAlign = 'left';
      break;
    }
    case 'world': {
      const pal = BASE_CONFIG.palettes[op.i];
      const unlocked = op.i < sim.palettesUnlocked;
      const a = unlocked ? 1 : H.swatchLockedAlpha;
      ctx.globalAlpha *= a;
      ctx.fillStyle = pal.bg1;
      roundRect(ctx, op.x, op.y, op.w, op.h * 0.62, 6); ctx.fill();
      ctx.strokeStyle = rgba(pal.ring, 0.9);
      ctx.lineWidth = 1;
      roundRect(ctx, op.x + 0.5, op.y + 0.5, op.w - 1, op.h * 0.62 - 1, 6); ctx.stroke();
      // Three dots of the world's own orb hues, so a chip is a sample and not just a rectangle.
      for (let d = 0; d < 3; d++) {
        ctx.fillStyle = pal.orbHues[d % pal.orbHues.length];
        ctx.beginPath();
        ctx.arc(op.x + op.w * (0.28 + d * 0.22), op.y + op.h * 0.31, Math.max(1.6, op.w * 0.05), 0, 6.283);
        ctx.fill();
      }
      if (unlocked && palette.cur && pal.name === palette.cur.name) {
        ctx.strokeStyle = rgba(P.hud, 0.85);
        ctx.lineWidth = 1.6;
        roundRect(ctx, op.x - 1.5, op.y - 1.5, op.w + 3, op.h * 0.62 + 3, 7); ctx.stroke();
      }
      ctx.font = '400 ' + (u * 0.66) + 'px ' + CFG.render.fontStack;
      ctx.fillStyle = rgba(P.hud, unlocked ? 0.8 : 0.9);
      ctx.fillText(unlocked ? pal.name : 'locked', op.x, op.y + op.h * 0.68);
      ctx.globalAlpha /= a;
      break;
    }
    case 'earned': {
      // Owned upgrades, newest first, plus exactly one locked row: the next. The remaining
      // levels are not enumerated — a toy that keeps its secrets should not publish a schedule.
      const owned = (BASE_CONFIG.upgrades || []).filter((x) => sim.appliedUpgrades.has(x.id))
        .sort((a, b) => b.level - a.level);
      const next = (BASE_CONFIG.upgrades || []).filter((x) => !sim.appliedUpgrades.has(x.id))
        .sort((a, b) => a.level - b.level)[0];
      let y = op.y;
      const line = u * 2.5;
      if (next) {
        ctx.fillStyle = rgba(P.ring, 0.55);
        ctx.fillRect(op.x - u * 0.45, y, 2, u * 1.8);
        ctx.font = '600 ' + (u * 0.9) + 'px ' + CFG.render.fontStack;
        ctx.fillStyle = rgba(P.hudDim, 0.95);
        ctx.fillText('LV ' + next.level + '   ' + next.label, op.x, y);
        ctx.font = '400 ' + (u * 0.78) + 'px ' + CFG.render.fontStack;
        ctx.fillStyle = rgba(P.hudDim, 0.8);
        ctx.fillText('next', op.x + op.w - ctx.measureText('next').width, y + 1);
        y += line;
      }
      for (const up of owned) {
        ctx.font = '600 ' + (u * 0.9) + 'px ' + CFG.render.fontStack;
        ctx.fillStyle = rgba(upgradeTint(P, up), 0.95);
        ctx.fillText('LV ' + up.level + '   ' + up.label, op.x, y);
        ctx.font = '400 ' + (u * 0.78) + 'px ' + CFG.render.fontStack;
        ctx.fillStyle = rgba(P.hud, 0.6);
        ctx.fillText(up.note, op.x, y + u * 1.15);
        y += line;
      }
      break;
    }
    case 'stats': {
      const rows = [
        ['level', sim.atLevelCap ? sim.level + ' of ' + CFG.levels.cap + ' — max' : sim.level + ' of ' + CFG.levels.cap],
        ['lifetime score', formatScore(sim.score)],
        ['best combo', formatScore(sim.bestCombo)],
        ['stars in your sky', String(sky.stars.length)],
        ['comets broken', String(sim.cometsBroken || 0)],
        ['upgrades earned', sim.appliedUpgrades.size + ' of 99'],
        ['time played', formatPlayed(sim.time)],
        ['this world', palette.cur ? palette.cur.name : '—'],
      ];
      let y = op.y;
      for (const [k, v] of rows) {
        ctx.font = '400 ' + (u * 0.92) + 'px ' + CFG.render.fontStack;
        ctx.fillStyle = rgba(P.hud, 0.72);
        ctx.fillText(k, op.x, y);
        ctx.textAlign = 'right';
        ctx.font = '600 ' + (u * 0.98) + 'px ' + CFG.render.fontStack;
        ctx.fillStyle = rgba(P.ring, 0.95);
        ctx.fillText(v, op.x + op.w, y);
        ctx.textAlign = 'left';
        y += u * 2.0;
      }
      break;
    }
    case 'erase': {
      const k = Math.min(1, help.eraseHold / CFG.help.eraseHoldTime);
      ctx.fillStyle = 'rgba(120,20,20,0.55)';
      roundRect(ctx, op.x, op.y, op.w, op.h, 8); ctx.fill();
      if (k > 0) {
        ctx.save();
        roundRect(ctx, op.x, op.y, op.w, op.h, 8); ctx.clip();
        ctx.fillStyle = 'rgba(255,70,70,0.85)';
        ctx.fillRect(op.x, op.y, op.w * k, op.h);
        ctx.restore();
      }
      ctx.font = '600 ' + (u * 0.88) + 'px ' + CFG.render.fontStack;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.textAlign = 'center';
      ctx.fillText(help.eraseDone > 0 ? 'erased. this is a first run again.' : 'hold to erase everything',
        op.x + op.w / 2, op.y + op.h * 0.32);
      ctx.textAlign = 'left';
      break;
    }
    default: break;
  }
}

/* -- input ------------------------------------------------------------------
 * Intercepted at ALL THREE pointer hooks, not just the first. Catching only pointerdown means a
 * fast reader's flick still feeds gestureMoved, the double-tap window and the scatter counter,
 * and the toy underneath quietly reacts to a thumb that was reading a help page.
 */

function helpDown(x, y) {
  if (!help.open) return false;
  const pan = helpPanel();
  const H = CFG.help;
  // Outside the sheet closes it.
  if (x < pan.x || x > pan.x + pan.w || y < pan.y || y > pan.y + pan.h) { closeHelp(); return true; }
  for (const h of help.hit) {
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
      if (h.act === 'close') closeHelp();
      else if (h.act === 'back') { help.section = null; help.scroll = 0; help.vel = 0; }
      return true;
    }
  }
  help.drag = { id: -1, lastY: y, y0: y, moved: 0, tapY: y, hitAct: null, hitArg: null };
  // Which content row is under the finger, resolved now and only acted on if this turns out
  // to be a tap rather than a scroll.
  const bodyY = pan.y + H.headerH;
  const u = helpUnit();
  const lay = layoutSection(help.section, pan.w);
  const ly = y - bodyY + help.scroll - u * 0.6;
  for (const op of lay.ops) {
    if (op.op !== 'hit') continue;
    if (ly >= op.y && ly <= op.y + op.h) { help.drag.hitAct = op.act; help.drag.hitArg = op.arg; break; }
  }
  help.vel = 0;
  return true;
}

function helpMove(x, y) {
  if (!help.open || !help.drag) return help.open;
  const d = help.drag;
  const dy = y - d.lastY;
  d.lastY = y;
  d.moved += Math.abs(dy);
  if (d.moved > 6) {
    const over = help.scroll < 0 || help.scroll > help.maxScroll;
    help.scroll -= dy * (over ? CFG.help.overscroll : 1);
    help.vel = -dy * 60;
    help.scrollGlow = 1;
  } else if (d.hitAct === 'erase') {
    // stay put: the erase target is a hold, not a drag
  }
  return true;
}

function helpUp() {
  if (!help.open) return false;
  const d = help.drag;
  help.drag = null;
  if (!d) return true;
  if (d.moved <= 6) {
    if (d.hitAct === 'section') { help.section = d.hitArg; help.scroll = 0; help.vel = 0; layoutCache.clear(); }
    else if (d.hitAct === 'demo') startDemo(d.hitArg);
  } else if (Math.abs(help.vel) < CFG.help.flickMin) {
    help.vel = 0;
  }
  help.eraseHold = 0;
  return true;
}

function updateHelp(dt) {
  const H = CFG.help;
  const want = help.open ? 1 : 0;
  const step = dt / Math.max(1e-6, H.openTime);
  help.t += Math.max(-step, Math.min(step, want - help.t));
  if (!help.open) { help.eraseHold = 0; return; }

  // Momentum, then a spring back out of overscroll.
  if (!help.drag) {
    help.scroll += help.vel * dt;
    help.vel -= help.vel * Math.min(1, H.scrollFriction * dt);
    if (Math.abs(help.vel) < 4) help.vel = 0;
    if (help.scroll < 0) { help.scroll += (0 - help.scroll) * Math.min(1, H.overscrollSpring * dt); help.vel = 0; }
    else if (help.scroll > help.maxScroll) {
      help.scroll += (help.maxScroll - help.scroll) * Math.min(1, H.overscrollSpring * dt);
      help.vel = 0;
    }
  }
  help.scrollGlow = Math.max(0, (help.scrollGlow || 0) - dt / 0.8);

  // Hold-to-erase, only while a finger is actually sitting on the target.
  let onErase = false;
  if (help.drag && help.drag.hitAct === 'erase' && help.drag.moved <= 6) onErase = true;
  if (onErase) {
    help.eraseHold += dt;
    if (help.eraseHold >= H.eraseHoldTime && help.eraseDone === 0) {
      wipeSave();
      resetToLevelOne();
      help.eraseDone = 0.001;
      layoutCache.clear();
    }
  } else {
    help.eraseHold = 0;
  }
  if (help.eraseDone > 0) { help.eraseDone += dt; if (help.eraseDone > 3) help.eraseDone = 0; }

  // A demonstration playing over the live toy.
  if (help.demo) {
    help.demo.t += dt;
    const k = help.demo.t / H.demoTime;
    help.demoFadeK = k < 0.5 ? Math.min(1, help.demo.t / H.demoFade)
      : Math.min(1, (H.demoTime - help.demo.t) / H.demoFade);
    if (help.demo.t >= H.demoTime) { help.demo = null; help.demoFadeK = 0; }
  } else {
    help.demoFadeK = 0;
  }
}

/**
 * Show me, do not tell me.
 *
 * The one legibility pattern this game already had that worked was the tap pulse: the event
 * carries its radius and the renderer draws exactly that, so you can see what WIDE PULSE bought.
 * A tapped row plays the same trick on demand — the player asks the question at the moment they
 * have it, and gets it answered at true size on a quiet screen.
 */
function startDemo(path) {
  const row = foldUpgrades().find((r) => r.path === path);
  if (!row) return;
  help.demo = { row, t: 0 };
  help.demoFadeK = 0;
}

function drawDemo(P) {
  if (!help.demo) return;
  const H = CFG.help;
  const r = help.demo.row;
  const cur = readPath(sim.config, r.path);
  const base = r.base;
  const k = Math.min(1, help.demo.t / H.demoTime);
  const cx = cssW / 2, cy = cssH * 0.5;
  const a = Math.sin(Math.min(1, k * 1.15) * Math.PI) * 0.95;
  if (a <= 0.01) return;

  ctx.save();
  ctx.lineWidth = 1.6 * scale();
  // Anything measured in pixels is drawn AT that many pixels. Everything else is drawn as a
  // pair of arcs whose lengths are in proportion, which is the honest picture of a multiplier.
  if (r.unit === 'px') {
    const s = scale();
    ctx.strokeStyle = rgba(P.hudDim, a * 0.55);
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, base * s), 0, 6.283); ctx.stroke();
    ctx.strokeStyle = rgba(P.ring, a);
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, cur * s), 0, 6.283); ctx.stroke();
  } else {
    const R = Math.min(cssW, cssH) * 0.3;
    const span = Math.max(1e-9, Math.max(base, cur, r.cap));
    ctx.strokeStyle = rgba(P.hudDim, a * 0.55);
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + 6.283 * (base / span)); ctx.stroke();
    ctx.lineWidth = 4 * scale();
    ctx.strokeStyle = rgba(P.ring, a);
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.92, -Math.PI / 2, -Math.PI / 2 + 6.283 * (cur / span)); ctx.stroke();
  }
  // The caption draws over the bare scene, so it keeps the HUD's halo.
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 9;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const u = helpUnit();
  ctx.font = '600 ' + (u * 1.15) + 'px ' + CFG.render.fontStack;
  ctx.fillStyle = rgba(P.hud, a);
  ctx.fillText(r.name, cx, cssH * 0.82);
  ctx.font = '600 ' + (u * 0.95) + 'px ' + CFG.render.fontStack;
  ctx.fillStyle = rgba(P.ring, a);
  ctx.fillText(helpNum(base, r.unit) + '  →  ' + helpNum(cur, r.unit), cx, cssH * 0.82 + u * 1.6);
  ctx.restore();
}

/* ---- debug overlay -------------------------------------------------------- */

const wipeRect = { x: 0, y: 0, w: 0, h: 0 };
const dbgCloseRect = { x: 0, y: 0, w: 0, h: 0 };  // the debug overlay's close cross
const upgBtnRect = { x: 0, y: 0, w: 0, h: 0 };   // "UPGRADES" button in the debug overlay
const lv1BtnRect = { x: 0, y: 0, w: 0, h: 0 };   // "RESET TO LV 1" button beside it
let lv1Done = 0;                                 // brief confirmation timer on that button

/* ---- upgrade menu: every upgrade, one tappable button each -------------- */

const upgradeMenu = { open: false, page: 0, rows: [], buttons: [] };
const UPG_PER_PAGE = 13;

function upgradePages() {
  return Math.max(1, Math.ceil((CFG.upgrades || []).length / UPG_PER_PAGE));
}

/** Fire an upgrade directly, as if the level that grants it had just been reached. */
function triggerUpgrade(up) {
  if (!up) return;
  applyUpgrade(sim, up, true);            // forced: debug may re-apply deliberately
  sim.lastUpgrade = up;                   // so the debug menu shows the same line real play does
  const P = palette.cur;
  if (!P) return;
  // Deliberately the same body as the `upgrade` event, so what the debug menu shows a developer
  // is exactly what a player sees. A debug path that celebrates differently is a debug path that
  // cannot be used to check the celebration.
  const loud = up.kind === 'type' || up.kind === 'palette';
  const tint = upgradeTint(P, up);
  const world = CFG.palettes[Math.min(sim.palettesUnlocked - 1, CFG.palettes.length - 1)];
  celebrate(up.kind === 'palette' && world ? world.name : up.label,
    up.kind === 'type' ? 'new ball' : (up.kind === 'palette' ? 'new sky' : ''), loud, 0, tint);
  addFlash(loud ? CFG.effects.flashUpgradeAlpha : CFG.effects.flashMinorAlpha, tint, true);
  spawnParticles(cssW / 2, cssH * 0.42, Math.round(CFG.effects.upgradeBurst * qualityMul()),
    340 * scale(), tint, 0.7, 2.0 * scale());
  if (loud) addShake(3 * scale());
  if (up.kind === 'palette') retargetPalette();
  if (up.path && up.path.indexOf('sky.') === 0) { plateKey = ''; platesReady = false; }
  queueProof(P, up, tint);
}

function grantLevels(n) {
  for (let i = 0; i < n; i++) {
    if (sim.atLevelCap) break;
    sim.xp = sim.xpNeeded;                // the next step() levels up and applies the upgrade
    simStep(sim, 1 / 60, null);
  }
}

function drawUpgradeMenu(P) {
  const rows = upgradeMenu.rows; rows.length = 0;
  const btns = upgradeMenu.buttons; btns.length = 0;
  const list = CFG.upgrades || [];
  const pages = upgradePages();
  upgradeMenu.page = ((upgradeMenu.page % pages) + pages) % pages;

  const x = safe.l + 8;
  const w = Math.min(cssW - safe.l - safe.r - 16, 320);
  const top = safe.t + 8;
  const rowH = 22;
  const headH = 26;
  const footH = 30;
  const h = headH + UPG_PER_PAGE * rowH + footH;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.86)';
  ctx.fillRect(x - 4, top - 4, w + 8, h + 8);
  ctx.strokeStyle = rgba(P.ring, 0.5);
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 4, top - 4, w + 8, h + 8);

  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#9fe8c0';
  ctx.fillText('UPGRADES  page ' + (upgradeMenu.page + 1) + '/' + pages
    + '   lv ' + sim.level + (sim.atLevelCap ? ' MAX' : '') + '   tap to fire', x, top + headH / 2);

  // A close cross of its own. This panel covers the corner you would hold to get out, and it
  // swallows every touch inside itself — so without this the only ways out were a keyboard and
  // a three-finger tap that iOS is entitled to eat. That is a trap.
  const cs = 26;
  const cx0 = x + w - cs;
  const cy0 = top - 2;
  btns.push({ x: cx0, y: cy0, w: cs, h: cs, act: 'close' });
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.6;
  const kx = cx0 + cs / 2, ky = cy0 + cs / 2;
  ctx.beginPath();
  ctx.moveTo(kx - 5, ky - 5); ctx.lineTo(kx + 5, ky + 5);
  ctx.moveTo(kx + 5, ky - 5); ctx.lineTo(kx - 5, ky + 5);
  ctx.stroke();

  const start = upgradeMenu.page * UPG_PER_PAGE;
  for (let i = 0; i < UPG_PER_PAGE; i++) {
    const up = list[start + i];
    if (!up) break;
    const ry = top + headH + i * rowH;
    const applied = sim.appliedUpgrades.has(up.id);
    ctx.fillStyle = applied ? 'rgba(60,110,80,0.55)' : 'rgba(40,44,60,0.55)';
    ctx.fillRect(x, ry, w, rowH - 2);
    ctx.fillStyle = applied ? '#bdf5d2' : '#dfe4f0';
    ctx.fillText(String(up.level).padStart(3) + '  ' + up.label, x + 6, ry + (rowH - 2) / 2);
    ctx.fillStyle = '#7f8aa0';
    ctx.textAlign = 'right';
    ctx.fillText(up.kind, x + w - 6, ry + (rowH - 2) / 2);
    ctx.textAlign = 'left';
    rows.push({ x, y: ry, w, h: rowH - 2, up });
  }

  const by = top + headH + UPG_PER_PAGE * rowH + 4;
  const labels = ['< PREV', 'NEXT >', '+1 LV', '+10 LV', 'ALL', 'RESET'];
  const acts = ['prev', 'next', 'lv1', 'lv10', 'all', 'reset'];
  const bw = (w - 5 * 3) / labels.length;
  for (let i = 0; i < labels.length; i++) {
    const bx = x + i * (bw + 3);
    ctx.fillStyle = 'rgba(70,80,110,0.75)';
    ctx.fillRect(bx, by, bw, 22);
    ctx.fillStyle = '#e6ecff';
    ctx.textAlign = 'center';
    ctx.fillText(labels[i], bx + bw / 2, by + 11);
    btns.push({ x: bx, y: by, w: bw, h: 22, act: acts[i] });
  }
  ctx.restore();
}

/** Returns true if the point landed on the menu and was handled. */
function upgradeMenuHit(px, py) {
  if (!upgradeMenu.open) return false;
  for (const b of upgradeMenu.buttons) {
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
      if (b.act === 'close') upgradeMenu.open = false;
      else if (b.act === 'prev') upgradeMenu.page--;
      else if (b.act === 'next') upgradeMenu.page++;
      else if (b.act === 'lv1') grantLevels(1);
      else if (b.act === 'lv10') grantLevels(10);
      else if (b.act === 'all') for (const u of (CFG.upgrades || [])) applyUpgrade(sim, u, false);
      else if (b.act === 'reset') resetToLevelOne();
      return true;
    }
  }
  for (const r of upgradeMenu.rows) {
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
      triggerUpgrade(r.up);
      return true;
    }
  }
  // Anywhere else inside the panel is swallowed, so the menu is not also playing the game.
  const rows = upgradeMenu.rows;
  if (rows.length) {
    const first = rows[0];
    const lastB = upgradeMenu.buttons[upgradeMenu.buttons.length - 1];
    if (px >= first.x - 6 && px <= first.x + first.w + 6
      && py >= safe.t && py <= (lastB ? lastB.y + lastB.h + 6 : first.y + first.h)) return true;
  }
  return false;
}

function drawDebug(P, physMs, fps) {
  const x = safe.l + 8;
  let y = safe.t + 8;
  const lh = 13;
  const lines = [
    'fps ' + fps.toFixed(0) + '   phys ' + physMs.toFixed(2) + 'ms   draw ' + renderMs.toFixed(2)
      + 'ms   dpr ' + dpr.toFixed(2),
    'balls ' + sim.aliveCount + '/' + sim.softCap + ' (cap ' + CFG.population.hardCap + ')'
      + '   shards ' + sim.shards.length,
    'parts ' + particles.length + '/' + particleBudget + '   bloom ' + bloomScale.toFixed(2)
      + '   evDrop ' + sim.eventsDropped + '/' + sim.eventsDroppedTotal,
    'sanitizer ' + sim.sanitizerHits + '   fields ' + sim.pointers.size
      + '   softResets ' + softResets,
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
    ? errorBuffer.slice(-6).map((e) => '#' + e.n + ' ' + e.kind + ': ' + e.msg + (e.count > 1 ? ' (x' + e.count + ')' : ''))
    : ['errors: none'];
  for (const l of errLines) maxW = Math.max(maxW, ctx.measureText(l).width);

  // + 30 for the wipe target, + 26 for the row of tap buttons under it.
  const boxH = (lines.length + errLines.length + 2) * lh + 30 + 26;
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(x - 5, y - 5, maxW + 16, boxH);

  // A close cross. The corner hold that opened this is a toggle, but a hold is a thing you can
  // get wrong and a panel with no visible way out is a panel people get stuck in.
  const cs = 30;
  dbgCloseRect.x = x - 5 + maxW + 16 - cs; dbgCloseRect.y = y - 5; dbgCloseRect.w = cs; dbgCloseRect.h = cs;
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 1.8;
  const kx = dbgCloseRect.x + cs / 2, ky = dbgCloseRect.y + cs / 2;
  ctx.beginPath();
  ctx.moveTo(kx - 6, ky - 6); ctx.lineTo(kx + 6, ky + 6);
  ctx.moveTo(kx + 6, ky - 6); ctx.lineTo(kx - 6, ky + 6);
  ctx.stroke();

  ctx.fillStyle = '#9fe8c0';
  for (const l of lines) { ctx.fillText(l, x, y); y += lh; }
  y += 4;
  ctx.fillStyle = errorBuffer.length ? '#ff9a9a' : '#6f8f7f';
  for (const l of errLines) { ctx.fillText(l, x, y); y += lh; }

  // Save-wipe target: hold a finger on it to erase everything.
  y += 6;
  wipeRect.x = x; wipeRect.y = y; wipeRect.w = 128; wipeRect.h = 20;
  const k = Math.min(1, wipeHold / CFG.debug.wipeHoldTime);
  ctx.fillStyle = 'rgba(120,20,20,0.75)';
  ctx.fillRect(wipeRect.x, wipeRect.y, wipeRect.w, wipeRect.h);
  ctx.fillStyle = 'rgba(255,70,70,0.9)';
  ctx.fillRect(wipeRect.x, wipeRect.y, wipeRect.w * k, wipeRect.h);
  ctx.fillStyle = '#fff';
  ctx.fillText(wipeDone > 0 ? 'WIPED' : 'HOLD TO WIPE SAVE', wipeRect.x + 6, wipeRect.y + 5);

  // Two plain tap buttons beside it. The upgrade menu needs a visible way in, and a way back
  // to a clean level 1 belongs where you can reach it without going through the menu first.
  y += 26;
  const label = (rect, text, fill) => {
    ctx.fillStyle = fill;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, rect.x + 6, rect.y + 5);
  };
  upgBtnRect.x = x; upgBtnRect.y = y; upgBtnRect.w = 92; upgBtnRect.h = 20;
  label(upgBtnRect, 'UPGRADES', 'rgba(30,70,120,0.85)');
  lv1BtnRect.x = x + 100; lv1BtnRect.y = y; lv1BtnRect.w = 118; lv1BtnRect.h = 20;
  label(lv1BtnRect, lv1Done > 0 ? 'BACK AT LV 1' : 'RESET TO LV 1', 'rgba(96,72,20,0.85)');
  ctx.restore();
}

/** Puts the run back to a clean level 1 — no upgrades, no score, starting population. */
function resetToLevelOne() {
  applySave(sim, defaultSave(BASE_CONFIG));
  CFG = sim.config;
  palette.cur = null; palette.key = '';
  palette.fromP = null; palette.rush = 0;
  plateKey = ''; platesReady = false;
  spriteCache.clear();
  sky = deriveStars(serializeSave(sim), CFG);
  particles.length = 0;
  celebration = null;
  capGlory = 0;
  popups.length = 0;
  writeSave(true);
  lv1Done = 0.001;
}

/** Returns true if the point landed on one of the overlay's buttons. */
function debugButtonHit(px, py) {
  if (!debugOn || upgradeMenu.open) return false;
  const hit = (r) => r.w > 0 && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  if (hit(dbgCloseRect)) { debugOn = false; upgradeMenu.open = false; return true; }
  if (hit(upgBtnRect)) { upgradeMenu.open = true; return true; }
  if (hit(lv1BtnRect)) { resetToLevelOne(); return true; }
  return false;
}

/**
 * One finger held in the top-left corner toggles the debug overlay.
 *
 * This exists because every other route is unreachable on the device the toy is for: there is
 * no D key on a phone, and iOS reserves three- and four-finger gestures for itself, so a
 * multi-finger tap may never arrive. A single finger held in a corner always does.
 */
function updateDebugCorner(dt) {
  const s = CFG.debug.cornerSize;
  let inside = false;
  for (const p of pointers.values()) {
    if (p.x >= safe.l && p.x <= safe.l + s && p.y >= safe.t && p.y <= safe.t + s) inside = true;
  }
  if (!inside) { cornerHold = 0; cornerArmed = true; return; }
  cornerHold += dt;
  if (cornerArmed && cornerHold >= CFG.debug.cornerHoldTime) {
    cornerArmed = false;
    debugOn = !debugOn;
    if (!debugOn) upgradeMenu.open = false;
  }
}

/** The filling arc that makes the corner hold discoverable instead of a secret. */
function drawDebugCorner(P) {
  if (!cornerArmed) return;
  const k = (cornerHold - CFG.debug.cornerArcDelay)
    / (CFG.debug.cornerHoldTime - CFG.debug.cornerArcDelay);
  if (k <= 0) return;
  const s = CFG.debug.cornerSize;
  const cx = safe.l + s * 0.5;
  const cy = safe.t + s * 0.5;
  const r = s * 0.34;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = rgba(P.ring, 0.18);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = rgba(P.ring, 0.85);
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, k));
  ctx.stroke();
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
    if (wipeHold >= CFG.debug.wipeHoldTime && wipeDone === 0) {
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
  const E = CFG.effects;
  if (fps < E.particleShedFps) {
    const target = Math.max(E.particleShedFloor, fps / E.particleShedFps);
    particleBudget = Math.max(
      Math.round(E.maxParticles * E.particleShedFloor),
      Math.round(particleBudget * 0.94 + E.maxParticles * target * 0.06),
    );
  } else if (particleBudget < E.maxParticles) {
    particleBudget = Math.min(E.maxParticles, Math.round(particleBudget * 1.02 + 4));
  }

  // Atmosphere is the first thing to go when frames get tight, and physics is never the last.
  const S = CFG.sky;
  bgTier = fps < S.shedTier0Fps ? 0 : (fps < S.shedTier1Fps ? 1 : 2);

  const wantBloom = fps < E.bloomShedFps
    ? Math.max(E.bloomMinScale, CFG.render.bloomScale * 0.5)
    : CFG.render.bloomScale;
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
    if (needFirstDtClamp) { dt = CFG.world.resumeDt; needFirstDtClamp = false; }
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    // Hold gestures count REAL seconds. dt below is clamped to world.maxDt so that one long
    // frame cannot integrate a huge physics step — but feeding that clamped value to a
    // "hold for 1.5 seconds" timer means the timer runs slow exactly when the scene is busy.
    // Measured: a 1.5s hold needed 2.0s of wall clock at 22fps, and longer once the debug
    // overlay itself was drawing. The gesture felt broken because it WAS taking longer.
    uiDt = Math.min(dt, CFG.world.uiMaxDt);
    dt = Math.min(dt, CFG.world.maxDt);

    fpsSamples.push(dt);
    if (fpsSamples.length > CFG.debug.fpsWindow) fpsSamples.shift();
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
      if (frameFails >= CFG.debug.frameFailSoftReset) {
        frameFails = 0;
        softResetEffects();
      }
    }

    saveTimer += dt;
    if (saveTimer >= CFG.save.writeInterval) writeSave(false);
  } catch (err) {
    logError('loop', err && err.message);
  }
}

function render(dt) {
  const P = updatePalette(dt);
  orbHueN = orbHueCount(P);
  const calmT = 1 - Math.min(1, sim.intensity / Math.max(1e-6, CFG.intensity.calmBelow));
  const frenzyT = Math.min(1, Math.max(0, (sim.intensity - CFG.intensity.frenzyAbove)
    / Math.max(1e-6, 1 - CFG.intensity.frenzyAbove)));

  consumeEvents(P);
  updateEffects(dt);
  updateWipe(uiDt);
  updateDebugCorner(uiDt);
  updateHelpCorner(uiDt);
  applyPendingReload(uiDt);
  updateHelp(dt);
  if (lv1Done > 0) { lv1Done += dt; if (lv1Done > 1.6) lv1Done = 0; }
  adaptQuality();

  // Rolling score counter.
  const k = 1 - Math.exp(-dt / Math.max(1e-6, CFG.score.rollTau));
  displayScore += (sim.score - displayScore) * k;
  if (Math.abs(sim.score - displayScore) < CFG.score.rollSnapBelow) displayScore = sim.score;

  // --- trail layer: fade with destination-out, then draw the glowing stuff -----------
  let fadeBase = calmT > 0
    ? CFG.render.trailFadeCalm + (CFG.render.trailFade - CFG.render.trailFadeCalm) * (1 - calmT)
    : CFG.render.trailFade + (CFG.render.trailFadeFrenzy - CFG.render.trailFade) * frenzyT;
  // During a world change, hold the streaks longer: the outgoing world burns off on screen
  // while the incoming one draws over it, which is the whole point of a crossfade you can see.
  if (wash) fadeBase *= CFG.paletteRules.unlockTrailHoldMul;
  // ...and on a screen nobody has touched, scrub it properly. See render.trailFadeIdle: the
  // fade is a multiply, so below a few units per 255 it subtracts nothing and the layer keeps a
  // permanent grey residue. Left alone, an idle screen slowly fills with a lattice of old paths.
  const idle = (sim.untouchedTime - CFG.render.idleFadeAfter) / Math.max(1e-6, CFG.render.idleFadeRamp);
  if (idle > 0) fadeBase += (CFG.render.trailFadeIdle - fadeBase) * Math.min(1, idle);
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
    ? CFG.render.bloomStrengthCalm + (CFG.render.bloomStrength - CFG.render.bloomStrengthCalm) * (1 - calmT)
    : CFG.render.bloomStrength + (CFG.render.bloomStrengthFrenzy - CFG.render.bloomStrength) * frenzyT;
  bloomACtx.setTransform(1, 0, 0, 1, 0, 0);
  bloomACtx.clearRect(0, 0, bloomA.width, bloomA.height);
  bloomACtx.drawImage(trail, 0, 0, bloomA.width, bloomA.height);
  if (CFG.render.bloomPasses > 1) {
    bloomBCtx.setTransform(1, 0, 0, 1, 0, 0);
    bloomBCtx.clearRect(0, 0, bloomB.width, bloomB.height);
    bloomBCtx.drawImage(bloomA, 0, 0, bloomB.width, bloomB.height);
  }

  // --- stage ------------------------------------------------------------------------
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  const sy = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  shakeX = sx; shakeY = sy;
  ctx.save();
  ctx.translate(sx, sy);

  drawBackground(P, calmT, frenzyT);

  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(trail, 0, 0, cssW, cssH);

  ctx.globalAlpha = strength;
  ctx.drawImage(bloomA, 0, 0, cssW, cssH);
  if (CFG.render.bloomPasses > 1) {
    ctx.globalAlpha = strength * 0.7;
    ctx.drawImage(bloomB, 0, 0, cssW, cssH);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  drawComet(P);
  drawVortices(P);
  drawBallDetail(P);
  drawConverts(P);
  drawProofs(P);
  drawTracers(P);
  drawFields(P);
  drawHud(P, calmT);

  if (flash > 0) {
    const a = flashMax * (flash / CFG.effects.flashTime);
    if (flashAdd) ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba(flashCol || P.fog, a);
    ctx.fillRect(-8, -8, cssW + 16, cssH + 16);
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();

  // The two debug panels occupy the same corner, so only one shows at a time.
  if (debugOn && !upgradeMenu.open && !help.open) drawDebug(P, physMs, fps);
  if (!help.open) drawDebugCorner(P);
  if (upgradeMenu.open && !help.open) drawUpgradeMenu(P);
  drawHelpCorner(P);
  drawDemo(P);
  drawHelp(P, dt);
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
      if (CFG.save.writeOnHide) writeSave(true);
    } else {
      paused = false;
      needFirstDtClamp = true;   // clamp the first dt after resume, or everything teleports
      lastTime = 0;
      checkForUpdate();
    }
  });
  window.addEventListener('pagehide', () => { if (CFG.save.writeOnHide) writeSave(true); });
} catch (e) { logError('life', e.message); }

/* ========================================================================== */
/* Picking up a new build                                                     */
/*                                                                            */
/* sw.js calls skipWaiting() and clients.claim(), so a new version takes       */
/* control as soon as it installs. Claiming a page does not RELOAD it though,  */
/* and the modules already running are the old ones. A home-screen app on iOS  */
/* is resumed from the switcher rather than re-navigated, so a player could    */
/* sit on a stale build indefinitely — the only cure being to force-quit the   */
/* app, which is not a thing anyone thinks to do to a toy.                     */
/* ========================================================================== */

let pendingReload = 0;        // seconds a reload has been waiting for a quiet moment
let lastUpdateCheck = -1e9;

/**
 * Is the build on the server still the build we are running?
 *
 * This reads sw.js directly rather than leaning on the service worker lifecycle. Asking the
 * registration to update() and waiting for it to claim the page turned out not to be dependable
 * enough to hang the whole update story on — the call is advisory, the browser may coalesce or
 * defer it, and a fire-and-forget one frequently did nothing at all. Every deploy already bumps
 * CACHE_VERSION in that file (the worker cannot work without it), so it doubles as a build stamp
 * that can be read in one no-store fetch of a few kilobytes, on resume, at most once a minute.
 *
 * The worker is still told to update as well — that is what actually swaps the cached assets.
 * This just makes the decision to reload something observable rather than something hoped for.
 */
let buildStamp = null;        // CACHE_VERSION as it was when this page loaded

function readBuildStamp() {
  // Offline is not a failure, it is just not a question worth asking — and attempting it anyway
  // prints a network error to the console on every resume of an installed offline app, which is
  // exactly the sort of routine noise that later hides a real one.
  try { if (navigator.onLine === false) return Promise.resolve(null); } catch (_) {}
  // The query string is load-bearing. An ALREADY-INSTALLED old worker is what stands between a
  // stuck app and the fix, and that old worker serves assets cache-first — including, before the
  // bail added to sw.js, its own script. So a plain './sw.js' fetch is answered from its cache
  // with the very build we are trying to move off, forever. A unique URL cannot be matched in
  // any cache, so it always reaches the network, which is the only way this check can ever
  // notice anything on the exact installs that need it most.
  return fetch('./sw.js?stamp=' + Math.floor(nowSec() * 1000), { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((t) => { const m = t.match(/CACHE_VERSION\s*=\s*'([^']+)'/); return m ? m[1] : null; })
    .catch(() => null);
}

function checkForUpdate() {
  if (!CFG.update.checkOnResume) return;
  const t = nowSec();
  if (t - lastUpdateCheck < CFG.update.checkThrottle) return;
  lastUpdateCheck = t;
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration()
        .then((r) => { if (r) return r.update(); })
        .catch(() => {});
    }
  } catch (_) {}
  // The file on the server is the authority on which build is deployed. Asking the service
  // worker to update and waiting for it to claim the page was tried first and is not dependable
  // enough to hang this on — the call is advisory and frequently did nothing at all. So: if the
  // stamp has moved, drop our caches and reload. Dropping them first is what makes the reload
  // mean something, because assets are served cache-first and a reload onto a live old cache
  // hands the page back the exact build it is trying to leave.
  readBuildStamp().then((v) => {
    if (!v) return;
    if (buildStamp === null) { buildStamp = v; return; }
    if (v === buildStamp || pendingReload !== 0) return;
    buildStamp = v;
    dropCachesThen(() => { pendingReload = 1e-6; });
  });
}

/** Delete only this app's caches, then continue. Never blocks on failure. */
function dropCachesThen(done) {
  const go = () => { try { done(); } catch (_) {} };
  try {
    if (!('caches' in window)) { go(); return; }
    const pre = CFG.update.cachePrefix;
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.indexOf(pre) === 0).map((n) => caches.delete(n))))
      .then(go, go);
  } catch (_) { go(); }
}

function applyPendingReload(dt) {
  if (pendingReload <= 0) return;
  pendingReload += dt;
  const quiet = sim.untouchedTime >= CFG.update.quietBeforeReload && pointers.size === 0;
  if (!quiet && pendingReload < CFG.update.maxWaitForQuiet) return;
  try { writeSave(true); } catch (_) {}
  pendingReload = 0;
  try { location.reload(); } catch (_) {}
}

// Read the build stamp once at startup. Everything after this compares against it.
try { readBuildStamp().then((v) => { if (buildStamp === null) buildStamp = v; }); } catch (_) {}

/**
 * Wait for a NEW worker to finish activating, then queue the reload.
 *
 * The ordering matters and is the whole reason this is not just "reload when the file changes".
 * Assets are served cache-first, so reloading before the new worker has activated hands the page
 * the OLD cached main.js and config.js and nothing changes — which is exactly the trap a stale
 * install falls into. A new worker precaches under a new cache name during install and deletes
 * the old one on activate, so only once it is active does a reload actually get the new build.
 */
function watchWorker(reg) {
  if (!reg) return;
  const follow = (w) => {
    if (!w) return;
    w.addEventListener('statechange', () => {
      if (w.state === 'activated' && pendingReload === 0) pendingReload = 1e-6;
    });
  };
  reg.addEventListener('updatefound', () => follow(reg.installing));
  follow(reg.waiting);
}

try {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(watchWorker).catch(() => {});
    // `hadController` is load-bearing, and it has to be RE-EVALUATED rather than frozen at boot.
    // On a first ever visit the page starts with no controller and gets one the moment the worker
    // claims it; reloading there would be a reload on every player's first launch, and with a slow
    // install, a loop. But main.js runs before the worker is even registered, so a value captured
    // once stays false forever and no later update is ever picked up either — which is the exact
    // bug that let a phone sit on a stale build.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const isUpdate = hadController;
      hadController = !!navigator.serviceWorker.controller;
      if (isUpdate && pendingReload === 0) pendingReload = 1e-6;
    });
  }
} catch (e) { logError('life', 'sw update: ' + e.message); }

// Expose a small handle for the headless harness and for poking around in Safari's
// inspector. Nothing in the app reads this.
try {
  window.ORBS = {
    sim,
    get CONFIG() { return sim.config; },
    BASE_CONFIG,
    get errors() { return errorBuffer.slice(); },
    get stats() {
      return {
        fps, physMs, renderMs, balls: sim.aliveCount, particles: particles.length,
        score: sim.score, level: sim.level, combo: sim.comboCount,
        intensity: sim.intensity, mode: sim.mode, sanitizer: sim.sanitizerHits,
        eventsDropped: sim.eventsDropped, eventsDroppedTotal: sim.eventsDroppedTotal,
        stars: sky.stars.length,
        storage: store.available, dpr, bloomScale, particleBudget,
        cssW, cssH, safe: Object.assign({}, safe), palette: palette.cur && palette.cur.name,
      };
    },
    wipe() { wipeSave(); },
    save() { writeSave(true); },
    toggleDebug() { debugOn = !debugOn; },
    upgrades() { return (CFG.upgrades || []).map((u) => ({ ...u, applied: sim.appliedUpgrades.has(u.id) })); },
    trigger(id) {
      const up = (CFG.upgrades || []).find((u) => u.id === id);
      if (up) triggerUpgrade(up);
      return !!up;
    },
    grantLevels,
    help,
    openHelp(id) { openHelp(id || null, 0); },
    closeHelp() { closeHelp(); },
    helpSections() { return HELP.map((h) => h.id); },
    get seenHelp() { return sim.seenHelp === true; },
    proofCount() { return proofs.length; },
    // The close crosses, so an automated check can press the same pixels a thumb would.
    closeTargets() {
      return {
        debug: { cx: dbgCloseRect.x + dbgCloseRect.w / 2, cy: dbgCloseRect.y + dbgCloseRect.h / 2 },
      };
    },
    menu(open) { upgradeMenu.open = open !== false; debugOn = debugOn || upgradeMenu.open; },
    // The menu's live hit-boxes, so an automated check can press the same pixels a thumb would.
    get menuState() {
      return {
        open: upgradeMenu.open, page: upgradeMenu.page,
        rows: upgradeMenu.rows.map((r) => ({ id: r.up.id, level: r.up.level, cx: r.x + r.w / 2, cy: r.y + r.h / 2 })),
        buttons: upgradeMenu.buttons.map((b) => ({ act: b.act, cx: b.x + b.w / 2, cy: b.y + b.h / 2 })),
        debug: debugOn,
        overlay: {
          upgrades: { cx: upgBtnRect.x + upgBtnRect.w / 2, cy: upgBtnRect.y + upgBtnRect.h / 2 },
          resetLv1: { cx: lv1BtnRect.x + lv1BtnRect.w / 2, cy: lv1BtnRect.y + lv1BtnRect.h / 2 },
        },
      };
    },
  };
} catch (_) {}

requestAnimationFrame(frame);
