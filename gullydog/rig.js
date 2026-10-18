/*
 * rig.js — turns "what is this creature doing" into bone matrices.
 *
 * A Rig holds one Euler triple per bone (yaw, pitch, roll about that bone's
 * pivot, relative to its parent) and composes them into world-space 3x4
 * matrices, written straight into the renderer's instance staging buffer.
 *
 * Sign conventions (models face +Z; see util.affFromEuler):
 *   pitch < 0  swings a hanging limb FORWARD; > 0 swings it back.
 *   pitch > 0  on a head or jaw tips it DOWN (the front drops).
 *   roll  > 0  lifts a +X (left-side) limb outward; mirror for the right.
 *
 * Each animated entity carries an `anim` object owned by the renderer, not the
 * sim: phases, smoothed blends, a crossfade snapshot. Animation is presentation;
 * keeping it out of the sim keeps the sim's determinism hash about gameplay.
 */

import { affFromEuler, affMul, affPivot, clamp, lerp, TAU } from './util.js';

export class Rig {
  constructor(model) {
    this.bones = model.bones;
    this.n = model.bones.length;
    this.ang = new Float32Array(this.n * 3);
    this.world = Array.from({ length: this.n }, () => new Float64Array(12));
    this.local = new Float64Array(12);
    this.root = new Float64Array(12);
    this.tmp = new Float64Array(12);
    this.oy = 0; this.oz = 0; this.ox = 0;
  }

  reset() {
    this.ang.fill(0);
    this.ox = 0; this.oy = 0; this.oz = 0;
    return this;
  }

  set(b, yaw, pitch, roll) {
    const i = b * 3;
    this.ang[i] = yaw; this.ang[i + 1] = pitch; this.ang[i + 2] = roll;
  }

  add(b, yaw, pitch, roll) {
    const i = b * 3;
    this.ang[i] += yaw; this.ang[i + 1] += pitch; this.ang[i + 2] += roll;
  }

  /** Blend the current pose toward a snapshot (used for crossfades). w = weight of the snapshot. */
  mixFrom(snapshot, w) {
    if (w <= 0) return;
    for (let i = 0; i < this.ang.length; i++) this.ang[i] = lerp(this.ang[i], snapshot[i], w);
  }

  /**
   * Compose and write every bone matrix (12 floats each) into out at float offset o.
   * The instance transform is translate(x,y,z) * Ry(yaw) * Rx(pitch) * Rz(roll) * scale.
   */
  write(out, o, x, y, z, yaw, scale, pitch = 0, roll = 0) {
    affFromEuler(this.root, x, y, z, yaw, pitch, roll, scale);
    if (this.ox || this.oy || this.oz) {
      affFromEuler(this.tmp, this.ox, this.oy, this.oz, 0, 0, 0, 1);
      affMul(this.root, this.root, this.tmp);
    }
    for (let b = 0; b < this.n; b++) {
      const bone = this.bones[b];
      const p = bone.pivot;
      const i = b * 3;
      affPivot(this.local, p[0], p[1], p[2], this.ang[i], this.ang[i + 1], this.ang[i + 2]);
      affMul(this.world[b], bone.parent < 0 ? this.root : this.world[bone.parent], this.local);
      const w = this.world[b];
      const k = o + b * 12;
      out[k] = w[0]; out[k + 1] = w[1]; out[k + 2] = w[2]; out[k + 3] = w[3];
      out[k + 4] = w[4]; out[k + 5] = w[5]; out[k + 6] = w[6]; out[k + 7] = w[7];
      out[k + 8] = w[8]; out[k + 9] = w[9]; out[k + 10] = w[10]; out[k + 11] = w[11];
    }
  }

  /** World position of a model-space point carried by bone b (after write()). */
  pointOn(b, x, y, z, out) {
    const w = this.world[b];
    out[0] = w[0] * x + w[1] * y + w[2] * z + w[3];
    out[1] = w[4] * x + w[5] * y + w[6] * z + w[7];
    out[2] = w[8] * x + w[9] * y + w[10] * z + w[11];
    return out;
  }
}

/** A fresh animation state; every entity the renderer draws gets one lazily. */
export function newAnim() {
  return {
    phase: 0, t: 0, mode: '', prevMode: '', fade: 1, snap: null,
    sit: 0, lie: 0, sleep: 0, beg: 0, mark: 0, air: 0, head: 0, headYaw: 0, jaw: 0,
    wag: 0, tailDown: 0, earsBack: 0, knock: 0, gait: 0, gaitW: 1, prevGait: 0, spin: 0, steer: 0,
  };
}

const approachTo = (v, t, rate, dt) => v + (t - v) * (1 - Math.exp(-rate * dt));

/* ======================================================================= DOGS */

// Leg order in the bone list: FL upper 5, FR 7, BL 9, BR 11 (lower = upper + 1).
const DOG_LEGS = [5, 7, 9, 11];
const GAITS = [
  // walk: lateral sequence, trot: diagonal pairs, gallop: rotary
  { off: [0.25, 0.75, 0.0, 0.5], A: 0.34, F: 0.75, stride: 0.55, bob: 0.008, rock: 0.0 },
  { off: [0.0, 0.5, 0.5, 0.0], A: 0.5, F: 1.0, stride: 0.85, bob: 0.014, rock: 0.02 },
  { off: [0.0, 0.12, 0.55, 0.67], A: 0.78, F: 1.15, stride: 1.45, bob: 0.03, rock: 0.11 },
];

function gaitFor(speed, current) {
  // hysteresis so a dog at the boundary does not flicker between gaits
  if (current === 0) return speed > 2.1 ? 1 : 0;
  if (current === 1) return speed < 1.7 ? 0 : speed > 4.9 ? 2 : 1;
  return speed < 4.4 ? 1 : 2;
}

function dogLegs(rig, g, phase, amp, w) {
  const G = GAITS[g];
  for (let i = 0; i < 4; i++) {
    const th = TAU * (phase + G.off[i]);
    const front = i < 2;
    const up = -G.A * amp * Math.sin(th);
    const swing = Math.max(0, Math.cos(th));
    const low = (front ? G.F : -G.F * 0.7) * amp * swing;
    const ub = DOG_LEGS[i];
    rig.ang[ub * 3 + 1] += up * w;
    rig.ang[(ub + 1) * 3 + 1] += (low + (front ? 0 : 0.15 * amp)) * w;
  }
}

/**
 * Advance a dog's animation state. `d` is the sim's dog: speed, vy, onGround,
 * and a `pose` string ('move','sit','lie','sleep','beg','mark','eat','drink',
 * 'sniff','knock'), plus mood flags: happy, scared, barking, panting.
 */
export function animateDog(a, d, dt) {
  a.t += dt;
  const speed = d.onGround === false ? 0 : d.speed || 0;
  const g = gaitFor(speed, a.gait);
  if (g !== a.gait) { a.prevGait = a.gait; a.gait = g; a.gaitW = 0; }
  a.gaitW = Math.min(1, a.gaitW + dt * 6);
  a.phase = (a.phase + (dt * speed) / GAITS[a.gait].stride) % 1;
  const p = d.pose || 'move';
  a.sit = approachTo(a.sit, p === 'sit' || p === 'beg' ? 1 : 0, 9, dt);
  a.lie = approachTo(a.lie, p === 'lie' || p === 'sleep' ? 1 : 0, 6, dt);
  a.sleep = approachTo(a.sleep, p === 'sleep' ? 1 : 0, 2, dt);
  a.beg = approachTo(a.beg, p === 'beg' ? 1 : 0, 8, dt);
  a.mark = approachTo(a.mark, p === 'mark' ? 1 : 0, 8, dt);
  a.head = approachTo(a.head, p === 'eat' || p === 'drink' ? 1 : p === 'sniff' ? 0.75 : 0, 10, dt);
  a.air = approachTo(a.air, d.onGround === false ? 1 : 0, 14, dt);
  a.knock = approachTo(a.knock, p === 'knock' ? 1 : 0, 12, dt);
  a.wag = approachTo(a.wag, d.happy ? 1 : 0, 4, dt);
  a.tailDown = approachTo(a.tailDown, d.scared ? 1 : 0, 6, dt);
  a.earsBack = approachTo(a.earsBack, d.scared || p === 'sleep' ? 1 : 0, 6, dt);
  a.headYaw = approachTo(a.headYaw, clamp(d.lookYaw || 0, -0.9, 0.9), 5, dt);
  const barkEnv = d.barkT > 0 ? Math.sin(Math.min(1, d.barkT / 0.35) * Math.PI) : 0;
  const pant = d.panting ? 0.14 + 0.06 * Math.sin(a.t * 18) : 0;
  const chew = p === 'eat' ? 0.18 + 0.15 * Math.sin(a.t * 14) : p === 'drink' ? 0.1 + 0.08 * Math.sin(a.t * 22) : 0;
  a.jaw = Math.max(barkEnv * 0.55, pant, chew);
  a.vy = d.vy || 0;
}

export function poseDog(rig, a, speed) {
  rig.reset();
  const moving = clamp(speed / 1.2, 0, 1) * (1 - a.sit) * (1 - a.lie);
  const G = GAITS[a.gait];
  // gait, crossfaded between the previous and current gait
  if (moving > 0.001) {
    dogLegs(rig, a.gait, a.phase, moving, a.gaitW);
    if (a.gaitW < 1) dogLegs(rig, a.prevGait, a.phase, moving, 1 - a.gaitW);
  }
  const th = TAU * a.phase;
  rig.oy += -G.bob * moving * Math.cos(2 * th);
  rig.add(0, 0, G.rock * moving * Math.sin(th), 0);
  rig.add(1, 0, -G.rock * 0.6 * moving * Math.sin(th), 0);

  // sit: rear down, hind legs folded forward, front legs held vertical
  if (a.sit > 0.001) {
    const s = a.sit;
    rig.add(0, 0, -0.5 * s, 0);
    rig.oy -= 0.11 * s;
    rig.oz -= 0.05 * s;
    for (const ub of [9, 11]) { rig.add(ub, 0, -1.2 * s, 0); rig.add(ub + 1, 0, 2.1 * s, 0); }
    for (const ub of [5, 7]) { rig.add(ub, 0, 0.5 * s, 0); }
    rig.add(1, 0, -0.1 * s, 0);
    rig.add(3, 0, -0.9 * s, 0);
  }
  // beg: one forepaw up, bobbing hopefully
  if (a.beg > 0.001) {
    const b = a.beg;
    rig.add(5, 0, -1.25 * b + 0.15 * Math.sin(a.t * 7) * b, 0.15 * b);
    rig.add(6, 0, 1.3 * b, 0);
  }
  // lie (sphinx), and sleep curled a little onto one side
  if (a.lie > 0.001) {
    const l = a.lie;
    rig.oy -= 0.27 * l;
    for (const ub of [5, 7]) { rig.add(ub, 0, -1.4 * l, 0); rig.add(ub + 1, 0, 0.15 * l, 0); }
    for (const ub of [9, 11]) { rig.add(ub, 0, -1.55 * l, 0); rig.add(ub + 1, 0, 2.55 * l, 0); }
    rig.add(9, 0.25 * l, 0, 0.35 * l);
    rig.add(11, -0.25 * l, 0, -0.35 * l);
    const s = a.sleep;
    rig.add(0, 0, 0, -0.32 * s);
    rig.add(1, 0.55 * s, 0.75 * s, 0.2 * s);
    rig.add(3, 1.3 * s, -0.5 * s, 0);
    rig.oy -= 0.03 * s;
  }
  // lifting a leg against a post
  if (a.mark > 0.001) {
    rig.add(9, 0, -0.2 * a.mark, 1.15 * a.mark);
    rig.add(10, 0, 0.3 * a.mark, 0);
    rig.add(0, 0, 0, -0.08 * a.mark);
  }
  // airborne: tuck the forelegs, stretch the hind legs, pitch with the arc
  if (a.air > 0.001) {
    const f = a.air;
    rig.add(5, 0, -0.85 * f, 0); rig.add(7, 0, -0.85 * f, 0);
    rig.add(6, 0, 1.2 * f, 0); rig.add(8, 0, 1.2 * f, 0);
    rig.add(9, 0, 0.75 * f, 0); rig.add(11, 0, 0.75 * f, 0);
    rig.add(0, 0, clamp(-a.vy * 0.06, -0.35, 0.3) * f, 0);
  }
  // head: down to eat or sniff, turned toward whatever has its attention
  const sniffJitter = a.head > 0.5 && a.head < 0.9 ? 0.12 * Math.sin(a.t * 19) : 0;
  rig.add(1, a.headYaw * (1 - a.sleep) + sniffJitter, 0.95 * a.head, 0);
  rig.add(2, 0, a.jaw, 0);
  // tail: carriage, wag, tuck
  const wag = a.wag * 0.6 * Math.sin(a.t * 2 * Math.PI * 5.5) + moving * 0.12 * Math.sin(th);
  rig.add(3, wag * (1 - a.tailDown), -1.7 * a.tailDown, 0);
  rig.add(4, wag * 0.6, -0.9 * a.tailDown, 0);
  // ears: perked, or flattened back
  const flick = Math.sin(a.t * 0.9) > 0.985 ? 0.4 : 0;
  rig.add(13, 0, -0.9 * a.earsBack, flick);
  rig.add(14, 0, -0.9 * a.earsBack, 0);
  // knocked over
  if (a.knock > 0.001) {
    rig.add(0, 0, 0, 1.1 * a.knock);
    for (const ub of DOG_LEGS) rig.add(ub, 0, 0.6 * a.knock * Math.sin(a.t * 30 + ub), 0);
  }
}

/* ===================================================================== PEOPLE */

const POSE_FADE = 0.28;

/**
 * h: { speed, mode, t?, look? } mode is one of: walk, run, sit, squat, pet,
 * shoo, talk, pray, ride, pedal, bat, swing, bowl, cop, cheer, startle, sleep,
 * feed, beckon, stand, field.
 */
export function animateHuman(a, h, dt, stride = 0.72) {
  a.t += dt;
  const mode = h.mode || 'walk';
  if (mode !== a.mode) {
    a.prevMode = a.mode;
    a.mode = mode;
    a.fade = a.prevMode ? 0 : 1;
    a.modeT = 0;
  }
  a.modeT = (a.modeT || 0) + dt;
  a.fade = Math.min(1, a.fade + dt / POSE_FADE);
  const sp = h.speed || 0;
  a.phase = (a.phase + (dt * sp) / (mode === 'run' ? stride * 1.7 : stride)) % 1;
  a.spin = (a.spin + dt * (h.pedal || 0) * 1.6) % 1;
  a.headYaw = approachTo(a.headYaw, clamp(h.look || 0, -1.1, 1.1), 4, dt);
}

export function poseHuman(rig, a, speed, mode) {
  // keep the previous pose to fade from
  if (a.fade < 1) {
    if (!a.snap) a.snap = new Float32Array(rig.ang.length);
  }
  rig.reset();
  humanPose(rig, a, speed, mode || a.mode);
  if (a.fade < 1 && a.snapReady) {
    const w = 1 - a.fade;
    rig.mixFrom(a.snap, w * w * (3 - 2 * w));
    rig.oy = lerp(rig.oy, a.snapOy || 0, w);
  }
  if (!a.snap) a.snap = new Float32Array(rig.ang.length);
  if (a.fade >= 1 || !a.snapReady) {
    a.snap.set(rig.ang);
    a.snapOy = rig.oy;
    a.snapReady = true;
  }
}

function humanPose(rig, a, speed, mode) {
  const t = a.t;
  const th = TAU * a.phase;
  const look = a.headYaw || 0;
  const walkAmp = clamp(speed / 1.3, 0, 1.25);
  const legs = (amp, knee) => {
    rig.add(7, 0, -amp * Math.sin(th), 0);
    rig.add(9, 0, amp * Math.sin(th), 0);
    rig.add(8, 0, knee * Math.max(0, Math.cos(th)), 0);
    rig.add(10, 0, knee * Math.max(0, -Math.cos(th)), 0);
  };
  const arms = (amp, bend) => {
    rig.add(3, 0, amp * Math.sin(th), 0.08);
    rig.add(5, 0, -amp * Math.sin(th), -0.08);
    rig.add(4, 0, -bend, 0);
    rig.add(6, 0, -bend, 0);
  };
  const breathe = 0.02 * Math.sin(t * 1.7);
  const sitPose = (seatDrop) => {
    rig.oy -= seatDrop;
    rig.add(7, 0, -1.5, 0.06); rig.add(9, 0, -1.5, -0.06);
    rig.add(8, 0, 1.5, 0); rig.add(10, 0, 1.5, 0);
  };
  switch (mode) {
    case 'run':
      legs(0.75 * walkAmp, 1.4 * walkAmp);
      arms(0.65 * walkAmp, 1.3);
      rig.add(1, 0, 0.18, 0);
      rig.oy += -0.04 * Math.abs(Math.cos(th));
      break;
    case 'sit':
      sitPose(0.4);
      rig.add(3, 0, -0.45, 0.05); rig.add(5, 0, -0.45, -0.05);
      rig.add(4, 0, -0.7, 0); rig.add(6, 0, -0.7, 0);
      rig.add(1, 0, 0.08 + breathe, 0);
      rig.add(2, look, 0, 0);
      break;
    case 'squat':
      rig.oy -= 0.58;
      rig.add(7, 0.25, -2.0, 0.2); rig.add(9, -0.25, -2.0, -0.2);
      rig.add(8, 0, 2.45, 0); rig.add(10, 0, 2.45, 0);
      rig.add(1, 0, 0.25 + breathe, 0);
      rig.add(3, 0, -0.9, 0.1); rig.add(5, 0, -0.9, -0.1);
      rig.add(4, 0, -0.5, 0); rig.add(6, 0, -0.5, 0);
      rig.add(2, look, -0.1, 0);
      break;
    case 'pet':
      rig.oy -= 0.1;
      rig.add(7, 0, -0.45, 0); rig.add(9, 0, -0.2, 0);
      rig.add(8, 0, 0.8, 0); rig.add(10, 0, 0.5, 0);
      rig.add(1, 0, 0.75, 0);
      rig.add(5, 0, -0.9 + 0.18 * Math.sin(t * 6), 0);
      rig.add(6, 0, -0.25, 0);
      rig.add(3, 0, -0.2, 0.1);
      rig.add(2, look * 0.5, 0.3, 0);
      break;
    case 'feed':
      rig.add(1, 0, 0.35, 0);
      rig.add(5, 0, -1.1, 0); rig.add(6, 0, -0.2, 0);
      rig.add(2, look, 0.35, 0);
      break;
    case 'shoo': {
      const s = Math.sin(t * 9);
      rig.add(1, 0, -0.08, 0);
      rig.add(5, 0, -1.3 + 0.35 * s, -0.25);
      rig.add(6, 0, -0.4 - 0.4 * s, 0);
      rig.add(3, 0, 0.1, 0.12);
      rig.add(2, look, 0.15, 0);
      legs(0.1 * walkAmp, 0.2);
      break;
    }
    case 'beckon':
      rig.add(1, 0, 0.2, 0);
      rig.add(5, 0, -1.2, -0.1);
      rig.add(6, 0, -0.9 - 0.5 * Math.max(0, Math.sin(t * 7)), 0);
      rig.add(2, look, 0.25, 0);
      break;
    case 'talk':
      rig.add(5, 0, -0.35, -0.1);
      rig.add(6, 0, -1.1 - 0.35 * Math.sin(t * 4.3), 0);
      rig.add(3, 0, 0.05, 0.08);
      rig.add(4, 0, -0.3 - 0.2 * Math.max(0, Math.sin(t * 2.1)), 0);
      rig.add(2, look + 0.15 * Math.sin(t * 0.8), 0.05 * Math.sin(t * 3), 0);
      rig.add(1, 0, breathe, 0);
      break;
    case 'pray':
      rig.add(3, 0, -0.55, -0.35); rig.add(5, 0, -0.55, 0.35);
      rig.add(4, 0.55, -1.6, 0); rig.add(6, -0.55, -1.6, 0);
      rig.add(2, 0, 0.35, 0);
      rig.add(1, 0, 0.1 + breathe, 0);
      break;
    case 'ride':
      sitPose(0.38);
      rig.add(7, 0, 0.35, 0.12); rig.add(9, 0, 0.35, -0.12);
      rig.add(8, 0, -0.3, 0); rig.add(10, 0, -0.3, 0);
      rig.add(3, 0, -1.05, 0.12); rig.add(5, 0, -1.05, -0.12);
      rig.add(4, 0, -0.35, 0); rig.add(6, 0, -0.35, 0);
      rig.add(1, 0, 0.12, 0);
      rig.add(2, look, 0, 0);
      break;
    case 'passenger':
      sitPose(0.4);
      rig.add(3, 0, -0.3, 0.05); rig.add(5, 0, -0.3, -0.05);
      rig.add(4, 0, -0.9, 0); rig.add(6, 0, -0.9, 0);
      rig.add(2, look, 0, 0);
      break;
    case 'pedal': {
      const c = TAU * a.spin;
      rig.oy -= 0.06;
      rig.add(7, 0, -0.95 - 0.42 * Math.sin(c), 0.05);
      rig.add(9, 0, -0.95 + 0.42 * Math.sin(c), -0.05);
      rig.add(8, 0, 1.0 + 0.5 * Math.cos(c), 0);
      rig.add(10, 0, 1.0 - 0.5 * Math.cos(c), 0);
      rig.add(1, 0, 0.3, 0);
      rig.add(3, 0, -1.05, 0.1); rig.add(5, 0, -1.05, -0.1);
      rig.add(2, look, -0.2, 0);
      break;
    }
    case 'bat':
      rig.oy -= 0.08;
      rig.add(7, 0, -0.3, 0.12); rig.add(9, 0, 0.1, -0.12);
      rig.add(8, 0, 0.45, 0); rig.add(10, 0, 0.3, 0);
      rig.add(1, 0.55, 0.3, 0);
      rig.add(3, 0, -0.75, -0.55); rig.add(5, 0, -0.6, -0.2);
      rig.add(4, 0, -0.6, 0); rig.add(6, 0, -0.5, 0);
      rig.add(2, -0.6, 0, 0);
      break;
    case 'swing': {
      // modeT restarts whenever the mode changes, so the swing plays once
      const s = clamp((a.modeT || 0) / 0.35, 0, 1);
      rig.oy -= 0.08;
      rig.add(1, 0.55 - 1.5 * s, 0.25, 0);
      rig.add(3, 0, -0.75 - 0.6 * s, -0.55 + 0.3 * s);
      rig.add(5, 0, -0.6 - 0.9 * s, -0.2);
      rig.add(2, -0.6 + 0.4 * s, 0, 0);
      break;
    }
    case 'bowl': {
      const s = Math.min(1, (a.modeT || 0) * 1.4);
      legs(0.3, 0.5);
      rig.add(5, 0, -TAU * s, -0.1);
      rig.add(3, 0, -0.6, 0.2);
      rig.add(1, 0, 0.15, 0);
      break;
    }
    case 'cop': {
      const s = Math.sin(t * 2.2);
      rig.add(3, 0, -0.2, 1.3 + 0.25 * s);
      rig.add(4, 0, -0.9 - 0.6 * Math.max(0, s), 0);
      rig.add(5, 0, -1.4 - 0.4 * Math.max(0, -s), -0.1);
      rig.add(6, 0, -0.2, 0);
      rig.add(2, 0.5 * s, 0, 0);
      break;
    }
    case 'cheer': {
      const s = Math.abs(Math.sin(t * 6));
      rig.add(3, 0, -2.6 - 0.2 * s, 0.2); rig.add(5, 0, -2.6 - 0.2 * s, -0.2);
      rig.oy += 0.08 * s;
      rig.add(2, 0, -0.2, 0);
      break;
    }
    case 'startle':
      rig.add(1, 0, -0.25, 0);
      rig.add(3, 0, -1.3, 0.4); rig.add(5, 0, -1.3, -0.4);
      rig.add(4, 0, -1.2, 0); rig.add(6, 0, -1.2, 0);
      rig.add(7, 0, 0.25, 0); rig.add(8, 0, 0.3, 0);
      rig.add(2, look, -0.25, 0);
      break;
    case 'sleep':
      rig.add(0, 0, -1.5, 0);
      rig.oy -= 0.5; rig.oz -= 0.0;
      rig.add(3, 0, 0, 0.15); rig.add(5, 0, 0, -0.15);
      rig.add(2, 0.4, -0.2, 0);
      break;
    case 'field':
      rig.oy -= 0.12;
      rig.add(7, 0.15, -0.5, 0.15); rig.add(9, -0.15, -0.5, -0.15);
      rig.add(8, 0, 0.9, 0); rig.add(10, 0, 0.9, 0);
      rig.add(1, 0, 0.5, 0);
      rig.add(3, 0, -0.5, 0.25); rig.add(5, 0, -0.5, -0.25);
      rig.add(2, look, -0.35, 0);
      break;
    case 'stand':
      rig.add(3, 0, 0.05, 0.1); rig.add(5, 0, 0.05, -0.1);
      rig.add(4, 0, -0.25, 0); rig.add(6, 0, -0.25, 0);
      rig.add(1, 0, breathe, 0);
      rig.add(2, look + 0.25 * Math.sin(t * 0.37), 0, 0);
      break;
    default: { // walk / idle
      legs(0.42 * walkAmp, 0.75 * walkAmp);
      arms(0.32 * walkAmp, 0.25 + 0.15 * walkAmp);
      rig.oy += -0.022 * walkAmp * Math.abs(Math.cos(th));
      rig.add(1, 0.05 * walkAmp * Math.sin(th), 0.04 * walkAmp + breathe * (1 - walkAmp), 0);
      rig.add(2, look * (1 - 0.5 * walkAmp) + (walkAmp < 0.1 ? 0.2 * Math.sin(t * 0.43) : 0), 0, 0);
    }
  }
}

/* ===================================================================== CATTLE */

export function animateQuad(a, q, dt, stride = 1.1) {
  a.t += dt;
  const sp = q.speed || 0;
  a.phase = (a.phase + (dt * sp) / stride) % 1;
  a.lie = approachTo(a.lie, q.pose === 'lie' ? 1 : 0, 1.5, dt);
  a.head = approachTo(a.head, q.pose === 'graze' ? 1 : 0, 2.5, dt);
  a.headYaw = approachTo(a.headYaw, clamp(q.look || 0, -0.8, 0.8), 2, dt);
}

export function poseQuad(rig, a, speed) {
  rig.reset();
  const th = TAU * a.phase;
  const amp = clamp(speed / 0.9, 0, 1.2) * (1 - a.lie);
  const off = [0.25, 0.75, 0.0, 0.5]; // fl fr bl br
  for (let i = 0; i < 4; i++) rig.add(3 + i, 0, -0.32 * amp * Math.sin(TAU * a.phase + TAU * off[i]), 0);
  rig.oy += -0.02 * amp * Math.abs(Math.cos(th));
  // lying: legs folded flat, belly on the ground, a slight lean
  const l = a.lie;
  if (l > 0.001) {
    rig.oy -= 0.56 * l;
    rig.add(3, 0.1 * l, -1.45 * l, 0.1 * l); rig.add(4, -0.1 * l, -1.45 * l, -0.1 * l);
    rig.add(5, 0.3 * l, 1.45 * l, 0.35 * l); rig.add(6, -0.3 * l, 1.45 * l, -0.35 * l);
    rig.add(0, 0, 0, 0.06 * l);
  }
  const chew = a.head > 0.5 ? 0.04 * Math.sin(a.t * 5) : 0;
  rig.add(1, a.headYaw + 0.1 * Math.sin(a.t * 0.31), 0.75 * a.head - 0.1 * l + chew, 0);
  rig.add(2, 0.35 * Math.sin(a.t * 1.9) + 0.15 * Math.sin(a.t * 3.7), 0.1, 0);
}

/* ===================================================================== BIRDS */

export function poseBird(rig, a, b) {
  rig.reset();
  const t = a.t;
  if (b.flying) {
    const f = b.glide ? 0.15 * Math.sin(t * 3) : 0.95 * Math.sin(t * TAU * 7.5);
    rig.set(1, 0, 0, f);
    rig.set(2, 0, 0, -f);
    rig.set(0, 0, -0.18, 0);
  } else {
    const peck = b.pecking ? Math.max(0, Math.sin(t * 9)) ** 3 : 0;
    rig.set(3, 0.4 * Math.sin(t * 1.3 + b.id), 0.9 * peck, 0);
    rig.set(1, 0, 0, -0.05);
    rig.set(2, 0, 0, 0.05);
    rig.oy += 0.012 * Math.abs(Math.sin(t * 10)) * (b.speed > 0.05 ? 1 : 0);
  }
}

/* =================================================================== VEHICLES */

/** Wheels spin with distance travelled; the front wheel of a two/three-wheeler steers. */
export function poseVehicle(rig, model, spin, steer, pitch, crank) {
  rig.reset();
  for (let b = 1; b < rig.n; b++) {
    const bone = rig.bones[b];
    if (bone.name === 'crank') { rig.set(b, 0, crank || 0, 0); continue; }
    const r = Math.max(0.1, bone.pivot[1]);
    rig.set(b, b === 1 && bone.pivot[0] === 0 ? steer : 0, spin / r, 0);
  }
  rig.set(0, 0, pitch || 0, 0);
}
