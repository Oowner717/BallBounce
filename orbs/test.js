/*
 * test.js — run with `node test.js`. Zero installs, node:assert only.
 *
 * These tests exist because this thing runs on a phone that never gets a debugger
 * attached. Every one of them is guarding a specific way the sim could quietly rot:
 * a divergence, a NaN, an energy leak, a population explosion, a stuck timer, a save
 * that eats itself.
 *
 * Set ORBS_TEST_STACK=1 for full stack traces on failure.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cloneConfig, CONFIG } from './config.js';
import {
  createSim, step, resize, scatter, makeRng, hashState,
  loadSave, serializeSave, defaultSave, deriveStars,
  levelThreshold, comboMultiplier, milestoneLadder, filigreeTier,
  forceSplitAll, detonateAll, totalKineticEnergy, detonate, applySave,
} from './sim.js';

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
    console.log('  ok   ' + name + (ms > 150 ? '  (' + ms.toFixed(0) + 'ms)' : ''));
  } catch (err) {
    failed++;
    failures.push({ group: currentGroup, name, err });
    console.log('  FAIL ' + name);
    console.log('       ' + String(err && err.message).split('\n').join('\n       '));
    if (process.env.ORBS_TEST_STACK) console.log(err && err.stack);
  }
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const W = 390;
const H = 844;

function freshSim(overrides, seed = 12345, w = W, h = H) {
  return createSim({
    config: cloneConfig(overrides),
    rng: makeRng(seed),
    width: w, height: h,
  });
}

/**
 * A deterministic input script. Given a step index it returns the same pointer state
 * every time, including holds (which exercise gather) and releases (which sling).
 * `intensity` 1 = max-strength flailing, 0.35 = ordinary play.
 */
function makeScript(seed, opts = {}) {
  const rng = makeRng(seed);
  const count = opts.pointers == null ? 3 : opts.pointers;
  const w = opts.width || W;
  const h = opts.height || H;
  const ptrs = [];
  for (let i = 0; i < count; i++) {
    ptrs.push({
      id: 100 + i,
      x: rng.range(0, w), y: rng.range(0, h),
      tx: rng.range(0, w), ty: rng.range(0, h),
      down: false, hold: 0, timer: rng.range(0.2, 1.5),
    });
  }
  return function script(i, dt) {
    const out = [];
    const cancelled = [];
    for (const p of ptrs) {
      p.timer -= dt;
      if (p.timer <= 0) {
        p.timer = rng.range(0.25, 1.6);
        if (!p.down) {
          p.down = true;
          p.hold = rng.float() < (opts.holdChance == null ? 0.35 : opts.holdChance) ? rng.range(0.5, 2.0) : 0;
          p.x = rng.range(0, w); p.y = rng.range(0, h);
          p.tx = rng.range(0, w); p.ty = rng.range(0, h);
        } else if (rng.float() < 0.5) {
          // Half the time a release is a cancel (pointercancel / blur), which must NOT sling.
          if (rng.float() < 0.25) cancelled.push(p.id);
          p.down = false;
        } else {
          p.tx = rng.range(0, w); p.ty = rng.range(0, h);
        }
      }
      if (!p.down) continue;
      if (p.hold > 0) {
        p.hold -= dt;
        // Hold nearly still: this is what morphs the field into an attractor.
        p.x += rng.range(-1, 1) * 6 * dt;
        p.y += rng.range(-1, 1) * 6 * dt;
      } else {
        const k = Math.min(1, 8 * dt);
        p.x += (p.tx - p.x) * k;
        p.y += (p.ty - p.y) * k;
      }
      out.push({ id: p.id, x: p.x, y: p.y });
    }
    return { pointers: out, cancelled };
  };
}

function allFinite(sim) {
  for (const b of sim.balls) {
    if (!b.alive) continue;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return 'ball ' + b.id + ' position ' + b.x + ',' + b.y;
    if (!Number.isFinite(b.vx) || !Number.isFinite(b.vy)) return 'ball ' + b.id + ' velocity ' + b.vx + ',' + b.vy;
    if (!Number.isFinite(b.r) || b.r <= 0) return 'ball ' + b.id + ' radius ' + b.r;
    if (!Number.isFinite(b.mass) || b.mass <= 0) return 'ball ' + b.id + ' mass ' + b.mass;
  }
  for (const s of sim.shards) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) ||
        !Number.isFinite(s.vx) || !Number.isFinite(s.vy)) return 'shard ' + s.x + ',' + s.y;
  }
  const scalars = { score: sim.score, xp: sim.xp, comboMult: sim.comboMult, intensity: sim.intensity, time: sim.time };
  for (const k of Object.keys(scalars)) {
    if (!Number.isFinite(scalars[k])) return 'scalar ' + k + ' = ' + scalars[k];
  }
  return null;
}

/* ========================================================================== */
group('1. Determinism');
/* ========================================================================== */

function runScripted(steps, seed, scriptSeed, cfgOverrides) {
  const sim = freshSim(cfgOverrides, seed);
  const script = makeScript(scriptSeed);
  const dt = 1 / 60;
  for (let i = 0; i < steps; i++) {
    step(sim, dt, script(i, dt));
  }
  return sim;
}

test('same seed + same scripted inputs → identical state hash over 4000 steps', () => {
  const a = runScripted(4000, 777, 4242);
  const b = runScripted(4000, 777, 4242);
  assert.equal(hashState(a), hashState(b), 'state hashes diverged');
  // Sanity: the run must actually have done something, or this proves nothing.
  assert.ok(a.score > 0, 'scripted run scored nothing — the test is not exercising the sim');
  assert.ok(a.stepCount === 4000);
});

test('divergent seed produces a different hash (the harness can detect divergence)', () => {
  const a = runScripted(600, 777, 4242);
  const b = runScripted(600, 778, 4242);
  assert.notEqual(hashState(a), hashState(b));
});

test('divergent input script produces a different hash', () => {
  const a = runScripted(600, 777, 4242);
  const b = runScripted(600, 777, 9999);
  assert.notEqual(hashState(a), hashState(b));
});

test('variable dt is still deterministic (frame pacing must not change outcomes)', () => {
  const run = () => {
    const sim = freshSim(null, 31337);
    const script = makeScript(555);
    const dtRng = makeRng(2024);
    for (let i = 0; i < 1500; i++) {
      const dt = dtRng.range(1 / 120, 1 / 30);
      step(sim, dt, script(i, dt));
    }
    return hashState(sim);
  };
  assert.equal(run(), run());
});

test('hash rounds to 1e-6, so sub-epsilon float noise is not a divergence', () => {
  const a = freshSim(null, 5);
  const b = freshSim(null, 5);
  step(a, 1 / 60, null);
  step(b, 1 / 60, null);
  b.balls[0].x += 1e-9;
  assert.equal(hashState(a), hashState(b), '1e-9 nudge should round away');
  b.balls[0].x += 1e-3;
  assert.notEqual(hashState(a), hashState(b), '1e-3 nudge should be visible');
});

/* ========================================================================== */
group('2. Stability soak');
/* ========================================================================== */

test('12000 steps of random max-strength multi-touch → no NaN/Inf, speed clamped, in bounds', () => {
  const sim = freshSim(null, 90210);
  const script = makeScript(31415, { pointers: 4, holdChance: 0.4 });
  const dt = 1 / 60;
  const clampSpeed = CONFIG.world.speedClamp * sim.scale * (1 + 1e-6);

  for (let i = 0; i < 12000; i++) {
    step(sim, dt, script(i, dt));

    // Checked every step. Messages are built only on failure — eagerly concatenating them
    // on a passing check dominated the runtime of this soak.
    const bad = allFinite(sim);
    if (bad) assert.fail('non-finite at step ' + i + ': ' + bad);
    for (const b of sim.balls) {
      if (!b.alive) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > clampSpeed) assert.fail('step ' + i + ' ball ' + b.id + ' speed ' + sp.toFixed(2) + ' > clamp ' + clampSpeed.toFixed(2));
      if (!(b.x >= -1 && b.x <= sim.width + 1)) assert.fail('step ' + i + ' ball ' + b.id + ' x=' + b.x + ' out of [0,' + sim.width + ']');
      if (!(b.y >= -1 && b.y <= sim.height + 1)) assert.fail('step ' + i + ' ball ' + b.id + ' y=' + b.y + ' out of [0,' + sim.height + ']');
    }
    if (sim.balls.length > CONFIG.population.hardCap) assert.fail('population ' + sim.balls.length + ' over hard cap');
  }
  assert.ok(sim.score > 0, 'soak scored nothing');
});

test('hostile dt (0, negative, NaN, Infinity, 10 seconds) never corrupts the sim', () => {
  const sim = freshSim(null, 4);
  const hostile = [0, -1, -0.0001, NaN, Infinity, -Infinity, 10, 1e9, undefined, null];
  for (let round = 0; round < 40; round++) {
    for (const dt of hostile) {
      step(sim, dt, { pointers: [{ id: 1, x: 100, y: 200 }] });
      const bad = allFinite(sim);
      assert.equal(bad, null, 'dt=' + dt + ' produced ' + bad);
    }
  }
  assert.ok(Number.isFinite(sim.time) && sim.time > 0);
});

test('hostile pointer input (NaN coords, missing fields, 500 pointers) is survived', () => {
  const sim = freshSim(null, 6);
  const junk = [
    { pointers: [{ id: 1, x: NaN, y: NaN }] },
    { pointers: [{ id: 1, x: Infinity, y: -Infinity }] },
    { pointers: [{ id: 2 }] },
    { pointers: [null, undefined, { id: 3, x: 1e12, y: -1e12 }] },
    { pointers: Array.from({ length: 500 }, (_, i) => ({ id: i, x: i, y: i })) },
    { pointers: 'not an array' },
    { cancelled: 'nope' },
    null,
    undefined,
  ];
  for (let round = 0; round < 30; round++) {
    for (const inp of junk) {
      step(sim, 1 / 60, inp);
      const bad = allFinite(sim);
      assert.equal(bad, null, 'input ' + JSON.stringify(inp && inp.pointers ? 'ptrs' : inp) + ' produced ' + bad);
    }
  }
  // maxPointers is a hard ceiling regardless of what the platform hands us.
  assert.ok(sim.pointers.size <= CONFIG.input.maxPointers, 'tracked ' + sim.pointers.size + ' pointers');
});

test('injected NaN and escaped balls are repaired by the sanitizer and counted', () => {
  const sim = freshSim(null, 8);
  step(sim, 1 / 60, null);
  const before = sim.sanitizerHits;

  sim.balls[0].x = NaN;
  sim.balls[1].vy = Infinity;
  sim.balls[2].y = -100000;
  sim.balls[3].r = -5;
  sim.balls[4].x = sim.width + 99999;

  step(sim, 1 / 60, null);

  assert.equal(allFinite(sim), null, 'sanitizer left something non-finite');
  assert.ok(sim.sanitizerHits >= before + 5, 'expected >=5 sanitizer hits, got ' + (sim.sanitizerHits - before));
  for (const b of sim.balls) {
    if (!b.alive) continue;
    assert.ok(b.x >= -1 && b.x <= sim.width + 1 && b.y >= -1 && b.y <= sim.height + 1);
    assert.ok(b.r > 0);
  }
});

test('resize rescales velocities with the world, not just positions and radii', () => {
  // Everything in the sim is expressed in px/s at the current scale, so a scale change has
  // to carry velocities with it. Miss this and balls move at the old screen's speed on the
  // new one: sluggish on a bigger screen, frantic on a smaller one.
  const sim = freshSim({ 'world.idleDriftStrength': 0, 'world.gravityY': 0 }, 606);
  const script = makeScript(909, { pointers: 2 });
  for (let i = 0; i < 300; i++) step(sim, 1 / 60, script(i, 1 / 60));

  const before = sim.balls.filter((b) => b.alive).map((b) => Math.hypot(b.vx, b.vy) / sim.scale);
  const meanBefore = before.reduce((a, v) => a + v, 0) / before.length;
  assert.ok(meanBefore > 1, 'nothing was moving, so this test proves nothing');

  const oldScale = sim.scale;
  resize(sim, W * 2, H * 2);                       // a genuine scale change
  assert.ok(Math.abs(sim.scale / oldScale - 2) < 1e-9, 'scale did not actually change');

  const after = sim.balls.filter((b) => b.alive).map((b) => Math.hypot(b.vx, b.vy) / sim.scale);
  const meanAfter = after.reduce((a, v) => a + v, 0) / after.length;
  assert.ok(Math.abs(meanAfter - meanBefore) / meanBefore < 0.02,
    'scale-normalised mean speed changed across a resize: '
      + meanBefore.toFixed(1) + ' -> ' + meanAfter.toFixed(1) + ' px/s @ref');

  // Radii must travel with it too, so ball size relative to the screen is unchanged.
  for (const b of sim.balls) {
    if (!b.alive) continue;
    assert.ok(b.r / sim.scale >= CONFIG.balls.minSplitRadius * 0.49
      && b.r / sim.scale <= CONFIG.balls.radiusMax * 1.01, 'radius ' + (b.r / sim.scale).toFixed(2) + ' @ref');
  }
  assert.equal(allFinite(sim), null);
});

test('resize carries the comet with it', () => {
  const sim = freshSim({ 'comet.chancePerSec': 60, 'comet.requireIntensity': 0, 'comet.minGap': 0 }, 1919);
  for (let i = 0; i < 240 && !sim.comet; i++) step(sim, 1 / 60, null);
  assert.ok(sim.comet, 'no comet to test with');
  const before = { x: sim.comet.x, y: sim.comet.y };

  resize(sim, W * 2, H * 2);
  const c = sim.comet;
  assert.ok(c, 'the comet vanished on resize');
  assert.ok(Math.abs(c.x - before.x * 2) < 1e-6 && Math.abs(c.y - before.y * 2) < 1e-6,
    'the comet was left in old coordinates: ' + c.x.toFixed(0) + ',' + c.y.toFixed(0)
      + ' expected ' + (before.x * 2).toFixed(0) + ',' + (before.y * 2).toFixed(0));
  assert.ok(Number.isFinite(c.vx) && Number.isFinite(c.vy));
  for (const v of c.tail) assert.ok(Number.isFinite(v));

  // And it must still be alive and reachable, not stranded off the new screen.
  for (let i = 0; i < 60; i++) step(sim, 1 / 60, null);
  assert.equal(allFinite(sim), null);
});

test('resize / rotation re-clamps every ball into the new bounds', () => {
  const sim = freshSim(null, 11);
  const script = makeScript(77);
  for (let i = 0; i < 400; i++) step(sim, 1 / 60, script(i, 1 / 60));

  const sizes = [[844, 390], [320, 568], [1024, 1366], [390, 844], [1, 1], [200, 900]];
  for (const [w, h] of sizes) {
    resize(sim, w, h);
    step(sim, 1 / 60, null);
    assert.equal(allFinite(sim), null, 'resize to ' + w + 'x' + h + ' produced non-finite state');
    for (const b of sim.balls) {
      if (!b.alive) continue;
      assert.ok(b.x >= -1 && b.x <= sim.width + 1, w + 'x' + h + ': x=' + b.x);
      assert.ok(b.y >= -1 && b.y <= sim.height + 1, w + 'x' + h + ': y=' + b.y);
    }
  }
});

/* ========================================================================== */
group('3. Energy sanity');
/* ========================================================================== */

/*
 * If positional correction pumps energy in, an untouched screen slowly boils. These two
 * tests are the tripwire. Idle drift is zeroed via config override (the brief's
 * requirement), scoring is zeroed so nothing levels up mid-run, and the population is
 * pinned so spawns cannot inject fresh kinetic energy.
 */
const ENERGY_OVERRIDES = {
  'world.idleDriftStrength': 0,
  'score.energyScale': 0,
  'comet.enabled': false,
  'population.startCount': 70,
  'population.softCapBase': 70,
  'population.softCapPerLevel': 0,
};

function energizedSim(extra, seed = 24680) {
  const sim = freshSim(Object.assign({}, ENERGY_OVERRIDES, extra), seed);
  // Kick everything hard so there is real energy to lose.
  const rng = makeRng(999);
  for (const b of sim.balls) {
    const a = rng.float() * Math.PI * 2;
    const sp = 500 * sim.scale * rng.range(0.6, 1);
    b.vx = Math.cos(a) * sp;
    b.vy = Math.sin(a) * sp;
  }
  return sim;
}

test('restitution < 1, no input, no drift → kinetic energy decays hard', () => {
  assert.ok(CONFIG.collision.restitution < 1, 'restitution must be < 1 for this test to mean anything');
  const sim = energizedSim();
  const e0 = totalKineticEnergy(sim);
  assert.ok(e0 > 0);
  for (let i = 0; i < 1800; i++) step(sim, 1 / 60, null);
  const e1 = totalKineticEnergy(sim);
  assert.ok(e1 < e0 * 0.05, 'KE only fell from ' + e0.toFixed(1) + ' to ' + e1.toFixed(1));
});

test('with gravity also zeroed, KE is monotonically non-increasing across every window', () => {
  const sim = energizedSim({ 'world.gravityY': 0, 'world.gravityX': 0 });
  const windows = [];
  let acc = 0, n = 0;
  for (let i = 0; i < 2400; i++) {
    step(sim, 1 / 60, null);
    acc += totalKineticEnergy(sim); n++;
    if (n === 60) { windows.push(acc / n); acc = 0; n = 0; }
  }
  assert.ok(windows.length >= 30);
  for (let i = 1; i < windows.length; i++) {
    // A strict conservation law: no window may hold more energy than the one before it.
    assert.ok(
      windows[i] <= windows[i - 1] * (1 + 1e-9) + 1e-9,
      'window ' + i + ' rose: ' + windows[i - 1].toExponential(4) + ' -> ' + windows[i].toExponential(4)
        + ' (positional correction is pumping energy in)',
    );
  }
  assert.ok(windows[windows.length - 1] < windows[0] * 0.02, 'energy did not actually dissipate');
});

test('a dense jam of overlapping balls relaxes instead of exploding', () => {
  // Positional correction's worst case: everything stacked on one point.
  const sim = freshSim(Object.assign({}, ENERGY_OVERRIDES, { 'world.gravityY': 0 }), 13);
  for (const b of sim.balls) {
    b.x = sim.width * 0.5; b.y = sim.height * 0.5; b.vx = 0; b.vy = 0;
  }
  for (let i = 0; i < 900; i++) {
    step(sim, 1 / 60, null);
    assert.equal(allFinite(sim), null, 'jam went non-finite at step ' + i);
  }
  const peak = Math.max(...sim.balls.filter((b) => b.alive).map((b) => Math.hypot(b.vx, b.vy)));
  assert.ok(peak <= CONFIG.world.speedClamp * sim.scale * (1 + 1e-6), 'jam produced speed ' + peak);
  // And it should have actually separated rather than staying welded together.
  let overlaps = 0;
  const alive = sim.balls.filter((b) => b.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const d = Math.hypot(alive[i].x - alive[j].x, alive[i].y - alive[j].y);
      if (d < (alive[i].r + alive[j].r) * 0.75) overlaps++;
    }
  }
  assert.ok(overlaps < alive.length * 0.5, 'balls stayed jammed: ' + overlaps + ' deep overlaps');
});

/* ========================================================================== */
group('4. Splitter storm');
/* ========================================================================== */

test('forced splitting, repeatedly, never exceeds the hard cap', () => {
  const sim = freshSim(null, 1234);
  const cap = CONFIG.population.hardCap;
  for (let round = 0; round < 220; round++) {
    forceSplitAll(sim);
    // aliveCount is the population; balls.length also holds not-yet-compacted tombstones
    // until the end of the step, so it is only meaningful after step() has compacted.
    assert.ok(sim.aliveCount <= cap, 'round ' + round + ': aliveCount=' + sim.aliveCount + ' > cap ' + cap);
    assert.equal(sim.aliveCount, sim.balls.filter((b) => b.alive).length, 'aliveCount drifted from reality');
    step(sim, 1 / 60, null);
    assert.ok(sim.balls.length <= cap, 'round ' + round + ' post-step: ' + sim.balls.length + ' > cap ' + cap);
    assert.equal(sim.balls.length, sim.aliveCount, 'step did not compact tombstones');
    assert.equal(allFinite(sim), null, 'round ' + round + ' non-finite');
  }
  assert.ok(sim.aliveCount > 0, 'everything vanished');
});

test('splitting respects the minimum radius and does not produce zero-size balls', () => {
  const sim = freshSim(null, 4321);
  for (let round = 0; round < 60; round++) { forceSplitAll(sim); step(sim, 1 / 60, null); }
  const minR = CONFIG.balls.minSplitRadius * sim.scale;
  for (const b of sim.balls) {
    if (!b.alive) continue;
    assert.ok(b.r > 0, 'zero radius ball');
    assert.ok(b.r >= minR * 0.499, 'ball radius ' + b.r.toFixed(3) + ' below half the min-split radius ' + minR.toFixed(3));
  }
});

test('splitter storm under full multi-touch still respects the cap', () => {
  const sim = freshSim(null, 555);
  const script = makeScript(8080, { pointers: 4 });
  const dt = 1 / 60;
  for (let i = 0; i < 900; i++) {
    if (i % 3 === 0) forceSplitAll(sim);
    step(sim, dt, script(i, dt));
    assert.ok(sim.balls.length <= CONFIG.population.hardCap, 'step ' + i + ': ' + sim.balls.length);
  }
  assert.equal(allFinite(sim), null);
});

/* ========================================================================== */
group('5. Effect storm');
/* ========================================================================== */

test('detonating every ball in one step respects the per-frame effect budget', () => {
  const sim = freshSim(null, 2468);
  step(sim, 1 / 60, null);
  const budget = CONFIG.effects.maxPerFrame;

  for (let round = 0; round < 40; round++) {
    sim.events.length = 0;
    const n = detonateAll(sim);
    assert.ok(n > 0, 'round ' + round + ': nothing detonated');
    assert.ok(
      sim.events.length <= budget,
      'round ' + round + ': ' + sim.events.length + ' events emitted, budget is ' + budget,
    );
    assert.ok(sim.eventsDropped > 0, 'round ' + round + ': excess should be counted as dropped, not queued');
    step(sim, 1 / 60, null);
    assert.equal(allFinite(sim), null, 'round ' + round + ' non-finite after storm');
    assert.ok(sim.events.length <= budget, 'round ' + round + ': step emitted ' + sim.events.length + ' events');
  }
});

test('effect budget holds during a combined split + detonate + multi-touch storm', () => {
  const sim = freshSim(null, 97531);
  const script = makeScript(1111, { pointers: 4 });
  const dt = 1 / 60;
  let maxEvents = 0;
  for (let i = 0; i < 700; i++) {
    if (i % 5 === 0) detonateAll(sim);
    if (i % 7 === 0) forceSplitAll(sim);
    step(sim, dt, script(i, dt));
    maxEvents = Math.max(maxEvents, sim.events.length);
    assert.ok(sim.events.length <= CONFIG.effects.maxPerFrame, 'step ' + i + ': ' + sim.events.length + ' events');
    assert.equal(allFinite(sim), null, 'step ' + i + ' non-finite');
    assert.ok(sim.balls.length <= CONFIG.population.hardCap);
  }
  assert.ok(maxEvents > 0, 'storm produced no events at all — the test is not exercising anything');
  assert.ok(Number.isFinite(sim.score) && sim.score >= 0);
});

test('prism shards push nothing and bounce off a wall exactly once', () => {
  const sim = freshSim({ 'world.idleDriftStrength': 0, 'world.gravityY': 0 }, 5150);
  step(sim, 1 / 60, null);

  // Park one ball in the middle at rest, and fire a shard straight at it.
  for (const b of sim.balls) { b.x = sim.width * 3; b.y = sim.height * 3; b.vx = 0; b.vy = 0; }
  const target = sim.balls[0];
  target.x = sim.width * 0.5; target.y = sim.height * 0.5; target.vx = 0; target.vy = 0;
  sim.shards.length = 0;
  sim.shards.push({
    x: target.x - 120 * sim.scale, y: target.y, vx: 600 * sim.scale, vy: 0,
    life: 3, bounces: CONFIG.types.PRISM.shardBounces, charge: 0, seed: 1,
  });

  let hit = false;
  for (let i = 0; i < 60 && !hit; i++) {
    step(sim, 1 / 60, null);
    hit = sim.events.some((e) => e.type === 'shardHit');
  }
  assert.ok(hit, 'the shard never reached the ball');
  // "push nothing": the ball it struck must not have been moved by it.
  assert.ok(Math.hypot(target.vx, target.vy) < 1e-6,
    'a shard pushed a ball to ' + Math.hypot(target.vx, target.vy).toFixed(3) + ' px/s');
  assert.equal(sim.shards.length, 0, 'the shard survived contact');

  // "bounce off a wall once": one bounce, then it is gone.
  sim.shards.length = 0;
  sim.shards.push({
    x: 30 * sim.scale, y: sim.height * 0.5, vx: -900 * sim.scale, vy: 0,
    life: 30, bounces: CONFIG.types.PRISM.shardBounces, charge: 0, seed: 2,
  });
  for (const b of sim.balls) { b.x = sim.width * 3; b.y = sim.height * 3; }
  let bounces = 0;
  for (let i = 0; i < 600 && sim.shards.length; i++) {
    step(sim, 1 / 60, null);
    bounces += sim.events.filter((e) => e.type === 'shardBounce').length;
  }
  assert.equal(bounces, CONFIG.types.PRISM.shardBounces,
    'shard bounced ' + bounces + ' times, config says ' + CONFIG.types.PRISM.shardBounces);
  assert.equal(sim.shards.length, 0, 'the shard outlived its bounce allowance');
});

test('prism shards are capped and always expire', () => {
  const sim = freshSim(null, 60606);
  const cap = CONFIG.types.PRISM.maxShards;
  // Force a shard flood.
  for (let round = 0; round < 30; round++) {
    for (const b of sim.balls) { b.type = 'PRISM'; b.effectT = 0; }
    for (let k = 0; k < 6; k++) {
      for (const b of sim.balls) {
        if (!b.alive) continue;
        b.effectT = 0;
        b.chargeT = 2;              // type effects only fire on charged balls
        b.vx = 900 * sim.scale; b.vy = 0;
      }
      step(sim, 1 / 60, null);
      assert.ok(sim.shards.length <= cap, 'shard count ' + sim.shards.length + ' over cap ' + cap);
    }
  }
  // Let them all die out. Pin the spawn pool to ORB too, or the population manager keeps
  // spawning fresh prisms that emit more shards.
  sim.unlocked = ['ORB'];
  for (const b of sim.balls) { b.type = 'ORB'; b.chargeT = 0; }
  for (let i = 0; i < 400; i++) step(sim, 1 / 60, null);
  assert.equal(sim.shards.length, 0, 'shards never expired: ' + sim.shards.length + ' left');
});

/* ========================================================================== */
group('6. Timers');
/* ========================================================================== */

test('frozen balls always recover after freezeTime', () => {
  const sim = freshSim(null, 777777);
  step(sim, 1 / 60, null);
  const freezeTime = CONFIG.types.FROST.freezeTime;
  for (const b of sim.balls) { b.frozenT = freezeTime; b.frozenFromX = b.x - 5; b.frozenFromY = b.y; }
  const frozenIds = sim.balls.filter((b) => b.alive).map((b) => b.id);
  assert.ok(frozenIds.length > 0);

  const steps = Math.ceil((freezeTime + 0.25) * 60);
  for (let i = 0; i < steps; i++) step(sim, 1 / 60, null);

  for (const b of sim.balls) {
    if (!b.alive) continue;
    assert.equal(b.frozenT, 0, 'ball ' + b.id + ' still frozen (' + b.frozenT + ')');
  }
});

test('inert (discharged) volatiles always recharge after inertTime', () => {
  const sim = freshSim(null, 888888);
  step(sim, 1 / 60, null);
  const inertTime = CONFIG.types.VOLATILE.inertTime;
  for (const b of sim.balls) { b.type = 'VOLATILE'; b.inertT = inertTime; }
  const steps = Math.ceil((inertTime + 0.25) * 60);
  for (let i = 0; i < steps; i++) step(sim, 1 / 60, null);
  for (const b of sim.balls) {
    if (!b.alive) continue;
    assert.equal(b.inertT, 0, 'ball ' + b.id + ' still inert (' + b.inertT + ')');
  }
});

test('no timer can get stuck under a 20-second storm — everything drains when it stops', () => {
  const sim = freshSim(null, 191919);
  const script = makeScript(2323, { pointers: 4 });
  const dt = 1 / 60;
  for (let i = 0; i < 1200; i++) {
    if (i % 4 === 0) detonateAll(sim);
    step(sim, dt, script(i, dt));
  }
  // Now stop everything and let it settle for well past the longest duration.
  for (const b of sim.balls) b.type = 'ORB';
  const longest = Math.max(
    CONFIG.types.VOLATILE.inertTime, CONFIG.types.FROST.freezeTime,
    CONFIG.types.FROST.immuneTime, CONFIG.types.MAGNET.spikeTime,
    CONFIG.collision.effectCooldown, CONFIG.types.SPLITTER.cooldown,
  );
  for (let i = 0; i < Math.ceil((longest + 2) * 60); i++) step(sim, dt, null);

  // Then wait for genuine quiet before asserting. A hard impact landing in the final frames
  // legitimately sets a fresh cooldown; "no timer gets stuck" means everything drains once
  // nothing is happening, not that a cooldown may never be running.
  let quiet = 0;
  for (let i = 0; i < 60 * 60 && quiet < 60; i++) {
    step(sim, dt, null);
    quiet = sim.hardImpactsThisStep === 0 ? quiet + 1 : 0;
  }
  assert.ok(quiet >= 60, 'the world never went quiet, so this test could not run');
  for (let i = 0; i < Math.ceil((longest + 1) * 60); i++) step(sim, dt, null);

  for (const b of sim.balls) {
    if (!b.alive) continue;
    for (const k of ['frozenT', 'inertT', 'effectT', 'scoreT', 'splitT', 'spikeT', 'immuneT', 'magnetT', 'chargeT']) {
      assert.equal(b[k], 0, 'ball ' + b.id + ' has ' + k + ' = ' + b[k] + ' stuck');
    }
  }
});

test('a frozen ball detonated mid-freeze still ends up thawed (no stranded state)', () => {
  const sim = freshSim(null, 4545);
  step(sim, 1 / 60, null);
  const a = sim.balls[0], b = sim.balls[1];
  b.x = a.x + a.r + b.r + 1; b.y = a.y;
  b.frozenT = CONFIG.types.FROST.freezeTime;
  b.frozenFromX = a.x; b.frozenFromY = a.y;
  a.type = 'VOLATILE'; a.inertT = 0; a.effectT = 0;
  detonate(sim, a, 1);
  for (let i = 0; i < Math.ceil((CONFIG.types.FROST.freezeTime + 0.5) * 60); i++) step(sim, 1 / 60, null);
  if (b.alive) assert.equal(b.frozenT, 0, 'detonated frozen ball stayed frozen');
});

/* ========================================================================== */
group('7. Score, combo, levels');
/* ========================================================================== */

test('score never decreases across a long chaotic run', () => {
  const sim = freshSim(null, 31415);
  const script = makeScript(2718, { pointers: 4 });
  const dt = 1 / 60;
  let prev = sim.score;
  for (let i = 0; i < 5000; i++) {
    if (i % 11 === 0) detonateAll(sim);
    if (i % 13 === 0) forceSplitAll(sim);
    if (i % 200 === 0) scatter(sim);
    step(sim, dt, script(i, dt));
    assert.ok(sim.score >= prev, 'score fell at step ' + i + ': ' + prev + ' -> ' + sim.score);
    assert.ok(Number.isInteger(sim.score), 'score is not an integer: ' + sim.score);
    prev = sim.score;
  }
  assert.ok(sim.score > 0, 'nothing scored');
});

test('combo decays to baseline after quiet, and its multiplier returns to exactly 1', () => {
  const sim = freshSim(null, 5150);
  const script = makeScript(1717, { pointers: 3, holdChance: 0.1 });
  const dt = 1 / 60;
  for (let i = 0; i < 1500; i++) step(sim, dt, script(i, dt));
  assert.ok(sim.comboCount > 0, 'never built a combo — the test proves nothing');

  const peak = sim.comboCount;
  const quietSteps = Math.ceil((CONFIG.score.comboWindow + peak * CONFIG.score.comboDecayStep + 5) * 60);
  for (let i = 0; i < quietSteps; i++) step(sim, dt, null);

  assert.equal(sim.comboCount, 0, 'combo did not decay to 0 (at ' + sim.comboCount + ' from peak ' + peak + ')');
  assert.equal(sim.comboMult, 1, 'combo multiplier did not return to 1 (at ' + sim.comboMult + ')');
});

test('combo survives the ~2.5s window and only then starts shedding', () => {
  const sim = freshSim(null, 606);
  step(sim, 1 / 60, null);
  sim.comboCount = 20;
  sim.comboTimer = CONFIG.score.comboWindow;
  sim.comboDecayAcc = 0;
  // Just under the window: untouched.
  for (let i = 0; i < Math.floor((CONFIG.score.comboWindow - 0.15) * 60); i++) step(sim, 1 / 60, null);
  assert.equal(sim.comboCount, 20, 'combo decayed early (at ' + sim.comboCount + ')');
  // Well past it: shedding.
  for (let i = 0; i < Math.ceil(3 * CONFIG.score.comboDecayStep * 60) + 20; i++) step(sim, 1 / 60, null);
  assert.ok(sim.comboCount < 20, 'combo never started decaying');
});

test('combo multiplier is sublinear, uncapped, and monotonically increasing', () => {
  assert.equal(comboMultiplier(0), 1);
  let prev = comboMultiplier(0);
  for (let n = 1; n <= 5000; n++) {
    const m = comboMultiplier(n);
    assert.ok(m > prev, 'multiplier not increasing at ' + n);
    prev = m;
  }
  // Sublinear: doubling the count must less than double the bonus.
  const b100 = comboMultiplier(100) - 1;
  const b200 = comboMultiplier(200) - 1;
  assert.ok(b200 < b100 * 2, 'multiplier growth is not sublinear');
  // Uncapped: it keeps climbing at absurd counts.
  assert.ok(comboMultiplier(1e6) > comboMultiplier(1e5), 'multiplier is capped');
  assert.ok(Number.isFinite(comboMultiplier(1e9)));
});

test('level thresholds are strictly increasing and finite', () => {
  let prev = 0;
  for (let lv = 1; lv <= 3000; lv++) {
    const t = levelThreshold(lv);
    assert.ok(Number.isFinite(t), 'threshold at level ' + lv + ' is ' + t);
    assert.ok(t > prev, 'threshold not increasing at level ' + lv + ': ' + prev + ' -> ' + t);
    prev = t;
  }
});

test('levels unlock every ball type in order, and the first unlock is reachable fast', () => {
  const sim = freshSim(null, 24);
  assert.deepEqual(sim.unlocked, ['ORB'], 'a fresh save must start with ORB only');

  const script = makeScript(4646, { pointers: 2, holdChance: 0.3 });
  const dt = 1 / 60;
  let firstUnlockTime = null;
  const order = [];
  for (let i = 0; i < 60 * 60 * 6; i++) {
    step(sim, dt, script(i, dt));
    for (const ev of sim.events) {
      if (ev.type === 'unlock') {
        order.push(ev.key);
        if (firstUnlockTime === null) firstUnlockTime = sim.time;
      }
    }
    if (order.length === CONFIG.unlockOrder.length) break;
  }
  assert.deepEqual(order, CONFIG.unlockOrder, 'types unlocked out of order');
  assert.ok(firstUnlockTime !== null, 'nothing ever unlocked');
  assert.ok(firstUnlockTime <= 15, 'first unlock took ' + firstUnlockTime.toFixed(1) + 's, brief says ~15s');
  assert.ok(sim.unlocked.indexOf('GOLD') >= 0, 'GOLD never unlocked');
});

test('after every type is out, levels keep raising the global multiplier and the ball cap', () => {
  const sim = freshSim(null, 25);
  const lastUnlock = Math.max(...CONFIG.unlockOrder.map((k) => CONFIG.types[k].unlockLevel));
  const seen = [];
  // Drive genuine level-ups by feeding xp, rather than poking sim.level.
  while (sim.level < lastUnlock) { sim.xp += sim.xpNeeded; step(sim, 1 / 60, null); }
  seen.push({ lv: sim.level, mult: sim.globalMult, cap: sim.softCap });
  for (let i = 0; i < 40; i++) {
    sim.xp += sim.xpNeeded;
    step(sim, 1 / 60, null);
    seen.push({ lv: sim.level, mult: sim.globalMult, cap: sim.softCap });
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].mult > seen[i - 1].mult, 'global multiplier stopped growing at level ' + seen[i].lv);
    assert.ok(seen[i].cap >= seen[i - 1].cap, 'ball cap went backwards at level ' + seen[i].lv);
  }
  assert.ok(seen[seen.length - 1].cap <= CONFIG.population.hardCap, 'soft cap exceeded the hard cap');
});

test('the population soft cap never pushes past the hard cap, at any level', () => {
  for (const lv of [1, 10, 50, 200, 5000, 100000]) {
    const sim = freshSim(null, 26);
    sim.level = lv;
    step(sim, 1 / 60, null);
    assert.ok(sim.softCap <= CONFIG.population.hardCap, 'level ' + lv + ' soft cap ' + sim.softCap);
  }
});

test('milestones are crossed once each, in ascending order, and never duplicate', () => {
  const sim = freshSim(null, 27);
  const ladder = milestoneLadder();
  const fired = [];
  for (let i = 0; i < 4000; i++) {
    sim.score += 900;   // march the lifetime score upward
    step(sim, 1 / 60, null);
    for (const ev of sim.events) if (ev.type === 'milestone') fired.push(ev.value);
  }
  assert.ok(fired.length > 3, 'no milestones fired');
  for (let i = 1; i < fired.length; i++) {
    assert.ok(fired[i] > fired[i - 1], 'milestones out of order: ' + fired[i - 1] + ' then ' + fired[i]);
  }
  assert.equal(new Set(sim.milestones).size, sim.milestones.length, 'duplicate milestone ids');
  for (const v of fired) assert.ok(ladder.indexOf(v) >= 0, v + ' is not on the ladder');
});

test('an untouched screen is genuinely CALM after ten seconds', () => {
  const sim = freshSim(null, 28);
  const script = makeScript(3131, { pointers: 4, holdChance: 0.1 });
  const dt = 1 / 60;
  for (let i = 0; i < 1200; i++) step(sim, dt, script(i, dt));
  assert.ok(sim.intensity > CONFIG.intensity.calmBelow, 'play did not raise intensity above calm');

  const peak = sim.comboCount;
  let hardImpacts = 0;
  for (let i = 0; i < Math.ceil(CONFIG.intensity.calmSettleTime * 60); i++) {
    step(sim, dt, null);
    if (i > 60 * 8) hardImpacts += sim.hardImpactsThisStep;   // the last two seconds
  }
  assert.equal(sim.mode, 'CALM', 'still ' + sim.mode + ' at intensity ' + sim.intensity.toFixed(3) + ' after 10 quiet seconds');
  assert.ok(sim.intensity < CONFIG.intensity.calmBelow, 'intensity ' + sim.intensity.toFixed(3));
  assert.ok(sim.untouchedTime >= CONFIG.intensity.calmSettleTime - 0.001);
  // "Genuinely quiet" means nothing is still going off, not that a five-thousand combo has
  // finished unwinding — that is a separate (and separately tested) wind-down.
  assert.equal(hardImpacts, 0, hardImpacts + ' hard impacts were still firing in the last 2 quiet seconds');
  assert.ok(sim.comboCount < peak, 'combo is not even decaying (still ' + sim.comboCount + ')');
  const fastest = Math.max(...sim.balls.filter((b) => b.alive).map((b) => Math.hypot(b.vx, b.vy)));
  assert.ok(fastest < CONFIG.collision.hardImpactSpeed * sim.scale,
    'a ball is still moving at ' + fastest.toFixed(0) + ' px/s, fast enough to make a hard impact');
});

test('cancelled pointers clear their field without slinging (iOS pointercancel)', () => {
  const build = (cancel) => {
    const sim = freshSim(null, 29);
    // Hold still long enough to gather a real orbit.
    for (let i = 0; i < 180; i++) {
      step(sim, 1 / 60, { pointers: [{ id: 1, x: sim.width * 0.5, y: sim.height * 0.5 }] });
    }
    const f = sim.pointers.get(1);
    assert.ok(f && f.gather > 0.5, 'field never morphed into an attractor (gather=' + (f && f.gather) + ')');
    step(sim, 1 / 60, cancel ? { pointers: [], cancelled: [1] } : { pointers: [] });
    return sim;
  };
  const cancelled = build(true);
  const released = build(false);

  // A cancel is instant: iOS fires pointercancel on system gestures and a field that
  // outlives the finger by even a moment is the stuck-invisible-field bug.
  assert.equal(cancelled.pointers.size, 0, 'cancelled field was not cleared immediately');
  assert.ok(!cancelled.events.some((e) => e.type === 'sling'), 'a cancelled pointer slung — that is the stuck-field bug');

  // A clean release slings, then fades out over field.releaseFade rather than hard-cutting.
  assert.ok(released.events.some((e) => e.type === 'sling'), 'a released gather did NOT sling');
  const fading = released.pointers.get(1);
  if (fading) {
    assert.equal(fading.down, false, 'released field still reads as held');
    assert.equal(fading.gather, 0, 'a lifted finger must stop attracting immediately');
  }
  // ...and it is always gone once the fade is over. No field ever outlives its finger.
  for (let i = 0; i < Math.ceil((CONFIG.field.releaseFade + 0.1) * 60); i++) step(released, 1 / 60, { pointers: [] });
  assert.equal(released.pointers.size, 0, 'released field never went away — stuck field');

  // A cancelled field applies no further force at all, from the very next step.
  const before = cancelled.balls.map((b) => Math.hypot(b.vx, b.vy));
  step(cancelled, 1 / 60, { pointers: [] });
  assert.equal(cancelled.pointers.size, 0);
  assert.equal(before.length, cancelled.balls.length);
});

test('a recycled pointer id does not drag the old field across the screen', () => {
  // Platforms recycle pointer ids. If a re-tap reuses a field that is still fading out,
  // its smoothed position sweeps from the old touch to the new one, which the physics
  // reads as an enormous swipe the player never made.
  const sim = freshSim({ 'world.idleDriftStrength': 0, 'world.gravityY': 0 }, 8123);
  for (let i = 0; i < 90; i++) step(sim, 1 / 60, { pointers: [{ id: 1, x: 40, y: 100 }] });
  step(sim, 1 / 60, { pointers: [] });                     // release; the field starts fading
  assert.ok(sim.pointers.has(1), 'the field should still be fading, or this proves nothing');

  // Re-tap with the SAME id, far away, while the old field is mid-fade.
  const farX = sim.width - 40, farY = sim.height - 100;
  step(sim, 1 / 60, { pointers: [{ id: 1, x: farX, y: farY }] });
  const f = sim.pointers.get(1);
  assert.ok(f, 'no field after the re-tap');
  assert.ok(Math.hypot(f.sx - farX, f.sy - farY) < 1,
    'the field was placed at ' + f.sx.toFixed(0) + ',' + f.sy.toFixed(0) + ' instead of the new touch');
  assert.ok(f.speed < 1, 'the re-tap inherited a field velocity of ' + f.speed.toFixed(0) + ' px/s');

  for (let i = 0; i < 10; i++) {
    step(sim, 1 / 60, { pointers: [{ id: 1, x: farX, y: farY }] });
    assert.ok(f.speed < CONFIG.gather.flickSpeed * sim.scale,
      'phantom field speed ' + f.speed.toFixed(0) + ' px/s after a recycled-id re-tap');
  }
  assert.equal(allFinite(sim), null);
});

test('holding still gathers a real orbit: balls arrive at the shell AND circulate', () => {
  // This is the test that was missing. The attractor can look completely alive — the ring
  // draws, the morph animates, the sling still throws whatever drifted nearby — while
  // applying no force whatsoever. Assert the physics, not the appearance.
  const sim = freshSim(null, 31);
  const cx = sim.width / 2, cy = sim.height / 2;
  for (let i = 0; i < 60 * 5; i++) step(sim, 1 / 60, { pointers: [{ id: 1, x: cx, y: cy }] });

  const f = sim.pointers.get(1);
  assert.ok(f && f.gather > 0.99, 'the field never became an attractor');

  // The orbit settles where the spring supplies the centripetal acceleration the spin needs.
  const G = CONFIG.gather;
  const k = G.orbitSpring, r0 = G.orbitRadius * sim.scale, v = G.orbitSpin * sim.scale;
  const shell = (k * r0 + Math.sqrt(k * k * r0 * r0 + 4 * k * v * v)) / (2 * k);

  let captured = 0, nearShell = 0, circulating = 0, sumTan = 0;
  for (const b of sim.balls) {
    if (!b.alive) continue;
    const dx = b.x - f.sx, dy = b.y - f.sy;
    const d = Math.hypot(dx, dy);
    if (d > G.captureRadius * sim.scale) continue;
    captured++;
    if (d < shell * 1.9) nearShell++;
    const nx = dx / d, ny = dy / d;
    const tan = b.vx * -ny + b.vy * nx;
    sumTan += Math.abs(tan);
    if (Math.abs(tan) > 80 * sim.scale) circulating++;
  }

  assert.ok(captured >= 20, 'the attractor only gathered ' + captured + ' balls');
  assert.ok(nearShell >= captured * 0.7,
    'only ' + nearShell + '/' + captured + ' gathered balls reached the ' + shell.toFixed(0) + 'px shell');
  // Gathered but barely moving means gravity/momentum brought them, not the attractor.
  const meanTan = sumTan / captured;
  assert.ok(meanTan > G.orbitSpin * sim.scale * 0.5,
    'gathered balls are not circulating: mean |tangential| = ' + meanTan.toFixed(0)
      + ' px/s against an orbitSpin target of ' + (G.orbitSpin * sim.scale).toFixed(0));
  assert.ok(circulating >= captured * 0.8,
    'only ' + circulating + '/' + captured + ' gathered balls are actually orbiting');
});

test('the attractor works from anywhere on screen and on any seed', () => {
  // The failure mode this guards was seed- and position-independent, but a gather that only
  // works in the middle of the screen would be just as broken in practice.
  const spots = [[0.5, 0.5], [0.25, 0.2], [0.8, 0.75], [0.5, 0.12], [0.12, 0.5]];
  for (const seed of [3, 31, 77]) {
    for (const [fx, fy] of spots) {
      const sim = freshSim(null, seed);
      const x = sim.width * fx, y = sim.height * fy;
      for (let i = 0; i < 60 * 4; i++) step(sim, 1 / 60, { pointers: [{ id: 1, x, y }] });
      const f = sim.pointers.get(1);
      let captured = 0, sumTan = 0;
      for (const b of sim.balls) {
        if (!b.alive) continue;
        const dx = b.x - f.sx, dy = b.y - f.sy, d = Math.hypot(dx, dy);
        if (d > CONFIG.gather.captureRadius * sim.scale) continue;
        captured++;
        sumTan += Math.abs(b.vx * (-dy / d) + b.vy * (dx / d));
      }
      const where = 'seed ' + seed + ' at ' + (fx * 100) + '%,' + (fy * 100) + '%';
      assert.ok(captured >= 12, where + ': gathered only ' + captured + ' balls');
      assert.ok(sumTan / captured > CONFIG.gather.orbitSpin * sim.scale * 0.4,
        where + ': gathered balls are not circulating (' + (sumTan / captured).toFixed(0) + ' px/s)');
    }
  }
});

test('gather then release actually throws balls outward (the sling does work)', () => {
  const sim = freshSim({ 'world.idleDriftStrength': 0 }, 30);
  const cx = sim.width * 0.5, cy = sim.height * 0.5;
  for (let i = 0; i < 240; i++) step(sim, 1 / 60, { pointers: [{ id: 1, x: cx, y: cy }] });

  const capR = CONFIG.gather.captureRadius * sim.scale;
  const before = sim.balls.filter((b) => b.alive && Math.hypot(b.x - cx, b.y - cy) <= capR);
  assert.ok(before.length >= 3, 'gather collected only ' + before.length + ' balls');
  const speedBefore = before.reduce((s, b) => s + Math.hypot(b.vx, b.vy), 0) / before.length;

  step(sim, 1 / 60, { pointers: [] });
  const speedAfter = before.filter((b) => b.alive).reduce((s, b) => s + Math.hypot(b.vx, b.vy), 0)
    / Math.max(1, before.filter((b) => b.alive).length);

  assert.ok(speedAfter > speedBefore * 1.5, 'sling barely moved anything: ' + speedBefore.toFixed(1) + ' -> ' + speedAfter.toFixed(1));
  assert.ok(speedAfter > CONFIG.gather.slingBase * sim.scale * 0.4, 'sling speed too low: ' + speedAfter.toFixed(1));
});

test('a FAST swipe flings balls along the swipe; a slow drag only pushes them outward', () => {
  // The brief's headline feel requirement, and the one most easily faked: a field that
  // only pushes radially would scatter balls symmetrically no matter how fast it moved.
  const swipe = (speed) => {
    const sim = freshSim({ 'world.idleDriftStrength': 0, 'world.gravityY': 0 }, 77);
    const y = sim.height / 2;
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) step(sim, dt, null);
    const touched = new Map();
    let x = 40;
    while (x < sim.width - 40) {
      for (const b of sim.balls) {
        if (b.alive && Math.abs(b.y - y) < 70 && Math.abs(b.x - x) < 70 && !touched.has(b.id)) {
          touched.set(b.id, b);
        }
      }
      step(sim, dt, { pointers: [{ id: 1, x, y }] });
      x += speed * sim.scale * dt;
    }
    for (let i = 0; i < 6; i++) step(sim, dt, { pointers: [] });

    let sx = 0, sy = 0, n = 0, along = 0;
    for (const b of touched.values()) {
      if (!b.alive) continue;
      if (Math.hypot(b.vx, b.vy) < 20 * sim.scale) continue;
      sx += b.vx; sy += b.vy; n++;
      if (b.vx > 0) along++;
    }
    assert.ok(n >= 6, 'swipe at ' + speed + ' only moved ' + n + ' balls');
    return { angle: Math.atan2(sy / n, sx / n) * 180 / Math.PI, alongPct: 100 * along / n, n };
  };

  const slow = swipe(240);
  const fast = swipe(1500);

  // A fast swipe: most balls end up travelling WITH it, and the mean direction is the
  // swipe's own direction (0 degrees) rather than something radial.
  assert.ok(fast.alongPct >= 70,
    'only ' + fast.alongPct.toFixed(0) + '% of balls travel with a fast swipe');
  assert.ok(Math.abs(fast.angle) < 30,
    'fast-swipe mean velocity is ' + fast.angle.toFixed(0) + ' degrees off the swipe direction');

  // And it must be genuinely velocity-dependent, not just "the field always shoves right".
  assert.ok(fast.alongPct > slow.alongPct + 20,
    'a fast swipe is no more directional than a slow drag ('
      + fast.alongPct.toFixed(0) + '% vs ' + slow.alongPct.toFixed(0) + '%) — the fling term is not working');
});

/* ========================================================================== */
group('8. Save roundtrip and corruption');
/* ========================================================================== */

test('serialize → JSON → load is identical', () => {
  const sim = freshSim(null, 606060);
  const script = makeScript(9090, { pointers: 3 });
  for (let i = 0; i < 3000; i++) step(sim, 1 / 60, script(i, 1 / 60));

  const a = serializeSave(sim);
  const b = loadSave(JSON.stringify(a));
  assert.deepEqual(b, a, 'save did not survive a JSON roundtrip');

  // And a second roundtrip is a fixed point.
  const c = loadSave(JSON.stringify(b));
  assert.deepEqual(c, b);

  // The save must carry real progress, or this proves nothing.
  assert.ok(a.lifetimeScore > 0 && a.level >= 1);
});

test('a loaded save restores score, level, combo record, unlocks and milestones', () => {
  const sim = freshSim(null, 707070);
  const script = makeScript(1212, { pointers: 3 });
  for (let i = 0; i < 6000; i++) step(sim, 1 / 60, script(i, 1 / 60));
  const saved = serializeSave(sim);
  assert.ok(saved.unlocked.length > 1, 'never unlocked anything to test with');

  const reborn = createSim({ config: cloneConfig(), rng: makeRng(1), width: W, height: H, save: saved });
  assert.equal(reborn.score, saved.lifetimeScore);
  assert.equal(reborn.level, saved.level);
  assert.equal(reborn.bestCombo, saved.bestCombo);
  assert.deepEqual(reborn.unlocked, saved.unlocked);
  assert.deepEqual(reborn.milestones, saved.milestones);
  assert.equal(reborn.plays, saved.plays + 1, 'play count should advance on load');
});

test('corrupt, hostile, and wrong-version saves all yield clean defaults without throwing', () => {
  const def = defaultSave();
  const junk = [
    '', '{', '{"v":', 'null', 'undefined', '[]', '[1,2,3]', '"a string"', '42', 'true',
    '{}', '{"v":0}', '{"v":"3"}', '{"v":999}', '{"v":2,"lifetimeScore":100}',
    JSON.stringify({ v: CONFIG.save.version - 1, lifetimeScore: 999999 }),
    null, undefined, 0, NaN, [], () => {}, Symbol ? 'x' : 'x',
    ' garbage',
    'a'.repeat(100000),
  ];
  for (const j of junk) {
    let out;
    assert.doesNotThrow(() => { out = loadSave(j); }, 'threw on ' + String(j).slice(0, 30));
    assert.deepEqual(out, def, 'did not return defaults for ' + String(j).slice(0, 30));
  }
});

test('a valid-version save with missing or mistyped fields is repaired field by field', () => {
  const v = CONFIG.save.version;
  const cases = [
    [{ v }, 'empty but valid version'],
    [{ v, lifetimeScore: 'abc', level: null, xp: {}, bestCombo: [] }, 'mistyped scalars'],
    [{ v, lifetimeScore: -5000, level: -3, xp: -1, bestCombo: -9 }, 'negatives'],
    [{ v, lifetimeScore: NaN, level: Infinity, xp: -Infinity }, 'non-finite'],
    [{ v, milestones: 'not an array' }, 'milestones wrong type'],
    [{ v, milestones: [1, 2, {}, null, 's1000', 's1000', true] }, 'milestones with junk'],
    [{ v, unlocked: ['ORB', 'NOT_A_TYPE', 42, 'GOLD'] }, 'unlocked with junk'],
    [{ v, unlocked: [] }, 'unlocked empty'],
    [{ v, paletteIndex: 9999 }, 'palette out of range'],
    [{ v, lifetimeScore: 1e308 * 10 }, 'overflow'],
  ];
  for (const [obj, label] of cases) {
    let out;
    assert.doesNotThrow(() => { out = loadSave(obj); }, label + ' threw');
    assert.equal(typeof out, 'object', label);
    assert.ok(Number.isFinite(out.lifetimeScore) && out.lifetimeScore >= 0, label + ': lifetimeScore ' + out.lifetimeScore);
    assert.ok(Number.isInteger(out.level) && out.level >= 1, label + ': level ' + out.level);
    assert.ok(Number.isFinite(out.xp) && out.xp >= 0, label + ': xp ' + out.xp);
    assert.ok(Number.isFinite(out.bestCombo) && out.bestCombo >= 0, label + ': bestCombo ' + out.bestCombo);
    assert.ok(Array.isArray(out.milestones), label + ': milestones');
    assert.ok(out.milestones.every((m) => typeof m === 'string'), label + ': non-string milestone');
    assert.ok(Array.isArray(out.unlocked) && out.unlocked[0] === 'ORB', label + ': unlocked ' + out.unlocked);
    assert.ok(out.paletteIndex >= 0 && out.paletteIndex < CONFIG.palettes.length, label + ': palette');
    // And a sim built on the repaired save must run.
    const sim = createSim({ config: cloneConfig(), rng: makeRng(3), width: W, height: H, save: out });
    for (let i = 0; i < 60; i++) step(sim, 1 / 60, null);
    assert.equal(allFinite(sim), null, label + ': sim went non-finite');
  }
});

test('applySave resets a live sim in place — a wipe really is a first run', () => {
  const sim = freshSim(null, 4004);
  const script = makeScript(2002, { pointers: 3 });
  for (let i = 0; i < 4000; i++) step(sim, 1 / 60, script(i, 1 / 60));
  assert.ok(sim.score > 0 && sim.unlocked.length > 1 && sim.milestones.length > 0,
    'the sim did not accumulate anything to reset');

  applySave(sim, defaultSave());

  assert.equal(sim.score, 0, 'score survived the wipe');
  assert.equal(sim.level, 1);
  assert.equal(sim.xp, 0);
  assert.equal(sim.bestCombo, 0);
  assert.equal(sim.comboCount, 0);
  assert.equal(sim.comboMult, 1);
  assert.deepEqual(sim.unlocked, ['ORB'], 'unlocks survived the wipe');
  assert.deepEqual(sim.milestones, []);
  assert.equal(deriveStars(serializeSave(sim)).stars.length, 0, 'the sky survived the wipe');
  // Balls of a no-longer-unlocked type must revert, or a "first run" is full of gold.
  for (const b of sim.balls) {
    if (b.alive) assert.equal(b.type, 'ORB', 'ball kept type ' + b.type + ' after a wipe');
  }
  // And it must still run.
  for (let i = 0; i < 300; i++) step(sim, 1 / 60, script(i, 1 / 60));
  assert.equal(allFinite(sim), null);
  assert.ok(sim.score >= 0);
});

test('applySave restores an arbitrary save onto a running sim', () => {
  const donor = freshSim(null, 5005);
  const script = makeScript(6006, { pointers: 2 });
  for (let i = 0; i < 5000; i++) step(donor, 1 / 60, script(i, 1 / 60));
  const payload = serializeSave(donor);

  const target = freshSim(null, 7007);
  applySave(target, payload);
  assert.equal(target.score, payload.lifetimeScore);
  assert.equal(target.level, payload.level);
  assert.deepEqual(target.unlocked, payload.unlocked);
  assert.deepEqual(target.milestones, payload.milestones);
  assert.equal(target.xpNeeded, levelThreshold(payload.level), 'derived state was not refreshed');
  // A corrupt payload must land on clean defaults rather than throwing.
  assert.doesNotThrow(() => applySave(target, '{{{not json'));
  assert.equal(target.score, 0);
  assert.equal(target.level, 1);
});

test('a prototype-pollution attempt in a save is inert', () => {
  const evil = '{"v":' + CONFIG.save.version + ',"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}';
  const out = loadSave(evil);
  assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
  assert.equal(out.polluted, undefined);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(defaultSave()).sort());
});

test('milestone list is bounded so a hostile save cannot blow up memory', () => {
  const huge = { v: CONFIG.save.version, milestones: Array.from({ length: 50000 }, (_, i) => 's' + i) };
  const out = loadSave(huge);
  assert.ok(out.milestones.length <= 4096, 'milestones not bounded: ' + out.milestones.length);
  const sky = deriveStars(out);
  assert.ok(sky.stars.length <= CONFIG.sky.maxStars);
});

/* ========================================================================== */
group('9. The sky');
/* ========================================================================== */

test('stars derive deterministically from the save', () => {
  const save = defaultSave();
  save.milestones = ['s1000', 's2500', 's5000', 'c1', 's10000', 's25000'];
  const a = deriveStars(save);
  const b = deriveStars(JSON.parse(JSON.stringify(save)));
  assert.deepEqual(a, b, 'same save produced a different sky');

  // Order and identity matter; content defines position.
  const shuffled = Object.assign({}, save, { milestones: save.milestones.slice().reverse() });
  const c = deriveStars(shuffled);
  assert.equal(c.stars.length, a.stars.length);
  const byId = new Map(a.stars.map((s) => [s.id, s]));
  for (const s of c.stars) {
    const orig = byId.get(s.id);
    assert.ok(orig, 'unexpected star id ' + s.id);
    assert.equal(s.x, orig.x, 'star ' + s.id + ' moved when the list was reordered');
    assert.equal(s.y, orig.y, 'star ' + s.id + ' moved when the list was reordered');
  }
});

test('star count is capped; further milestones brighten instead of adding', () => {
  const cap = CONFIG.sky.maxStars;
  const save = defaultSave();
  save.milestones = Array.from({ length: cap + 250 }, (_, i) => 'm' + i);
  const sky = deriveStars(save);
  assert.equal(sky.stars.length, cap, 'star count ' + sky.stars.length + ' != cap ' + cap);
  assert.equal(sky.extra, 250);
  assert.ok(sky.brighten > 0, 'post-cap milestones did not brighten anything');
  assert.ok(sky.brighten <= CONFIG.sky.maxBrighten, 'brighten unbounded: ' + sky.brighten);

  // Under the cap, every milestone is a star.
  for (const n of [0, 1, 5, cap - 1, cap]) {
    const s = defaultSave();
    s.milestones = Array.from({ length: n }, (_, i) => 'm' + i);
    const out = deriveStars(s);
    assert.equal(out.stars.length, n, 'expected ' + n + ' stars, got ' + out.stars.length);
    assert.equal(out.extra, 0);
  }
});

test('stars stay inside the screen, and constellation links are bounded and valid', () => {
  const save = defaultSave();
  save.milestones = Array.from({ length: CONFIG.sky.maxStars }, (_, i) => 'star-' + i * 7919);
  const sky = deriveStars(save);
  for (const s of sky.stars) {
    assert.ok(s.x >= CONFIG.sky.edgeInset - 1e-9 && s.x <= 1 - CONFIG.sky.edgeInset + 1e-9, 'star x=' + s.x);
    assert.ok(s.y >= CONFIG.sky.edgeInset - 1e-9 && s.y <= 1 - CONFIG.sky.edgeInset + 1e-9, 'star y=' + s.y);
    assert.ok(Number.isFinite(s.mag) && s.mag > 0, 'star mag ' + s.mag);
  }
  assert.ok(sky.links.length <= CONFIG.sky.maxLinks, 'too many links: ' + sky.links.length);
  assert.ok(sky.links.length <= Math.floor(sky.stars.length * CONFIG.sky.linksPerStars));
  for (const [i, j] of sky.links) {
    assert.ok(i >= 0 && i < sky.stars.length && j >= 0 && j < sky.stars.length, 'link out of range');
    assert.notEqual(i, j, 'star linked to itself');
    const d = Math.hypot(sky.stars[i].x - sky.stars[j].x, sky.stars[i].y - sky.stars[j].y);
    assert.ok(d <= CONFIG.sky.linkDistance + 1e-9, 'link longer than linkDistance');
  }
});

test('constellation links grow monotonically as the sky fills in', () => {
  let prev = -1;
  for (const n of [0, 5, 20, 40, 60, CONFIG.sky.maxStars]) {
    const save = defaultSave();
    save.milestones = Array.from({ length: n }, (_, i) => 'k' + i);
    const sky = deriveStars(save);
    assert.ok(sky.links.length >= prev || n < 10, 'links went backwards at ' + n);
    prev = sky.links.length;
  }
  assert.ok(prev > 0, 'a full sky has no constellation lines at all');
});

test('an empty / brand-new save yields an empty sky without throwing', () => {
  for (const s of [defaultSave(), {}, null, undefined, { milestones: null }]) {
    let sky;
    assert.doesNotThrow(() => { sky = deriveStars(s); });
    assert.equal(sky.stars.length, 0);
    assert.equal(sky.links.length, 0);
  }
});

test('the sky a live sim produces round-trips through a save unchanged', () => {
  const sim = freshSim(null, 8080);
  for (let i = 0; i < 3000; i++) { sim.score += 700; step(sim, 1 / 60, null); }
  assert.ok(sim.milestones.length > 2, 'no milestones accrued');
  const skyLive = deriveStars(serializeSave(sim));
  const skyReloaded = deriveStars(loadSave(JSON.stringify(serializeSave(sim))));
  assert.deepEqual(skyReloaded, skyLive, 'the sky changed across a save/load cycle');
});

test('filigree tiers rise with lifetime best combo and are bounded', () => {
  assert.equal(filigreeTier(0), 0);
  let prev = 0;
  for (const c of [0, 1, 7, 8, 19, 20, 100, 399, 400, 10000, 1e9]) {
    const t = filigreeTier(c);
    assert.ok(t >= prev, 'tier went backwards at combo ' + c);
    assert.ok(t <= CONFIG.filigree.tiers.length, 'tier ' + t + ' out of range');
    assert.ok(CONFIG.filigree.arcCount[t] !== undefined, 'no arc count defined for tier ' + t);
    prev = t;
  }
});

/* ========================================================================== */
group('10. Population and despawn behaviour');
/* ========================================================================== */

test('population converges on the soft cap and never exceeds the hard cap', () => {
  const sim = freshSim(null, 606061);
  const script = makeScript(4141, { pointers: 3 });
  for (let i = 0; i < 3000; i++) {
    step(sim, 1 / 60, script(i, 1 / 60));
    assert.ok(sim.aliveCount <= CONFIG.population.hardCap, 'step ' + i + ': ' + sim.aliveCount);
  }
  assert.ok(Math.abs(sim.aliveCount - sim.softCap) <= 8,
    'population ' + sim.aliveCount + ' drifted from soft cap ' + sim.softCap);
});

test('GOLD is never quietly despawned', () => {
  const sim = freshSim(null, 909090);
  step(sim, 1 / 60, null);
  // Make every ball gold, then force a heavy over-cap condition.
  for (const b of sim.balls) b.type = 'GOLD';
  const goldIds = new Set(sim.balls.filter((b) => b.alive).map((b) => b.id));
  sim.softCap = 5;
  for (let i = 0; i < 2000; i++) {
    sim.softCap = 5;
    step(sim, 1 / 60, null);
  }
  const survivors = new Set(sim.balls.filter((b) => b.alive && b.type === 'GOLD').map((b) => b.id));
  for (const id of goldIds) assert.ok(survivors.has(id), 'gold ball ' + id + ' was despawned');
});

test('re-scatter leaves score, level and combo untouched', () => {
  const sim = freshSim(null, 313131);
  const script = makeScript(5252, { pointers: 3 });
  for (let i = 0; i < 1200; i++) step(sim, 1 / 60, script(i, 1 / 60));
  const before = { score: sim.score, level: sim.level, xp: sim.xp, combo: sim.comboCount, best: sim.bestCombo };
  scatter(sim);
  assert.equal(sim.score, before.score);
  assert.equal(sim.level, before.level);
  assert.equal(sim.xp, before.xp);
  assert.equal(sim.comboCount, before.combo);
  assert.equal(sim.bestCombo, before.best);
  assert.equal(allFinite(sim), null);
});

/* ========================================================================== */
group('11. Resonances (the three that exist)');
/* ========================================================================== */

test('there are exactly three resonances, each with a distinct id', () => {
  assert.equal(CONFIG.resonances.length, 3, 'the brief says exactly three');
  const ids = CONFIG.resonances.map((r) => r.id);
  assert.equal(new Set(ids).size, 3, 'duplicate resonance ids');
  for (const r of CONFIG.resonances) assert.ok(typeof r.when === 'string' && r.when.length > 0);
});

test('detonating next to a frozen ball becomes a shatter nova', () => {
  const sim = freshSim(null, 111);
  step(sim, 1 / 60, null);
  const a = sim.balls[0], b = sim.balls[1];
  a.x = sim.width * 0.5; a.y = sim.height * 0.5;
  b.x = a.x + 20 * sim.scale; b.y = a.y;
  b.frozenT = CONFIG.types.FROST.freezeTime;
  b.frozenFromX = a.x; b.frozenFromY = a.y;
  a.type = 'VOLATILE'; a.inertT = 0; a.effectT = 0;
  sim.events.length = 0;
  detonate(sim, a, 1);
  const det = sim.events.find((e) => e.type === 'detonate');
  assert.ok(det, 'no detonation event');
  assert.equal(det.nova, true, 'a frozen neighbour did not trigger the nova resonance');
  assert.ok(sim.events.some((e) => e.type === 'resonance' && e.id === 'shatterNova'));
  assert.equal(b.frozenT, 0, 'the nova did not shatter the frozen ball');
});

test('a chain jolt landing on a volatile detonates it, cooldown or not', () => {
  const sim = freshSim(null, 222);
  step(sim, 1 / 60, null);
  const src = sim.balls[0], vol = sim.balls[1];
  // Park everything else far away so the chain can only reach `vol`.
  for (const b of sim.balls) { b.x = sim.width * 2; b.y = sim.height * 2; }
  src.x = sim.width * 0.5; src.y = sim.height * 0.5;
  vol.x = src.x + 30 * sim.scale; vol.y = src.y;
  src.type = 'CHAIN'; src.effectT = 0; src.chargeT = 3;
  vol.type = 'VOLATILE'; vol.inertT = 0;
  vol.effectT = CONFIG.collision.effectCooldown;   // on cooldown: the resonance must bypass it
  sim.events.length = 0;

  // Drive a hard impact between them.
  src.vx = 900 * sim.scale; vol.vx = -900 * sim.scale;
  for (let i = 0; i < 8 && !sim.events.some((e) => e.type === 'detonate'); i++) step(sim, 1 / 60, null);

  assert.ok(sim.events.some((e) => e.type === 'resonance' && e.id === 'chainDetonate')
    || vol.inertT > 0, 'the chain never forced the volatile to detonate');
});

test('a magnet dragging gold into a hard impact scores double', () => {
  const mk = (withMagnet) => {
    const sim = freshSim({ 'world.idleDriftStrength': 0, 'world.gravityY': 0 }, 333);
    step(sim, 1 / 60, null);
    for (const b of sim.balls) { b.x = sim.width * 3; b.y = sim.height * 3; b.vx = 0; b.vy = 0; }
    const gold = sim.balls[0], target = sim.balls[1];
    gold.type = 'GOLD'; target.type = 'ORB';
    gold.r = target.r = 8 * sim.scale;
    gold.mass = target.mass = CONFIG.balls.density * Math.pow(gold.r, CONFIG.balls.densityExp);
    gold.invMass = target.invMass = 1 / gold.mass;
    gold.x = sim.width * 0.5 - 40 * sim.scale; gold.y = sim.height * 0.5;
    target.x = sim.width * 0.5 + 40 * sim.scale; target.y = sim.height * 0.5;
    gold.vx = 700 * sim.scale; target.vx = -700 * sim.scale;
    gold.magnetT = withMagnet ? CONFIG.resonances.find((r) => r.id === 'magnetGold').dragWindow : 0;
    const before = sim.score;
    for (let i = 0; i < 10; i++) {
      if (withMagnet) gold.magnetT = Math.max(gold.magnetT, 0.5);
      step(sim, 1 / 60, null);
      if (sim.score > before) break;
    }
    return sim.score - before;
  };
  const plain = mk(false);
  const magnetised = mk(true);
  assert.ok(plain > 0, 'the control impact scored nothing');
  const ratio = magnetised / plain;
  assert.ok(ratio > 1.7 && ratio < 2.3, 'expected ~2x, got ' + ratio.toFixed(3) + ' (' + plain + ' -> ' + magnetised + ')');
});

/* ========================================================================== */
group('11b. The comet');
/* ========================================================================== */

// The comet is rare by design, so these force it via config overrides. The shipped
// rarity is asserted separately, so the overrides cannot hide a bad default.
const COMET_ON = { 'comet.chancePerSec': 60, 'comet.requireIntensity': 0, 'comet.minGap': 0 };

test('the shipped comet really is rare and active-play only', () => {
  assert.ok(CONFIG.comet.enabled);
  assert.ok(CONFIG.comet.chancePerSec > 0 && CONFIG.comet.chancePerSec < 0.1,
    'chancePerSec ' + CONFIG.comet.chancePerSec + ' is not "rarely"');
  assert.ok(CONFIG.comet.minGap >= 30, 'comets could bunch up: minGap ' + CONFIG.comet.minGap);
  assert.ok(CONFIG.comet.requireIntensity > 0, 'a comet must not appear on a calm, untouched screen');

  // Prove the gate: a quiet screen never produces one, however long it sits.
  const quiet = freshSim({ 'comet.chancePerSec': 60, 'comet.minGap': 0 }, 4242);
  for (let i = 0; i < 4000; i++) {
    step(quiet, 1 / 60, null);
    assert.equal(quiet.comet, null, 'a comet appeared on an untouched screen at step ' + i);
  }
});

test('a comet spawns, drifts, and leaves on its own', () => {
  const sim = freshSim(COMET_ON, 515);
  let spawned = false;
  for (let i = 0; i < 240 && !spawned; i++) { step(sim, 1 / 60, null); spawned = !!sim.comet; }
  assert.ok(spawned, 'no comet after 240 steps with the spawn forced');
  assert.ok(Number.isFinite(sim.comet.x) && Number.isFinite(sim.comet.y));
  assert.equal(sim.comet.hp, CONFIG.comet.hp);

  const x0 = sim.comet.x;
  for (let i = 0; i < 60; i++) step(sim, 1 / 60, null);
  assert.ok(sim.comet === null || Math.abs(sim.comet.x - x0) > 1, 'the comet never moved');

  // It must eventually leave rather than parking on screen forever.
  let gone = false;
  for (let i = 0; i < Math.ceil((CONFIG.comet.lifetime + 5) * 60) && !gone; i++) {
    step(sim, 1 / 60, null);
    if (!sim.comet) gone = true;
  }
  assert.ok(gone, 'the comet never left');
  assert.equal(allFinite(sim), null);
});

test('slamming balls into a comet chips it, breaks it, and records a milestone', () => {
  const sim = freshSim(COMET_ON, 616);
  for (let i = 0; i < 240 && !sim.comet; i++) step(sim, 1 / 60, null);
  assert.ok(sim.comet, 'no comet to hit');

  const before = sim.score;
  const milestonesBefore = sim.milestones.length;
  let chips = 0, broke = false;
  for (let i = 0; i < 2000 && !broke; i++) {
    const c = sim.comet;
    if (c) {
      // Fire everything nearby straight at it, fast enough to chip.
      for (const b of sim.balls) {
        if (!b.alive) continue;
        const dx = c.x - b.x, dy = c.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < 200 * sim.scale && d > 1e-3) {
          const sp = CONFIG.comet.chipSpeed * sim.scale * 3;
          b.vx = (dx / d) * sp; b.vy = (dy / d) * sp;
        }
      }
    }
    step(sim, 1 / 60, null);
    for (const ev of sim.events) {
      if (ev.type === 'cometChip') chips++;
      if (ev.type === 'cometBreak') broke = true;
    }
    if (!sim.comet && !broke) break;   // it drifted away; give up cleanly
  }
  assert.ok(chips > 0, 'never chipped the comet');
  assert.ok(broke, 'never broke the comet after ' + chips + ' chips');
  assert.equal(sim.comet, null, 'a broken comet is still on screen');
  assert.ok(sim.score > before, 'breaking a comet scored nothing');
  assert.equal(sim.cometsBroken, 1);
  assert.ok(sim.milestones.length > milestonesBefore, 'breaking a comet was not a milestone');
  assert.ok(sim.milestones.some((m) => m[0] === 'c'), 'no comet milestone id: ' + sim.milestones.join(','));
  // And that milestone must etch a star like any other.
  const sky = deriveStars(serializeSave(sim));
  assert.ok(sky.stars.some((s) => s.id[0] === 'c'), 'the comet did not put a star in the sky');
  assert.equal(allFinite(sim), null);
});

/* ========================================================================== */
group('12. Config integrity');
/* ========================================================================== */

test('every config path the code reads actually exists in config.js', () => {
  // THE test this file was missing. `radiusGather` was declared under `field` while sim.js
  // read `C.gather.radiusGather`. The lookup was undefined, so `d < NaN` was always false and
  // the attractor applied no force at all — while still looking completely alive on screen.
  // Nothing failed. Nothing threw. It just silently did nothing.
  const src = readFileSync(new URL('./sim.js', import.meta.url), 'utf8')
    + readFileSync(new URL('./main.js', import.meta.url), 'utf8');

  const sections = new Set(Object.keys(CONFIG));
  // Match C.a.b / CONFIG.a.b / cfg.a.b chains. Only chains whose first segment is a real
  // top-level CONFIG section are resolved, so locals like `const C = sim.config.intensity`
  // (where C.riseTau is correct) are skipped rather than producing false alarms.
  const re = /\b(?:C|CONFIG|cfg)((?:\.[A-Za-z_$][\w$]*)+)/g;
  const bad = [];
  const checked = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const parts = m[1].split('.').filter(Boolean);
    if (!sections.has(parts[0])) continue;
    const path = parts.join('.');
    if (checked.has(path)) continue;
    checked.add(path);
    let node = CONFIG;
    for (const seg of parts) {
      if (node == null || typeof node !== 'object') { node = undefined; break; }
      node = node[seg];
    }
    if (node === undefined) bad.push(path);
  }

  assert.ok(checked.size > 120, 'the scanner only found ' + checked.size + ' config reads — it is not working');
  assert.deepEqual(bad, [], 'config paths read by the code but missing from config.js: ' + bad.join(', '));
});

test('cloneConfig deep-clones and applies dotted overrides without touching CONFIG', () => {
  const c = cloneConfig({ 'world.idleDriftStrength': 0, 'types.GOLD.weight': 99, 'a.b.c': 5 });
  assert.equal(c.world.idleDriftStrength, 0);
  assert.equal(c.types.GOLD.weight, 99);
  assert.equal(c.a.b.c, 5);
  assert.notEqual(CONFIG.world.idleDriftStrength, 0, 'CONFIG was mutated');
  assert.notEqual(CONFIG.types.GOLD.weight, 99, 'CONFIG was mutated');
  c.palettes[0].name = 'CHANGED';
  assert.notEqual(CONFIG.palettes[0].name, 'CHANGED', 'palettes were shared by reference');
});

test('every ball type has a complete definition and every palette covers every type', () => {
  const keys = ['ORB', ...CONFIG.unlockOrder];
  assert.equal(new Set(keys).size, keys.length, 'duplicate type keys');
  for (const k of keys) {
    const t = CONFIG.types[k];
    assert.ok(t, 'missing type ' + k);
    assert.ok(Number.isFinite(t.weight) && t.weight > 0, k + ' weight');
    assert.ok(Number.isFinite(t.score) && t.score > 0, k + ' score');
    assert.ok(Number.isInteger(t.unlockLevel) && t.unlockLevel >= 0, k + ' unlockLevel');
    assert.ok(typeof t.label === 'string' && t.label.length > 0, k + ' label');
  }
  // Unlock levels ascend in the declared order, and ORB is free.
  assert.equal(CONFIG.types.ORB.unlockLevel, 0);
  let prev = 0;
  for (const k of CONFIG.unlockOrder) {
    assert.ok(CONFIG.types[k].unlockLevel > prev, k + ' unlocks out of order');
    prev = CONFIG.types[k].unlockLevel;
  }
  // Palettes: every one must colour every non-ORB type, or rendering falls through a hole.
  assert.ok(CONFIG.palettes.length >= 6, 'the brief asks for at least six colour worlds');
  for (const p of CONFIG.palettes) {
    for (const key of ['name', 'bg0', 'bg1', 'hud', 'hudDim', 'ring', 'star', 'orbHues', 'type']) {
      assert.ok(p[key] !== undefined, 'palette ' + p.name + ' missing ' + key);
    }
    assert.ok(Array.isArray(p.orbHues) && p.orbHues.length >= 3, 'palette ' + p.name + ' orbHues');
    for (const k of CONFIG.unlockOrder) {
      assert.ok(typeof p.type[k] === 'string' && /^#[0-9a-f]{6}$/i.test(p.type[k]),
        'palette ' + p.name + ' has no valid colour for ' + k);
    }
    for (const c of p.orbHues) assert.ok(/^#[0-9a-f]{6}$/i.test(c), 'palette ' + p.name + ' bad orb hue ' + c);
    for (const k of ['bg0', 'bg1', 'hud', 'hudDim', 'ring', 'star', 'fog']) {
      assert.ok(/^#[0-9a-f]{6}$/i.test(p[k]), 'palette ' + p.name + ' bad ' + k + ': ' + p[k]);
    }
  }
});

test('gold is roughly 2% of the spawn pool once everything is unlocked', () => {
  const keys = ['ORB', ...CONFIG.unlockOrder];
  const total = keys.reduce((s, k) => s + CONFIG.types[k].weight, 0);
  const goldShare = CONFIG.types.GOLD.weight / total;
  assert.ok(goldShare > 0.015 && goldShare < 0.028, 'gold share is ' + (goldShare * 100).toFixed(2) + '%');
});

test('restitution, drag and the speed clamp are inside sane physical ranges', () => {
  assert.ok(CONFIG.collision.restitution > 0.85 && CONFIG.collision.restitution < 1, 'the brief asks for ~0.9');
  assert.ok(CONFIG.collision.restitutionFrenzy < 1, 'restitution must stay under 1 or energy is created');
  assert.ok(CONFIG.world.wallRestitution < 1);
  assert.ok(CONFIG.collision.correctionPercent > 0 && CONFIG.collision.correctionPercent < 1);
  assert.ok(CONFIG.collision.correctionSlop > 0);
  assert.ok(CONFIG.world.drag > 0);
  assert.ok(CONFIG.world.speedClamp > 0 && Number.isFinite(CONFIG.world.speedClamp));
  assert.ok(CONFIG.world.substeps >= 1);
});

test('scale invariance: a phone and a tablet behave equivalently', () => {
  // Same seed, same normalised inputs, different screens. Trajectories should match once
  // positions are normalised — that is what "scale forces and radii from a reference
  // dimension" buys, and it is why an SE and an iPad feel identical.
  const run = (w, h) => {
    const sim = createSim({ config: cloneConfig({ 'world.idleDriftStrength': 0 }), rng: makeRng(42), width: w, height: h });
    for (let i = 0; i < 300; i++) {
      const t = i / 300;
      step(sim, 1 / 60, { pointers: [{ id: 1, x: w * (0.3 + 0.4 * t), y: h * 0.5 }] });
    }
    const alive = sim.balls.filter((b) => b.alive);
    return {
      n: alive.length,
      meanSpeed: alive.reduce((s, b) => s + Math.hypot(b.vx, b.vy), 0) / alive.length / sim.scale,
    };
  };
  const phone = run(390, 844);
  const tablet = run(780, 1688);   // exactly 2x, so normalised behaviour must match closely
  const rel = Math.abs(phone.meanSpeed - tablet.meanSpeed) / Math.max(1e-6, phone.meanSpeed);
  assert.ok(rel < 0.12, 'scale-normalised mean speed differs by ' + (rel * 100).toFixed(1) + '%');
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
