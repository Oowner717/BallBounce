/*
 * scenes.js — the people with names, and the little stories that repeat daily.
 *
 *   Raju the chai wallah   sit nicely by the stall and a biscuit may come your way
 *   the halwai             leaves samosas on an open counter; take one and run
 *   Aunty                  feeds the street dogs morning and evening, calls you by name
 *   the pujari             rings the bell for the evening aarti and hands out prasad
 *   the traffic cop        waves his arms at the chowk and blows his whistle
 *   the cricket kids       bowl, bat and lose the ball across the maidan
 *
 * They are ordinary crowd people (so they draw, collide and react like anyone)
 * with role 'special' and a little state machine each.
 */

import { pick, rand, clamp, dist2, approachAngle, angleDiff, lerp } from './util.js';
import { emit, say, spawnItem, tossToDog, removeItem, groundAt } from './simcore.js';
import { makePerson, startReaction } from './crowd.js';
import { SPEECH, DOG_NAME } from './data.js';

function special(S, opts) {
  const p = makePerson(S, Object.assign({ role: 'special' }, opts));
  p.state = 'special';
  p.mode = opts.mode || 'stand';
  S.peds.push(p);
  return p;
}

const inWindow = (h, w) => h >= w[0] && h < w[1];

export function init(S) {
  const W = S.W, sp = W.special;
  const sc = S.scenes = {};

  // Raju, the chai wallah
  if (sp.chai) {
    const p = special(S, { kind: 'manMustache', female: false, kid: false, x: sp.chai.vendor.x, z: sp.chai.vendor.z, yaw: sp.chai.vendor.yaw + Math.PI, mode: 'talk' });
    p.yaw = Math.atan2(sp.chai.front.x - p.x, sp.chai.front.z - p.z);
    p.name = 'Raju';
    p.disp = 'kind';
    p.onBeg = chaiBeg;
    p.begReach = 2.8; // the counter keeps a dog about two metres off
    sc.chai = { p, cd: 0, call: rand(S.rng, 5, 15) };
  }
  // the halwai behind his counter
  if (sp.halwai) {
    const v = sp.halwai.vendor;
    const p = special(S, { kind: 'kurta', female: false, kid: false, x: v.x, z: v.z, yaw: 0, mode: 'stand' });
    p.colors[1] = [0.97, 0.96, 0.9];
    p.onBeg = halwaiBeg;
    sc.halwai = { p, home: { x: v.x, z: v.z }, samosas: 6, state: 'idle', t: 0, refill: 0, call: rand(S.rng, 6, 16) };
  }
  // Aunty
  if (sp.aunty) {
    const p = special(S, { kind: 'saree', female: true, kid: false, x: sp.aunty.door.x, z: sp.aunty.door.z, yaw: sp.aunty.yaw, mode: 'stand' });
    p.colors[3] = [0.55, 0.55, 0.55];
    p.name = 'Aunty';
    p.disp = 'kind';
    p.hidden = true;
    p.onBeg = (S2, q) => { startReaction(S2, q, 'pet', 2.6, 'pet'); say(S2, q, SPEECH.pet); };
    sc.aunty = { p, out: false, served: -1, petted: false, call: 0 };
  }
  // the pujari at the temple
  if (W.spawns.priest) {
    const q = W.spawns.priest;
    const p = special(S, { kind: 'kurta', female: false, kid: false, x: q.x, z: q.z, yaw: q.yaw, mode: 'stand', uniform: 'saffron' });
    p.y = 1.2;
    p.disp = 'kind';
    p.onBeg = priestBeg;
    p.begReach = 5.2; // he sees a dog sitting at the foot of the steps from the top
    sc.priest = { p, bell: 0, given: -1, rang: false };
  }
  // the traffic cop on the island
  if (W.spawns.cop) {
    const q = W.spawns.cop;
    const p = special(S, { kind: 'cap', female: false, kid: false, x: q.x, z: q.z, yaw: q.yaw, mode: 'cop', uniform: 'khaki' });
    p.colors[3] = [0.85, 0.82, 0.75];
    p.y = 0.45;
    p.disp = 'neutral';
    sc.cop = { p, whistle: rand(S.rng, 4, 10) };
  }
  // auto drivers passing the time at the stand
  if (sp.autoStand) {
    const a = sp.autoStand;
    for (let i = 0; i < 2; i++) {
      const p = special(S, { kind: pick(S.rng, ['man', 'manMustache', 'cap']), female: false, kid: false, x: a.x0 + 3 + i * 1.1, z: a.z1 - 0.6, yaw: i ? -Math.PI / 2 : Math.PI / 2, mode: 'talk', uniform: 'khaki' });
      p.disp = 'neutral';
    }
  }
  initCricket(S);
}

export function step(S, dt) {
  const sc = S.scenes;
  const h = S.clock.hours;
  if (sc.chai) chai(S, sc.chai, dt);
  if (sc.halwai) halwai(S, sc.halwai, dt);
  if (sc.aunty) aunty(S, sc.aunty, dt, h);
  if (sc.priest) priest(S, sc.priest, dt, h);
  if (sc.cop) {
    const c = sc.cop;
    c.whistle -= dt;
    c.p.mode = c.p.react > 0 ? c.p.mode : 'cop';
    if (c.whistle <= 0) {
      c.whistle = rand(S.rng, 5, 12);
      if (dist2(c.p.x, c.p.z, S.dog.x, S.dog.z) < 45 * 45 && h > 7 && h < 21) emit(S, 'whistle', { x: c.p.x, z: c.p.z });
      if (S.rng() < 0.15 && dist2(c.p.x, c.p.z, S.dog.x, S.dog.z) < 20 * 20) say(S, c.p, SPEECH.cop);
    }
  }
  cricket(S, dt);
}

/* --------------------------------------------------------------------- chai */

function chai(S, c, dt) {
  c.call -= dt;
  if (c.call <= 0) {
    c.call = rand(S.rng, 10, 24);
    if (dist2(c.p.x, c.p.z, S.dog.x, S.dog.z) < 22 * 22 && S.clock.hours > 6 && S.clock.hours < 22) {
      say(S, c.p, SPEECH.vendor.chai);
      emit(S, 'vendorCall', { x: c.p.x, z: c.p.z });
    }
  }
  if (c.p.react <= 0) c.p.mode = 'talk';
}

function chaiBeg(S, p) {
  const c = S.scenes.chai;
  const now = S.clock.absH * 60;
  if (now >= c.cd) {
    c.cd = now + S.C.scenes.chaiBiscuitCooldown;
    startReaction(S, p, 'feed', 2.2, 'feed');
    say(S, p, [['Le, ' + DOG_NAME + ', biscuit!', 'Here, a biscuit!'], ['Chai nahi, biscuit le', 'No tea for you — have a biscuit']]);
    tossToDog(S, 'biscuit', p.x, p.y + 1.0, p.z, { gift: true });
    emit(S, 'chaiBiscuit', {});
    emit(S, 'fed', { by: p.id });
  } else {
    p.petCD = S.t + 25;
    say(S, p, [['Abhi nahi, baad mein', 'Not now, later'], ['Ek hi milega, chal', 'Only one a day, go on']]);
  }
}

/* ------------------------------------------------------------------- halwai */

function halwai(S, H, dt) {
  const p = H.p;
  const d = S.dog;
  H.t += dt;
  H.refill += S.gameDt * 60;
  if (H.refill > S.C.scenes.samosaRefill) { H.refill = 0; H.samosas = Math.min(6, H.samosas + 1); }
  switch (H.state) {
    case 'notice':
      if (H.t > 0.45) {
        H.state = 'chase'; H.t = 0;
        say(S, p, SPEECH.thief);
        emit(S, 'thiefShout', { x: p.x, z: p.z });
      }
      p.mode = 'startle';
      break;
    case 'chase': {
      const dx = d.x - p.x, dz = d.z - p.z, l = Math.hypot(dx, dz) || 1;
      const sp = S.C.scenes.halwaiChaseSpeed;
      const nx = p.x + (dx / l) * sp * dt, nz = p.z + (dz / l) * sp * dt;
      p.x = nx; p.z = nz; // he will run into the road after a thief
      p.yaw = Math.atan2(dx, dz);
      p.speed = sp; p.mode = 'run';
      const stolen = d.carry && d.carry.stolen ? d.carry : null;
      if (l < 0.85) {
        // caught: he takes it back and gives the thief a piece of his mind
        if (stolen) removeItem(S, stolen);
        d.scaredT = 3;
        d.needs.mood -= 10;
        say(S, p, [['Bhaag yahan se!', 'Get out of here!'], ['Pakad liya!', 'Got you!']]);
        emit(S, 'caught', {});
        H.state = 'return'; H.t = 0;
      } else if (H.t > S.C.scenes.halwaiChaseTime || l > S.C.scenes.halwaiGiveUp || !stolen) {
        say(S, p, [['Agli baar dekh lunga!', "I'll get you next time!"], ['Arre yaar...', 'Oh, come on...']]);
        if (stolen) { stolen.stolen = false; emit(S, 'escaped', {}); }
        H.state = 'return'; H.t = 0;
      }
      break;
    }
    case 'return': {
      const dx = H.home.x - p.x, dz = H.home.z - p.z, l = Math.hypot(dx, dz);
      if (l < 0.2) { p.x = H.home.x; p.z = H.home.z; p.yaw = 0; p.speed = 0; H.state = 'idle'; p.mode = 'stand'; break; }
      p.x += (dx / l) * 1.3 * dt; p.z += (dz / l) * 1.3 * dt;
      p.yaw = Math.atan2(dx, dz); p.speed = 1.3; p.mode = 'walk';
      break;
    }
    default:
      p.speed = 0;
      if (p.react <= 0) p.mode = 'stand';
      H.call -= dt;
      if (H.call <= 0) {
        H.call = rand(S.rng, 10, 22);
        if (dist2(p.x, p.z, d.x, d.z) < 22 * 22 && S.clock.hours > 7 && S.clock.hours < 22) say(S, p, SPEECH.vendor.samosa);
      }
  }
}

/** The dog reached up to the counter and took a samosa. Returns the item, or null if the tray is empty. */
export function grabSamosa(S) {
  const H = S.scenes.halwai;
  if (!H || H.samosas <= 0) return null;
  H.samosas--;
  const it = spawnItem(S, 'samosa', S.dog.x, 1, S.dog.z, 0, 0, 0, { stolen: true });
  it.state = 'carried';
  S.dog.carry = it;
  emit(S, 'stole', {});
  if (H.state === 'idle') { H.state = 'notice'; H.t = 0; }
  return it;
}

export function samosasLeft(S) {
  return S.scenes.halwai ? S.scenes.halwai.samosas : 0;
}

function halwaiBeg(S, p) {
  const H = S.scenes.halwai;
  if (H.state !== 'idle') return;
  if (S.rng() < 0.35) {
    startReaction(S, p, 'feed', 2.0, 'feed');
    say(S, p, [['Le, tooti hui hai', "Here — it's a broken one"], ['Chal, ek tukda', 'Fine, one piece']]);
    tossToDog(S, 'samosa', p.x, p.y + 1.0, p.z, { gift: true });
    emit(S, 'fed', { by: p.id });
  } else {
    startReaction(S, p, 'shoo', 1.4, 'shoo');
    say(S, p, SPEECH.shoo);
    emit(S, 'shooed', { by: p.id });
  }
}

/* -------------------------------------------------------------------- aunty */

function aunty(S, A, dt, h) {
  const p = A.p;
  const sp = S.W.special.aunty;
  const win = S.C.scenes.auntyFeed.findIndex((w) => inWindow(h, w));
  const key = S.clock.day * 10 + win;
  if (win >= 0 && !A.out) {
    A.out = true;
    p.hidden = false;
    p.x = sp.door.x; p.z = sp.door.z;
    p.yaw = sp.yaw;
    A.petted = false;
    if (A.served !== key) {
      A.served = key;
      // two rotis and a bowl of milk by the step
      spawnItem(S, 'roti', sp.bowl.x + 0.15, 0.3, sp.bowl.z, 0, 0, 0, { aunty: true });
      spawnItem(S, 'roti', sp.bowl.x - 0.2, 0.3, sp.bowl.z + 0.1, 0, 0, 0, { aunty: true });
      spawnItem(S, 'milk', sp.bowl.x, 0.2, sp.bowl.z - 0.35, 0, 0, 0, { aunty: true });
      say(S, p, SPEECH.aunty, { time: 4 });
      emit(S, 'auntyCall', { x: sp.bowl.x, z: sp.bowl.z });
      A.call = 20;
    }
  }
  if (win < 0 && A.out) {
    A.out = false;
    p.hidden = true;
  }
  if (!A.out) return;
  A.call -= dt;
  if (A.call <= 0) {
    A.call = rand(S.rng, 18, 30);
    if (S.items.some((it) => it.aunty && !it.gone)) {
      say(S, p, [[DOG_NAME + '! Aaja!', DOG_NAME + '! Come!'], ['Khaana thanda ho raha hai!', 'Your food is getting cold!']]);
      emit(S, 'auntyCall', { x: sp.bowl.x, z: sp.bowl.z, again: true });
    }
  }
  const dd = dist2(p.x, p.z, S.dog.x, S.dog.z);
  if (!A.petted && dd < 1.8 * 1.8 && p.react <= 0) {
    A.petted = true;
    startReaction(S, p, 'pet', 2.8, 'pet');
    say(S, p, [['Mera ' + DOG_NAME + '!', 'My ' + DOG_NAME + '!'], ['Kitna bada ho gaya tu', "Look how big you've grown"]]);
  }
  if (p.react <= 0) p.mode = 'stand';
}

/** Where Aunty takes in a dog that fainted. */
export function auntyRescue(S) {
  const sp = S.W.special.aunty;
  if (!sp) return null;
  const A = S.scenes.aunty;
  if (A) {
    A.p.hidden = false;
    A.out = true;
    say(S, A.p, [['Hai Ram! Kya ho gaya tujhe?', "Oh god! What happened to you?"]], { time: 5 });
  }
  return { x: sp.bowl.x + 0.6, z: sp.bowl.z + 0.6 };
}

/* ------------------------------------------------------------------- priest */

function priest(S, P, dt, h) {
  const p = P.p;
  const w = S.C.scenes.aarti;
  const during = inWindow(h, w);
  if (during) {
    P.bell -= dt;
    p.mode = p.react > 0 ? p.mode : 'pray';
    if (P.bell <= 0) {
      P.bell = 0.9;
      emit(S, 'bell', { x: -36, z: -42 });
    }
    if (!P.rang) { P.rang = true; emit(S, 'aarti', {}); }
  } else {
    P.rang = false;
    if (p.react <= 0) p.mode = 'stand';
    P.bell -= dt;
    if (P.bell <= 0) {
      P.bell = rand(S.rng, 20, 50);
      if (h > 6 && h < 21 && dist2(-36, -42, S.dog.x, S.dog.z) < 40 * 40) emit(S, 'bell', { x: -36, z: -42, single: true });
    }
  }
}

function priestBeg(S, p) {
  const P = S.scenes.priest;
  const h = S.clock.hours;
  const w = S.C.scenes.aarti;
  const late = h >= w[0] && h < w[1] + 0.6;
  if (late && P.given !== S.clock.day) {
    P.given = S.clock.day;
    startReaction(S, p, 'feed', 2.4, 'feed');
    say(S, p, SPEECH.priest);
    tossToDog(S, 'ladoo', p.x, p.y + 1.1, p.z, { gift: true, prasad: true });
    emit(S, 'fed', { by: p.id });
  } else {
    startReaction(S, p, 'pet', 2.0, 'pet');
    say(S, p, [['Jai ho', 'Blessings'], ['Shaam ko aana, prasad milega', 'Come in the evening for prasad']]);
  }
}

/* ------------------------------------------------------------------ cricket */

function initCricket(S) {
  const P = S.W.special.pitch;
  if (!P) return;
  const kids = [];
  const mk = (kind, x, z, yaw, mode) => {
    const p = special(S, { kind, kid: true, x, z, yaw, mode, female: kind === 'girl' });
    p.home = { x, z };
    p.disp = 'kind';
    kids.push(p);
    return p;
  };
  const batter = mk('batter', P.batter.x, P.batter.z, -Math.PI / 2, 'bat');
  const bowler = mk('kid', P.bowler.x - 4, P.bowler.z, Math.PI / 2, 'stand');
  const f1 = mk('girl', 44, -49, 0, 'field');
  const f2 = mk('kid', 40, -34, Math.PI, 'field');
  const keeper = mk('kid', P.batter.x + 2.2, P.batter.z, -Math.PI / 2, 'field');
  const ball = spawnItem(S, 'ball', bowler.x, 1.0, bowler.z, 0, 0, 0, { cricket: true });
  ball.state = 'held';
  S.cricket = { kids, batter, bowler, fielders: [f1, f2, keeper], keeper, ball, holder: bowler, phase: 'ready', t: rand(S.rng, 2, 4), chaser: null, dogT: 0, runs: 0 };
}

function kidMove(S, p, tx, tz, speed, dt) {
  const dx = tx - p.x, dz = tz - p.z, l = Math.hypot(dx, dz);
  if (l < 0.15) { p.speed = 0; return true; }
  const st = Math.min(l, speed * dt);
  p.x += (dx / l) * st; p.z += (dz / l) * st;
  p.yaw = approachAngle(p.yaw, Math.atan2(dx, dz), 9 * dt);
  p.speed = speed;
  p.mode = speed > 2.2 ? 'run' : 'walk';
  return l < 0.3;
}

function holdBall(S, p) {
  const K = S.cricket;
  K.holder = p;
  K.ball.state = 'held';
  K.ball.vx = K.ball.vy = K.ball.vz = 0;
}

function throwBall(S, from, tx, tz, flight) {
  const K = S.cricket;
  const b = K.ball;
  b.x = from.x; b.z = from.z; b.y = from.y + 1.4 * from.scale;
  const T = flight;
  b.vx = (tx - b.x) / T;
  b.vz = (tz - b.z) / T;
  b.vy = (0.8 - b.y) / T + 0.5 * 19.6 * T;
  b.state = 'air';
  K.holder = null;
}

function cricket(S, dt) {
  const K = S.cricket;
  if (!K) return;
  const C = S.C.cricket;
  const d = S.dog;
  const b = K.ball;
  const P = S.W.special.pitch;
  const h = S.clock.hours;
  const playing = h > 7.2 && h < 18.6 && S.weather !== 'rain';
  K.t -= dt;
  for (const k of K.kids) {
    k.hidden = !playing;
    if (k.react > 0) continue;
  }
  if (!playing) {
    if (b.state === 'held' && K.holder) { b.x = K.holder.x; b.z = K.holder.z; b.y = 1; }
    return;
  }
  // the ball goes where its holder goes
  if (b.state === 'held' && K.holder) {
    b.x = K.holder.x + Math.sin(K.holder.yaw) * 0.3;
    b.z = K.holder.z + Math.cos(K.holder.yaw) * 0.3;
    b.y = K.holder.y + 1.0 * K.holder.scale;
  }
  // the dog has it!
  if (b.state === 'carried') {
    if (K.phase !== 'dog') {
      K.phase = 'dog'; K.dogT = 0;
      say(S, K.batter, SPEECH.kids);
      emit(S, 'kidsShout', {});
    }
    K.dogT += dt;
    // everybody chases the dog, laughing
    for (const k of K.kids) {
      if (k.react > 0) continue;
      if (K.dogT < C.giveUp) kidMove(S, k, d.x - Math.sin(k.id) * 0.9, d.z - Math.cos(k.id) * 0.9, 3.6, dt);
      else { k.speed = 0; k.mode = 'stand'; }
    }
    if (K.dogT > C.giveUp && !K.sulked) { K.sulked = true; say(S, K.batter, [['Arre yaar, Bhura!', 'Oh come on, Bhura!']]); }
    return;
  }
  if (K.phase === 'dog') {
    // the dog let it go — was it a return?
    const nearKid = K.kids.some((k) => dist2(k.x, k.z, b.x, b.z) < 4 * 4) && dist2(b.x, b.z, (P.x0 + P.x1) / 2, P.z) < 14 * 14;
    K.sulked = false;
    if (nearKid && K.dogT > 0.5) {
      emit(S, 'fetch', {});
      say(S, K.batter, SPEECH.kidsThanks, { time: 3 });
      for (const k of K.kids) if (dist2(k.x, k.z, d.x, d.z) < 5 * 5 && k.react <= 0) startReaction(S, k, 'cheer', 1.6, 'cheer');
      const petter = K.kids.reduce((a, k) => (dist2(k.x, k.z, d.x, d.z) < dist2(a.x, a.z, d.x, d.z) ? k : a), K.kids[0]);
      if (petter.react <= 0) startReaction(S, petter, 'pet', 2.2, 'pet');
      emit(S, 'petted', { by: petter.id, kid: true });
    }
    K.phase = 'loose';
  }

  switch (K.phase) {
    case 'ready': {
      // bowler walks back to the top of his run-up
      const bw = K.bowler;
      if (K.holder !== bw && b.state === 'held') holdBall(S, bw);
      const atMark = kidMove(S, bw, P.bowler.x - 5, P.bowler.z, 1.4, dt);
      for (const f of K.fielders) if (f.react <= 0) { kidMove(S, f, f.home.x, f.home.z, 1.6, dt); if (f.speed === 0) { f.mode = 'field'; f.yaw = approachAngle(f.yaw, Math.atan2(P.batter.x - f.x, P.batter.z - f.z), 4 * dt); } }
      if (K.batter.react <= 0) { kidMove(S, K.batter, P.batter.x, P.batter.z, 1.4, dt); if (K.batter.speed === 0) { K.batter.mode = 'bat'; K.batter.yaw = -Math.PI / 2; } }
      if (atMark && K.t <= 0 && K.holder === bw) { K.phase = 'runup'; bw.yaw = Math.PI / 2; }
      break;
    }
    case 'runup': {
      const bw = K.bowler;
      if (kidMove(S, bw, P.bowler.x, P.bowler.z, 3.4, dt)) {
        bw.mode = 'bowl';
        bw.speed = 0;
        throwBall(S, bw, P.batter.x - 0.4, P.batter.z + rand(S.rng, -0.2, 0.2), 0.75);
        K.phase = 'bowled'; K.t = 0.75;
        emit(S, 'bowled', {});
      }
      break;
    }
    case 'bowled':
      if (K.t <= 0.08 && b.state === 'air') {
        // the swing
        K.batter.mode = 'swing';
        K.batter.modeReset = true;
        if (S.rng() < 0.78) {
          const ang = Math.PI + rand(S.rng, -1.15, 1.15); // back down the ground, westward
          const sp = rand(S.rng, C.hitSpeed[0], C.hitSpeed[1]);
          b.vx = Math.cos(ang) * sp; b.vz = Math.sin(ang) * sp; b.vy = rand(S.rng, 2.5, 7);
          b.state = 'air';
          emit(S, 'batHit', { x: b.x, z: b.z });
          if (S.rng() < 0.4) say(S, pick(S.rng, K.fielders), SPEECH.kids);
          K.phase = 'loose';
        } else {
          K.phase = 'loose';
          if (S.rng() < 0.3) { say(S, K.keeper, [['Howzat!', ''], ['Out hai!', "He's out!"]]); }
        }
      }
      break;
    case 'loose': {
      // nearest kid runs for the ball
      if (b.state === 'held') { K.phase = 'return'; break; }
      let best = null, bd = Infinity;
      for (const k of K.fielders.concat([K.bowler])) {
        const q = dist2(k.x, k.z, b.x, b.z);
        if (q < bd) { bd = q; best = k; }
      }
      K.chaser = best;
      for (const k of K.kids) {
        if (k.react > 0) continue;
        if (k === best) {
          if (b.state !== 'air' || b.y < 1.5) {
            if (kidMove(S, k, b.x, b.z, S.C.cricket.fielderSpeed, dt) && b.y < 1.4) { holdBall(S, k); K.phase = 'return'; K.t = 0.4; }
          }
        } else if (k === K.batter) {
          if (k.speed === 0 || k.mode !== 'swing') { kidMove(S, k, P.batter.x, P.batter.z, 1.2, dt); if (k.speed === 0) { k.mode = 'bat'; k.yaw = -Math.PI / 2; } }
        } else {
          k.speed = 0;
          if (k.mode !== 'cheer') k.mode = 'field';
          k.yaw = approachAngle(k.yaw, Math.atan2(b.x - k.x, b.z - k.z), 5 * dt);
        }
      }
      // a ball that rolls off into the city is chased down eventually or replaced
      if (Math.abs(b.x - 44) > 40 || Math.abs(b.z + 42) > 40) { holdBall(S, K.bowler); K.phase = 'ready'; K.t = 2; }
      break;
    }
    case 'return': {
      const k = K.holder;
      if (!k) { K.phase = 'loose'; break; }
      if (k === K.bowler) { K.phase = 'ready'; K.t = rand(S.rng, C.bowlEvery[0], C.bowlEvery[1]); break; }
      k.speed = 0;
      k.mode = 'bowl';
      if (K.t <= 0) {
        throwBall(S, k, K.bowler.x, K.bowler.z, Math.max(0.5, Math.sqrt(dist2(k.x, k.z, K.bowler.x, K.bowler.z)) / 14));
        K.phase = 'toBowler';
      }
      break;
    }
    case 'toBowler':
      if (b.state !== 'air') {
        if (dist2(b.x, b.z, K.bowler.x, K.bowler.z) < 2.5 * 2.5) { holdBall(S, K.bowler); K.phase = 'ready'; K.t = rand(S.rng, C.bowlEvery[0], C.bowlEvery[1]); }
        else K.phase = 'loose';
      } else if (dist2(b.x, b.z, K.bowler.x, K.bowler.z) < 1 && b.y < 1.8) { holdBall(S, K.bowler); K.phase = 'ready'; K.t = rand(S.rng, C.bowlEvery[0], C.bowlEvery[1]); }
      break;
    default:
      K.phase = 'ready';
  }
  for (const k of K.kids) k.y = groundAt(S, k.x, k.z, 0.3);
}
