/*
 * rail.js — the railway along the north edge of town: the trains, the level
 * crossing (the phatak) and the gateman who works it.
 *
 * A train is a locomotive and a string of coaches running straight along one of
 * the two tracks, full inside and out: people sit along the roofs with their
 * legs over the side and hang out of every door. Trains keep their own
 * timetable in real seconds and roll their own dice (S.rail.rng), so a train
 * going by does not reshuffle the rest of the town.
 *
 * When a nose comes within warnDist of the road the bell rings and the gateman
 * winds the booms down. Traffic stops at the line (traffic.js asks gateStop()),
 * apart from the two-wheelers, who duck under the boom until the train is
 * close. Nobody stops on the tracks, open gate or not. Once the last coach is
 * clear the booms go back up.
 *
 * A train cannot stop for a dog. It sounds its horn, and a dog still on the line
 * when the engine gets there is thrown clear, hard. It does stop for a cow on
 * the crossing: everyone does.
 */

import { PLAY_HALF } from './world.js';
import { makeRng, rand, randInt, pick, dist2 } from './util.js';
import { emit, say, tossToDog } from './simcore.js';
import { makePerson } from './crowd.js';
import { SPEECH } from './data.js';

export const COACH_LIVERIES = 3; // paint schemes, see models.js and main.js
export const LOCO_LIVERIES = 3;
export const RAIL_TOP = 0.46;    // height of the rail heads above the ground
export const ROOF_Y = 4.42;      // a coach roof, where the riders sit
export const STEP_Y = 1.2;       // the bottom door step, where the hangers-on stand

/** Height of a coach roof at `lz` metres from its centre line (it curves down to the sides). */
export function roofAt(lz) {
  const a = Math.abs(lz);
  if (a <= 0.56) return ROOF_Y;
  if (a <= 1.12) return 4.3 + 0.12 * (1.12 - a) / 0.56;
  return 4.0 + 0.3 * Math.max(0, 1.6 - a) / 0.48;
}

const DUCKERS = new Set(['scooter', 'bike', 'cycle']);

/** Some two-wheelers wait at a closed gate; most do not. Fixed per vehicle, no dice. */
export const ducker = (v) => DUCKERS.has(v.type) && ((v.id * 2654435761) >>> 0) % 100 < 60;

export function init(S) {
  const W = S.W, X = W.special.crossing;
  const R = S.rail = {
    rng: makeRng((S.seed * 40503 + S.clock.day * 7919 + 17) >>> 0),
    next: S.C.rail.firstTrain,
    count: 0,
    trains: [],
    gate: { state: 'open', k: 0, t: 0 },
    duckOk: false,
    pedDuckOk: false,
    keeper: null,
    keeperCD: 0,
    cross: [],
    nextId: 1,
  };
  if (!X) return;
  // where each route goes in between the booms and comes out again
  R.cross = W.routes.map((r) => {
    const segs = [];
    let inside = false, sIn = 0;
    for (let i = 0; i < r.n; i++) {
      const on = Math.abs(r.x[i]) < X.x1 + 2 && r.z[i] < X.gateZ[0] && r.z[i] > X.gateZ[1];
      if (on && !inside) { inside = true; sIn = i * r.step; }
      else if (!on && inside) { inside = false; segs.push({ sIn, sOut: i * r.step }); }
    }
    if (inside) segs.push({ sIn, sOut: r.length });
    return segs.length ? segs : null;
  });
  // the gateman, in railway blue, outside his hut
  const k = X.keeper;
  const p = makePerson({ rng: R.rng, nextId: 1e6, C: S.C }, { kind: 'manMustache', female: false, kid: false, role: 'special', x: k.x, z: k.z, yaw: k.yaw });
  p.colors[1] = [0.13, 0.22, 0.42];
  p.colors[2] = [0.1, 0.11, 0.15];
  p.state = 'special'; p.mode = 'squat'; p.disp = 'neutral'; p.name = 'Gateman';
  p.home = { x: k.x, z: k.z, yaw: k.yaw };
  S.peds.push(p);
  R.keeper = p;
}

/* ------------------------------------------------------------------ trains */

function spawnTrain(S) {
  const R = S.rail, C = S.C.rail, rng = R.rng, X = S.W.special.crossing;
  const track = R.count % 2; // the tracks take turns
  R.count++;
  const T = X.tracks[track];
  const nCoach = randInt(rng, C.coaches[0], C.coaches[1]);
  const livery = Math.floor(rng() * COACH_LIVERIES);
  const cars = [{ kind: 'loco', len: C.locoLen, off: 0, livery: Math.floor(rng() * LOCO_LIVERIES), riders: [] }];
  let off = C.locoLen + C.coupling;
  for (let i = 0; i < nCoach; i++) {
    const car = { kind: 'coach', len: C.coachLen, off, livery, riders: [] };
    // the general coaches at either end are the fullest of all
    fillCoach(S, car, i === 0 || i === nCoach - 1 ? 1 : rand(rng, 0.7, 1));
    cars.push(car);
    off += C.coachLen + C.coupling;
  }
  const v = rand(rng, C.speed[0], C.speed[1]);
  const t = {
    id: R.nextId++, track, dir: T.dir, z: T.z, len: off - C.coupling, cars,
    x: -T.dir * C.spawnX, v, vmax: v,
    horns: 0, hornCD: 0, braking: false,
    raceT: 0, raced: false, snack: rng() < C.snackChance, cheerT: 0, sayCD: 0,
    voice: { x: 0, y: ROOF_Y, z: T.z, h: 0.9 },
  };
  R.trains.push(t);
  emit(S, 'trainSpawn', { id: t.id, dir: t.dir });
  return t;
}

/** Load a coach's roof and doors with people. `full` 0..1. */
function fillCoach(S, car, full) {
  const rng = S.rail.rng;
  const who = { rng, nextId: 0, C: S.C };
  const look = (women) => {
    const p = makePerson(who, { female: rng() < women, kid: rng() < 0.06 });
    return { kind: p.kind, colors: p.colors, scale: p.scale };
  };
  // The roof: a row along each edge with their legs over the side, and a crowd
  // squatting, sitting and standing down the middle. lx runs along the coach
  // (toward the engine), lz across it.
  const half = car.len / 2 - 0.8;
  const n = Math.round(randInt(rng, 18, 28) * full);
  const placed = [];
  for (let i = 0; i < n; i++) {
    let lx = 0, lz = 0, ok = false;
    for (let k = 0; k < 10 && !ok; k++) {
      lx = rand(rng, -half, half);
      lz = rng() < 0.5 ? (rng() < 0.5 ? -1.3 : 1.3) : rand(rng, -0.65, 0.65);
      ok = placed.every((q) => (q[0] - lx) ** 2 + (q[1] - lz) ** 2 > 0.62 * 0.62);
    }
    if (!ok) continue;
    placed.push([lx, lz]);
    const edge = Math.abs(lz) > 1;
    const pose = edge ? 'sit' : pick(rng, ['squat', 'knees', 'knees', 'stand', 'squat', 'knees']);
    const yaw = edge ? (lz > 0 ? Math.PI / 2 : -Math.PI / 2) : pick(rng, [0, 0, Math.PI, 0.7, -0.7, Math.PI / 2, -Math.PI / 2]);
    car.riders.push(Object.assign(look(0.12), { slot: 'roof', lx, lz, y: roofAt(lz), yaw, pose, ph: rng() * 10, waver: rng() < 0.6 }));
  }
  // bags and bundles up there too
  car.bags = [];
  for (let i = randInt(rng, 1, 4); i > 0; i--) {
    const lz = rand(rng, -0.5, 0.5);
    car.bags.push({ lx: rand(rng, -half, half), lz, y: roofAt(lz), kind: rng() < 0.5 ? 'bundle' : 'trunk', yaw: rng() * Math.PI });
  }
  // the doors, two at each end, one each side: most have someone hanging out
  for (const end of [-1, 1]) {
    for (const side of [-1, 1]) {
      const m = randInt(rng, full > 0.9 ? 1 : 0, 3);
      for (let i = 0; i < m; i++) {
        car.riders.push(Object.assign(look(0.06), {
          slot: 'door', lx: end * (car.len / 2 - 0.95) - end * i * 0.42, lz: side * (1.66 + i * 0.1), y: STEP_Y,
          yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2, pose: 'hang', ph: rng() * 10, waver: rng() < 0.7, side,
        }));
      }
    }
  }
}

/** World x of a car's centre. */
export const carX = (t, car) => t.x - t.dir * (car.off + car.len / 2);
/** Distance from the nose to the near side of the road (negative once the nose is over it). */
const toRoad = (S, t) => -S.W.special.crossing.x1 - t.dir * t.x;
/** Has the tail gone clear of the road by `m` metres? */
const tailClear = (S, t, m) => t.dir * t.x - t.len > S.W.special.crossing.x1 + m;

/* -------------------------------------------------------------------- step */

export function step(S, dt) {
  const R = S.rail, C = S.C.rail, X = S.W.special.crossing;
  if (!X) return;
  R.next -= dt;
  if (R.next <= 0) {
    spawnTrain(S);
    R.next = rand(R.rng, C.every[0], C.every[1]);
  }
  const d = S.dog;
  for (let i = R.trains.length - 1; i >= 0; i--) {
    const t = R.trains[i];
    moveTrain(S, t, dt);
    if (t.dir * t.x - t.len > C.spawnX) { R.trains.splice(i, 1); t.gone = true; continue; }
    passengers(S, t, dt);
    shovePeds(S, t);
  }
  gate(S, dt);
  keeper(S, dt);
  // the dog on the line, or squeezed against a passing coach
  collideDog(S, d);
}

function moveTrain(S, t, dt) {
  const C = S.C.rail, X = S.W.special.crossing;
  const dn = toRoad(S, t);
  // anything standing on the crossing in our track's way? A cow is shooed and
  // waited for; a vehicle is waited for (it should never be there with the gate down)
  let blocked = null;
  if (dn > -X.x1 * 2 && dn < 120) {
    const band = C.halfW + 0.9;
    for (const c of S.cows) if (Math.abs(c.z - t.z) < band && Math.abs(c.x) < X.x1 + 1) { blocked = c; if (!c.shooed && c.state !== 'walk') c.shooed = { x: c.x, z: t.z }; break; }
    if (!blocked) for (const v of S.vehicles) if (Math.abs(v.z - t.z) < band + v.len / 2 && Math.abs(v.x) < X.x1 + 1) { blocked = v; break; }
  }
  let target = t.vmax;
  t.braking = false;
  if (blocked && dn > 0) {
    // stop with the engine a few metres short of the road
    const room = Math.max(0, dn - 6);
    target = Math.min(target, Math.sqrt(2 * C.brake * room));
    t.braking = target < t.v - 0.1;
    if (t.hornCD <= 0) { horn(S, t, true); t.hornCD = 2.2; }
  }
  t.hornCD -= dt;
  if (target < t.v) t.v = Math.max(target, t.v - C.brake * 1.4 * dt);
  else t.v = Math.min(target, t.v + 0.5 * dt);
  t.x += t.dir * t.v * dt;
  // the driver leans on the horn coming up to the crossing...
  if (t.horns < C.hornAt.length && dn < C.hornAt[t.horns]) { horn(S, t, t.horns > 0); t.horns++; }
  // ...and for anyone on the line ahead
  const d = S.dog;
  if (t.hornCD <= 0 && Math.abs(d.z - t.z) < C.halfW + 0.4) {
    const ahead = t.dir * (d.x - t.x);
    if (ahead > 0 && ahead < 140) { horn(S, t, true, true); t.hornCD = 2.6; }
  }
}

function horn(S, t, long, atDog) {
  emit(S, 'trainHorn', { id: t.id, x: t.x, z: t.z, long: !!long, atDog: !!atDog });
}

/** The people on board: cheering a racing dog, waving, the odd snack thrown down. */
function passengers(S, t, dt) {
  const C = S.C.rail, d = S.dog;
  const lo = Math.min(t.x, t.x - t.dir * t.len), hi = Math.max(t.x, t.x - t.dir * t.len);
  // the voice of the coach nearest the dog
  t.voice.x = Math.max(lo + 2, Math.min(hi - 2, d.x));
  t.voice.z = t.z;
  t.cheerT = Math.max(0, t.cheerT - dt);
  t.sayCD -= dt;
  const side = Math.abs(d.z - t.z);
  const alongside = side < 7 && d.x > lo - 2 && d.x < hi + 2 && d.y < 2;
  // racing: running beside the coaches, in their direction
  if (alongside && d.vx * t.dir > C.raceSpeed && t.v > 3) {
    t.raceT += dt;
    t.cheerT = 3;
    if (t.raceT >= C.raceTime && !t.raced) {
      t.raced = true;
      emit(S, 'trainRace', { id: t.id });
      say(S, t.voice, SPEECH.train, { time: 3 });
    }
    if (t.snack && t.raceT > 1.5) throwSnack(S, t);
  } else t.raceT = Math.max(0, t.raceT - dt * 0.5);
  if (alongside && t.sayCD <= 0 && side < 6) {
    t.sayCD = rand(S.rail.rng, 5, 9);
    if (d.barkedAt === S.t || t.raceT > 0.5 || S.rail.rng() < 0.4) say(S, t.voice, t.raceT > 0.5 ? SPEECH.train : SPEECH.trainWave);
  }
  // sitting nicely by the line is asking
  if (alongside && t.snack && (d.sitting || d.begging) && side < 5.5) throwSnack(S, t);
}

function throwSnack(S, t) {
  t.snack = false;
  const d = S.dog;
  const kind = pick(S.rail.rng, ['biscuit', 'biscuit', 'samosa', 'roti']);
  const sz = Math.sign(d.z - t.z) || 1;
  tossToDog(S, kind, t.voice.x, ROOF_Y + 0.6, t.z + sz * 1.4, { fromTrain: true });
  say(S, t.voice, SPEECH.trainSnack, { time: 2.2 });
  emit(S, 'trainSnack', { id: t.id, kind });
}

/* -------------------------------------------------------------------- gate */

function gate(S, dt) {
  const R = S.rail, C = S.C.rail, g = R.gate;
  let need = false, nearest = Infinity;
  for (const t of R.trains) {
    if (tailClear(S, t, C.clearAfter)) continue;
    const dn = toRoad(S, t);
    if (dn < C.warnDist) need = true;
    nearest = Math.min(nearest, Math.max(0, dn));
  }
  g.t += dt;
  if (need && (g.state === 'open' || g.state === 'opening')) {
    g.state = 'closing'; g.t = 0;
    emit(S, 'gateClosing', {});
  } else if (!need && (g.state === 'closed' || g.state === 'closing')) {
    g.state = 'opening'; g.t = 0;
    emit(S, 'gateOpening', {});
  }
  if (g.state === 'closing') {
    g.k = Math.min(1, g.k + dt / C.closeTime);
    if (g.k >= 1) { g.state = 'closed'; g.t = 0; }
  } else if (g.state === 'opening') {
    g.k = Math.max(0, g.k - dt / C.openTime);
    if (g.k <= 0) { g.state = 'open'; g.t = 0; emit(S, 'gateOpen', {}); }
  }
  // two-wheelers chance it under the boom while the train is still a way off;
  // people on foot, slower over the tracks, only while it is further off still
  R.duckOk = nearest > C.duckDist;
  R.pedDuckOk = nearest > C.warnDist - 15;
}

/**
 * For traffic.js: how far vehicle v may go before the stop line at the
 * crossing, or -1 if it may carry on. `ahead` is what it already senses in front.
 */
export function gateStop(S, v, ahead) {
  const R = S.rail;
  v.ducking = false;
  const segs = R && R.cross[v.route];
  if (!segs) return -1;
  const front = v.s + v.len / 2;
  for (const seg of segs) {
    if (front > seg.sOut) continue;           // this crossing is behind us
    const line = seg.sIn - 0.9;
    if (front > line + 0.3) {
      // over the line: keep going and get off the tracks, ducking under a
      // boom that is coming down
      v.ducking = R.gate.k > 0.25;
      return -1;
    }
    if (line - front > 45) return -1;
    const shut = R.gate.state !== 'open';
    if (shut && !(R.duckOk && ducker(v))) return Math.max(0, line - front);
    // never stop on the tracks: go over only if there is room on the far side
    if (ahead && ahead.what === 'veh' && ahead.lead < 2.5 && front + ahead.gap < seg.sOut + v.len + 1) return Math.max(0, line - front);
    return -1;
  }
  return -1;
}

/** Between the booms (with a little to spare), on the road or its pavements. */
function inGateZone(X, x, z, pad = 0.3) {
  return Math.abs(x) < X.x1 + 2.5 && z < X.gateZ[0] + pad && z > X.gateZ[1] - pad;
}

/**
 * For crowd.js: should a walker at p, heading for (tx, tz), stop at the boom?
 * Someone already between the booms carries on across (and hurries).
 */
export function pedMustWait(S, p, tx, tz) {
  const R = S.rail, X = S.W.special.crossing;
  if (!X || R.gate.state === 'open') return false;
  if (Math.abs(p.x) > X.x1 + 2.5) return false;
  const hi = X.gateZ[0] + 0.3, lo = X.gateZ[1] - 0.3;
  if (p.z < hi && p.z > lo) return false;
  const south = p.z >= hi;
  if (south ? tz >= hi : tz <= lo) return false;           // not going over
  if ((south ? p.z - hi : lo - p.z) > 1.2) return false;   // walk up to the boom first
  // about half of them duck under it while the train is still far off
  return !(R.pedDuckOk && ((p.id * 2654435761) >>> 0) % 100 < 50);
}

/** For crowd.js: on the tracks with the gate down. Get across! */
export function pedHurry(S, p) {
  const X = S.W.special.crossing;
  return !!X && S.rail.gate.state !== 'open' && inGateZone(X, p.x, p.z, 0);
}

/** Last resort: nobody is ever run over. Anyone on foot in a train's way is shoved clear. */
function shovePeds(S, t) {
  const C = S.C.rail, X = S.W.special.crossing;
  const front = t.x, tail = t.x - t.dir * t.len;
  if (Math.max(front, tail) < -X.x1 - 3 || Math.min(front, tail) > X.x1 + 3) return;
  for (const p of S.peds) {
    if (p.hidden || !inGateZone(X, p.x, p.z, 0)) continue;
    const dz = p.z - t.z;
    if (Math.abs(dz) >= C.halfW + 0.3 || p.x < Math.min(front, tail) - 1 || p.x > Math.max(front, tail) + 1) continue;
    p.z = t.z + (dz >= 0 ? 1 : -1) * (C.halfW + 0.32);
  }
}

/* ----------------------------------------------------------------- gateman */

function keeper(S, dt) {
  const R = S.rail, p = R.keeper, g = R.gate;
  if (!p) return;
  const d = S.dog, X = S.W.special.crossing;
  R.keeperCD -= dt;
  // he winds the booms by hand, then stands out with his flag for the train
  if (g.state === 'closing' || g.state === 'opening') p.mode = 'crank';
  else if (g.state === 'closed') p.mode = R.trains.some((t) => toRoad(S, t) < 60 && !tailClear(S, t, 0)) ? 'flag' : 'stand';
  else p.mode = 'squat'; // waiting for the next one, on his heels
  p.yaw = p.mode === 'flag' ? Math.PI : p.home.yaw; // flag: facing the line
  if (p.react > 0) return;
  const near = dist2(p.x, p.z, d.x, d.z) < 30 * 30;
  if (!near || R.keeperCD > 0) return;
  if (g.state === 'closing' && g.t < 0.5) {
    say(S, p, SPEECH.gateman);
    R.keeperCD = 6;
  } else if (g.state !== 'open' && d.z < X.z1 && d.z > X.z0 && Math.abs(d.x) < 40) {
    say(S, p, SPEECH.gatemanDog);
    R.keeperCD = 5;
  }
}

/* --------------------------------------------------------------------- dog */

function collideDog(S, d) {
  const R = S.rail, C = S.C.rail;
  const r = S.C.dog.radius;
  for (const t of R.trains) {
    const dz = d.z - t.z;
    if (Math.abs(dz) >= C.halfW + r || d.y > ROOF_Y) continue;
    const front = t.x, tail = t.x - t.dir * t.len;
    if (d.x < Math.min(front, tail) - r || d.x > Math.max(front, tail) + r) continue;
    const ahead = t.dir * (d.x - front);
    if (ahead > -1.5 && t.v > 1 && d.invuln <= 0) { hitByTrain(S, t, dz); return; }
    // alongside a coach: the side of the train is a moving wall
    const s = clearSide(t, dz, C.halfW + r);
    d.z = t.z + s * (C.halfW + r);
    if (d.vz * s < 0) d.vz = 0;
  }
}

/** Which side of a train to put the dog out on: his own, unless that is off the map. */
function clearSide(t, dz, w) {
  const s = dz >= 0 ? 1 : -1;
  return Math.abs(t.z + s * w) > PLAY_HALF - 0.2 ? -s : s;
}

function hitByTrain(S, t, dz) {
  const d = S.dog, C = S.C.rail;
  const s = clearSide(t, dz, C.halfW + S.C.dog.radius + 0.05);
  d.needs.health -= C.hitDamage;
  d.needs.mood -= 15;
  d.scaredT = 6;
  // flung off the line, sideways and on along the train's way
  d.vx = t.dir * t.v * 0.55;
  d.vz = s * 6.5;
  d.vy = 5;
  d.z = t.z + s * (C.halfW + S.C.dog.radius + 0.05);
  d.onGround = false;
  d.action = { kind: 'knock', t: 0, dur: 1.3 };
  d.invuln = 3;
  d.sitting = d.lying = d.sleeping = d.begging = false;
  if (d.carry) { const it = d.carry; it.state = 'air'; it.vx = it.vz = 0; it.vy = 1; d.carry = null; }
  d.crossHit = true;
  S.day.hits++;
  S.totals.hits++;
  emit(S, 'hit', { dmg: C.hitDamage, vtype: 'train', x: d.x, z: d.z });
  emit(S, 'trainHit', { id: t.id });
  horn(S, t, true, true);
}

/* ----------------------------------------------------------------- queries */

/** Is the dog standing on the line itself (between the outer rails, either track)? */
export function onTrack(S, x, z) {
  const X = S.W.special.crossing;
  if (!X) return false;
  return X.tracks.some((T) => Math.abs(z - T.z) < 1.2);
}

/** The nearest train's distance (along the line) from (x, z), and whether it is coming. */
export function nearestTrain(S, x) {
  let best = null, bd = Infinity;
  for (const t of S.rail.trains) {
    const lo = Math.min(t.x, t.x - t.dir * t.len), hi = Math.max(t.x, t.x - t.dir * t.len);
    const dd = x < lo ? lo - x : x > hi ? x - hi : 0;
    if (dd < bd) { bd = dd; best = t; }
  }
  return best ? { t: best, d: bd } : null;
}
