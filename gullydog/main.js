/*
 * main.js — boot, loop, camera, and turning the sim into a picture and sound.
 *
 * The sim (sim.js and friends) knows nothing about the screen. Each frame this
 * file reads the input, steps the sim, poses every visible creature through its
 * rig, hands the renderer instances, decals, particles and lights, and lets the
 * HUD and the audio react to the frame's events.
 */

import { generateWorld, collidersNear, PLAY_HALF } from './world.js';
import { buildCity } from './cityMesh.js';
import { atlasLayout, paintAtlas, paintNoise } from './textures.js';
import { buildAllModels, PEOPLE_KINDS } from './models.js';
import { Renderer } from './gfx.js';
import { Rig, newAnim, animateDog, poseDog, animateHuman, poseHuman, animateQuad, poseQuad, poseBird, poseVehicle } from './rig.js';
import { environment } from './env.js';
import { createSim, step, drainEvents, contextAction, newDay, serializeSave, loadSave, SAVE_KEY } from './sim.js';
import { groundAt } from './simcore.js';
import { Input } from './input.js';
import { CONTROLS, steerRate, aimStick, easeRate } from './controls.js';
import { AudioEngine } from './audio.js';
import { Hud } from './hud.js';
import { m4, m4Mul, m4Perspective, m4LookAt, clamp, lerp, dist2, hex, makeRng, TAU } from './util.js';

const Q = new URLSearchParams(location.search);
const DEBUG = Q.has('debug');
const SETTINGS_KEY = 'gullydog-settings-v1';

/* -------------------------------------------------------------- settings */

function loadSettings() {
  const d = { sound: true, music: true, quality: 'auto', invert: false, tasksHidden: false };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof s.sound === 'boolean') d.sound = s.sound;
    if (typeof s.music === 'boolean') d.music = s.music;
    if (['auto', 'low', 'medium', 'high'].includes(s.quality)) d.quality = s.quality;
    if (typeof s.invert === 'boolean') d.invert = s.invert;
    if (typeof s.tasksHidden === 'boolean') d.tasksHidden = s.tasksHidden;
  } catch (e) { /* private mode or junk: defaults */ }
  return d;
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }

const isTouchDevice = () => (navigator.maxTouchPoints || 0) > 0 && matchMedia('(pointer: coarse)').matches;

function qualityProfile(q) {
  const touch = isTouchDevice();
  if (q === 'auto') q = touch ? 'medium' : 'high';
  if (Q.get('quality')) q = Q.get('quality');
  return {
    name: q,
    dpr: q === 'high' ? 2 : q === 'medium' ? 1.5 : 1,
    shadows: q !== 'low',
    shadowSize: q === 'high' ? 2048 : 1024,
    draw: q === 'low' ? 110 : q === 'medium' ? 140 : 170,
    peopleDist: q === 'low' ? 55 : q === 'medium' ? 70 : 85,
    antialias: q !== 'low',
  };
}

/* ------------------------------------------------------------------ boot */

const canvas = document.getElementById('stage');
const settings = loadSettings();
let profile = qualityProfile(settings.quality);
let W, layout, city, models, R, S, input, audio, hud;
const rigs = {};
const anims = new WeakMap();
const animOf = (o) => { let a = anims.get(o); if (!a) { a = newAnim(); a.t = Math.random() * 10; anims.set(o, a); } return a; };
let state = 'loading'; // loading | start | play | pause | summary
let glLost = false;
let lastSave = 0;

function setLoading(msg) { const el = document.getElementById('loadMsg'); if (el) el.textContent = msg; }
function fail(err) {
  console.error(err);
  const el = document.getElementById('err');
  if (el) el.textContent = String(err).includes('WebGL')
    ? 'Gully Dog needs WebGL 2: Safari on iOS 15 or later, or any recent Chrome, Firefox or Edge.'
    : 'Something went wrong: ' + (err && err.message ? err.message : String(err));
  document.title = 'error';
}
window.addEventListener('error', (e) => { if (state === 'loading') fail(e.error || e.message); });

async function boot() {
  const seed = Number(Q.get('seed')) || 7;
  setLoading('Laying out the galis…');
  await frame0();
  W = generateWorld(seed);
  setLoading('Painting the shop signs…');
  await frame0();
  layout = atlasLayout();
  const painted = paintAtlas(layout, document);
  const noise = paintNoise(document);
  setLoading('Building the neighbourhood…');
  await frame0();
  city = buildCity(W, layout);
  models = buildAllModels();
  R = new Renderer(canvas, { shadowSize: profile.shadowSize, antialias: profile.antialias });
  // iOS takes the GPU back from a tab left in the background. Ask for it to be
  // restored, and when it is, reload into the day as saved: rebuilding every buffer
  // in place is not worth the code for something that happens this rarely.
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); glLost = true; persist(); });
  canvas.addEventListener('webglcontextrestored', () => { persist(); location.reload(); });
  R.setTextures(painted.canvas, noise);
  R.setCity(city);
  for (const [k, m] of Object.entries(models)) { R.addModel(k, m); rigs[k] = new Rig(m); }
  setLoading('Waking up the mohalla…');
  await frame0();
  let save = null;
  try { save = loadSave(localStorage.getItem(SAVE_KEY)); } catch (e) { save = loadSave(null); }
  if (Q.has('fresh')) save = loadSave(null);
  S = createSim({ world: W, seed, save });
  if (Q.has('hour')) S.clock.hours = Number(Q.get('hour'));
  if (Q.has('weather')) S.weather = Q.get('weather');
  if (Q.has('x') && Q.has('z')) { S.dog.x = Number(Q.get('x')); S.dog.z = Number(Q.get('z')); S.dog.y = groundAt(S, S.dog.x, S.dog.z, 2); S.dog.lying = false; }
  if (Q.has('yaw')) S.dog.yaw = Number(Q.get('yaw'));
  input = new Input(canvas, { buttons: Array.from(document.querySelectorAll('[data-act]')), stickBase: document.getElementById('stickBase'), stickKnob: document.getElementById('stickKnob') });
  audio = new AudioEngine();
  audio.muted = !settings.sound;
  audio.music = settings.music;
  hud = new Hud(W);
  if (settings.tasksHidden) document.getElementById('tasks').classList.add('collapsed');
  cam.yaw = S.dog.yaw + Math.PI;
  resize();
  window.addEventListener('resize', resize);
  wireUi();
  document.getElementById('loading').remove();
  if (isTouchDevice()) { document.body.classList.add('touch'); hud.touch = true; }
  state = 'start';
  document.getElementById('playBtn').textContent = S.clock.day > 1 || (save && save.mid) ? `Continue · Day ${S.clock.day}` : 'Play';
  if (Q.has('autoplay')) startGame(); else document.getElementById('start').classList.add('open');
  last = performance.now();
  requestAnimationFrame(loop);
  window.__game = { S, R, cam, W, hud, input, audio, timing, state: () => state, setHour: (h) => { S.clock.hours = h; }, profile: () => profile };
  document.title = 'Gully Dog';
  registerSW();
}

const frame0 = () => new Promise((r) => requestAnimationFrame(() => r()));

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, profile.dpr) * renderScale;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

/* ---------------------------------------------------------------- the UI */

function toggleBtn(id, on) { const b = document.getElementById(id); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
function syncToggles() {
  for (const id of ['tSound', 'pSound']) toggleBtn(id, settings.sound);
  for (const id of ['tMusic', 'pMusic']) toggleBtn(id, settings.music);
  toggleBtn('pInvert', settings.invert);
  for (const id of ['tQuality', 'pQuality']) { const b = document.getElementById(id); if (b) b.textContent = 'Quality: ' + settings.quality; }
}

function wireUi() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('playBtn', startGame);
  on('helpBtn', () => openScreen('help'));
  on('helpClose', () => { closeScreen('help'); if (state === 'pause') openScreen('pause'); });
  on('pHelp', () => { closeScreen('pause'); openScreen('help'); });
  on('resumeBtn', resumeGame);
  const sound = () => { settings.sound = !settings.sound; audio.setMuted(!settings.sound); saveSettings(settings); syncToggles(); };
  const music = () => { settings.music = !settings.music; audio.setMusic(settings.music); saveSettings(settings); syncToggles(); };
  const quality = () => {
    const order = ['auto', 'high', 'medium', 'low'];
    settings.quality = order[(order.indexOf(settings.quality) + 1) % order.length];
    profile = qualityProfile(settings.quality);
    if (R.shadowSize !== profile.shadowSize) R.makeShadowMap(profile.shadowSize);
    renderScale = 1;
    resize();
    saveSettings(settings);
    syncToggles();
  };
  on('tSound', sound); on('pSound', sound);
  on('tMusic', music); on('pMusic', music);
  on('tQuality', quality); on('pQuality', quality);
  on('pInvert', () => { settings.invert = !settings.invert; saveSettings(settings); syncToggles(); });
  // Two taps, confirmed in the page itself: confirm() is refused in embedded frames
  // and looks foreign in an installed app.
  let armedAt = -1e9;
  on('newGame', () => {
    const btn = document.getElementById('newGame');
    if (performance.now() - armedAt > 4000) {
      armedAt = performance.now();
      btn.textContent = 'Tap again: your cred and friends will be forgotten';
      setTimeout(() => { if (performance.now() - armedAt >= 3990) btn.textContent = 'Start over from day one'; }, 4000);
      return;
    }
    wiping = true; // or the pagehide on the way out saves the old day straight back
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    location.reload();
  });
  on('tasksHead', () => {
    const t = document.getElementById('tasks');
    t.classList.toggle('collapsed');
    settings.tasksHidden = t.classList.contains('collapsed');
    saveSettings(settings);
  });
  syncToggles();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      persist();
      if (audio) audio.suspend();
      if (state === 'play') pauseGame();
    }
  });
  window.addEventListener('pagehide', persist);
  // sound stopped by iOS (a call, Siri, the screen locking) comes back on the next tap in play
  document.addEventListener('pointerup', () => { if (state === 'play' && audio) audio.resume(); }, { passive: true });
  // the first touch anywhere switches to touch controls
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !document.body.classList.contains('touch')) { document.body.classList.add('touch'); hud.touch = true; }
  }, { capture: true });
}

function openScreen(id) { document.getElementById(id).classList.add('open'); }
function closeScreen(id) { document.getElementById(id).classList.remove('open'); }

function startGame() {
  closeScreen('start');
  audio.start();
  audio.setMuted(!settings.sound);
  document.getElementById('hud').classList.remove('hidden');
  state = 'play';
  input.enabled = true;
}
function pauseGame() { if (state !== 'play') return; state = 'pause'; openScreen('pause'); }
function resumeGame() { closeScreen('pause'); closeScreen('help'); state = 'play'; audio.resume(); last = performance.now(); }

let wiping = false;
function persist() {
  if (!S || wiping) return;
  try { localStorage.setItem(SAVE_KEY, serializeSave(S)); } catch (e) { /* storage full or blocked: play on */ }
}

/* ---------------------------------------------------------------- camera */

const IDLE_INPUT = { move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 }, lookStick: { x: 0, y: 0 }, zoom: 0 };

const cam = { yaw: 0, pitch: 0.24, dist: 3.9, tx: 0, ty: 0.6, tz: 0, x: 0, y: 2, z: 5, fov: 62, shake: 0, init: false, steer: 0, lookVx: 0, lookVy: 0 };
const view = m4(), proj = m4(), vp = m4();

function updateCamera(dt, inp) {
  const d = S.dog;
  const lookSpeed = 0.0052;
  const inv = settings.invert ? -1 : 1;
  // dragged with a finger or the mouse: the view follows the drag exactly
  if (inp.look.dx || inp.look.dy) {
    cam.yaw -= inp.look.dx * lookSpeed;
    cam.pitch = clamp(cam.pitch + inp.look.dy * 0.0042 * inv, -0.12, 1.25);
  }
  // Steering: the movement stick's left-right swings the view round at a rate set
  // by how far it is pushed, eased in and out (controls.js). The dog runs relative
  // to the view, so he turns with it, in an arc as wide as the push is gentle.
  // The right stick and the look keys turn it the same way.
  cam.steer = easeRate(cam.steer, steerRate(inp.move.x, inp.move.y), dt);
  cam.lookVx = easeRate(cam.lookVx, inp.lookStick.x * CONTROLS.maxLookX, dt);
  cam.lookVy = easeRate(cam.lookVy, inp.lookStick.y * CONTROLS.maxLookY, dt);
  cam.yaw -= (cam.steer + cam.lookVx) * dt;
  cam.pitch = clamp(cam.pitch + cam.lookVy * inv * dt, -0.12, 1.25);
  if (inp.zoom) cam.dist = clamp(cam.dist * Math.pow(1.12, inp.zoom), 1.8, 14);
  if (d.sleeping) cam.yaw += dt * 0.05;
  // follow the dog, smoothed (but not through kerbs)
  const ty = (d.ry !== undefined ? d.ry : d.y) + 0.62;
  const k = cam.init ? 1 - Math.exp(-12 * dt) : 1;
  cam.tx += (d.x - cam.tx) * k; cam.tz += (d.z - cam.tz) * k; cam.ty += (ty - cam.ty) * k;
  cam.init = true;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  let dist = cam.dist;
  // pull in when something is between the dog and the camera: snap in at once,
  // ease back out, so the view does not pump as the dog trots past a stall
  const dx = Math.sin(cam.yaw) * cp, dy = sp, dz = Math.cos(cam.yaw) * cp;
  const hit = rayBuildings(cam.tx, cam.ty, cam.tz, dx, dy, dz, dist + 0.3);
  if (hit < dist + 0.3) dist = Math.max(0.7, hit - 0.3);
  if (cam.cur === undefined || dist < cam.cur) cam.cur = dist;
  else cam.cur += (dist - cam.cur) * (1 - Math.exp(-2.5 * dt));
  dist = cam.cur;
  cam.x = cam.tx + dx * dist; cam.y = cam.ty + dy * dist; cam.z = cam.tz + dz * dist;
  const gy = groundAt(S, cam.x, cam.z, cam.y) + 0.22;
  if (cam.y < gy) cam.y = gy;
  // a little lurch when hit
  cam.shake = Math.max(0, cam.shake - dt * 2.5);
  const sh = cam.shake * cam.shake * 0.12;
  const ox = (Math.random() - 0.5) * sh, oy = (Math.random() - 0.5) * sh;
  m4LookAt(view, cam.x + ox, cam.y + oy, cam.z, cam.tx, cam.ty, cam.tz);
  m4Perspective(proj, (cam.fov * Math.PI) / 180, canvas.width / Math.max(1, canvas.height), 0.08, 700);
}

const rayList = [];
/**
 * How far the camera can sit from the dog along a ray before something gets in
 * the way: walls and anything solid (but not lamp posts, which would make the
 * view jump), and the things with no collider that would fill the screen from
 * close up: a stall under its tarp, a shop awning, a tree's canopy.
 */
function rayBuildings(ox, oy, oz, dx, dy, dz, max) {
  for (let t = 0.3; t < max; t += 0.2) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    collidersNear(W, x, z, 0.05, rayList);
    for (const idx of rayList) {
      const c = W.colliders[idx];
      if (y > c.y1 + 0.1 || y < c.y0) continue;
      if (c.kind === 'box') { if (x > c.x0 - 0.1 && x < c.x1 + 0.1 && z > c.z0 - 0.1 && z < c.z1 + 0.1) return t; }
      else if (c.r > 0.5 && dist2(x, z, c.x, c.z) < (c.r + 0.1) * (c.r + 0.1)) return t;
    }
    if (y < 2.6) {
      for (const st of W.stalls) {
        const rx = x - st.x, rz = z - st.z;
        if (rx * rx + rz * rz > 9) continue;
        const ca = Math.cos(st.yaw), sa = Math.sin(st.yaw);
        const lx = rx * ca - rz * sa, lz = rx * sa + rz * ca;
        if (Math.abs(lx) < st.w / 2 + 0.4 && Math.abs(lz) < st.d / 2 + 0.6) return t;
      }
    }
    for (const sh of W.shades) {
      if (sh.kind === 'box') {
        if (x > sh.x0 && x < sh.x1 && z > sh.z0 && z < sh.z1 && y > sh.y0 - 0.3 && y < sh.y1 + 0.3) return t;
      } else if ((x - sh.x) ** 2 + (y - sh.y) ** 2 + (z - sh.z) ** 2 < sh.r * sh.r) return t;
    }
  }
  return max;
}

/* ------------------------------------------------------------- the loop */

let last = 0;
let renderScale = 1;
let slowFrames = 0, fastFrames = 0;
let fps = 60, frameMs = 16;
const timing = { sim: 0, draw: 0, submit: 0, gl: 0 };
const DOG_COAT = ['#b8763c', '#ead2ad', '#6b3f1d'].map(hex);
const COLLAR_RED = hex('#c0392b');

function loop(now) {
  requestAnimationFrame(loop);
  const rawDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (!S) return;
  frameMs = lerp(frameMs, rawDt * 1000, 0.05);
  fps = 1000 / Math.max(1, frameMs);
  adaptResolution(rawDt);
  const inp = input.poll(rawDt);
  if (state === 'play') {
    if (inp.pause) { pauseGame(); }
    if (inp.help) { pauseGame(); closeScreen('pause'); openScreen('help'); }
    if (inp.tasks) document.getElementById('tasksHead').click();
    if (inp.map) document.getElementById('minimapWrap').classList.toggle('hidden');
  } else if (state === 'pause' && inp.pause) resumeGame();
  else if (state === 'start' && (inp.act || inp.jump)) startGame();

  if (state === 'play') {
    // stick (x right, y forward) to world, relative to where the camera faces, with
    // its sideways part softened so a part-push bends the path gently
    const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
    const [ax, ay] = aimStick(inp.move.x, inp.move.y);
    const simIn = {
      mx: rx * ax + fx * ay, mz: rz * ax + fz * ay,
      run: inp.run, jump: inp.jump, bark: inp.bark, sniff: inp.sniff, act: inp.act, lie: inp.lie,
    };
    // a long frame is split so the sim never integrates a huge step
    let left = Q.has('fixedstep') ? 1 / 30 : rawDt;
    let first = true;
    const t0 = performance.now();
    while (left > 1e-4) {
      const h = Math.min(left, 1 / 30);
      step(S, h, first ? simIn : { mx: simIn.mx, mz: simIn.mz, run: simIn.run });
      first = false;
      left -= h;
    }
    timing.sim = lerp(timing.sim, performance.now() - t0, 0.1);
    const events = drainEvents(S);
    onEvents(events);
    if (now - lastSave > 10000) { lastSave = now; persist(); }
  }
  const d = S.dog;
  d.ry = d.ry === undefined || !d.onGround ? d.y : d.ry + (d.y - d.ry) * (1 - Math.exp(-18 * rawDt));
  updateCamera(rawDt, state === 'play' ? inp : IDLE_INPUT);
  try {
    const t1 = performance.now();
    if (!glLost) drawScene(Q.has('fixedstep') ? 1 / 30 : rawDt, now / 1000);
    timing.draw = lerp(timing.draw, performance.now() - t1, 0.1);
  } catch (e) {
    console.error(e);
    if (!window.__drawErr) window.__drawErr = String(e && e.stack);
  }
  if (state === 'play' || state === 'pause') {
    const env = lastEnv;
    hud.update(S, cam, vp, canvas, rawDt, state === 'play' ? contextAction(S) : null);
    audio.update(rawDt, S, cam, env);
  } else if (audio.ctx) audio.update(rawDt, S, cam, lastEnv);
  if (DEBUG) debugOverlay();
}

function adaptResolution(dt) {
  // Keep the frame rate up by trading resolution, never simulation.
  if (dt > 0.034) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
  if (dt < 0.018) fastFrames++; else fastFrames = 0;
  if (slowFrames > 45 && renderScale > 0.6) { renderScale = Math.max(0.6, renderScale - 0.1); slowFrames = 0; resize(); }
  if (fastFrames > 240 && renderScale < 1) { renderScale = Math.min(1, renderScale + 0.1); fastFrames = 0; resize(); }
}

function onEvents(events) {
  hud.handle(events, S);
  audio.handle(events, S);
  for (const e of events) {
    switch (e.type) {
      case 'hit': cam.shake = 1; burst(S.dog.x, S.dog.y + 0.4, S.dog.z, 14, [0.85, 0.8, 0.7], 0.12, 2.5, false); break;
      case 'taskDone': case 'rank': burst(S.dog.x, S.dog.y + 0.8, S.dog.z, 26, [1, 0.82, 0.3], 0.16, 2.2, true); break;
      case 'petted': burst(S.dog.x, S.dog.y + 1.0, S.dog.z, 6, [1, 0.45, 0.65], 0.18, 0.6, true); break;
      case 'say': {
        const b = S.bubbles[S.bubbles.length - 1];
        if (b && b.text === e.text) audio.speech(b.who);
        break;
      }
      case 'bark': barkRings.push({ x: S.dog.x, z: S.dog.z, y: S.dog.y, t: 0 }); break;
      case 'dayEnd':
        state = 'summary';
        persist();
        hud.showSummary(e.summary, () => { newDay(S); persist(); state = 'play'; last = performance.now(); });
        break;
      case 'drank': for (let i = 0; i < 6; i++) spawnP(S.dog.x + Math.sin(S.dog.yaw) * 0.6, S.dog.y + 0.05, S.dog.z + Math.cos(S.dog.yaw) * 0.6, (Math.random() - 0.5) * 0.8, 1 + Math.random(), (Math.random() - 0.5) * 0.8, 0.5, 0.07, [0.7, 0.85, 1], 0.7, false); break;
      default:
    }
  }
}

/* ------------------------------------------------------------ particles */

const parts = [];
const barkRings = [];
function spawnP(x, y, z, vx, vy, vz, life, size, color, alpha, glow, grav = 0) {
  if (parts.length > 900) return;
  parts.push({ x, y, z, vx, vy, vz, life, max: life, size, color, alpha, glow, grav });
}
function burst(x, y, z, n, color, size, speed, glow) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, u = Math.random() * 2 - 1;
    const s = speed * (0.4 + Math.random() * 0.6);
    spawnP(x, y, z, Math.cos(a) * Math.sqrt(1 - u * u) * s, Math.abs(u) * s + 0.6, Math.sin(a) * Math.sqrt(1 - u * u) * s, 0.7 + Math.random() * 0.5, size, color, 1, glow, 3);
  }
}

/* ---------------------------------------------------------------- draw */

let lastEnv = environment(6.5, 'clear');
const tmp3 = [0, 0, 0];
const rainSeed = makeRng(5);

function drawScene(dt, time) {
  const env = lastEnv = environment(S.clock.hours, S.weather);
  m4Mul(vp, proj, view);
  R.beginFrame();
  R.setCamera(view, proj, [cam.x, cam.y, cam.z]);
  const d = S.dog;
  const shadowsOn = profile.shadows && env.shadows;
  const near = (x, z, r) => dist2(x, z, cam.x, cam.z) < r * r;
  const vis = (x, y, z, r) => R.visible(x, y, z, r);

  /* the dog */
  const da = animOf(d);
  animateDog(da, d, dt);
  {
    const rig = rigs.dog;
    poseDog(rig, da, d.onGround === false ? 0 : d.speed);
    const b = R.batch('dog');
    const o = b.alloc();
    b.colors(o, DOG_COAT[0], DOG_COAT[1], DOG_COAT[2], S.collar ? COLLAR_RED : DOG_COAT[0]);
    rig.write(b.data, o + 16, d.x, d.ry, d.z, d.yaw, 1);
    // the carried thing sits in the jaws
    if (d.carry && models[itemModel(d.carry.kind)]) {
      rig.pointOn(2, 0, 0.625, 0.66, tmp3);
      itemInstance(d.carry.kind, tmp3[0], tmp3[1] - 0.02, tmp3[2], d.yaw + Math.PI / 2);
    }
    R.decal(d.x, d.ry + 0.02, d.z, 0.42, d.yaw, layout.uv['decal:soft'], 0, 0, 0, shadowsOn ? 0.28 : 0.45, 0, 1.7);
  }

  /* the other dogs */
  for (const q of S.dogs) {
    if (!near(q.x, q.z, 80) || !vis(q.x, 0.5, q.z, 1)) continue;
    const a = animOf(q);
    animateDog(a, q, dt);
    const rig = rigs.dog;
    poseDog(rig, a, q.speed);
    const b = R.batch('dog');
    const o = b.alloc();
    b.colors(o, q.coat[0], q.coat[1], q.coat[2], q.coat[0]);
    rig.write(b.data, o + 16, q.x, q.y || 0, q.z, q.yaw, q.scale);
    R.decal(q.x, (q.y || 0) + 0.02, q.z, 0.4 * q.scale, q.yaw, layout.uv['decal:soft'], 0, 0, 0, shadowsOn ? 0.22 : 0.4, 0, 1.7);
  }

  /* people */
  const pd = profile.peopleDist;
  for (const p of S.peds) {
    if (p.hidden) continue;
    const maxD = p.role === 'keeper' ? 42 : pd;
    if (!near(p.x, p.z, maxD) || !vis(p.x, 0.9, p.z, 1.1)) continue;
    const a = animOf(p);
    animateHuman(a, { speed: p.speed, mode: p.mode, look: p.look }, dt);
    const rig = rigs[p.kind] || rigs.man;
    poseHuman(rig, a, p.speed, p.mode);
    const b = R.batch(PEOPLE_KINDS.includes(p.kind) ? p.kind : 'man');
    const o = b.alloc();
    b.colors(o, p.colors[0], p.colors[1], p.colors[2], p.colors[3]);
    rig.write(b.data, o + 16, p.x, p.y || 0, p.z, p.yaw, p.scale);
    if (!shadowsOn && near(p.x, p.z, 35)) R.decal(p.x, (p.y || 0) + 0.02, p.z, 0.32 * p.scale, 0, layout.uv['decal:soft'], 0, 0, 0, 0.35, 0);
  }

  /* vehicles and whoever is riding them */
  const night = env.night;
  const headlights = [];
  for (const v of S.vehicles) {
    if (!near(v.x, v.z, profile.draw * 0.85)) continue;
    const r = v.len / 2 + 1;
    if (!vis(v.x, 1, v.z, r)) continue;
    const m = models[v.T.model];
    const rig = rigs[v.T.model];
    const crank = v.spin * 1.4;
    poseVehicle(rig, m, v.spin, v.steer, v.pitch, crank);
    const b = R.batch(v.T.model);
    const o = b.alloc();
    b.colors(o, v.colors[0], v.colors[1], v.colors[2], v.colors[3]);
    rig.write(b.data, o + 16, v.x, 0, v.z, v.yaw, 1);
    if (night > 0.3 && near(v.x, v.z, 45)) headlights.push(v);
    if (!near(v.x, v.z, pd)) continue;
    // riders
    const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
    for (const rd of v.riders) {
      const seat = rd.seat === 'driver' ? m.seats && m.seats.driver : m.seats && m.seats.back[Number(rd.seat.slice(4)) || 0];
      if (!seat) continue;
      const wx = v.x + cy * seat[0] + sy * seat[2], wz = v.z - sy * seat[0] + cy * seat[2];
      const ra = animOf(rd);
      animateHuman(ra, { speed: 0, mode: rd.pose, pedal: rd.pose === 'pedal' ? v.v : 0 }, dt);
      const hr = rigs[rd.kind] || rigs.man;
      poseHuman(hr, ra, 0, rd.pose);
      const hb = R.batch(PEOPLE_KINDS.includes(rd.kind) ? rd.kind : 'man');
      const ho = hb.alloc();
      hb.colors(ho, rd.colors[0], rd.colors[1], rd.colors[2], rd.colors[3]);
      hr.write(hb.data, ho + 16, wx, seat[1] - 0.53 * rd.scale, wz, v.yaw, rd.scale);
    }
    // exhaust from autos, buses and trucks
    if ((v.type === 'auto' || v.type === 'bus' || v.type === 'truck') && near(v.x, v.z, 40) && Math.random() < dt * (v.type === 'auto' ? 3 : 5)) {
      const bx = v.x - v.dirx * (v.len / 2 + 0.1), bz = v.z - v.dirz * (v.len / 2 + 0.1);
      spawnP(bx, 0.35, bz, -v.dirx * 0.4 + (Math.random() - 0.5) * 0.3, 0.35, -v.dirz * 0.4 + (Math.random() - 0.5) * 0.3, 1.6, 0.22, [0.55, 0.57, 0.6], 0.32, false);
    }
    if (!shadowsOn && near(v.x, v.z, 40)) R.decal(v.x, 0.02, v.z, v.halfW * 1.2, v.yaw + Math.PI / 2, layout.uv['decal:soft'], 0, 0, 0, 0.45, 0, v.len / (v.halfW * 2.4) * 0.5 + 0.5);
  }

  /* parked vehicles */
  for (const p of W.props) {
    if (p.type !== 'parked' || !near(p.x, p.z, 70) || !vis(p.x, 0.6, p.z, 1.6)) continue;
    const name = p.vtype === 'auto' ? 'auto' : p.vtype;
    const m = models[name];
    const rig = rigs[name];
    poseVehicle(rig, m, 0, 0, 0, 0);
    const b = R.batch(name);
    const o = b.alloc();
    const pal = PARKED[name] || PARKED.scooter;
    const c0 = pal[(p.color || 0) % pal.length];
    b.colors(o, c0, name === 'auto' ? AUTO_TOP : [1, 1, 1], [0.15, 0.15, 0.15], [1, 1, 1]);
    rig.write(b.data, o + 16, p.x, groundY(p.x, p.z), p.z, p.yaw, 1);
  }

  /* cows and goats */
  for (const c of S.cows) {
    if (!near(c.x, c.z, 110) || !vis(c.x, 1, c.z, 1.6)) continue;
    const a = animOf(c);
    animateQuad(a, c, dt);
    poseQuad(rigs.cow, a, c.speed);
    const b = R.batch('cow');
    const o = b.alloc();
    b.colors(o, c.colors[0], c.colors[1], c.colors[2], c.colors[3]);
    rigs.cow.write(b.data, o + 16, c.x, c.y || 0, c.z, c.yaw, 1);
    if (!shadowsOn && near(c.x, c.z, 40)) R.decal(c.x, (c.y || 0) + 0.02, c.z, 0.55, c.yaw, layout.uv['decal:soft'], 0, 0, 0, 0.4, 0, 2);
  }
  for (const g of S.goats) {
    if (!near(g.x, g.z, 80) || !vis(g.x, 0.5, g.z, 1)) continue;
    const a = animOf(g);
    animateQuad(a, g, dt, 0.7);
    poseQuad(rigs.goat, a, g.speed);
    const b = R.batch('goat');
    const o = b.alloc();
    b.colors(o, g.colors[0], g.colors[1], g.colors[2], g.colors[3]);
    rigs.goat.write(b.data, o + 16, g.x, 0.03, g.z, g.yaw, 0.55);
  }

  /* birds */
  for (const bd of S.birds) {
    if (!near(bd.x, bd.z, 70) || !vis(bd.x, bd.y, bd.z, 0.5)) continue;
    const a = animOf(bd);
    a.t += dt;
    poseBird(rigs.bird, a, bd);
    const b = R.batch('bird');
    const o = b.alloc();
    b.colors(o, bd.colors[0], bd.colors[1], bd.colors[2], bd.colors[3]);
    rigs.bird.write(b.data, o + 16, bd.x, bd.y, bd.z, bd.yaw, 1);
  }

  /* things on the ground */
  for (const it of S.items) {
    if (it.state === 'carried' || !near(it.x, it.z, 50)) continue;
    itemInstance(it.kind, it.x, it.y + (it.kind === 'ball' ? 0.036 : 0), it.z, it.yaw || 0);
  }

  /* decals: puddles, the task marker, bark rings */
  for (const p of W.props) if (p.type === 'puddle' && near(p.x, p.z, 60)) R.decal(p.x, groundY(p.x, p.z) + 0.012, p.z, p.r, p.x, layout.uv['decal:puddle'], 1, 1, 1, 0.92, 1);
  if (S.weather === 'rain') rainPuddles();
  const tt = taskSpot();
  if (tt && near(tt.x, tt.z, 45)) {
    const pulse = 0.85 + 0.25 * Math.sin(time * 4);
    R.decal(tt.x, groundY(tt.x, tt.z) + 0.03, tt.z, 1.1 * pulse, time, layout.uv['decal:ring'], 1, 0.82, 0.25, 0.85, 2);
  }
  for (let i = barkRings.length - 1; i >= 0; i--) {
    const r = barkRings[i];
    r.t += dt;
    if (r.t > 0.6) { barkRings.splice(i, 1); continue; }
    R.decal(r.x, r.y + 0.03, r.z, 0.6 + r.t * 9, 0, layout.uv['decal:ring'], 1, 1, 1, (1 - r.t / 0.6) * 0.5, 2);
  }

  /* particles */
  scentTrails(time);
  ambientParticles(dt, time, env);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    p.vy -= p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const f = p.life / p.max;
    R.particle(p.x, p.y, p.z, p.size * (p.glow ? 1 : 1.6 - f * 0.6), p.color[0], p.color[1], p.color[2], p.alpha * Math.min(1, f * 2), p.glow);
  }

  /* lights: the nearest lamps, and headlights near the dog */
  const L = [];
  if (env.lampLevel > 0.02) {
    const cands = [];
    for (const l of W.lights) {
      const q = dist2(l.x, l.z, cam.tx, cam.tz);
      if (q < 48 * 48) cands.push([q, l]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(6, cands.length); i++) {
      const l = cands[i][1];
      L.push({ x: l.x, y: l.y, z: l.z, r: l.r, color: l.color, i: (l.kind === 'shop' ? 1.4 : 2.4) * env.lampLevel });
    }
    // glow sprites on every lamp in view
    for (const l of W.lights) {
      if (!near(l.x, l.z, 90)) continue;
      const s = l.kind === 'sodium' ? 1.5 : l.kind === 'shop' ? 0 : l.kind === 'tower' ? 3 : 0.9;
      if (s > 0) R.particle(l.x, l.y, l.z, s, l.color[0] * 0.55 * env.lampLevel, l.color[1] * 0.45 * env.lampLevel, l.color[2] * 0.3 * env.lampLevel, 1, true);
    }
  }
  headlights.sort((a, b) => dist2(a.x, a.z, d.x, d.z) - dist2(b.x, b.z, d.x, d.z));
  for (let i = 0; i < Math.min(2, headlights.length); i++) {
    const v = headlights[i];
    L.push({ x: v.x + v.dirx * (v.len / 2 + 3), y: 1.0, z: v.z + v.dirz * (v.len / 2 + 3), r: 9, color: [1, 0.95, 0.8], i: 2.2 * night });
  }
  for (const v of headlights) {
    const hx = v.x + v.dirx * (v.len / 2 + 0.05), hz = v.z + v.dirz * (v.len / 2 + 0.05);
    R.particle(hx, 0.85, hz, 0.9, 0.6 * night, 0.58 * night, 0.45 * night, 1, true);
  }
  R.setLights(L);

  /* shadows follow a point a little ahead of the camera's gaze */
  const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
  R.computeShadow(env.sunDir, d.x + fx * 10, d.z + fz * 10);
  const F = Object.assign({}, env, {
    time,
    shadows: shadowsOn,
    drawDistance: profile.draw,
    sniff: S.sniff ? Math.min(1, S.sniff.t * 2, (S.C.dog.sniffDuration - S.sniff.t) * 4) : 0,
  });
  const tg = performance.now();
  R.render(F);
  timing.gl = lerp(timing.gl, performance.now() - tg, 0.1);
}

const PARKED = {
  scooter: ['#c62828', '#f2f2f2', '#212121', '#1565c0', '#8e8e8e', '#6d1b2b', '#00796b', '#f9a825'].map(hex),
  bike: ['#212121', '#c62828', '#1565c0', '#2e2e2e'].map(hex),
  cycle: ['#111111', '#2b2b2b', '#5b1f1f'].map(hex),
  auto: ['#2e9e4f', '#2a8f47', '#151515'].map(hex),
};
const AUTO_TOP = hex('#f5c518');

function groundY(x, z) { return groundAt(S, x, z, 0.5); }

function itemModel(kind) {
  if (kind === 'milk') return 'bowl';
  if (kind === 'scraps') return 'roti';
  return kind;
}

function itemInstance(kind, x, y, z, yaw) {
  const name = itemModel(kind);
  const m = models[name];
  if (!m) return;
  const b = R.batch(name);
  const o = b.alloc();
  const c = [1, 1, 1];
  b.colors(o, c, c, c, c);
  const rig = rigs[name];
  rig.reset();
  rig.write(b.data, o + 16, x, y, z, yaw, kind === 'scraps' ? 0.7 : 1);
}

function taskSpot() {
  // the next task with a place, the same one the minimap and arrow point at
  for (const t of S.tasks) {
    if (t.done || !t.def.where) continue;
    const w = t.def.where(S);
    if (w && Number.isFinite(w.x)) return w;
  }
  return null;
}

const SCENT = { food: [1, 0.62, 0.2], water: [0.35, 0.8, 1], task: [1, 0.85, 0.25], friend: [1, 0.45, 0.75] };
function scentTrails(time) {
  if (!S.sniff) return;
  const fade = Math.min(1, S.sniff.t / 1.2);
  for (const tr of S.sniff.trails) {
    const col = SCENT[tr.kind] || SCENT.food;
    let acc = 0;
    const spacing = 1.1;
    const phase = (time * 2.4) % spacing;
    let drawn = 0;
    for (let i = 0; i + 1 < tr.pts.length && drawn < 60; i++) {
      const [ax, az] = tr.pts[i], [bx, bz] = tr.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      let s = (spacing - ((acc - phase) % spacing + spacing) % spacing);
      while (s < len && drawn < 60) {
        const x = ax + (bx - ax) * (s / len), z = az + (bz - az) * (s / len);
        const wob = Math.sin(time * 3 + x * 1.7 + z) * 0.08;
        R.particle(x + wob, groundY(x, z) + 0.35 + Math.sin(time * 2 + s) * 0.06, z - wob, 0.28, col[0] * fade, col[1] * fade, col[2] * fade, 1, true);
        s += spacing;
        drawn++;
      }
      acc += len;
    }
    // the destination glows
    R.particle(tr.x, groundY(tr.x, tr.z) + 0.6, tr.z, 1.4, col[0] * fade * 0.8, col[1] * fade * 0.8, col[2] * fade * 0.8, 1, true);
  }
}

let dustT = 0, steamT = 0;
function ambientParticles(dt, time, env) {
  const d = S.dog;
  // dust kicked up by a running dog
  dustT -= dt;
  if (d.speed > 4.5 && d.onGround && dustT <= 0) {
    dustT = 0.05;
    spawnP(d.x - Math.sin(d.yaw) * 0.4, d.ry + 0.05, d.z - Math.cos(d.yaw) * 0.4, (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.3, (Math.random() - 0.5) * 0.6, 0.7, 0.18, [0.62, 0.55, 0.44], 0.35, false);
  }
  // steam off the chai kettle
  const ch = W.special.chai;
  steamT -= dt;
  if (ch && steamT <= 0 && dist2(ch.x, ch.z, cam.x, cam.z) < 40 * 40) {
    steamT = 0.12;
    spawnP(ch.x - 0.3 * Math.sin(Math.PI), 1.45, ch.z, (Math.random() - 0.5) * 0.1, 0.5 + Math.random() * 0.2, (Math.random() - 0.5) * 0.1, 1.8, 0.12, [0.95, 0.95, 0.95], 0.35, false);
  }
  // rain falling around the camera
  if (env.rain) {
    for (let i = 0; i < 70; i++) {
      const x = cam.x + (rainSeed() - 0.5) * 24, z = cam.z + (rainSeed() - 0.5) * 24;
      const y = cam.y + (rainSeed() - 0.3) * 9;
      R.particle(x, y, z, 0.05, 0.75, 0.8, 0.9, 0.55, false);
    }
  }
  // dust motes in the sun
  if (!env.rain && env.sunUp && Math.random() < dt * 8) {
    spawnP(cam.tx + (Math.random() - 0.5) * 8, cam.ty + Math.random() * 2, cam.tz + (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 0.1, 0.03, (Math.random() - 0.5) * 0.1, 4, 0.03, [1, 0.95, 0.8], 0.6, true);
  }
}

function rainPuddles() {
  // every pothole fills up: a deterministic scatter of extra puddles on the roads near the camera
  const rng = makeRng(77);
  for (let i = 0; i < 70; i++) {
    const onMg = i % 2 === 0;
    const x = onMg ? rng() * 170 - 85 : rng() * 7 - 3.5;
    const z = onMg ? rng() * 12 - 6 : rng() * 170 - 85;
    const r = 0.6 + rng() * 1.2;
    if (dist2(x, z, cam.x, cam.z) > 55 * 55) continue;
    R.decal(x, 0.012, z, r, rng() * 6, layout.uv['decal:puddle'], 1, 1, 1, 0.9, 1);
  }
}

/* ----------------------------------------------------------------- debug */

function debugOverlay() {
  const el = document.getElementById('debug');
  el.style.display = 'block';
  const st = R.stats;
  el.textContent = `fps ${fps.toFixed(0)}  scale ${renderScale.toFixed(2)}  ${canvas.width}x${canvas.height}
sim ${timing.sim.toFixed(1)}ms  scene ${(timing.draw - timing.gl).toFixed(1)}ms  gl ${timing.gl.toFixed(1)}ms
draws ${st.drawCalls}  chunks ${st.chunks}  tris ${(st.tris / 1000).toFixed(0)}k  inst ${st.instances}
peds ${S.peds.length}  veh ${S.vehicles.length}  items ${S.items.length}
dog ${S.dog.x.toFixed(1)}, ${S.dog.z.toFixed(1)}  ${S.dog.pose}  ${S.dog.zone}
${S.clock.hours.toFixed(2)}h  ${S.weather}  q:${profile.name}`;
}

/* --------------------------------------------------------- service worker */

function registerSW() {
  try {
    const h = location.hostname;
    const secure = location.protocol === 'https:' || h === 'localhost' || h === '127.0.0.1';
    if (!secure || !('serviceWorker' in navigator) || window.top !== window.self) return;
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  } catch (e) { /* sandboxed frames refuse; play on */ }
}

boot().catch(fail);
