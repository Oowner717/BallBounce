/*
 * power.js — the electricity, such as it is.
 *
 * A transformer on two poles at the corner of the maidan hums and spits the odd
 * spark, and the tangle of wires overhead does too (those sparks are only for
 * show: main.js makes them). Once a night the power goes: the street lamps and
 * the shop lights die, the generators cough into life, everyone says the same
 * thing ("Light gayi!"), and after a while a lineman from the electricity board
 * turns up with his ladder, climbs to the transformer, fiddles in a shower of
 * sparks, and the lights come back on to a cheer. Nobody gets hurt.
 *
 * A dog who lifts his leg against the transformer pole gets a tingle he will
 * remember, and nothing worse.
 *
 * Its own dice (S.power.rng), so a power cut does not reshuffle the town.
 */

import { makeRng, rand, dist2, hex } from './util.js';
import { emit, say, groundAt } from './simcore.js';
import { makePerson } from './crowd.js';
import { SPEECH } from './data.js';

export function init(S) {
  const X = S.W.special.transformer;
  const rng = makeRng((S.seed * 1597334677 + S.clock.day * 3812015801 + 11) >>> 0);
  const P = S.power = { rng, state: 'on', t: 0, day: S.clock.day, cutAt: rand(rng, 20.3, 21.6), done: false, level: 1, lineman: null, sparkCD: 1 };
  if (!X) return;
  const look = makePerson({ rng, nextId: 4e6, C: S.C }, { kind: 'cap', female: false, kid: false });
  P.lineman = {
    id: look.id, kind: 'cap', colors: [look.colors[0], hex('#56653a'), hex('#33363b'), hex('#f2c230')], scale: look.scale, h: look.h,
    x: X.walkIn.x, y: 0, z: X.walkIn.z, yaw: 0, mode: 'stand', speed: 0, hidden: true, phase: 'away', t: 0,
  };
  // a cut already under way when the day is loaded
  const h = S.clock.hours;
  if (h >= P.cutAt && h < P.cutAt + 0.3) cut(S, P);
}

function cut(S, P) {
  P.state = 'cut'; P.t = 0; P.done = true;
  emit(S, 'powerCut', {});
  react(S, SPEECH.powerCut, false);
}

/** A few people near the dog say what everyone says. */
function react(S, lines, cheer) {
  const d = S.dog;
  let n = 0;
  for (const p of S.peds) {
    if (n >= 3 || p.hidden || p.react > 0 || dist2(p.x, p.z, d.x, d.z) > 22 * 22) continue;
    if (p.role !== 'walker' && p.role !== 'vendor' && p.role !== 'keeper') continue;
    say(S, p, lines, { time: 2.6 });
    if (cheer && p.kid) { p.react = 1.2; p.reactKind = 'cheer'; p.mode = 'cheer'; }
    n++;
  }
}

export function step(S, dt) {
  const P = S.power, X = S.W.special.transformer;
  if (!X) return;
  const h = S.clock.hours;
  if (P.day !== S.clock.day) { P.day = S.clock.day; P.done = false; P.cutAt = rand(P.rng, 20.3, 21.6); }
  switch (P.state) {
    case 'on':
      if (!P.done && h >= P.cutAt && h < P.cutAt + 1) cut(S, P);
      break;
    case 'cut':
      // dark, and nothing happens for a while, as ever
      P.t += dt;
      if (P.t > 14) { P.state = 'fixing'; P.t = 0; startLineman(P, X); }
      break;
    case 'fixing':
      P.t += dt;
      lineman(S, P, X, dt);
      break;
    default:
  }
  // he walks home after the lights come back
  if (P.state === 'on' && P.lineman && P.lineman.phase !== 'away') lineman(S, P, X, dt);
  P.level = P.state === 'on' ? 1 : 0;
  zap(S);
}

function startLineman(P, X) {
  const L = P.lineman;
  L.hidden = false; L.phase = 'walk'; L.t = 0;
  L.x = X.walkIn.x; L.z = X.walkIn.z; L.y = 0;
}

function walkTo(L, x, z, speed, dt) {
  const dx = x - L.x, dz = z - L.z, l = Math.hypot(dx, dz);
  if (l < 0.1) { L.speed = 0; return true; }
  const k = Math.min(l, speed * dt);
  L.x += (dx / l) * k; L.z += (dz / l) * k;
  L.yaw = Math.atan2(dx, dz);
  L.speed = speed;
  return false;
}

function lineman(S, P, X, dt) {
  const L = P.lineman, rng = P.rng;
  const ground = groundAt(S, X.ladder.x, X.ladder.z, 1);
  L.t += dt;
  switch (L.phase) {
    case 'walk':
      L.mode = 'walk';
      L.y = groundAt(S, L.x, L.z, L.y + 0.3);
      if (walkTo(L, X.ladder.x, X.ladder.z, 1.2, dt)) { L.phase = 'climb'; L.t = 0; L.yaw = Math.atan2(X.poles[0][0] - L.x, X.poles[0][1] - L.z); emit(S, 'ladder', { x: L.x, z: L.z }); }
      break;
    case 'climb':
      L.mode = 'climb'; L.speed = 0.5;
      L.y = Math.min(ground + X.workY, L.y + 0.62 * dt);
      if (L.y >= ground + X.workY - 1e-6) { L.phase = 'work'; L.t = 0; P.sparkCD = 1.2; }
      break;
    case 'work':
      L.mode = 'work'; L.speed = 0;
      P.sparkCD -= dt;
      if (P.sparkCD <= 0) {
        P.sparkCD = rand(rng, 0.9, 2.4);
        emit(S, 'spark', { x: X.box.x + rand(rng, -0.4, 0.4), y: X.box.y + rand(rng, -0.2, 0.5), z: X.box.z, big: rng() < 0.3 });
      }
      if (L.t > 16) {
        // a last bang, and the lights come back on
        emit(S, 'spark', { x: X.box.x, y: X.box.y + 0.4, z: X.box.z, big: true });
        P.state = 'on';
        emit(S, 'powerOn', {});
        react(S, SPEECH.powerBack, true);
        L.phase = 'down'; L.t = 0;
      }
      break;
    case 'down':
      L.mode = 'climb'; L.speed = 0.5;
      L.y = Math.max(ground, L.y - 0.8 * dt);
      if (L.y <= ground + 1e-6) { L.phase = 'leave'; L.t = 0; }
      break;
    case 'leave':
      L.mode = 'walk';
      L.y = groundAt(S, L.x, L.z, L.y + 0.3);
      if (walkTo(L, X.walkIn.x, X.walkIn.z, 1.2, dt)) { L.phase = 'away'; L.hidden = true; L.mode = 'stand'; }
      break;
    default:
  }
}

/** A dog marking the transformer pole this step gets a jolt: a hop, a yelp, a lesson. */
function zap(S) {
  for (let i = S.events.length - 1; i >= 0 && S.events[i].t === S.t; i--) {
    const e = S.events[i];
    if ((e.type !== 'marked' && e.type !== 'markedAgain') || e.tag !== 'transformer') continue;
    const d = S.dog;
    d.vy = 3.4; d.onGround = false;
    d.scaredT = 3;
    d.needs.mood = Math.max(0, d.needs.mood - 8);
    d.needs.health = Math.max(1, d.needs.health - 1);
    d.zapT = 2.2;
    emit(S, 'zapped', { x: d.x, z: d.z });
    return;
  }
}
