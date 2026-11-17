/*
 * border.js — Seema Chowki, the border post at the west end of town, and its
 * retreat ceremony.
 *
 * All day two guards stand at each gate: ours in khaki with a red fan on the
 * turban, theirs across the line in black. Twice a day, at 10:30 and at 5:30,
 * the stands fill and the show begins: six soldiers a side march to their gates
 * with high kicks and stamps, the gates swing open, the leading soldiers square
 * up at the zero line, glare, flex and shake hands, and both flags come down
 * together to the bugle. Then the gates slam shut and everyone goes home. Both
 * crowds cheer their own side; both sides put on the same show.
 *
 * A dog who wanders over the white line is booted straight back into India.
 *
 * Its own dice (S.border.rng), like the trains and the street, so none of this
 * reshuffles the rest of the town. The soldiers and the crowd in the stands are
 * not passers-by: they live here, not in S.peds.
 */

import { makeRng, rand, pick, clamp, dist2, approachAngle, hex } from './util.js';
import { emit, say, groundAt, kickDog } from './simcore.js';
import { makePerson } from './crowd.js';
import { SPEECH } from './data.js';

/** When the retreat ceremony begins (game hours). */
export const RETREAT_AT = [10.5, 17.5];

// The running order, in real seconds from the start.
const T = { march: 14, solo: 34, open: 46, faceoff: 49, shake: 55, flags: 58, close: 78, back: 80, disperse: 96, end: 110 };
const UNIFORM = {
  IN: { top: hex('#a08757'), accent: hex('#c62828'), turban: hex('#a08757') },
  PK: { top: hex('#1f2024'), accent: hex('#3b3d44'), turban: hex('#1f2024') },
};

export function init(S) {
  const B = S.W.special.border;
  if (!B) { S.border = null; return; }
  const rng = makeRng((S.seed * 2246822519 + S.clock.day * 3266489917 + 3) >>> 0);
  const st = S.border = {
    rng, phase: 'idle', t: 0, which: -1, done: {},
    gate: 1, gateTarget: 1, flagUp: 1, crowdOn: 0,
    soldiers: [], crowd: [],
    chantCD: 3, kickCD: 0, dogInParade: false, watched: false,
  };
  const who = { rng, nextId: 3e6, C: S.C };
  // six a side; the first two of each keep guard at the gate when there is no show
  for (const side of ['IN', 'PK']) {
    const east = side === 'IN' ? 1 : -1; // which way is home: India is east (+x)
    const U = UNIFORM[side];
    for (let i = 0; i < 6; i++) {
      const p = makePerson(who, { kind: 'manMustache', female: false, kid: false });
      const sentry = i < 2 ? (side === 'IN' ? B.sentriesIN : B.sentriesPK)[i] : null;
      const row = Math.floor(i / 2), lane = i % 2 ? 1 : -1;
      const sol = {
        id: p.id, side, i, kind: 'soldier', colors: [p.colors[0], U.top, U.accent, U.turban], scale: rand(rng, 1.03, 1.09), h: 2.35,
        x: 0, y: 0.18, z: 0, yaw: 0, speed: 0, mode: 'attention', hidden: !sentry, kickT: rand(rng, 1, 4),
        sentry,
        // the parade: from the far end of the road to a place in two files by the gate
        start: { x: side === 'IN' ? B.east - 1.5 - (2 - row) * 1.8 : B.west + 1 + (2 - row) * 1.8, z: B.centre + lane * 1.5 },
        spot: { x: (side === 'IN' ? B.gateIN : B.gatePK) + east * (1.6 + row * 1.8), z: B.centre + lane * 2.2 },
        lead: i === 0,
      };
      const home = sentry || sol.start;
      sol.x = home.x; sol.z = home.z;
      sol.yaw = -east * Math.PI / 2; // facing the line
      st.soldiers.push(sol);
    }
  }
  // the crowd in the stands, filling front row first when a ceremony is on
  const fill = (side, x0, x1, za, zb) => {
    const toward = za < B.road[0] ? 1 : -1;
    for (let k = 0; k < 3; k++) {
      const d = (zb - za) / 3;
      const z = toward > 0 ? zb - (k + 0.5) * d : za + (k + 0.5) * d;
      for (let x = x0 + 0.5; x < x1 - 0.4; x += 0.82 + rng() * 0.3) {
        if (rng() < 0.3) continue;
        const p = makePerson(who, { female: rng() < 0.35, kid: rng() < 0.15 });
        st.crowd.push({
          id: p.id, side, kind: p.kind, colors: p.colors, scale: p.scale, h: p.h,
          x: x + (rng() - 0.5) * 0.2, y: 0.18 + 0.5 * (k + 1), z: z + (rng() - 0.5) * 0.3,
          yaw: toward > 0 ? 0 : Math.PI, row: k, order: rng() + k * 0.4, flag: rng() < 0.35, ph: rng() * 10,
        });
      }
    }
  };
  for (const [x0, x1] of B.standsIN) { fill('IN', x0, x1, B.standN[0], B.standN[1]); fill('IN', x0, x1, B.standS[0], B.standS[1]); }
  for (const [x0, x1] of B.standsPK) { fill('PK', x0, x1, B.standN[0], B.standN[1]); fill('PK', x0, x1, B.standS[0], B.standS[1]); }
  st.crowd.sort((a, b) => a.order - b.order);
  st.crowd.forEach((c, i) => { c.rank = i / st.crowd.length; });
  // the gates are open and the flags up in the daytime, shut and down at night
  const h = S.clock.hours;
  const night = h < 6 || h >= RETREAT_AT[1] + 2.5;
  st.gate = st.gateTarget = night ? 0 : 1;
  st.flagUp = night ? 0 : 1;
  // arriving in the middle of one: it starts now
  RETREAT_AT.forEach((t0, i) => { if (h >= t0 && h < t0 + 0.4) start(S, i); });
}

/** Soldiers are solid (softly) for the dog and anyone walking past. */
export function insertGrid(S) {
  const st = S.border;
  if (!st) return;
  for (const s of st.soldiers) if (!s.hidden && Math.abs(s.x) <= 86) S.grid.insert('guard', s, s.x, s.z, 0.28);
}

function start(S, which) {
  const st = S.border;
  st.phase = 'gather'; st.t = 0; st.which = which;
  st.done[S.clock.day + ':' + which] = true;
  st.gateTarget = 0;
  st.dogInParade = false; st.watched = false;
  for (const s of st.soldiers) {
    s.mode = 'attention'; s.yaw = s.side === 'IN' ? -Math.PI / 2 : Math.PI / 2;
    if (s.sentry) continue; // the guards on duty keep their posts until the march
    s.x = s.start.x; s.z = s.start.z; s.hidden = true;
  }
  emit(S, 'retreatStart', { which });
}

/* -------------------------------------------------------------------- step */

export function step(S, dt) {
  const st = S.border;
  if (!st) return;
  const B = S.W.special.border, h = S.clock.hours;
  // the timetable
  if (st.phase === 'idle') {
    RETREAT_AT.forEach((t0, i) => { if (h >= t0 && h < t0 + 0.4 && !st.done[S.clock.day + ':' + i]) start(S, i); });
    // a quarter of an hour's warning
    RETREAT_AT.forEach((t0, i) => {
      const key = S.clock.day + ':warn' + i;
      if (h >= t0 - 0.25 && h < t0 && !st.done[key]) { st.done[key] = true; emit(S, 'retreatSoon', { which: i }); }
    });
    // the flags go up again first thing, and after the morning show
    if (h >= 6 && h < RETREAT_AT[1] && st.flagUp < 1) st.flagUp = Math.min(1, st.flagUp + dt / 8);
    if (h >= 6 && h < RETREAT_AT[1] && st.gateTarget === 0) st.gateTarget = 1;
  } else ceremony(S, st, B, dt);
  // the gates swing toward where they should be; a slam is quick
  const sp = st.phase === 'close' ? 1.4 : 0.38;
  st.gate = st.gate < st.gateTarget ? Math.min(st.gateTarget, st.gate + sp * dt) : Math.max(st.gateTarget, st.gate - sp * dt);
  // the crowd comes and goes
  const want = st.phase === 'idle' ? 0 : st.phase === 'disperse' ? 0 : 1;
  st.crowdOn = want > st.crowdOn ? Math.min(want, st.crowdOn + dt / 12) : Math.max(want, st.crowdOn - dt / 12);
  if (st.phase === 'idle') sentries(S, st, dt);
  for (const s of st.soldiers) s.y = groundAt(S, s.x, s.z, s.y + 0.3);
  dogAtTheLine(S, st, B, dt);
}

function walkTo(s, x, z, speed, dt) {
  const dx = x - s.x, dz = z - s.z, l = Math.hypot(dx, dz);
  if (l < 0.12) { s.speed = 0; return true; }
  const k = Math.min(l, speed * dt);
  s.x += (dx / l) * k; s.z += (dz / l) * k;
  s.yaw = approachAngle(s.yaw, Math.atan2(dx, dz), 8 * dt);
  s.speed = speed;
  return false;
}

/** Between shows: the sentries stand their posts, and step out to stretch now and then. */
function sentries(S, st, dt) {
  for (const s of st.soldiers) {
    if (!s.sentry) { s.hidden = true; continue; }
    if (s.busy > 0) { s.busy -= dt; continue; }
    s.hidden = false;
    if (walkTo(s, s.sentry.x, s.sentry.z, 1.1, dt)) {
      s.yaw = approachAngle(s.yaw, s.side === 'IN' ? -Math.PI / 2 : Math.PI / 2, 4 * dt);
      s.mode = 'attention';
    } else s.mode = 'march';
  }
}

/** The show, from the first chant to the last soldier marching home. */
function ceremony(S, st, B, dt) {
  st.t += dt;
  const t = st.t, rng = st.rng;
  const prev = st.phase;
  st.phase = t < T.march ? 'gather' : t < T.solo ? 'march' : t < T.open ? 'solo' : t < T.faceoff ? 'open'
    : t < T.shake ? 'faceoff' : t < T.flags ? 'shake' : t < T.close ? 'flags' : t < T.back ? 'close'
      : t < T.disperse ? 'back' : t < T.end ? 'disperse' : 'idle';
  if (st.phase !== prev) phaseStarts(S, st, B, prev);
  if (st.phase === 'idle') return;
  // the crowds chant, each for their own side
  st.chantCD -= dt;
  if (st.chantCD <= 0 && st.phase !== 'disperse') {
    st.chantCD = rand(rng, 2.2, 4.5);
    const side = rng() < 0.55 ? 'IN' : 'PK';
    const c = pickVisible(st, side);
    if (c && dist2(c.x, c.z, S.dog.x, S.dog.z) < 45 * 45) say(S, c, side === 'IN' ? SPEECH.chantIN : SPEECH.chantPK, { time: 2.2 });
    if (dist2(B.gateIN, B.centre, S.dog.x, S.dog.z) < 70 * 70) emit(S, 'roar', { x: c ? c.x : B.line, z: B.centre, side });
  }
  // the soldiers
  for (const s of st.soldiers) {
    if (s.busy > 0) { s.busy -= dt; continue; } // off seeing a dog back over the line
    const home = s.side === 'IN' ? 1 : -1;
    const lineX = B.line + home * 0.7;
    switch (st.phase) {
      case 'gather':
        if (s.sentry) { s.hidden = false; s.mode = 'attention'; s.speed = 0; } else s.hidden = true;
        break;
      case 'march': {
        // two files to the gate, in from the far end of the road (the guards on
        // duty just step across to theirs); a high kick every few steps
        if (!s.sentry && t - T.march < (s.i - 2) * 0.7) { s.hidden = true; break; }
        s.hidden = false;
        if (s.mode === 'highkick' && (s.kickLeft -= dt) > 0) { s.speed = 0; break; }
        if (walkTo(s, s.spot.x, s.spot.z, 1.4, dt)) { s.mode = 'attention'; s.yaw = approachAngle(s.yaw, -home * Math.PI / 2, 6 * dt); break; }
        s.mode = 'march';
        if (!s.sentry && (s.kickT -= dt) <= 0) { s.kickT = rand(rng, 2.8, 4.4); highKick(S, s); }
        break;
      }
      case 'solo':
        // the leader struts to the gate and kicks for the crowd; the rest (in
        // their places by now, or nearly) stamp and stand
        if (s.lead) {
          if (s.mode === 'highkick' && (s.kickLeft -= dt) > 0) break;
          const gx = (s.side === 'IN' ? B.gateIN : B.gatePK) + home * 1.3;
          if (!walkTo(s, gx, B.centre, 1.6, dt)) { s.mode = 'march'; break; }
          s.yaw = -home * Math.PI / 2;
          if ((s.kickT -= dt) <= 0) { s.kickT = 1.6; highKick(S, s); } else s.mode = 'flex';
        } else {
          s.hidden = false;
          if (s.mode === 'highkick' && (s.kickLeft -= dt) > 0) break;
          if (!walkTo(s, s.spot.x, s.spot.z, 1.4, dt)) { s.mode = 'march'; break; }
          s.mode = Math.floor((t + s.i) * 0.7) % 3 === 0 ? 'stamp' : 'attention';
          s.yaw = approachAngle(s.yaw, -home * Math.PI / 2, 6 * dt);
        }
        break;
      case 'open':
        s.speed = 0;
        if (!s.lead) s.mode = 'attention';
        break;
      case 'faceoff':
        // the two leaders, nose to nose across the white line
        if (s.lead) {
          if (!walkTo(s, lineX, B.centre, 1.4, dt)) { s.mode = 'march'; break; }
          s.yaw = -home * Math.PI / 2;
          s.mode = Math.floor(t * 0.9) % 2 ? 'flex' : 'stamp';
        }
        break;
      case 'shake':
        if (s.lead) { s.mode = 'shake'; s.yaw = -home * Math.PI / 2; }
        break;
      case 'flags':
        s.mode = s.lead ? 'salute' : 'attention';
        s.speed = 0;
        break;
      case 'close':
        // the leaders step back through their gates before they slam
        if (s.lead) s.mode = walkTo(s, (s.side === 'IN' ? B.gateIN : B.gatePK) + home * 1.4, B.centre, 2.2, dt) ? 'attention' : 'march';
        break;
      case 'back':
      case 'disperse':
        // march off the way they came; the sentries go back to their posts
        if (s.hidden) break;
        {
          const to = s.sentry || s.start;
          if (walkTo(s, to.x, to.z, 1.3, dt)) {
            s.mode = 'attention';
            s.yaw = -home * Math.PI / 2;
            if (!s.sentry) s.hidden = true;
          } else s.mode = 'march';
        }
        break;
      default:
    }
  }
  // the flags come down together, slowly, to the bugle
  if (st.phase === 'flags') st.flagUp = clamp(1 - (t - T.flags) / (T.close - T.flags - 1), 0, 1);
  // and once the leaders are back on their own sides: bang
  if (st.phase === 'close' && t - T.close > 1.5 && st.gateTarget !== 0) {
    st.gateTarget = 0;
    bootOut(S, st, B); // any dog still between the gates is shown out first
    emit(S, 'gateSlam', { x: B.line, z: B.centre });
  }
  // a dog in the parade: the crowd loves it
  const d = S.dog;
  if (!st.dogInParade && (st.phase === 'march' || st.phase === 'solo') && d.z > B.road[0] && d.z < B.road[1] && d.x < B.east && d.x > B.line) {
    if (st.soldiers.some((s) => !s.hidden && s.side === 'IN' && dist2(s.x, s.z, d.x, d.z) < 4 * 4)) {
      st.dogInParade = true;
      emit(S, 'paradeDog', {});
      const c = pickVisible(st, 'IN');
      if (c) say(S, c, SPEECH.paradeDog, { time: 2.6 });
    }
  }
}

function phaseStarts(S, st, B, prev) {
  const near = dist2(B.gateIN, B.centre, S.dog.x, S.dog.z) < 70 * 70;
  switch (st.phase) {
    case 'march':
      for (const s of st.soldiers) { s.x = s.start.x; s.z = s.start.z; s.kickT = 1 + s.i * 0.7; }
      break;
    case 'solo':
      for (const s of st.soldiers) if (s.lead) s.kickT = 0.8;
      break;
    case 'open':
      st.gateTarget = 1;
      if (near) emit(S, 'gateSwing', { x: B.line, z: B.centre });
      break;
    case 'shake':
      emit(S, 'handshake', { x: B.line, z: B.centre });
      break;
    case 'flags':
      emit(S, 'bugle', { x: B.line, z: B.centre });
      break;
    case 'close':
      // the dog saw it all, close up
      if (dist2(B.gateIN, B.centre, S.dog.x, S.dog.z) < 40 * 40) { st.watched = true; emit(S, 'retreatWatched', {}); }
      break;
    case 'idle':
      st.which = -1;
      // the morning show ends with the gates open again; the evening's stay shut
      st.gateTarget = S.clock.hours < 14 ? 1 : 0;
      for (const s of st.soldiers) { if (!s.sentry) s.hidden = true; }
      break;
    default:
  }
  if (st.phase === 'disperse' && prev !== 'disperse') emit(S, 'retreatEnd', {});
}

function highKick(S, s) {
  s.mode = 'highkick';
  s.kickLeft = 1.1;
  s.speed = 0;
  if (dist2(s.x, s.z, S.dog.x, S.dog.z) < 60 * 60) emit(S, 'stomp', { x: s.x, z: s.z, side: s.side });
}

function pickVisible(st, side) {
  const vis = st.crowd.filter((c) => c.side === side && c.rank < st.crowdOn);
  return vis.length ? pick(st.rng, vis) : null;
}

/* ------------------------------------------------------- the dog at the line */

/**
 * The gates are walls when shut. Over the white line, the nearest of their
 * guards marches up and boots the dog back where he came from.
 */
function dogAtTheLine(S, st, B, dt) {
  const d = S.dog, r = S.C.dog.radius;
  st.kickCD -= dt;
  // closed gates: a wall across the road (whichever side of it he is on)
  const onRoad = d.z > B.road[0] && d.z < B.road[1];
  if (onRoad && st.gate < 0.5) {
    for (const gx of [B.gateIN, B.gatePK]) {
      const side = (d.prevX === undefined ? d.x : d.prevX) >= gx ? 1 : -1;
      if (Math.abs(d.x - gx) < r + 0.06) { d.x = gx + side * (r + 0.06); if (d.vx * side < 0) d.vx = 0; }
    }
  }
  d.prevX = d.x;
  if (d.x >= B.line - 0.1 || d.invuln > 0) { st.chasing = null; return; }
  // over the line: their nearest man comes for him
  let g = st.chasing;
  if (!g) {
    let bd = Infinity;
    for (const s of st.soldiers) {
      if (s.hidden || s.side !== 'PK') continue;
      const q = dist2(s.x, s.z, d.x, d.z);
      if (q < bd) { bd = q; g = s; }
    }
    if (!g) return;
    st.chasing = g;
    say(S, g, SPEECH.borderGuard, { time: 2 });
  }
  g.busy = 3;
  if (dist2(g.x, g.z, d.x, d.z) > 1.0 * 1.0) {
    walkTo(g, d.x - 0.6, d.z, 4.2, dt);
    g.mode = 'run';
    return;
  }
  if (st.kickCD > 0) return;
  // one swift boot, eastward, into India
  g.mode = 'kick'; g.speed = 0;
  g.yaw = Math.atan2(d.x - g.x, d.z - g.z);
  if (kickDog(S, d.x - 1.2, d.z, 8.5, 4, g, { border: true })) {
    st.kickCD = 2;
    st.chasing = null;
    const c = pickVisible(st, 'IN') || pickVisible(st, 'PK');
    if (c) say(S, c, SPEECH.borderLaugh, { time: 2 });
  }
}

/** When the gates close on him, a dog between them is shown back to our side. */
function bootOut(S, st, B) {
  const d = S.dog;
  if (!(d.z > B.walk[0] && d.z < B.walk[1] && d.x < B.gateIN + 0.3 && d.x > B.gatePK)) return;
  const s = st.soldiers.find((q) => q.side === 'IN' && q.lead) || st.soldiers[0];
  d.x = Math.max(d.x, B.line + 0.3);
  kickDog(S, d.x - 1.5, d.z, 7, 2, s, { border: true });
  d.prevX = B.gateIN + 1; // he is on our side of the gate now
}
