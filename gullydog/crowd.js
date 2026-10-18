/*
 * crowd.js — the people.
 *
 * WALKERS pick somewhere to go (a shop, a stall, a bench, the temple, the bus
 * stop, or home through the edge of the map), walk the pedestrian graph to it
 * with their own lateral lane so a sidewalk fills sideways rather than single
 * file, wait at the kerb for a gap before crossing, then linger and move on.
 * VENDORS and SHOPKEEPERS stay put and call out.
 *
 * Everyone has a disposition toward street dogs, and that is most of the game:
 * sit nicely near a kind person and you get petted (sometimes fed); a grumpy one
 * shoos you; a bark startles everybody; barrelling into someone carrying a snack
 * makes them drop it.
 */

import { pedPath, nearestPedNode, pedWalkable, clearLine, baseHeightAt, facadePoint } from './world.js';
import { pick, pickWeighted, rand, clamp, lerp, dist2, wrapAngle, approachAngle, hex, angleDiff } from './util.js';
import { emit, say, spawnItem, tossToDog, groundAt } from './simcore.js';
import { SPEECH, SKIN_TONES, HAIR_COLORS, CLOTHES, SHOP_TYPES } from './data.js';

const nearList = [];

/* ------------------------------------------------------------------ people */

export function makePerson(S, opts = {}) {
  const rng = S.rng;
  const kid = opts.kid !== undefined ? opts.kid : rng() < 0.12;
  const female = opts.female !== undefined ? opts.female : rng() < 0.42;
  let kind = opts.kind;
  if (!kind) {
    if (kid) kind = female ? 'girl' : 'kid';
    else if (female) kind = pick(rng, ['saree', 'saree', 'salwar', 'salwar', 'saree']);
    else kind = pickWeighted(rng, [[24, 'man'], [16, 'manMustache'], [14, 'kurta'], [8, 'lungi'], [7, 'turban'], [9, 'cap'], [5, 'elder']]);
  }
  const skin = hex(pick(rng, SKIN_TONES));
  let top, bottom, hair = hex(pick(rng, HAIR_COLORS.slice(0, 5)));
  switch (kind) {
    case 'saree': top = hex(pick(rng, CLOTHES.saree)); bottom = hex(pick(rng, CLOTHES.saree2)); break;
    case 'salwar': top = hex(pick(rng, CLOTHES.saree)); bottom = hex(pick(rng, CLOTHES.dupatta)); break;
    case 'kurta': top = hex(pick(rng, CLOTHES.kurta)); bottom = hex(pick(rng, ['#f8f4e3', '#fffdf5', '#e9d8a6', '#d6ccc2'])); break;
    case 'turban': top = hex(pick(rng, CLOTHES.kurta)); bottom = hex(pick(rng, ['#f8f4e3', '#2b3a55'])); hair = hex(pick(rng, CLOTHES.turban)); break;
    case 'lungi': top = hex(pick(rng, CLOTHES.shirt)); bottom = hex(pick(rng, ['#f8f4e3', '#3e7cb1', '#2f6d3a', '#7a1f1f'])); break;
    case 'elder': top = hex(pick(rng, ['#f8f4e3', '#fffdf5', '#e9d8a6'])); bottom = hex(pick(rng, ['#f8f4e3', '#d6ccc2'])); hair = hex(pick(rng, ['#d8d8d8', '#bdbdbd', '#a34a28'])); break;
    case 'kid': case 'girl': case 'batter': top = hex(pick(rng, CLOTHES.kid)); bottom = hex(pick(rng, ['#1d3557', '#2b3a55', '#5a4632', '#c62828', '#1565c0'])); break;
    case 'cap': top = hex(pick(rng, CLOTHES.shirt)); bottom = hex(pick(rng, CLOTHES.pants)); hair = hex(pick(rng, ['#1d3557', '#e63946', '#f1faee', '#2a9d8f', '#111111'])); break;
    default: top = hex(pick(rng, CLOTHES.shirt)); bottom = hex(pick(rng, CLOTHES.pants));
  }
  if (opts.uniform === 'khaki') { top = hex(CLOTHES.khaki[0]); bottom = hex(CLOTHES.khaki[1]); }
  if (opts.uniform === 'saffron') { top = hex(CLOTHES.saffron[0]); bottom = hex(CLOTHES.saffron[1]); }
  const scale = kid ? rand(rng, 0.6, 0.72) : rand(rng, 0.93, 1.07) * (female ? 0.95 : 1);
  return {
    id: S.nextId++, role: opts.role || 'walker', kind, colors: [skin, top, bottom, hair], scale, kid,
    h: 1.75 * scale + 0.25,
    x: opts.x || 0, z: opts.z || 0, y: 0, yaw: opts.yaw || 0, vx: 0, vz: 0, speed: 0,
    walkSpeed: kid ? rand(rng, 1.2, 1.7) : kind === 'elder' ? rand(rng, 0.6, 0.85) : rand(rng, S.C.crowd.walkSpeed[0], S.C.crowd.walkSpeed[1]),
    state: 'idle', timer: 0, path: null, pi: 0, lane: rand(rng, -0.85, 0.85), dest: null, plan: 'dest', node: -1,
    disp: kid ? 'kind' : pickWeighted(rng, S.C.crowd.disposition),
    snack: null, petCD: 0, mode: 'walk', look: 0, react: 0, reactT: 0, startleT: 0,
    talkTo: null, waitT: 0, bubbleCD: rand(rng, 4, 14), stuckT: 0, gone: false,
  };
}

function population(S) {
  const P = S.C.crowd.population;
  const h = S.clock.hours;
  for (let i = 0; i + 1 < P.length; i++) {
    if (h >= P[i][0] && h <= P[i + 1][0]) return Math.round(lerp(P[i][1], P[i + 1][1], (h - P[i][0]) / (P[i + 1][0] - P[i][0])));
  }
  return P[0][1];
}

export function init(S) {
  S.peds = [];
  S.destBusy = new Map();
  const G = S.W.peds;
  // vendors behind every stall and cart
  for (const st of S.W.stalls) {
    if (st.kind === 'chai') continue; // the chai wallah is a scene character
    const p = makePerson(S, { role: 'vendor', kid: false, female: st.kind === 'flower' ? S.rng() < 0.6 : S.rng() < 0.2, x: st.vendor.x, z: st.vendor.z, yaw: st.vendor.yaw });
    p.stall = st;
    p.state = 'vendor';
    p.mode = st.type === 'stall' && st.kind !== 'flower' ? 'squat' : 'stand';
    p.disp = S.rng() < 0.5 ? 'grumpy' : 'neutral';
    p.callKind = st.kind === 'banana' || st.kind === 'coconut' ? 'fruit' : st.kind;
    S.peds.push(p);
  }
  // shopkeepers stand behind their counters
  for (const b of S.W.buildings) {
    if (!b.shop || b.kind !== 'front') continue;
    const f = facadePoint(b, 0.5);
    if (Math.abs(f.x) > 88 || Math.abs(f.z) > 88) continue;
    const T = SHOP_TYPES[b.shop.type];
    const p = makePerson(S, { role: 'keeper', kid: false, female: b.shop.type === 'bangles' || b.shop.type === 'saree' ? S.rng() < 0.4 : S.rng() < 0.12, x: f.x - f.nx * 1.35, z: f.z - f.nz * 1.35, yaw: Math.atan2(f.nx, f.nz) });
    p.shop = b;
    p.state = 'vendor';
    p.mode = 'stand';
    p.food = T.food === 'beg';
    p.disp = p.food ? pick(S.rng, ['kind', 'kind', 'neutral', 'grumpy']) : pick(S.rng, ['neutral', 'neutral', 'grumpy', 'kind']);
    p.door = { x: f.x + f.nx * 1.1, z: f.z + f.nz * 1.1 };
    p.y = 0.22;
    S.peds.push(p);
  }
  const n = population(S);
  for (let i = 0; i < n; i++) spawnWalker(S, true);
  S.crowdSpawnT = 0;
}

function walkerCount(S) {
  let n = 0;
  for (const p of S.peds) if (p.role === 'walker') n++;
  return n;
}

function spawnWalker(S, anywhere) {
  const G = S.W.peds;
  const d = S.dog;
  let node = -1;
  if (anywhere || S.rng() < 0.5) {
    for (let tries = 0; tries < 12; tries++) {
      const cand = pick(S.rng, G.walkNodes);
      const nd = G.nodes[cand];
      if (!anywhere && dist2(nd.x, nd.z, d.x, d.z) < 26 * 26) continue;
      node = cand;
      break;
    }
  }
  if (node < 0) node = pick(S.rng, G.portals);
  const nd = G.nodes[node];
  let x = nd.x + rand(S.rng, -0.4, 0.4), z = nd.z + rand(S.rng, -0.4, 0.4);
  if (!pedWalkable(S.W, x, z)) { x = nd.x; z = nd.z; } // portals sit at the very end of the pavement
  const p = makePerson(S, { x, z });
  p.node = node;
  p.y = baseHeightAt(S.W, p.x, p.z);
  if (p.disp === 'kind' && S.rng() < S.C.crowd.snackChance) p.snack = pick(S.rng, ['biscuit', 'roti', 'samosa', 'jalebi']);
  S.peds.push(p);
  planNext(S, p);
  // spread the initial crowd along its first legs so it does not start in clumps:
  // start them AT a node partway along, not merely aiming at one far ahead
  if (anywhere && p.path && p.path.length > 2) {
    const k = Math.min(p.path.length - 1, 1 + Math.floor(S.rng() * (p.path.length - 1)));
    const at = G.nodes[p.path[k - 1]];
    p.x = at.x; p.z = at.z; p.node = p.path[k - 1]; p.pi = k;
    p.y = baseHeightAt(S.W, p.x, p.z);
    const kind = edgeKind(G, p.path[k - 1], p.path[k]);
    if (kind === 'zebra' || kind === 'jay') { p.state = 'curb'; p.waitT = 0; p.crossKind = kind; }
  }
  return p;
}

/* ------------------------------------------------------------------- plans */

// How many people are using a seat, stall or shop door. Kept in the sim, not on the
// world's own destination objects: the world is shared and must stay read-only.
const busyAt = (S, D) => S.destBusy.get(D) || 0;
function occupy(S, D, n) { S.destBusy.set(D, Math.max(0, busyAt(S, D) + n)); }

function destWeights(S) {
  const h = S.clock.hours;
  const aarti = h >= S.C.scenes.aarti[0] - 0.4 && h <= S.C.scenes.aarti[1];
  return [[46, 'shop'], [20, 'stall'], [9, 'seat'], [aarti ? 30 : 4, 'pray'], [1.5, 'pump'], [5, 'wait'], [3, 'feed'], [12, 'wander'], [9, 'leave']];
}

function planNext(S, p) {
  const G = S.W.peds;
  // get up off the bench first: seats are props, not pavement
  if (p.state === 'sit' && p.dest) { p.x = p.dest.x; p.z = p.dest.z; }
  if (p.dest) { occupy(S, p.dest, -1); p.dest = null; }
  let kind = pickWeighted(S.rng, destWeights(S));
  if (p.overflow) kind = 'leave';
  let goal = -1;
  if (kind === 'leave') {
    goal = pick(S.rng, G.portals);
    p.plan = 'leave';
  } else if (kind === 'wander') {
    goal = pick(S.rng, G.walkNodes);
    p.plan = 'wander';
  } else {
    // a free destination of that kind, preferring ones not too far away
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 10; k++) {
      const dd = pick(S.rng, G.dests);
      if (dd.kind !== kind || busyAt(S, dd) >= (dd.cap || 1)) continue;
      const dist = Math.sqrt(dist2(dd.x, dd.z, p.x, p.z));
      const score = -dist + S.rng() * 40;
      if (score > bestScore) { bestScore = score; best = dd; }
    }
    if (!best) { goal = pick(S.rng, G.walkNodes); p.plan = 'wander'; }
    else { goal = best.node; p.dest = best; occupy(S, best, 1); p.plan = 'dest'; }
  }
  const from = p.node >= 0 ? p.node : nearestPedNode(G, p.x, p.z);
  const path = pedPath(G, from, goal);
  if (!path) { p.path = null; p.state = 'idle'; p.timer = 2; return; }
  p.path = path;
  p.pi = 0;
  p.state = 'walk';
  p.mode = 'walk';
}

function edgeKind(G, a, b) {
  const e = G.nodes[a].edges.find((q) => q.to === b);
  return e ? e.kind : 'walk';
}

function arrive(S, p) {
  const C = S.C.crowd;
  if (p.plan === 'leave') { p.gone = true; return; }
  if (!p.dest) { p.state = 'idle'; p.timer = rand(S.rng, 1, 5); p.mode = 'stand'; return; }
  const D = p.dest;
  p.yawTarget = D.yaw;
  switch (D.kind) {
    case 'seat': {
      const s = D.seat;
      const slot = busyAt(S, D) > 1 ? 0.45 : -0.45;
      const ax = Math.cos(s.yaw), az = -Math.sin(s.yaw);
      p.x = s.x + ax * slot; p.z = s.z + az * slot;
      p.yaw = s.yaw;
      p.state = 'sit'; p.mode = 'sit'; p.timer = rand(S.rng, C.sitTime[0], C.sitTime[1]);
      break;
    }
    case 'pray': p.state = 'act'; p.mode = 'pray'; p.timer = rand(S.rng, 8, 20); break;
    case 'feed': p.state = 'act'; p.mode = 'feed'; p.timer = rand(S.rng, 6, 14); emit(S, 'grain', { x: p.x, z: p.z }); break;
    case 'wait': p.state = 'act'; p.mode = 'stand'; p.timer = rand(S.rng, 20, 60); p.waitBus = true; break;
    case 'pump': p.state = 'act'; p.mode = 'stand'; p.timer = rand(S.rng, 5, 9); emit(S, 'pump', { x: p.x, z: p.z }); break;
    default:
      p.state = 'act';
      p.mode = S.rng() < 0.4 ? 'talk' : 'stand';
      p.timer = rand(S.rng, C.browseTime[0], C.browseTime[1]);
      if (D.kind === 'stall' && S.rng() < 0.25 && !p.snack && p.disp !== 'grumpy') p.snack = pick(S.rng, ['roti', 'samosa', 'biscuit']);
  }
}

/* ------------------------------------------------------------------- update */

export function insertGrid(S) {
  for (const p of S.peds) {
    if (p.hidden) continue; // indoors (Aunty between meals, kids after dark)
    S.grid.insert('ped', p, p.x, p.z, S.C.crowd.radius * (p.kid ? 0.8 : 1));
  }
}

export function step(S, dt) {
  const C = S.C.crowd;
  const G = S.W.peds;
  // keep the street as busy as the hour says
  const target = population(S);
  const n = walkerCount(S);
  S.crowdSpawnT -= dt;
  if (n < target && S.crowdSpawnT <= 0) { spawnWalker(S, false); S.crowdSpawnT = 0.35; }
  if (n > target + 12 && S.rng() < dt * 0.5) {
    const far = S.peds.find((p) => p.role === 'walker' && p.plan !== 'leave' && p.state === 'walk' && dist2(p.x, p.z, S.dog.x, S.dog.z) > 35 * 35);
    if (far) { far.overflow = true; planNext(S, far); }
  }

  for (let i = S.peds.length - 1; i >= 0; i--) {
    const p = S.peds[i];
    if (p.gone) { if (p.dest) occupy(S, p.dest, -1); S.peds.splice(i, 1); continue; }
    if (p.startleT > 0) p.startleT -= dt;
    if (p.react > 0) {
      p.react -= dt;
      faceToward(p, S.dog.x, S.dog.z, dt, 6);
      if (p.react <= 0) endReaction(S, p);
      continue;
    }
    p.bubbleCD -= dt;
    switch (p.state) {
      case 'walk': walk(S, p, dt); break;
      case 'curb': curb(S, p, dt); break;
      case 'vendor': vendor(S, p, dt); break;
      case 'sit':
      case 'act':
      case 'idle':
        p.speed = 0; p.vx = 0; p.vz = 0;
        if (p.yawTarget !== undefined && p.state !== 'sit') p.yaw = approachAngle(p.yaw, p.yawTarget, 4 * dt);
        p.timer -= dt;
        if (p.waitBus && boardBus(S, p)) break;
        if (p.mode === 'talk' && p.bubbleCD <= 0 && near2(S, p, 22)) { say(S, p, SPEECH.chatter); p.bubbleCD = rand(S.rng, 6, 14); }
        if (p.timer <= 0) { p.waitBus = false; planNext(S, p); }
        break;
      case 'flee': flee(S, p, dt); break;
      default: break;
    }
    if (p.role === 'special') p.y = groundAt(S, p.x, p.z, p.y + 0.3);
    else if (p.role !== 'keeper' && p.state !== 'sit') p.y = baseHeightAt(S.W, p.x, p.z);
  }
  dogInteractions(S, dt);
}

const near2 = (S, p, r) => dist2(p.x, p.z, S.dog.x, S.dog.z) < r * r;

function faceToward(p, x, z, dt, rate) {
  p.yaw = approachAngle(p.yaw, Math.atan2(x - p.x, z - p.z), rate * dt);
}

function walk(S, p, dt) {
  const G = S.W.peds;
  if (!p.path) { planNext(S, p); return; }
  const idx = p.path[p.pi];
  const nd = G.nodes[idx];
  if (p.segPath !== p.path || p.segPi !== p.pi) laneTarget(S, p, p.pi > 0 ? p.path[p.pi - 1] : -1, idx);
  // a detour back through the last node, when the way ahead is blocked from here
  if (p.via && Math.hypot(p.via.x - p.x, p.via.z - p.z) < 0.3) { p.via = null; p.bestD = Infinity; }
  const tx = p.via ? p.via.x : p.segX, tz = p.via ? p.via.z : p.segZ;
  const dx = tx - p.x, dz = tz - p.z;
  const dist = Math.hypot(dx, dz);
  // Getting no closer for a few seconds (a wall in the way, a slide that goes
  // nowhere, a knot of people): find the way again from where they actually are.
  if (dist < p.bestD - 0.25) { p.bestD = dist; p.noProg = 0; }
  else if ((p.noProg += dt) > 5) { p.noProg = 0; repath(S, p); return; }
  if (p.via) { steer(S, p, dx / dist, dz / dist, p.walkSpeed, dt, false); return; }
  const crossingNow = p.crossing;
  if (dist < (crossingNow ? 0.5 : 0.85)) {
    p.node = idx;
    p.stuckN = 0;
    p.crossing = false;
    if (p.pi >= p.path.length - 1) {
      // final approach: step onto the exact destination point
      arrive(S, p);
      return;
    }
    p.pi++;
    const kind = edgeKind(G, idx, p.path[p.pi]);
    if (kind === 'zebra' || kind === 'jay') { p.state = 'curb'; p.waitT = 0; p.crossKind = kind; }
    return;
  }
  steer(S, p, dx / dist, dz / dist, p.walkSpeed * (crossingNow ? 1.3 : 1), dt, crossingNow);
}

/**
 * Where along this stretch to aim: the node, shifted sideways by the walker's lane
 * so a crowd spreads across the pavement. The lane is only a preference, and the
 * pavement's nominal width knows nothing of the parked bikes and carts along its
 * kerb, so the shifted line is checked once per stretch and pulled back toward the
 * middle until it is clear.
 */
function laneTarget(S, p, from, to) {
  const G = S.W.peds;
  const nd = G.nodes[to], prev = from >= 0 ? G.nodes[from] : null;
  p.segPath = p.path; p.segPi = p.pi;
  p.segX = nd.x; p.segZ = nd.z;
  p.bestD = Infinity; p.noProg = 0;
  p.via = null;
  if (!prev || edgeKind(G, from, to) !== 'walk') return; // crossings go straight across
  if (nd.kind !== 'dest' && nd.kind !== 'portal') {
    const sx = nd.x - prev.x, sz = nd.z - prev.z;
    const l = Math.hypot(sx, sz) || 1;
    const w = Math.min(nd.w, prev.w);
    for (const k of [1, 0.5, 0.2]) {
      const lx = (-sz / l) * p.lane * w * k, lz = (sx / l) * p.lane * w * k;
      if (clearLine(S.W, prev.x + lx, prev.z + lz, nd.x + lx, nd.z + lz)) { p.segX = nd.x + lx; p.segZ = nd.z + lz; break; }
    }
  }
  // arriving off to one side of the last node can leave a parked cart between the
  // walker and the next stretch: back through the node itself in that case
  if (pedWalkable(S.W, p.x, p.z) && !clearLine(S.W, p.x, p.z, p.segX, p.segZ)) p.via = { x: prev.x, z: prev.z };
}

const TURNS = [0.5, -0.5, 1.0, -1.0, 1.57, -1.57]; // never more than square: that would be backing off

/** Desired heading plus separation from neighbours and room for the dog, then move. */
function steer(S, p, dirx, dirz, speed, dt, onRoad) {
  const C = S.C.crowd;
  let vx = dirx * speed, vz = dirz * speed;
  S.grid.query(p.x, p.z, 1.6, nearList);
  for (const e of nearList) {
    if (e.ref === p) continue;
    const ex = p.x - e.x, ez = p.z - e.z;
    const d2 = ex * ex + ez * ez;
    // someone standing still can be squeezed past; someone walking gets more room
    let room = e.kind === 'ped' ? (e.ref.speed < 0.2 ? 0.5 : 0.7) : e.kind === 'dog' ? C.personalSpace : e.kind === 'veh' ? e.r + 0.55 : e.kind === 'cow' ? e.r + 0.45 : e.r + 0.35;
    if (d2 > room * room || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const push = (room - d) / room;
    // push away, plus a sidestep so people flow round rather than stall
    const side = (ex * dirz - ez * dirx) >= 0 ? 1 : -1;
    vx += (ex / d) * push * C.separation + dirz * side * push * 0.9;
    vz += (ez / d) * push * C.separation - dirx * side * push * 0.9;
    // on the road, only a vehicle that is still moving makes a crosser hesitate
    if (e.kind === 'veh' && onRoad && e.ref.v > 1.5) { vx *= 0.35; vz *= 0.35; }
  }
  const sp = Math.hypot(vx, vz);
  const max = speed * 1.15;
  if (sp > max) { vx *= max / sp; vz *= max / sp; }
  const k = 1 - Math.exp(-7 * dt);
  p.vx += (vx - p.vx) * k;
  p.vz += (vz - p.vz) * k;
  let nx = p.x + p.vx * dt, nz = p.z + p.vz * dt;
  // Someone already off the pavement (the last stride of a crossing, shoved by the
  // dog, spawned past the end of a gali) walks straight back on: refusing every
  // step that is not yet on pavement would freeze them where they stand.
  if (!onRoad && !pedWalkable(S.W, nx, nz) && pedWalkable(S.W, p.x, p.z)) {
    // slide along whatever is in the way; if the slide goes nowhere (a cart parked
    // right up against the line they are walking), turn a little to get round it
    const len = Math.hypot(nx - p.x, nz - p.z);
    if (pedWalkable(S.W, nx, p.z) && Math.abs(nx - p.x) > len * 0.3) nz = p.z;
    else if (pedWalkable(S.W, p.x, nz) && Math.abs(nz - p.z) > len * 0.3) nx = p.x;
    else {
      // of the ways round that are open, the one that heads most toward the goal
      const a0 = Math.atan2(nx - p.x, nz - p.z);
      let best = -Infinity, bx = p.x, bz = p.z;
      for (const da of TURNS) {
        const sx = Math.sin(a0 + da), sz = Math.cos(a0 + da);
        const qx = p.x + sx * len, qz = p.z + sz * len;
        const score = sx * dirx + sz * dirz;
        if (score > best && pedWalkable(S.W, qx, qz)) { best = score; bx = qx; bz = qz; }
      }
      nx = bx; nz = bz;
    }
  }
  p.x = nx; p.z = nz;
  p.speed = Math.hypot(p.vx, p.vz);
  if (p.speed > 0.15) p.yaw = approachAngle(p.yaw, Math.atan2(p.vx, p.vz), 7 * dt);
  p.mode = 'walk';
  if (p.stuckT > 4) { p.stuckT = 0; repath(S, p); }
}

/**
 * Re-route to the same goal from the nearest node in plain sight. Someone who
 * keeps getting stuck gives up on the errand; out of the dog's sight they just
 * go home (the crowd refills itself elsewhere).
 */
function repath(S, p) {
  const G = S.W.peds;
  p.stuckN = (p.stuckN || 0) + 1;
  if (p.stuckN > 3) {
    p.stuckN = 0;
    if (dist2(p.x, p.z, S.dog.x, S.dog.z) > 30 * 30) { p.gone = true; return; }
    p.node = inSight(S, p.x, p.z);
    planNext(S, p);
    return;
  }
  const goal = p.path ? p.path[p.path.length - 1] : -1;
  const from = inSight(S, p.x, p.z);
  const path = goal >= 0 && from >= 0 ? pedPath(G, from, goal) : null;
  p.node = from;
  if (!path) { planNext(S, p); return; }
  p.path = path;
  p.pi = 0;
  p.crossing = false;
}

/** The nearest pedestrian node that can be walked to in a straight line from (x, z). */
function inSight(S, x, z) {
  const G = S.W.peds;
  const cand = [];
  for (let i = 0; i < G.nodes.length; i++) {
    const nd = G.nodes[i];
    if (!nd.ok) continue;
    const q = dist2(nd.x, nd.z, x, z);
    if (q < 15 * 15) cand.push([q, i]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  for (const [, i] of cand) {
    const nd = G.nodes[i];
    const l = Math.hypot(nd.x - x, nd.z - z);
    let open = true;
    // the first half metre is forgiven: they may be standing just off the pavement
    for (let t = 0.5; t < l && open; t += 0.25) open = pedWalkable(S.W, x + ((nd.x - x) * t) / l, z + ((nd.z - z) * t) / l);
    if (open) return i;
  }
  return nearestPedNode(G, x, z);
}

/** At the kerb: wait for a gap in the traffic, then go. */
function curb(S, p, dt) {
  const G = S.W.peds;
  const a = G.nodes[p.path[p.pi - 1]], b = G.nodes[p.path[p.pi]];
  p.speed = 0; p.vx *= 0.8; p.vz *= 0.8;
  faceToward(p, b.x, b.z, dt, 5);
  p.mode = 'stand';
  p.waitT += dt;
  const C = S.C.crowd;
  // any vehicle that would reach the crossing line within crossWait seconds?
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  let danger = false;
  const patience = p.crossKind === 'zebra' ? 1.0 : 0.6;
  for (const v of S.vehicles) {
    const rx = mx - v.x, rz = mz - v.z;
    const along = rx * v.dirx + rz * v.dirz;
    if (along < -v.len / 2 - 1 || along > 30) continue;
    const lateral = Math.abs(rx * v.dirz - rz * v.dirx);
    if (lateral > len / 2 + 1.5) continue;
    // a stopped or crawling vehicle is giving way; walk in front of it like everyone does
    if (v.v < 1.0) continue;
    const tta = along / v.v;
    if (tta < C.crossWait * patience * (p.waitT > 12 ? 0.5 : 1)) { danger = true; break; }
  }
  if (!danger) { p.state = 'walk'; p.crossing = true; }
  else if (p.waitT > 30) { p.state = 'walk'; p.pi = Math.max(0, p.pi - 1); planNext(S, p); }
}

function vendor(S, p, dt) {
  p.speed = 0;
  if (p.bubbleCD <= 0) {
    p.bubbleCD = rand(S.rng, 9, 22);
    if (p.role === 'vendor' && near2(S, p, 20)) {
      const lines = SPEECH.vendor[p.callKind] || SPEECH.vendor.veg;
      say(S, p, lines);
      emit(S, 'vendorCall', { x: p.x, z: p.z });
    } else if (p.role === 'keeper' && near2(S, p, 10) && S.rng() < 0.3) {
      say(S, p, SPEECH.chatter);
    }
  }
  // glance at the dog when it is close
  if (near2(S, p, 4)) p.look = clamp(angleDiff(p.yaw, Math.atan2(S.dog.x - p.x, S.dog.z - p.z)), -1, 1);
  else p.look *= 0.95;
  // cows nosing into the vegetables get shooed
  if (p.role === 'vendor' && !p.react) {
    for (const c of S.cows) {
      if (dist2(c.x, c.z, p.x, p.z) < 3.2 * 3.2 && c.state !== 'lie' && S.rng() < dt * 0.6) {
        p.react = 1.4; p.reactKind = 'shooCow'; p.mode = 'shoo';
        say(S, p, SPEECH.shoo);
        c.shooed = { x: p.x, z: p.z };
        break;
      }
    }
  }
}

function boardBus(S, p) {
  for (const v of S.vehicles) {
    if (v.type === 'bus' && v.stopped && v.stopWait > 1 && dist2(v.x, v.z, p.x, p.z) < 7 * 7) {
      p.state = 'walk';
      p.plan = 'leave';
      p.path = [p.node];
      p.pi = 0;
      p.gone = true; // climbs aboard
      emit(S, 'boarded', { x: p.x, z: p.z });
      return true;
    }
  }
  return false;
}

function flee(S, p, dt) {
  p.timer -= dt;
  const dx = p.x - S.dog.x, dz = p.z - S.dog.z;
  const d = Math.hypot(dx, dz) || 1;
  steer(S, p, dx / d, dz / d, p.walkSpeed * 2, dt, false);
  p.mode = 'run';
  if (p.timer <= 0) { p.node = nearestPedNode(S.W.peds, p.x, p.z); planNext(S, p); }
}

/* --------------------------------------------------------------- the dog */

function startReaction(S, p, kind, time, mode) {
  p.react = time;
  p.reactKind = kind;
  p.mode = mode;
  p.speed = 0; p.vx = 0; p.vz = 0;
}

function endReaction(S, p) {
  const kind = p.reactKind;
  p.reactKind = '';
  if (kind === 'pet' || kind === 'feed') {
    emit(S, 'petted', { by: p.id, kid: p.kid });
  }
  if (p.role === 'vendor' || p.role === 'keeper') { p.mode = p.role === 'vendor' && p.stall && p.stall.type === 'stall' && p.stall.kind !== 'flower' ? 'squat' : 'stand'; return; }
  if (p.state === 'walk' || p.state === 'curb') { p.mode = 'walk'; return; }
  if (p.state === 'sit') p.mode = 'sit';
  else if (p.state === 'act') p.mode = 'stand';
}

/** The dog sat nicely in front of this person long enough. What do they do? */
function respond(S, p) {
  const C = S.C.crowd;
  p.petCD = S.t + C.petCooldown;
  if (p.onBeg) { p.onBeg(S, p); return; }
  const d = S.dog;
  let disp = p.disp;
  if (disp === 'neutral') disp = S.rng() < 0.55 ? 'kind' : 'ignore';
  if (p.kid) disp = 'kind';
  switch (disp) {
    case 'kind': {
      const food = p.snack || (p.role === 'keeper' && p.food && S.rng() < 0.6 ? pick(S.rng, ['biscuit', 'roti', 'jalebi']) : null);
      if (food) {
        startReaction(S, p, 'feed', 2.4, 'feed');
        say(S, p, SPEECH.feed);
        tossToDog(S, food, p.x, p.y + 0.95 * p.scale, p.z, { owner: p.id, gift: true });
        p.snack = null;
        emit(S, 'fed', { by: p.id });
      } else {
        startReaction(S, p, 'pet', 2.6, 'pet');
        say(S, p, SPEECH.pet);
      }
      break;
    }
    case 'grumpy':
      startReaction(S, p, 'shoo', 1.6, 'shoo');
      say(S, p, SPEECH.shoo);
      emit(S, 'shooed', { by: p.id });
      d.scaredT = 2.5;
      break;
    case 'timid':
      p.petCD = S.t + 30;
      say(S, p, SPEECH.startled);
      if (p.role === 'walker') { p.state = 'flee'; p.timer = 2.2; }
      break;
    default:
      // not now, little one
      p.petCD = S.t + 40;
      if (S.rng() < 0.5) say(S, p, [['Nahi, abhi nahi', 'Not now'], ['Kuch nahi hai', "I've got nothing"]]);
  }
}

function dogInteractions(S, dt) {
  const d = S.dog;
  const C = S.C.crowd;
  const barked = d.barkedAt === S.t;
  S.grid.query(d.x, d.z, Math.max(3, S.C.dog.barkRadius), nearList);
  const begging = (d.sitting || d.begging) && !d.action;
  let bestBeg = null, bestScore = Infinity;
  for (const e of nearList) {
    if (e.kind !== 'ped') continue;
    const p = e.ref;
    if (p.hidden) continue;
    const dist = Math.sqrt(dist2(p.x, p.z, d.x, d.z));
    if (barked && dist < S.C.dog.barkRadius && p.startleT <= 0) {
      p.startleT = 4;
      if (p.react <= 0 || p.reactKind === 'pet') {
        if (p.kid && S.rng() < 0.6) { startReaction(S, p, 'cheer', 1.2, 'cheer'); say(S, p, [['Bhow bhow!', 'Woof woof!'], ['Hahaha!', '']]); }
        else if (p.disp === 'grumpy' && dist < 3.5) { startReaction(S, p, 'shoo', 1.4, 'shoo'); say(S, p, SPEECH.shoo); emit(S, 'shooed', { by: p.id }); d.scaredT = 1.5; }
        else if (dist < 3.2) { startReaction(S, p, 'startle', 0.9, 'startle'); if (S.rng() < 0.45) say(S, p, SPEECH.startled); emit(S, 'startled', { by: p.id }); }
      }
      continue;
    }
    // running into someone
    if (d.speed > 3.8 && dist < 0.62 && p.startleT <= 0 && p.role !== 'keeper') {
      p.startleT = 3;
      startReaction(S, p, 'startle', 1.0, 'startle');
      say(S, p, SPEECH.startled);
      emit(S, 'bumped', { by: p.id });
      if (p.snack) {
        spawnItem(S, p.snack, p.x, p.y + 1.0, p.z, rand(S.rng, -1, 1), 1.5, rand(S.rng, -1, 1), { dropped: true });
        say(S, p, [['Arre! Mera ' + p.snack + '!', 'Hey! My ' + p.snack + '!']]);
        p.snack = null;
        emit(S, 'dropped', { by: p.id });
      }
      continue;
    }
    // candidate for begging
    if (begging && S.t >= p.petCD && p.react <= 0 && p.state !== 'curb' && !p.crossing) {
      const reach = p.begReach || (p.role === 'keeper' ? 3.2 : 2.1);
      if (dist > reach) continue;
      if (p.role === 'keeper' && dist2(d.x, d.z, p.door.x, p.door.z) > 1.8 * 1.8) continue;
      const toPed = Math.atan2(p.x - d.x, p.z - d.z);
      const facing = Math.abs(angleDiff(d.yaw, toPed));
      if (facing > 1.4) continue;
      const score = dist + facing;
      if (score < bestScore) { bestScore = score; bestBeg = p; }
    }
    // a resting dog sometimes gets a pat from a kind passer-by
    if (!begging && (d.lying || d.sitting) && !d.sleeping && p.role === 'walker' && p.disp === 'kind' && dist < 1.6 && S.t >= p.petCD && p.state === 'walk' && S.rng() < C.spontaneousPet * dt) {
      p.petCD = S.t + C.petCooldown;
      startReaction(S, p, 'pet', 2.4, 'pet');
      say(S, p, SPEECH.pet);
    }
  }
  if (bestBeg && d.begT > C.begTime) {
    d.begT = 0;
    respond(S, bestBeg);
  }
}

/** Scene characters borrow the crowd's reaction helpers. */
export { startReaction, respond };
