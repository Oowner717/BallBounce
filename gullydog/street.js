/*
 * street.js — street life that keeps its own hours: the kids who work the queue
 * at the railway gate, and the rope walker's show in Mandir Square.
 *
 * THE PHATAK KIDS. Three of them hang about on the verge by the gateman's hut:
 * a boy with a bunch of balloons, a girl with jasmine and marigold strings, and
 * a little one who just asks for a rupee. When the booms come down and the
 * traffic backs up, out they go, window to window down the queue. When the
 * booms start to lift they run back before anything moves. They are kind to a
 * dog who sits nicely, and the little one shares his roti.
 *
 * THE ROPE WALKER. A family of street performers: a girl who walks a rope
 * strung between two bamboo tripods, with a balancing pole (and, some
 * crossings, a brass pot on her head); her brother on the dholak; their mother
 * calling the crowd and going round with the plate. They play late morning and
 * early evening. A crowd gathers and cheers each crossing. A dog who barks
 * makes her wobble; a dog who jumps for the crowd gets cheered too.
 *
 * Everyone here rolls the street's own dice (S.street.rng), as the trains do, so
 * none of it reshuffles the rest of the town.
 */

import { makeRng, rand, pick, dist2, hex } from './util.js';
import { surfAt, SURF } from './world.js';
import { emit, say, groundAt } from './simcore.js';
import { makePerson, startReaction } from './crowd.js';
import { SPEECH } from './data.js';

/** When the rope walker plays (game hours). */
export const SHOW_HOURS = [[10, 12.5], [16, 18.75]];

export function init(S) {
  const W = S.W;
  const st = S.street = {
    rng: makeRng((S.seed * 69069 + S.clock.day * 1013 + 5) >>> 0),
    kids: [],
    show: null,
    dung: [],   // cow pats: {x, z, born}, wherever the cows have been
  };
  // the morning's pats are already down round the cows' haunts
  for (const c of S.W.spawns.cows || []) {
    for (let k = 0; k < 2; k++) {
      const a = st.rng() * Math.PI * 2, r = 1 + st.rng() * Math.min(4, c.r || 4);
      dropPat(S, c.x + Math.cos(a) * r, c.z + Math.sin(a) * r);
    }
  }
  const who = { rng: st.rng, nextId: 2e6, C: S.C };
  const person = (opts) => {
    const p = makePerson(who, Object.assign({ role: 'special' }, opts));
    p.state = 'special';
    p.mode = opts.mode || 'stand';
    p.y = groundAt(S, p.x, p.z, 1);
    S.peds.push(p);
    return p;
  };

  // the kids at the phatak
  const X = W.special.crossing;
  if (X && X.kids) {
    const K = X.kids;
    const defs = [
      { kind: 'kid', female: false, ware: 'balloons', lines: SPEECH.kidBalloons, idle: 'stand' },
      { kind: 'girl', female: true, ware: 'garlands', lines: SPEECH.kidFlowers, idle: 'squat' },
      { kind: 'kid', female: false, ware: null, lines: SPEECH.kidCoins, idle: 'talk', small: true },
    ];
    defs.forEach((d, i) => {
      const home = { x: K.x + i * 0.75, z: K.z - (i === 1 ? 0.55 : 0) };
      const p = person({ kind: d.kind, kid: true, female: d.female, x: home.x, z: home.z, yaw: -Math.PI / 2, mode: d.idle });
      if (d.small) { p.scale *= 0.86; p.h = 1.75 * p.scale + 0.25; p.snack = 'roti'; }
      p.disp = 'kind';
      p.ware = d.ware;
      p.name = 'phatakKid';
      st.kids.push({ p, i, home, lines: d.lines, idle: d.idle, state: 'home', v: null, t: rand(st.rng, 0.5, 3), via: null });
    });
  }

  // the rope walker and her family, and the crowd that comes to watch
  const R = W.special.show;
  if (R) {
    const girl = person({ kind: 'girl', kid: true, female: true, x: R.rest.x, z: R.rest.z, mode: 'squat' });
    girl.scale = 0.7; girl.h = 1.75 * girl.scale + 0.25;
    girl.colors[1] = hex('#e0245e'); girl.colors[2] = hex('#ffcc33');
    girl.disp = 'kind';
    const drummer = person({ kind: 'kid', kid: true, female: false, x: R.drum.x, z: R.drum.z, yaw: R.drum.yaw, mode: 'drum' });
    drummer.disp = 'kind';
    drummer.ware = 'dholak';
    const mother = person({ kind: 'saree', female: true, kid: false, x: R.rest.x - 0.6, z: R.rest.z + 0.7, mode: 'knees' });
    mother.colors[1] = hex('#2e7d32'); mother.colors[2] = hex('#c62828');
    mother.disp = 'neutral';
    const crowd = R.spots.map(([x, z], i) => {
      const p = person({ x, z, kid: st.rng() < 0.25, mode: 'stand' });
      p.hidden = true;
      p.disp = pick(st.rng, ['kind', 'kind', 'neutral']);
      return { p, spot: { x, z }, from: { x: R.from[i][0], z: R.from[i][1] }, state: 'away' };
    });
    st.show = {
      girl, drummer, mother, crowd,
      on: false, phase: 'rest', t: 0, x: R.x0 + 0.7, dir: 1, laps: 0, pot: false,
      wobble: 0, trickCD: 0, callCD: 3, plate: 0, plateT: 0, cheerT: 0,
    };
  }
}

export function step(S, dt) {
  if (S.street.kids.length) kids(S, dt);
  if (S.street.show) show(S, dt);
  dung(S, dt);
}

/* ---------------------------------------------------------------- cow dung */

const PAT_GROUND = new Set([SURF.ROAD, SURF.WALK, SURF.GALI, SURF.PLAZA, SURF.DIRT, SURF.MARKET, SURF.CROSS]);

function dropPat(S, x, z) {
  if (!PAT_GROUND.has(surfAt(S.W, x, z))) return;
  const D = S.street.dung;
  D.push({ x, z, born: S.t, yaw: S.street.rng() * Math.PI * 2 });
  if (D.length > 26) D.shift();
}

/** Cows leave pats where they stand; a dog who trots through one knows about it. */
function dung(S, dt) {
  const st = S.street;
  for (const c of S.cows) {
    if (st.rng() < dt / 95) dropPat(S, c.x - Math.sin(c.yaw) * 0.95, c.z - Math.cos(c.yaw) * 0.95);
  }
  const d = S.dog;
  if (d.speed < 0.3 || !d.onGround) return;
  for (const pt of st.dung) {
    if (pt.stepped || dist2(pt.x, pt.z, d.x, d.z) > 0.36 * 0.36) continue;
    pt.stepped = true;
    d.needs.mood = Math.max(0, d.needs.mood - 2);
    d.dungT = 14; // smelly paw prints for a while (main.js)
    emit(S, 'dungStep', { x: pt.x, z: pt.z });
  }
}

/* ---------------------------------------------------------------- helpers */

/** Walk (or run) p straight toward (x, z). True on arrival. */
function moveTo(S, p, x, z, speed, dt) {
  const dx = x - p.x, dz = z - p.z, l = Math.hypot(dx, dz);
  if (l < 0.2) { p.speed = 0; return true; }
  const s = Math.min(l, speed * dt);
  p.x += (dx / l) * s; p.z += (dz / l) * s;
  p.yaw = Math.atan2(dx, dz);
  p.speed = speed;
  p.mode = speed > 2 ? 'run' : 'walk';
  p.y = groundAt(S, p.x, p.z, p.y + 0.3);
  return false;
}

const face = (p, x, z) => { p.yaw = Math.atan2(x - p.x, z - p.z); };
const dogNear = (S, p, r) => dist2(p.x, p.z, S.dog.x, S.dog.z) < r * r;

/* -------------------------------------------------------- the phatak kids */

/** Where a kid stands to work this vehicle: by the driver's window (the right), or the other side if that is full. */
function windowSpot(S, v) {
  const rx = -v.dirz, rz = v.dirx; // the driver's side
  for (const s of [1, -1]) {
    const x = v.x + rx * s * (v.halfW + 0.42) + v.dirx * v.len * 0.12;
    const z = v.z + rz * s * (v.halfW + 0.42) + v.dirz * v.len * 0.12;
    let free = true;
    for (const o of S.vehicles) {
      if (o === v || Math.abs(o.x - x) > 6 || Math.abs(o.z - z) > 6) continue;
      for (const c of o.circles) if (dist2(x, z, o.x + o.dirx * c.off, o.z + o.dirz * c.off) < (c.r + 0.3) * (c.r + 0.3)) { free = false; break; }
      if (!free) break;
    }
    if (free) return { x, z };
  }
  return null;
}

/** The next vehicle in the queue to try: waiting on the town side, not being worked by another kid. */
function nextVehicle(S, k, X) {
  let best = null, bd = Infinity;
  for (const v of S.vehicles) {
    if (!v.gateWait || v.z < X.gateZ[0] || v.z > X.gateZ[0] + 34 || Math.abs(v.x) > 5) continue;
    if (S.street.kids.some((o) => o !== k && o.v === v)) continue;
    if (k.tried && k.tried.includes(v.id)) continue;
    const d = dist2(v.x, v.z, k.p.x, k.p.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function kids(S, dt) {
  const X = S.W.special.crossing, g = S.rail.gate;
  const working = g.state === 'closing' || g.state === 'closed';
  for (const k of S.street.kids) {
    const p = k.p;
    if (p.react > 0) continue; // petting the dog: the crowd code has them
    k.t -= dt;
    // the booms are going up: everybody off the road, now
    if (!working && k.state !== 'home' && k.state !== 'back') { k.state = 'back'; k.v = null; k.tried = null; }
    switch (k.state) {
      case 'home':
        p.mode = k.idle; p.speed = 0;
        p.yaw = -Math.PI / 2 + (k.i - 1) * 0.5;
        if (working && g.k > 0.6 && k.t <= 0) {
          const v = nextVehicle(S, k, X);
          if (v) { k.v = v; k.state = 'out'; k.tried = [v.id]; } else k.t = 1.2;
        }
        break;
      case 'out': // to the corner of the pavement first, then down the queue
        if (moveTo(S, p, X.kids.kerb.x, X.kids.kerb.z, 1.7, dt)) k.state = 'go';
        break;
      case 'go': {
        const v = k.v;
        const spot = v && !v.gone && v.gateWait ? windowSpot(S, v) : null;
        if (!spot) { k.state = 'next'; break; }
        if (moveTo(S, p, spot.x, spot.z, 1.6, dt)) {
          k.state = 'pitch'; k.t = rand(S.street.rng, 3, 6);
          if (dogNear(S, p, 20)) say(S, p, k.lines);
        }
        break;
      }
      case 'pitch': {
        const v = k.v;
        if (!v || v.gone || !v.gateWait) { k.state = 'next'; break; }
        p.speed = 0;
        p.mode = 'beckon';
        face(p, v.x, v.z);
        if (k.t <= 0) {
          // a coin, a "not now", or nothing at all
          const roll = S.street.rng();
          if (roll < 0.35) {
            emit(S, 'coin', { x: p.x, z: p.z });
            if (dogNear(S, p, 20)) say(S, p, SPEECH.kidThanks2);
          } else if (roll < 0.6 && dogNear(S, p, 20)) say(S, v, SPEECH.driverKid, { h: v.h + 0.2 });
          k.state = 'next';
        }
        break;
      }
      case 'next': {
        const v = nextVehicle(S, k, X);
        if (v) { k.v = v; k.tried.push(v.id); k.state = 'go'; } else { k.state = 'back'; k.v = null; }
        break;
      }
      case 'back': // back to the verge, through the corner of the pavement
        if (!k.via) k.via = Math.abs(p.x - X.kids.kerb.x) > 0.5 ? 'kerb' : 'home';
        if (k.via === 'kerb') { if (moveTo(S, p, X.kids.kerb.x, X.kids.kerb.z, working ? 1.7 : 2.6, dt)) k.via = 'home'; }
        else if (moveTo(S, p, k.home.x, k.home.z, working ? 1.5 : 2.2, dt)) { k.state = 'home'; k.via = null; k.tried = null; k.t = rand(S.street.rng, 2, 5); }
        break;
      default:
    }
  }
}

/* ---------------------------------------------------------- the rope walker */

function show(S, dt) {
  const sh = S.street.show, R = S.W.special.show, h = S.clock.hours;
  const on = SHOW_HOURS.some(([a, b]) => h >= a && h < b);
  const night = h < 8.5 || h >= 20.5;
  const { girl, drummer, mother } = sh;
  for (const p of [girl, drummer, mother]) p.hidden = night;
  sh.trickCD -= dt;
  sh.cheerT = Math.max(0, sh.cheerT - dt);
  if (on && !sh.on) {
    sh.on = true; sh.phase = 'call'; sh.t = 8; sh.x = R.x0 + 0.7; sh.dir = 1; sh.laps = 0;
    for (const c of sh.crowd) if (c.state === 'away') { c.state = 'coming'; c.p.hidden = true; c.p.x = c.from.x; c.p.z = c.from.z; c.delay = rand(S.street.rng, 0, 9); }
    emit(S, 'showStart', { x: R.ring.x, z: R.ring.z });
  } else if (!on && sh.on) {
    sh.on = false; sh.phase = 'rest';
    for (const c of sh.crowd) if (c.state !== 'away') c.state = 'going';
  }
  crowd(S, sh, dt);
  // the family
  if (!sh.on) {
    girl.y = groundAt(S, R.rest.x, R.rest.z, 1);
    girl.x = R.rest.x; girl.z = R.rest.z; girl.mode = 'squat'; girl.speed = 0; girl.aloft = false; girl.ware = null; girl.hat = null;
    if (drummer.react <= 0) drummer.mode = 'knees';
    drummer.ware = null;
    if (mother.react <= 0) { mother.mode = 'knees'; mother.x = R.rest.x - 0.6; mother.z = R.rest.z + 0.7; mother.ware = null; }
    return;
  }
  drummer.ware = 'dholak';
  if (drummer.react <= 0) { drummer.mode = 'drum'; drummer.yaw = R.drum.yaw; }
  // the girl: up the tripod, along the rope, a pause and a turn at each end
  switch (sh.phase) {
    case 'call': // the drum starts, the crowd gathers, she waits at the foot of the tripod
      girl.x = R.rest.x; girl.z = R.rest.z; girl.mode = 'stand'; girl.speed = 0; girl.aloft = false;
      girl.y = groundAt(S, girl.x, girl.z, 1);
      face(girl, R.ring.x, R.ring.z);
      sh.t -= dt;
      if (sh.t <= 0) { sh.phase = 'walk'; sh.x = R.x0 + 0.7; sh.dir = 1; }
      break;
    case 'walk':
      sh.x += sh.dir * 0.36 * dt * (sh.wobble > 0 ? 0.2 : 1);
      girl.speed = sh.wobble > 0 ? 0.1 : 0.36;
      if ((sh.dir > 0 && sh.x >= R.x1 - 0.7) || (sh.dir < 0 && sh.x <= R.x0 + 0.7)) {
        sh.phase = 'turn'; sh.t = 2.4; sh.laps++;
        sh.cheerT = 1.8;
        emit(S, 'showCheer', { x: R.ring.x, z: R.ring.z });
        if (dogNear(S, girl, 25) && S.street.rng() < 0.5) say(S, pick(S.street.rng, sh.crowd).p, SPEECH.showCrowd);
        // a coin or two for the plate
        if (S.street.rng() < 0.7) { sh.plate++; emit(S, 'coin', { x: mother.x, z: mother.z }); }
      }
      break;
    case 'turn':
      girl.speed = 0;
      sh.t -= dt;
      if (sh.t <= 0) {
        sh.dir = -sh.dir; sh.phase = 'walk';
        if (sh.laps % 3 === 2) sh.pot = !sh.pot; // the brass pot goes up for a crossing or two
      }
      break;
    default:
  }
  if (sh.phase === 'walk' || sh.phase === 'turn') {
    girl.aloft = true;
    girl.x = sh.x; girl.z = R.z; girl.y = R.h;
    girl.yaw = sh.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    girl.mode = 'balance';
    girl.ware = 'pole';
    girl.hat = sh.pot ? 'pot' : null;
  }
  // a bark close by puts her off her stride
  sh.wobble = Math.max(0, sh.wobble - dt);
  girl.wobble = sh.wobble;
  const d = S.dog;
  if (d.barkedAt === S.t && girl.aloft && dogNear(S, girl, 8) && sh.wobble <= 0) {
    sh.wobble = 2.2;
    emit(S, 'showWobble', { x: girl.x, z: girl.z });
    say(S, mother, SPEECH.showBark);
    for (const c of sh.crowd) if (c.state === 'watch' && c.p.react <= 0) startReaction(S, c.p, 'startle', 1.0, 'startle');
  }
  // her mother goes round the crowd with the plate, calling people in
  if (mother.react <= 0) {
    mother.ware = 'plate';
    const ax = R.ring.x + Math.sin(S.t * 0.12) * 4.2, az = R.z + 2.35;
    if (moveTo(S, mother, ax, az, 0.6, dt)) { mother.mode = 'beckon'; face(mother, R.ring.x, R.z); }
    sh.callCD -= dt;
    if (sh.callCD <= 0) {
      sh.callCD = rand(S.street.rng, 9, 16);
      if (dogNear(S, mother, 22)) say(S, mother, SPEECH.showCall);
    }
  }
  // a dog doing tricks in front of the crowd: a jump in the ring, with her up on the rope
  if (girl.aloft && sh.trickCD <= 0 && jumpedNow(S)) {
    const r = R.ring;
    const ex = (d.x - r.x) / r.rx, ez = (d.z - r.z) / r.rz;
    if (ex * ex + ez * ez < 1) {
      sh.trickCD = 1.4;
      sh.cheerT = 1.8;
      emit(S, 'showTrick', { x: d.x, z: d.z });
      emit(S, 'showCheer', { x: r.x, z: r.z });
      if (S.street.rng() < 0.5) say(S, pick(S.street.rng, sh.crowd).p, SPEECH.showDog);
      if (S.street.rng() < 0.6) { sh.plate++; emit(S, 'coin', { x: mother.x, z: mother.z }); }
    }
  }
}

/** Did the dog jump this very step? (sim.js emits 'jump' before the street runs.) */
function jumpedNow(S) {
  for (let i = S.events.length - 1; i >= 0 && S.events[i].t === S.t; i--) if (S.events[i].type === 'jump') return true;
  return false;
}

/** The crowd: they wander in when the drum starts, watch and cheer, and drift off after. */
function crowd(S, sh, dt) {
  const R = S.W.special.show;
  for (const c of sh.crowd) {
    const p = c.p;
    if (p.react > 0) continue;
    switch (c.state) {
      case 'coming': // round the corner of the square after a while, then over to watch
        c.delay -= dt;
        if (c.delay > 0) break;
        p.hidden = false;
        if (moveTo(S, p, c.spot.x, c.spot.z, 1.1, dt)) c.state = 'watch';
        break;
      case 'watch': {
        p.speed = 0;
        const gx = sh.girl.aloft ? sh.girl.x : R.ring.x;
        face(p, gx, R.z);
        p.mode = sh.cheerT > 0 ? (p.kid ? 'cheer' : 'clap') : 'stand';
        break;
      }
      case 'going':
        if (moveTo(S, p, c.from.x, c.from.z, 1.1, dt)) {
          c.state = 'away';
          p.hidden = true;
          p.mode = 'stand';
        }
        break;
      default:
        p.hidden = true;
    }
  }
}
