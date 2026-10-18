/*
 * traffic.js — autos, scooters, buses, trucks, cycle-rickshaws: the river of
 * vehicles through the chowk.
 *
 * Every vehicle follows one ROUTE (arm in -> around the ring -> arm out, see
 * world.buildRoutes) at arc length `s`, with a lateral offset `d` inside its
 * carriageway — lane discipline here is a suggestion, and two-wheelers weave.
 *
 * Control is one rule applied to everything: look along your own path for the
 * first thing in the way (another vehicle, a person, a cow, the dog), keep a
 * speed you could stop from in that gap, and honk. Vehicles entering the ring
 * give way to those already on it, until they have waited long enough to stop
 * being polite. Whatever gets truly stuck far from the dog is quietly removed.
 */

import { routePose, ARMS, surfAt, SURF } from './world.js';
import { pickWeighted, pick, rand, clamp, lerp, dist2, wrapAngle, hex, smoothstep } from './util.js';
import { emit, say } from './simcore.js';
import { SKIN_TONES, HAIR_COLORS, CLOTHES, VEHICLE_COLORS, SPEECH } from './data.js';

const POSE = { x: 0, z: 0, tx: 0, tz: 0, halfW: 0, speed: 0, tag: 0 };

export function init(S) {
  S.vehicles = [];
  S.spawnClock = {};
  for (const A of ARMS) S.spawnClock[A.id] = rand(S.rng, 0, 2);
  S.routeByArm = {};
  for (let i = 0; i < S.W.routes.length; i++) {
    const r = S.W.routes[i];
    (S.routeByArm[r.from] || (S.routeByArm[r.from] = [])).push(i);
  }
  // Bus stop: where along the eastern arm's inbound approach the stop sits.
  S.busStopS = {};
  for (let i = 0; i < S.W.routes.length; i++) {
    const r = S.W.routes[i];
    if (r.from !== 'E') continue;
    let best = 0, bd = Infinity;
    for (let k = 0; k < r.n; k++) {
      if (r.tag[k] !== 0) break;
      const d = Math.abs(r.x[k] - S.W.special.busStop.roadX);
      if (d < bd) { bd = d; best = k; }
    }
    S.busStopS[i] = best * r.step;
  }
  prewarm(S);
}

function arrivalRate(S) {
  const h = S.clock.hours;
  const R = S.C.traffic.rate;
  if (h < 5 || h >= 23) return R.night;
  if (h < 7) return lerp(R.night, R.morning, (h - 5) / 2);
  if (h < 11) return R.morning;
  if (h < 16.5) return R.day;
  if (h < 21) return R.evening;
  return lerp(R.evening, R.night, (h - 21) / 2);
}

function chooseRoute(S, arm) {
  const T = S.C.traffic.turn;
  const list = S.routeByArm[arm];
  const turn = pickWeighted(S.rng, [[T.straight, 'straight'], [T.left, 'left'], [T.right, 'right'], [T.u, 'u']]);
  const r = list.find((i) => S.W.routes[i].turn === turn);
  return r === undefined ? list[0] : r;
}

/* ------------------------------------------------------------------- riders */

function person(S, opts) {
  const rng = S.rng;
  const female = opts.female !== undefined ? opts.female : rng() < 0.32;
  const kind = opts.kind || (female ? pick(rng, ['saree', 'salwar']) : pick(rng, ['man', 'manMustache', 'cap', 'kurta', 'turban']));
  const skin = hex(pick(rng, SKIN_TONES));
  let top, bottom, hair = hex(pick(rng, HAIR_COLORS.slice(0, 5)));
  if (kind === 'saree') { top = hex(pick(rng, CLOTHES.saree)); bottom = hex(pick(rng, CLOTHES.saree2)); }
  else if (kind === 'salwar') { top = hex(pick(rng, CLOTHES.saree)); bottom = hex(pick(rng, CLOTHES.dupatta)); }
  else if (kind === 'kurta' || kind === 'turban') { top = hex(pick(rng, CLOTHES.kurta)); bottom = hex(pick(rng, ['#f8f4e3', '#fffdf5', '#e9d8a6'])); if (kind === 'turban') hair = hex(pick(rng, CLOTHES.turban)); }
  else { top = hex(pick(rng, CLOTHES.shirt)); bottom = hex(pick(rng, CLOTHES.pants)); if (kind === 'cap') hair = hex(pick(rng, ['#1d3557', '#e63946', '#f1faee', '#2a9d8f'])); }
  if (opts.uniform) { top = hex(pick(rng, CLOTHES.khaki)); bottom = hex(pick(rng, CLOTHES.khaki)); }
  return { kind, colors: [skin, top, bottom, hair], scale: rand(rng, 0.94, 1.06) };
}

function makeRiders(S, type) {
  const rng = S.rng;
  const R = [];
  switch (type) {
    case 'auto': {
      R.push(Object.assign(person(S, { female: false, uniform: rng() < 0.7, kind: pick(rng, ['man', 'manMustache', 'cap']) }), { seat: 'driver', pose: 'ride' }));
      const n = pick(rng, [0, 1, 1, 2, 2, 3]);
      for (let i = 0; i < n; i++) R.push(Object.assign(person(S, {}), { seat: 'back' + i, pose: 'passenger' }));
      break;
    }
    case 'scooter':
    case 'bike': {
      R.push(Object.assign(person(S, { female: type === 'scooter' && rng() < 0.25 ? true : false }), { seat: 'driver', pose: 'ride' }));
      if (rng() < 0.45) R.push(Object.assign(person(S, {}), { seat: 'back0', pose: 'passenger' }));
      break;
    }
    case 'cycle':
      R.push(Object.assign(person(S, { female: false }), { seat: 'driver', pose: 'pedal' }));
      break;
    case 'rickshaw': {
      R.push(Object.assign(person(S, { female: false, kind: pick(rng, ['lungi', 'man', 'manMustache']) }), { seat: 'driver', pose: 'pedal' }));
      const n = pick(rng, [0, 1, 1, 2]);
      for (let i = 0; i < n; i++) R.push(Object.assign(person(S, {}), { seat: 'back' + i, pose: 'passenger' }));
      break;
    }
    default:
  }
  return R;
}

function vehicleColors(S, type) {
  const rng = S.rng, V = VEHICLE_COLORS;
  const black = hex('#222222'), white = hex('#ffffff');
  switch (type) {
    case 'auto': { const c = rng() < 0.75 ? pick(rng, V.autoCng) : pick(rng, V.autoMumbai); return [hex(c[0]), hex(c[1]), black, white]; }
    case 'taxi': { const c = pick(rng, V.taxi); return [hex(c[0]), hex(c[1]), black, white]; }
    case 'car': { const c = hex(pick(rng, V.car)); return [c, c, black, white]; }
    case 'bus': { const c = pick(rng, V.bus); return [hex(c[0]), hex(c[1]), black, white]; }
    case 'truck': { const c = pick(rng, V.truck); return [hex(c[0]), hex(c[1]), black, white]; }
    case 'cycle': { const c = hex(pick(rng, V.cycle)); return [c, c, black, white]; }
    case 'rickshaw': { const c = hex(pick(rng, ['#1d4e89', '#2e7d32', '#7a1f1f', '#4a148c'])); return [c, hex(pick(rng, ['#1d4e89', '#111111', '#7a1f1f', '#f9a825'])), hex('#7a1f1f'), white]; }
    default: { const c = hex(pick(rng, V.scooter)); return [c, white, black, white]; }
  }
}

/* ------------------------------------------------------------------- spawn */

function makeVehicle(S, type, routeIndex, s) {
  const T = S.C.traffic.types[type];
  const route = S.W.routes[routeIndex];
  const two = type === 'scooter' || type === 'bike' || type === 'cycle';
  const room = Math.max(0, route.halfW[0] - T.halfW - 0.2);
  // slow traffic keeps left (negative d); two-wheelers go wherever there is a gap
  const pref = two ? rand(S.rng, -room, room) : type === 'bus' || type === 'truck' || type === 'rickshaw' || type === 'cycle' ? -room * rand(S.rng, 0.4, 0.9) : rand(S.rng, -room * 0.6, room * 0.7);
  const v = {
    id: S.nextId++, type, T, route: routeIndex, s, d: pref, dPref: pref, dTarget: pref,
    v: T.vmax * 0.6, vmax: T.vmax * rand(S.rng, 0.85, 1.12),
    x: 0, z: 0, yaw: 0, dirx: 0, dirz: 1, y: 0,
    stopT: 0, waitT: 0, honkCD: rand(S.rng, 0, 3), honkT: 0, spin: 0, steer: 0, pitch: 0,
    colors: vehicleColors(S, type), riders: makeRiders(S, type),
    blockedKind: '', blockedT: 0, weaveT: 0, brakeT: 0, creep: false,
    stopAt: -1, stopWait: 0, stopped: false,
    circles: [], len: T.len, halfW: T.halfW,
    h: type === 'bus' ? 3.2 : type === 'truck' ? 3.0 : 1.8,
  };
  // a footprint of circles along the body, for everyone else's collision tests
  const n = Math.max(1, Math.round(T.len / (2 * T.halfW)));
  const r = Math.max(T.halfW, T.len / (2 * n));
  for (let k = 0; k < n; k++) v.circles.push({ off: n === 1 ? 0 : -(T.len / 2 - r) + ((T.len - 2 * r) * k) / (n - 1), r });
  if (type === 'bus' && S.busStopS[routeIndex] !== undefined) v.stopAt = S.busStopS[routeIndex];
  else if (type === 'auto' && S.rng() < 0.18) {
    const end = route.entryS - 25;
    if (end > 30) v.stopAt = rand(S.rng, 20, end);
  }
  place(S, v);
  return v;
}

function place(S, v) {
  const route = S.W.routes[v.route];
  routePose(route, v.s, v.d, POSE);
  v.x = POSE.x; v.z = POSE.z;
  v.dirx = POSE.tx; v.dirz = POSE.tz;
  v.yaw = Math.atan2(POSE.tx, POSE.tz);
}

function spaceClear(S, x, z, r) {
  for (const o of S.vehicles) if (dist2(o.x, o.z, x, z) < r * r) return false;
  return true;
}

function prewarm(S) {
  const target = Math.round(S.C.traffic.maxVehicles * 0.55);
  let guard = 0;
  while (S.vehicles.length < target && guard++ < 400) {
    const A = pick(S.rng, ARMS);
    const ri = chooseRoute(S, A.id);
    const route = S.W.routes[ri];
    const s = rand(S.rng, 5, route.length - 10);
    const type = pickWeighted(S.rng, A.road === 'mg' ? S.C.traffic.mixMG : S.C.traffic.mixBazaar);
    routePose(route, s, 0, POSE);
    if (!spaceClear(S, POSE.x, POSE.z, 9)) continue;
    const v = makeVehicle(S, type, ri, s);
    v.v = v.vmax * 0.5;
    S.vehicles.push(v);
  }
}

function spawn(S, dt) {
  const rate = arrivalRate(S) / 60;
  for (const A of ARMS) {
    const k = A.road === 'mg' ? 1 : 0.75;
    S.spawnClock[A.id] -= dt * rate * k;
    if (S.spawnClock[A.id] > 0) continue;
    S.spawnClock[A.id] = -Math.log(1 - S.rng() * 0.999); // exponential gaps
    if (S.vehicles.length >= S.C.traffic.maxVehicles) continue;
    const ri = chooseRoute(S, A.id);
    const route = S.W.routes[ri];
    routePose(route, 0, 0, POSE);
    if (!spaceClear(S, POSE.x, POSE.z, 11)) continue;
    const type = pickWeighted(S.rng, A.road === 'mg' ? S.C.traffic.mixMG : S.C.traffic.mixBazaar);
    S.vehicles.push(makeVehicle(S, type, ri, 0));
  }
}

/* ------------------------------------------------------------------ control */

/** Insert every vehicle's footprint into the shared grid (called by sim before subsystems step). */
export function insertGrid(S) {
  for (const v of S.vehicles) {
    for (const c of v.circles) S.grid.insert('veh', v, v.x + v.dirx * c.off, v.z + v.dirz * c.off, c.r);
  }
}

const near = [];

/**
 * How far ahead along its own path can v drive at lateral offset d before it
 * meets something? Returns { gap, what, lead } where lead is the obstacle's
 * speed along our direction (0 for people and animals).
 */
function senseAhead(S, v, d, look, ignore) {
  const route = S.W.routes[v.route];
  const T = S.C.traffic;
  const front = v.len / 2;
  const out = { gap: look, what: '', ref: null, lead: 0 };
  S.grid.query(v.x, v.z, look + front + 3, near);
  if (!near.length) return out;
  const step = route.step;
  const i0 = Math.floor(v.s / step);
  const kStart = Math.max(0, Math.floor((front - 0.4) / step));
  const kEnd = Math.ceil((front + look) / step);
  for (const e of near) {
    if (e.ref === v || e.ref === ignore) continue;
    const ex = e.x, ez = e.z;
    // people and animals only matter once they are actually on the carriageway
    let margin = T.latMargin;
    if (e.kind !== 'veh') {
      const sf = surfAt(S.W, ex, ez);
      if (sf !== SURF.ROAD && sf !== SURF.CROSS) continue;
      margin = 0.1;
    }
    // quick reject: far beyond the look-ahead
    const rx = ex - v.x, rz = ez - v.z;
    const along = rx * v.dirx + rz * v.dirz;
    if (along < front - 1.5 - e.r || along > front + look + e.r + 2) continue;
    const clear = v.halfW + e.r + margin;
    const c2 = clear * clear;
    for (let k = kStart; k <= kEnd; k += 2) {
      const i = Math.min(route.n - 1, i0 + k);
      const tx = route.tx[i], tz = route.tz[i];
      const px = route.x[i] - tz * d, pz = route.z[i] + tx * d;
      const dx = ex - px, dz = ez - pz;
      if (dx * dx + dz * dz < c2) {
        const gap = k * step - front - e.r;
        if (gap < out.gap) {
          out.gap = gap;
          out.what = e.kind;
          out.ref = e.ref;
          out.lead = e.kind === 'veh' ? Math.max(0, e.ref.v * (e.ref.dirx * v.dirx + e.ref.dirz * v.dirz)) : 0;
        }
        break;
      }
    }
  }
  return out;
}

/** Ring entry: is anyone on the ring coming round toward our merge point? */
function mustYield(S, v, route) {
  const merge = route.ringAngle;
  const win = v.waitT > S.C.traffic.impatient ? 0.55 : S.C.traffic.yieldWindow;
  for (const u of S.vehicles) {
    if (u === v) continue;
    const ur = S.W.routes[u.route];
    if (u.s < ur.ringStart - 3 || u.s > ur.ringEnd) continue;
    const phi = Math.atan2(u.z, u.x);
    const ahead = wrapAngle(merge - phi); // > 0: u is upstream, coming toward the merge
    if (ahead > -0.12 && ahead < win) return u;
  }
  return null;
}

export function step(S, dt) {
  spawn(S, dt);
  const T = S.C.traffic;
  const dog = S.dog;
  for (let vi = S.vehicles.length - 1; vi >= 0; vi--) {
    const v = S.vehicles[vi];
    const route = S.W.routes[v.route];
    routePose(route, v.s, v.d, POSE);
    const limit = Math.min(v.vmax, POSE.speed * (v.vmax / v.T.vmax));
    const look = T.lookBase + v.v * T.lookPerSpeed;
    let sense = senseAhead(S, v, v.d, look);
    // two vehicles each waiting for the other: the older one goes first
    if (sense.what === 'veh' && sense.ref.blockRef === v && v.id < sense.ref.id) sense = senseAhead(S, v, v.d, look, sense.ref);
    v.blockRef = sense.what === 'veh' ? sense.ref : null;
    v.dbg = sense;
    // ring entry yield
    const yieldS = route.entryS - 0.5;
    if (v.s < yieldS && yieldS - v.s < look + v.len) {
      const u = mustYield(S, v, route);
      if (u) {
        const g = yieldS - v.s - v.len / 2;
        if (g < sense.gap) { sense = { gap: Math.max(0, g), what: 'yield', ref: u, lead: 0 }; }
      }
    }
    // planned stop (bus stop, auto dropping a passenger)
    if (v.stopAt >= 0 && !v.stopped && v.s < v.stopAt + 0.5) {
      const g = v.stopAt - v.s;
      if (g < sense.gap) sense = { gap: Math.max(0, g), what: 'stop', ref: null, lead: 0 };
      v.dTarget = -(route.halfW[Math.floor(v.s / route.step)] - v.halfW - 0.15);
      if (g < 0.4 && v.v < 0.4) { v.stopped = true; v.stopWait = v.type === 'bus' ? T.busStopTime : rand(S.rng, 2.5, 4.5); }
    }
    if (v.stopped && v.stopWait > 0) {
      v.stopWait -= dt;
      sense = { gap: 0, what: 'stop', ref: null, lead: 0 };
      if (v.stopWait <= 0) { v.stopAt = -1; v.dTarget = v.dPref; }
    }

    // curve speed: look a little ahead for the tightest bend
    let curve = limit;
    const i0 = Math.floor(v.s / route.step);
    for (let k = 4; k < 24; k += 4) {
      const ia = Math.min(route.n - 1, i0 + k), ib = Math.min(route.n - 1, i0 + k + 4);
      const turn = Math.abs(wrapAngle(Math.atan2(route.tx[ib], route.tz[ib]) - Math.atan2(route.tx[ia], route.tz[ia])));
      if (turn > 1e-3) curve = Math.min(curve, Math.sqrt(T.curveAccel * (4 * route.step) / turn));
    }

    // safe speed for the gap ahead
    const g0 = sense.what === 'stop' || sense.what === 'yield' ? 0.05 : v.type === 'scooter' || v.type === 'bike' || v.type === 'cycle' ? T.minGap * 0.6 : T.minGap;
    const free = Math.max(0, sense.gap - g0);
    const safe = Math.sqrt(sense.lead * sense.lead + 2 * v.T.decel * 0.7 * free);
    let target = Math.min(limit, curve, safe);
    if (v.brakeT > 0) { v.brakeT -= dt; target = 0; }

    // creeping out of a deadlock: inch forward past another stuck vehicle
    if (v.stopT > T.creepAfter && sense.what === 'veh' && sense.ref && sense.ref.stopT > T.creepAfter && sense.gap > 0.35) target = Math.max(target, 0.6);

    if (target < v.v) v.v = Math.max(target, v.v - v.T.decel * dt * (sense.gap < 2 ? 1.8 : 1));
    else v.v = Math.min(target, v.v + v.T.accel * dt);
    if (sense.gap <= 0.05 && sense.what !== 'yield') v.v = Math.min(v.v, 0.2);

    // weaving: two-wheelers, autos and cars squeeze past slow obstacles
    const blocked = sense.gap < 7 && (sense.what !== 'veh' || sense.lead < v.vmax * 0.45) && sense.what !== 'yield' && sense.what !== 'stop';
    v.blockedT = blocked ? v.blockedT + dt : Math.max(0, v.blockedT - dt * 2);
    v.weaveT -= dt;
    const hw = POSE.halfW;
    const room = Math.max(0, hw - v.halfW - 0.15);
    const big = v.type === 'bus' || v.type === 'truck';
    if (v.blockedT > (big ? 2.2 : 0.9) && v.weaveT <= 0) {
      v.weaveT = 0.8;
      let best = v.dTarget, bestGap = sense.gap + 2.5;
      for (const cand of [v.d + 1.3, v.d - 1.3, room, -room, room * 0.5, -room * 0.5, 0]) {
        if (Math.abs(cand) > room + 1e-6 || Math.abs(cand - v.d) < 0.3) continue;
        const sg = senseAhead(S, v, cand, look + 4).gap;
        if (sg > bestGap + Math.abs(cand - v.d) * 0.3) { bestGap = sg; best = cand; }
      }
      v.dTarget = best;
    } else if (!blocked && v.blockedT === 0 && v.stopAt < 0 && Math.abs(v.dTarget - v.dPref) > 0.1 && v.weaveT < -2) {
      v.dTarget = clamp(v.dPref, -room, room);
    }
    v.dTarget = clamp(v.dTarget, -room, room);
    const latStep = T.latSpeed * dt * clamp(v.v / 3, 0.25, 1);
    v.d += clamp(v.dTarget - v.d, -latStep, latStep);
    v.d = clamp(v.d, -room - 0.05, room + 0.05);

    // honking: at whatever is in the way, and just because
    v.honkCD -= dt;
    if (v.honkT > 0) v.honkT -= dt;
    const inWay = sense.what === 'dog' || sense.what === 'ped' || sense.what === 'cow' || sense.what === 'npcdog' || sense.what === 'goat';
    if (v.honkCD <= 0) {
      if ((inWay && sense.gap < 6) || (blocked && v.blockedT > 1.5)) {
        if (S.rng() < v.T.honk) honk(S, v, sense.what === 'dog');
        v.honkCD = rand(S.rng, T.honkCooldown[0], T.honkCooldown[1]);
      } else if (v.v > 2 && S.rng() < T.randomHonk * v.T.honk * dt) {
        honk(S, v, false);
        v.honkCD = rand(S.rng, T.honkCooldown[0] * 2, T.honkCooldown[1] * 2);
      }
    }

    // advance
    const prevYaw = v.yaw;
    v.s += v.v * dt;
    v.spin += v.v * dt;
    if (v.s >= route.length - 0.5) { S.vehicles.splice(vi, 1); v.gone = true; continue; }
    place(S, v);
    v.steer = clamp(wrapAngle(v.yaw - prevYaw) / Math.max(dt, 1e-3) * 0.35, -0.5, 0.5);
    v.pitch = lerp(v.pitch, clamp((target - v.v) * 0.01, -0.03, 0.03), 1 - Math.exp(-6 * dt));
    if (v.v < 0.1) v.stopT += dt; else v.stopT = 0;
    if (sense.what === 'yield' || (sense.what === 'veh' && v.v < 0.3)) v.waitT += dt; else v.waitT = 0;

    // give up on hopeless jams that are out of the dog's sight
    if (v.stopT > T.despawnStuck && dist2(v.x, v.z, dog.x, dog.z) > 28 * 28) { S.vehicles.splice(vi, 1); v.gone = true; }
  }
  separate(S);
}

/** Last line of defence: if two bodies overlap anyway (a merge, a creep), back the later one off. */
function separate(S) {
  const list = S.vehicles;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const reach = (a.len + b.len) / 2 + 1;
      if (Math.abs(a.x - b.x) > reach || Math.abs(a.z - b.z) > reach) continue;
      let worst = 0;
      for (const ca of a.circles) {
        const ax = a.x + a.dirx * ca.off, az = a.z + a.dirz * ca.off;
        for (const cb of b.circles) {
          const bx = b.x + b.dirx * cb.off, bz = b.z + b.dirz * cb.off;
          const pen = ca.r + cb.r - Math.sqrt(dist2(ax, az, bx, bz));
          if (pen > worst) worst = pen;
        }
      }
      if (worst > 0.15) {
        // whoever is behind (relative to the other's heading) yields
        const rel = (b.x - a.x) * a.dirx + (b.z - a.z) * a.dirz;
        const back = rel > 0 ? a : b;
        back.s = Math.max(0, back.s - Math.min(worst, 0.5));
        back.v = Math.min(back.v, 0.3);
        place(S, back);
      }
    }
  }
}

export function honk(S, v, atDog) {
  v.honkT = v.T.horn === 'bus' || v.T.horn === 'truck' ? 0.9 : 0.45;
  emit(S, 'honk', { id: v.id, x: v.x, z: v.z, horn: v.T.horn, atDog: !!atDog });
  if (atDog && S.rng() < 0.35 && v.riders.length) say(S, v, SPEECH.driver, { h: v.h + 0.2 });
}

/** The dog walked into a vehicle, or a vehicle into the dog. Called from the dog's collision pass. */
export function hitDog(S, v) {
  emit(S, 'hitByVehicle', { id: v.id, v: v.v, vtype: v.type });
  v.brakeT = 1.6;
  v.v *= 0.25;
  honk(S, v, true);
  say(S, v, SPEECH.driver, { h: v.h + 0.2 });
}
