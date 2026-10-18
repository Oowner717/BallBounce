/*
 * test.js — run with `node test.js`. Zero installs, node:assert only.
 *
 * Gully Dog is a simulation with a renderer on top, and most of what can go
 * wrong with it goes wrong quietly: a samosa nobody can reach, a crossing that
 * never counts, a jam that never clears, a crowd that freezes on the spot, a
 * save that eats a day. So most of these tests PLAY the game. They put Bhura
 * somewhere, press the buttons a player would press, and check that the street
 * answers.
 *
 * The rest guard what a browser would otherwise be the first to notice: the
 * world's invariants, the meshes and the texture atlas, the light at every
 * hour, the rig, and the offline cache.
 *
 * Set GULLYDOG_TEST_STACK=1 for full stack traces on failure.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CONFIG, cloneConfig } from './config.js';
import {
  generateWorld, surfAt, SURF, WALKABLE, PLAY_HALF, collidersNear, routePose, zoneAt, pedWalkable,
} from './world.js';
import {
  createSim, step, drainEvents, contextAction, newDay, weatherFor,
  defaultSave, serializeSave, loadSave, hashState,
} from './sim.js';
import { groundAt, spawnItem } from './simcore.js';
import { makePerson } from './crowd.js';
import { samosasLeft } from './scenes.js';
import { TASKS, tasksForDay, rankFor, addCred } from './tasks.js';
import { environment, sunDirection, lampLevel, nightFactor, WEATHERS } from './env.js';
import { atlasLayout, paintAtlas, paintNoise } from './textures.js';
import { buildCity } from './cityMesh.js';
import { buildAllModels, PEOPLE_KINDS } from './models.js';
import { Rig, newAnim, animateDog, poseDog, animateHuman, poseHuman, animateQuad, poseQuad, poseBird, poseVehicle } from './rig.js';
import { clamp } from './util.js';

/* -------------------------------------------------------------------------- */
/* Tiny runner                                                                */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log('\n' + name);
}

function test(name, fn) {
  const t0 = process.hrtime.bigint();
  try {
    fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    passed++;
    console.log('  ok   ' + name + (ms > 400 ? '  (' + ms.toFixed(0) + 'ms)' : ''));
  } catch (err) {
    failed++;
    failures.push({ group: currentGroup, name, err });
    console.log('  FAIL ' + name);
    console.log('       ' + String(err && err.message).split('\n').join('\n       '));
    if (process.env.GULLYDOG_TEST_STACK) console.log(err && err.stack);
  }
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const WORLD = generateWorld(7);
const DT = 1 / 30;
const IDLE = {};

/** No walkers and no traffic: the dog, the named characters, shopkeepers, vendors and animals. */
const QUIET = { crowd: { population: [[0, 0], [24, 0]] }, traffic: { maxVehicles: 0 } };

function merge(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') merge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}

function sim({ quiet = false, config = null, seed = 11, hour, weather = null, save = null, world = WORLD } = {}) {
  const C = merge(cloneConfig(quiet ? QUIET : null), config);
  if (hour !== undefined) C.time.startHour = hour;
  return createSim({ world, config: C, seed, weather, save });
}

/** Step for `secs` of real time. `input` is an object or (S, i) => object. Returns every event. */
function run(S, secs, input = IDLE) {
  const out = [];
  const n = Math.max(1, Math.round(secs / DT));
  for (let i = 0; i < n; i++) {
    step(S, DT, typeof input === 'function' ? input(S, i) : input);
    for (const e of drainEvents(S)) out.push(e);
  }
  return out;
}

/** Buttons are edge-triggered: hold one for a single frame, then let `after` seconds play out. */
function press(S, button, after = 0) {
  const out = run(S, DT, { [button]: true });
  return after > 0 ? out.concat(run(S, after)) : out;
}

/** Step until pred(S, events) holds or `max` seconds pass. Returns the events either way. */
function runUntil(S, max, input, pred) {
  const out = [];
  for (let i = 0, n = Math.round(max / DT); i < n; i++) {
    step(S, DT, typeof input === 'function' ? input(S, i) : input || IDLE);
    for (const e of drainEvents(S)) out.push(e);
    if (pred(S, out)) break;
  }
  return out;
}

const only = (evs, type, f) => evs.filter((e) => e.type === type && (!f || f(e)));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function setHour(S, h) {
  S.clock.hours = h;
  S.clock.absH = (S.clock.day - 1) * 24 + h;
}

/** Put the dog down at (x, z), standing, facing `face` (a yaw, or anything with x and z). */
function place(S, x, z, face) {
  const d = S.dog;
  d.x = x; d.z = z;
  d.vx = d.vy = d.vz = 0; d.speed = 0;
  d.y = groundAt(S, x, z, 1);
  d.onGround = true;
  d.action = null;
  d.sitting = d.lying = d.sleeping = d.begging = false;
  d.begT = 0;
  if (z < -7.6) d.side = 'N'; else if (z > 7.6) d.side = 'S';
  if (face !== undefined) d.yaw = typeof face === 'number' ? face : Math.atan2(face.x - x, face.z - z);
}

/** How far the dog's body is sunk into anything that is a wall at its height (0 = clear). */
function wallOverlap(S) {
  const d = S.dog, r = S.C.dog.radius, list = [];
  collidersNear(S.W, d.x, d.z, r + 0.5, list);
  let worst = 0;
  for (const i of list) {
    const c = S.W.colliders[i];
    if (c.y1 <= d.y + S.C.dog.stepUp + 1e-3 || c.y0 >= d.y + 0.55) continue;
    let pen;
    if (c.kind === 'box') pen = r - Math.hypot(d.x - clamp(d.x, c.x0, c.x1), d.z - clamp(d.z, c.z0, c.z1));
    else pen = c.r + r - Math.hypot(d.x - c.x, d.z - c.z);
    worst = Math.max(worst, pen);
  }
  return worst;
}

/** Walk toward (x, z) with the stick, as a player would, until within r or `until(S)` holds. */
function walkTo(S, x, z, { r = 0.35, max = 20, sprint = false, until = null } = {}) {
  const out = [];
  for (let i = 0, n = Math.round(max / DT); i < n; i++) {
    const d = S.dog;
    const dx = x - d.x, dz = z - d.z, l = Math.hypot(dx, dz);
    if (l < r || (until && until(S))) return out;
    const k = Math.min(1, 0.3 + l / 1.5);
    step(S, DT, { mx: (dx / l) * k, mz: (dz / l) * k, run: sprint });
    for (const e of drainEvents(S)) out.push(e);
  }
  assert.fail(`could not walk to (${x.toFixed(1)}, ${z.toFixed(1)}); stuck at (${S.dog.x.toFixed(2)}, ${S.dog.z.toFixed(2)})`);
}

/** A clear spot on open ground about `dist` from a point, with the dog placed there facing it. */
function placeNear(S, target, dist) {
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const x = target.x + Math.cos(a) * dist, z = target.z + Math.sin(a) * dist;
    if (!WALKABLE[surfAt(S.W, x, z)]) continue;
    place(S, x, z, target);
    if (wallOverlap(S) <= 0) return true;
  }
  return false;
}

/** Walk up to `target` from a few metres off until the action button offers `kind`. */
function approach(S, target, kind, dist = 2.5) {
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const x = target.x + Math.cos(a) * dist, z = target.z + Math.sin(a) * dist;
    if (!WALKABLE[surfAt(S.W, x, z)]) continue;
    place(S, x, z, target);
    if (wallOverlap(S) > 0) continue;
    try {
      walkTo(S, target.x, target.z, { r: 0.15, max: 4, until: (S2) => contextAction(S2).kind === kind });
    } catch (e) { continue; }
    if (contextAction(S).kind === kind) return;
  }
  assert.fail(`could not get close enough to (${target.x.toFixed(1)}, ${target.z.toFixed(1)}) to ${kind}`);
}

/** A stand-in person who stays where they are put. */
function addPerson(S, x, z, props = {}) {
  const p = makePerson(S, { role: 'special', kid: false, female: false, x, z });
  p.state = 'special';
  p.mode = 'stand';
  p.y = groundAt(S, x, z, 1);
  p.yaw = Math.atan2(S.dog.x - x, S.dog.z - z);
  Object.assign(p, props);
  S.peds.push(p);
  return p;
}

const ahead = (S, k) => ({ x: S.dog.x + Math.sin(S.dog.yaw) * k, z: S.dog.z + Math.cos(S.dog.yaw) * k });

/** Everything with a position has a finite one; the dog is in bounds with needs in range. */
function checkSane(S) {
  const d = S.dog;
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw']) assert.ok(Number.isFinite(d[k]), 'dog.' + k + ' = ' + d[k]);
  for (const [k, v] of Object.entries(d.needs)) assert.ok(v >= 0 && v <= 100, `need ${k} = ${v}`);
  assert.ok(Math.abs(d.x) <= PLAY_HALF + 1e-9 && Math.abs(d.z) <= PLAY_HALF + 1e-9, 'the dog left the map');
  assert.ok(d.y > -0.01 && d.y < 3, 'dog height ' + d.y);
  for (const list of [S.peds, S.vehicles, S.cows, S.goats, S.birds, S.dogs, S.items]) {
    for (const e of list) assert.ok(Number.isFinite(e.x) && Number.isFinite(e.z) && Number.isFinite(e.y || 0), 'non-finite position');
  }
  for (const v of S.vehicles) assert.ok(Number.isFinite(v.v) && v.v >= 0 && Number.isFinite(v.s) && Number.isFinite(v.d), 'vehicle state');
  assert.ok(Number.isFinite(S.clock.hours) && S.clock.hours >= 0 && S.clock.hours < 24);
}

/** A deterministic, button-mashing player. */
const mash = (i) => ({
  mx: Math.sin(i * 0.011) * (i % 700 < 500 ? 1 : 0.3),
  mz: Math.cos(i * 0.017),
  run: i % 420 < 130,
  jump: i % 157 === 0,
  bark: i % 97 === 0,
  sniff: i % 311 === 0,
  act: i % 89 === 0,
  lie: i % 523 === 0,
});

/** A hash of every value reachable from the world: any write to it shows up here. */
function digestWorld(W) {
  let h = 2166136261 >>> 0;
  const mixN = (v) => { h ^= Math.round(v * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; };
  const mixS = (str) => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  const seen = new Set();
  const walk = (v) => {
    if (v === null || v === undefined) { mixN(7); return; }
    if (typeof v === 'number') { mixN(Number.isFinite(v) ? v : 1e6); return; }
    if (typeof v === 'string') { mixS(v); return; }
    if (typeof v === 'boolean') { mixN(v ? 3 : 5); return; }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) { mixN(v.length); for (let i = 0; i < v.length; i++) mixN(v[i]); return; }
    if (v instanceof Map) { mixN(v.size); for (const [k, x] of v) { walk(k); walk(x); } return; }
    if (Array.isArray(v)) { mixN(v.length); for (const x of v) walk(x); return; }
    for (const k of Object.keys(v)) { mixS(k); walk(v[k]); }
  };
  walk(W);
  return h >>> 0;
}
const WORLD_DIGEST = digestWorld(WORLD);

/* ========================================================================== */
/* The world                                                                  */
/* ========================================================================== */

group('the world');

test('the same seed builds the same neighbourhood', () => {
  assert.equal(digestWorld(generateWorld(7)), WORLD_DIGEST);
});

test('the pavements are one network, reaching all eight ways off the map (seeds 7, 3, 21)', () => {
  for (const W of [WORLD, generateWorld(3), generateWorld(21)]) {
    const G = W.peds;
    assert.equal(G.portals.length, 8, 'a way off the map was cut off');
    const seen = new Uint8Array(G.nodes.length);
    const stack = [G.portals[0]];
    seen[stack[0]] = 1;
    while (stack.length) for (const e of G.nodes[stack.pop()].edges) if (!seen[e.to]) { seen[e.to] = 1; stack.push(e.to); }
    const usable = G.nodes.filter((n) => n.ok).length;
    assert.ok(usable / G.nodes.length > 0.98, `only ${usable} of ${G.nodes.length} nodes are usable`);
    G.nodes.forEach((n, i) => {
      if (n.ok) assert.ok(seen[i], `node ${i} at (${n.x.toFixed(1)}, ${n.z.toFixed(1)}) is cut off from the rest`);
    });
    for (const d of G.dests) assert.ok(seen[d.node], 'a destination nobody can reach');
    assert.ok(G.walkNodes.every((i) => pedWalkable(W, G.nodes[i].x, G.nodes[i].z)), 'a walking node off the pavement');
  }
});

test('every path can be walked both ways', () => {
  const G = WORLD.peds;
  G.nodes.forEach((n, i) => {
    for (const e of n.edges) assert.ok(G.nodes[e.to].edges.some((f) => f.to === i), `edge ${i} -> ${e.to} is one-way`);
  });
});

test('vehicle routes stay on the carriageway, across their full width', () => {
  const P = {};
  for (const r of WORLD.routes) {
    for (let s = 1; s < r.length - 1; s += 1) {
      const hw = r.halfW[Math.floor(s / r.step)];
      for (const f of [-0.9, 0, 0.9]) {
        routePose(r, s, hw * f, P);
        const su = surfAt(WORLD, P.x, P.z);
        assert.ok(su === SURF.ROAD || su === SURF.CROSS, `route ${r.from}->${r.to} at s=${s} runs over surface ${su}`);
      }
    }
  }
});

test('traffic keeps left, and the roundabout turns clockwise', () => {
  // in from the west on the north half of MG Road, in from the east on the south half
  const P = {};
  for (const r of WORLD.routes) {
    routePose(r, 5, 0, P);
    if (r.from === 'W') assert.ok(P.z < 0, 'westbound arrivals should drive on the north side');
    if (r.from === 'E') assert.ok(P.z > 0, 'eastbound arrivals should drive on the south side');
    // around the ring, the bearing atan2(z, x) only ever increases: clockwise on a north-up map
    let prev = null, turned = 0;
    for (let s = r.ringStart + 0.5; s < r.ringEnd - 0.5; s += 0.5) {
      routePose(r, s, 0, P);
      const a = Math.atan2(P.z, P.x);
      if (prev !== null) {
        let da = a - prev;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        assert.ok(da > -1e-6, `route ${r.from}->${r.to} goes anticlockwise round the chowk`);
        turned += da;
      }
      prev = a;
    }
    assert.ok(turned >= 0);
  }
});

test('no building stands on a road, and nothing solid does but the median kerb', () => {
  for (const b of WORLD.buildings) {
    for (let x = b.x0 + 0.25; x < b.x1; x += 0.5) {
      for (let z = b.z0 + 0.25; z < b.z1; z += 0.5) {
        const s = surfAt(WORLD, x, z);
        assert.ok(s !== SURF.ROAD && s !== SURF.CROSS, `building ${b.id} covers a road at (${x}, ${z})`);
      }
    }
  }
  for (const c of WORLD.colliders) {
    const cx = c.kind === 'box' ? (c.x0 + c.x1) / 2 : c.x, cz = c.kind === 'box' ? (c.z0 + c.z1) / 2 : c.z;
    const s = surfAt(WORLD, cx, cz);
    if (s === SURF.ROAD || s === SURF.CROSS) assert.equal(c.tag, 'median', `a ${c.tag} stands in the road at (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
  }
});

test('everything the game sends you to is on open ground', () => {
  const open = (p, what) => {
    const s = surfAt(WORLD, p.x, p.z);
    assert.ok(s !== SURF.BUILDING && s !== SURF.MASS, `${what} at (${p.x}, ${p.z}) is inside a building`);
  };
  for (const k of ['water', 'garbage', 'sleep', 'food', 'posts']) for (const p of WORLD.pois[k]) open(p, k);
  for (const k of ['dogs', 'cows', 'goats', 'flocks']) for (const p of WORLD.spawns[k]) open(p, k);
  open(WORLD.spawns.dog, 'the dog');
  const sp = WORLD.special;
  for (const p of [sp.chai.front, sp.halwai.front, sp.aunty.bowl, sp.aunty.door, sp.temple.door, sp.pitch.batter, sp.pitch.bowler]) open(p, 'a scene');
  for (const id of Object.keys(TASKS)) {
    if (!TASKS[id].where) continue;
    const w = TASKS[id].where(sim({ quiet: true }));
    if (w) open(w, 'task ' + id);
  }
});

test('every spot on the map has a name', () => {
  const names = new Set();
  for (let x = -PLAY_HALF; x <= PLAY_HALF; x += 2) {
    for (let z = -PLAY_HALF; z <= PLAY_HALF; z += 2) {
      const n = zoneAt(WORLD, x, z);
      assert.ok(typeof n === 'string' && n.length > 0, `no name at (${x}, ${z})`);
      names.add(n);
    }
  }
  assert.ok(names.size >= 12, 'only ' + names.size + ' named places');
});

test('Bhura wakes up on top of the sacks, not inside them', () => {
  const S = sim({ quiet: true });
  assert.ok(near(S.dog.y, 0.68, 0.02), 'expected the dog on the sacks, y = ' + S.dog.y);
  assert.equal(wallOverlap(S), 0);
  assert.equal(contextAction(S).kind, 'sit', 'lying down at dawn, the button sits him up');
});

/* ========================================================================== */
/* Determinism                                                                */
/* ========================================================================== */

group('determinism');

function replay(opts, secs) {
  const S = sim(opts);
  const hashes = [];
  for (let k = 0; k < secs; k++) {
    run(S, 1, (S2, i) => mash(k * 30 + i));
    hashes.push(hashState(S));
  }
  return hashes;
}

test('the same seed and the same buttons replay exactly', () => {
  assert.deepEqual(replay({ seed: 5 }, 30), replay({ seed: 5 }, 30));
});

test('a different seed is a different morning', () => {
  assert.notEqual(replay({ seed: 5 }, 5)[4], replay({ seed: 6 }, 5)[4]);
});

test('a sim never changes the world it runs on', () => {
  replay({ seed: 9, hour: 18 }, 20);
  assert.equal(digestWorld(WORLD), WORLD_DIGEST, 'the shared world was modified');
  assert.deepEqual(replay({ seed: 9 }, 10), replay({ seed: 9, world: generateWorld(7) }, 10));
});

test('no Math.random and no wall clock inside the simulation', () => {
  const saved = [Math.random, Date.now, performance.now];
  const boom = (what) => () => { throw new Error(what + ' was called inside the simulation'); };
  Math.random = boom('Math.random');
  Date.now = boom('Date.now');
  performance.now = boom('performance.now');
  try {
    replay({ seed: 3, hour: 17.5 }, 15);
  } finally {
    [Math.random, Date.now, performance.now] = saved;
  }
});

test('a wild afternoon: nothing NaN, nobody through a wall, needs in range', () => {
  const S = sim({ seed: 4, hour: 12 });
  let worst = 0;
  for (let i = 0; i < 20 * 150; i++) {
    step(S, 1 / 20, mash(i * 2));
    drainEvents(S);
    worst = Math.max(worst, wallOverlap(S));
    if (i % 20 === 0) checkSane(S);
  }
  assert.ok(worst < 0.06, 'the dog sank ' + worst.toFixed(3) + ' m into a wall');
  assert.ok(S.day.distance > 150, 'the mashing barely moved the dog: ' + S.day.distance.toFixed(0) + ' m');
});

/* ========================================================================== */
/* Bhura                                                                      */
/* ========================================================================== */

group('Bhura');

test('the stick walks, trots and sprints at the speeds in the config', () => {
  const S = sim({ quiet: true });
  place(S, -36, -26, Math.PI);
  run(S, 1.0, { mx: 0, mz: -0.5 });
  assert.ok(near(S.dog.speed, 0.6 + (CONFIG.dog.walkSpeed - 0.6) * ((0.5 - 0.12) / 0.43), 0.1), 'walk ' + S.dog.speed);
  run(S, 1.0, { mx: 0, mz: -1 });
  assert.ok(near(S.dog.speed, CONFIG.dog.trotSpeed, 0.1), 'trot ' + S.dog.speed);
  run(S, 0.7, { mx: 0, mz: -1, run: true });
  assert.ok(near(S.dog.speed, CONFIG.dog.runSpeed, 0.15), 'run ' + S.dog.speed);
});

test('steps and kerbs are climbed; the island kerb takes a jump; the clock tower is a wall', () => {
  const S = sim({ quiet: true });
  // up the temple steps onto the plinth, without jumping
  place(S, -36, -35, Math.PI);
  walkTo(S, -36, -41.9, { max: 8 });
  assert.ok(near(S.dog.y, 1.2, 0.02), 'on the temple plinth, y = ' + S.dog.y);
  // the roundabout island stands 0.45 m: too tall to step onto
  place(S, 7, 0, -Math.PI / 2);
  run(S, 1.5, { mx: -0.6, mz: 0 });
  assert.ok(S.dog.y < 0.01 && S.dog.x >= 5 + CONFIG.dog.radius - 0.02, 'walked up the island kerb');
  // ...but a jump from close in makes it
  place(S, 6.1, 0, -Math.PI / 2);
  run(S, 0.15, { mx: -1, mz: 0 });
  run(S, DT, { mx: -1, mz: 0, jump: true });
  run(S, 0.6, { mx: -1, mz: 0 });
  assert.ok(near(S.dog.y, 0.45, 0.02), 'jumped onto the island, y = ' + S.dog.y);
  run(S, 1.0, { mx: -1, mz: 0 });
  assert.ok(S.dog.x >= 1.9 + CONFIG.dog.radius - 0.02, 'went through the clock tower to x = ' + S.dog.x);
  assert.equal(wallOverlap(S), 0);
});

test('a jump clears about seventy centimetres', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, 0);
  const y0 = S.dog.y;
  let top = y0;
  const ev = press(S, 'jump');
  for (let i = 0; i < 40; i++) { run(S, DT); top = Math.max(top, S.dog.y); }
  const v = CONFIG.dog.jumpSpeed;
  assert.ok(near(top - y0, (v * v) / (2 * CONFIG.dog.gravity), 0.05), 'jump height ' + (top - y0).toFixed(2));
  assert.equal(only(ev, 'jump').length, 1);
  assert.ok(S.dog.onGround && near(S.dog.y, y0, 1e-6));
});

test('sit, lie down, sleep, wake up', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, 0);
  press(S, 'act');
  assert.ok(S.dog.sitting, 'E sits');
  assert.equal(contextAction(S).kind, 'stand');
  press(S, 'lie');
  assert.ok(S.dog.lying && !S.dog.sleeping, 'Z lies down');
  let ev = press(S, 'lie');
  assert.ok(S.dog.sleeping && only(ev, 'sleep').length === 1, 'Z again sleeps');
  assert.equal(contextAction(S).kind, 'wake');
  ev = press(S, 'lie');
  assert.ok(!S.dog.sleeping && !S.dog.lying && only(ev, 'wake').length === 1, 'Z wakes him');
  press(S, 'lie'); press(S, 'lie');
  ev = run(S, 0.3, { mx: 1, mz: 0 });
  assert.ok(!S.dog.sleeping && only(ev, 'wake').length === 1, 'the stick wakes him too');
});

test('asleep, the clock runs ten times faster', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, 0);
  let h0 = S.clock.hours;
  run(S, 2);
  const awake = S.clock.hours - h0;
  press(S, 'lie'); press(S, 'lie');
  h0 = S.clock.hours;
  run(S, 2);
  const asleep = S.clock.hours - h0;
  assert.ok(near(awake, (2 * CONFIG.time.scale) / 60, 1e-3), 'awake ' + awake);
  assert.ok(near(asleep / awake, CONFIG.time.sleepScale, 0.3), 'asleep runs ' + (asleep / awake).toFixed(2) + 'x');
});

test('sniffing lays scent trails to food, water and the next task', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, 0);
  S.dog.needs.thirst = 40;
  const ev = press(S, 'sniff');
  assert.equal(only(ev, 'sniff').length, 1);
  const kinds = S.sniff.trails.map((t) => t.kind);
  assert.ok(kinds.includes('water') && kinds.includes('food') && kinds.includes('task'), 'trails: ' + kinds.join(','));
  for (const t of S.sniff.trails) {
    assert.ok(t.pts.length >= 2 && t.pts.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z)));
    // a trail follows the pavements: no stretch of it cuts through a building
    for (let i = 1; i < t.pts.length - 1; i++) {
      const [ax, az] = t.pts[i - 1], [bx, bz] = t.pts[i];
      for (let k = 1; k < 8; k++) {
        const s = surfAt(WORLD, ax + ((bx - ax) * k) / 8, az + ((bz - az) * k) / 8);
        assert.ok(s !== SURF.BUILDING, `the ${t.kind} trail goes through a building`);
      }
    }
  }
  run(S, CONFIG.dog.sniffDuration + 0.1);
  assert.equal(S.sniff, null, 'the scent fades');
});

/* ========================================================================== */
/* Needs                                                                      */
/* ========================================================================== */

group('needs');

test('hunger and thirst run down by the game hour', () => {
  const S = sim({ quiet: true, hour: 8 });
  place(S, -36, -28, 0);
  press(S, 'lie');
  const n0 = Object.assign({}, S.dog.needs);
  run(S, 60 / CONFIG.time.scale); // one game hour
  assert.ok(!S.dog.hot);
  assert.ok(near(n0.hunger - S.dog.needs.hunger, CONFIG.needs.hungerPerHour, 0.3), 'hunger fell ' + (n0.hunger - S.dog.needs.hunger));
  assert.ok(near(n0.thirst - S.dog.needs.thirst, CONFIG.needs.thirstPerHour, 0.3), 'thirst fell ' + (n0.thirst - S.dog.needs.thirst));
  assert.ok(S.dog.needs.energy >= n0.energy, 'lying down rests');
});

test('the midday sun on open road makes a dog thirsty almost twice as fast', () => {
  const S = sim({ quiet: true, hour: 13 });
  place(S, 40, 0, 0);
  run(S, 1);
  assert.ok(S.dog.hot && !S.dog.shaded, 'out in the sun at 1 pm');
  const t0 = S.dog.needs.thirst;
  run(S, 30 / CONFIG.time.scale); // half an hour
  const fell = t0 - S.dog.needs.thirst;
  assert.ok(near(fell, (CONFIG.needs.thirstPerHour * CONFIG.needs.heatThirstMult) / 2, 0.4), 'thirst fell ' + fell.toFixed(2));
  assert.ok(S.dog.panting);
});

test('sprinting tires a dog out, and an exhausted dog cannot sprint', () => {
  const S = sim({ quiet: true });
  place(S, 40, 0, Math.PI / 2);
  const e0 = S.dog.needs.energy;
  run(S, 4, { mx: 1, mz: 0, run: true });
  assert.ok(e0 - S.dog.needs.energy > 6, 'four seconds of sprinting cost ' + (e0 - S.dog.needs.energy).toFixed(1));
  S.dog.needs.energy = 2;
  place(S, 40, 0, -Math.PI / 2);
  run(S, 1, { mx: -1, mz: 0, run: true });
  assert.ok(S.dog.speed <= CONFIG.dog.tiredSpeed + 0.05, 'still sprinting at ' + S.dog.speed);
});

test('an empty belly costs health, and a dog who runs out wakes up at Aunty\'s', () => {
  const S = sim({ quiet: true, hour: 10 });
  place(S, 40, 0, 0);
  S.dog.needs.hunger = 0;
  S.dog.needs.health = 2;
  const h0 = S.clock.hours;
  const ev = runUntil(S, 15, IDLE, (S2, e) => only(e, 'faint').length > 0);
  assert.equal(only(ev, 'faint').length, 1);
  const bowl = WORLD.special.aunty.bowl;
  assert.ok(Math.hypot(S.dog.x - bowl.x, S.dog.z - bowl.z) < 1.5, 'Aunty took him in');
  assert.ok(S.dog.lying && S.dog.needs.health >= 40 && S.dog.needs.hunger >= 40);
  assert.ok(S.clock.hours - h0 > 1.4, 'time passes while he recovers');
  assert.ok(!S.scenes.aunty.p.hidden, 'and Aunty is there');
});

/* ========================================================================== */
/* Food and water                                                             */
/* ========================================================================== */

group('food and water');

test('food on the ground: E eats it', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, Math.PI);
  S.dog.needs.hunger = 40;
  const f = ahead(S, 0.5);
  spawnItem(S, 'roti', f.x, S.dog.y, f.z);
  assert.equal(contextAction(S).label, 'Eat the roti');
  const ev = press(S, 'act', 2);
  assert.equal(only(ev, 'ate', (e) => e.kind === 'roti').length, 1);
  assert.ok(S.dog.needs.hunger > 40 + CONFIG.food.roti.hunger - 1);
  assert.ok(!S.items.some((it) => it.kind === 'roti'), 'the roti is gone');
});

test('on a full belly E picks food up instead, and E again eats it', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, Math.PI);
  S.dog.needs.hunger = CONFIG.food.carryWhenFull + 5;
  const f = ahead(S, 0.5);
  const it = spawnItem(S, 'jalebi', f.x, S.dog.y, f.z);
  assert.equal(contextAction(S).label, 'Pick up the jalebi');
  press(S, 'act', 0.6);
  assert.equal(S.dog.carry, it);
  run(S, 1, { mx: 0, mz: -1 }); // it travels with him
  assert.ok(Math.hypot(it.x - S.dog.x, it.z - S.dog.z) < 0.8);
  assert.equal(contextAction(S).kind, 'eatCarry');
  const ev = press(S, 'act', 2);
  assert.equal(only(ev, 'ate', (e) => e.kind === 'jalebi').length, 1);
});

test('the hand pump in Pump Wala Chowk always has water', () => {
  const S = sim({ quiet: true });
  const pump = WORLD.pois.water.find((w) => w.kind === 'pump');
  approach(S, pump, 'drink');
  S.dog.needs.thirst = 30;
  const ev = press(S, 'act', CONFIG.food.drinkTime + 0.3);
  const drank = only(ev, 'drank');
  assert.equal(drank.length, 1);
  assert.equal(drank[0].kind, 'pump');
  assert.ok(S.dog.needs.thirst > 30 + CONFIG.food.drinkGain - 1);
});

test('rummaging turns something up about half the time, and a heap needs time to refill', () => {
  let found = 0;
  const heap = WORLD.pois.garbage[3];
  for (let seed = 1; seed <= 12; seed++) {
    const S = sim({ quiet: true, seed });
    approach(S, heap, 'rummage');
    const ev = press(S, 'act', CONFIG.food.rummageTime + 0.4);
    const r = only(ev, 'rummage');
    assert.equal(r.length, 1);
    if (r[0].found) {
      found++;
      assert.ok(S.items.some((it) => it.found && it.state !== 'gone'), 'the find should be lying there');
    }
    assert.notEqual(contextAction(S).kind, 'rummage', 'the same heap again straight away');
  }
  assert.ok(found >= 3 && found <= 10, found + ' of 12 rummages found something');
});

test('in the rain, every pothole is a drink', () => {
  const wet = sim({ quiet: true, weather: 'rain' });
  place(wet, 40, 0, 0);
  assert.equal(contextAction(wet).kind, 'drink');
  const ev = press(wet, 'act', CONFIG.food.drinkTime + 0.3);
  assert.equal(only(ev, 'drank', (e) => e.kind === 'rain').length, 1);
  const dry = sim({ quiet: true, weather: 'clear' });
  place(dry, 40, 0, 0);
  assert.notEqual(contextAction(dry).kind, 'drink');
});

test('food left lying about goes off; the cricket ball does not', () => {
  const S = sim({ quiet: true, hour: 19 });
  place(S, -36, -28, 0);
  const f = ahead(S, 2);
  const roti = spawnItem(S, 'roti', f.x, S.dog.y, f.z);
  run(S, 1);
  assert.ok(!roti.gone);
  S.clock.absH += CONFIG.food.itemLife + 0.1;
  run(S, DT);
  assert.ok(roti.gone, 'still there after ' + CONFIG.food.itemLife + ' hours');
  assert.ok(S.items.includes(S.cricket.ball), 'the ball is not food');
});

/* ========================================================================== */
/* People                                                                     */
/* ========================================================================== */

group('people');

test('sit in front of a kind person and you get petted', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, Math.PI / 2);
  const p = addPerson(S, -34.8, -28, { disp: 'kind', snack: null });
  assert.equal(contextAction(S).label, 'Sit and beg');
  const cred0 = S.cred;
  const ev = press(S, 'act', 5);
  assert.equal(only(ev, 'petted', (e) => e.by === p.id).length, 1);
  assert.equal(S.day.petted, 1);
  assert.ok(S.cred >= cred0 + CONFIG.cred.pet);
  // ...and not again straight away
  const again = run(S, 10);
  assert.equal(only(again, 'petted', (e) => e.by === p.id).length, 0, 'petted twice in a row');
});

test('a kind person with a snack throws it to you', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, Math.PI / 2);
  const p = addPerson(S, -34.6, -28, { disp: 'kind', snack: 'samosa' });
  S.dog.needs.hunger = 30;
  let ev = press(S, 'act', 5);
  assert.equal(only(ev, 'fed', (e) => e.by === p.id).length, 1);
  assert.equal(p.snack, null);
  assert.equal(contextAction(S).label, 'Eat the samosa', 'the samosa should land under his nose');
  ev = press(S, 'act', 2);
  assert.equal(only(ev, 'ate', (e) => e.kind === 'samosa').length, 1);
});

test('a grumpy one shoos you off', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, Math.PI / 2);
  const p = addPerson(S, -34.8, -28, { disp: 'grumpy' });
  const ev = press(S, 'act', 3);
  assert.equal(only(ev, 'shooed', (e) => e.by === p.id).length, 1);
  assert.equal(only(ev, 'petted').length, 0);
});

test('a bark makes people jump', () => {
  const S = sim({ quiet: true });
  place(S, -36, -28, Math.PI / 2);
  const p = addPerson(S, -33.5, -28, { disp: 'kind' });
  const ev = press(S, 'bark', 0.5);
  assert.equal(only(ev, 'startled', (e) => e.by === p.id).length, 1);
});

test('barrel into someone carrying a snack and they drop it', () => {
  const S = sim({ quiet: true });
  place(S, -36, -26, Math.PI);
  const p = addPerson(S, -36, -30.5, { disp: 'neutral', snack: 'jalebi' });
  const ev = runUntil(S, 3, { mx: 0, mz: -1, run: true }, (S2, e) => only(e, 'bumped').length > 0);
  run(S, 1);
  assert.equal(only(ev, 'bumped', (e) => e.by === p.id).length, 1);
  assert.equal(only(ev, 'dropped', (e) => e.by === p.id).length, 1);
  assert.ok(S.items.some((it) => it.kind === 'jalebi' && it.dropped), 'the jalebi should be on the ground');
});

test('shopkeepers, vendors and the pujari hold their ground when the dog leans on them', () => {
  const S = sim({ quiet: true, hour: 9 });
  const pr = S.scenes.priest.p;
  const x0 = pr.x, z0 = pr.z;
  place(S, -36, -40.6, pr);
  run(S, 3, { mx: 0, mz: -1 });
  assert.ok(Math.hypot(pr.x - x0, pr.z - z0) < 1e-9, 'the dog shoved the pujari off his spot');
  const vendor = S.peds.find((p) => p.role === 'vendor');
  const v0 = { x: vendor.x, z: vendor.z };
  place(S, vendor.x + Math.sin(vendor.yaw) * 1.2, vendor.z + Math.cos(vendor.yaw) * 1.2, vendor);
  run(S, 2, () => ({ mx: vendor.x - S.dog.x, mz: vendor.z - S.dog.z }));
  assert.ok(Math.hypot(vendor.x - v0.x, vendor.z - v0.z) < 1e-9, 'the dog shoved a vendor out of his stall');
});

/* ========================================================================== */
/* The street's characters                                                    */
/* ========================================================================== */

group('the people with names');

test("Raju's biscuit: sit nicely at the chai stall (once in a while)", () => {
  const S = sim({ quiet: true, hour: 9 });
  const C = WORLD.special.chai;
  place(S, C.front.x, C.front.z - 1.5, 0);
  run(S, 1.5, { mx: 0, mz: 0.5 }); // up to the counter
  let ev = press(S, 'act', 5);
  assert.equal(only(ev, 'chaiBiscuit').length, 1);
  assert.equal(only(ev, 'fed', (e) => e.by === S.scenes.chai.p.id).length, 1);
  assert.equal(contextAction(S).label, 'Eat the biscuit');
  ev = press(S, 'act', 2);
  assert.equal(only(ev, 'ate', (e) => e.kind === 'biscuit').length, 1);
  ev = press(S, 'act', 8);
  assert.equal(only(ev, 'chaiBiscuit').length, 0, 'a second biscuit straight away');
});

test('the samosa heist: grab one and outrun the halwai', () => {
  const S = sim({ quiet: true, hour: 10 });
  const H = WORLD.special.halwai;
  place(S, H.front.x, H.front.z + 0.3, Math.PI);
  assert.equal(contextAction(S).kind, 'grab');
  const left = samosasLeft(S);
  let ev = press(S, 'act', 0.7);
  assert.equal(only(ev, 'stole').length, 1);
  assert.ok(S.dog.carry && S.dog.carry.kind === 'samosa' && S.dog.carry.stolen);
  assert.equal(samosasLeft(S), left - 1);
  ev = ev.concat(runUntil(S, 14, { mx: 1, mz: 0, run: true }, (S2, e) => only(e, 'escaped').length + only(e, 'caught').length > 0));
  assert.equal(only(ev, 'thiefShout').length, 1, 'he should notice');
  assert.equal(only(ev, 'caught').length, 0);
  assert.equal(only(ev, 'escaped').length, 1);
  assert.equal(only(ev, 'cred', (e) => e.why === 'escaped').length, 1);
  assert.equal(contextAction(S).kind, 'eatCarry', 'it is his now');
  ev = press(S, 'act', 2);
  assert.equal(only(ev, 'ate', (e) => e.kind === 'samosa').length, 1);
});

test('the samosa heist: dawdle and he takes it back', () => {
  const S = sim({ quiet: true, hour: 10 });
  const H = WORLD.special.halwai;
  place(S, H.front.x, H.front.z + 0.3, Math.PI);
  const mood = S.dog.needs.mood;
  const ev = press(S, 'act', 6);
  assert.equal(only(ev, 'caught').length, 1);
  assert.equal(only(ev, 'escaped').length, 0);
  assert.equal(S.dog.carry, null);
  assert.ok(S.dog.needs.mood < mood - 5);
  run(S, 8);
  const P = S.scenes.halwai.p;
  assert.ok(S.scenes.halwai.state === 'idle' && Math.hypot(P.x - H.vendor.x, P.z - H.vendor.z) < 0.05, 'he went back behind his counter');
});

test('the halwai\'s tray refills as the day goes on', () => {
  const S = sim({ quiet: true, hour: 10 });
  const H = WORLD.special.halwai;
  place(S, H.front.x, H.front.z + 0.3, Math.PI);
  press(S, 'act', 6); // stolen, and taken back
  const n = samosasLeft(S);
  assert.equal(n, 5);
  run(S, (CONFIG.scenes.samosaRefill + 2) / CONFIG.time.scale);
  assert.equal(samosasLeft(S), 6);
});

test("Aunty's bowl: rotis and milk at half past seven, and a pat on the head", () => {
  const S = sim({ quiet: true, hour: 7.45 });
  const A = WORLD.special.aunty;
  let ev = run(S, 4);
  assert.ok(only(ev, 'auntyCall').length >= 1, 'she calls the dogs');
  const food = S.items.filter((it) => it.aunty);
  assert.deepEqual(food.map((f) => f.kind).sort(), ['milk', 'roti', 'roti']);
  S.dog.needs.hunger = 30;
  approach(S, food.find((f) => f.kind === 'roti'), 'eat');
  ev = press(S, 'act', 2.5);
  const ate = only(ev, 'ate', (e) => e.aunty);
  assert.equal(ate.length, 1);
  assert.ok(TASKS.aunty.filter(ate[0], S), "counts for Aunty's favourite");
  assert.ok(only(ev, 'petted', (e) => e.by === S.scenes.aunty.p.id).length + only(run(S, 3), 'petted').length >= 1, 'Aunty pets him');
  // and the next time the window opens the same day, no second helping
  const before = S.items.filter((it) => it.aunty).length;
  setHour(S, 9); run(S, 1);
  setHour(S, 7.6); run(S, 1);
  assert.equal(S.items.filter((it) => it.aunty).length, before, 'Aunty served breakfast twice');
  void A;
});

test('prasad at the evening aarti, sitting at the foot of the temple steps', () => {
  const S = sim({ quiet: true, hour: 18.55 });
  let ev = run(S, 1);
  assert.equal(only(ev, 'aarti').length, 1);
  assert.ok(only(ev, 'bell').length >= 1);
  const pr = S.scenes.priest.p;
  const spot = TASKS.prasad.where(S);
  place(S, spot.x, spot.z, pr);
  ev = press(S, 'act', 5);
  const fed = only(ev, 'fed', (e) => e.by === pr.id);
  assert.equal(fed.length, 1, 'no prasad from where the task points');
  assert.ok(TASKS.prasad.filter(fed[0], S));
  assert.equal(contextAction(S).label, 'Eat the ladoo', 'the ladoo should land in reach');
  ev = press(S, 'act', 2);
  assert.equal(only(ev, 'ate', (e) => e.prasad).length, 1);
  ev = press(S, 'act', 6);
  assert.equal(only(ev, 'fed', (e) => e.by === pr.id).length, 0, 'one ladoo a day');
});

test('gully cricket: fetch the ball back to the kids', () => {
  const S = sim({ quiet: true, hour: 10 });
  const K = S.cricket;
  const b = K.ball;
  // a big hit has rolled to the edge of the maidan
  Object.assign(b, { state: 'ground', x: 44, z: -30, vx: 0, vy: 0, vz: 0 });
  b.y = groundAt(S, b.x, b.z, 1);
  K.holder = null;
  K.phase = 'loose';
  place(S, 44, -29.4, b);
  assert.equal(contextAction(S).label, 'Grab the ball');
  let ev = press(S, 'act', 0.5);
  assert.equal(S.dog.carry, b);
  ev = ev.concat(run(S, 2.5));
  assert.equal(only(ev, 'kidsShout').length, 1, 'the kids want it back');
  assert.ok(K.kids.some((k) => Math.hypot(k.x - S.dog.x, k.z - S.dog.z) < 4), 'and come running');
  assert.equal(contextAction(S).label, 'Drop the ball');
  const cred0 = S.cred;
  ev = press(S, 'act', 1);
  assert.equal(only(ev, 'fetch').length, 1);
  assert.ok(only(ev, 'petted', (e) => e.kid).length >= 1);
  assert.ok(S.cred >= cred0 + CONFIG.cred.fetch);
});

test('the cricket kids go home at dusk, and stay in when it rains', () => {
  const dusk = sim({ quiet: true, hour: 19 });
  run(dusk, 0.2);
  assert.ok(dusk.cricket.kids.every((k) => k.hidden));
  const rain = sim({ quiet: true, hour: 10, weather: 'rain' });
  run(rain, 0.2);
  assert.ok(rain.cricket.kids.every((k) => k.hidden));
  const day = sim({ quiet: true, hour: 10, weather: 'clear' });
  run(day, 0.2);
  assert.ok(day.cricket.kids.every((k) => !k.hidden));
});

/* ========================================================================== */
/* Animals                                                                    */
/* ========================================================================== */

group('animals');

test('pigeons scatter at a bark, perch, and come back down', () => {
  const S = sim({ quiet: true });
  const f = S.flocks[0];
  place(S, f.x + 5, f.z, f);
  const ev = press(S, 'bark', 0.5);
  const sc = only(ev, 'scatter', (e) => e.flock === f.id);
  assert.equal(sc.length, 1);
  const mine = S.birds.filter((b) => b.flock === f);
  assert.equal(sc[0].n, mine.length);
  assert.ok(mine.every((b) => b.state !== 'ground'), 'all of them took off');
  run(S, 40);
  assert.ok(mine.filter((b) => b.state === 'ground').length >= mine.length * 0.8, 'they should be back on the ground');
  for (const b of mine) assert.ok(Number.isFinite(b.x + b.y + b.z));
});

test('running at the pigeons scatters them too', () => {
  const S = sim({ quiet: true });
  const f = S.flocks[0];
  place(S, f.x + 9, f.z, f);
  const ev = runUntil(S, 3, { mx: -1, mz: 0, run: true }, (S2, e) => only(e, 'scatter').length > 0);
  assert.equal(only(ev, 'scatter', (e) => e.flock === f.id).length, 1);
});

test('three barks get the cow off MG Road', () => {
  const S = sim({ quiet: true });
  const cow = S.cows[0];
  assert.equal(surfAt(WORLD, cow.x, cow.z), SURF.ROAD, 'the first cow lies in the road');
  const x0 = cow.x, z0 = cow.z;
  place(S, cow.x, cow.z + 3.2, cow);
  let ev = [];
  for (let i = 0; i < CONFIG.animals.cowIgnoreBarks; i++) ev = ev.concat(press(S, 'bark', 0.6));
  assert.equal(only(ev, 'cowMoved', (e) => e.fromRoad).length, 1);
  run(S, 20);
  assert.ok(Math.hypot(cow.x - x0, cow.z - z0) > 2, 'the cow stayed put');
  assert.notEqual(surfAt(WORLD, cow.x, cow.z), SURF.ROAD, 'the cow is still in the road');
});

test('goats bolt from a running dog', () => {
  const S = sim({ quiet: true });
  const g = S.goats[0];
  place(S, g.x - 7, g.z, g);
  const ev = runUntil(S, 3, () => ({ mx: g.x - S.dog.x, mz: g.z - S.dog.z, run: true }), (S2, e) => only(e, 'goatChased').length > 0);
  assert.ok(only(ev, 'goatChased').length >= 1);
  run(S, 0.5, () => ({ mx: g.x - S.dog.x, mz: g.z - S.dog.z, run: true }));
  assert.ok(S.goats.some((q) => q.fleeing || q.state === 'run'), 'nobody ran');
});

test('Moti: greet him and keep calm company, and he becomes a friend who follows', () => {
  const S = sim({ quiet: true, hour: 9 });
  const moti = S.dogs.find((d) => d.key === 'moti');
  assert.ok(placeNear(S, moti, 2));
  const ev = runUntil(S, 120, () => {
    const d = S.dog, dx = moti.x - d.x, dz = moti.z - d.z, l = Math.hypot(dx, dz);
    if (contextAction(S).kind === 'greet' && moti.greetCD <= 0) return { act: true };
    if (l > 1.8) return { mx: (dx / l) * 0.45, mz: (dz / l) * 0.45 }; // a calm walk, not a charge
    return IDLE;
  }, (S2, e) => only(e, 'friend').length > 0);
  assert.equal(only(ev, 'friend', (e) => e.key === 'moti').length, 1, 'friendship only reached ' + S.friendship.moti.toFixed(0));
  assert.ok(only(ev, 'greeted', (e) => e.key === 'moti').length >= 2);
  assert.ok(S.friendship.moti >= CONFIG.animals.friendAt);
  assert.equal(moti.state, 'follow');
  // trot off across Mandir Square: he tags along
  walkTo(S, -36, -31, { max: 8 });
  run(S, 3);
  assert.ok(Math.hypot(moti.x - S.dog.x, moti.z - S.dog.z) < 3, 'Moti did not follow');
});

test('Kalu guards the bus stop: a stranger is growled at, chased and nipped', () => {
  const S = sim({ quiet: true, hour: 9 });
  const kalu = S.dogs.find((d) => d.key === 'kalu');
  assert.ok(placeNear(S, kalu, 3));
  const h0 = S.dog.needs.health;
  const ev = run(S, 12);
  assert.ok(only(ev, 'growl', (e) => e.key === 'kalu').length >= 1);
  assert.ok(only(ev, 'nipped', (e) => e.key === 'kalu').length >= 1);
  assert.ok(S.dog.needs.health < h0);
});

test("Lali's puppies: on a full belly, carry food over and share it", () => {
  const S = sim({ quiet: true, hour: 9 });
  const pup = S.dogs.find((d) => d.puppy);
  // a roti found on the way, picked up rather than eaten
  assert.ok(placeNear(S, pup, 2.2));
  S.dog.needs.hunger = 90;
  const f = ahead(S, 0.5);
  spawnItem(S, 'roti', f.x, S.dog.y, f.z);
  assert.equal(contextAction(S).kind, 'pickup');
  press(S, 'act', 0.5);
  assert.ok(S.dog.carry && S.dog.carry.kind === 'roti');
  walkTo(S, pup.x, pup.z, { r: 0.2, max: 4, until: (S2) => /^Share with/.test(contextAction(S2).label) });
  const label = contextAction(S).label;
  const ev = press(S, 'act', 6);
  const shared = only(ev, 'sharedFood');
  assert.equal(shared.length, 1, 'nobody ate it (' + label + ')');
  if (label === 'Share with the puppy') assert.ok(shared[0].puppy);
  assert.ok(S.friendship.lali >= 6 + CONFIG.animals.friendFood);
});

/* ========================================================================== */
/* Traffic                                                                    */
/* ========================================================================== */

group('traffic');

test('rush hour flows: vehicles come, go round and leave, with no lasting jam', () => {
  const S = sim({ seed: 3, hour: 17.5 });
  let exits = 0, culled = 0, sum = 0, n = 0, worstStop = 0, worstOverlap = 0;
  for (let i = 0; i < 20 * 120; i++) {
    const before = S.vehicles.slice();
    step(S, 1 / 20, null);
    drainEvents(S);
    for (const v of before) if (v.gone) { if (v.s >= WORLD.routes[v.route].length - 1) exits++; else culled++; }
    if (i % 20) continue;
    sum += S.vehicles.length; n++;
    for (const v of S.vehicles) if (!v.stopped) worstStop = Math.max(worstStop, v.stopT);
    for (let a = 0; a < S.vehicles.length; a++) {
      for (let b = a + 1; b < S.vehicles.length; b++) {
        const A = S.vehicles[a], B = S.vehicles[b];
        if (Math.abs(A.x - B.x) > 12 || Math.abs(A.z - B.z) > 12) continue;
        for (const ca of A.circles) for (const cb of B.circles) {
          const d = Math.hypot(A.x + A.dirx * ca.off - B.x - B.dirx * cb.off, A.z + A.dirz * ca.off - B.z - B.dirz * cb.off);
          worstOverlap = Math.max(worstOverlap, ca.r + cb.r - d);
        }
      }
    }
    checkSane(S);
  }
  assert.ok(sum / n > 25, 'only ' + (sum / n).toFixed(1) + ' vehicles on average at rush hour');
  assert.ok(exits > 70, 'only ' + exits + ' vehicles got through in two minutes');
  assert.ok(culled <= 2, culled + ' vehicles had to be removed from jams');
  assert.ok(worstStop < 25, 'a vehicle sat still for ' + worstStop.toFixed(1) + ' s');
  assert.ok(worstOverlap < 0.4, 'two vehicles overlapped by ' + worstOverlap.toFixed(2) + ' m');
});

/** The first vehicle of these types bowling along a straight approach, well short of the chowk. */
function cruiser(S, types) {
  for (let t = 0; t < 30; t++) {
    const v = S.vehicles.find((q) => types.includes(q.type) && q.v > 6 && q.stopAt < 0 && !q.stopped
      && WORLD.routes[q.route].tag[Math.floor(q.s / WORLD.routes[q.route].step)] === 0
      && q.s + 30 < WORLD.routes[q.route].entryS && Math.abs(q.x) < 80 && Math.abs(q.z) < 80);
    if (v) return v;
    run(S, 1);
  }
  assert.fail('no vehicle at speed on an approach');
}

test('drivers honk at a dog in the road, and stop short of him', () => {
  const S = sim({ seed: 2, hour: 9 });
  const v = cruiser(S, ['car', 'taxi', 'auto']);
  const gap = 12;
  place(S, v.x + v.dirx * (v.len / 2 + gap), v.z + v.dirz * (v.len / 2 + gap), v);
  let slowest = v.v;
  const ev = runUntil(S, 5, IDLE, () => { slowest = Math.min(slowest, v.v); return false; });
  assert.equal(only(ev, 'hit').length, 0, 'he drove into the dog');
  assert.ok(only(ev, 'honk', (e) => e.id === v.id && e.atDog).length >= 1, 'no honk');
  assert.ok(slowest < 1, 'never slowed below ' + slowest.toFixed(1) + ' m/s');
});

test('an auto at speed knocks the dog flying, once', () => {
  const S = sim({ seed: 2, hour: 9 });
  const v = cruiser(S, ['auto', 'car', 'taxi']);
  const gap = 1.2;
  place(S, v.x + v.dirx * (v.len / 2 + gap), v.z + v.dirz * (v.len / 2 + gap), v);
  const h0 = S.dog.needs.health;
  const ev = run(S, CONFIG.dog.hitInvuln - 0.2);
  const hits = only(ev, 'hit');
  assert.equal(hits.length, 1, hits.length + ' hits');
  assert.ok(hits[0].dmg >= CONFIG.traffic.hitDamage[0] && hits[0].dmg <= CONFIG.traffic.hitDamage[2]);
  assert.ok(near(h0 - S.dog.needs.health, hits[0].dmg, 0.5));
  assert.equal(only(ev, 'hitByVehicle').length, 1);
  assert.equal(S.day.hits, 1);
  run(S, 2);
  assert.ok(S.dog.onGround && S.dog.action === null, 'he picks himself up');
  checkSane(S);
});

test('crossing MG Road counts, unless you were hit on the way', () => {
  const S = sim({ quiet: true });
  let ev = [];
  for (const [z0, dir] of [[9.5, -1], [-9.5, 1], [9.5, -1]]) {
    place(S, 14, z0, dir < 0 ? Math.PI : 0);
    ev = ev.concat(run(S, 7, { mx: 0, mz: dir }));
  }
  assert.equal(only(ev, 'crossed').length, 3);
  // a hit on the way across spoils it
  place(S, 14, 9.5, Math.PI);
  S.dog.crossHit = true;
  ev = run(S, 7, { mx: 0, mz: -1 });
  assert.equal(only(ev, 'crossed').length, 0);
});

/* ========================================================================== */
/* The crowd                                                                  */
/* ========================================================================== */

group('the crowd');

test('the street fills and empties with the hour', () => {
  const walkers = (S) => S.peds.filter((p) => p.role === 'walker').length;
  const target = (h) => {
    const P = CONFIG.crowd.population;
    for (let i = 0; i + 1 < P.length; i++) if (h >= P[i][0] && h <= P[i + 1][0]) return P[i][1] + ((P[i + 1][1] - P[i][1]) * (h - P[i][0])) / (P[i + 1][0] - P[i][0]);
    return P[0][1];
  };
  for (const h of [3, 8, 18]) {
    const S = sim({ seed: 8, hour: h });
    run(S, 20);
    const n = walkers(S), t = target(S.clock.hours);
    assert.ok(Math.abs(n - t) <= Math.max(8, t * 0.15), `${n} walkers at ${h}:00, wanted about ${t.toFixed(0)}`);
  }
});

test('nobody freezes: every walker keeps making progress (four seeds, four hours)', () => {
  for (const [seed, hour] of [[3, 8], [5, 13], [9, 18.5], [12, 21]]) {
    const S = sim({ seed, hour });
    const track = new Map();
    const stuck = [];
    for (let i = 0; i < 20 * 75; i++) {
      step(S, 1 / 20, null);
      drainEvents(S);
      if (i % 20) continue;
      for (const p of S.peds) {
        if (p.role !== 'walker' || p.hidden) continue;
        const t = track.get(p);
        if (!t || p.state !== 'walk' || Math.hypot(p.x - t.x, p.z - t.z) > 0.6) { track.set(p, { x: p.x, z: p.z, since: S.t }); continue; }
        if (S.t - t.since > 12 && !t.flagged) { t.flagged = true; stuck.push(`(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`); }
      }
    }
    assert.equal(stuck.length, 0, `seed ${seed} at ${hour}:00: ${stuck.length} walkers frozen, e.g. at ${stuck.slice(0, 3).join(' ')}`);
  }
});

test('walkers stay on the pavement unless they are crossing', () => {
  const S = sim({ seed: 6, hour: 18 });
  let samples = 0, bad = 0;
  for (let i = 0; i < 20 * 60; i++) {
    step(S, 1 / 20, null);
    drainEvents(S);
    if (i % 20) continue;
    for (const p of S.peds) {
      if (p.role !== 'walker' || p.hidden || p.crossing || p.state === 'curb' || p.state === 'sit') continue;
      samples++;
      if (!pedWalkable(WORLD, p.x, p.z)) bad++;
    }
  }
  assert.ok(bad / samples < 0.005, `${bad} of ${samples} walker samples were off the pavement`);
});

/* ========================================================================== */
/* Tasks and cred                                                             */
/* ========================================================================== */

group('tasks and cred');

test('day one is the tutorial; day two always has the heist and the cricket', () => {
  assert.deepEqual(tasksForDay(7, 1), ['eat', 'drink', 'pets3', 'pigeons', 'nap']);
  for (const seed of [1, 7, 99]) {
    const t = tasksForDay(seed, 2);
    assert.ok(t.includes('samosa') && t.includes('fetch'));
  }
});

test('every day has five different tasks, all real', () => {
  for (const seed of [1, 7]) {
    for (let day = 1; day <= 120; day++) {
      const t = tasksForDay(seed, day);
      assert.equal(t.length, 5);
      assert.equal(new Set(t).size, 5);
      for (const id of t) assert.ok(TASKS[id], 'unknown task ' + id);
    }
  }
  for (const [id, T] of Object.entries(TASKS)) {
    assert.ok(T.title && T.desc && T.hint && T.ev, id);
    assert.ok(T.count >= 1 && T.reward > 0, id);
  }
});

test('a task pays its reward once, and cred climbs the ranks to the collar', () => {
  const S = sim({ quiet: true });
  const f = S.flocks[0];
  place(S, f.x + 5, f.z, f);
  let ev = press(S, 'bark', 0.2);
  const done = only(ev, 'taskDone', (e) => e.id === 'pigeons');
  assert.equal(done.length, 1);
  assert.equal(S.cred, TASKS.pigeons.reward + CONFIG.cred.scatter);
  run(S, 6);
  ev = press(S, 'bark', 0.2);
  assert.equal(only(ev, 'taskDone').length, 0, 'paid twice');
  const R = CONFIG.cred.ranks;
  assert.equal(rankFor(S, R[2][0] - 1), 1);
  assert.equal(rankFor(S, R[2][0]), 2);
  addCred(S, R[2][0] - S.cred);
  ev = drainEvents(S);
  assert.equal(S.rank, 2);
  assert.equal(only(ev, 'rank').length, 1);
  assert.equal(only(ev, 'collar').length, 1);
  assert.ok(S.collar);
});

test('day one can be finished: eat, drink, three pats, pigeons, an afternoon nap', () => {
  const S = sim({ quiet: true, seed: 2 });
  let ev = [];
  // eat
  place(S, -36, -28, Math.PI);
  S.dog.needs.hunger = 50;
  const f = ahead(S, 0.5);
  spawnItem(S, 'roti', f.x, S.dog.y, f.z);
  ev = ev.concat(press(S, 'act', 2));
  // drink
  approach(S, WORLD.pois.water.find((w) => w.kind === 'pump'), 'drink');
  ev = ev.concat(press(S, 'act', CONFIG.food.drinkTime + 0.3));
  // three pats from three kind people
  for (let k = 0; k < 3; k++) {
    place(S, -36, -28, Math.PI / 2);
    addPerson(S, -34.8, -28, { disp: 'kind', snack: null });
    ev = ev.concat(press(S, 'act', 5));
    S.peds = S.peds.filter((p) => p.role !== 'special' || p.name || p.kid || p.onBeg || p.uniform || p.home || p.mode !== 'stand' || p.disp !== 'kind');
  }
  // pigeons
  const fl = S.flocks[0];
  place(S, fl.x + 5, fl.z, fl);
  ev = ev.concat(press(S, 'bark', 0.3));
  // nap on the chabutra under the peepal tree after noon
  setHour(S, 12.5);
  const spot = WORLD.pois.sleep.find((p) => p.tag === 'chabutra');
  place(S, spot.x, spot.z, 0);
  press(S, 'lie'); press(S, 'lie');
  ev = ev.concat(runUntil(S, 10, IDLE, (S2, e) => only(e, 'allTasksDone').length > 0));
  const left = S.tasks.filter((t) => !t.done).map((t) => t.id + ' ' + t.progress + '/' + t.def.count);
  assert.equal(left.length, 0, 'still to do: ' + left.join(', '));
  assert.equal(only(ev, 'allTasksDone').length, 1);
  assert.ok(only(ev, 'napMinute').length >= TASKS.nap.count);
});

/* ========================================================================== */
/* The day                                                                    */
/* ========================================================================== */

group('the day');

test('sleeping after half past nine ends the day with a summary', () => {
  const S = sim({ quiet: true });
  setHour(S, CONFIG.time.bedtime - 0.05);
  place(S, -36, -28, 0);
  press(S, 'lie'); press(S, 'lie');
  const ev = runUntil(S, 3, IDLE, (S2, e) => only(e, 'dayEnd').length > 0);
  const end = only(ev, 'dayEnd');
  assert.equal(end.length, 1);
  const sum = end[0].summary;
  assert.equal(sum.why, 'slept');
  assert.equal(sum.day, 1);
  assert.equal(sum.tasks.length, 5);
  for (const k of ['cred', 'ate', 'drank', 'petted', 'hits', 'honks', 'distance', 'friends']) assert.ok(Number.isFinite(sum[k]), k);
  const t = S.t;
  step(S, DT, { mx: 1 });
  assert.equal(S.t, t, 'the sim should wait for the next morning');
});

test('stay up past two and you drop where you stand', () => {
  const S = sim({ quiet: true });
  setHour(S, CONFIG.time.collapseHour - 0.02);
  place(S, -36, -28, 0);
  const ev = runUntil(S, 3, IDLE, (S2, e) => only(e, 'dayEnd').length > 0);
  assert.equal(only(ev, 'dayEnd', (e) => e.summary.why === 'collapsed').length, 1);
});

test('a new morning: home on the sacks, rested, new tasks, and the weather rolls', () => {
  const S = sim({ quiet: true, seed: 4 });
  setHour(S, CONFIG.time.bedtime + 0.1);
  place(S, 40, 0, 0);
  S.dog.needs.energy = 10;
  spawnItem(S, 'roti', 41, 0, 0);
  press(S, 'lie'); press(S, 'lie');
  run(S, 0.5);
  assert.ok(S.dayOver);
  newDay(S);
  const ev = drainEvents(S);
  assert.equal(only(ev, 'newDay').length, 1);
  assert.equal(S.clock.day, 2);
  assert.ok(near(S.clock.hours, CONFIG.time.startHour, 1e-9));
  assert.equal(S.dayOver, null);
  assert.equal(S.weather, weatherFor(4, 2));
  assert.deepEqual(S.tasks.map((t) => t.id), tasksForDay(4, 2));
  assert.equal(S.dog.needs.energy, 100);
  assert.ok(near(S.dog.x, WORLD.spawns.dog.x, 1e-9) && near(S.dog.z, WORLD.spawns.dog.z, 1e-9));
  assert.ok(!S.items.some((it) => it.kind === 'roti'), "yesterday's food is gone");
  assert.ok(S.items.includes(S.cricket.ball), 'the cricket ball stays');
  run(S, 2);
  checkSane(S);
});

test('day one is always clear; later days bring haze and rain', () => {
  assert.equal(weatherFor(7, 1), 'clear');
  const seen = new Set();
  for (let day = 2; day < 200; day++) {
    const w = weatherFor(7, day);
    assert.ok(WEATHERS[w], w);
    assert.equal(w, weatherFor(7, day));
    seen.add(w);
  }
  assert.ok(seen.has('clear') && seen.has('hazy') && seen.has('rain'));
});

/* ========================================================================== */
/* Saves                                                                      */
/* ========================================================================== */

group('saves');

test('anything that is not a save loads as a fresh start', () => {
  const junk = [undefined, null, '', 'garbage', '{', '[]', '123', 'null', 'true', '"text"', '{"v":2,"day":9}',
    '{"v":"1","day":9}', JSON.stringify({ v: 1, day: 'nine', cred: 'lots', friendship: 'yes', totals: [], mid: 'x' })];
  for (const j of junk) assert.deepEqual(loadSave(j), defaultSave(), 'loaded ' + JSON.stringify(j));
});

test('numbers in a save are clamped, never trusted', () => {
  const sv = loadSave(JSON.stringify({ v: 1, day: -4, cred: 1e99, collar: 'yes', friendship: { kalu: 500, moti: -3, rex: 50 }, totals: { days: -1, ate: 1e20 } }));
  assert.equal(sv.day, 1);
  assert.equal(sv.cred, 1e7);
  assert.equal(sv.collar, false);
  assert.equal(sv.friendship.kalu, 100);
  assert.equal(sv.friendship.moti, 0);
  assert.ok(!('rex' in sv.friendship), 'an unknown dog came in from the save');
  assert.equal(sv.totals.days, 0);
  assert.equal(sv.totals.ate, 1e9);
  assert.equal(loadSave(JSON.stringify({ v: 1, day: 1e12 })).day, 100000);
});

test('a save round-trips the day in progress', () => {
  const S = sim({ quiet: true, seed: 6 });
  const f = S.flocks[0];
  place(S, f.x + 5, f.z, f);
  press(S, 'bark', 0.3);                   // pigeons: done
  place(S, -36, -28, 1.0);
  run(S, 3);
  S.dog.needs.hunger = 33.5;
  S.friendship.sheru = 41;
  const text = serializeSave(S);
  assert.ok(text.length < 4096, 'save is ' + text.length + ' bytes');
  const T = sim({ quiet: true, seed: 6, save: loadSave(text) });
  assert.equal(T.clock.day, S.clock.day);
  assert.ok(near(T.clock.hours, S.clock.hours, 1e-6));
  assert.ok(near(T.dog.x, S.dog.x, 1e-9) && near(T.dog.z, S.dog.z, 1e-9) && near(T.dog.yaw, S.dog.yaw, 1e-9));
  assert.ok(near(T.dog.needs.hunger, 33.5, 1e-9));
  assert.equal(T.cred, Math.round(S.cred));
  assert.equal(T.friendship.sheru, 41);
  assert.deepEqual(T.tasks.map((t) => [t.id, t.progress, t.done]), S.tasks.map((t) => [t.id, t.progress, t.done]));
  assert.equal(T.day.scatters, S.day.scatters);
  run(T, 2);
  checkSane(T);
});

test('a saved spot inside a building is not trusted', () => {
  const b = WORLD.buildings[0];
  const sv = loadSave(JSON.stringify({ v: 1, day: 1, mid: { day: 1, hours: 9, x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, yaw: 0, needs: {}, tasks: [] } }));
  const S = sim({ quiet: true, save: sv });
  assert.ok(near(S.dog.x, WORLD.spawns.dog.x, 1e-9) && near(S.dog.z, WORLD.spawns.dog.z, 1e-9), 'the dog woke up inside a wall');
  assert.ok(near(S.clock.hours, 9, 1e-9), 'the rest of the day still loads');
});

test('a garbled mid-day section cannot crash the game', () => {
  const mids = [
    { day: 1, hours: 'noon', x: 'a', z: null, needs: 'full', tasks: 'all', dayc: 7, marked: 'x' },
    { day: 1, hours: 1e9, x: 1e9, z: -1e9, needs: { hunger: -50, thirst: 1e9 }, tasks: [[1, 2], [null], 'x', ['eat', 'NaN', 7, {}], ['pets3', 1e9, 1, ['a', 'b']]], dayc: { cred: 'x', zones: [1, 'Mandir Square', {}] }, marked: [1, 'a', null] },
    { day: 3, hours: 12 },
  ];
  for (const mid of mids) {
    const S = sim({ quiet: true, save: loadSave(JSON.stringify({ v: 1, day: 1, mid })) });
    run(S, 2, { mx: 1, mz: 0.3 });
    checkSane(S);
    for (const t of S.tasks) assert.ok(t.progress >= 0 && t.progress <= t.def.count && Number.isFinite(t.progress));
  }
});

test('a finished day saves no mid-day state, and loads at the next dawn of that day count', () => {
  const S = sim({ quiet: true });
  setHour(S, CONFIG.time.bedtime + 0.1);
  press(S, 'lie'); press(S, 'lie');
  run(S, 0.5);
  assert.ok(S.dayOver);
  const sv = JSON.parse(serializeSave(S));
  assert.equal(sv.mid, null);
});

/* ========================================================================== */
/* Light, meshes, atlas and rig                                               */
/* ========================================================================== */

group('light, meshes and the rig');

test('the light is finite at every hour and in every weather', () => {
  const walk = (v, path) => {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), path + ' = ' + v);
    else if (Array.isArray(v) || (v && typeof v === 'object')) for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k);
  };
  for (const w of Object.keys(WEATHERS)) {
    for (let h = 0; h <= 24; h += 0.25) {
      const E = environment(h, w);
      walk(E, `environment(${h}, ${w})`);
      assert.ok(E.fogDen > 0);
    }
  }
});

test('the sun rises in the east, is high at noon, sets in the west; lamps come on at night', () => {
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  for (let h = 0; h < 24; h += 0.5) assert.ok(near(len(sunDirection(h)), 1, 1e-9));
  assert.ok(sunDirection(7)[0] > 0.5 && sunDirection(7)[1] > 0, 'morning sun in the east');
  assert.ok(sunDirection(12.3)[1] > 0.85, 'high at noon');
  assert.ok(sunDirection(18)[0] < -0.5, 'evening sun in the west');
  assert.ok(sunDirection(12.3)[2] > 0, 'and on the southern side, as in India');
  assert.equal(lampLevel(12), 0);
  assert.equal(lampLevel(22), 1);
  assert.equal(lampLevel(3), 1);
  assert.equal(nightFactor(12), 0);
  assert.equal(nightFactor(0), 1);
});

test('the texture atlas packs every sign without overlap', () => {
  const L = atlasLayout();
  const rects = Object.entries(L.px);
  for (const [k, [x, y, w, h]] of rects) {
    assert.ok(x >= 0 && y >= 0 && x + w <= L.size && y + h <= L.size, k + ' falls off the atlas');
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [ka, a] = rects[i], [kb, b] = rects[j];
      const apart = a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];
      assert.ok(apart, ka + ' overlaps ' + kb);
    }
  }
  for (const [k, uv] of Object.entries(L.uv)) assert.ok(uv.every((v) => v > 0 && v < 1) && uv[2] > uv[0] && uv[3] > uv[1], k);
});

test('the atlas and the noise paint on any 2D canvas without throwing', () => {
  const calls = {};
  const store = {};
  const ctx = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 9, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
      if (k === 'createImageData' || k === 'getImageData') return (...a) => { const w = a.length > 2 ? a[2] : a[0], h = a.length > 2 ? a[3] : a[1]; return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; };
      return () => { calls[k] = (calls[k] || 0) + 1; };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const doc = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx }) };
  const L = atlasLayout();
  const out = paintAtlas(L, doc);
  assert.ok(out.canvas && typeof out.devanagari === 'boolean');
  assert.ok((calls.fillText || 0) >= Object.keys(L.px).filter((k) => k.startsWith('sign:')).length, 'every sign gets its lettering');
  assert.ok(paintNoise(doc));
});

test('the city mesh: sound indices, finite vertices inside the world, and under budget', () => {
  const city = buildCity(WORLD, atlasLayout());
  let tris = 0;
  const check = (m, where, lim) => {
    assert.equal(m.indexCount % 3, 0);
    tris += m.indexCount / 3;
    const f32 = new Float32Array(m.vertices), i8 = new Int8Array(m.vertices);
    let maxI = 0;
    for (let i = 0; i < m.indexCount; i++) if (m.indices[i] > maxI) maxI = m.indices[i];
    assert.ok(maxI < m.vertexCount, where + ': index out of range');
    for (let v = 0; v < m.vertexCount; v++) {
      const o = v * 8;
      const x = f32[o], y = f32[o + 1], z = f32[o + 2];
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), where + ': NaN vertex');
      assert.ok(Math.abs(x) <= lim && Math.abs(z) <= lim && y > -1 && y < 60, `${where}: vertex at (${x}, ${y}, ${z})`);
      const n = v * 32 + 12;
      assert.ok(Math.hypot(i8[n], i8[n + 1], i8[n + 2]) > 100, where + ': a zero normal');
    }
  };
  for (const c of city.chunks) check(c.mesh, `chunk ${c.i},${c.j}`, 140);
  check(city.far, 'skyline', 800);
  assert.ok(city.chunks.length >= 40);
  assert.ok(tris < 450000, 'the city grew to ' + tris + ' triangles');
});

test('every model is whole: bones before children, weights on real bones, parts on real slots', () => {
  const M = buildAllModels();
  for (const k of PEOPLE_KINDS) assert.ok(M[k], 'no model for ' + k);
  for (const T of Object.values(CONFIG.traffic.types)) assert.ok(M[T.model], 'no model for ' + T.model);
  for (const k of ['dog', 'cow', 'goat', 'bird', 'biscuit', 'roti', 'samosa', 'jalebi', 'ladoo', 'bone', 'ball', 'chappal', 'bowl']) assert.ok(M[k], 'no model for ' + k);
  for (const [name, m] of Object.entries(M)) {
    assert.equal(m.boneCount, m.bones.length, name);
    m.bones.forEach((b, i) => assert.ok(b.parent < i, `${name}: bone ${b.name} comes before its parent`));
    const g = m.mesh, u8 = new Uint8Array(g.vertices), f32 = new Float32Array(g.vertices);
    assert.ok(g.vertexCount > 0 && g.indexCount % 3 === 0, name);
    for (let i = 0; i < g.indexCount; i++) assert.ok(g.indices[i] < g.vertexCount, name + ': index out of range');
    for (let v = 0; v < g.vertexCount; v++) {
      assert.ok(Number.isFinite(f32[v * 8] + f32[v * 8 + 1] + f32[v * 8 + 2]), name + ': NaN vertex');
      assert.ok(u8[v * 32 + 24] < m.boneCount, name + ': vertex on bone ' + u8[v * 32 + 24]);
      assert.ok(u8[v * 32 + 25] <= 4, name + ': colour slot ' + u8[v * 32 + 25]);
    }
  }
});

test('every pose the street asks for, the rig can draw without NaN', () => {
  const M = buildAllModels();
  const rigs = {};
  const rigOf = (name) => rigs[name] || (rigs[name] = new Rig(M[name]));
  const out = new Float32Array(64 * 12);
  const finiteOut = (n, what) => { for (let i = 0; i < n * 12; i++) assert.ok(Number.isFinite(out[i]), what + ' posed to NaN'); };
  const anims = new Map();
  const anim = (e) => anims.get(e) || (anims.set(e, newAnim()), anims.get(e));
  const rigSrc = readFileSync(new URL('./rig.js', import.meta.url), 'utf8');
  const S = sim({ seed: 5, hour: 9.5 });
  const modes = new Set();
  for (let f = 0; f < 20 * 40; f++) {
    // the player does a bit of everything
    step(S, 1 / 20, mash(f * 3));
    drainEvents(S);
    const dt = 1 / 20;
    for (const q of [S.dog, ...S.dogs]) {
      const a = anim(q); animateDog(a, q, dt);
      const r = rigOf('dog'); poseDog(r, a, q.speed); r.write(out, 0, q.x, q.y || 0, q.z, q.yaw, q.scale || 1);
      finiteOut(r.n, 'a dog (' + q.pose + ')');
    }
    for (const p of S.peds) {
      if (p.hidden) continue;
      modes.add(p.mode);
      assert.ok(PEOPLE_KINDS.includes(p.kind), 'person of unknown kind ' + p.kind);
      const a = anim(p); animateHuman(a, { speed: p.speed, mode: p.mode, look: p.look }, dt);
      const r = rigOf(p.kind); poseHuman(r, a, p.speed, p.mode); r.write(out, 0, p.x, p.y || 0, p.z, p.yaw, p.scale);
      finiteOut(r.n, 'a person (' + p.mode + ')');
    }
    for (const v of S.vehicles) {
      const r = rigOf(v.T.model); poseVehicle(r, M[v.T.model], v.spin, v.steer, v.pitch, v.spin * 1.4); r.write(out, 0, v.x, 0, v.z, v.yaw, 1);
      finiteOut(r.n, 'a ' + v.type);
      for (const rd of v.riders) {
        modes.add(rd.pose);
        assert.ok(PEOPLE_KINDS.includes(rd.kind), 'rider of unknown kind ' + rd.kind);
      }
    }
    for (const c of [...S.cows, ...S.goats]) {
      const a = anim(c); animateQuad(a, c, dt);
      const r = rigOf(c.kind); poseQuad(r, a, c.speed); r.write(out, 0, c.x, c.y, c.z, c.yaw, 1);
      finiteOut(r.n, 'a ' + c.kind);
    }
    for (const b of S.birds) {
      const a = anim(b); a.t += dt;
      const r = rigOf('bird'); poseBird(r, a, b); r.write(out, 0, b.x, b.y, b.z, b.yaw, 1);
      finiteOut(r.n, 'a bird');
    }
  }
  // every mode the sim used is one the rig knows by name (falling through to the walk would look wrong)
  for (const m of modes) assert.ok(m === 'walk' || rigSrc.includes(`case '${m}'`), `people are asked to '${m}', which the rig does not know`);
});

/* ========================================================================== */
/* The installable app                                                        */
/* ========================================================================== */

group('the installable app');

const here = (p) => new URL(p, import.meta.url);
const text = (p) => readFileSync(here(p), 'utf8');

test('the service worker precaches every module the game loads, and only files that exist', () => {
  const sw = text('./sw.js');
  const list = sw.slice(sw.indexOf('const PRECACHE'), sw.indexOf('];', sw.indexOf('const PRECACHE')));
  const pre = [...list.matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
  for (const p of pre) if (p !== './') assert.ok(existsSync(here(p)), p + ' is precached but does not exist');
  // walk the import graph from main.js
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of text(file).matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'(\.\/[^']+)'/gm)) visit(m[1]);
  };
  visit('./main.js');
  for (const f of seen) assert.ok(pre.includes(f), f + ' is loaded by the game but not precached');
  for (const f of ['./', './index.html', './manifest.webmanifest']) assert.ok(pre.includes(f), f);
  assert.match(sw, /CACHE_VERSION = 'gullydog-v\d+'/);
});

test('the manifest and the page point at icons that exist, at the sizes they claim', () => {
  const man = JSON.parse(text('./manifest.webmanifest'));
  assert.equal(man.start_url, './');
  assert.ok(man.icons.some((i) => i.purpose === 'maskable'));
  const png = (p) => { const b = readFileSync(here(p)); assert.equal(b.toString('latin1', 1, 4), 'PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const i of man.icons) {
    const [w, h] = png(i.src);
    assert.equal(`${w}x${h}`, i.sizes, i.src);
  }
  const html = text('./index.html');
  for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) assert.ok(existsSync(here(m[1])), 'index.html points at missing ' + m[1]);
  assert.deepEqual(png('./icons/icon-180.png'), [180, 180]);
});

/* ========================================================================== */
/* Summary                                                                    */
/* ========================================================================== */

console.log('\n' + '-'.repeat(58));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f.group + ' :: ' + f.name);
  process.exitCode = 1;
} else {
  console.log('all green');
  process.exitCode = 0;
}
