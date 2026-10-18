/*
 * tasks.js — the day's to-do list, and Gully Cred.
 *
 * Every day brings five tasks. Day one teaches the basics (eat, drink, get
 * petted, scatter pigeons, nap in the shade); later days draw from a wider
 * pool. Tasks listen to sim events, so anything the dog does counts no matter
 * how it happened. Cred comes from tasks and from good moments in general, and
 * climbing the ranks earns a collar (and respect).
 */

import { emit } from './simcore.js';
import { makeRng } from './util.js';

/**
 * ev: the event that counts. filter: optional test on the event. count: how many.
 * where: optional hint location {x, z} (or a function of the sim) for the sniff
 * trail and the minimap marker.
 */
export const TASKS = {
  eat: { title: 'Breakfast time', desc: 'Eat something', ev: 'ate', count: 1, reward: 15, hint: 'Sit nicely (E) near the chai stall, or sniff around (F).' },
  drink: { title: 'Thirsty work', desc: 'Drink some water', ev: 'drank', count: 1, reward: 15, hint: 'The hand pump in Pump Wala Chowk always leaks.', where: (S) => S.W.pois.water.find((w) => w.kind === 'pump') },
  pets3: { title: 'Good boy', desc: 'Get petted 3 times', ev: 'petted', count: 3, reward: 20, hint: 'Walk up to someone and sit (E). Kind people will pet you.' },
  pigeons: { title: 'Pigeon panic', desc: 'Scatter a flock of pigeons', ev: 'scatter', count: 1, reward: 15, hint: 'Run at the pigeons by the clock tower, or bark (B).', where: (S) => S.flocks[0] },
  nap: { title: 'Siesta', desc: 'Nap in the shade after noon', ev: 'napMinute', count: 45, reward: 25, unit: 'min', hint: 'Lie down (Z twice) under a tree or an awning between 12 and 4.' },
  samosa: { title: 'Samosa heist', desc: 'Steal a samosa and get away', ev: 'escaped', count: 1, reward: 35, hint: "Sharma Sweets on MG Road leaves them on the counter. Grab one (E) and run (Shift)!", where: (S) => S.W.special.halwai && S.W.special.halwai.front },
  fetch: { title: 'Gully cricket', desc: 'Bring the ball back to the kids', ev: 'fetch', count: 1, reward: 30, hint: 'The kids play on the maidan. Grab the ball (E), then drop it (E) near them.', where: (S) => S.W.special.pitch && { x: 44, z: -42 } },
  mark: { title: 'My street', desc: 'Mark 5 posts or trees', ev: 'marked', count: 5, reward: 20, hint: 'Stand by a lamp post or a tree and press E.' },
  friend: { title: 'Make a friend', desc: 'Win over one of the street dogs', ev: 'friend', count: 1, reward: 40, hint: 'Greet a dog (E) and stay calm near it. Sharing food helps a lot.' },
  cross: { title: 'Road warrior', desc: 'Cross MG Road 3 times unhurt', ev: 'crossed', count: 3, reward: 20, hint: 'Use the zebra crossings by the chowk. Watch for autos!' },
  explore: { title: 'Know your gali', desc: 'Visit 6 different places', ev: 'newZone', count: 6, reward: 20, hint: 'The place name shows at the top of the screen.' },
  prasad: { title: 'Blessings', desc: 'Get prasad at the evening aarti', ev: 'fed', filter: (e, S) => e.by === (S.scenes.priest && S.scenes.priest.p.id), count: 1, reward: 30, hint: 'At 6:30 pm the pujari hands out ladoos. Sit by the temple steps.', where: (S) => ({ x: -36, z: -37.6 }) },
  aunty: { title: "Aunty's favourite", desc: "Eat at Aunty's house", ev: 'ate', filter: (e) => e.aunty, count: 1, reward: 25, hint: 'Aunty feeds the dogs at 7:30 am and 6:30 pm in Pump Wala Chowk.', where: (S) => S.W.special.aunty && S.W.special.aunty.bowl },
  puppies: { title: 'Big brother', desc: "Share food with Lali's puppies", ev: 'sharedFood', filter: (e) => e.puppy, count: 1, reward: 40, hint: 'On a full belly, E picks food up instead of eating it. Carry it to Gali No. 7 and drop it (E) by the puppies.', where: (S) => { const l = S.dogs.find((d) => d.key === 'lali'); return l && { x: l.x, z: l.z }; } },
  goats: { title: 'Goat rodeo', desc: 'Chase the goats on the maidan', ev: 'goatChased', count: 3, reward: 15, hint: 'Run (Shift) at the goats on the maidan.', where: (S) => S.goats[0] },
  rummage: { title: 'Treasure hunter', desc: 'Find food in the garbage', ev: 'rummage', filter: (e) => e.found, count: 2, reward: 20, hint: 'Rummage (E) through a garbage heap. Sniff (F) to find one.', where: (S) => S.W.pois.garbage[0] },
  cow: { title: 'Traffic police', desc: 'Bark a cow off the road', ev: 'cowMoved', filter: (e) => e.fromRoad && e.byDog, count: 1, reward: 25, hint: 'A cow is lying in MG Road, holding up the traffic. Bark (B) at it a few times.', where: (S) => S.cows[0] },
  bike: { title: 'Scooter chaser', desc: 'Chase a scooter for 3 seconds', ev: 'bikeChase', count: 1, reward: 20, hint: 'Sprint (Shift) alongside a scooter or motorbike. Careful!' },
  pets8: { title: 'Mohalla darling', desc: 'Get petted 8 times', ev: 'petted', count: 8, reward: 30, hint: 'Kids and kind aunties love you. Sit (E) near them.' },
  biscuit: { title: 'Chai and biscuit', desc: 'Get a biscuit from Raju', ev: 'chaiBiscuit', count: 1, reward: 15, hint: 'Sit (E) in front of the chai stall at the chowk.', where: (S) => S.W.special.chai && S.W.special.chai.front },
  drinks3: { title: 'Water hopper', desc: 'Drink from 3 different places', ev: 'drank', unique: (e) => e.src, count: 3, reward: 20, hint: 'Puddles, the pump, the temple trough, Aunty\'s bowl...' },
  bark10: { title: 'Loudmouth', desc: 'Bark 15 times', ev: 'bark', count: 15, reward: 10, hint: 'Press B. Everyone will love it. Mostly.' },
};

const DAY1 = ['eat', 'drink', 'pets3', 'pigeons', 'nap'];
const POOL = ['samosa', 'fetch', 'mark', 'friend', 'cross', 'explore', 'prasad', 'aunty', 'puppies', 'goats', 'rummage', 'cow', 'bike', 'pets8', 'biscuit', 'drinks3', 'bark10'];

export function tasksForDay(seed, day) {
  if (day <= 1) return DAY1.slice();
  const rng = makeRng(seed * 31 + day * 977);
  const pool = POOL.slice();
  const out = [];
  // day two always offers the two signature heists
  if (day === 2) { out.push('samosa', 'fetch'); }
  while (out.length < 5 && pool.length) {
    const k = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export function startDay(S) {
  const ids = tasksForDay(S.seed, S.clock.day);
  S.tasks = ids.map((id) => ({ id, def: TASKS[id], progress: 0, done: false, seen: [] }));
  S.taskCursor = S.events.length;
}

export function rankFor(S, cred) {
  const R = S.C.cred.ranks;
  let r = 0;
  for (let i = 0; i < R.length; i++) if (cred >= R[i][0]) r = i;
  return r;
}

export function addCred(S, n, why) {
  if (!n) return;
  const before = rankFor(S, S.cred);
  S.cred += n;
  S.day.cred += n;
  emit(S, 'cred', { n, why });
  const after = rankFor(S, S.cred);
  if (after > before) {
    S.rank = after;
    emit(S, 'rank', { rank: after, title: S.C.cred.ranks[after][1] });
    if (after >= 2 && !S.collar) { S.collar = true; emit(S, 'collar', {}); }
  }
}

/** Cred for good moments, independent of tasks. */
const MOMENT = { petted: 'pet', fed: 'fed', scatter: 'scatter', fetch: 'fetch', friend: 'friend', escaped: 'stole', crossed: 'crossed' };

export function step(S) {
  const C = S.C.cred;
  for (let i = S.taskCursor; i < S.events.length; i++) {
    const e = S.events[i];
    if (MOMENT[e.type]) addCred(S, C[MOMENT[e.type]], e.type);
    if (e.type === 'petted') { S.day.petted++; S.totals.petted++; }
    else if (e.type === 'honk' && e.atDog) S.day.honks++;
    else if (e.type === 'scatter') S.day.scatters++;
    for (const t of S.tasks) {
      if (t.done || t.def.ev !== e.type) continue;
      if (t.def.filter && !t.def.filter(e, S)) continue;
      if (t.def.unique) {
        const key = t.def.unique(e);
        if (t.seen.includes(key)) continue;
        t.seen.push(key);
      }
      t.progress += e.n || 1;
      if (t.progress >= t.def.count) {
        t.progress = t.def.count;
        t.done = true;
        emit(S, 'taskDone', { id: t.id, title: t.def.title, reward: t.def.reward });
        addCred(S, t.def.reward, 'task');
        if (S.tasks.every((q) => q.done)) emit(S, 'allTasksDone', {});
      }
    }
  }
  S.taskCursor = S.events.length;
}

/** Where the first unfinished task with a location wants the dog to go. */
export function taskTarget(S) {
  for (const t of S.tasks) {
    if (t.done || !t.def.where) continue;
    const w = t.def.where(S);
    if (w && Number.isFinite(w.x)) return { x: w.x, z: w.z, task: t };
  }
  return null;
}
