/*
 * sim.js — the pure simulation core of Orbs.
 *
 * RULES THIS FILE OBEYS, WITHOUT EXCEPTION:
 *   - No DOM, no canvas, no window, no document.
 *   - No Date.now(), no performance.now(). Time is passed into step().
 *   - No Math.random(). All randomness comes from the injected seeded PRNG.
 *   - No tunable numbers. Every constant lives in config.js.
 *
 * Consequence: the same seed plus the same scripted inputs produces a bit-identical
 * state, forever. test.js leans on that hard.
 *
 * The renderer reads `sim.events` (cleared and refilled every step) and draws from it.
 * The sim never knows what an effect looks like — only that one happened, and where.
 */

import { CONFIG } from './config.js';

export const SAVE_VERSION = CONFIG.save.version;

/* ========================================================================== */
/* PRNG                                                                       */
/* ========================================================================== */

/**
 * mulberry32 — small, fast, good enough, and trivially serialisable.
 * The whole sim's randomness flows through one of these.
 */
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const rng = {
    getState() { return s >>> 0; },
    setState(v) { s = (v >>> 0) || 0x9e3779b9; },
    float() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(a, b) { return a + (b - a) * rng.float(); },
    int(n) { return n <= 0 ? 0 : Math.min(n - 1, Math.floor(rng.float() * n)); },
    pick(arr) { return arr[rng.int(arr.length)]; },
    sign() { return rng.float() < 0.5 ? -1 : 1; },
    angle() { return rng.float() * Math.PI * 2; },
  };
  return rng;
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

const TAU = Math.PI * 2;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function fin(v, fallback) { return Number.isFinite(v) ? v : fallback; }

/** Exponential smoothing factor for a time constant `tau` over `dt`. */
function smoothK(tau, dt) {
  if (!(tau > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

/** Deterministic 32-bit string hash (FNV-1a). Used for the sky and state hashing. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mixes a 32-bit integer into a well-distributed 32-bit integer. */
function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/* ========================================================================== */
/* Levels, combo, milestones — pure functions of the config                   */
/* ========================================================================== */

/** XP required to advance FROM `level` to `level + 1`. Strictly increasing in level. */
export function levelThreshold(level, config = CONFIG) {
  const L = config.levels;
  const n = Math.max(1, level);
  return Math.round(L.base * Math.pow(n, L.exp) + L.linear * n);
}

/** Combo multiplier. Sublinear in count, uncapped, exactly 1 at count 0. */
export function comboMultiplier(count, config = CONFIG) {
  if (count <= 0) return 1;
  const S = config.score;
  return 1 + S.comboMultScale * Math.pow(count, S.comboMultExp);
}

/** The full ascending ladder of lifetime-score milestones. */
export function milestoneLadder(config = CONFIG) {
  const M = config.milestones;
  const out = [];
  for (let e = M.startExp; e <= M.maxExp; e++) {
    for (const m of M.mantissas) {
      const v = Math.round(m * Math.pow(10, e));
      if (out.length === 0 || v > out[out.length - 1]) out.push(v);
    }
  }
  return out;
}

/** Best-combo filigree tier: how many thresholds the lifetime best combo has passed. */
export function filigreeTier(bestCombo, config = CONFIG) {
  const tiers = config.filigree.tiers;
  let t = 0;
  for (let i = 0; i < tiers.length; i++) if (bestCombo >= tiers[i]) t = i + 1;
  return t;
}

/** How many palettes are unlocked at a given level. Always at least 1. */
export function palettesUnlockedAt(level, config = CONFIG) {
  const every = Math.max(1, config.paletteRules.unlockEvery);
  const n = 1 + Math.floor(Math.max(0, level - 1) / every);
  return clamp(n, 1, config.palettes.length);
}

/* ========================================================================== */
/* The sky — permanent, derived deterministically from the save               */
/* ========================================================================== */

/**
 * Stars are a pure function of the save's milestone list. Same save, same sky,
 * on any device, forever. Past `sky.maxStars` the count is capped and further
 * milestones brighten the existing stars instead of adding new ones.
 *
 * Returns { stars: [{x, y, mag, seed}], links: [[i, j]], extra, brighten }
 * with x/y normalised to 0..1.
 */
export function deriveStars(save, config = CONFIG) {
  const S = config.sky;
  const ids = (save && Array.isArray(save.milestones)) ? save.milestones : [];
  const capped = Math.min(ids.length, S.maxStars);
  const extra = Math.max(0, ids.length - S.maxStars);
  const brighten = Math.min(S.maxBrighten, extra * S.brightenPerExtra);

  const stars = [];
  for (let i = 0; i < capped; i++) {
    const h = hashString('star:' + String(ids[i]));
    const hx = mix32(h);
    const hy = mix32(h ^ 0x9e3779b9);
    const hm = mix32(h ^ 0x85ebca6b);
    const inset = S.edgeInset;
    stars.push({
      id: String(ids[i]),
      x: inset + (hx / 4294967296) * (1 - inset * 2),
      y: inset + (hy / 4294967296) * (1 - inset * 2),
      mag: S.baseMag + (hm / 4294967296) * S.magVariance + brighten,
      seed: h,
    });
  }

  // Constellation lines accrue slowly: a regular's sky knits itself together over weeks.
  const budget = Math.min(S.maxLinks, Math.floor(stars.length * S.linksPerStars));
  const cand = [];
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const dx = stars[i].x - stars[j].x;
      const dy = stars[i].y - stars[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= S.linkDistance) cand.push([d, i, j]);
    }
  }
  // Deterministic ordering: shortest first, ties broken by index.
  cand.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
  const links = [];
  for (let k = 0; k < cand.length && links.length < budget; k++) {
    links.push([cand[k][1], cand[k][2]]);
  }

  return { stars, links, extra, brighten };
}

/* ========================================================================== */
/* Save                                                                       */
/* ========================================================================== */

export function defaultSave(config = CONFIG) {
  return {
    v: config.save.version,
    lifetimeScore: 0,
    level: 1,
    xp: 0,
    bestCombo: 0,
    milestones: [],
    unlocked: ['ORB'],
    cometsBroken: 0,
    playTime: 0,
    plays: 0,
    paletteIndex: 0,
    seenHint: false,
  };
}

/**
 * Parse a save defensively. Anything wrong — corrupt JSON, wrong version, missing or
 * mistyped fields, hostile values — yields clean defaults. This function never throws.
 */
export function loadSave(raw, config = CONFIG) {
  const def = defaultSave(config);
  let obj = raw;
  try {
    if (typeof raw === 'string') obj = JSON.parse(raw);
  } catch (_) {
    return def;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return def;
  if (obj.v !== config.save.version) return def;

  const num = (v, d, lo, hi) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return d;
    return clamp(n, lo, hi);
  };

  const out = defaultSave(config);
  out.lifetimeScore = Math.floor(num(obj.lifetimeScore, 0, 0, Number.MAX_SAFE_INTEGER));
  out.level = Math.floor(num(obj.level, 1, 1, 1e6));
  out.xp = Math.floor(num(obj.xp, 0, 0, Number.MAX_SAFE_INTEGER));
  out.bestCombo = Math.floor(num(obj.bestCombo, 0, 0, Number.MAX_SAFE_INTEGER));
  out.cometsBroken = Math.floor(num(obj.cometsBroken, 0, 0, Number.MAX_SAFE_INTEGER));
  out.playTime = num(obj.playTime, 0, 0, 1e12);
  out.plays = Math.floor(num(obj.plays, 0, 0, 1e9));
  out.paletteIndex = Math.floor(num(obj.paletteIndex, 0, 0, config.palettes.length - 1));
  out.seenHint = obj.seenHint === true;

  // Milestones: strings only, deduped, order preserved (order defines the sky).
  if (Array.isArray(obj.milestones)) {
    const seen = new Set();
    for (const m of obj.milestones) {
      if (typeof m !== 'string' && typeof m !== 'number') continue;
      const s = String(m);
      if (s.length > 64 || seen.has(s)) continue;
      seen.add(s);
      out.milestones.push(s);
      if (out.milestones.length >= 4096) break;
    }
  }

  // Unlocked types: only real type keys, ORB always present, canonical order.
  const known = ['ORB', ...config.unlockOrder];
  const want = new Set(['ORB']);
  if (Array.isArray(obj.unlocked)) {
    for (const k of obj.unlocked) if (known.indexOf(k) >= 0) want.add(k);
  }
  out.unlocked = known.filter((k) => want.has(k));

  return out;
}

/** Extract the persistent save payload from a live sim. */
export function serializeSave(sim) {
  return {
    v: sim.config.save.version,
    lifetimeScore: Math.floor(sim.score),
    level: sim.level,
    xp: Math.floor(sim.xp),
    bestCombo: Math.floor(sim.bestCombo),
    milestones: sim.milestones.slice(),
    unlocked: sim.unlocked.slice(),
    cometsBroken: sim.cometsBroken,
    playTime: Math.round(sim.playTime * 1000) / 1000,
    plays: sim.plays,
    paletteIndex: sim.paletteIndex,
    seenHint: sim.seenHint === true,
  };
}

/* ========================================================================== */
/* Sim construction                                                           */
/* ========================================================================== */

export function createSim(opts = {}) {
  const config = opts.config || CONFIG;
  const rng = opts.rng || makeRng(1);
  const width = Math.max(1, fin(opts.width, 390));
  const height = Math.max(1, fin(opts.height, 844));
  const save = loadSave(opts.save != null ? opts.save : defaultSave(config), config);

  const sim = {
    config, rng,
    width, height,
    scale: 1,
    time: 0,
    frame: 0,

    balls: [],
    shards: [],
    pointers: new Map(),
    nextId: 1,
    aliveCount: 0,
    needsCompact: false,

    events: [],
    eventsDropped: 0,

    score: save.lifetimeScore,
    scoreThisStep: 0,
    comboCount: 0,
    comboMult: 1,
    comboTimer: 0,
    comboDecayAcc: 0,
    bestCombo: save.bestCombo,
    sessionBestCombo: 0,

    level: save.level,
    xp: save.xp,
    xpNeeded: levelThreshold(save.level, config),
    unlocked: save.unlocked.slice(),
    globalMult: 1,
    milestones: save.milestones.slice(),
    cometsBroken: save.cometsBroken,
    playTime: save.playTime,
    plays: save.plays + 1,
    paletteIndex: save.paletteIndex,
    seenHint: save.seenHint,

    intensity: 0,
    mode: 'CALM',
    untouchedTime: config.intensity.calmSettleTime,
    hardImpactsThisStep: 0,
    effectsThisStep: 0,

    softCap: 0,
    despawnTimer: 0,
    respawnTimer: 0,

    comet: null,
    cometTimer: config.comet.minGap * 0.5,

    sanitizerHits: 0,
    stepCount: 0,

    // Scratch, reused across steps so the hot loop allocates nothing.
    _grid: new Map(),
    _cell: 1,
    _gw: 1,
    _impacts: [],
    _magnets: [],
    _near: [],
    _weights: [],
    _keys: [],
  };

  sim._milestoneSet = new Set(sim.milestones);
  sim._ladder = milestoneLadder(config);
  sim._res = {};
  for (const r of config.resonances) sim._res[r.id] = r;

  resize(sim, width, height);
  refreshDerived(sim);

  for (let i = 0; i < config.population.startCount; i++) {
    const b = spawnBall(sim, { anywhere: true, fade: 1 });
    if (!b) break;
  }
  return sim;
}

/** Recompute everything that follows from level/unlocks. */
function refreshDerived(sim) {
  const C = sim.config;
  sim.xpNeeded = levelThreshold(sim.level, C);
  const lastUnlockLevel = Math.max(...C.unlockOrder.map((k) => C.types[k].unlockLevel));
  const past = Math.max(0, sim.level - lastUnlockLevel);
  sim.globalMult = C.score.globalMultBase + C.score.globalMultPerLevel * past;
  const nudge = Math.max(0, sim.level - C.levels.capNudgeStart) * C.levels.capNudgePerLevel;
  sim.softCap = Math.min(
    C.population.hardCap,
    Math.round(C.population.softCapBase + C.population.softCapPerLevel * (sim.level - 1) + nudge),
  );
  sim.palettesUnlocked = palettesUnlockedAt(sim.level, C);
  sim.filigreeTier = filigreeTier(sim.bestCombo, C);
}

/** Re-measure the world. Balls are rescaled and re-clamped so rotation never strands one. */
export function resize(sim, width, height) {
  const C = sim.config;
  const w = Math.max(1, fin(width, sim.width));
  const h = Math.max(1, fin(height, sim.height));
  const oldW = sim.width, oldH = sim.height, oldScale = sim.scale;

  sim.width = w;
  sim.height = h;
  sim.scale = Math.max(0.25, Math.min(w, h) / C.world.referenceDim);
  const midR = (C.balls.radiusMin + C.balls.radiusMax) * 0.5 * sim.scale;
  sim.refMass = C.balls.density * Math.pow(midR, C.balls.densityExp);
  sim.refSpeed = C.score.refSpeed * sim.scale;

  const sx = w / oldW, sy = h / oldH;
  const rs = sim.scale / oldScale;
  if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(rs)) {
    for (const b of sim.balls) {
      b.x = fin(b.x * sx, w * 0.5);
      b.y = fin(b.y * sy, h * 0.5);
      b.r = Math.max(1, fin(b.r * rs, 6));
      b.mass = C.balls.density * Math.pow(b.r, C.balls.densityExp);
      b.invMass = 1 / b.mass;
      clampIntoBounds(sim, b);
    }
    for (const s of sim.shards) {
      s.x = fin(s.x * sx, w * 0.5);
      s.y = fin(s.y * sy, h * 0.5);
      s.vx = fin(s.vx * rs, 0);
      s.vy = fin(s.vy * rs, 0);
    }
  }
  for (const f of sim.pointers.values()) {
    f.x = fin(f.x * sx, w * 0.5); f.y = fin(f.y * sy, h * 0.5);
    f.sx = fin(f.sx * sx, f.x); f.sy = fin(f.sy * sy, f.y);
    f.vx = 0; f.vy = 0;
  }
  return sim;
}

/* ========================================================================== */
/* Balls                                                                      */
/* ========================================================================== */

function pickType(sim) {
  const C = sim.config;
  const keys = sim._keys; keys.length = 0;
  const w = sim._weights; w.length = 0;
  let total = 0;
  for (const k of sim.unlocked) {
    const t = C.types[k];
    if (!t) continue;
    keys.push(k); w.push(t.weight); total += t.weight;
  }
  if (total <= 0) return 'ORB';
  let roll = sim.rng.float() * total;
  for (let i = 0; i < keys.length; i++) {
    roll -= w[i];
    if (roll <= 0) return keys[i];
  }
  return keys[keys.length - 1];
}

function makeBall(sim, x, y, r, type, fade) {
  const C = sim.config;
  const mass = C.balls.density * Math.pow(r, C.balls.densityExp);
  return {
    id: sim.nextId++,
    type,
    x, y, vx: 0, vy: 0,
    r, mass, invMass: 1 / mass,
    phase: sim.rng.float() * TAU,
    seed: mix32(sim.nextId * 2654435761),
    hue: sim.rng.int(4),
    alive: true,
    fade: fade == null ? 0 : fade,
    dying: false,
    born: sim.time,
    effectT: 0,
    scoreT: 0,
    inertT: 0,
    frozenT: 0,
    immuneT: 0,
    spikeT: 0,
    splitT: 0,
    magnetT: 0,
    chargeT: 0,       // s of "traceable to a finger" left. Gates type effects; see config.charge.
    escaped: false,
    frozenFromX: x,
    frozenFromY: y,
    lastHitT: -99,
    pulse: 0,
  };
}

/** Spawn a ball. Returns null if the hard cap forbids it. */
function spawnBall(sim, opt = {}) {
  const C = sim.config;
  if (sim.aliveCount >= C.population.hardCap) return null;
  const s = sim.scale;
  const rng = sim.rng;

  const u = Math.pow(rng.float(), C.balls.radiusBias);
  const r = (C.balls.radiusMin + (C.balls.radiusMax - C.balls.radiusMin) * u) * s;
  const type = opt.type || pickType(sim);

  let x, y, vx, vy;
  const inset = C.population.spawnEdgeInset * s + r;
  if (opt.anywhere) {
    x = rng.range(r + 2, Math.max(r + 3, sim.width - r - 2));
    y = rng.range(r + 2, Math.max(r + 3, sim.height - r - 2));
    const a = rng.angle();
    const sp = C.population.spawnSpeed * s * rng.range(0.2, 1);
    vx = Math.cos(a) * sp; vy = Math.sin(a) * sp;
  } else {
    const edge = rng.int(4);
    const sp = C.population.spawnSpeed * s * rng.range(0.5, 1.2);
    if (edge === 0) { x = rng.range(inset, sim.width - inset); y = inset; vx = rng.range(-0.5, 0.5) * sp; vy = sp; }
    else if (edge === 1) { x = sim.width - inset; y = rng.range(inset, sim.height - inset); vx = -sp; vy = rng.range(-0.5, 0.5) * sp; }
    else if (edge === 2) { x = rng.range(inset, sim.width - inset); y = sim.height - inset; vx = rng.range(-0.5, 0.5) * sp; vy = -sp; }
    else { x = inset; y = rng.range(inset, sim.height - inset); vx = sp; vy = rng.range(-0.5, 0.5) * sp; }
  }

  const b = makeBall(sim, fin(x, sim.width * 0.5), fin(y, sim.height * 0.5), r, type, opt.fade);
  b.vx = fin(vx, 0); b.vy = fin(vy, 0);
  sim.balls.push(b);
  sim.aliveCount++;
  return b;
}

function clampIntoBounds(sim, b) {
  const pad = sim.config.world.boundsPad * sim.scale;
  const lo = pad + b.r, hiX = sim.width - pad - b.r, hiY = sim.height - pad - b.r;
  b.x = hiX >= lo ? clamp(b.x, lo, hiX) : sim.width * 0.5;
  b.y = hiY >= lo ? clamp(b.y, lo, hiY) : sim.height * 0.5;
}

/** Re-scatter every ball. Score, level and combo are deliberately untouched. */
export function scatter(sim) {
  const C = sim.config, rng = sim.rng, s = sim.scale;
  for (const b of sim.balls) {
    if (!b.alive) continue;
    b.x = rng.range(b.r + 2, Math.max(b.r + 3, sim.width - b.r - 2));
    b.y = rng.range(b.r + 2, Math.max(b.r + 3, sim.height - b.r - 2));
    const a = rng.angle();
    const sp = C.population.scatterSpeed * s * rng.range(0.35, 1);
    b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
    b.frozenT = 0; b.dying = false; b.fade = Math.max(b.fade, 0.15);
  }
  pushEvent(sim, { type: 'scatter', x: sim.width * 0.5, y: sim.height * 0.5 });
  return sim;
}

/* ========================================================================== */
/* Events (budgeted; excess is dropped, never queued)                         */
/* ========================================================================== */

function pushEvent(sim, ev) {
  if (sim.events.length >= sim.config.effects.maxPerFrame) {
    sim.eventsDropped++;
    return false;
  }
  sim.events.push(ev);
  return true;
}

/* ========================================================================== */
/* Pointer fields                                                             */
/* ========================================================================== */

function makeField(sim, id, x, y) {
  return {
    id,
    x, y,            // raw pointer position
    sx: x, sy: y,    // smoothed ("weighty") field position
    vx: 0, vy: 0,    // smoothed field velocity
    speed: 0,
    amp: 0,          // press ramp 0..1
    gather: 0,       // morph amount 0..1
    stillT: 0,
    holdT: 0,
    spin: 0,
    down: true,
    releasing: 0,
    age: 0,
  };
}

function updatePointers(sim, dt, input) {
  const C = sim.config;
  const s = sim.scale;
  const list = (input && Array.isArray(input.pointers)) ? input.pointers : EMPTY;
  const cancelled = (input && Array.isArray(input.cancelled)) ? input.cancelled : EMPTY;

  // Cancellations (pointercancel / pointerleave / blur): the field vanishes, no sling.
  for (const id of cancelled) {
    if (sim.pointers.has(id)) {
      pushEvent(sim, { type: 'fieldCancel', x: sim.pointers.get(id).sx, y: sim.pointers.get(id).sy });
      sim.pointers.delete(id);
    }
  }

  const seen = sim._seen || (sim._seen = new Set());
  seen.clear();

  let n = 0;
  for (const p of list) {
    if (n++ >= C.input.maxPointers) break;
    if (!p || p.id == null) continue;
    const px = fin(p.x, sim.width * 0.5);
    const py = fin(p.y, sim.height * 0.5);
    seen.add(p.id);
    let f = sim.pointers.get(p.id);
    if (!f) {
      f = makeField(sim, p.id, px, py);
      sim.pointers.set(p.id, f);
      pushEvent(sim, { type: 'fieldDown', x: px, y: py, id: p.id });
    }
    f.x = px; f.y = py;
    f.down = true;
  }

  // Anything no longer reported has been released: sling, then remove.
  for (const [id, f] of sim.pointers) {
    if (!seen.has(id)) {
      slingField(sim, f);
      sim.pointers.delete(id);
    }
  }

  // Integrate every live field.
  const kPos = smoothK(C.field.smoothTau, dt);
  const kVel = smoothK(C.field.velTau, dt);
  const maxSpeed = C.field.maxFieldSpeed * s;
  for (const f of sim.pointers.values()) {
    const prevX = f.sx, prevY = f.sy;
    f.sx += (f.x - f.sx) * kPos;
    f.sy += (f.y - f.sy) * kPos;
    const ivx = dt > 0 ? (f.sx - prevX) / dt : 0;
    const ivy = dt > 0 ? (f.sy - prevY) / dt : 0;
    f.vx += (clamp(fin(ivx, 0), -maxSpeed, maxSpeed) - f.vx) * kVel;
    f.vy += (clamp(fin(ivy, 0), -maxSpeed, maxSpeed) - f.vy) * kVel;
    f.speed = Math.hypot(f.vx, f.vy);

    f.age += dt;
    f.holdT += dt;
    f.amp = C.field.pressRampTime > 0 ? Math.min(1, f.age / C.field.pressRampTime) : 1;

    // Held nearly still long enough? Morph into an attractor.
    const still = f.speed < C.gather.stillSpeed * s;
    if (still) {
      f.stillT += dt;
      if (f.stillT >= C.gather.stillTime) {
        f.gather = Math.min(1, f.gather + dt / Math.max(1e-6, C.gather.morphIn));
      }
    } else {
      f.stillT = 0;
      f.holdT = 0;
      f.gather = Math.max(0, f.gather - dt / Math.max(1e-6, C.gather.morphOut));
    }
    f.spin = C.gather.spinRampTime > 0
      ? Math.min(1, f.spin + dt / C.gather.spinRampTime) * (f.gather > 0 ? 1 : 0)
      : (f.gather > 0 ? 1 : 0);
    if (f.gather <= 0) f.spin = 0;
  }
}

const EMPTY = [];

/** Release: throw whatever this field had gathered into the crowd. */
function slingField(sim, f) {
  const C = sim.config, s = sim.scale, rng = sim.rng;
  if (f.gather <= 0.06) {
    pushEvent(sim, { type: 'fieldUp', x: f.sx, y: f.sy, gather: f.gather });
    return;
  }

  const capR = C.gather.captureRadius * s;
  const capR2 = capR * capR;
  const caught = sim._near; caught.length = 0;
  for (const b of sim.balls) {
    if (!b.alive || b.dying) continue;
    const dx = b.x - f.sx, dy = b.y - f.sy;
    if (dx * dx + dy * dy <= capR2) {
      caught.push(b);
      if (caught.length >= C.gather.maxCapture) break;
    }
  }
  if (caught.length === 0) {
    pushEvent(sim, { type: 'fieldUp', x: f.sx, y: f.sy, gather: f.gather });
    return;
  }

  const charge = clamp(f.holdT / Math.max(1e-6, C.gather.slingChargeMax), 0, 1);
  const power = (1 + charge * C.gather.slingChargeGain) * f.gather;
  const flicking = f.speed > C.gather.flickSpeed * s;
  let dirX = 0, dirY = 0;
  if (flicking) {
    const inv = 1 / Math.max(1e-6, f.speed);
    dirX = f.vx * inv; dirY = f.vy * inv;
  }

  const base = (C.gather.slingBase + C.gather.slingPerBall * (caught.length - 1)) * s * power;
  for (const b of caught) {
    const dx = b.x - f.sx, dy = b.y - f.sy;
    const d = Math.max(1e-4, Math.hypot(dx, dy));
    const nx = dx / d, ny = dy / d;
    let ax, ay;
    if (flicking) {
      // Follow the flick, with a little of the ball's own radial offset folded in.
      ax = dirX * C.gather.flickGain + nx * 0.35;
      ay = dirY * C.gather.flickGain + ny * 0.35;
    } else {
      ax = nx; ay = ny;
    }
    const al = Math.max(1e-4, Math.hypot(ax, ay));
    ax /= al; ay /= al;
    const spread = (rng.float() - 0.5) * C.gather.slingSpread;
    const cs = Math.cos(spread), sn = Math.sin(spread);
    const rx = ax * cs - ay * sn, ry = ax * sn + ay * cs;

    // Keep a slice of the orbital tangential velocity so the sling looks like a release,
    // not a teleport.
    const tvx = -ny, tvy = nx;
    const tang = b.vx * tvx + b.vy * tvy;
    b.vx = rx * base + tvx * tang * C.gather.slingSpin;
    b.vy = ry * base + tvy * tang * C.gather.slingSpin;
    b.chargeT = Math.max(b.chargeT, C.charge.slingTime);
    b.frozenT = 0;
  }

  sim.comboTimer = Math.max(sim.comboTimer, C.gather.slingComboGrace);
  pushEvent(sim, {
    type: 'sling', x: f.sx, y: f.sy, count: caught.length,
    power, flick: flicking, dx: dirX, dy: dirY,
  });
  caught.length = 0;
}

/* ========================================================================== */
/* Broadphase                                                                 */
/* ========================================================================== */

function buildGrid(sim) {
  const grid = sim._grid;
  grid.clear();
  let maxR = 1;
  for (const b of sim.balls) if (b.alive && !b.dying && b.r > maxR) maxR = b.r;
  const cell = Math.max(4, maxR * sim.config.collision.gridCellScale);
  sim._cell = cell;
  sim._gw = Math.max(1, Math.ceil(sim.width / cell) + 2);
  for (let i = 0; i < sim.balls.length; i++) {
    const b = sim.balls[i];
    if (!b.alive || b.dying) continue;
    const cx = Math.floor(b.x / cell), cy = Math.floor(b.y / cell);
    const key = cy * 73856093 + cx;
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(i);
  }
}

/** Collect indices of balls in the 3x3 cell block around (x, y) into `out`. */
function queryNeighbors(sim, x, y, out) {
  const cell = sim._cell, grid = sim._grid;
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const arr = grid.get((cy + oy) * 73856093 + (cx + ox));
      if (arr) for (let i = 0; i < arr.length; i++) out.push(arr[i]);
    }
  }
  return out;
}

/* ========================================================================== */
/* Forces                                                                     */
/* ========================================================================== */

function applyForces(sim, h) {
  const C = sim.config;
  const s = sim.scale;
  const inten = sim.intensity;

  const gx = C.world.gravityX * s;
  const gy = C.world.gravityY * s;
  const driftAmp = C.world.idleDriftStrength * s *
    lerp(C.world.idleDriftCalmBoost, 1, clamp(inten / Math.max(1e-6, C.intensity.frenzyAbove), 0, 1));
  const sA = C.world.idleDriftSpaceA / s;
  const sB = C.world.idleDriftSpaceB / s;
  const rA = C.world.idleDriftRateA * TAU;
  const rB = C.world.idleDriftRateB * TAU;
  const t = sim.time;

  const dragRate = C.world.drag * lerp(1, C.world.dragFrenzyScale, clamp(inten, 0, 1));
  const clampSpeed = C.world.speedClamp * s;

  // Magnets get gathered once per substep; there are never many.
  const mags = sim._magnets; mags.length = 0;
  for (const b of sim.balls) {
    if (b.alive && !b.dying && b.type === 'MAGNET' && b.frozenT <= 0) mags.push(b);
  }
  const magCfg = C.types.MAGNET;
  const magR = magCfg.pullRadius * s;
  const magR2 = magR * magR;
  const goldRes = sim._res.magnetGold;

  const fields = sim.pointers;
  const fRadius = C.field.radius * s;
  const fRadiusG = C.gather.radiusGather * s;
  const minD = C.field.minDist * s;
  const strength = C.field.strength * s;
  const orbitR = C.gather.orbitRadius * s;
  const orbitSpin = C.gather.orbitSpin * s;
  const pull = C.gather.pull * s;
  const refMass = sim.refMass;

  for (const b of sim.balls) {
    if (!b.alive) continue;
    let ax = gx, ay = gy;

    // Idle drift: a divergence-free-ish wander so an untouched screen stays alive
    // without systematically herding balls anywhere.
    if (driftAmp > 0 && b.frozenT <= 0) {
      const p = b.phase;
      ax += driftAmp * (Math.sin(b.y * sA + t * rA + p) + 0.6 * Math.sin(b.y * sB - t * rB + p * 2.3)) * 0.7;
      ay += driftAmp * (Math.cos(b.x * sA - t * rA + p * 1.3) + 0.6 * Math.cos(b.x * sB + t * rB + p * 0.7)) * 0.7;
    }

    // Mass response: small balls fly, big balls shoulder through. Feel, not realism.
    const massResp = C.field.massFalloff > 0
      ? Math.pow(refMass * b.invMass, C.field.massFalloff)
      : 1;

    // --- finger fields -----------------------------------------------------
    // Push and gather have SEPARATE reaches. The push evacuates a hole around the finger;
    // the attractor has to reach past that hole or it finds nothing to gather.
    if (fields.size > 0) {
      for (const f of fields.values()) {
        const g = f.gather;
        const reach = g > 0 ? Math.max(fRadius, fRadiusG) : fRadius;
        const dx = b.x - f.sx, dy = b.y - f.sy;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach * reach) continue;
        const d = Math.max(minD, Math.sqrt(d2));
        const nx = dx / d, ny = dy / d;
        const amp = f.amp * massResp;
        b.chargeT = Math.max(b.chargeT, C.charge.fieldTime * f.amp);

        if (d < fRadius) {
          const tt = clamp(d / fRadius, 0, 1);
          const q = 1 - tt * tt;
          if (g < 1) {
            const push = strength * Math.pow(q, C.field.falloffExp) * amp * (1 - g);
            ax += nx * push;
            ay += ny * push;
            // A little curl so the field reads as alive rather than as a piston.
            const sw = push * C.field.swirl * C.field.swirlSign;
            ax += -ny * sw;
            ay += nx * sw;
          }
          // Fling: acceleration along the field's own motion. This is what turns a fast
          // swipe into balls travelling *with* the swipe rather than merely away from it.
          const fling = C.field.flingGain * Math.pow(q, C.field.flingFalloffExp) * amp * (1 - 0.45 * g);
          ax += f.vx * fling;
          ay += f.vy * fling;
        }

        if (g > 0 && d < fRadiusG) {
          // Attractor: a spring onto an orbit shell, clamped so it becomes a steady haul
          // at long range; radial damping so nothing rattles in and out; and a tangential
          // drive, which is what makes it actually orbit rather than just collapse.
          const vr = b.vx * nx + b.vy * ny;
          let radial = -C.gather.orbitSpring * (d - orbitR);
          if (radial < -pull) radial = -pull;
          else if (radial > pull * C.gather.pushOutCap) radial = pull * C.gather.pushOutCap;
          radial -= C.gather.orbitDamp * vr;
          const tvx = -ny, tvy = nx;
          const vt = b.vx * tvx + b.vy * tvy;
          const tan = (orbitSpin * f.spin - vt) * C.gather.orbitSpinGain;
          ax += (nx * radial + tvx * tan) * g * amp;
          ay += (ny * radial + tvy * tan) * g * amp;
        }
      }
    }

    // --- magnets -----------------------------------------------------------
    for (let m = 0; m < mags.length; m++) {
      const mb = mags[m];
      if (mb === b) continue;
      const dx = mb.x - b.x, dy = mb.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > magR2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const fall = 1 - d / magR;
      const spike = mb.spikeT > 0 ? magCfg.spikePull : 1;
      const acc = magCfg.pull * s * fall * spike * massResp;
      ax += (dx / d) * acc;
      ay += (dy / d) * acc;
      // The magnet also drags its catch along its own heading, which is what makes
      // "magnet drags gold into something" a thing that actually happens.
      ax += mb.vx * magCfg.dragAssist * fall * fall * 0.5;
      ay += mb.vy * magCfg.dragAssist * fall * fall * 0.5;
      if (b.type === 'GOLD' && goldRes) b.magnetT = goldRes.dragWindow;
    }

    // --- integrate ---------------------------------------------------------
    b.vx += ax * h;
    b.vy += ay * h;

    const dr = b.frozenT > 0 ? C.types.FROST.frozenDrag : dragRate;
    const k = Math.exp(-dr * h);
    b.vx *= k; b.vy *= k;

    const sp2 = b.vx * b.vx + b.vy * b.vy;
    if (sp2 > clampSpeed * clampSpeed) {
      const inv = clampSpeed / Math.sqrt(sp2);
      b.vx *= inv; b.vy *= inv;
    }

    b.x += b.vx * h;
    b.y += b.vy * h;
  }
}

/* ========================================================================== */
/* Collision                                                                  */
/* ========================================================================== */

function collide(sim, h) {
  const C = sim.config;
  const s = sim.scale;
  const balls = sim.balls;
  const rest = lerp(C.collision.restitution, C.collision.restitutionFrenzy, clamp(sim.intensity, 0, 1));
  const slop = C.collision.correctionSlop * s;
  const maxCorr = C.collision.maxCorrection * s;
  const hardSpeed = C.collision.hardImpactSpeed * s;
  const frostRest = C.types.FROST.frozenRestitution;

  buildGrid(sim);
  const near = sim._near;

  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (!a.alive || a.dying) continue;
    near.length = 0;
    queryNeighbors(sim, a.x, a.y, near);
    for (let n = 0; n < near.length; n++) {
      const j = near[n];
      if (j <= i) continue;
      const b = balls[j];
      if (!b.alive || b.dying) continue;

      let dx = b.x - a.x, dy = b.y - a.y;
      const rsum = a.r + b.r;
      let d2 = dx * dx + dy * dy;
      if (d2 >= rsum * rsum) continue;
      if (d2 < 1e-12) {
        // Exactly coincident. Without a made-up normal these two are welded together
        // forever, and a pile of them never unpacks. The angle is derived from the ids so
        // it stays deterministic.
        const ang = (mix32(a.id * 2654435761 + b.id) / 4294967296) * TAU;
        dx = Math.cos(ang) * 1e-4; dy = Math.sin(ang) * 1e-4;
        d2 = 1e-8;
      }
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;

      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const vn = rvx * nx + rvy * ny;

      if (vn < 0) {
        let e = rest;
        if (a.frozenT > 0 || b.frozenT > 0) e = Math.min(e, frostRest);
        const invSum = a.invMass + b.invMass;
        const jimp = -(1 + e) * vn / invSum;
        a.vx -= jimp * nx * a.invMass; a.vy -= jimp * ny * a.invMass;
        b.vx += jimp * nx * b.invMass; b.vy += jimp * ny * b.invMass;

        const speed = -vn;
        if (speed > hardSpeed) {
          const mr = 1 / invSum;                       // reduced mass
          sim._impacts.push({
            a, b, speed, mr,
            x: a.x + nx * a.r, y: a.y + ny * a.r,
            nx, ny, wall: false,
          });
        } else if (speed > hardSpeed * 0.28) {
          pushEvent(sim, { type: 'tap', x: a.x + nx * a.r, y: a.y + ny * a.r, speed: speed / hardSpeed });
        }
      }

      // Positional correction. Slop + percent<1 + a hard cap is what keeps this from
      // feeding energy back into the system (test 3 exists to prove it).
      const pen = rsum - d;
      if (pen > slop) {
        const invSum = a.invMass + b.invMass;
        let corr = (pen - slop) * C.collision.correctionPercent / invSum;
        if (corr > maxCorr / invSum) corr = maxCorr / invSum;
        a.x -= corr * nx * a.invMass; a.y -= corr * ny * a.invMass;
        b.x += corr * nx * b.invMass; b.y += corr * ny * b.invMass;
      }
    }
  }

  walls(sim);
}

function walls(sim) {
  const C = sim.config, s = sim.scale;
  const pad = C.world.boundsPad * s;
  const e = C.world.wallRestitution;
  const fr = C.world.wallFriction;
  const hardW = C.collision.hardImpactWall * s;

  const esc = C.world.escapeMargin * s;

  for (const b of sim.balls) {
    if (!b.alive) continue;
    // A ball this far outside did not "bounce" — something teleported it. Clamping it to
    // the wall would leave it glued there at absurd speed; hand it to the sanitizer, which
    // respawns it properly and counts the event in the debug overlay.
    if (b.x < -esc || b.x > sim.width + esc || b.y < -esc || b.y > sim.height + esc) {
      b.escaped = true;
      continue;
    }
    const lo = pad + b.r;
    const hiX = sim.width - pad - b.r;
    const hiY = sim.height - pad - b.r;
    if (hiX < lo || hiY < lo) { clampIntoBounds(sim, b); continue; }

    let hitSpeed = 0, nx = 0, ny = 0;
    if (b.x < lo) { b.x = lo; if (b.vx < 0) { hitSpeed = -b.vx; nx = 1; b.vx = -b.vx * e; b.vy *= fr; } }
    else if (b.x > hiX) { b.x = hiX; if (b.vx > 0) { hitSpeed = b.vx; nx = -1; b.vx = -b.vx * e; b.vy *= fr; } }
    if (b.y < lo) { b.y = lo; if (b.vy < 0) { const sp = -b.vy; if (sp > hitSpeed) { hitSpeed = sp; nx = 0; ny = 1; } b.vy = -b.vy * e; b.vx *= fr; } }
    else if (b.y > hiY) { b.y = hiY; if (b.vy > 0) { const sp = b.vy; if (sp > hitSpeed) { hitSpeed = sp; nx = 0; ny = -1; } b.vy = -b.vy * e; b.vx *= fr; } }

    if (hitSpeed > hardW && !b.dying) {
      sim._impacts.push({
        a: b, b: null, speed: hitSpeed, mr: b.mass,
        x: b.x, y: b.y, nx, ny, wall: true,
      });
    }
  }
}

/* ========================================================================== */
/* Impact resolution: scoring, combo, type effects, resonances                */
/* ========================================================================== */

function typeMult(sim, ball) {
  const t = sim.config.types[ball.type];
  return t ? t.score : 1;
}

function addScore(sim, amount, x, y, kind) {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0;
  const gained = Math.max(sim.config.score.minHit, Math.round(amount));
  sim.score += gained;
  sim.scoreThisStep += gained;
  sim.xp += gained;
  if (gained >= sim.config.score.popupMinScore) {
    pushEvent(sim, { type: 'score', x, y, amount: gained, kind: kind || 'hit', combo: sim.comboCount });
  }
  return gained;
}

function bumpCombo(sim, steps) {
  const C = sim.config;
  sim.comboCount += steps;
  sim.comboTimer = C.score.comboWindow;
  sim.comboDecayAcc = 0;
  sim.comboMult = comboMultiplier(sim.comboCount, C);
  if (sim.comboCount > sim.sessionBestCombo) sim.sessionBestCombo = sim.comboCount;
  if (sim.comboCount > sim.bestCombo) {
    sim.bestCombo = sim.comboCount;
    const nt = filigreeTier(sim.bestCombo, C);
    if (nt !== sim.filigreeTier) {
      sim.filigreeTier = nt;
      pushEvent(sim, { type: 'filigree', tier: nt, x: sim.width * 0.5, y: sim.height * 0.5 });
    }
  }
}

function processImpacts(sim) {
  const C = sim.config;
  const s = sim.scale;
  const imps = sim._impacts;
  if (imps.length === 0) return;

  const refSpeed = sim.refSpeed;
  const refMass = sim.refMass;

  for (let i = 0; i < imps.length; i++) {
    const im = imps[i];
    const a = im.a, b = im.b;
    if (!a.alive) continue;
    if (b && !b.alive) continue;

    // One contact is one score.
    if (a.scoreT > 0 && (!b || b.scoreT > 0)) continue;

    sim.hardImpactsThisStep++;

    // Normalised impact energy: mass ratio times (speed / reference speed) squared.
    const vRel = im.speed / Math.max(1e-6, refSpeed);
    const mRel = im.mr / Math.max(1e-9, refMass);
    let energy = 0.5 * mRel * vRel * vRel;
    if (!Number.isFinite(energy) || energy < 0) energy = 0;

    let mult = typeMult(sim, a);
    if (b) mult = Math.max(mult, typeMult(sim, b));
    let flat = 0;
    let resonanceMul = 1;

    // Resonance: a magnet dragging gold into a hard impact scores double.
    const gres = sim._res.magnetGold;
    if (gres) {
      if ((a.type === 'GOLD' && a.magnetT > 0) || (b && b.type === 'GOLD' && b.magnetT > 0)) {
        resonanceMul *= gres.scoreMul;
        pushEvent(sim, { type: 'resonance', id: 'magnetGold', x: im.x, y: im.y });
      }
    }

    // Gold: flat bonus and a combo jump.
    let comboSteps = C.score.comboStepPerHit;
    const goldCfg = C.types.GOLD;
    if (a.type === 'GOLD') { flat += goldCfg.scoreFlat; comboSteps = Math.max(comboSteps, goldCfg.comboJump); }
    if (b && b.type === 'GOLD') { flat += goldCfg.scoreFlat; comboSteps = Math.max(comboSteps, goldCfg.comboJump); }

    bumpCombo(sim, comboSteps);

    const wallScale = im.wall ? C.collision.wallScoreScale : 1;
    const raw = (C.score.energyScale * Math.pow(energy, C.score.energyExp) * mult + flat)
      * sim.comboMult * sim.globalMult * resonanceMul * wallScale;
    addScore(sim, raw, im.x, im.y, im.wall ? 'wall' : 'hit');

    pushEvent(sim, {
      type: 'impact', x: im.x, y: im.y, nx: im.nx, ny: im.ny,
      speed: im.speed / Math.max(1e-6, refSpeed), energy,
      wall: im.wall, typeA: a.type, typeB: b ? b.type : null,
    });

    a.scoreT = C.collision.scoreCooldown;
    a.lastHitT = sim.time;
    a.pulse = 1;
    if (b) { b.scoreT = C.collision.scoreCooldown; b.lastHitT = sim.time; b.pulse = 1; }

    // Type effects. Wall hits do not fire them — the walls are not opponents.
    // And they only fire on CHARGED balls: energy the player put in. That is what keeps a
    // detonation cascade from feeding itself forever (see config.charge).
    if (!im.wall) {
      const best = Math.max(a.chargeT, b ? b.chargeT : 0);
      if (best > 0) {
        const passed = best * C.charge.impactTransfer;
        const give = passed >= C.charge.minTransfer ? passed : 0;
        if (a.chargeT < give) a.chargeT = give;
        if (b && b.chargeT < give) b.chargeT = give;
        fireTypeEffect(sim, a, b, im);
        if (b) fireTypeEffect(sim, b, a, im);
      }
    }
  }
  imps.length = 0;
}

function fireTypeEffect(sim, b, other, im) {
  const C = sim.config;
  if (b.effectT > 0) return;
  switch (b.type) {
    case 'VOLATILE': detonate(sim, b, 1); break;
    case 'SPLITTER': splitBall(sim, b); break;
    case 'MAGNET':
      b.spikeT = C.types.MAGNET.spikeTime;
      b.effectT = C.collision.effectCooldown;
      sim.effectsThisStep++;
      pushEvent(sim, { type: 'magnetSpike', x: b.x, y: b.y, id: b.id, r: b.r });
      break;
    case 'PRISM': emitShards(sim, b, im); break;
    case 'CHAIN': chainJolt(sim, b); break;
    case 'FROST': freezeNeighbors(sim, b); break;
    case 'GOLD':
      b.effectT = C.collision.effectCooldown;
      sim.effectsThisStep++;
      pushEvent(sim, { type: 'gold', x: b.x, y: b.y, id: b.id, r: b.r });
      break;
    default: break;
  }
}

/** Pass a decayed slice of `src`'s charge to `dst`. Below the floor the chain is over. */
function passCharge(sim, src, dst) {
  const C = sim.config.charge;
  const v = src.chargeT * C.effectTransfer;
  if (v >= C.minTransfer && dst.chargeT < v) dst.chargeT = v;
}

/* --------------------------------------------------------------- VOLATILE -- */

export function detonate(sim, b, scoreMulIn) {
  const C = sim.config;
  const cfg = C.types.VOLATILE;
  if (!b.alive || b.inertT > 0) return false;
  const s = sim.scale;

  let radius = cfg.blastRadius * s;
  let impulse = cfg.blastImpulse * s;
  let scoreMul = scoreMulIn == null ? 1 : scoreMulIn;

  // Resonance: detonating on a frozen ball becomes a shatter nova.
  const nova = sim._res.shatterNova;
  let isNova = false;
  if (nova) {
    if (b.frozenT > 0) isNova = true;
    else {
      const r2 = radius * radius;
      for (const o of sim.balls) {
        if (!o.alive || o === b || o.frozenT <= 0) continue;
        const dx = o.x - b.x, dy = o.y - b.y;
        if (dx * dx + dy * dy <= r2) { isNova = true; break; }
      }
    }
    if (isNova) {
      radius *= nova.radiusMul;
      impulse *= nova.impulseMul;
      scoreMul *= nova.scoreMul;
    }
  }

  b.inertT = cfg.inertTime;
  b.effectT = C.collision.effectCooldown;
  b.frozenT = 0;
  sim.effectsThisStep++;

  const r2 = radius * radius;
  let caught = 0;
  for (const o of sim.balls) {
    if (!o.alive || o.dying) continue;
    const dx = o.x - b.x, dy = o.y - b.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const d = Math.max(1e-4, Math.sqrt(d2));
    const fall = Math.pow(clamp(1 - d / radius, 0, 1), cfg.blastFalloffExp);
    const kick = impulse * fall * (o === b ? cfg.selfKick : 1);
    const nx = o === b ? 0 : dx / d, ny = o === b ? 0 : dy / d;
    o.vx += nx * kick; o.vy += ny * kick;
    if (o !== b) {
      passCharge(sim, b, o);
      caught++;
      if (isNova && nova.shatterAll && o.frozenT > 0) shatter(sim, o, true);
    }
  }

  const gained = cfg.scoreEach * caught * sim.comboMult * sim.globalMult * scoreMul;
  if (gained > 0) addScore(sim, gained, b.x, b.y, 'blast');

  pushEvent(sim, {
    type: 'detonate', x: b.x, y: b.y, r: radius, id: b.id,
    caught, nova: isNova,
  });
  pushEvent(sim, { type: 'shockwave', x: b.x, y: b.y, r: radius, strength: isNova ? 1.5 : 1 });
  if (isNova) pushEvent(sim, { type: 'resonance', id: 'shatterNova', x: b.x, y: b.y });
  return true;
}

/* --------------------------------------------------------------- SPLITTER -- */

export function splitBall(sim, b) {
  const C = sim.config;
  const cfg = C.types.SPLITTER;
  if (!b.alive || b.dying || b.splitT > 0) return false;

  const childR = b.r * cfg.childRadius;
  if (childR < C.balls.minSplitRadius * sim.scale) {
    b.effectT = C.collision.effectCooldown;
    return false;
  }
  // Splitting is +1 net ball. Never let the population reach the hard cap.
  if (sim.aliveCount + 1 > C.population.hardCap - cfg.reserve) {
    b.effectT = C.collision.effectCooldown;
    return false;
  }

  const s = sim.scale;
  const spd = Math.hypot(b.vx, b.vy);
  // Children separate perpendicular to the parent's heading, splayed by splitSpread,
  // so a split reads as the ball cracking open along its direction of travel.
  const baseAngle = spd > 1e-4 ? Math.atan2(b.vy, b.vx) : sim.rng.angle();
  const sep = cfg.splitSpeed * s;
  const half = cfg.splitSpread * 0.5;

  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? -1 : 1;
    const out = baseAngle + side * (Math.PI * 0.5 - half);
    const c = makeBall(
      sim,
      b.x + Math.cos(out) * (childR + 0.5),
      b.y + Math.sin(out) * (childR + 0.5),
      childR, 'SPLITTER', Math.max(0.35, b.fade),
    );
    c.vx = b.vx * cfg.inheritSpeed + Math.cos(out) * sep;
    c.vy = b.vy * cfg.inheritSpeed + Math.sin(out) * sep;
    c.splitT = cfg.cooldown;
    c.chargeT = b.chargeT * C.charge.effectTransfer;
    c.effectT = C.collision.effectCooldown;
    clampIntoBounds(sim, c);
    sim.balls.push(c);
    sim.aliveCount++;
  }

  b.alive = false;
  sim.aliveCount--;
  sim.needsCompact = true;
  sim.effectsThisStep++;
  pushEvent(sim, { type: 'split', x: b.x, y: b.y, r: b.r, id: b.id });
  return true;
}

/** Test hook: force every splitter-capable ball to split this instant. */
export function forceSplitAll(sim) {
  const snapshot = sim.balls.slice();
  let n = 0;
  for (const b of snapshot) {
    if (!b.alive || b.dying) continue;
    b.splitT = 0;
    b.type = 'SPLITTER';
    if (splitBall(sim, b)) n++;
  }
  return n;
}

/** Test hook: detonate every volatile-capable ball this instant. */
export function detonateAll(sim) {
  const snapshot = sim.balls.slice();
  let n = 0;
  for (const b of snapshot) {
    if (!b.alive || b.dying) continue;
    b.type = 'VOLATILE';
    b.inertT = 0;
    b.effectT = 0;
    if (detonate(sim, b, 1)) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ PRISM -- */

function emitShards(sim, b, im) {
  const C = sim.config;
  const cfg = C.types.PRISM;
  const s = sim.scale;
  b.effectT = C.collision.effectCooldown;
  sim.effectsThisStep++;

  const base = im && Number.isFinite(im.nx) ? Math.atan2(-im.ny, -im.nx) : sim.rng.angle();
  let made = 0;
  for (let i = 0; i < cfg.shards; i++) {
    if (sim.shards.length >= cfg.maxShards) break;
    const frac = cfg.shards > 1 ? (i / (cfg.shards - 1) - 0.5) : 0;
    const ang = base + frac * cfg.shardSpread + sim.rng.range(-0.12, 0.12);
    const sp = cfg.shardSpeed * s * (1 + sim.rng.range(-cfg.shardSpeedJitter, cfg.shardSpeedJitter));
    sim.shards.push({
      x: b.x, y: b.y,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      life: cfg.shardLife,
      bounces: cfg.shardBounces,
      charge: b.chargeT * C.charge.effectTransfer,
      seed: mix32(b.id * 2246822519 + i),
    });
    made++;
  }
  pushEvent(sim, { type: 'prism', x: b.x, y: b.y, id: b.id, count: made, r: b.r });
}

function updateShards(sim, dt) {
  const C = sim.config;
  const cfg = C.types.PRISM;
  const s = sim.scale;
  const shards = sim.shards;
  if (shards.length === 0) return;

  const k = Math.exp(-cfg.shardDrag * dt);
  const sr = cfg.shardRadius * s;
  let write = 0;

  buildGrid(sim);
  const near = sim._near;

  for (let i = 0; i < shards.length; i++) {
    const sh = shards[i];
    sh.life -= dt;
    if (sh.life <= 0) continue;
    sh.vx *= k; sh.vy *= k;
    sh.x += sh.vx * dt;
    sh.y += sh.vy * dt;
    if (!Number.isFinite(sh.x) || !Number.isFinite(sh.y)) continue;

    // Walls: one bounce, then gone. Shards push nothing, ever.
    let bounced = false;
    if (sh.x < 0) { sh.x = 0; sh.vx = -sh.vx; bounced = true; }
    else if (sh.x > sim.width) { sh.x = sim.width; sh.vx = -sh.vx; bounced = true; }
    if (sh.y < 0) { sh.y = 0; sh.vy = -sh.vy; bounced = true; }
    else if (sh.y > sim.height) { sh.y = sim.height; sh.vy = -sh.vy; bounced = true; }
    if (bounced) {
      sh.bounces--;
      if (sh.bounces < 0) continue;
      pushEvent(sim, { type: 'shardBounce', x: sh.x, y: sh.y });
    }

    // Contact with a ball scores and consumes the shard.
    near.length = 0;
    queryNeighbors(sim, sh.x, sh.y, near);
    let hit = null;
    for (let n = 0; n < near.length; n++) {
      const b = sim.balls[near[n]];
      if (!b || !b.alive || b.dying) continue;
      const dx = b.x - sh.x, dy = b.y - sh.y;
      const rr = b.r + sr;
      if (dx * dx + dy * dy <= rr * rr) { hit = b; break; }
    }
    if (hit) {
      if (sh.charge >= C.charge.minTransfer && hit.chargeT < sh.charge) hit.chargeT = sh.charge;
      const gained = cfg.shardScore * sim.comboMult * sim.globalMult;
      addScore(sim, gained, sh.x, sh.y, 'shard');
      pushEvent(sim, { type: 'shardHit', x: sh.x, y: sh.y });
      continue;
    }

    shards[write++] = sh;
  }
  shards.length = write;
}

/* ------------------------------------------------------------------ CHAIN -- */

function chainJolt(sim, source) {
  const C = sim.config;
  const cfg = C.types.CHAIN;
  const s = sim.scale;
  source.effectT = C.collision.effectCooldown;
  sim.effectsThisStep++;

  const range2 = (cfg.range * s) * (cfg.range * s);
  const hit = new Set([source.id]);
  let frontier = [source];
  let gained = 0;

  for (let depth = 0; depth < cfg.depth; depth++) {
    const next = [];
    for (const from of frontier) {
      // Nearest N unhit balls within range. Deterministic: sorted by (distance, id).
      const cand = [];
      for (const o of sim.balls) {
        if (!o.alive || o.dying || hit.has(o.id)) continue;
        const dx = o.x - from.x, dy = o.y - from.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= range2) cand.push([d2, o.id, o]);
      }
      cand.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
      const take = Math.min(cfg.targets, cand.length);
      for (let i = 0; i < take; i++) {
        const o = cand[i][2];
        hit.add(o.id);
        const dx = o.x - from.x, dy = o.y - from.y;
        const d = Math.max(1e-4, Math.hypot(dx, dy));
        const kick = cfg.impulse * s;
        o.vx += (dx / d) * kick;
        o.vy += (dy / d) * kick;
        o.pulse = 1;
        passCharge(sim, from, o);
        gained += cfg.scoreEach;
        pushEvent(sim, { type: 'chain', x1: from.x, y1: from.y, x2: o.x, y2: o.y, depth });

        // Resonance: a chain jolt landing on a volatile is a guaranteed detonation.
        const cres = sim._res.chainDetonate;
        if (cres && o.type === 'VOLATILE' && o.inertT <= 0) {
          if (cres.ignoreCooldown) o.effectT = 0;
          if (o.effectT <= 0) {
            detonate(sim, o, cres.scoreMul);
            pushEvent(sim, { type: 'resonance', id: 'chainDetonate', x: o.x, y: o.y });
          }
        }
        next.push(o);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  if (gained > 0) addScore(sim, gained * sim.comboMult * sim.globalMult, source.x, source.y, 'chain');
}

/* ------------------------------------------------------------------ FROST -- */

function freezeNeighbors(sim, source) {
  const C = sim.config;
  const cfg = C.types.FROST;
  const s = sim.scale;
  source.effectT = C.collision.effectCooldown;
  sim.effectsThisStep++;

  const r = cfg.radius * s;
  const r2 = r * r;
  const cand = [];
  for (const o of sim.balls) {
    if (!o.alive || o.dying || o === source) continue;
    if (o.frozenT > 0 || o.immuneT > 0) continue;
    const dx = o.x - source.x, dy = o.y - source.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2) cand.push([d2, o.id, o]);
  }
  cand.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  const take = Math.min(cfg.maxTargets, cand.length);
  let gained = 0;
  for (let i = 0; i < take; i++) {
    const o = cand[i][2];
    o.frozenT = cfg.freezeTime;
    o.frozenFromX = source.x;
    o.frozenFromY = source.y;
    passCharge(sim, source, o);
    gained += cfg.scoreEach;
    pushEvent(sim, { type: 'freeze', x: o.x, y: o.y, r: o.r, id: o.id });
  }
  pushEvent(sim, { type: 'frostBurst', x: source.x, y: source.y, r, count: take });
  if (gained > 0) addScore(sim, gained * sim.comboMult * sim.globalMult, source.x, source.y, 'frost');
}

/** Break a ball out of its freeze, with the little outward pop that sells it. */
function shatter(sim, b, forced) {
  const C = sim.config;
  const cfg = C.types.FROST;
  b.frozenT = 0;
  b.immuneT = cfg.immuneTime;
  const dx = b.x - b.frozenFromX, dy = b.y - b.frozenFromY;
  const d = Math.hypot(dx, dy);
  const s = sim.scale;
  const imp = cfg.shatterImpulse * s * (forced ? 1.6 : 1);
  if (d > 1e-4) { b.vx += (dx / d) * imp; b.vy += (dy / d) * imp; }
  else {
    const a = sim.rng.angle();
    b.vx += Math.cos(a) * imp; b.vy += Math.sin(a) * imp;
  }
  pushEvent(sim, { type: 'shatter', x: b.x, y: b.y, r: b.r, id: b.id, forced: !!forced });
}

/* ========================================================================== */
/* Timers, sanitizer, population                                              */
/* ========================================================================== */

function updateTimers(sim, dt) {
  const C = sim.config;
  for (const b of sim.balls) {
    if (!b.alive) continue;
    if (b.effectT > 0) b.effectT = Math.max(0, b.effectT - dt);
    if (b.scoreT > 0) b.scoreT = Math.max(0, b.scoreT - dt);
    if (b.inertT > 0) b.inertT = Math.max(0, b.inertT - dt);
    if (b.splitT > 0) b.splitT = Math.max(0, b.splitT - dt);
    if (b.spikeT > 0) b.spikeT = Math.max(0, b.spikeT - dt);
    if (b.immuneT > 0) b.immuneT = Math.max(0, b.immuneT - dt);
    if (b.magnetT > 0) b.magnetT = Math.max(0, b.magnetT - dt);
    if (b.chargeT > 0) b.chargeT = Math.max(0, b.chargeT - dt);
    if (b.pulse > 0) b.pulse = Math.max(0, b.pulse - dt * 4);
    if (b.frozenT > 0) {
      b.frozenT -= dt;
      if (b.frozenT <= 0) shatter(sim, b, false);
    }
    if (b.dying) {
      b.fade -= dt / Math.max(1e-6, C.population.despawnFade);
      if (b.fade <= 0) {
        b.alive = false;
        sim.aliveCount--;
        sim.needsCompact = true;
      }
    } else if (b.fade < 1) {
      b.fade = Math.min(1, b.fade + dt / Math.max(1e-6, C.population.spawnFade));
    }
  }
}

/**
 * The sanitizer. Runs every single step. NaN, Infinity, or an escaped ball is
 * repaired in place — respawned at an edge if it has genuinely left the world.
 * This is the reason the sim cannot be killed.
 */
function sanitize(sim) {
  const C = sim.config;
  const s = sim.scale;
  const esc = C.world.escapeMargin * s;
  const clampSpeed = C.world.speedClamp * s;
  let hits = 0;

  for (const b of sim.balls) {
    if (!b.alive) continue;
    let bad = false;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) ||
        !Number.isFinite(b.vx) || !Number.isFinite(b.vy) ||
        !Number.isFinite(b.r) || b.r <= 0 ||
        !Number.isFinite(b.mass) || b.mass <= 0) bad = true;

    if (!bad && (b.escaped || b.x < -esc || b.x > sim.width + esc || b.y < -esc || b.y > sim.height + esc)) bad = true;

    if (bad) {
      b.escaped = false;
      hits++;
      const rng = sim.rng;
      if (!Number.isFinite(b.r) || b.r <= 0) b.r = C.balls.radiusMin * s;
      b.mass = C.balls.density * Math.pow(b.r, C.balls.densityExp);
      b.invMass = 1 / b.mass;
      const edge = rng.int(4);
      const inset = C.population.spawnEdgeInset * s + b.r;
      const sp = C.population.spawnSpeed * s;
      if (edge === 0) { b.x = rng.range(inset, Math.max(inset + 1, sim.width - inset)); b.y = inset; b.vx = 0; b.vy = sp; }
      else if (edge === 1) { b.x = sim.width - inset; b.y = rng.range(inset, Math.max(inset + 1, sim.height - inset)); b.vx = -sp; b.vy = 0; }
      else if (edge === 2) { b.x = rng.range(inset, Math.max(inset + 1, sim.width - inset)); b.y = sim.height - inset; b.vx = 0; b.vy = -sp; }
      else { b.x = inset; b.y = rng.range(inset, Math.max(inset + 1, sim.height - inset)); b.vx = sp; b.vy = 0; }
      b.frozenT = 0;
      b.fade = Math.max(0.2, Math.min(1, fin(b.fade, 1)));
      b.dying = false;
      continue;
    }

    // Belt and braces: the clamp is enforced here too, not only in the integrator.
    const sp2 = b.vx * b.vx + b.vy * b.vy;
    if (sp2 > clampSpeed * clampSpeed) {
      const inv = clampSpeed / Math.sqrt(sp2);
      b.vx *= inv; b.vy *= inv;
    }
    clampIntoBounds(sim, b);
    if (!Number.isFinite(b.fade)) b.fade = 1;
    b.fade = clamp(b.fade, 0, 1);
  }

  // Shards get the same treatment, quietly.
  let w = 0;
  for (let i = 0; i < sim.shards.length; i++) {
    const sh = sim.shards[i];
    if (!Number.isFinite(sh.x) || !Number.isFinite(sh.y) ||
        !Number.isFinite(sh.vx) || !Number.isFinite(sh.vy) || !Number.isFinite(sh.life)) {
      hits++;
      continue;
    }
    sim.shards[w++] = sh;
  }
  sim.shards.length = w;

  if (hits > 0) sim.sanitizerHits += hits;
  sim.sanitizerHitsThisStep = hits;
}

function compact(sim) {
  if (!sim.needsCompact) return;
  let w = 0;
  for (let i = 0; i < sim.balls.length; i++) {
    const b = sim.balls[i];
    if (b.alive) sim.balls[w++] = b;
  }
  sim.balls.length = w;
  sim.aliveCount = w;
  sim.needsCompact = false;
}

function population(sim, dt) {
  const C = sim.config.population;
  const s = sim.scale;

  if (sim.aliveCount < sim.softCap) {
    sim.respawnTimer -= dt;
    if (sim.respawnTimer <= 0) {
      const b = spawnBall(sim, { fade: 0 });
      sim.respawnTimer = C.respawnDelay;
      if (b) pushEvent(sim, { type: 'spawn', x: b.x, y: b.y, r: b.r, id: b.id });
    }
  } else if (sim.aliveCount > sim.softCap) {
    const over = sim.aliveCount - sim.softCap;
    const urgency = clamp(over / Math.max(1, C.overCapUrgency), 0, 1);
    sim.despawnTimer -= dt;
    if (sim.despawnTimer <= 0) {
      const margin = C.despawnMargin * s;
      const maxSp = C.despawnMaxSpeed * s;
      let best = null, bestScore = Infinity;
      for (const b of sim.balls) {
        if (!b.alive || b.dying || b.fade < 1) continue;
        if (b.type === 'GOLD' && sim.config.types.GOLD.neverDespawn) continue;
        if (b.frozenT > 0) continue;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > maxSp) continue;
        const edgeDist = Math.min(b.x, b.y, sim.width - b.x, sim.height - b.y);
        if (edgeDist > margin) continue;
        // Prefer the slowest ball closest to an edge; ties by id, for determinism.
        const sc = edgeDist + sp * 0.5 + b.id * 1e-9;
        if (sc < bestScore) { bestScore = sc; best = b; }
      }
      if (best) {
        best.dying = true;
        sim.despawnTimer = lerp(C.despawnInterval, 0.02, urgency);
        pushEvent(sim, { type: 'despawn', x: best.x, y: best.y, r: best.r, id: best.id });
      } else {
        sim.despawnTimer = 0.25;
      }
    }
  } else {
    sim.respawnTimer = Math.min(sim.respawnTimer, C.respawnDelay);
  }
}

/* ========================================================================== */
/* Progression                                                                */
/* ========================================================================== */

function progression(sim, dt) {
  const C = sim.config;

  // Combo decay: quiet for comboWindow, then it sheds a step at a time.
  if (sim.comboCount > 0) {
    if (sim.comboTimer > 0) {
      sim.comboTimer -= dt;
    } else {
      sim.comboDecayAcc += dt;
      // Proportional decay: a huge combo unwinds in roughly the same wall time as a small
      // one. One-step-per-tick would leave a 7000 combo grinding down for an hour.
      while (sim.comboDecayAcc >= C.score.comboDecayStep && sim.comboCount > 0) {
        sim.comboDecayAcc -= C.score.comboDecayStep;
        const shed = Math.max(1, Math.ceil(sim.comboCount * C.score.comboDecayFrac));
        sim.comboCount = Math.max(0, sim.comboCount - shed);
      }
      sim.comboMult = comboMultiplier(sim.comboCount, C);
    }
  } else {
    sim.comboCount = 0;
    sim.comboMult = 1;
    sim.comboDecayAcc = 0;
  }

  // Levels. Thresholds are strictly increasing, so this terminates.
  let guard = 0;
  while (sim.xp >= sim.xpNeeded && guard++ < 64) {
    sim.xp -= sim.xpNeeded;
    sim.level++;
    const beforePalettes = sim.palettesUnlocked;
    refreshDerived(sim);

    // Type unlocks: each early level opens a new ball type, with a celebration.
    for (const key of C.unlockOrder) {
      const t = C.types[key];
      if (t.unlockLevel === sim.level && sim.unlocked.indexOf(key) < 0) {
        sim.unlocked.push(key);
        pushEvent(sim, { type: 'unlock', key, label: t.label, level: sim.level });
      }
    }
    if (sim.palettesUnlocked > beforePalettes) {
      pushEvent(sim, {
        type: 'palette', index: sim.palettesUnlocked - 1,
        name: C.palettes[sim.palettesUnlocked - 1].name, level: sim.level,
      });
    }
    pushEvent(sim, { type: 'levelup', level: sim.level, cap: sim.softCap, mult: sim.globalMult });
  }

  // Milestones: round numbers, celebrated hard, etched permanently into the sky.
  const ladder = sim._ladder;
  for (let i = 0; i < ladder.length; i++) {
    const v = ladder[i];
    if (sim.score < v) break;
    const id = 's' + v;
    if (!sim._milestoneSet.has(id)) {
      sim._milestoneSet.add(id);
      sim.milestones.push(id);
      pushEvent(sim, { type: 'milestone', id, value: v, kind: 'score' });
    }
  }

  sim.playTime += dt;
}

function updateIntensity(sim, dt) {
  const C = sim.config.intensity;
  let target = 0;
  target += sim.pointers.size > 0 ? C.touchWeight : 0;
  // Only a LIVE combo counts. A big number sitting there decaying is not excitement, and
  // treating it as such pinned the screen in FRENZY minutes after everything had stopped.
  if (sim.comboTimer > 0) {
    const freshness = clamp(sim.comboTimer / Math.max(1e-6, sim.config.score.comboWindow), 0, 1);
    target += Math.min(C.comboMaxContrib, sim.comboCount * C.comboWeight) * freshness;
  }
  target += sim.hardImpactsThisStep * C.impactWeight;
  target += sim.effectsThisStep * C.effectWeight;
  target = clamp(target, 0, 1);

  const tau = target > sim.intensity ? C.riseTau : C.fallTau;
  sim.intensity += (target - sim.intensity) * smoothK(tau, dt);
  sim.intensity = clamp(fin(sim.intensity, 0), 0, 1);

  if (sim.pointers.size > 0) sim.untouchedTime = 0;
  else sim.untouchedTime += dt;

  sim.mode = sim.intensity < C.calmBelow ? 'CALM'
    : (sim.intensity > C.frenzyAbove ? 'FRENZY' : 'ACTIVE');
}

/* ========================================================================== */
/* Comet                                                                      */
/* ========================================================================== */

function updateComet(sim, dt) {
  const C = sim.config.comet;
  if (!C.enabled) return;
  const s = sim.scale;

  if (sim.comet) {
    const c = sim.comet;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.t += dt;
    c.tail.push(c.x, c.y);
    if (c.tail.length > C.tailLength * 2) c.tail.splice(0, c.tail.length - C.tailLength * 2);

    const cr = C.radius * s;
    const chip = C.chipSpeed * s;
    for (const b of sim.balls) {
      if (!b.alive || b.dying) continue;
      const dx = b.x - c.x, dy = b.y - c.y;
      const rr = b.r + cr;
      if (dx * dx + dy * dy > rr * rr) continue;
      const sp = Math.hypot(b.vx, b.vy);
      const d = Math.max(1e-4, Math.hypot(dx, dy));
      // Always bounce off it; only a fast ball actually chips it.
      b.vx += (dx / d) * chip * 0.55;
      b.vy += (dy / d) * chip * 0.55;
      if (sp > chip && c.hitT <= 0) {
        c.hp--;
        c.hitT = 0.12;
        addScore(sim, C.scorePerChip * sim.comboMult * sim.globalMult, c.x, c.y, 'comet');
        pushEvent(sim, { type: 'cometChip', x: c.x, y: c.y, hp: c.hp });
        if (c.hp <= 0) {
          addScore(sim, C.scoreBreak * sim.comboMult * sim.globalMult, c.x, c.y, 'cometBreak');
          sim.cometsBroken++;
          const id = 'c' + sim.cometsBroken;
          if (sim.config.milestones.cometMilestone && !sim._milestoneSet.has(id)) {
            sim._milestoneSet.add(id);
            sim.milestones.push(id);
            pushEvent(sim, { type: 'milestone', id, value: sim.cometsBroken, kind: 'comet' });
          }
          pushEvent(sim, { type: 'cometBreak', x: c.x, y: c.y });
          sim.comet = null;
          sim.cometTimer = C.minGap;
          return;
        }
      }
    }
    if (c.hitT > 0) c.hitT -= dt;

    const pad = C.radius * s * 4;
    if (c.t > C.lifetime || c.x < -pad || c.x > sim.width + pad || c.y < -pad || c.y > sim.height + pad) {
      sim.comet = null;
      sim.cometTimer = C.minGap;
    }
    return;
  }

  sim.cometTimer -= dt;
  if (sim.cometTimer > 0) return;
  if (sim.intensity < C.requireIntensity) return;
  if (sim.rng.float() >= C.chancePerSec * dt) return;

  const rng = sim.rng;
  const fromLeft = rng.float() < 0.5;
  const y0 = rng.range(sim.height * 0.12, sim.height * 0.6);
  const y1 = rng.range(sim.height * 0.12, sim.height * 0.75);
  const x0 = fromLeft ? -C.radius * s * 2 : sim.width + C.radius * s * 2;
  const dx = (fromLeft ? 1 : -1);
  const ang = Math.atan2(y1 - y0, sim.width * dx);
  const sp = C.speed * s;
  sim.comet = {
    x: x0, y: y0,
    vx: Math.cos(ang) * sp * (fromLeft ? 1 : -1) * (dx > 0 ? 1 : 1),
    vy: Math.sin(ang) * sp,
    hp: C.hp, t: 0, hitT: 0, tail: [],
  };
  if (!fromLeft) { sim.comet.vx = -Math.abs(sim.comet.vx); }
  else { sim.comet.vx = Math.abs(sim.comet.vx); }
  sim.cometTimer = C.minGap;
  pushEvent(sim, { type: 'cometSpawn', x: sim.comet.x, y: sim.comet.y });
}

/* ========================================================================== */
/* step()                                                                     */
/* ========================================================================== */

/**
 * Advance the world by `dt` seconds.
 *
 * input = {
 *   pointers:  [{ id, x, y }]   every live finger/mouse; absence means released
 *   cancelled: [id]             fields to drop WITHOUT slinging (pointercancel/blur)
 *   scatter:   boolean          two-finger triple-tap re-scatter
 * }
 */
export function step(sim, dtRaw, input) {
  const C = sim.config;

  let dt = dtRaw;
  if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
  if (dt > C.world.maxDt) dt = C.world.maxDt;

  sim.events.length = 0;
  sim.eventsDropped = 0;
  sim.scoreThisStep = 0;
  sim.hardImpactsThisStep = 0;
  sim.effectsThisStep = 0;
  sim._impacts.length = 0;

  if (input && input.scatter) scatter(sim);

  updatePointers(sim, dt, input);

  const sub = Math.max(1, C.world.substeps | 0);
  const h = dt / sub;
  for (let i = 0; i < sub; i++) {
    applyForces(sim, h);
    collide(sim, h);
    processImpacts(sim);
  }

  updateShards(sim, dt);
  updateTimers(sim, dt);
  updateComet(sim, dt);
  sanitize(sim);
  compact(sim);
  population(sim, dt);
  progression(sim, dt);
  updateIntensity(sim, dt);

  sim.time += dt;
  sim.frame++;
  sim.stepCount++;
  return sim;
}

/* ========================================================================== */
/* State hashing (determinism harness)                                        */
/* ========================================================================== */

/** Round to 1e-6 before hashing, so float noise never masquerades as divergence. */
function q(v) {
  if (!Number.isFinite(v)) return 'X';
  return (Math.round(v * 1e6) / 1e6).toFixed(6);
}

/**
 * A compact, order-sensitive hash of everything that matters. Two runs with the same
 * seed and the same scripted inputs must produce the same string.
 */
export function hashState(sim) {
  const parts = [];
  parts.push('n', String(sim.balls.length), 'a', String(sim.aliveCount));
  for (const b of sim.balls) {
    parts.push(
      String(b.id), b.type, b.alive ? '1' : '0',
      q(b.x), q(b.y), q(b.vx), q(b.vy), q(b.r),
      q(b.fade), q(b.frozenT), q(b.inertT), q(b.effectT), q(b.chargeT),
    );
  }
  parts.push('sh', String(sim.shards.length));
  for (const s of sim.shards) parts.push(q(s.x), q(s.y), q(s.vx), q(s.vy), q(s.life), String(s.bounces));
  parts.push(
    'sc', String(sim.score), 'xp', String(sim.xp), 'lv', String(sim.level),
    'cc', String(sim.comboCount), 'cm', q(sim.comboMult), 'ct', q(sim.comboTimer),
    'in', q(sim.intensity), 'ms', sim.milestones.join(','), 'un', sim.unlocked.join(','),
    'rng', String(sim.rng.getState()), 't', q(sim.time),
    'cap', String(sim.softCap), 'san', String(sim.sanitizerHits),
    'cb', String(sim.cometsBroken), 'co', sim.comet ? (q(sim.comet.x) + ',' + q(sim.comet.y) + ',' + sim.comet.hp) : '-',
  );
  const s = parts.join('|');
  // 64-bit-ish: two independent 32-bit hashes over the same string.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b); h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + ':' + s.length;
}

/** Total kinetic energy. Used by the energy-sanity test. */
export function totalKineticEnergy(sim) {
  let e = 0;
  for (const b of sim.balls) {
    if (!b.alive) continue;
    e += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
  }
  return e;
}

export default {
  createSim, step, resize, scatter, makeRng, hashState,
  loadSave, serializeSave, defaultSave, deriveStars,
  levelThreshold, comboMultiplier, milestoneLadder, filigreeTier,
  palettesUnlockedAt, detonate, splitBall, forceSplitAll, detonateAll,
  totalKineticEnergy, SAVE_VERSION,
};
