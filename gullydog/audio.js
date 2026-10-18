/*
 * audio.js — every sound is synthesised. No files.
 *
 * Events from the sim become one-shot voices, panned and attenuated by where
 * they happened relative to the camera. A few loops run underneath: the traffic
 * rumble and crowd murmur (scaled by what is actually near the dog), crickets at
 * night, rain, and a quiet tanpura drone that can be switched off.
 *
 * Plucked notes and the tanpura are Karplus-Strong strings rendered into
 * buffers once at start-up; the rest is oscillators and filtered noise.
 */

import { clamp, dist2 } from './util.js';

const PENTA = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0]; // Bhupali: Sa Re Ga Pa Dha

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.music = true;
    this.listener = { x: 0, z: 0, rx: 1, rz: 0 };
    this.hornBudget = 0;
    this.sayBudget = 0;
  }

  /** Must be called from a user gesture (iOS will not start audio otherwise). */
  start() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    // iOS: a context only runs once something has been played inside the tap that
    // made it, and older versions need that to be a real buffer, even a silent one
    try {
      if (ctx.state !== 'running') ctx.resume();
      const kick = ctx.createBufferSource();
      kick.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      kick.connect(ctx.destination);
      kick.start(0);
    } catch (e) { /* play on without sound */ }
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 18; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
    this.amb = ctx.createGain(); this.amb.gain.value = 0.55; this.amb.connect(this.master);
    this.mus = ctx.createGain(); this.mus.gain.value = this.music ? 0.32 : 0; this.mus.connect(this.master);
    // a short room for the bells and the drone
    this.verb = ctx.createDelay(1); this.verb.delayTime.value = 0.13;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const vlp = ctx.createBiquadFilter(); vlp.type = 'lowpass'; vlp.frequency.value = 2600;
    this.verb.connect(vlp); vlp.connect(fb); fb.connect(this.verb);
    this.verbOut = ctx.createGain(); this.verbOut.gain.value = 0.5; vlp.connect(this.verbOut); this.verbOut.connect(this.master);
    this.noise = this.makeNoise(2, 'white');
    this.brown = this.makeNoise(3, 'brown');
    this.plucks = PENTA.map((f) => this.karplus(f, 1.6, 0.996));
    this.drone = [130.81, 98.0, 130.81, 65.41].map((f) => this.karplus(f, 4.5, 0.9993));
    this.loops();
    this.droneT = 0;
    this.droneI = 0;
  }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05); }
  setMusic(on) { this.music = on; if (this.mus) this.mus.gain.setTargetAtTime(on ? 0.32 : 0, this.ctx.currentTime, 0.2); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  // iOS parks the context as 'interrupted' after a call or Siri, not 'suspended'
  resume() { if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume(); }

  makeNoise(sec, kind) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    for (let i = 0; i < n; i++) {
      const w = rnd();
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    return buf;
  }

  karplus(freq, sec, decay) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * sec);
    const buf = ctx.createBuffer(1, n, sr);
    const out = buf.getChannelData(0);
    const N = Math.max(2, Math.round(sr / freq));
    const line = new Float32Array(N);
    let seed = Math.round(freq * 1000);
    for (let i = 0; i < N; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; line[i] = seed / 4294967296 * 2 - 1; }
    let idx = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const cur = line[idx];
      const next = 0.5 * (cur + prev) * decay;
      // a touch of the sitar's buzzing bridge: soft-clip the string
      line[idx] = Math.tanh(next * 1.4) / 1.4;
      prev = cur;
      out[i] = cur * 0.6;
      idx = (idx + 1) % N;
    }
    return buf;
  }

  /* ------------------------------------------------------------ plumbing */

  voice(dest, x, z, opts = {}) {
    // spatial gain + pan for a sound at (x, z); returns the node to connect into
    const ctx = this.ctx;
    const g = ctx.createGain();
    let gain = opts.gain === undefined ? 1 : opts.gain;
    if (x !== undefined && x !== null) {
      const L = this.listener;
      const dx = x - L.x, dz = z - L.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const ref = opts.ref || 6;
      gain *= 1 / (1 + (d / ref) * (d / ref));
      if (d > (opts.max || 70)) return null;
      if (gain < 0.01) return null;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) {
        pan.pan.value = clamp(((dx * L.rx + dz * L.rz) / Math.max(1, d)) * 0.85, -1, 1);
        g.connect(pan);
        pan.connect(dest);
      } else g.connect(dest);
      if (d > 25) {
        // distance takes the top end off
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.max(900, 8000 - d * 90);
        lp.connect(g);
        g.gain.value = gain;
        return lp;
      }
    } else g.connect(dest);
    g.gain.value = gain;
    return g;
  }

  env(param, t, a, peak, d, end = 0.0001) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    param.exponentialRampToValueAtTime(end, t + a + d);
  }

  osc(type, f, t, dur, into, peak = 0.3, a = 0.005) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    const g = this.ctx.createGain();
    this.env(g.gain, t, a, peak, dur);
    o.connect(g); g.connect(into);
    o.start(t); o.stop(t + a + dur + 0.05);
    return o;
  }

  noiseBurst(t, dur, into, type, f, q, peak = 0.3, a = 0.004, buf) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf || this.noise;
    s.loop = true;
    s.loopStart = Math.random() * 1.5;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g.gain, t, a, peak, dur);
    s.connect(flt); flt.connect(g); g.connect(into);
    s.start(t, Math.random()); s.stop(t + a + dur + 0.05);
    return { s, flt, g };
  }

  /* -------------------------------------------------------------- sounds */

  bark(x, z, pitch = 1, gain = 1) {
    const out = this.voice(this.sfx, x, z, { gain, ref: 9 });
    if (!out) return;
    const t = this.ctx.currentTime + 0.005;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(420 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(190 * pitch, t + 0.13);
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900 * pitch; f.Q.value = 1.1;
    const g = this.ctx.createGain(); this.env(g.gain, t, 0.008, 0.55, 0.15);
    o.connect(f); f.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.2);
    this.noiseBurst(t, 0.09, out, 'bandpass', 1500 * pitch, 0.9, 0.35);
  }

  growl(x, z) {
    const out = this.voice(this.sfx, x, z, { gain: 0.7, ref: 6 });
    if (!out) return;
    const t = this.ctx.currentTime;
    const n = this.noiseBurst(t, 0.9, out, 'lowpass', 420, 2, 0.5, 0.08, this.brown);
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 27;
    const lg = this.ctx.createGain(); lg.gain.value = 0.3;
    lfo.connect(lg); lg.connect(n.g.gain); lfo.start(t); lfo.stop(t + 1);
  }

  yelp() {
    const out = this.voice(this.sfx, null, null, { gain: 0.8 });
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(1500, t); o.frequency.exponentialRampToValueAtTime(620, t + 0.32);
    const g = this.ctx.createGain(); this.env(g.gain, t, 0.01, 0.45, 0.35);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.4);
    this.osc('sine', 980, t + 0.18, 0.25, out, 0.18);
  }

  horn(kind, x, z, atDog) {
    if (this.hornBudget > 3) return;
    const out = this.voice(this.sfx, x, z, { gain: atDog ? 0.65 : 0.42, ref: 11, max: 80 });
    if (!out) return;
    this.hornBudget++;
    const t = this.ctx.currentTime + Math.random() * 0.03;
    const blasts = kind === 'bus' || kind === 'truck' ? 1 : Math.random() < 0.5 ? 2 : 1;
    for (let b = 0; b < blasts; b++) {
      const tb = t + b * 0.22;
      switch (kind) {
        case 'auto': // the nasal two-tone "pee-pee"
          for (const f of [640, 760]) { const lp = this.ctx.createBiquadFilter(); lp.type = 'bandpass'; lp.frequency.value = f * 1.5; lp.Q.value = 0.8; lp.connect(out); this.osc('square', f, tb, 0.16, lp, 0.18, 0.01); }
          break;
        case 'scooter':
          for (const f of [880, 1050]) { const lp = this.ctx.createBiquadFilter(); lp.type = 'bandpass'; lp.frequency.value = f * 1.4; lp.Q.value = 0.9; lp.connect(out); this.osc('square', f, tb, 0.12, lp, 0.14, 0.008); }
          break;
        case 'car':
          for (const f of [405, 510]) { const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800; lp.connect(out); this.osc('sawtooth', f, tb, 0.22, lp, 0.16, 0.012); }
          break;
        case 'bus':
        case 'truck': { // the musical pressure horn, three notes
          const notes = kind === 'truck' ? [330, 392, 440] : [262, 330, 392];
          notes.forEach((f, i) => {
            const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200; lp.connect(out);
            this.osc('sawtooth', f, tb + i * 0.16, 0.2 + (i === 2 ? 0.35 : 0), lp, 0.15, 0.02);
            this.osc('square', f * 1.5, tb + i * 0.16, 0.2 + (i === 2 ? 0.35 : 0), lp, 0.05, 0.02);
          });
          break;
        }
        default: // bicycle bell, ring-ring
          for (let r = 0; r < 2; r++) for (const [f, a] of [[2350, 0.16], [3450, 0.08], [4910, 0.05]]) this.osc('sine', f, tb + r * 0.16, 0.45, out, a, 0.002);
      }
    }
  }

  templeBell(x, z, single) {
    const out = this.voice(this.sfx, x, z, { gain: single ? 0.4 : 0.55, ref: 14, max: 110 });
    if (!out) return;
    const t = this.ctx.currentTime;
    const f = 612;
    const parts = [[1, 0.3, 3.2], [2.0, 0.16, 2.1], [2.76, 0.12, 1.7], [4.07, 0.07, 1.1], [5.43, 0.05, 0.8], [6.8, 0.03, 0.5]];
    const send = this.ctx.createGain(); send.gain.value = 0.6; out.connect(send); send.connect(this.verb);
    for (const [k, a, d] of parts) this.osc('sine', f * k, t, d, out, a, 0.002);
    this.noiseBurst(t, 0.03, out, 'highpass', 3000, 0.7, 0.2, 0.001);
  }

  whistle(x, z) {
    const out = this.voice(this.sfx, x, z, { gain: 0.35, ref: 14, max: 90 });
    if (!out) return;
    const t = this.ctx.currentTime;
    for (const [st, dur] of [[0, 0.32], [0.42, 0.12]]) {
      const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2900;
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 30;
      const lg = this.ctx.createGain(); lg.gain.value = 140;
      lfo.connect(lg); lg.connect(o.frequency);
      const g = this.ctx.createGain(); this.env(g.gain, t + st, 0.01, 0.3, dur);
      o.connect(g); g.connect(out);
      o.start(t + st); o.stop(t + st + dur + 0.05); lfo.start(t + st); lfo.stop(t + st + dur + 0.05);
    }
  }

  moo(x, z) {
    const out = this.voice(this.sfx, x, z, { gain: 0.6, ref: 10 });
    if (!out) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(118, t); o.frequency.linearRampToValueAtTime(132, t + 0.35); o.frequency.exponentialRampToValueAtTime(92, t + 1.3);
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2.2;
    f.frequency.setValueAtTime(380, t); f.frequency.linearRampToValueAtTime(700, t + 0.5); f.frequency.linearRampToValueAtTime(330, t + 1.3);
    const g = this.ctx.createGain(); this.env(g.gain, t, 0.18, 0.5, 1.2);
    o.connect(f); f.connect(g); g.connect(out); o.start(t); o.stop(t + 1.5);
  }

  flutter(x, z, n) {
    const out = this.voice(this.sfx, x, z, { gain: 0.25 + Math.min(0.4, n * 0.03), ref: 8 });
    if (!out) return;
    const t = this.ctx.currentTime;
    const b = this.noiseBurst(t, 0.9, out, 'bandpass', 1300, 0.7, 0.5, 0.02);
    const lfo = this.ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 17;
    const lg = this.ctx.createGain(); lg.gain.value = 0.35;
    lfo.connect(lg); lg.connect(b.g.gain); lfo.start(t); lfo.stop(t + 1);
  }

  murmur(x, z, high) {
    if (this.sayBudget > 2) return;
    const out = this.voice(this.sfx, x, z, { gain: 0.16, ref: 5, max: 26 });
    if (!out) return;
    this.sayBudget++;
    const t = this.ctx.currentTime;
    const base = high ? 300 : 190;
    const syl = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < syl; i++) {
      const ts = t + i * 0.11;
      const o = this.ctx.createOscillator(); o.type = 'triangle';
      const f0 = base * (0.85 + Math.random() * 0.4);
      o.frequency.setValueAtTime(f0, ts); o.frequency.linearRampToValueAtTime(f0 * (0.8 + Math.random() * 0.5), ts + 0.09);
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700 + Math.random() * 900; bp.Q.value = 1.5;
      const g = this.ctx.createGain(); this.env(g.gain, ts, 0.015, 0.5, 0.08);
      o.connect(bp); bp.connect(g); g.connect(out); o.start(ts); o.stop(ts + 0.13);
    }
  }

  crunch(n = 6) {
    const out = this.voice(this.sfx, null, null, { gain: 0.35 });
    const t = this.ctx.currentTime;
    for (let i = 0; i < n; i++) this.noiseBurst(t + i * 0.18 + Math.random() * 0.06, 0.05, out, 'highpass', 1800 + Math.random() * 1500, 0.8, 0.5, 0.002);
  }

  lap() {
    const out = this.voice(this.sfx, null, null, { gain: 0.3 });
    const t = this.ctx.currentTime;
    for (let i = 0; i < 10; i++) this.noiseBurst(t + i * 0.2, 0.07, out, 'bandpass', 650 + Math.random() * 200, 3, 0.6, 0.01);
  }

  thud(gain = 0.3) {
    const out = this.voice(this.sfx, null, null, { gain });
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    const g = this.ctx.createGain(); this.env(g.gain, t, 0.004, 0.6, 0.14);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.2);
  }

  tok(x, z) {
    const out = this.voice(this.sfx, x, z, { gain: 0.5, ref: 10 });
    if (!out) return;
    const t = this.ctx.currentTime;
    this.osc('sine', 950, t, 0.06, out, 0.5, 0.001);
    this.noiseBurst(t, 0.03, out, 'bandpass', 2200, 1.2, 0.4, 0.001);
  }

  pluck(i, t, gain = 0.4, into) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.plucks[Math.max(0, Math.min(this.plucks.length - 1, i))];
    const g = this.ctx.createGain(); g.gain.value = gain;
    s.connect(g); g.connect(into || this.sfx);
    s.start(t);
  }

  jingle(kind) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    const seqs = {
      task: [0, 2, 4, 5],
      rank: [0, 2, 3, 4, 5, 7, 9],
      friend: [4, 3, 4, 7],
      pet: [5, 7],
      sad: [4, 2, 0],
      day: [0, 4, 3, 2, 0],
    };
    const seq = seqs[kind] || seqs.task;
    seq.forEach((n, i) => this.pluck(n, t + i * (kind === 'rank' ? 0.11 : 0.13), kind === 'pet' ? 0.22 : 0.42));
  }

  /* --------------------------------------------------------------- loops */

  loops() {
    const ctx = this.ctx;
    const loop = (buf, type, f, q) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
      const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      s.connect(flt); flt.connect(g); g.connect(this.amb);
      s.start();
      return { s, flt, g };
    };
    this.rumble = loop(this.brown, 'lowpass', 180, 0.7);
    this.crowd = loop(this.noise, 'bandpass', 520, 0.6);
    this.rain = loop(this.noise, 'highpass', 1400, 0.5);
    this.pant = loop(this.noise, 'bandpass', 1900, 1.4);
    // crickets: a high tone gated in chirps
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 4700;
    const gate = ctx.createGain(); gate.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 26;
    const lg = ctx.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg); lg.connect(gate.gain);
    const cg = ctx.createGain(); cg.gain.value = 0;
    o.connect(gate); gate.connect(cg); cg.connect(this.amb);
    o.start(); lfo.start();
    this.crickets = { g: cg, gate };
    this.crowdMod = 0;
  }

  /**
   * Per frame: move the listener with the camera, steer the loops toward what
   * is around the dog, and keep the drone going.
   */
  update(dt, S, cam, env) {
    if (!this.ctx) return;
    this.hornBudget = Math.max(0, this.hornBudget - dt * 6);
    this.sayBudget = Math.max(0, this.sayBudget - dt * 2.5);
    const d = S.dog;
    this.listener.x = d.x; this.listener.z = d.z;
    this.listener.rx = Math.cos(cam.yaw); this.listener.rz = -Math.sin(cam.yaw);
    const t = this.ctx.currentTime;
    // how busy is it here?
    let veh = 0, ped = 0;
    for (const v of S.vehicles) { const q = dist2(v.x, v.z, d.x, d.z); if (q < 1600) veh += (1 - q / 1600) * (0.4 + Math.min(1, v.v / 8)); }
    for (const p of S.peds) { if (p.hidden) continue; const q = dist2(p.x, p.z, d.x, d.z); if (q < 400) ped += 1 - q / 400; }
    this.crowdMod += (Math.random() - 0.5) * dt * 3;
    this.crowdMod = clamp(this.crowdMod, -0.4, 0.4);
    const night = env.night;
    this.rumble.g.gain.setTargetAtTime(clamp(0.08 + veh * 0.05, 0, 0.6), t, 0.4);
    this.crowd.g.gain.setTargetAtTime(clamp(ped * 0.012 * (1 + this.crowdMod), 0, 0.22), t, 0.3);
    this.crowd.flt.frequency.setTargetAtTime(480 + this.crowdMod * 200, t, 0.3);
    this.rain.g.gain.setTargetAtTime(env.rain ? 0.22 : 0, t, 1.0);
    this.crickets.g.gain.setTargetAtTime(night > 0.5 && !env.rain ? 0.012 * night : 0, t, 1.5);
    this.crickets.gate.gain.value = Math.sin(t * 7) > 0.2 ? 0.5 : 0;
    // panting, in rhythm
    const pant = d.panting && !d.sleeping ? (Math.sin(t * 22) > 0 ? 0.07 : 0.012) : 0;
    this.pant.g.gain.setTargetAtTime(pant, t, 0.03);
    // tanpura: Pa Sa Sa Sa, over and over
    if (this.music) {
      this.droneT -= dt;
      if (this.droneT <= 0) {
        this.droneT = 1.3;
        const s = this.ctx.createBufferSource();
        s.buffer = this.drone[this.droneI % 4];
        this.droneI++;
        const g = this.ctx.createGain(); g.gain.value = 0.55;
        const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
        s.connect(lp); lp.connect(g); g.connect(this.mus);
        const send = this.ctx.createGain(); send.gain.value = 0.25; g.connect(send); send.connect(this.verb);
        s.start();
      }
    }
    // sparrows in the morning
    const h = S.clock.hours;
    if (h > 5.8 && h < 9.5 && !env.rain && Math.random() < dt * 0.6) {
      const out = this.voice(this.amb, d.x + (Math.random() - 0.5) * 30, d.z + (Math.random() - 0.5) * 30, { gain: 0.08, ref: 10 });
      if (out) {
        const tt = this.ctx.currentTime;
        for (let i = 0; i < 3; i++) { const o = this.osc('sine', 3600 + Math.random() * 1200, tt + i * 0.09, 0.05, out, 0.3, 0.002); o.frequency.exponentialRampToValueAtTime(5200, tt + i * 0.09 + 0.05); }
      }
    }
  }

  /** Turn the frame's sim events into sound. */
  handle(events, S) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    for (const e of events) {
      switch (e.type) {
        case 'bark': this.bark(null, null, 1, 0.8); break;
        case 'npcBark': this.bark(e.x, e.z, e.puppy ? 1.7 : e.key === 'sheru' ? 0.78 : e.key === 'kalu' ? 0.88 : 1.12, 0.7); break;
        case 'growl': this.growl(e.x, e.z); break;
        case 'honk': this.horn(e.horn, e.x, e.z, e.atDog); break;
        case 'hit': this.yelp(); this.thud(0.5); break;
        case 'nipped': this.yelp(); break;
        case 'bell': this.templeBell(e.x, e.z, e.single); break;
        case 'whistle': this.whistle(e.x, e.z); break;
        case 'moo': this.moo(e.x, e.z); break;
        case 'scatter': this.flutter(e.x, e.z, e.n); break;
        case 'say': break;
        case 'vendorCall': this.murmur(e.x, e.z, false); break;
        case 'ate': this.crunch(e.kind === 'milk' ? 0 : 6); if (e.kind === 'milk') this.lap(); break;
        case 'drank': this.lap(); break;
        case 'rummage': this.crunch(3); break;
        case 'pickup': case 'drop': this.thud(0.18); break;
        case 'land': this.thud(Math.min(0.4, e.v * 0.05)); break;
        case 'batHit': this.tok(e.x, e.z); break;
        case 'petted': this.jingle('pet'); break;
        case 'taskDone': this.jingle('task'); break;
        case 'rank': this.jingle('rank'); break;
        case 'friend': this.jingle('friend'); break;
        case 'faint': this.jingle('sad'); break;
        case 'butted': this.thud(0.35); break;
        case 'thiefShout': this.murmur(e.x, e.z, false); break;
        default:
      }
    }
  }

  /** A bubble appeared over someone: a little murmur from where they stand. */
  speech(who) {
    if (!this.ctx || this.ctx.state !== 'running' || !who) return;
    this.murmur(who.x, who.z, !!(who.kid || (who.kind === 'saree' || who.kind === 'salwar' || who.kind === 'girl')));
  }
}
