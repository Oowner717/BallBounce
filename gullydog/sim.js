/*
 * sim.js — the game. Pure and deterministic: no DOM, no clock, no Math.random().
 *
 *   createSim({ world, seed, save })  -> S
 *   step(S, dt, input)                 advance by dt real seconds
 *   contextAction(S)                   what the action button would do right now
 *   drainEvents(S)                     everything that happened, for sound and HUD
 *
 * The dog is the only thing the player controls. Everything else lives in
 * traffic.js, crowd.js, fauna.js and scenes.js, which all read and write the same
 * state object S and talk through events (simcore.emit).
 *
 * INPUT (one step): { mx, mz } desired direction in world space, magnitude 0..1;
 *   run (held); and edge-triggered jump, bark, sniff, act, lie.
 */

import { CONFIG } from './config.js';
import { makeRng, clamp, lerp, dist2, approachAngle, angleDiff, smoothstep, wrapAngle } from './util.js';
import { SURF, PLAY_HALF, collidersNear, surfAt, zoneAt, inShade, nearestPedNode, pedPath, pedWalkable } from './world.js';
import { SpatialHash } from './spatial.js';
import { sunDirection } from './env.js';
import { emit, drainEvents, say, updateBubbles, groundAt, spawnItem, removeItem, updateItems, isFood, nearest } from './simcore.js';
import * as Traffic from './traffic.js';
import * as Crowd from './crowd.js';
import * as Fauna from './fauna.js';
import * as Scenes from './scenes.js';
import * as Tasks from './tasks.js';

export { drainEvents };

export const SAVE_KEY = 'gullydog-save-v1';
export const SAVE_VERSION = 1;
const NO_INPUT = { mx: 0, mz: 0 };
const BODY_H = 0.55; // the dog's body, for deciding what is a wall and what is overhead

/* ------------------------------------------------------------------- create */

function makeDog(W) {
  const sp = W.spawns.dog;
  return {
    x: sp.x, y: 0.18, z: sp.z, vx: 0, vy: 0, vz: 0, yaw: sp.yaw, speed: 0, h: 0.95,
    onGround: true, pose: 'lie',
    sitting: false, lying: true, sleeping: false, begging: false, begT: 0,
    action: null, barkT: 0, barkCD: 0, sniffCD: 0, invuln: 0, barkedAt: -1,
    carry: null, scaredT: 0,
    needs: { hunger: 72, thirst: 66, energy: 92, mood: 60, health: 100 },
    hot: false, shaded: true, shadeT: 0, lookT: 0, lookYaw: 0,
    side: 'S', crossHit: false, zone: '', napAcc: 0, bikeT: 0, bikeCD: 0,
    happy: false, scared: false, panting: false, marked: [], rummaged: {},
  };
}

function newDayCounters() {
  return { cred: 0, ate: 0, drank: 0, petted: 0, hits: 0, honks: 0, barks: 0, scatters: 0, friends: 0, distance: 0, zones: [], stole: 0 };
}

export function createSim({ world, config, seed = 1, save = null, weather = null }) {
  const C = config || CONFIG;
  const S = {
    W: world, C, seed,
    rng: makeRng(seed),
    t: 0,
    clock: { day: 1, hours: C.time.startHour, absH: C.time.startHour },
    gameDt: 0,
    weather: weather || 'clear',
    events: [], taskCursor: 0,
    grid: new SpatialHash(3),
    dog: makeDog(world),
    peds: [], vehicles: [], cows: [], goats: [], flocks: [], birds: [], dogs: [], items: [],
    bubbles: [],
    nextId: 1,
    cred: 0, rank: 0, collar: false,
    friendship: { kalu: 0, moti: 12, sheru: 0, lali: 6 },
    day: newDayCounters(),
    totals: { days: 0, ate: 0, petted: 0, hits: 0, distance: 0 },
    tasks: [],
    sniff: null,
    dayOver: null,
    paused: false,
  };
  if (save) applySave(S, save);
  S.rng = makeRng((seed * 7919 + S.clock.day * 104729) >>> 0);
  if (!weather) S.weather = weatherFor(S.seed, S.clock.day);
  Traffic.init(S);
  Crowd.init(S);
  Fauna.init(S);
  Scenes.init(S);
  Tasks.startDay(S);
  if (save && save.mid && save.mid.day === S.clock.day) applyMidDay(S, save.mid);
  S.dog.y = groundAt(S, S.dog.x, S.dog.z, 1);
  return S;
}

/** Day one is always clear; later days roll the weather. */
export function weatherFor(seed, day) {
  if (day <= 1) return 'clear';
  const r = makeRng(seed * 13 + day * 7)();
  return r < 0.5 ? 'clear' : r < 0.72 ? 'hazy' : r < 0.9 ? 'rain' : 'clear';
}

/* --------------------------------------------------------------------- step */

export function step(S, dt, input) {
  if (S.paused || S.dayOver) return;
  dt = Math.min(dt, S.C.time.maxDt);
  input = input || NO_INPUT;
  S.t += dt;
  advanceClock(S, dt);
  S.grid.clear();
  Traffic.insertGrid(S);
  Crowd.insertGrid(S);
  Fauna.insertGrid(S);
  S.grid.insert('dog', S.dog, S.dog.x, S.dog.z, S.C.dog.radius);
  updateDog(S, dt, input);
  Traffic.step(S, dt);
  Crowd.step(S, dt);
  Fauna.step(S, dt);
  Scenes.step(S, dt);
  updateItems(S, dt);
  updateNeeds(S, dt);
  updateBubbles(S, dt);
  if (S.sniff) { S.sniff.t -= dt; if (S.sniff.t <= 0) S.sniff = null; }
  Tasks.step(S);
  checkDay(S);
}

function advanceClock(S, dt) {
  const k = (S.C.time.scale / 60) * (S.dog.sleeping ? S.C.time.sleepScale : 1);
  S.gameDt = dt * k;
  S.clock.hours += S.gameDt;
  S.clock.absH += S.gameDt;
  if (S.clock.hours >= 24) S.clock.hours -= 24;
}

/* ---------------------------------------------------------------------- dog */

function updateDog(S, dt, input) {
  const d = S.dog;
  const C = S.C.dog;
  d.barkCD -= dt; d.sniffCD -= dt; d.invuln -= dt; d.scaredT -= dt; d.bikeCD -= dt;
  if (d.barkT > 0) d.barkT -= dt;
  const mx = input.mx || 0, mz = input.mz || 0;
  const mag = Math.min(1, Math.hypot(mx, mz));
  const wantsMove = mag > 0.12;

  // an action in progress runs to completion unless the player pulls away
  if (d.action) {
    const a = d.action;
    a.t += dt;
    if (a.kind === 'knock') {
      if (a.t >= a.dur) d.action = null;
    } else if (wantsMove && a.t > 0.3) {
      d.action = null;
    } else if (a.t >= a.dur) {
      finishAction(S, a);
    }
  }
  if (wantsMove && !d.action) {
    if (d.sleeping) wake(S);
    d.sitting = false; d.lying = false; d.begging = false;
  }
  if (input.lie && !d.action) toggleLie(S);
  if (input.act && !d.action) doContext(S);
  if (input.bark && d.barkCD <= 0 && !d.sleeping && (!d.action || d.action.kind !== 'knock')) bark(S);
  if (input.sniff && d.sniffCD <= 0 && !d.sleeping) sniff(S);
  if (input.jump && d.onGround && !d.action && !d.sleeping) {
    d.vy = C.jumpSpeed;
    d.onGround = false;
    d.sitting = d.lying = d.begging = false;
    emit(S, 'jump', {});
  }

  // desired horizontal velocity
  const locked = !!d.action || d.sitting || d.lying;
  let target = 0;
  if (!locked && wantsMove) {
    if (mag < 0.55) target = lerp(0.6, C.walkSpeed, (mag - 0.12) / 0.43);
    else target = lerp(C.walkSpeed, C.trotSpeed, (mag - 0.55) / 0.45);
    if (input.run && d.needs.energy > 3) target = C.runSpeed;
    if (d.needs.energy < 8) target = Math.min(target, C.tiredSpeed);
    if (d.needs.health < 25) target = Math.min(target, C.trotSpeed * 0.8);
  }
  const knocked = d.action && d.action.kind === 'knock';
  if (!knocked) {
    const dirx = wantsMove ? mx / Math.hypot(mx, mz) : 0, dirz = wantsMove ? mz / Math.hypot(mx, mz) : 0;
    const tvx = dirx * target, tvz = dirz * target;
    const acc = (d.onGround ? C.accel : C.airAccel) * dt;
    const dvx = tvx - d.vx, dvz = tvz - d.vz;
    const dl = Math.hypot(dvx, dvz);
    if (dl > acc) { d.vx += (dvx / dl) * acc; d.vz += (dvz / dl) * acc; } else { d.vx = tvx; d.vz = tvz; }
    if (target > 0.05) d.yaw = approachAngle(d.yaw, Math.atan2(dirx, dirz), C.turnRate * dt * (1 + 1 / (0.6 + d.speed)));
  } else if (d.onGround) {
    const f = Math.exp(-4 * dt);
    d.vx *= f; d.vz *= f;
  }

  // move...
  const px = d.x, pz = d.z;
  d.x += d.vx * dt;
  d.z += d.vz * dt;

  // ...up and down: gravity, landing, kerbs and steps...
  const g = groundAt(S, d.x, d.z, d.y, C.stepUp);
  if (!d.onGround || d.y > g + 0.02) {
    d.onGround = false;
    // exact for constant gravity, so a jump is the same height at any frame rate
    d.y += d.vy * dt - 0.5 * C.gravity * dt * dt;
    d.vy -= C.gravity * dt;
    if (d.y <= g) {
      d.y = g;
      // a thud for jumps and real drops; stepping down a kerb (0.18 m, 2.7 m/s)
      // or a temple step (0.3 m, 3.4 m/s) is silent
      if (d.vy < -3.6) emit(S, 'land', { v: -d.vy });
      d.vy = 0;
      d.onGround = true;
    }
  } else {
    d.y = g;
    d.vy = 0;
  }

  // ...then out of anything solid at the height the dog ended up at, and out of
  // everyone's way. A shove from a cow or a bumper must not end inside a wall.
  collideStatic(S, d);
  collideDynamic(S, d, dt);
  collideStatic(S, d);
  d.x = clamp(d.x, -PLAY_HALF, PLAY_HALF);
  d.z = clamp(d.z, -PLAY_HALF, PLAY_HALF);

  const moved = Math.hypot(d.x - px, d.z - pz);
  d.speed = moved / Math.max(dt, 1e-6);
  S.day.distance += moved;

  // sitting still in front of someone is begging; the crowd decides what happens
  if ((d.sitting || d.begging) && !d.action) d.begT += dt; else d.begT = 0;
  d.begging = d.sitting && d.begT > 0.4 && personAhead(S);

  // pose for the animator
  d.pose = poseOf(d);

  // where the head looks
  d.lookT -= dt;
  if (d.lookT <= 0) { d.lookT = 0.3; d.lookYaw = lookTarget(S); }

  // sun and shade, a few times a second
  d.shadeT -= dt;
  if (d.shadeT <= 0) {
    d.shadeT = 0.4;
    const sun = sunDirection(S.clock.hours);
    d.shaded = sun[1] < 0.08 || S.weather === 'rain' || inShade(S.W, d.x, d.y + 0.4, d.z, sun[0], sun[1], sun[2]);
    const h = S.clock.hours;
    d.hot = !d.shaded && h >= S.C.needs.heatStart && h <= S.C.needs.heatEnd;
  }

  trackPlaces(S);
  trackBikeChase(S, dt);
}

function poseOf(d) {
  if (d.action) {
    const k = d.action.kind;
    if (k === 'eat' || k === 'drink' || k === 'rummage') return k === 'rummage' ? 'sniff' : k;
    if (k === 'mark') return 'mark';
    if (k === 'knock') return 'knock';
    if (k === 'grab') return 'beg';
    if (k === 'greet') return 'sit';
  }
  if (d.sleeping) return 'sleep';
  if (d.lying) return 'lie';
  if (d.begging) return 'beg';
  if (d.sitting) return 'sit';
  if (d.sniffing) return 'sniff';
  return 'move';
}

function personAhead(S) {
  const d = S.dog;
  for (const p of S.peds) {
    if (p.hidden) continue;
    const q = dist2(p.x, p.z, d.x, d.z);
    if (q > 3.3 * 3.3) continue;
    if (Math.abs(angleDiff(d.yaw, Math.atan2(p.x - d.x, p.z - d.z))) < 1.3) return true;
  }
  return false;
}

const lookList = [];
function lookTarget(S) {
  const d = S.dog;
  S.grid.query(d.x, d.z, 5, lookList);
  let best = null, bd = 25;
  for (const e of lookList) {
    if (e.ref === d) continue;
    const q = dist2(e.x, e.z, d.x, d.z);
    if (q < bd && q > 0.25) {
      const rel = angleDiff(d.yaw, Math.atan2(e.x - d.x, e.z - d.z));
      if (Math.abs(rel) < 1.6) { bd = q; best = rel; }
    }
  }
  return best === null ? 0 : clamp(best, -0.9, 0.9);
}

/* -------------------------------------------------------------- collisions */

const colList = [];

function collideStatic(S, d) {
  const W = S.W;
  const r = S.C.dog.radius;
  const stepUp = S.C.dog.stepUp;
  collidersNear(W, d.x, d.z, r + 0.5, colList);
  for (let iter = 0; iter < 3; iter++) {
    let any = false;
    for (const idx of colList) {
      const c = W.colliders[idx];
      if (c.y1 <= d.y + stepUp + 1e-3) continue; // a floor to step onto, not a wall
      if (c.y0 >= d.y + BODY_H) continue;          // passes overhead
      if (c.kind === 'box') {
        const qx = clamp(d.x, c.x0, c.x1), qz = clamp(d.z, c.z0, c.z1);
        let dx = d.x - qx, dz = d.z - qz;
        const l2 = dx * dx + dz * dz;
        if (l2 > r * r) continue;
        if (l2 < 1e-9) {
          // centre inside the box: leave by the nearest face
          const e = [d.x - c.x0, c.x1 - d.x, d.z - c.z0, c.z1 - d.z];
          const m = Math.min(...e);
          if (m === e[0]) d.x = c.x0 - r; else if (m === e[1]) d.x = c.x1 + r; else if (m === e[2]) d.z = c.z0 - r; else d.z = c.z1 + r;
        } else {
          const l = Math.sqrt(l2);
          d.x = qx + (dx / l) * r;
          d.z = qz + (dz / l) * r;
          // lose the velocity into the wall
          const nx = dx / l, nz = dz / l;
          const vn = d.vx * nx + d.vz * nz;
          if (vn < 0) { d.vx -= vn * nx; d.vz -= vn * nz; }
        }
        any = true;
      } else {
        const dx = d.x - c.x, dz = d.z - c.z;
        const rr = c.r + r;
        const l2 = dx * dx + dz * dz;
        if (l2 >= rr * rr) continue;
        const l = Math.sqrt(l2) || 1e-4;
        const nx = l2 > 1e-8 ? dx / l : 1, nz = l2 > 1e-8 ? dz / l : 0;
        d.x = c.x + nx * rr;
        d.z = c.z + nz * rr;
        const vn = d.vx * nx + d.vz * nz;
        if (vn < 0) { d.vx -= vn * nx; d.vz -= vn * nz; }
        any = true;
      }
    }
    if (!any) break;
  }
}

const dynList = [];

function collideDynamic(S, d, dt) {
  const r = S.C.dog.radius;
  S.grid.query(d.x, d.z, 3.5, dynList);
  for (const e of dynList) {
    if (e.ref === d) continue;
    const dx = d.x - e.x, dz = d.z - e.z;
    const rr = e.r + r;
    const l2 = dx * dx + dz * dz;
    if (l2 >= rr * rr) continue;
    const l = Math.sqrt(l2) || 1e-4;
    const nx = dx / l, nz = dz / l;
    const pen = rr - l;
    if (e.kind === 'veh') {
      const v = e.ref;
      // closing speed of the vehicle onto the dog (n points from the vehicle to the
      // dog): driving at him is a hit, brushing past or pulling away is a shove
      const closing = (v.dirx * nx + v.dirz * nz) * v.v;
      if (v.v > S.C.traffic.hitSpeed && closing > 0.5 && d.invuln <= 0 && d.y < 1.2) {
        hitByVehicle(S, v, nx, nz);
        return;
      }
      d.x += nx * pen; d.z += nz * pen;
      const vn = d.vx * nx + d.vz * nz;
      if (vn < 0) { d.vx -= vn * nx; d.vz -= vn * nz; }
    } else if (e.kind === 'cow' || e.kind === 'goat') {
      if (d.y > 1.0) continue;
      d.x += nx * pen; d.z += nz * pen;
      const vn = d.vx * nx + d.vz * nz;
      if (vn < 0) { d.vx -= vn * nx; d.vz -= vn * nz; }
    } else {
      // people and dogs: soft — the dog is nudged and passers-by make room. Anyone
      // with a spot of their own (a shopkeeper, a vendor, Raju, the pujari, someone
      // on a bench) holds it: nothing walks them back once they are shoved off it.
      const p = e.kind === 'ped' ? e.ref : null;
      const anchored = p && (p.role === 'keeper' || p.role === 'vendor' || (p.role === 'special' && !p.kid) || p.state === 'sit');
      const k = anchored ? 1 : 0.5;
      d.x += nx * pen * k; d.z += nz * pen * k;
      if (p && !anchored) {
        // ...but never off the pavement and into a wall or the traffic
        const px = p.x - nx * pen * 0.5, pz = p.z - nz * pen * 0.5;
        if (pedWalkable(S.W, px, pz) || !pedWalkable(S.W, p.x, p.z)) { p.x = px; p.z = pz; }
      }
    }
  }
}

function hitByVehicle(S, v, nx, nz) {
  const d = S.dog;
  const T = S.C.traffic;
  const dmg = Math.min(T.hitDamage[2], T.hitDamage[0] + T.hitDamage[1] * v.v);
  d.needs.health -= dmg;
  d.needs.mood -= 8;
  d.scaredT = 4;
  // thrown along the vehicle's travel and out to the side it was struck from
  const sp = v.v;
  d.vx = v.dirx * sp * 0.75 + nx * 3.2;
  d.vz = v.dirz * sp * 0.75 + nz * 3.2;
  d.vy = 3 + sp * 0.12;
  d.onGround = false;
  d.action = { kind: 'knock', t: 0, dur: 0.95 };
  d.invuln = S.C.dog.hitInvuln;
  d.sitting = d.lying = d.sleeping = d.begging = false;
  if (d.carry) dropCarry(S, false);
  d.crossHit = true;
  S.day.hits++;
  S.totals.hits++;
  emit(S, 'hit', { dmg, vtype: v.type, x: d.x, z: d.z });
  Traffic.hitDog(S, v);
}

/* ---------------------------------------------------------------- actions */

function startAction(S, kind, dur, target) {
  const d = S.dog;
  d.action = { kind, t: 0, dur, target };
  d.vx = 0; d.vz = 0;
  d.sitting = false; d.lying = false; d.begging = false;
  if (target && Number.isFinite(target.x)) d.yaw = Math.atan2(target.x - d.x, target.z - d.z);
}

function finishAction(S, a) {
  const d = S.dog;
  d.action = null;
  const F = S.C.food;
  switch (a.kind) {
    case 'eat': {
      const it = a.target;
      if (!it || it.gone) return;
      eatItem(S, it);
      break;
    }
    case 'drink': {
      const w = a.target;
      d.needs.thirst = Math.min(100, d.needs.thirst + F.drinkGain);
      if (w && !w.clean && S.rng() < 0.15) { d.needs.health -= 3; emit(S, 'queasy', {}); }
      if (w && w.item) removeItem(S, w.item);
      S.day.drank++;
      emit(S, 'drank', { src: w ? w.id || w.kind + Math.round(w.x) + ',' + Math.round(w.z) : 'x', kind: w ? w.kind : '' });
      break;
    }
    case 'rummage': {
      const g = a.target;
      const key = Math.round(g.x) + ',' + Math.round(g.z);
      d.rummaged[key] = S.clock.absH;
      const found = S.rng() < F.rummageFind;
      if (found) {
        const kind = S.rng() < 0.3 ? 'bone' : S.rng() < 0.6 ? 'roti' : 'scraps';
        spawnItem(S, kind, g.x + Math.sin(d.yaw + Math.PI) * 0.2 + (d.x - g.x) * 0.5, 0.5, g.z + (d.z - g.z) * 0.5, (d.x - g.x) * 0.6, 1.5, (d.z - g.z) * 0.6, { found: true });
      }
      emit(S, 'rummage', { found });
      break;
    }
    case 'mark': {
      const p = a.target;
      const key = Math.round(p.x * 10) + ',' + Math.round(p.z * 10);
      if (!d.marked.includes(key)) { d.marked.push(key); emit(S, 'marked', { x: p.x, z: p.z }); }
      else emit(S, 'markedAgain', {});
      break;
    }
    case 'grab': {
      const it = Scenes.grabSamosa(S);
      if (!it) emit(S, 'nothingLeft', {});
      break;
    }
    case 'greet': {
      Fauna.greet(S, a.target);
      break;
    }
    case 'pickup': {
      const it = a.target;
      if (!it || it.gone || it.state === 'carried' || it.state === 'held') return;
      it.state = 'carried';
      d.carry = it;
      emit(S, 'pickup', { kind: it.kind });
      break;
    }
    default:
  }
}

function eatItem(S, it) {
  const d = S.dog;
  const F = S.C.food;
  const f = F[it.kind] || F.scraps;
  d.needs.hunger = Math.min(100, d.needs.hunger + (f.hunger || 0));
  if (f.thirst) d.needs.thirst = Math.min(100, d.needs.thirst + f.thirst);
  d.needs.mood = Math.min(100, d.needs.mood + (f.mood || 0));
  if (f.sick && S.rng() < f.sick) { d.needs.health -= 4; emit(S, 'queasy', {}); }
  removeItem(S, it);
  S.day.ate++;
  S.totals.ate++;
  emit(S, 'ate', { kind: it.kind, aunty: !!it.aunty, prasad: !!it.prasad, stolen: !!it.stolen });
}

function dropCarry(S, gentle) {
  const d = S.dog;
  const it = d.carry;
  if (!it) return null;
  d.carry = null;
  it.x = d.x + Math.sin(d.yaw) * 0.55;
  it.z = d.z + Math.cos(d.yaw) * 0.55;
  it.y = d.y + 0.4;
  it.vx = gentle ? 0 : d.vx * 0.5; it.vz = gentle ? 0 : d.vz * 0.5; it.vy = 0.5;
  it.state = 'air';
  it.byPlayer = true;
  // dropped in front of a dog: it's for them
  const npc = Fauna.npcDogNear(S, it.x, it.z, 2.6);
  if (npc && isFood(it)) it.forDog = npc.key;
  emit(S, 'drop', { kind: it.kind });
  return it;
}

function toggleLie(S) {
  const d = S.dog;
  if (d.sleeping) { wake(S); return; }
  if (d.lying) {
    d.sleeping = true;
    emit(S, 'sleep', {});
    return;
  }
  d.lying = true;
  d.sitting = false;
  d.begging = false;
  d.vx = d.vz = 0;
}

function wake(S) {
  const d = S.dog;
  d.sleeping = false;
  d.lying = false;
  emit(S, 'wake', {});
}

function bark(S) {
  const d = S.dog;
  d.barkT = 0.35;
  d.barkCD = S.C.dog.barkCooldown;
  d.barkedAt = S.t;
  d.sleeping = false;
  S.day.barks++;
  emit(S, 'bark', { x: d.x, z: d.z });
}

/**
 * What the action button would do here, best first. Returns
 * { kind, label, target } — the HUD shows the label.
 */
export function contextAction(S) {
  const d = S.dog;
  const R = S.C.dog.reach;
  if (d.sleeping) return { kind: 'wake', label: 'Wake up' };
  const fx = d.x + Math.sin(d.yaw) * 0.35, fz = d.z + Math.cos(d.yaw) * 0.35;
  if (d.carry) {
    if (isFood(d.carry)) {
      const npc = Fauna.npcDogNear(S, d.x, d.z, 2.6);
      if (npc) return { kind: 'drop', label: 'Share with ' + (npc.puppy ? 'the puppy' : npc.name) };
      return { kind: 'eatCarry', label: 'Eat the ' + d.carry.kind, target: d.carry };
    }
    return { kind: 'drop', label: 'Drop the ' + d.carry.kind };
  }
  // food on the ground: eaten, unless the dog is full — then it is picked up, to
  // share with a friend or the puppies
  const food = nearest(S.items, fx, fz, R, (it) => (it.state === 'ground' || it.state === 'roll') && isFood(it) && Math.abs(it.y - d.y) < 0.6);
  if (food) {
    if (food.kind === 'milk') return { kind: 'eat', label: 'Lap up the milk', target: food };
    if (d.needs.hunger >= S.C.food.carryWhenFull) return { kind: 'pickup', label: 'Pick up the ' + food.kind, target: food };
    return { kind: 'eat', label: 'Eat the ' + food.kind, target: food };
  }
  // water
  const water = nearestWater(S, fx, fz, 1.15);
  if (water && d.needs.thirst < 97) return { kind: 'drink', label: 'Drink', target: water };
  // the halwai's samosas
  const H = S.W.special.halwai;
  if (H && dist2(fx, fz, H.front.x, H.front.z) < 1.1 * 1.1 && Scenes.samosasLeft(S) > 0 && S.scenes.halwai.state === 'idle') {
    return { kind: 'grab', label: 'Grab a samosa!', target: H.front };
  }
  // things to pick up
  const thing = nearest(S.items, fx, fz, R, (it) => (it.state === 'ground' || it.state === 'roll' || (it.state === 'air' && it.y < d.y + 1.1)) && !isFood(it) && it.kind !== 'bowl');
  if (thing) return { kind: 'pickup', label: thing.kind === 'ball' ? 'Grab the ball' : 'Pick up the ' + thing.kind, target: thing };
  // a dog to greet
  const npc = Fauna.npcDogNear(S, d.x, d.z, 2.2);
  if (npc) return { kind: 'greet', label: 'Greet ' + (npc.puppy ? 'the puppy' : npc.name), target: npc };
  // garbage to rummage
  const g = nearest(S.W.pois.garbage, d.x, d.z, 2.1);
  if (g) {
    const key = Math.round(g.x) + ',' + Math.round(g.z);
    const last = d.rummaged[key];
    if (last === undefined || S.clock.absH - last > S.C.food.rummageCooldown / 60) return { kind: 'rummage', label: 'Rummage', target: g };
  }
  // a post to mark
  const post = nearest(S.W.pois.posts, d.x, d.z, 0.95);
  if (post) return { kind: 'mark', label: 'Mark this ' + (post.tag === 'tree' ? 'tree' : 'post'), target: post };
  if (d.lying) return { kind: 'sit', label: 'Sit up' };
  if (d.sitting) return { kind: 'stand', label: 'Stand' };
  return { kind: 'sit', label: personAhead(S) ? 'Sit and beg' : 'Sit' };
}

function nearestWater(S, x, z, r) {
  let best = null, bd = r * r;
  for (const w of S.W.pois.water) {
    const q = dist2(w.x, w.z, x, z);
    if (q < bd) { bd = q; best = w; }
  }
  for (const it of S.items) {
    if (it.kind !== 'milk' || it.state !== 'ground') continue;
    const q = dist2(it.x, it.z, x, z);
    if (q < bd) { bd = q; best = { x: it.x, z: it.z, kind: 'milk', clean: true, item: it, id: 'milk' }; }
  }
  // rain fills every pothole
  if (!best && S.weather === 'rain' && surfAt(S.W, x, z) === SURF.ROAD) best = { x, z, kind: 'rain', clean: false, id: 'rain' };
  return best;
}

function doContext(S) {
  const d = S.dog;
  const a = contextAction(S);
  const F = S.C.food;
  switch (a.kind) {
    case 'wake': wake(S); break;
    case 'eat': startAction(S, 'eat', F.eatTime, a.target); break;
    case 'eatCarry': {
      const it = d.carry;
      d.carry = null;
      it.state = 'ground';
      it.x = d.x + Math.sin(d.yaw) * 0.5; it.z = d.z + Math.cos(d.yaw) * 0.5; it.y = d.y;
      if (it.stolen && S.scenes.halwai && S.scenes.halwai.state === 'chase') emit(S, 'eatingStolen', {});
      startAction(S, 'eat', F.eatTime, it);
      break;
    }
    case 'drink': startAction(S, 'drink', F.drinkTime, a.target); break;
    case 'grab': startAction(S, 'grab', 0.55, a.target); break;
    case 'pickup': startAction(S, 'pickup', 0.3, a.target); break;
    case 'greet': startAction(S, 'greet', 1.1, a.target); break;
    case 'rummage': startAction(S, 'rummage', F.rummageTime, a.target); break;
    case 'mark': startAction(S, 'mark', 1.4, a.target); break;
    case 'drop': dropCarry(S, true); break;
    case 'stand': d.sitting = false; d.begging = false; break;
    case 'sit':
      d.lying = false;
      d.sitting = true;
      d.vx = d.vz = 0;
      break;
    default:
  }
}

/* ------------------------------------------------------------------ sniff */

/**
 * Follow your nose: up to three scent trails, each a path along the pedestrian
 * graph from the dog to something worth finding — food, water if thirsty, and
 * whatever today's next task needs.
 */
function sniff(S) {
  const d = S.dog;
  const C = S.C.dog;
  d.sniffCD = C.sniffCooldown;
  const G = S.W.peds;
  const start = nearestPedNode(G, d.x, d.z);
  const trails = [];
  const addTrail = (kind, x, z, range = C.sniffRange) => {
    if (!Number.isFinite(x) || dist2(x, z, d.x, d.z) > range * range) return;
    if (trails.some((t) => dist2(t.x, t.z, x, z) < 4)) return;
    const goal = nearestPedNode(G, x, z);
    const path = start >= 0 && goal >= 0 ? pedPath(G, start, goal) : null;
    const pts = [[d.x, d.z]];
    if (path) for (const n of path) pts.push([G.nodes[n].x, G.nodes[n].z]);
    pts.push([x, z]);
    trails.push({ kind, x, z, pts });
  };
  // food: something lying around, else a garbage heap, else the chai stall
  const food = nearest(S.items, d.x, d.z, C.sniffRange, (it) => it.state === 'ground' && isFood(it));
  if (food) addTrail('food', food.x, food.z);
  else {
    const g = nearest(S.W.pois.garbage, d.x, d.z, C.sniffRange, (q) => {
      const last = d.rummaged[Math.round(q.x) + ',' + Math.round(q.z)];
      return last === undefined || S.clock.absH - last > S.C.food.rummageCooldown / 60;
    });
    if (g) addTrail('food', g.x, g.z);
  }
  if (d.needs.thirst < 75) {
    const w = nearest(S.W.pois.water, d.x, d.z, C.sniffRange);
    if (w) addTrail('water', w.x, w.z);
  }
  // today's task is always worth following, however far away it is
  const t = Tasks.taskTarget(S);
  if (t) addTrail('task', t.x, t.z, Infinity);
  // a friend's scent
  const friend = S.dogs.find((q) => !q.puppy && (S.friendship[q.key] || 0) >= S.C.animals.friendAt && dist2(q.x, q.z, d.x, d.z) > 36);
  if (friend) addTrail('friend', friend.x, friend.z);
  S.sniff = { t: C.sniffDuration, trails };
  d.sniffing = true;
  emit(S, 'sniff', { n: trails.length });
}

/* ------------------------------------------------------------------- needs */

function updateNeeds(S, dt) {
  const d = S.dog;
  const N = S.C.needs;
  const n = d.needs;
  const gh = S.gameDt;
  if (S.sniff === null) d.sniffing = false;
  n.hunger -= N.hungerPerHour * gh;
  n.thirst -= N.thirstPerHour * gh * (d.hot ? N.heatThirstMult : 1);
  if (d.speed > 5) {
    n.hunger -= N.runHunger * dt;
    n.thirst -= N.runThirst * dt;
    n.energy -= N.runEnergy * dt;
  } else if (d.speed > 2.2) n.energy -= N.trotEnergy * dt;
  else if (d.speed > 0.3) n.energy -= N.walkEnergy * dt;
  else if (d.sleeping) n.energy += N.sleepEnergy * dt;
  else if (d.lying) n.energy += N.lieEnergy * dt;
  else if (d.sitting) n.energy += N.sitEnergy * dt;
  n.mood += (N.moodNeutral - n.mood) * (1 - Math.exp(-gh * N.moodDecayPerHour * 0.1));
  if (n.hunger < 15 || n.thirst < 15) n.mood -= 0.25 * dt;
  if (d.hot && !d.sleeping) n.mood -= 0.05 * dt;
  if (n.hunger <= 0 || n.thirst <= 0) n.health -= N.starve * dt;
  else if (n.hunger > 30 && n.thirst > 30) n.health += N.healthRegen * dt * (d.sleeping ? 3 : 1);
  for (const k of ['hunger', 'thirst', 'energy', 'mood', 'health']) n[k] = clamp(n[k], 0, 100);
  d.panting = d.hot || n.energy < 25 || n.thirst < 22 || d.speed > 5.5;
  d.scared = d.scaredT > 0;
  d.happy = !d.scared && n.mood > 62;
  // afternoon naps in the shade
  const h = S.clock.hours;
  if (d.sleeping && d.shaded && h >= 12 && h < 16.5) {
    d.napAcc += gh * 60;
    while (d.napAcc >= 1) { d.napAcc -= 1; emit(S, 'napMinute', {}); }
  }
  if (n.health <= 0) faint(S);
}

function faint(S) {
  const d = S.dog;
  const spot = Scenes.auntyRescue(S);
  emit(S, 'faint', {});
  if (spot) { d.x = spot.x; d.z = spot.z; }
  d.y = groundAt(S, d.x, d.z, 1);
  d.vx = d.vy = d.vz = 0;
  d.action = null;
  if (d.carry) dropCarry(S, true);
  d.lying = true; d.sitting = false; d.sleeping = false;
  d.needs.health = 45;
  d.needs.hunger = Math.max(d.needs.hunger, 45);
  d.needs.thirst = Math.max(d.needs.thirst, 45);
  d.needs.mood = Math.max(20, d.needs.mood - 10);
  S.clock.hours = Math.min(S.clock.hours + 1.5, 23.5);
  S.clock.absH += 1.5;
}

/* ----------------------------------------------------- places and chases */

function trackPlaces(S) {
  const d = S.dog;
  const zone = zoneAt(S.W, d.x, d.z);
  if (zone !== d.zone) {
    d.zone = zone;
    emit(S, 'zone', { name: zone });
    if (!S.day.zones.includes(zone)) { S.day.zones.push(zone); emit(S, 'newZone', { name: zone }); }
  }
  // crossing MG Road from one pavement to the other
  const side = d.z < -7.6 ? 'N' : d.z > 7.6 ? 'S' : null;
  if (side && side !== d.side) {
    if (!d.crossHit && Math.abs(d.x) < PLAY_HALF) emit(S, 'crossed', {});
    d.side = side;
    d.crossHit = false;
  }
}

function trackBikeChase(S, dt) {
  const d = S.dog;
  if (d.speed < 4.5 || d.bikeCD > 0) { d.bikeT = Math.max(0, d.bikeT - dt * 2); return; }
  let chasing = false;
  for (const v of S.vehicles) {
    if (v.type !== 'scooter' && v.type !== 'bike') continue;
    if (v.v < 3.5 || dist2(v.x, v.z, d.x, d.z) > 4.5 * 4.5) continue;
    if (v.dirx * d.vx + v.dirz * d.vz > 0) { chasing = true; break; }
  }
  if (chasing) {
    d.bikeT += dt;
    if (d.bikeT > 3) { d.bikeT = 0; d.bikeCD = 20; emit(S, 'bikeChase', {}); }
  } else d.bikeT = Math.max(0, d.bikeT - dt);
}

/* ----------------------------------------------------------------- the day */

function checkDay(S) {
  const h = S.clock.hours;
  const T = S.C.time;
  const late = h >= T.bedtime || h < 5;
  if (S.dog.sleeping && late) endDay(S, 'slept');
  else if (h >= T.collapseHour && h < 5) { S.dog.sleeping = true; S.dog.lying = true; endDay(S, 'collapsed'); }
}

function endDay(S, why) {
  const done = S.tasks.filter((t) => t.done).length;
  S.dayOver = {
    why, day: S.clock.day, tasksDone: done, tasks: S.tasks.map((t) => ({ title: t.def.title, done: t.done })),
    cred: S.day.cred, totalCred: S.cred, rank: S.rank, rankTitle: S.C.cred.ranks[S.rank][1],
    ate: S.day.ate, drank: S.day.drank, petted: S.day.petted, hits: S.day.hits, honks: S.day.honks,
    distance: Math.round(S.day.distance), friends: Object.entries(S.friendship).filter(([, v]) => v >= S.C.animals.friendAt).length,
  };
  S.totals.days++;
  emit(S, 'dayEnd', { summary: S.dayOver });
}

/** Wake up to a new morning. Called by the front end after the day summary. */
export function newDay(S) {
  const d = S.dog;
  S.clock.day++;
  S.clock.hours = S.C.time.startHour;
  S.clock.absH = (S.clock.day - 1) * 24 + S.C.time.startHour;
  S.weather = weatherFor(S.seed, S.clock.day);
  S.dayOver = null;
  S.day = newDayCounters();
  d.sleeping = false; d.lying = true; d.sitting = false; d.action = null;
  d.needs.energy = 100;
  d.needs.hunger = Math.max(15, d.needs.hunger - 22);
  d.needs.thirst = Math.max(15, d.needs.thirst - 22);
  d.needs.health = Math.min(100, d.needs.health + 30);
  d.marked = [];
  d.rummaged = {};
  if (d.carry) dropCarry(S, true);
  // back home on the sacks by the chai stall
  const sp = S.W.spawns.dog;
  d.x = sp.x; d.z = sp.z; d.yaw = sp.yaw;
  d.y = groundAt(S, d.x, d.z, 1);
  S.items = S.items.filter((it) => it.cricket);
  Tasks.startDay(S);
  emit(S, 'newDay', { day: S.clock.day, weather: S.weather });
}

/* -------------------------------------------------------------------- save */

export function defaultSave() {
  return { v: SAVE_VERSION, day: 1, cred: 0, collar: false, friendship: { kalu: 0, moti: 12, sheru: 0, lali: 6 }, totals: { days: 0, ate: 0, petted: 0, hits: 0, distance: 0 }, mid: null };
}

export function serializeSave(S) {
  const d = S.dog;
  return JSON.stringify({
    v: SAVE_VERSION,
    day: S.clock.day,
    cred: Math.round(S.cred),
    collar: !!S.collar,
    friendship: S.friendship,
    totals: S.totals,
    mid: S.dayOver ? null : {
      day: S.clock.day, hours: S.clock.hours, x: d.x, z: d.z, yaw: d.yaw,
      needs: d.needs, tasks: S.tasks.map((t) => [t.id, t.progress, t.done ? 1 : 0, t.seen]),
      dayc: S.day, marked: d.marked,
    },
  });
}

/** Parse defensively: anything wrong and we start clean rather than crash. */
export function loadSave(text) {
  const def = defaultSave();
  if (!text || typeof text !== 'string') return def;
  let o;
  try { o = JSON.parse(text); } catch (e) { return def; }
  if (!o || typeof o !== 'object' || o.v !== SAVE_VERSION) return def;
  const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : dflt);
  const out = defaultSave();
  out.day = Math.floor(num(o.day, 1, 100000, 1));
  out.cred = num(o.cred, 0, 1e7, 0);
  out.collar = o.collar === true;
  if (o.friendship && typeof o.friendship === 'object') {
    for (const k of Object.keys(out.friendship)) out.friendship[k] = num(o.friendship[k], 0, 100, out.friendship[k]);
  }
  if (o.totals && typeof o.totals === 'object') {
    for (const k of Object.keys(out.totals)) out.totals[k] = num(o.totals[k], 0, 1e9, 0);
  }
  const m = o.mid;
  if (m && typeof m === 'object' && num(m.day, 1, 100000, 0) === out.day) {
    const needs = {};
    for (const k of ['hunger', 'thirst', 'energy', 'mood', 'health']) needs[k] = num(m.needs && m.needs[k], 0, 100, 60);
    out.mid = {
      day: out.day, hours: num(m.hours, 0, 24, 6.5), x: num(m.x, -PLAY_HALF, PLAY_HALF, NaN), z: num(m.z, -PLAY_HALF, PLAY_HALF, NaN), yaw: num(m.yaw, -10, 10, 0),
      needs, tasks: Array.isArray(m.tasks) ? m.tasks.filter((t) => Array.isArray(t) && typeof t[0] === 'string').slice(0, 8) : [],
      dayc: m.dayc && typeof m.dayc === 'object' ? m.dayc : null,
      marked: Array.isArray(m.marked) ? m.marked.filter((s) => typeof s === 'string').slice(0, 200) : [],
    };
  }
  return out;
}

function applySave(S, sv) {
  S.clock.day = sv.day;
  S.clock.hours = S.C.time.startHour;
  S.clock.absH = (sv.day - 1) * 24 + S.clock.hours;
  S.cred = sv.cred;
  S.rank = Tasks.rankFor(S, sv.cred);
  S.collar = sv.collar || S.rank >= 2;
  Object.assign(S.friendship, sv.friendship);
  Object.assign(S.totals, sv.totals);
}

function applyMidDay(S, m) {
  const d = S.dog;
  S.clock.hours = m.hours;
  S.clock.absH = (S.clock.day - 1) * 24 + m.hours;
  if (Number.isFinite(m.x) && Number.isFinite(m.z)) {
    // only trust a saved spot that is actually open ground
    const s = surfAt(S.W, m.x, m.z);
    if (s !== SURF.BUILDING && s !== SURF.MASS) { d.x = m.x; d.z = m.z; d.yaw = m.yaw; d.lying = false; }
  }
  Object.assign(d.needs, m.needs);
  for (const [id, progress, done, seen] of m.tasks) {
    const t = S.tasks.find((q) => q.id === id);
    if (!t) continue;
    t.progress = clamp(Number(progress) || 0, 0, t.def.count);
    t.done = done === 1;
    if (Array.isArray(seen)) t.seen = seen.slice(0, 20);
  }
  if (m.dayc) {
    for (const k of Object.keys(S.day)) {
      if (k === 'zones') S.day.zones = Array.isArray(m.dayc.zones) ? m.dayc.zones.filter((z) => typeof z === 'string') : [];
      else if (typeof m.dayc[k] === 'number' && Number.isFinite(m.dayc[k])) S.day[k] = m.dayc[k];
    }
  }
  d.marked = m.marked || [];
  S.weather = weatherFor(S.seed, S.clock.day);
}

/* ------------------------------------------------------------------ hashing */

/** A digest of the state that matters, for determinism tests. */
export function hashState(S) {
  let h = 2166136261 >>> 0;
  const mix = (v) => {
    const x = Math.round(v * 1000) | 0;
    h ^= x;
    h = Math.imul(h, 16777619) >>> 0;
  };
  const d = S.dog;
  mix(d.x); mix(d.z); mix(d.y); mix(d.yaw);
  for (const k of ['hunger', 'thirst', 'energy', 'mood', 'health']) mix(d.needs[k]);
  mix(S.clock.hours); mix(S.cred);
  for (const v of S.vehicles) { mix(v.id); mix(v.s); mix(v.d); mix(v.v); }
  for (const p of S.peds) { mix(p.id); mix(p.x); mix(p.z); }
  for (const c of S.cows) { mix(c.x); mix(c.z); }
  for (const b of S.birds) { mix(b.x); mix(b.y); mix(b.z); }
  for (const q of S.dogs) { mix(q.x); mix(q.z); }
  mix(S.items.length);
  mix(S.rng.getState());
  return h >>> 0;
}
