/*
 * fauna.js — everyone else with four legs or two wings.
 *
 * COWS wander their patch at a stately pace and lie down wherever they like,
 * including the middle of MG Road; traffic flows round them. Bark at one often
 * enough and it will move; get in its face and it will nudge you.
 * GOATS graze the maidan and scatter when chased.
 * PIGEONS peck in flocks and burst up onto the rooftops when something rushes
 * them, drifting back down a while later.
 * DOGS: Kalu, Moti, Sheru and Lali each hold a patch. Strangers get growled at
 * and chased off; friends get a wagging tail and company. Lali has puppies.
 */

import { pedWalkable, surfAt, SURF, baseHeightAt, facadePoint } from './world.js';
import { pick, rand, clamp, dist2, wrapAngle, approachAngle, hex, angleDiff, lerp } from './util.js';
import { emit, say, removeItem, isFood, groundAt } from './simcore.js';
import { SPEECH } from './data.js';

const nearList = [];

const COATS = {
  black: ['#26211e', '#4a423c', '#141110', '#26211e'],
  spotted: ['#ece4d6', '#fbf8f2', '#7d5230', '#ece4d6'],
  tan: ['#c58c47', '#ead2aa', '#7a4a22', '#c58c47'],
  red: ['#a9542c', '#e7c49a', '#5e2c14', '#a9542c'],
  puppy: ['#b8693a', '#efd3ad', '#6b3418', '#b8693a'],
};

/** Open ground a large animal can stand on (roads count; cows do not care). */
function openGround(W, x, z) {
  const s = surfAt(W, x, z);
  return s === SURF.ROAD || s === SURF.CROSS || pedWalkable(W, x, z);
}

function lineOpen(W, ax, az, bx, bz) {
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5);
  for (let i = 1; i <= n; i++) if (!openGround(W, ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)) return false;
  return true;
}

export function init(S) {
  const W = S.W;
  S.cows = W.spawns.cows.map((c, i) => ({
    id: S.nextId++, kind: 'cow', x: c.x, z: c.z, y: 0, yaw: S.rng() * Math.PI * 2, speed: 0,
    state: c.lie ? 'lie' : 'graze', timer: rand(S.rng, 10, 40) * (c.lie ? 4 : 1), lazy: !!c.lie,
    home: { x: c.x, z: c.z }, r: c.r, target: null, h: 1.7, look: 0,
    colors: [hex(pick(S.rng, ['#ebe5d8', '#e2dbcc', '#f2efe8', '#cfc6b6', '#b9a58c'])), hex('#3a3430'), hex(pick(S.rng, ['#d35400', '#2f6db5', '#c0392b', '#7a6a5a'])), hex('#ffffff')],
    barks: [], mooCD: rand(S.rng, 10, 40), shooed: null,
  }));
  S.goats = (W.spawns.goats || []).map((g) => ({
    id: S.nextId++, kind: 'goat', x: g.x, z: g.z, y: 0, yaw: S.rng() * 6.28, speed: 0, state: 'graze', timer: rand(S.rng, 3, 12),
    home: { x: g.x, z: g.z }, r: 7, target: null, h: 0.9, look: 0,
    colors: [hex(pick(S.rng, ['#f2efe8', '#3b3330', '#8a6a4a', '#d8cfc2'])), hex('#2b2522'), hex('#8a7a6a'), hex('#ffffff')],
  }));
  S.flocks = [];
  S.birds = [];
  for (const f of W.spawns.flocks) {
    const flock = { id: S.nextId++, x: f.x, z: f.z, kind: f.kind, grain: !!f.grain, island: !!f.island, perches: perchesNear(S, f.x, f.z), away: 0, cd: 0 };
    S.flocks.push(flock);
    for (let i = 0; i < f.n; i++) {
      const a = S.rng() * Math.PI * 2, r = S.rng() * 1.8;
      S.birds.push({
        id: S.nextId++, flock, x: f.x + Math.cos(a) * r, y: f.island ? 0.45 : baseHeightAt(W, f.x, f.z), z: f.z + Math.sin(a) * r,
        yaw: S.rng() * 6.28, vx: 0, vy: 0, vz: 0, state: 'ground', t: rand(S.rng, 0, 5), target: null, delay: 0,
        flying: false, pecking: false, glide: false, speed: 0,
        colors: [hex(pick(S.rng, ['#8d939b', '#9aa1a9', '#7d838b', '#a7a29a', '#6f747c'])), hex(pick(S.rng, ['#7a828c', '#6b727c', '#8a8f96'])), hex(pick(S.rng, ['#3f8a7a', '#5c4f8a', '#3f7a5a'])), hex('#ffffff')],
      });
    }
  }
  S.dogs = [];
  for (const d of W.spawns.dogs) {
    const dog = makeNpcDog(S, d.id, d.name, d.x, d.z, d.coat, 1.0);
    S.dogs.push(dog);
    for (let k = 0; k < (d.puppies || 0); k++) {
      const pup = makeNpcDog(S, d.id + 'Pup' + k, 'Puppy', d.x + rand(S.rng, -1, 1), d.z + rand(S.rng, -1, 1), 'puppy', 0.5);
      pup.mother = dog;
      pup.puppy = true;
      pup.coat = COATS.puppy.map((c, i) => hex(i === 0 ? pick(S.rng, ['#b8693a', '#2b2522', '#c9944f', '#efe8dc']) : c));
      S.dogs.push(pup);
    }
  }
}

function perchesNear(S, x, z) {
  const out = [];
  for (const b of S.W.buildings) {
    if (b.kind !== 'front') continue;
    const f = facadePoint(b, 0.3 + S.rng() * 0.4);
    const d = dist2(f.x, f.z, x, z);
    if (d < 9 * 9 || d > 34 * 34) continue;
    out.push({ x: f.x - f.nx * 0.1, y: b.h + 0.86, z: f.z - f.nz * 0.1, d });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, 10);
}

function makeNpcDog(S, key, name, x, z, coat, scale) {
  return {
    id: S.nextId++, key, name, x, z, y: 0, yaw: S.rng() * 6.28, speed: 0, vx: 0, vz: 0,
    coat: (COATS[coat] || COATS.tan).map(hex), scale, h: 0.9 * scale,
    home: { x, z }, state: 'rest', timer: rand(S.rng, 5, 20), target: null,
    barkT: 0, barkCD: 0, nipCD: 0, greetCD: 0, followT: 0, chaseT: 0, pose: 'lie',
    happy: false, scared: false, lookYaw: 0, onGround: true,
  };
}

export function insertGrid(S) {
  for (const c of S.cows) {
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    S.grid.insert('cow', c, c.x + fx * 0.5, c.z + fz * 0.5, 0.48);
    S.grid.insert('cow', c, c.x - fx * 0.5, c.z - fz * 0.5, 0.48);
  }
  for (const g of S.goats) S.grid.insert('goat', g, g.x, g.z, 0.3);
  for (const d of S.dogs) S.grid.insert('npcdog', d, d.x, d.z, 0.25 * d.scale + 0.05);
}

export function step(S, dt) {
  for (const c of S.cows) cow(S, c, dt);
  for (const g of S.goats) goat(S, g, dt);
  birds(S, dt);
  for (const d of S.dogs) npcDog(S, d, dt);
}

/* --------------------------------------------------------------------- cows */

/** Somewhere to amble to near home. `offRoad`: graze anywhere but the carriageway. */
function pickTarget(S, a, r, offRoad) {
  for (let k = 0; k < 8; k++) {
    const ang = S.rng() * Math.PI * 2, d = S.rng() * r;
    const tx = a.home.x + Math.cos(ang) * d, tz = a.home.z + Math.sin(ang) * d;
    if (offRoad && surfAt(S.W, tx, tz) === SURF.ROAD) continue;
    if (openGround(S.W, tx, tz) && lineOpen(S.W, a.x, a.z, tx, tz)) return { x: tx, z: tz };
  }
  return null;
}

function cow(S, c, dt) {
  const d = S.dog;
  const A = S.C.animals;
  c.timer -= dt;
  c.mooCD -= dt;
  const dd = dist2(c.x, c.z, d.x, d.z);
  // barks within earshot pile up; enough of them and the cow gets up and goes
  if (d.barkedAt === S.t && dd < 6 * 6) {
    c.barks.push(S.t);
    c.look = clamp(angleDiff(c.yaw, Math.atan2(d.x - c.x, d.z - c.z)), -0.8, 0.8);
    if (dd < 1.6 * 1.6 && c.state !== 'lie') {
      // too close: a nudge with the head
      const k = 1 / Math.max(0.3, Math.sqrt(dd));
      d.vx += (d.x - c.x) * k * 3.5; d.vz += (d.z - c.z) * k * 3.5;
      emit(S, 'butted', { id: c.id });
      d.scaredT = 1.5;
    }
  }
  while (c.barks.length && S.t - c.barks[0] > 6) c.barks.shift();
  const onRoad = surfAt(S.W, c.x, c.z) === SURF.ROAD;
  if (c.barks.length >= A.cowIgnoreBarks || c.shooed) {
    const byDog = !c.shooed; // or a vendor guarding his vegetables, or a driver held up
    const from = c.shooed || d;
    c.barks.length = 0;
    c.shooed = null;
    const ax = c.x - from.x, az = c.z - from.z, l = Math.hypot(ax, az) || 1;
    // somewhere away from the nuisance: straight away if there is room, else
    // nearer, or off at an angle (a cow in a road walks to the kerb, not into a wall)
    const t = getaway(S, c, Math.atan2(ax / l, az / l), onRoad);
    if (t) {
      c.target = t; c.state = 'walk'; c.timer = 20; c.fast = true;
      emit(S, 'cowMoved', { id: c.id, fromRoad: onRoad && surfAt(S.W, t.x, t.z) !== SURF.ROAD, byDog });
      if (S.rng() < 0.5) { emit(S, 'moo', { x: c.x, z: c.z }); }
    }
  }
  if (c.mooCD <= 0) {
    c.mooCD = rand(S.rng, 25, 70);
    if (dd < 30 * 30) emit(S, 'moo', { x: c.x, z: c.z });
  }
  switch (c.state) {
    case 'walk': {
      if (!c.target) { c.state = 'graze'; break; }
      const dx = c.target.x - c.x, dz = c.target.z - c.z, l = Math.hypot(dx, dz);
      const sp = (c.fast ? 1.6 : 1) * A.cowSpeed;
      if (l < 0.4 || c.timer <= 0) { c.state = 'graze'; c.timer = rand(S.rng, 8, 25); c.speed = 0; c.fast = false; break; }
      c.yaw = approachAngle(c.yaw, Math.atan2(dx, dz), 1.2 * dt);
      // only walk where it is facing; a cow turns before it goes
      if (Math.abs(angleDiff(c.yaw, Math.atan2(dx, dz))) < 0.5) {
        const nx = c.x + Math.sin(c.yaw) * sp * dt, nz = c.z + Math.cos(c.yaw) * sp * dt;
        if (openGround(S.W, nx, nz) && !bodyBlocked(S, c, nx, nz)) { c.x = nx; c.z = nz; c.speed = sp; }
        else { c.speed = 0; c.target = null; }
      } else c.speed = 0;
      break;
    }
    case 'lie':
      c.speed = 0;
      if (c.timer <= 0) { c.state = 'stand'; c.timer = rand(S.rng, 4, 10); }
      break;
    default:
      c.speed = 0;
      if (c.timer <= 0) {
        const roll = S.rng();
        if (roll < (c.lazy ? 0.6 : 0.22)) { c.state = 'lie'; c.timer = rand(S.rng, 40, 140) * (c.lazy ? 2 : 1); }
        // only the lazy one lives in the road; the rest cross it but graze beside it
        else if (roll < 0.75) { c.target = pickTarget(S, c, c.r, !c.lazy); c.state = c.target ? 'walk' : 'graze'; c.timer = 30; }
        else { c.state = c.state === 'graze' ? 'stand' : 'graze'; c.timer = rand(S.rng, 6, 20); }
      }
  }
  c.pose = c.state === 'lie' ? 'lie' : c.state === 'graze' ? 'graze' : 'stand';
  c.look *= Math.exp(-dt * 0.6);
  c.y = baseHeightAt(S.W, c.x, c.z) === 0.45 ? 0 : baseHeightAt(S.W, c.x, c.z);
}

/**
 * Where a cow goes when it has had enough: away from the nuisance, a little off
 * the line either way. One standing in the road makes for a kerb, the nearest one
 * in any direction but back past whoever moved it, before it settles for merely
 * shuffling along the road.
 */
function getaway(S, c, away, onRoad) {
  const open = (tx, tz) => openGround(S.W, tx, tz) && lineOpen(S.W, c.x, c.z, tx, tz);
  const offRoad = (tx, tz) => surfAt(S.W, tx, tz) !== SURF.ROAD;
  for (const len of [7, 5, 3.5]) {
    for (const off of [0, 0.35, -0.35, 0.7, -0.7]) {
      const a = away + off + (S.rng() - 0.5) * 0.3;
      const tx = c.x + Math.sin(a) * len, tz = c.z + Math.cos(a) * len;
      if (open(tx, tz) && (!onRoad || offRoad(tx, tz))) return { x: tx, z: tz };
    }
  }
  if (onRoad) {
    let best = null, bestLen = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = away + (k / 16) * Math.PI * 2;
      if (Math.cos(a - away) < -0.3) continue;
      for (const len of [3, 4.5, 6, 8]) {
        if (len >= bestLen) break;
        const tx = c.x + Math.sin(a) * len, tz = c.z + Math.cos(a) * len;
        if (open(tx, tz) && offRoad(tx, tz)) { best = { x: tx, z: tz }; bestLen = len; break; }
      }
    }
    if (best) return best;
  }
  for (let k = 0; k < 8; k++) {
    const a = away + (S.rng() - 0.5) * 2.4, len = 2.5 + S.rng() * 2;
    const tx = c.x + Math.sin(a) * len, tz = c.z + Math.cos(a) * len;
    if (open(tx, tz)) return { x: tx, z: tz };
  }
  return null;
}

/** Do vehicles or people stand where a cow wants to step? Cows wait rather than walk through. */
function bodyBlocked(S, c, nx, nz) {
  S.grid.query(nx, nz, 2.5, nearList);
  for (const e of nearList) {
    if (e.ref === c || e.kind === 'ped' || e.kind === 'npcdog' || e.kind === 'dog') continue;
    if (dist2(e.x, e.z, nx, nz) < (e.r + 0.9) * (e.r + 0.9)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------- goats */

function goat(S, g, dt) {
  const d = S.dog;
  const A = S.C.animals;
  g.timer -= dt;
  const dd = Math.sqrt(dist2(g.x, g.z, d.x, d.z));
  if (dd < 3.2 && d.speed > 2) {
    // run!
    const ax = g.x - d.x, az = g.z - d.z;
    const yaw = Math.atan2(ax, az) + (S.rng() - 0.5) * 0.6;
    g.yaw = approachAngle(g.yaw, yaw, 8 * dt);
    const nx = g.x + Math.sin(g.yaw) * A.goatFleeSpeed * dt, nz = g.z + Math.cos(g.yaw) * A.goatFleeSpeed * dt;
    if (openGround(S.W, nx, nz) && dist2(nx, nz, g.home.x, g.home.z) < 22 * 22) { g.x = nx; g.z = nz; g.speed = A.goatFleeSpeed; }
    else { g.yaw += 1.5 * dt; g.speed = 0; }
    if (!g.fleeing) { g.fleeing = true; emit(S, 'goatChased', { id: g.id }); if (S.rng() < 0.5) emit(S, 'bleat', { x: g.x, z: g.z }); }
    g.state = 'run';
    g.timer = 2;
    return;
  }
  g.fleeing = false;
  if (g.state === 'run' && g.timer > 0) { g.speed = 0; return; }
  if (g.state === 'walk' && g.target) {
    const dx = g.target.x - g.x, dz = g.target.z - g.z, l = Math.hypot(dx, dz);
    if (l < 0.3 || g.timer <= 0) { g.state = 'graze'; g.timer = rand(S.rng, 4, 14); g.speed = 0; return; }
    g.yaw = approachAngle(g.yaw, Math.atan2(dx, dz), 3 * dt);
    g.x += Math.sin(g.yaw) * 0.6 * dt; g.z += Math.cos(g.yaw) * 0.6 * dt; g.speed = 0.6;
    return;
  }
  g.speed = 0;
  if (g.timer <= 0) {
    g.target = pickTarget(S, g, g.r);
    g.state = g.target ? 'walk' : 'graze';
    g.timer = g.target ? 12 : rand(S.rng, 4, 10);
  }
  g.pose = g.state === 'graze' ? 'graze' : 'stand';
}

/* -------------------------------------------------------------------- birds */

function birds(S, dt) {
  const d = S.dog;
  const A = S.C.animals;
  const barked = d.barkedAt === S.t;
  for (const f of S.flocks) {
    f.cd -= dt;
    const dd = Math.sqrt(dist2(f.x, f.z, d.x, d.z));
    let scare = false;
    if (f.cd <= 0) {
      if (barked && dd < S.C.dog.barkRadius + 1.5) scare = true;
      // a fast dog anywhere near a bird on the ground
      if (!scare && d.speed > 2.3) {
        for (const b of S.birds) {
          if (b.flock === f && b.state === 'ground' && dist2(b.x, b.z, d.x, d.z) < A.birdScatterDist * A.birdScatterDist) { scare = true; break; }
        }
      }
      if (!scare) {
        for (const v of S.vehicles) {
          if (v.v > 3 && dist2(v.x, v.z, f.x, f.z) < 3.5 * 3.5) { scare = true; break; }
        }
      }
    }
    if (scare) {
      let n = 0;
      for (const b of S.birds) {
        if (b.flock !== f || b.state !== 'ground') continue;
        n++;
        const p = f.perches.length ? pick(S.rng, f.perches) : { x: f.x + rand(S.rng, -15, 15), y: 9, z: f.z + rand(S.rng, -15, 15) };
        b.state = 'fly';
        b.delay = S.rng() * 0.35;
        b.target = { x: p.x + rand(S.rng, -1.2, 1.2), y: p.y, z: p.z + rand(S.rng, -1.2, 1.2) };
        b.t = 0;
      }
      if (n > 0) {
        f.cd = 4;
        emit(S, 'scatter', { flock: f.id, kind: f.kind, n, x: f.x, z: f.z, byDog: true });
      }
    }
  }
  for (const b of S.birds) {
    b.t += dt;
    const f = b.flock;
    switch (b.state) {
      case 'ground': {
        b.flying = false;
        b.pecking = Math.sin(b.t * 0.7 + b.id) > 0;
        if (!b.target || b.t > 3) {
          const a = S.rng() * Math.PI * 2, r = S.rng() * 2;
          b.target = { x: f.x + Math.cos(a) * r, z: f.z + Math.sin(a) * r };
          b.t = 0;
        }
        const dx = b.target.x - b.x, dz = b.target.z - b.z, l = Math.hypot(dx, dz);
        if (l > 0.1) {
          b.yaw = approachAngle(b.yaw, Math.atan2(dx, dz), 6 * dt);
          b.x += (dx / l) * 0.35 * dt; b.z += (dz / l) * 0.35 * dt; b.speed = 0.35;
        } else b.speed = 0;
        b.y = f.island ? 0.45 : baseHeightAt(S.W, b.x, b.z);
        break;
      }
      case 'fly':
      case 'return': {
        if (b.delay > 0) { b.delay -= dt; break; }
        b.flying = true;
        const T = b.target;
        const dx = T.x - b.x, dy = T.y - b.y, dz = T.z - b.z;
        const l = Math.hypot(dx, dy, dz);
        const sp = A.birdFlySpeed * (b.state === 'return' ? 0.8 : 1);
        if (l < 0.25) {
          b.x = T.x; b.y = T.y; b.z = T.z;
          if (b.state === 'fly') { b.state = 'perch'; b.t = 0; b.wait = rand(S.rng, A.birdReturn[0], A.birdReturn[1]); }
          else { b.state = 'ground'; b.t = 0; b.target = null; }
          b.flying = false;
          break;
        }
        // climb steeply at first, glide in at the end
        const climb = b.state === 'fly' && b.t < 0.6 ? 3.5 : 0;
        b.x += (dx / l) * sp * dt;
        b.z += (dz / l) * sp * dt;
        b.y += ((dy / l) * sp + climb) * dt;
        b.yaw = approachAngle(b.yaw, Math.atan2(dx, dz), 8 * dt);
        b.glide = l < 4 && b.state === 'return';
        b.speed = sp;
        break;
      }
      case 'perch':
        b.flying = false;
        b.pecking = false;
        b.speed = 0;
        if (b.t > b.wait) {
          const a = S.rng() * Math.PI * 2, r = S.rng() * 1.8;
          b.state = 'return';
          b.target = { x: f.x + Math.cos(a) * r, y: f.island ? 0.45 : baseHeightAt(S.W, f.x, f.z), z: f.z + Math.sin(a) * r };
          b.t = 0;
          b.delay = S.rng() * 2;
        }
        break;
      default:
    }
  }
}

/* --------------------------------------------------------------------- dogs */

function friendship(S, d) { return S.friendship[d.puppy ? d.mother.key : d.key] || 0; }
function addFriendship(S, d, n) {
  const key = d.puppy ? d.mother.key : d.key;
  const before = S.friendship[key] || 0;
  const after = clamp(before + n, 0, 100);
  S.friendship[key] = after;
  if (before < S.C.animals.friendAt && after >= S.C.animals.friendAt) {
    emit(S, 'friend', { key, name: d.puppy ? d.mother.name : d.name });
  }
}

const DOG_TURNS = [0, 0.5, -0.5, 1.0, -1.0, 1.57, -1.57];

/** Trot toward (tx, tz): straight if the way is open, else the open heading that goes most toward it. */
function moveDogTo(S, d, tx, tz, speed, dt) {
  const dx = tx - d.x, dz = tz - d.z, l = Math.hypot(dx, dz);
  if (l < 0.05) { d.speed = 0; return true; }
  const step = Math.min(l, speed * dt);
  const ux = dx / l, uz = dz / l;
  // Go round an obstacle on one side. Picking the better side afresh every step
  // flips as the dog draws level with its goal, and it dithers against the corner.
  d.detourT = (d.detourT || 0) - dt;
  const side = d.detourT > 0 ? d.detour : 1;
  for (const turn of DOG_TURNS) {
    const da = turn * side;
    const c = Math.cos(da), s = Math.sin(da);
    const hx = ux * c + uz * s, hz = uz * c - ux * s;
    if (!openGround(S.W, d.x + hx * step, d.z + hz * step)) continue;
    if (da !== 0) { d.detour = Math.sign(da); d.detourT = 1.0; }
    d.x += hx * step; d.z += hz * step;
    d.yaw = approachAngle(d.yaw, Math.atan2(hx, hz), 8 * dt);
    d.speed = speed * (da === 0 ? 1 : 0.8);
    return l < 0.4;
  }
  d.speed = 0;
  d.yaw = approachAngle(d.yaw, Math.atan2(dx, dz), 8 * dt);
  return l < 0.4;
}

function npcBark(S, d) {
  if (d.barkCD > 0) return;
  d.barkT = 0.35;
  d.barkCD = rand(S.rng, 0.6, 1.4);
  emit(S, 'npcBark', { x: d.x, z: d.z, key: d.key, puppy: !!d.puppy });
}

function npcDog(S, d, dt) {
  const P = S.dog;
  const A = S.C.animals;
  d.timer -= dt; d.barkT -= dt; d.barkCD -= dt; d.nipCD -= dt; d.greetCD -= dt;
  const fr = friendship(S, d);
  const dist = Math.sqrt(dist2(d.x, d.z, P.x, P.z));
  const homeD = Math.sqrt(dist2(d.x, d.z, d.home.x, d.home.z));
  const playerHomeD = Math.sqrt(dist2(P.x, P.z, d.home.x, d.home.z));
  d.happy = false; d.scared = false;
  d.lookYaw = 0;

  // calm company builds trust
  if (dist < 4 && P.speed < 2 && !d.puppy && fr < A.calmCap && P.barkedAt !== S.t) addFriendship(S, d, A.friendCalm * dt);

  // food on the ground nearby is fair game
  if (d.state !== 'chase' && d.state !== 'eat') {
    for (const it of S.items) {
      if (it.state !== 'ground' || !isFood(it) || S.t - (it.landT || 0) < 0.5) continue;
      if (dist2(it.x, it.z, d.x, d.z) < 7 * 7 && (it.forDog === d.key || dist2(it.x, it.z, P.x, P.z) > 1.5 * 1.5)) {
        d.state = 'eatGo'; d.target = it; d.timer = 8;
        break;
      }
    }
  }

  // puppies stick close to their mother unless someone brings food
  if (d.puppy && d.state !== 'eatGo' && d.state !== 'eat') {
    const m = d.mother;
    const md = Math.sqrt(dist2(d.x, d.z, m.x, m.z));
    if (md > 1.6) moveDogTo(S, d, m.x + Math.sin(d.id) * 0.8, m.z + Math.cos(d.id) * 0.8, md > 4 ? 3 : 1.4, dt);
    else d.speed = 0;
    d.pose = m.pose === 'lie' && md < 1.6 ? 'lie' : 'move';
    d.happy = dist < 3 && fr > 20;
    if (dist < 3) d.lookYaw = clamp(angleDiff(d.yaw, Math.atan2(P.x - d.x, P.z - d.z)), -0.9, 0.9);
    return;
  }

  switch (d.state) {
    case 'eatGo': {
      const it = d.target;
      if (!it || it.gone || it.state !== 'ground' || d.timer <= 0) { d.state = 'patrol'; d.target = null; break; }
      if (moveDogTo(S, d, it.x, it.z, 3.2, dt)) { d.state = 'eat'; d.timer = 1.6; }
      d.pose = 'move';
      return;
    }
    case 'eat': {
      d.pose = 'eat'; d.speed = 0;
      if (d.timer <= 0) {
        const it = d.target;
        if (it && !it.gone) {
          removeItem(S, it);
          if (it.forDog === d.key || it.byPlayer) {
            addFriendship(S, d, A.friendFood);
            emit(S, 'sharedFood', { key: d.key, name: d.name, puppy: !!d.puppy });
          } else emit(S, 'npcAte', { key: d.key });
        }
        d.state = 'rest'; d.timer = rand(S.rng, 5, 15); d.target = null;
      }
      return;
    }
    default:
  }

  const friend = fr >= A.friendAt;
  const intruder = !friend && fr < 30 && playerHomeD < A.dogTerritory + 1 && !d.puppy;

  if (intruder && d.state !== 'chase' && dist < A.dogGrowlDist && S.clock.hours > 6) {
    if (d.state !== 'alert') { d.state = 'alert'; d.timer = 3.2; say(S, d, SPEECH.dogGrowl, { h: 1.0 }); emit(S, 'growl', { x: d.x, z: d.z, key: d.key }); }
  }
  switch (d.state) {
    case 'alert': {
      d.pose = 'move'; d.speed = 0;
      d.yaw = approachAngle(d.yaw, Math.atan2(P.x - d.x, P.z - d.z), 5 * dt);
      d.scared = false;
      if (dist < A.dogChaseDist || P.barkedAt === S.t) npcBark(S, d);
      if (!intruder || dist > A.dogGrowlDist + 2) { d.state = 'rest'; d.timer = 4; break; }
      if (d.timer <= 0 && dist < A.dogChaseDist + 1) { d.state = 'chase'; d.chaseT = 6; }
      break;
    }
    case 'chase': {
      d.chaseT -= dt;
      d.pose = 'move';
      if (S.rng() < dt * 3) npcBark(S, d);
      moveDogTo(S, d, P.x, P.z, A.dogChaseSpeed, dt);
      if (dist < 0.75 && d.nipCD <= 0 && P.invuln <= 0) {
        d.nipCD = 2.5;
        P.needs.health -= A.dogNipDamage;
        P.needs.mood -= 6;
        P.scaredT = 2.5;
        emit(S, 'nipped', { key: d.key, name: d.name });
      }
      if (d.chaseT <= 0 || playerHomeD > A.dogTerritory + 6 || homeD > A.dogTerritory + 8) { d.state = 'return'; }
      break;
    }
    case 'return':
      d.pose = 'move';
      if (moveDogTo(S, d, d.home.x, d.home.z, 2.2, dt)) { d.state = 'rest'; d.timer = rand(S.rng, 6, 20); }
      break;
    case 'follow': {
      d.pose = 'move';
      d.happy = true;
      d.followT -= dt;
      const want = 1.6;
      if (dist > want) {
        const behind = Math.atan2(P.x - d.x, P.z - d.z);
        moveDogTo(S, d, P.x - Math.sin(behind) * 1.2 + Math.sin(d.id) * 0.6, P.z - Math.cos(behind) * 1.2 + Math.cos(d.id) * 0.6, Math.min(P.speed + 1.5, 7), dt);
      } else { d.speed = 0; if (P.sitting || P.lying) d.pose = P.lying ? 'lie' : 'sit'; }
      if (P.barkedAt === S.t && S.rng() < 0.7) npcBark(S, d);
      if (d.followT <= 0 || dist > 30) { d.state = 'return'; }
      break;
    }
    case 'patrol': {
      d.pose = 'move';
      if (!d.target || moveDogTo(S, d, d.target.x, d.target.z, 1.3, dt)) {
        d.state = 'rest'; d.timer = rand(S.rng, 10, 40);
      }
      break;
    }
    default: { // rest
      d.speed = 0;
      const h = S.clock.hours;
      const siesta = h > 12.5 && h < 15.5;
      d.pose = siesta || (h > 22 || h < 5.5) ? 'sleep' : 'lie';
      if (homeD > 1.5) { d.pose = 'move'; moveDogTo(S, d, d.home.x, d.home.z, 1.4, dt); }
      if (friend && dist < 4) {
        d.happy = true;
        d.pose = 'sit';
        d.lookYaw = clamp(angleDiff(d.yaw, Math.atan2(P.x - d.x, P.z - d.z)), -0.9, 0.9);
        if (P.speed > 1.2 && dist < 3) { d.state = 'follow'; d.followT = 45; }
      } else if (dist < 6 && fr >= 30) {
        d.happy = true;
        d.lookYaw = clamp(angleDiff(d.yaw, Math.atan2(P.x - d.x, P.z - d.z)), -0.9, 0.9);
      }
      if (d.timer <= 0 && !siesta) {
        const a = S.rng() * Math.PI * 2, r = 2 + S.rng() * (A.dogTerritory - 2);
        const tx = d.home.x + Math.cos(a) * r, tz = d.home.z + Math.sin(a) * r;
        if (openGround(S.W, tx, tz)) { d.target = { x: tx, z: tz }; d.state = 'patrol'; }
        d.timer = rand(S.rng, 15, 40);
      }
      // night watch: bark at passing traffic now and then
      if ((h > 21 || h < 5) && S.rng() < dt * 0.05) npcBark(S, d);
    }
  }
  d.y = baseHeightAt(S.W, d.x, d.z) === 0.45 ? 0 : baseHeightAt(S.W, d.x, d.z);
}

/** The player's dog play-bows at d. */
export function greet(S, d) {
  const A = S.C.animals;
  if (d.greetCD > 0) return false;
  d.greetCD = 15;
  const fr = friendship(S, d);
  if (d.state === 'chase' && fr < 20) return false;
  addFriendship(S, d, A.friendGreet);
  d.state = 'rest';
  d.timer = 6;
  d.yaw = Math.atan2(S.dog.x - d.x, S.dog.z - d.z);
  emit(S, 'greeted', { key: d.key, name: d.puppy ? 'a puppy' : d.name, friendship: friendship(S, d) });
  if (friendship(S, d) >= A.friendAt) { d.state = 'follow'; d.followT = 60; }
  return true;
}

/** Nearest NPC dog to a point. */
export function npcDogNear(S, x, z, r) {
  let best = null, bd = r * r;
  for (const d of S.dogs) {
    const q = dist2(d.x, d.z, x, z);
    if (q < bd) { bd = q; best = d; }
  }
  return best;
}
