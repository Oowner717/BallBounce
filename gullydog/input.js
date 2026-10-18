/*
 * input.js — keyboard, mouse, touch and gamepad, folded into one snapshot.
 *
 * poll() returns:
 *   move   {x, y}  stick: x to the right, y forward (camera-relative), 0..1
 *   run           held
 *   look   {dx, dy} camera orbit dragged, in pixels-ish, since the last poll
 *   lookStick {x, y} right stick / look keys, -1..1, already through the
 *                 dead zone and response curve (see controls.js)
 *   zoom          wheel / pinch steps since the last poll
 *   jump, bark, sniff, act, lie, pause, map, tasks   edge-triggered
 *
 * TOUCH: the left side of the screen is a floating joystick (push it to the rim
 * to sprint); the right side drags the camera; the round buttons do the rest.
 * iOS fires pointercancel on system gestures, so every pointer that ends any
 * way at all releases whatever it was holding.
 */

import { CONTROLS, shapeAxis, rampTo } from './controls.js';

const EDGES = ['jump', 'bark', 'sniff', 'act', 'lie', 'pause', 'map', 'tasks', 'help'];

const KEYMAP = {
  Space: 'jump', KeyB: 'bark', KeyF: 'sniff', KeyE: 'act', Enter: 'act', KeyZ: 'lie', KeyX: 'lie',
  Escape: 'pause', KeyP: 'pause', KeyM: 'map', Tab: 'tasks', KeyT: 'tasks', KeyH: 'help', Slash: 'help',
};

export class Input {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;
    this.keys = new Set();
    this.edges = {};
    this.look = { dx: 0, dy: 0 };
    this.zoom = 0;
    this.stick = null;          // { id, ox, oy, x, y }
    this.lookPtr = null;        // { id, x, y }
    this.pinch = null;
    this.mouseDrag = null;
    this.runHeld = false;
    this.edgeRunT = 0;
    this.stickRun = false;
    this.pads = [];
    this.lastPadButtons = [];
    this.usedTouch = false;
    this.keyX = 0;              // A/D, eased in and out
    this.keyLookX = 0;          // , and . (look), eased in and out
    this.enabled = true;
    this.bind();
  }

  bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' && e.code === 'Enter')) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!e.repeat && KEYMAP[e.code]) this.edges[KEYMAP[e.code]] = true;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.moveP(e));
    for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) c.addEventListener(t, (e) => this.up(e));
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom += Math.sign(e.deltaY); }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // touch buttons: anything with data-act fires that edge; data-hold holds it
    if (this.ui && this.ui.buttons) {
      for (const b of this.ui.buttons) {
        const act = b.dataset.act;
        const hold = b.dataset.hold;
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.usedTouch = this.usedTouch || e.pointerType === 'touch';
          if (act) this.edges[act] = true;
          if (hold === 'run') { this.runHeld = true; b.classList.add('held'); }
          b.classList.add('pressed');
          try { b.setPointerCapture(e.pointerId); } catch (err) { /* older Safari */ }
        });
        const off = () => { b.classList.remove('pressed'); if (hold === 'run') { this.runHeld = false; b.classList.remove('held'); } };
        for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, off);
      }
    }
  }

  releaseAll() {
    this.keys.clear();
    this.stick = null;
    this.lookPtr = null;
    this.pinch = null;
    this.mouseDrag = null;
    this.runHeld = false;
    this.stickRun = false;
    this.showStick(null);
  }

  down(e) {
    if (!this.enabled) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (e.pointerType === 'mouse') {
      this.mouseDrag = { id: e.pointerId, x, y };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      return;
    }
    this.usedTouch = true;
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (x < rect.width * 0.45 && !this.stick) {
      this.stick = { id: e.pointerId, ox: x, oy: y, x, y };
      this.showStick(this.stick);
    } else if (!this.lookPtr) {
      this.lookPtr = { id: e.pointerId, x, y };
    } else if (!this.pinch) {
      this.pinch = { id: e.pointerId, x, y, d0: Math.hypot(x - this.lookPtr.x, y - this.lookPtr.y) };
    }
  }

  moveP(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (this.mouseDrag && e.pointerId === this.mouseDrag.id) {
      this.look.dx += x - this.mouseDrag.x;
      this.look.dy += y - this.mouseDrag.y;
      this.mouseDrag.x = x; this.mouseDrag.y = y;
      return;
    }
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick.x = x; this.stick.y = y;
      this.showStick(this.stick);
      return;
    }
    if (this.pinch && (e.pointerId === this.pinch.id || (this.lookPtr && e.pointerId === this.lookPtr.id))) {
      if (e.pointerId === this.pinch.id) { this.pinch.x = x; this.pinch.y = y; } else { this.lookPtr.x = x; this.lookPtr.y = y; }
      const d = Math.hypot(this.pinch.x - this.lookPtr.x, this.pinch.y - this.lookPtr.y);
      if (Math.abs(d - this.pinch.d0) > 24) { this.zoom += d < this.pinch.d0 ? 1 : -1; this.pinch.d0 = d; }
      return;
    }
    if (this.lookPtr && e.pointerId === this.lookPtr.id) {
      this.look.dx += (x - this.lookPtr.x) * 1.3;
      this.look.dy += (y - this.lookPtr.y) * 1.3;
      this.lookPtr.x = x; this.lookPtr.y = y;
    }
  }

  up(e) {
    if (this.mouseDrag && e.pointerId === this.mouseDrag.id) this.mouseDrag = null;
    if (this.stick && e.pointerId === this.stick.id) { this.stick = null; this.stickRun = false; this.showStick(null); }
    if (this.lookPtr && e.pointerId === this.lookPtr.id) { this.lookPtr = this.pinch ? { id: this.pinch.id, x: this.pinch.x, y: this.pinch.y } : null; this.pinch = null; }
    if (this.pinch && e.pointerId === this.pinch.id) this.pinch = null;
  }

  showStick(s) {
    const ui = this.ui;
    if (!ui || !ui.stickBase) return;
    if (!s) { ui.stickBase.style.display = 'none'; return; }
    const R = 56;
    let dx = s.x - s.ox, dy = s.y - s.oy;
    const l = Math.hypot(dx, dy);
    if (l > R) { dx *= R / l; dy *= R / l; }
    ui.stickBase.style.display = 'block';
    ui.stickBase.style.transform = `translate(${s.ox - 64}px, ${s.oy - 64}px)`;
    ui.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    ui.stickBase.classList.toggle('sprint', this.stickRun);
  }

  pollPads() {
    const out = { mx: 0, my: 0, lx: 0, ly: 0, run: false };
    let pads = [];
    try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : []; } catch (e) { pads = []; }
    pads.forEach((p, i) => {
      const prev = this.lastPadButtons[i] || [];
      const pressed = p.buttons.map((b) => b.pressed || b.value > 0.5);
      const edge = (k) => pressed[k] && !prev[k];
      // raw axes: the dead zones and curves live in controls.js, applied once.
      // A worn stick at rest still reads a little, so the left one has a small
      // round dead zone of its own; the sim ignores tiny pushes anyway.
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.1) { out.mx += ax; out.my += -ay; }
      out.lx += p.axes[2] || 0; out.ly += p.axes[3] || 0;
      if (pressed[5] || pressed[7] || pressed[10]) out.run = true;
      if (edge(0)) this.edges.jump = true;
      if (edge(1)) this.edges.bark = true;
      if (edge(2)) this.edges.act = true;
      if (edge(3)) this.edges.sniff = true;
      if (edge(4) || edge(6)) this.edges.lie = true;
      if (edge(9)) this.edges.pause = true;
      if (edge(8)) this.edges.map = true;
      if (pressed[12]) out.my = 1; if (pressed[13]) out.my = -1; if (pressed[14]) out.mx = -1; if (pressed[15]) out.mx = 1;
      this.lastPadButtons[i] = pressed;
    });
    return out;
  }

  poll(dt) {
    const k = this.keys;
    let mx = 0, my = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) my += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;
    // Keys are all or nothing. Easing left-right in (a quarter of a second to the
    // full turn) and out makes A and D steer like a stick pushed smoothly.
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    this.keyX = rampTo(this.keyX, kx, (kx ? 4 : 8) * dt);
    mx += this.keyX;
    let run = k.has('ShiftLeft') || k.has('ShiftRight') || this.runHeld;
    // keyboard look: Q/E would collide with act; use the comma and period keys
    const kl = (k.has('Period') ? 1 : 0) - (k.has('Comma') ? 1 : 0);
    this.keyLookX = rampTo(this.keyLookX, kl, (kl ? 4 : 8) * dt);
    if (this.stick) {
      const R = 56;
      const sx = (this.stick.x - this.stick.ox) / R, sy = -(this.stick.y - this.stick.oy) / R;
      const l = Math.hypot(sx, sy);
      const m = Math.min(1, l);
      if (l > 0.05) { mx += (sx / l) * m; my += (sy / l) * m; }
      // push to the rim and hold: sprint
      if (l > 0.95) { this.edgeRunT += dt; if (this.edgeRunT > 0.18) this.stickRun = true; }
      else { this.edgeRunT = 0; if (l < 0.8) this.stickRun = false; }
      if (this.stickRun) run = true;
      if (this.ui && this.ui.stickBase) this.ui.stickBase.classList.toggle('sprint', this.stickRun);
    }
    const pad = this.pollPads();
    mx += pad.mx; my += pad.my;
    if (pad.run) run = true;
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    // the right stick and the look keys turn the view at a rate set by how far they are pushed
    const C = CONTROLS;
    const lookX = Math.max(-1, Math.min(1, shapeAxis(pad.lx, C.lookDeadzone, C.lookCurve) + this.keyLookX));
    const lookY = shapeAxis(pad.ly, C.lookDeadzone, C.lookCurve);
    const snap = {
      move: { x: mx, y: my }, run,
      look: { dx: this.look.dx, dy: this.look.dy }, lookStick: { x: lookX, y: lookY }, zoom: this.zoom,
    };
    for (const e of EDGES) { snap[e] = !!this.edges[e]; this.edges[e] = false; }
    this.look.dx = 0; this.look.dy = 0; this.zoom = 0;
    return snap;
  }
}
