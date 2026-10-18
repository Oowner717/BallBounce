/*
 * simcore.js — small helpers every part of the simulation shares: events,
 * speech bubbles, dropped items, and "how high is the ground here".
 *
 * Nothing here reads the clock or Math.random(); randomness always comes from
 * the sim's own seeded rng so a run can be replayed exactly.
 */

import { SURF, SURF_HEIGHT, collidersNear, surfAt } from './world.js';
import { pick, dist2 } from './util.js';

/** Queue an event for this frame: tasks count them, the front end plays sounds and toasts. */
export function emit(S, type, data) {
  const e = data ? Object.assign({ type, t: S.t }, data) : { type, t: S.t };
  S.events.push(e);
  if (S.events.length > 4000) {
    // nobody is draining (headless runs); keep the tail the task system has not read yet
    const cut = Math.min(2000, S.taskCursor);
    S.events.splice(0, cut);
    S.taskCursor -= cut;
  }
  return e;
}

/** Hand the front end everything since the last drain. Call after step(). */
export function drainEvents(S) {
  const out = S.events.splice(0);
  S.taskCursor = 0;
  return out;
}

/**
 * Someone says something: a speech bubble over their head. `who` is any entity
 * with x, z (and optionally y and a height h). `lines` is a list of [said, meaning].
 */
export function say(S, who, lines, opts) {
  if (!who || !lines || !lines.length) return null;
  const line = Array.isArray(lines[0]) ? pick(S.rng, lines) : lines;
  const existing = S.bubbles.find((b) => b.who === who);
  const t = (opts && opts.time) || S.C.crowd.bubbleTime;
  if (existing) {
    existing.text = line[0]; existing.sub = line[1] || ''; existing.t = t; existing.max = t;
    return existing;
  }
  if (S.bubbles.length >= 8) {
    // drop the oldest that is not about the dog's own business
    S.bubbles.sort((a, b) => a.t - b.t);
    S.bubbles.shift();
  }
  const b = { who, text: line[0], sub: line[1] || '', t, max: t, h: (opts && opts.h) || who.h || 1.9 };
  S.bubbles.push(b);
  emit(S, 'say', { text: line[0] });
  return b;
}

export function updateBubbles(S, dt) {
  for (let i = S.bubbles.length - 1; i >= 0; i--) {
    const b = S.bubbles[i];
    b.t -= dt;
    if (b.t <= 0 || b.who.gone) S.bubbles.splice(i, 1);
  }
}

/** Ground height at (x, z) for something whose feet are at y: kerbs, platforms, steps. */
export function groundAt(S, x, z, y, stepUp = 0.32) {
  const s = surfAt(S.W, x, z);
  let g = s === SURF.ISLAND ? 0 : SURF_HEIGHT[s];
  const near = collidersNear(S.W, x, z, 0.05, S.scratchG || (S.scratchG = []));
  for (const idx of near) {
    const c = S.W.colliders[idx];
    if (!c.platform || c.y1 > y + stepUp + 1e-3 || c.y1 <= g) continue;
    if (c.kind === 'box') {
      if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) g = c.y1;
    } else if (dist2(x, z, c.x, c.z) <= c.r * c.r) g = c.y1;
  }
  return g;
}

/* ------------------------------------------------------------------- items */

/**
 * Things on the ground or in a mouth: food, the cricket ball, a lost chappal.
 * state: 'ground' | 'air' | 'carried' | 'held' (by a person) | 'gone'
 */
export function spawnItem(S, kind, x, y, z, vx = 0, vy = 0, vz = 0, extra) {
  const it = Object.assign({
    id: S.nextId++, kind, x, y, z, vx, vy, vz,
    state: vy !== 0 || y > groundAt(S, x, z, y) + 0.05 ? 'air' : 'ground',
    bornH: S.clock.absH, owner: null, yaw: S.rng() * Math.PI * 2,
  }, extra || {});
  S.items.push(it);
  return it;
}

/**
 * A gift tossed to the dog: lob `kind` from a hand at (x, y, z) so it lands just
 * in front of the dog's nose, wherever the dog is sitting. Longer tosses take
 * longer and arc higher, so a ladoo thrown down the temple steps clears them.
 */
export function tossToDog(S, kind, x, y, z, extra) {
  const d = S.dog;
  const tx = d.x + Math.sin(d.yaw) * 0.45, tz = d.z + Math.cos(d.yaw) * 0.45;
  const T = 0.35 + Math.hypot(tx - x, tz - z) * 0.07;
  const vy = (groundAt(S, tx, tz, d.y + 0.3) - y) / T + 0.5 * 19.6 * T;
  return spawnItem(S, kind, x, y, z, (tx - x) / T, vy, (tz - z) / T, extra);
}

export function removeItem(S, it) {
  it.state = 'gone';
  it.gone = true;
  const i = S.items.indexOf(it);
  if (i >= 0) S.items.splice(i, 1);
  if (S.dog.carry === it) S.dog.carry = null;
}

export const FOOD_KINDS = new Set(['biscuit', 'roti', 'samosa', 'jalebi', 'ladoo', 'bone', 'scraps', 'milk']);
export const isFood = (it) => FOOD_KINDS.has(it.kind);

export function updateItems(S, dt) {
  const life = S.C.food.itemLife;
  const d = S.dog;
  for (let i = S.items.length - 1; i >= 0; i--) {
    const it = S.items[i];
    if (it.state === 'carried') {
      // held in the dog's mouth, a little ahead of the chest
      it.x = d.x + Math.sin(d.yaw) * 0.62;
      it.z = d.z + Math.cos(d.yaw) * 0.62;
      it.y = d.y + 0.6;
      continue;
    }
    if (it.state === 'held') continue;
    if (it.state === 'air') {
      it.x += it.vx * dt; it.y += it.vy * dt - 9.8 * dt * dt; it.z += it.vz * dt; // exact arcs: tosses land where aimed
      it.vy -= 19.6 * dt;
      const g = groundAt(S, it.x, it.z, it.y + 0.2);
      if (it.y <= g) {
        it.y = g;
        if (Math.abs(it.vy) > 1.2 && it.kind === 'ball') {
          it.vy = -it.vy * 0.45;
          it.vx *= 0.7; it.vz *= 0.7;
        } else {
          it.vy = 0;
          it.landT = S.t;
          it.state = it.kind === 'ball' && Math.hypot(it.vx, it.vz) > 0.3 ? 'roll' : 'ground';
          if (it.state === 'ground') { it.vx = 0; it.vz = 0; }
        }
      }
      if (Math.abs(it.x) > 99 || Math.abs(it.z) > 99) removeItem(S, it);
      continue;
    }
    if (it.state === 'roll') {
      const sp = Math.hypot(it.vx, it.vz);
      const ns = Math.max(0, sp - 2.2 * dt);
      if (ns <= 0.05) { it.state = 'ground'; it.vx = it.vz = 0; it.landT = S.t; continue; }
      it.vx *= ns / sp; it.vz *= ns / sp;
      const nx = it.x + it.vx * dt, nz = it.z + it.vz * dt;
      if (blockedAt(S, nx, it.z, it.y)) it.vx = -it.vx * 0.5; else it.x = nx;
      if (blockedAt(S, it.x, nz, it.y)) it.vz = -it.vz * 0.5; else it.z = nz;
      it.y = groundAt(S, it.x, it.z, it.y + 0.1);
      continue;
    }
    if (it.kind !== 'ball' && it.kind !== 'chappal' && S.clock.absH - it.bornH > life) removeItem(S, it);
  }
}

/** Is there a wall (anything solid taller than a kerb) at this point? */
export function blockedAt(S, x, z, y) {
  const near = collidersNear(S.W, x, z, 0.05, S.scratchB || (S.scratchB = []));
  for (const idx of near) {
    const c = S.W.colliders[idx];
    if (c.y1 <= y + 0.25 || c.y0 > y + 0.5) continue;
    if (c.kind === 'box') { if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) return true; }
    else if (dist2(x, z, c.x, c.z) <= c.r * c.r) return true;
  }
  return false;
}

/** Nearest entry of a list within maxD of (x, z); each entry needs x and z. */
export function nearest(list, x, z, maxD, filter) {
  let best = null, bd = maxD * maxD;
  for (const e of list) {
    if (filter && !filter(e)) continue;
    const d = dist2(e.x, e.z, x, z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Game time as absolute hours since day 1 began (for ages and cooldowns). */
export function absHours(S) {
  return (S.clock.day - 1) * 24 + S.clock.hours;
}
