/*
 * cityMesh.js — the world's static geometry, built once at load.
 *
 * Everything that never moves is merged into ~64 chunk meshes (25 m squares) so
 * the renderer can cull and draw the whole neighbourhood in a few dozen calls.
 * What lies beyond the grid — the hazy skyline, the roads running off into it —
 * goes into one `far` mesh that is always drawn.
 *
 * Buildings are built in a FACADE FRAME: x runs along the street face from the
 * left end as a pedestrian sees it, z points out of the face (the building
 * occupies z in [-depth, 0]), y is up. One transform per building then puts it
 * on its lot, whichever way it faces.
 *
 * Pure: no DOM, no GL. The atlas UVs come in from textures.atlasLayout().
 */

import { MeshBuilder, hangingLine } from './geom.js';
import {
  GRID, SURF, SURF_HEIGHT, LAYOUT, PLAY_HALF, WATER_Y, cellCenter, facadeWidth, zebraRects, cellOf,
} from './world.js';
import { hex, makeRng, rand, pick, chance, TAU, clamp, mixRgb, scaleRgb, jitterRgb } from './util.js';
import { SHOP_TYPES, WALL_ADS } from './data.js';

const CH = 25;
const NCH = Math.ceil((2 * GRID.half) / CH);
const N = GRID.n, RES = GRID.res, HALF = GRID.half;

const C = {
  asphalt: hex('#4a4a50'),
  walk: hex('#a39783'),
  gali: hex('#968d7e'),
  plaza: hex('#ab9c80'),
  dirt: hex('#a4835a'),
  market: hex('#91856e'),
  kerb: hex('#8e8a82'),
  white: hex('#f2f0ea'),
  yellow: hex('#f2c230'),
  black: hex('#202020'),
  roof: hex('#a8a39a'),
  glass: hex('#26313a'),
  wood: hex('#7a5230'),
  darkWood: hex('#4e3420'),
  concrete: hex('#b9b4aa'),
  metal: hex('#6d7277'),
  rust: hex('#7b4a2c'),
  tank: hex('#1c1c1e'),
  grass: hex('#6f9a3e'),
  interior: [hex('#d9e8d6'), hex('#d6e2ef'), hex('#efe4c8'), hex('#f0d5d5'), hex('#e8e8e8')],
  produce: {
    veg: ['#d62828', '#9b4a6a', '#b08a5a', '#3d7a2f', '#5d8f3a', '#4b2a5a', '#e67e22', '#f1ecd9'],
    fruit: ['#f39c12', '#c0392b', '#f6b93b', '#a4161a', '#7cb342', '#f4d03f'],
    banana: ['#f1c40f', '#e5b80b', '#7cb342'],
    coconut: ['#5a7d2a', '#6b8e23', '#4e6b1f'],
    flower: ['#ff8f00', '#ffb300', '#ff6f00', '#fff176', '#e53935'],
  },
};
C.ballast = hex('#77706a');
C.mud = hex('#4b4232');
C.water = hex('#363a2f');
const SURF_COLOR = {
  [SURF.ROAD]: C.asphalt, [SURF.CROSS]: C.asphalt, [SURF.WALK]: C.walk, [SURF.GALI]: C.gali,
  [SURF.PLAZA]: C.plaza, [SURF.DIRT]: C.dirt, [SURF.MARKET]: C.market, [SURF.RAIL]: C.ballast,
  [SURF.RIVER]: C.mud, [SURF.BANK]: hex('#5a4d3a'), [SURF.BEYOND]: hex('#a89a80'),
};
const SURF_DETAIL = {
  [SURF.ROAD]: 1, [SURF.CROSS]: 1, [SURF.WALK]: 0.8, [SURF.GALI]: 0.9, [SURF.PLAZA]: 0.7, [SURF.DIRT]: 1, [SURF.MARKET]: 1, [SURF.RAIL]: 1, [SURF.RIVER]: 1, [SURF.BANK]: 1, [SURF.BEYOND]: 0.7,
};

/* ------------------------------------------------------------------ chunks */

class Chunks {
  constructor() {
    this.list = [];
    this.grid = new Array(NCH * NCH).fill(null);
    this.far = new MeshBuilder();
  }
  at(x, z) {
    if (Math.abs(x) > HALF || Math.abs(z) > HALF) return this.far;
    const i = clamp(Math.floor((x + HALF) / CH), 0, NCH - 1);
    const j = clamp(Math.floor((z + HALF) / CH), 0, NCH - 1);
    const k = j * NCH + i;
    if (!this.grid[k]) {
      this.grid[k] = { b: new MeshBuilder(), i, j };
      this.list.push(this.grid[k]);
    }
    return this.grid[k].b;
  }
}

export function buildCity(W, atlas) {
  const uv = atlas.uv;
  const rng = makeRng(W.seed * 7919 + 3);
  const ch = new Chunks();
  const ctx = { W, uv, rng, ch };

  // triangle budget per phase, kept so tests and the debug overlay can see it
  const stats = {};
  const tris = () => ch.list.reduce((n, c) => n + c.b.idx.length / 3, 0) + ch.far.idx.length / 3;
  const phase = (name, fn) => { const t0 = tris(); fn(); stats[name] = tris() - t0; };
  phase('ground', () => buildGround(ctx));
  phase('chowk', () => buildChowk(ctx));
  phase('markings', () => buildMarkings(ctx));
  phase('buildings', () => { for (const b of W.buildings) buildBuilding(ctx, b); });
  phase('props', () => { for (const p of W.props) buildProp(ctx, p); });
  phase('wires', () => buildWires(ctx));
  phase('river', () => buildRiver(ctx));
  phase('skyline', () => buildSkyline(ctx));

  const chunks = [];
  for (const c of ch.list) {
    if (!c.b.vertexCount) continue;
    const mesh = c.b.build();
    chunks.push({ mesh, i: c.i, j: c.j, cx: -HALF + (c.i + 0.5) * CH, cz: -HALF + (c.j + 0.5) * CH });
  }
  return { chunks, far: ch.far.build(), chunkSize: CH, stats };
}

/* ------------------------------------------------------------------ ground */

const inChowk = (x, z) => Math.abs(x) <= LAYOUT.chowkSq && Math.abs(z) <= LAYOUT.chowkSq;

function buildGround(ctx) {
  const { W, ch, uv } = ctx;
  const surf = W.surf;
  const height = (i, j) => {
    if (i < 0 || j < 0 || i >= N || j >= N) return 0;
    const s = surf[j * N + i];
    if (s === SURF.BUILDING || s === SURF.MASS) return 99; // a wall stands there; no kerb face needed
    return SURF_HEIGHT[s];
  };
  const cells = CH / RES;
  for (let cj = 0; cj < NCH; cj++) {
    for (let ci = 0; ci < NCH; ci++) {
      const i0 = ci * cells, j0 = cj * cells;
      const i1 = Math.min(N, i0 + cells), j1 = Math.min(N, j0 + cells);
      const done = new Uint8Array(cells * cells);
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const li = (j - j0) * cells + (i - i0);
          if (done[li]) continue;
          const s = surf[j * N + i];
          if (!(s in SURF_COLOR)) { done[li] = 1; continue; }
          if (inChowk(cellCenter(i), cellCenter(j))) { done[li] = 1; continue; }
          const same = (ii, jj) => {
            const l = (jj - j0) * cells + (ii - i0);
            const ss = surf[jj * N + ii];
            const norm = (q) => (q === SURF.CROSS ? SURF.ROAD : q);
            return !done[l] && norm(ss) === norm(s) && !inChowk(cellCenter(ii), cellCenter(jj));
          };
          let w = 1;
          while (i + w < i1 && same(i + w, j)) w++;
          let h = 1;
          outer: while (j + h < j1) {
            for (let q = 0; q < w; q++) if (!same(i + q, j + h)) break outer;
            h++;
          }
          for (let jj = j; jj < j + h; jj++) for (let ii = i; ii < i + w; ii++) done[(jj - j0) * cells + (ii - i0)] = 1;
          const x0 = -HALF + i * RES, z0 = -HALF + j * RES, x1 = x0 + w * RES, z1 = z0 + h * RES;
          const y = SURF_HEIGHT[s];
          const b = ch.at((x0 + x1) / 2, (z0 + z1) / 2);
          b.uv(uv.white).color(SURF_COLOR[s]).detail(SURF_DETAIL[s]).bone(0).slot(0).emissive(0);
          b.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]);
          if (y > 0.001) kerbFaces(b, i, j, w, h, y, height, s);
        }
      }
    }
  }
  // A wide plain beneath it all, so nothing ever shows sky through a crack; it
  // drops under the river, which lies below the street.
  const RV = LAYOUT.river;
  ctx.ch.far.uv(uv.white).color(hex('#9c8a6c')).detail(1);
  ctx.ch.far.quad([-700, -0.03, RV.step], [700, -0.03, RV.step], [700, -0.03, -700], [-700, -0.03, -700]);
  ctx.ch.far.quad([-700, -0.03, 700], [700, -0.03, 700], [700, -0.03, RV.far], [-700, -0.03, RV.far]);
  ctx.ch.far.color(C.mud).quad([-700, -0.6, RV.far], [700, -0.6, RV.far], [700, -0.6, RV.step], [-700, -0.6, RV.step]);
  // The roads run on into the haze.
  const far = ctx.ch.far;
  far.color(C.asphalt).detail(1);
  for (const sgn of [-1, 1]) {
    far.quad([sgn > 0 ? 100 : -420, 0, LAYOUT.mgHalf], [sgn > 0 ? 420 : -100, 0, LAYOUT.mgHalf], [sgn > 0 ? 420 : -100, 0, -LAYOUT.mgHalf], [sgn > 0 ? 100 : -420, 0, -LAYOUT.mgHalf]);
    far.quad([-LAYOUT.bzHalf, 0, sgn > 0 ? 420 : -100], [LAYOUT.bzHalf, 0, sgn > 0 ? 420 : -100], [LAYOUT.bzHalf, 0, sgn > 0 ? 100 : -420], [-LAYOUT.bzHalf, 0, sgn > 0 ? 100 : -420]);
  }
  // ...and so does the railway, ballast and rails (the sleepers stop where the haze starts)
  const R = LAYOUT.rail;
  for (const sgn of [-1, 1]) {
    const xa = sgn > 0 ? 100 : -480, xb = sgn > 0 ? 480 : -100;
    far.color(C.ballast).detail(1).box(xa, -0.03, R.z0, xb, SURF_HEIGHT[SURF.RAIL], R.z1, { skip: 'b' });
    const ra = sgn > 0 ? 170 : -480, rb = sgn > 0 ? 480 : -170;
    for (const T of R.tracks) for (const s of [-1, 1]) railBar(far, ra, rb, T.z + s * R.gauge / 2, SLEEPER_TOP);
  }
  far.color(C.walk).detail(0.8);
  for (const sgn of [-1, 1]) {
    for (const side of [-1, 1]) {
      const za = side * LAYOUT.mgHalf, zb = side * LAYOUT.mgWalk;
      const xa = sgn > 0 ? 100 : -420, xb = sgn > 0 ? 420 : -100;
      far.quad([xa, 0.18, Math.max(za, zb)], [xb, 0.18, Math.max(za, zb)], [xb, 0.18, Math.min(za, zb)], [xa, 0.18, Math.min(za, zb)]);
      const xa2 = side * LAYOUT.bzHalf, xb2 = side * LAYOUT.bzWalk;
      const zs = sgn > 0 ? 100 : -420, ze = sgn > 0 ? 420 : -100;
      far.quad([Math.min(xa2, xb2), 0.18, ze], [Math.max(xa2, xb2), 0.18, ze], [Math.max(xa2, xb2), 0.18, zs], [Math.min(xa2, xb2), 0.18, zs]);
    }
  }
}

/** Vertical faces where this raised rect meets lower ground. MG Road kerbs are painted. */
function kerbFaces(b, i, j, w, h, y, height, s) {
  const x0 = -HALF + i * RES, z0 = -HALF + j * RES, x1 = x0 + w * RES, z1 = z0 + h * RES;
  const run = (n, getNeighbour, emit) => {
    let start = -1, lowH = 0;
    for (let k = 0; k <= n; k++) {
      const nh = k < n ? getNeighbour(k) : 99;
      const low = nh < y - 0.005;
      if (low && start < 0) { start = k; lowH = nh; }
      else if (start >= 0 && (!low || Math.abs(nh - lowH) > 0.005)) {
        emit(start, k, lowH);
        start = low ? k : -1;
        lowH = nh;
      }
    }
  };
  const paint = (a0, a1, along) => {
    // black-and-white kerb stones every metre along the big roads
    const stripes = s === SURF.WALK;
    if (!stripes) { along(a0, a1, C.kerb); return; }
    for (let t = a0; t < a1 - 1e-6;) {
      const t1 = Math.min(a1, Math.floor(t + 1e-6) + 1);
      along(t, t1, Math.floor(t + 1e-6) % 2 === 0 ? C.white : C.black);
      t = t1;
    }
  };
  // north edge (z0), face points -z
  run(w, (k) => height(i + k, j - 1), (k0, k1, lh) => paint(x0 + k0 * RES, x0 + k1 * RES, (a, c, col) => { b.color(col).detail(0.6); b.quad([c, lh, z0], [a, lh, z0], [a, y, z0], [c, y, z0]); }));
  // south edge (z1), face points +z
  run(w, (k) => height(i + k, j + h), (k0, k1, lh) => paint(x0 + k0 * RES, x0 + k1 * RES, (a, c, col) => { b.color(col).detail(0.6); b.quad([a, lh, z1], [c, lh, z1], [c, y, z1], [a, y, z1]); }));
  // west edge (x0), face points -x
  run(h, (k) => height(i - 1, j + k), (k0, k1, lh) => paint(z0 + k0 * RES, z0 + k1 * RES, (a, c, col) => { b.color(col).detail(0.6); b.quad([x0, lh, a], [x0, lh, c], [x0, y, c], [x0, y, a]); }));
  // east edge (x1), face points +x
  run(h, (k) => height(i + w, j + k), (k0, k1, lh) => paint(z0 + k0 * RES, z0 + k1 * RES, (a, c, col) => { b.color(col).detail(0.6); b.quad([x1, lh, c], [x1, lh, a], [x1, y, a], [x1, y, c]); }));
}

/* ------------------------------------------------------------------- chowk */

function buildChowk(ctx) {
  const { ch, uv } = ctx;
  const S = LAYOUT.chowkSq, R = LAYOUT.ringOut, I = LAYOUT.ringIn;
  const y = 0.18;
  // asphalt under the whole square, in four pieces so each lands in its own chunk
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const b = ch.at(sx * 4, sz * 4);
    b.uv(uv.white).detail(1).color(C.asphalt);
    const xa = Math.min(0, sx * S), xb = Math.max(0, sx * S), za = Math.min(0, sz * S), zb = Math.max(0, sz * S);
    b.quad([xa, 0, zb], [xb, 0, zb], [xb, 0, za], [xa, 0, za]);
  }
  // four raised corner plazas, cut by the ring
  const { bzHalf, mgHalf } = LAYOUT;
  for (const [sx, sz] of [[1, -1], [-1, -1], [-1, 1], [1, 1]]) {
    const b = ch.at(sx * 10, sz * 10);
    b.uv(uv.white).detail(0.7).color(C.plaza);
    const a0 = Math.atan2(sz * Math.sqrt(R * R - bzHalf * bzHalf), sx * bzHalf);
    const a1 = Math.atan2(sz * mgHalf, sx * Math.sqrt(R * R - mgHalf * mgHalf));
    const steps = 10;
    const arc = [];
    for (let k = 0; k <= steps; k++) {
      const a = a0 + angDelta(a0, a1) * (k / steps);
      arc.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    const poly = [[sx * bzHalf, sz * S], ...arc, [sx * S, sz * mgHalf], [sx * S, sz * S]];
    const corner = [sx * S, sz * S];
    // the polygon winds one way or the other depending on the quadrant; fan it and fix the facing
    for (let k = 0; k < poly.length - 2; k++) {
      const p = poly[k], q = poly[k + 1];
      if ((p[0] === corner[0] && p[1] === corner[1]) || (q[0] === corner[0] && q[1] === corner[1])) continue;
      triUp(b, [corner[0], y, corner[1]], [p[0], y, p[1]], [q[0], y, q[1]]);
    }
    // kerb faces: bazaar edge, the arc, MG edge
    b.color(C.kerb).detail(0.5);
    for (let k = 0; k < poly.length - 2; k++) {
      const p = poly[k], q = poly[k + 1];
      wallDown(b, p, q, 0, y);
    }
  }
  // the island: a raised round garden with a black-and-yellow kerb
  const bi = ch.at(1, 1);
  const segs = 28;
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * TAU, c = ((k + 1) / segs) * TAU;
    bi.color(k % 2 ? C.black : C.yellow).detail(0.3);
    bi.quad([Math.cos(c) * I, 0, Math.sin(c) * I], [Math.cos(a) * I, 0, Math.sin(a) * I], [Math.cos(a) * I, 0.45, Math.sin(a) * I], [Math.cos(c) * I, 0.45, Math.sin(c) * I]);
    bi.color(C.grass).detail(1);
    bi.tri([0, 0.45, 0], [Math.cos(c) * I, 0.45, Math.sin(c) * I], [Math.cos(a) * I, 0.45, Math.sin(a) * I]);
  }
  // marigold beds around the tower
  const rng = makeRng(31);
  for (let k = 0; k < 22; k++) {
    const a = (k / 22) * TAU, r = 3.2 + rng() * 1.0;
    bi.color(pick(rng, [hex('#ff8f00'), hex('#ffb300'), hex('#e53935'), hex('#fff176')])).detail(0).sway(0.2);
    bi.sphere(Math.cos(a) * r, 0.55, Math.sin(a) * r, 0.22 + rng() * 0.1, 0, 0.6);
  }
  bi.sway(0);
}

function angDelta(a0, a1) {
  let d = a1 - a0;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

/** Triangle that always faces up, whatever order the points came in. */
function triUp(b, p, q, r) {
  const ux = q[0] - p[0], uz = q[2] - p[2], vx = r[0] - p[0], vz = r[2] - p[2];
  const ny = uz * vx - ux * vz;
  if (ny >= 0) b.tri(p, q, r); else b.tri(p, r, q);
}

/** A vertical face between two ground points, facing away from the origin (outward from the chowk centre side is inward... pick the side that faces the lower ground). */
function wallDown(b, p, q, y0, y1) {
  // Face toward the chowk centre for arc segments; the straight edges face the road too.
  const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
  const nx = -(q[1] - p[1]), nz = q[0] - p[0];
  const toward = -(mx * nx + mz * nz) > 0; // does (nx,nz) point toward the origin?
  const A = toward ? p : q, B2 = toward ? q : p;
  b.quad([A[0], y0, A[1]], [B2[0], y0, B2[1]], [B2[0], y1, B2[1]], [A[0], y1, A[1]]);
}

/* ---------------------------------------------------------------- markings */

function buildMarkings(ctx) {
  const { ch, uv, rng } = ctx;
  const y = 0.012;
  const stripe = (x0, z0, x1, z1, col) => {
    const b = ch.at((x0 + x1) / 2, (z0 + z1) / 2);
    b.uv(uv.white).color(col).detail(0.6);
    b.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]);
  };
  const { mgLane, mgHalf } = LAYOUT;
  // MG Road: lane dashes and edge lines
  for (const sgn of [-1, 1]) {
    for (let x = 18; x < 100; x += 9) {
      const xs = sgn * x;
      stripe(Math.min(xs, xs + sgn * 3), -mgLane - 0.06, Math.max(xs, xs + sgn * 3), -mgLane + 0.06, C.white);
      stripe(Math.min(xs, xs + sgn * 3), mgLane - 0.06, Math.max(xs, xs + sgn * 3), mgLane + 0.06, C.white);
    }
    const xa = sgn > 0 ? 17 : -100, xb = sgn > 0 ? 100 : -17;
    stripe(xa, -mgHalf + 0.25, xb, -mgHalf + 0.37, C.white);
    stripe(xa, mgHalf - 0.37, xb, mgHalf - 0.25, C.white);
  }
  // Bazaar Road: a faded centre line
  for (const sgn of [-1, 1]) {
    for (let z = 18; z < 100; z += 7) stripe(-0.07, Math.min(sgn * z, sgn * (z + 2.5)), 0.07, Math.max(sgn * z, sgn * (z + 2.5)), C.yellow);
  }
  // Zebra crossings
  for (const r of zebraRects()) {
    const alongX = r[2] - r[0] < r[3] - r[1]; // stripes run along the road
    if (alongX) {
      for (let z = r[1] + 0.3; z < r[3] - 0.3; z += 1.0) stripe(r[0] + 0.2, z, r[2] - 0.2, z + 0.5, C.white);
    } else {
      for (let x = r[0] + 0.3; x < r[2] - 0.3; x += 1.0) stripe(x, r[1] + 0.2, x + 0.5, r[3] - 0.2, C.white);
    }
  }
  // Speed breakers on the bazaar, black and yellow
  for (const z of [-40, 40]) {
    const b = ch.at(0, z);
    for (let x = -4.5; x < 4.5; x += 0.75) {
      b.color(Math.round((x + 4.5) / 0.75) % 2 ? C.black : C.yellow).detail(0.4);
      b.taper(x + 0.375, 0, z, 0.75, 1.2, 0.07, 0.75, 0.5);
    }
  }
  // manholes and patched asphalt
  for (let k = 0; k < 26; k++) {
    const onMg = k % 2 === 0;
    const x = onMg ? rand(rng, -95, 95) : rand(rng, -3.5, 3.5);
    const z = onMg ? rand(rng, -6, 6) : rand(rng, -95, 95);
    if (Math.abs(x) < 18 && Math.abs(z) < 18) continue;
    const b = ch.at(x, z);
    if (k % 3 === 0) {
      b.color(hex('#3c3c40')).detail(0.8).cyl(x, 0, z, 0.38, 0.015, 0.38, 10, { caps: 't' });
    } else {
      b.color(hex('#45454a')).detail(1).taper(x, 0, z, rand(rng, 1, 3), rand(rng, 0.8, 2), 0.01, rand(rng, 1, 3), rand(rng, 0.8, 2), 0, { skip: 'b' });
    }
  }
}

/* --------------------------------------------------------------- buildings */

function facadeFrame(b) {
  const w = facadeWidth(b);
  const d = b.face === 'N' || b.face === 'S' ? b.z1 - b.z0 : b.x1 - b.x0;
  switch (b.face) {
    case 'S': return { ox: b.x0, oz: b.z1, yaw: 0, w, d };
    case 'N': return { ox: b.x1, oz: b.z0, yaw: Math.PI, w, d };
    case 'E': return { ox: b.x1, oz: b.z1, yaw: Math.PI / 2, w, d };
    default: return { ox: b.x0, oz: b.z0, yaw: -Math.PI / 2, w, d };
  }
}

/** Is the ground just outside this building's face open (so the face is seen)? */
function exposed(W, b, side) {
  const pts = [];
  const o = 0.4;
  for (let t = 0.15; t < 0.9; t += 0.2) {
    if (side === 'S') pts.push([b.x0 + (b.x1 - b.x0) * t, b.z1 + o]);
    if (side === 'N') pts.push([b.x0 + (b.x1 - b.x0) * t, b.z0 - o]);
    if (side === 'E') pts.push([b.x1 + o, b.z0 + (b.z1 - b.z0) * t]);
    if (side === 'W') pts.push([b.x0 - o, b.z0 + (b.z1 - b.z0) * t]);
  }
  let open = 0;
  for (const [x, z] of pts) {
    const i = cellOf(x), j = cellOf(z);
    if (i < 0 || j < 0 || i >= N || j >= N) { open++; continue; }
    const s = W.surf[j * N + i];
    if (s !== SURF.BUILDING && s !== SURF.MASS) open++;
    else {
      // a much shorter neighbour also leaves this face on show above it
      const id = W.claim[j * N + i];
      if (id >= 0 && W.buildings[id].h < b.h - 2.5) open++;
    }
  }
  return open >= 2;
}

/** Side letters in facade frame terms: which world side is the frame's left/right/back. */
function frameSides(face) {
  // [left, right, back] as world sides
  switch (face) {
    case 'S': return ['W', 'E', 'N'];
    case 'N': return ['E', 'W', 'S'];
    case 'E': return ['S', 'N', 'W'];
    default: return ['N', 'S', 'E'];
  }
}

function buildBuilding(ctx, b) {
  const { W, ch, uv } = ctx;
  const rng = makeRng(b.seed);
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const B = ch.at(cx, cz);
  const F = facadeFrame(b);
  const { w, d } = F;
  const gh = b.groundH, h = b.h;
  const wall = b.wall, trim = b.trim;
  const sides = frameSides(b.face);
  const exp = { left: exposed(W, b, sides[0]), right: exposed(W, b, sides[1]), back: exposed(W, b, sides[2]) };
  const front = b.kind === 'front' ? true : exposed(W, b, b.face);

  B.push();
  B.translate(F.ox, 0, F.oz);
  B.rotate(F.yaw);
  B.uv(uv.white).bone(0).slot(0).emissive(0).sway(0);

  // ---- the mass
  if (b.shop) {
    const depth = Math.min(2.4, d - 0.5);
    B.color(wall).detail(0.85);
    B.box(0, 0, -d, w, gh, -depth, { skip: 'b' });
    B.box(0, 0, -depth, 0.32, gh, 0, { skip: 'b' });
    B.box(w - 0.32, 0, -depth, w, gh, 0, { skip: 'b' });
    B.box(0.32, gh - 0.55, -depth, w - 0.32, gh, 0, { skip: 't' });
    shopInterior(B, b, rng, w, depth, gh);
  } else {
    B.color(wall).detail(0.85);
    B.box(0, 0, -d, w, gh, 0, { skip: 'b' });
  }
  if (h > gh + 0.01) {
    B.color(wall).detail(0.85);
    B.box(0, gh, -d, w, h, 0, { skip: 'b' });
  }
  // roof slab colour on top: a thin cap so the roof reads as concrete, not wall paint
  B.color(C.roof).detail(1).box(0.05, h, -d + 0.05, w - 0.05, h + 0.04, -0.05, { skip: 'b' });

  // ---- ground floor of a house: door, step, window
  if (!b.shop && front) {
    const dx = clamp(w * (0.25 + rng() * 0.5) - 0.55, 0.3, w - 1.4);
    B.color(scaleRgb(b.door, 0.85)).detail(0.4);
    B.box(dx, 0, -0.05, dx + 1.1, 2.15, 0.03);
    B.color(scaleRgb(b.door, 1.1)).box(dx + 0.06, 0.05, 0.03, dx + 0.53, 2.08, 0.06).box(dx + 0.57, 0.05, 0.03, dx + 1.04, 2.08, 0.06);
    B.color(trim).detail(0.5).box(dx - 0.12, 2.15, -0.02, dx + 1.22, 2.3, 0.1);
    B.color(C.concrete).detail(0.9).box(dx - 0.15, 0, 0, dx + 1.25, 0.16, 0.42, { skip: 'b' });
    const wx = dx + 1.1 + 0.8 < w - 1.2 ? dx + 1.9 : dx - 1.6;
    if (wx > 0.2 && wx + 1.1 < w - 0.2) windowAt(B, rng, wx + 0.55, 1.0, 1.1, 1.2, trim, true);
    if (b.special === 'aunty') {
      B.color(hex('#fff3d6')).emissive(20).boxC(dx + 0.55, 2.45, 0.08, 0.9, 0.2, 0.04); // nameplate
      B.emissive(0);
    }
  }

  // ---- upper floors
  for (let f = 1; f < b.floors; f++) {
    const base = gh + (f - 1) * 3.0;
    if (front) floorFacade(B, b, rng, w, base, trim, f);
    if (exp.left) sideWindows(B, rng, 'left', w, d, base, trim);
    if (exp.right) sideWindows(B, rng, 'right', w, d, base, trim);
    if (exp.back) sideWindows(B, rng, 'back', w, d, base, trim);
    // floor band
    if (front) B.color(trim).detail(0.4).box(-0.02, base - 0.14, 0, w + 0.02, base + 0.02, 0.08, { skip: 'n' });
  }

  // ---- parapet and roof clutter
  if (b.kind === 'front' || chance(rng, 0.3)) {
    const ph = 0.85;
    B.color(trim).detail(0.6);
    B.box(0, h, -0.18, w, h + ph, 0, { skip: 'b' });
    B.box(0, h, -d, w, h + ph, -d + 0.18, { skip: 'b' });
    B.box(0, h, -d + 0.18, 0.18, h + ph, -0.18, { skip: 'bns' });
    B.box(w - 0.18, h, -d + 0.18, w, h + ph, -0.18, { skip: 'bns' });
    if (b.kind === 'front' && chance(rng, 0.4)) {
      // a stepped crown over the facade, painted
      B.color(mixRgb(wall, trim, 0.5)).box(w * 0.3, h + ph, -0.18, w * 0.7, h + ph + 0.5, 0);
    }
  }
  if (b.roof.tank) {
    const tx = clamp(w * (0.2 + rng() * 0.6), 0.8, w - 0.8), tz = -clamp(d * (0.25 + rng() * 0.5), 0.8, d - 0.8);
    B.color(C.concrete).detail(0.8).box(tx - 0.7, h, tz - 0.7, tx + 0.7, h + 0.35, tz + 0.7, { skip: 'b' });

    B.color(C.tank).detail(0.2);
    B.cyl(tx, h + 0.35, tz, 0.58, h + 1.45, 0.55, 8, { smooth: true, caps: '' });
    B.cyl(tx, h + 1.45, tz, 0.55, h + 1.62, 0.18, 8, { smooth: true, caps: 't' });
    B.color(C.white).box(tx - 0.59, h + 0.8, tz - 0.05, tx - 0.57, h + 0.9, tz + 0.05); // the brand stripe nobody can read
  }
  if (b.roof.dish) {
    const x = w * 0.75, z = -0.8;
    B.color(C.metal).rod([x, h, z], [x, h + 0.9, z], 0.03, 4);
    B.color(hex('#d8d8d8')).push().translate(x, h + 1.0, z + 0.1).rotate(0, -0.8, 0).cyl(0, 0, 0, 0.32, 0.12, 0.05, 8, { caps: 'b' }).pop();
  }
  if (b.roof.rebar) {
    B.color(C.rust).detail(0);
    for (const x of [0.15, w - 0.15]) for (const z of [-0.15, -d + 0.15]) {
      for (let k = 0; k < 2; k++) B.rod([x + k * 0.12 - 0.06, h, z], [x + k * 0.12 - 0.06 + (rng() - 0.5) * 0.1, h + 0.9 + rng() * 0.6, z], 0.012, 3, { caps: '' });
    }
  }
  if (b.roof.hut) {
    const x0 = w * 0.55, z0 = -d + 0.4;
    B.color(wall).detail(0.85).box(x0, h, z0, Math.min(w - 0.3, x0 + 2.4), h + 2.6, z0 + 2.6, { skip: 'b' });
    B.color(b.door).box(x0 + 0.5, h, z0 + 2.6, x0 + 1.4, h + 2.0, z0 + 2.64);
  }
  if (b.roof.billboard >= 0) {
    const bw = Math.min(w - 0.6, 7), x0 = (w - bw) / 2;
    B.color(C.metal).detail(0);
    B.rod([x0 + 0.4, h, -0.9], [x0 + 0.4, h + 1.4, -0.9], 0.06, 4);
    B.rod([x0 + bw - 0.4, h, -0.9], [x0 + bw - 0.4, h + 1.4, -0.9], 0.06, 4);
    B.color([1, 1, 1]).emissive(40).box(x0, h + 1.4, -0.95, x0 + bw, h + 1.4 + bw * 0.42, -0.85, { uvFace: { s: uv['ad:' + b.roof.billboard] } });
    B.emissive(0);
  }

  // ---- signs
  if (b.shop) {
    const key = 'sign:' + b.shop.type + ':' + b.shop.idx;
    B.color(C.metal).detail(0).box(0.15, gh - 1.32, -0.02, w - 0.15, gh - 0.02, 0.06);
    B.color([1, 1, 1]).emissive(28).box(0.22, gh - 1.26, 0.06, w - 0.22, gh - 0.08, 0.12, { uvFace: { s: uv[key] } });
    B.emissive(0);
    if (b.shop.awning) awning(B, b, rng, w, gh);
  }
  if (b.upperSign >= 0 && b.floors > 1 && front) {
    const sw = Math.min(3.6, w * 0.62);
    const y = gh + 1.9 + (b.floors > 2 && rng() < 0.5 ? 3 : 0);
    B.color([1, 1, 1]).emissive(22).box(0.3, y + 0.0, 0.08, 0.3 + sw, y + 0.75, 0.14, { uvFace: { s: uv['upper:' + b.upperSign] } });
    B.emissive(0);
  }
  if (b.wallAd >= 0) {
    const side = exp.left ? 'left' : exp.right ? 'right' : null;
    if (side) {
      const aw = Math.min(d - 1, 5), ah = aw * 0.62;
      const y = Math.min(h - ah - 0.5, gh + 0.5);
      if (y > 0.4) {
        B.color([1, 1, 1]).emissive(10);
        if (side === 'left') B.quad([-0.03, y, -(d - aw) / 2 - aw], [-0.03, y, -(d - aw) / 2], [-0.03, y + ah, -(d - aw) / 2], [-0.03, y + ah, -(d - aw) / 2 - aw], uv['ad:' + b.wallAd]);
        else B.quad([w + 0.03, y, -(d - aw) / 2], [w + 0.03, y, -(d - aw) / 2 - aw], [w + 0.03, y + ah, -(d - aw) / 2 - aw], [w + 0.03, y + ah, -(d - aw) / 2], uv['ad:' + b.wallAd]);
        B.emissive(0);
      }
    }
  }
  // drain pipe and the odd meter box
  if (front) {
    const px = rng() < 0.5 ? 0.12 : w - 0.12;
    B.color(C.metal).detail(0.3).box(px - 0.05, 0.15, 0.0, px + 0.05, h + 0.2, 0.1);
    if (chance(rng, 0.4)) B.color(hex('#d6d6d0')).box(px + (px < w / 2 ? 0.2 : -0.6), 1.6, 0, px + (px < w / 2 ? 0.6 : -0.2), 2.1, 0.18);
  }
  B.pop();

  // ---- rangoli at the doorstep (a decal-like flat quad just above the ground)
  if (b.rangoli) {
    const f = { S: [0, 1], N: [0, -1], E: [1, 0], W: [-1, 0] }[b.face];
    const mx = b.face === 'N' || b.face === 'S' ? cx : f[0] > 0 ? b.x1 : b.x0;
    const mz = b.face === 'E' || b.face === 'W' ? cz : f[1] > 0 ? b.z1 : b.z0;
    const px = mx + f[0] * 1.1, pz = mz + f[1] * 1.1;
    const y = baseY(W, px, pz) + 0.008;
    const s = 0.55;
    const Bq = ch.at(px, pz);
    Bq.color([1, 1, 1]).detail(0.2).uv(null);
    Bq.quad([px - s, y, pz + s], [px + s, y, pz + s], [px + s, y, pz - s], [px - s, y, pz - s], uv['rangoli:' + (b.seed % 4 + 4) % 4]);
    Bq.uv(uv.white);
  }
}

function baseY(W, x, z) {
  const i = cellOf(x), j = cellOf(z);
  if (i < 0 || j < 0 || i >= N || j >= N) return 0;
  return SURF_HEIGHT[W.surf[j * N + i]];
}

function shopInterior(B, b, rng, w, depth, gh) {
  const T = SHOP_TYPES[b.shop.type];
  const inner = pick(rng, C.interior);
  B.color(scaleRgb(inner, 0.92)).detail(0.3);
  B.quad([0.32, 0, -depth + 0.01], [w - 0.32, 0, -depth + 0.01], [w - 0.32, gh - 0.55, -depth + 0.01], [0.32, gh - 0.55, -depth + 0.01]);
  B.color(hex('#cfc7b8')).detail(0.5).box(0.32, 0, -depth, w - 0.32, 0.22, 0, { skip: 'b' }); // raised shop floor
  // shelves with goods
  const goods = T.goods.map(hex);
  for (let s = 0; s < 3; s++) {
    const y = 0.75 + s * 0.72;
    B.color(C.wood).detail(0.4).box(0.4, y, -depth + 0.02, w - 0.4, y + 0.04, -depth + 0.42, { skip: 'nb' });
    for (let x = 0.5; x < w - 0.6;) {
      const gw = 0.22 + rng() * 0.3, gh2 = 0.15 + rng() * 0.38;
      const x1 = Math.min(w - 0.45, x + gw);
      const zf = -depth + 0.34;
      B.color(jitterRgb(rng, pick(rng, goods), 0.15)).detail(0);
      B.quad([x, y + 0.04, zf], [x1, y + 0.04, zf], [x1, y + 0.04 + gh2, zf], [x, y + 0.04 + gh2, zf]);
      B.quad([x, y + 0.04 + gh2, zf], [x1, y + 0.04 + gh2, zf], [x1, y + 0.04 + gh2, zf - 0.28], [x, y + 0.04 + gh2, zf - 0.28]);
      x = x1 + 0.03 + rng() * 0.05;
    }
  }
  // the counter, and the tube light that makes every shop glow blue-white at night
  B.color(b.shop.type === 'sweets' || b.shop.type === 'jeweller' ? hex('#bfd6dd') : C.darkWood).detail(0.3);
  B.box(0.5, 0.22, -0.95, w - 0.5, 1.0, -0.6);
  B.color(hex('#ffffff')).emissive(110).box(w * 0.3, gh - 0.75, -depth + 0.03, w * 0.7, gh - 0.69, -depth + 0.08);
  B.emissive(0);
  // the rolled-up shutter
  B.color(hex('#8b8f92')).detail(0.2);
  B.push().translate(w / 2, gh - 0.68, -0.12).rotate(0, 0, Math.PI / 2).cyl(0, -(w / 2 - 0.35), 0, 0.11, w / 2 - 0.35, 0.11, 8).pop();
  // stock spilling forward inside the opening
  const kind = b.shop.type;
  if (kind === 'kirana' || kind === 'flour') {
    for (let x = 0.6; x < w - 0.8; x += 0.75) {
      B.color(hex('#c2a878')).detail(0.6).taper(x + 0.3, 0.22, -0.3, 0.5, 0.42, 0.75, 0.42, 0.36);
      B.color(pick(rng, goods)).detail(0.2).taper(x + 0.3, 0.75, -0.3, 0.42, 0.36, 0.8, 0.3, 0.26);
    }
  } else if (kind === 'saree' || kind === 'tailor' || kind === 'bangles') {
    for (let x = 0.55; x < w - 0.6; x += 0.32) {
      B.color(pick(rng, goods)).detail(0.1).quad([x, 1.1, -0.16], [x + 0.22, 1.1, -0.16], [x + 0.22, gh - 0.75, -0.16], [x, gh - 0.75, -0.16]);
    }
  } else if (kind === 'fruit') {
    for (let x = 0.7; x < w - 0.7; x += 0.55) {
      B.color(C.wood).box(x - 0.25, 0.22, -0.55, x + 0.25, 0.5, -0.15);
      B.color(pick(rng, goods)).detail(0);
      for (let k = 0; k < 4; k++) B.sphere(x - 0.12 + (k % 2) * 0.24, 0.56, -0.45 + (k > 1 ? 0.2 : 0), 0.08, 0);
    }
  } else if (kind === 'shoes' || kind === 'hardware') {
    B.color(C.metal).quad([0.5, 0.22, -0.36], [w - 0.5, 0.22, -0.36], [w - 0.5, 1.7, -0.36], [0.5, 1.7, -0.36]);
    for (let x = 0.6; x < w - 0.6; x += 0.3) for (let y = 0.4; y < 1.6; y += 0.32) {
      B.color(pick(rng, goods)).detail(0).quad([x, y, -0.3], [x + 0.22, y, -0.3], [x + 0.22, y + 0.12, -0.3], [x, y + 0.12, -0.3]);
    }
  }
}

function windowAt(B, rng, cx, sill, ww, wh, trim, ground, cheap) {
  // A frame slab standing proud of the wall with the glass laid over its face:
  // reads as a framed window at any distance for 10 triangles.
  const f = 0.08, x0 = cx - ww / 2, x1 = cx + ww / 2;
  B.color(trim).detail(0.4);
  B.box(x0 - f, sill - f, 0, x1 + f, sill + wh + f, 0.05, { skip: 'nb' });
  // Lit windows are dark glass by day; the emissive byte (>=128) lights them at night.
  const lit = rng() < 0.45;
  B.color(C.glass).detail(0).emissive(lit ? 128 + Math.floor(60 + rng() * 60) : 0);
  B.quad([x0, sill, 0.052], [x1, sill, 0.052], [x1, sill + wh, 0.052], [x0, sill + wh, 0.052]);
  B.emissive(0);
  if (cheap) return;
  if (rng() < (ground ? 0.85 : 0.5)) {
    // grill: bars as flat strips in front of the glass
    B.color(hex('#2f3337')).detail(0);
    const bars = Math.max(2, Math.round(ww / 0.24));
    for (let k = 1; k < bars; k++) {
      const x = x0 + (ww * k) / bars;
      B.quad([x - 0.016, sill, 0.075], [x + 0.016, sill, 0.075], [x + 0.016, sill + wh, 0.075], [x - 0.016, sill + wh, 0.075]);
    }
    const ym = sill + wh * 0.5;
    B.quad([x0, ym - 0.016, 0.076], [x1, ym - 0.016, 0.076], [x1, ym + 0.016, 0.076], [x0, ym + 0.016, 0.076]);
  } else if (rng() < 0.3) {
    // wooden shutters swung open
    B.color(scaleRgb(trim, 0.7)).detail(0.3);
    B.quad([x0 - 0.5, sill, 0.07], [x0 - 0.1, sill, 0.07], [x0 - 0.1, sill + wh, 0.07], [x0 - 0.5, sill + wh, 0.07]);
    B.quad([x1 + 0.1, sill, 0.07], [x1 + 0.5, sill, 0.07], [x1 + 0.5, sill + wh, 0.07], [x1 + 0.1, sill + wh, 0.07]);
  }
  // the chajja: a concrete lip over every window, the most Indian line on the street
  B.color(C.concrete).detail(0.8);
  B.box(x0 - 0.3, sill + wh + 0.14, 0, x1 + 0.3, sill + wh + 0.24, 0.48, { skip: 'n' });
}

function floorFacade(B, b, rng, w, base, trim, f) {
  const sill = base < 0 ? 1.0 : base + 0.9;
  const n = Math.max(1, Math.floor((w - 0.4) / 2.1));
  const s = w / n;
  const ww = Math.min(1.25, s - 0.75), wh = 1.35;
  const balcony = b.kind === 'front' && b.balconies && f >= 1 && rng() < 0.7;
  if (balcony) {
    // a slab, a parapet, a door behind, and life on it
    const x0 = 0.35, x1 = w - 0.35;
    B.color(C.concrete).detail(0.8).box(x0, base - 0.02, 0, x1, base + 0.14, 1.0, { skip: 'n' });
    B.color(trim).detail(0.5);
    B.box(x0, base + 0.14, 0.92, x1, base + 1.0, 1.0, { skip: 'b' });
    B.box(x0, base + 0.14, 0.0, x0 + 0.08, base + 1.0, 0.92, { skip: 'bn' });
    B.box(x1 - 0.08, base + 0.14, 0.0, x1, base + 1.0, 0.92, { skip: 'bn' });
    // pattern cut-outs on the parapet face
    B.color(scaleRgb(trim, 0.75)).detail(0);
    for (let x = x0 + 0.3; x < x1 - 0.4; x += 0.45) B.quad([x, base + 0.35, 1.005], [x + 0.22, base + 0.35, 1.005], [x + 0.22, base + 0.8, 1.005], [x, base + 0.8, 1.005]);
    B.color(scaleRgb(b.door, 0.9)).detail(0.3).quad([w / 2 - 0.5, base + 0.14, 0.01], [w / 2 + 0.5, base + 0.14, 0.01], [w / 2 + 0.5, base + 2.2, 0.01], [w / 2 - 0.5, base + 2.2, 0.01]);
    if (rng() < 0.6) {
      B.color(hex('#a0522d')).detail(0.2).cyl(x0 + 0.35, base + 0.14, 0.6, 0.14, base + 0.42, 0.18, 6);
      B.color(hex('#3f8a35')).sway(0.6).sphere(x0 + 0.35, base + 0.62, 0.6, 0.25, 0).sway(0);
    }
    if (rng() < 0.5) {
      // clothes drying over the parapet
      for (let x = x0 + 0.5; x < x1 - 0.5; x += 0.5 + rng() * 0.3) {
        B.color(hex(pick(rng, ['#e63946', '#457b9d', '#f1faee', '#ffb703', '#8338ec', '#2a9d8f']))).detail(0);
        B.quad([x, base + 0.5, 1.03], [x + 0.36, base + 0.5, 1.03], [x + 0.36, base + 1.04, 1.03], [x, base + 1.04, 1.03]);
      }
    }
    // windows either side of the balcony door if there is room
    if (w > 4.4) {
      windowAt(B, rng, 0.35 + (w / 2 - 0.85) / 2, sill, Math.min(1.0, w / 2 - 1.3), wh, trim, false);
      windowAt(B, rng, w - 0.35 - (w / 2 - 0.85) / 2, sill, Math.min(1.0, w / 2 - 1.3), wh, trim, false);
    }
    return;
  }
  for (let k = 0; k < n; k++) {
    const cx = s * (k + 0.5);
    windowAt(B, rng, cx, sill, ww, wh, trim, base < 0, b.kind === 'back');
    if (rng() < 0.16) {
      B.color(hex('#e9e9e4')).detail(0.2).box(cx - 0.36, sill - 0.6, 0.0, cx + 0.36, sill - 0.08, 0.5, { skip: 'n' });
      B.color(hex('#9aa0a6')).quad([cx - 0.25, sill - 0.5, 0.505], [cx + 0.25, sill - 0.5, 0.505], [cx + 0.25, sill - 0.18, 0.505], [cx - 0.25, sill - 0.18, 0.505]);
    }
    if (rng() < 0.12) B.color(hex('#3f8a35')).sway(0.5).sphere(cx + ww / 2 - 0.15, sill + 0.15, 0.25, 0.16, 0).sway(0);
  }
}

function sideWindows(B, rng, side, w, d, base, trim) {
  // windows on an exposed side or back wall, in the facade frame
  const len = side === 'back' ? w : d;
  const n = Math.max(1, Math.floor((len - 1) / 3.6));
  for (let k = 0; k < n; k++) {
    if (rng() < 0.4) continue;
    const t = (len / n) * (k + 0.5);
    B.push();
    if (side === 'left') { B.translate(0, 0, -t); B.rotate(-Math.PI / 2); }
    else if (side === 'right') { B.translate(w, 0, -t); B.rotate(Math.PI / 2); }
    else { B.translate(w - t, 0, -d); B.rotate(Math.PI); }
    windowAt(B, rng, 0, base + 0.9, 0.9, 1.25, trim, false, true);
    B.pop();
  }
}

function awning(B, b, rng, w, gh) {
  const depth = b.front === 'gali' ? 1.0 : 1.6;
  const yTop = gh - 1.36, yLow = yTop - 0.45;
  const col = b.shop.awning;
  if (b.shop.stripes) {
    const n = Math.max(2, Math.round((w - 0.4) / 0.55));
    for (let k = 0; k < n; k++) {
      const x0 = 0.2 + ((w - 0.4) * k) / n, x1 = 0.2 + ((w - 0.4) * (k + 1)) / n;
      B.color(k % 2 ? C.white : col).detail(0.3);
      B.slab([x0, yTop, 0], [x1, yTop, 0], [x1, yLow, depth], [x0, yLow, depth]);
    }
  } else {
    B.color(col).detail(0.4);
    B.slab([0.2, yTop, 0], [w - 0.2, yTop, 0], [w - 0.2, yLow, depth], [0.2, yLow, depth]);
  }
  // scalloped valance
  B.color(scaleRgb(col, 0.8)).detail(0.2);
  B.box(0.2, yLow - 0.22, depth - 0.02, w - 0.2, yLow, depth + 0.02);
}

/* -------------------------------------------------------------------- props */

function buildProp(ctx, p) {
  const { ch, uv, W } = ctx;
  const B = ch.at(p.x, p.z);
  const rng = makeRng((p.seed || 0) ^ (Math.round(p.x * 131) * 7 + Math.round(p.z * 71)));
  const y0 = baseY(W, p.x, p.z);
  B.uv(uv.white).bone(0).slot(0).emissive(0).sway(0).detail(0.3);
  switch (p.type) {
    case 'pole': return pole(B, p, y0, rng);
    case 'lamp': return lampPost(B, p, y0);
    case 'tree': return tree(B, p, y0, rng);
    case 'stall': return stall(B, p, y0, rng, uv);
    case 'cart': return cart(B, p, y0, rng);
    case 'bench': return bench(B, p, y0);
    case 'charpai': return charpai(B, p, y0);
    case 'garbage': return garbage(B, p, y0, rng);
    case 'handpump': return handpump(B, p, y0);
    case 'tap': return tap(B, p, y0);
    case 'clocktower': return clocktower(B, p, uv);
    case 'temple': return temple(B, p, y0, rng);
    case 'shrine': return shrine(B, p, y0);
    case 'kiosk': return kiosk(B, p, y0, uv);
    case 'busstop': return busstop(B, p, y0, uv);
    case 'sacks': return sacks(B, p, y0);
    case 'clutter': return clutter(B, p, y0, rng);
    case 'tarp': return tarp(B, p, y0);
    case 'median': return median(ctx, p);
    case 'barricade': return barricade(B, p, y0);
    case 'gate': return gate(B, p, y0);
    case 'stumps': return stumps(B, p, y0);
    case 'pitch': return pitch(B, p);
    case 'sandpile': return B.color(hex('#d6b67a')).detail(1).sphere(p.x, y0, p.z, p.r, 1, 0.3);
    case 'bricks': return bricks(B, p, y0, rng);
    case 'planter': return planter(B, p, y0);
    case 'counter': return counter(B, p, y0, rng);
    case 'track': return trackPiece(ctx, p);
    case 'railwall': return railWall(B, p, uv, rng);
    case 'gumti': return gumti(B, p, y0, uv);
    case 'gatepost': return gatePost(B, p, y0);
    case 'whistle': return whistleBoard(B, p, y0, uv);
    case 'tightrope': return tightrope(B, p, y0);
    case 'parapet': return parapet(B, p);
    case 'riversign': return riverSign(B, p, uv);
    case 'drainpipe': return drainPipe(B, p);
    case 'litter': return litter(ctx, p, rng);
    case 'parade': return paradeRoad(ctx);
    case 'stand': return stand(ctx, p);
    case 'bordergate': return borderGate(B, p, uv);
    case 'borderfence': return borderFence(B, p);
    case 'flagpole': return flagpole(B, p, y0);
    default: return null; // parked vehicles and puddles are drawn elsewhere
  }
}

/* ----------------------------------------------------------------- railway */

const RAIL_TOP = 0.46, SLEEPER_TOP = 0.34;

/** What lies under the line at (x, z): a surface, or -1 beyond the edge of the map. */
function surfUnder(W, x, z) {
  if (Math.abs(x) >= HALF || Math.abs(z) >= HALF) return -1;
  return W.surf[cellOf(z) * N + cellOf(x)];
}

/** One rail from x a to b: a dark web and a polished head. */
function railBar(B, a, b, rz, base) {
  B.color(hex('#4d4640')).detail(0.3).box(a, base, rz - 0.06, b, RAIL_TOP - 0.03, rz + 0.06, { skip: 'bew' });
  B.color(hex('#c9c6c0')).detail(0).box(a, RAIL_TOP - 0.03, rz - 0.04, b, RAIL_TOP, rz + 0.04, { skip: 'bew' });
}

/**
 * One 10 m stretch of both tracks: concrete sleepers and rails on the ballast,
 * or, where a road crosses, rails set flush in a concrete deck.
 */
function trackPiece(ctx, p) {
  const { W } = ctx;
  const R = LAYOUT.rail, g = R.gauge / 2;
  for (const T of R.tracks) {
    let a = p.x0;
    while (a < p.x1 - 1e-6) {
      const s0 = surfUnder(W, a + 0.01, T.z);
      let b = a + 0.5;
      while (b < p.x1 - 1e-6 && surfUnder(W, b + 0.01, T.z) === s0) b += 0.5;
      b = Math.min(b, p.x1);
      const B = ctx.ch.at((a + b) / 2, T.z);
      B.uv(ctx.uv.white).bone(0).slot(0).emissive(0).sway(0);
      if (s0 === SURF.RAIL || s0 < 0) {
        B.color(hex('#8f8b84')).detail(0.6);
        for (let x = Math.ceil(a / 0.65) * 0.65; x < b; x += 0.65) B.box(x - 0.12, 0.2, T.z - 1.3, x + 0.12, SLEEPER_TOP, T.z + 1.3, { skip: 'b' });
        for (const s of [-1, 1]) railBar(B, a, b, T.z + s * g, SLEEPER_TOP);
      } else {
        const y = SURF_HEIGHT[s0];
        B.color(hex('#86817a')).detail(0.9).box(a, y, T.z - g - 0.6, b, y + 0.02, T.z + g + 0.6, { skip: 'b' });
        for (const s of [-1, 1]) {
          const rz = T.z + s * g;
          B.color(hex('#2e2a26')).detail(0.2).box(a, y + 0.02, rz - 0.08, b, y + 0.024, rz + 0.08, { skip: 'bew' });
          B.color(hex('#c9c6c0')).detail(0).box(a, y + 0.02, rz - 0.035, b, y + 0.04, rz + 0.035, { skip: 'bew' });
        }
      }
      a = b;
    }
  }
}

/** The railway's boundary wall: plastered brick, pillars every few metres, painted adverts on the town side. */
function railWall(B, p, uv, rng) {
  const z = p.z, h = 1.05;
  B.color(hex('#cdbfa6')).detail(1).box(p.x0, 0, z - 0.12, p.x1, h, z + 0.12, { skip: 'b' });
  B.color(hex('#948a7c')).detail(0.6).box(p.x0, h, z - 0.15, p.x1, h + 0.07, z + 0.15, { skip: 'b' });
  for (let x = p.x0 + 0.1; x < p.x1 - 0.3; x += 3) B.box(x, 0, z - 0.17, x + 0.3, h + 0.14, z + 0.17, { skip: 'b' });
  if (z > (LAYOUT.rail.z0 + LAYOUT.rail.z1) / 2 && p.x1 - p.x0 > 5 && rng() < 0.6) {
    const k = Math.floor(rng() * WALL_ADS.length);
    const ax = p.x0 + 0.5 + rng() * (p.x1 - p.x0 - 3.6);
    B.color([1, 1, 1]).detail(0.5).box(ax, 0.1, z + 0.12, ax + 2.6, 0.98, z + 0.13, { uvFace: { s: uv['ad:' + k] }, skip: 'bnew' });
  }
}

/** The gateman's hut by the crossing, with its board, its bell and the winch that works the booms. */
function gumti(B, p, y0, uv) {
  const x0 = p.x - 1.4, x1 = p.x + 1.4, z0 = p.z - 1.2, z1 = p.z + 1.2, h = 2.6;
  B.color(hex('#efe3c2')).detail(0.9).box(x0, y0, z0, x1, y0 + h, z1, { skip: 'b' });
  B.color(hex('#7a2a22')).detail(0.6).box(x0 - 0.01, y0, z0 - 0.01, x1 + 0.01, y0 + 0.75, z1 + 0.01, { skip: 'bt' });
  B.color(hex('#241f1b')).detail(0.3).box(p.x - 0.45, y0, z1, p.x + 0.45, y0 + 2.0, z1 + 0.02, { skip: 'bn' }); // the door, open
  B.color(hex('#33404a')).box(x0 - 0.02, y0 + 1.1, p.z - 0.5, x0, y0 + 1.9, p.z + 0.5, { skip: 'be' });     // window on the road
  B.box(p.x - 0.6, y0 + 1.1, z0 - 0.02, p.x + 0.6, y0 + 1.9, z0, { skip: 'bs' });                          // window on the line
  B.color(hex('#2b2b2b')).detail(0.1);
  for (let k = -0.4; k <= 0.41; k += 0.2) B.box(x0 - 0.05, y0 + 1.1, p.z + k - 0.015, x0 - 0.02, y0 + 1.9, p.z + k + 0.015, { skip: 'b' });
  for (let k = -0.5; k <= 0.51; k += 0.2) B.box(p.x + k - 0.015, y0 + 1.1, z0 - 0.05, p.x + k + 0.015, y0 + 1.9, z0 - 0.02, { skip: 'b' });
  B.color(hex('#b9b3a6')).detail(0.8).box(x0 - 0.35, y0 + h, z0 - 0.35, x1 + 0.35, y0 + h + 0.15, z1 + 0.35);
  B.color(hex('#6d675e')).box(x0 - 0.35, y0 + h + 0.15, z0 - 0.35, x1 + 0.35, y0 + h + 0.4, z0 - 0.25, { skip: 'b' });
  // the board over the door
  B.color([1, 1, 1]).detail(0.2).box(p.x - 1.25, y0 + h + 0.2, z1 + 0.3, p.x + 1.25, y0 + h + 0.82, z1 + 0.34, { uvFace: { s: uv.phatak } });
  B.color(hex('#2b2b2b')).box(p.x - 1.0, y0 + h + 0.15, z1 + 0.27, p.x - 0.94, y0 + h + 0.2, z1 + 0.33).box(p.x + 0.94, y0 + h + 0.15, z1 + 0.27, p.x + 1.0, y0 + h + 0.2, z1 + 0.33);
  // the bell, under the eave on the road side
  B.color(hex('#3a3a3a')).box(x0 - 0.22, y0 + 2.3, p.z + 0.78, x0, y0 + 2.36, p.z + 0.92);
  B.color(hex('#c9a227')).detail(0.1).cyl(x0 - 0.2, y0 + 2.02, p.z + 0.85, 0.14, y0 + 2.3, 0.07, 10, { smooth: true });
  // the winch the gateman turns, on its stand facing him
  const wx = p.winch.x, wz = p.winch.z;
  B.color(hex('#3a3a3a')).detail(0.3).box(wx - 0.08, y0, wz - 0.08, wx + 0.08, y0 + 0.95, wz + 0.08, { skip: 'b' });
  B.color(hex('#8a2b1f')).detail(0.3).wheel(wx - 0.12, y0 + 0.95, wz, 0.42, 0.06, 14);
  B.color(hex('#2b2b2b')).box(wx - 0.18, y0 + 0.93, wz - 0.4, wx - 0.14, y0 + 0.97, wz + 0.4).box(wx - 0.18, y0 + 0.55, wz - 0.02, wx - 0.14, y0 + 1.35, wz + 0.02);
  B.color(hex('#d8d2c4')).rod([wx - 0.14, y0 + 0.95, wz + 0.36], [wx - 0.32, y0 + 0.95, wz + 0.36], 0.025, 5);
}

/** A boom's post, in black and yellow bands; the boom itself moves, so main.js draws it. */
function gatePost(B, p, y0) {
  const { x, z } = p;
  B.detail(0.4);
  for (let k = 0; k < 5; k++) B.color(hex(k % 2 ? '#1d1d1d' : '#f2c230')).box(x - 0.15, y0 + k * 0.23, z - 0.15, x + 0.15, y0 + (k + 1) * 0.23, z + 0.15, { skip: 'b' });
  B.color(hex('#3a3a3a')).box(x - 0.2, y0 + 1.15, z - 0.22, x + 0.2, y0 + 1.27, z + 0.22);
  // the warning lamp on its bracket (main.js flashes it)
  B.color(hex('#2a2a2a')).box(x - 0.03, y0 + 1.27, z - 0.03, x + 0.03, y0 + 2.05, z + 0.03);
  B.box(x - 0.13, y0 + 1.95, z - 0.13, x + 0.13, y0 + 2.25, z + 0.13);
  B.color(hex('#6e1010')).emissive(15).box(x - 0.1, y0 + 2.0, z - 0.135, x + 0.1, y0 + 2.2, z + 0.135).emissive(0);
}

/** "Whistle!" for the driver: a yellow board on a post between the tracks, facing the oncoming train. */
function whistleBoard(B, p, y0, uv) {
  const { x, z } = p;
  B.color(hex('#d9d4c8')).detail(0.4).box(x - 0.04, y0, z - 0.04, x + 0.04, y0 + 1.75, z + 0.04, { skip: 'b' });
  B.color([1, 1, 1]).detail(0.2).box(x - 0.02, y0 + 1.15, z - 0.3, x + 0.02, y0 + 1.75, z + 0.3, { uvFace: p.face > 0 ? { e: uv.whistle } : { w: uv.whistle } });
}

/* ------------------------------------------------------------------ border */

/** The parade road from the square to the line and on beyond it: asphalt, white edges, the zero line. */
function paradeRoad(ctx) {
  const B = LAYOUT.border, y = SURF_HEIGHT[SURF.PLAZA] + 0.004;
  const [za, zb] = B.road;
  for (let x = B.west; x < B.east - 1e-6; x += 12.5) {
    const x1 = Math.min(B.east, x + 12.5);
    const Bc = ctx.ch.at((x + x1) / 2, (za + zb) / 2);
    Bc.uv(ctx.uv.white).bone(0).slot(0).emissive(0).sway(0);
    Bc.color(C.asphalt).detail(0.9).box(x, y - 0.004, za, x1, y, zb, { skip: 'bnsew' });
    Bc.color(C.white).detail(0.2);
    Bc.box(x, y, za + 0.15, x1, y + 0.003, za + 0.3, { skip: 'bnsew' }).box(x, y, zb - 0.3, x1, y + 0.003, zb - 0.15, { skip: 'bnsew' });
    for (let xd = x + 1; xd < x1 - 1.5; xd += 3) Bc.box(xd, y, (za + zb) / 2 - 0.06, xd + 1.5, y + 0.003, (za + zb) / 2 + 0.06, { skip: 'bnsew' });
  }
  // the zero line: a broad white band across the road, studded with little stones
  const Bz = ctx.ch.at(B.line, (za + zb) / 2);
  Bz.color(hex('#f6f4ee')).detail(0.2).box(B.line - 0.12, y, za, B.line + 0.12, y + 0.006, zb, { skip: 'bnsew' });
  Bz.color(hex('#e8c33a'));
  for (let z = za + 0.4; z < zb - 0.2; z += 1.1) Bz.boxC(B.line, y + 0.03, z, 0.18, 0.06, 0.18);
}

/**
 * Stepped concrete stands along the road, three tiers rising away from it, with
 * a rail along each tier's edge and bunting along the back: ours in saffron,
 * white and green, theirs in green and white.
 */
function stand(ctx, p) {
  const { x0, x1, toward, ours } = p;
  const za = p.z0, zb = p.z1, d = (zb - za) / 3, y0 = SURF_HEIGHT[SURF.PLAZA];
  for (let x = x0; x < x1 - 1e-6; x += 12) {
    const xe = Math.min(x1, x + 12);
    const B = ctx.ch.at((x + xe) / 2, (za + zb) / 2);
    B.uv(ctx.uv.white).bone(0).slot(0).emissive(0).sway(0);
    for (let k = 0; k < 3; k++) {
      const zz0 = toward > 0 ? zb - (k + 1) * d : za + k * d;
      B.color(hex(k % 2 ? '#c9c2b4' : '#bdb5a6')).detail(0.8).box(x, y0, zz0, xe, y0 + 0.5 * (k + 1), zz0 + d, { skip: 'b' });
      // a painted edge on each step
      const edge = toward > 0 ? zz0 + d : zz0;
      B.color(hex(ours ? (k === 0 ? '#ff9933' : k === 1 ? '#f4f4f0' : '#138808') : (k === 1 ? '#f4f4f0' : '#01411c'))).detail(0.3)
        .box(x, y0 + 0.5 * (k + 1) - 0.08, edge - 0.02, xe, y0 + 0.5 * (k + 1) + 0.005, edge + 0.02, { skip: 'b' });
    }
    // the back wall, and the rail along the front
    const back = toward > 0 ? za : zb;
    B.color(hex('#b3ab9c')).detail(0.8).box(x, y0, back - 0.15, xe, y0 + 2.6, back + 0.15, { skip: 'b' });
    B.color(hex('#55524c')).detail(0.2);
    const front = toward > 0 ? zb - 0.1 : za + 0.1;
    B.box(x, y0 + 0.9, front - 0.025, xe, y0 + 0.95, front + 0.025);
    for (let xp = x + 0.2; xp < xe; xp += 2) B.box(xp - 0.025, y0, front - 0.025, xp + 0.025, y0 + 0.95, front + 0.025, { skip: 'b' });
    // bunting along the top of the back wall
    const cols = ours ? ['#ff9933', '#f4f4f0', '#138808'] : ['#01411c', '#f4f4f0'];
    for (let xb = x + 0.3, k = 0; xb < xe - 0.2; xb += 0.55, k++) {
      B.color(hex(cols[k % cols.length])).detail(0.2).pyramid(xb, y0 + 2.75, back, 0.16, 0.02, y0 + 2.45);
    }
  }
}

/** A gate arch over the road with its sign: pillars, a crossbeam, the country's name. The leaves move (main.js). */
function borderGate(B, p, uv) {
  const L = LAYOUT.border, x = p.x, y0 = SURF_HEIGHT[SURF.PLAZA];
  const ours = p.side === 'IN';
  const za = L.walk[0] + 0.45, zb = L.walk[1] - 0.45;
  for (const z of [za, zb]) {
    B.color(hex('#efe8da')).detail(0.6).box(x - 0.4, y0, z - 0.4, x + 0.4, y0 + 4.8, z + 0.4, { skip: 'b' });
    B.color(hex(ours ? '#ff9933' : '#01411c')).box(x - 0.42, y0 + 0.9, z - 0.42, x + 0.42, y0 + 1.1, z + 0.42, { skip: 'tb' });
    B.color(hex('#d8cdb8')).box(x - 0.5, y0 + 4.8, z - 0.5, x + 0.5, y0 + 5.0, z + 0.5);
  }
  // the beam and the board on both faces
  B.color(hex('#efe8da')).detail(0.6).box(x - 0.35, y0 + 4.2, za, x + 0.35, y0 + 5.0, zb);
  const sign = uv[ours ? 'borderIN' : 'borderPK'];
  B.color([1, 1, 1]).detail(0.2).box(x - 0.37, y0 + 4.28, za + 0.6, x + 0.37, y0 + 4.92, zb - 0.6, { uvFace: { e: sign, w: sign }, skip: 'tbns' });
  // a lamp atop each pillar
  for (const z of [za, zb]) B.color(hex('#fff1c9')).emissive(90).boxC(x, y0 + 5.25, z, 0.3, 0.4, 0.3).emissive(0);
}

/** The fence along the line: concrete posts, strands of barbed wire, and a coil along the top. */
function borderFence(B, p) {
  const x = p.x, y0 = SURF_HEIGHT[SURF.PLAZA];
  B.color(hex('#9b968c')).detail(0.6);
  for (let z = p.z0; z <= p.z1 + 1e-6; z += 2.4) B.box(x - 0.07, y0, z - 0.07, x + 0.07, y0 + 2.4, z + 0.07, { skip: 'b' });
  B.color(hex('#6d6a66')).detail(0.1);
  for (let k = 0; k < 6; k++) B.box(x - 0.012, y0 + 0.35 + k * 0.36, p.z0, x + 0.012, y0 + 0.37 + k * 0.36, p.z1);
  for (let z = p.z0; z < p.z1; z += 0.35) B.boxC(x, y0 + 2.45, z, 0.32, 0.32, 0.03);
}

/** A tall white flagpole with a gilded finial. The flag on it moves (main.js). */
function flagpole(B, p, y0) {
  B.color(hex('#f2f0ea')).detail(0.3).cyl(p.x, y0, p.z, 0.11, y0 + p.h, 0.06, 8, { smooth: true });
  B.color(hex('#d4a017')).sphere(p.x, y0 + p.h + 0.1, p.z, 0.12, 1);
  B.color(hex('#c9c2b4')).detail(0.7).cyl(p.x, y0, p.z, 0.45, y0 + 0.35, 0.4, 8);
}

/* ------------------------------------------------------------------- river */

/**
 * The nala's water: one murky sheet each side of the bridge (and on into the
 * haze), with scum, oily patches, foam and clumps of water hyacinth on it. The
 * rubbish that floats down it is drawn live (main.js), so it drifts.
 */
function buildRiver(ctx) {
  const R = LAYOUT.river, b = R.bridge;
  const rng = makeRng(8191);
  for (const [xa, xb] of [[-100, -b], [b, 100]]) {
    const B = ctx.ch.at((xa + xb) / 2, (R.z0 + R.z1) / 2);
    // one sheet per chunk-sized piece, so culling still works
    for (let x = xa; x < xb - 1e-6; x += 25) {
      const x1 = Math.min(xb, x + 25);
      const Bc = ctx.ch.at((x + x1) / 2, (R.step + R.far) / 2);
      Bc.uv(ctx.uv.white).bone(0).slot(0).emissive(0).sway(0);
      Bc.color(C.water).detail(0.18).quad([x, WATER_Y, R.far], [x1, WATER_Y, R.far], [x1, WATER_Y, R.step], [x, WATER_Y, R.step]);
      // the sky caught in long streaks down the current
      Bc.color(hex('#4b544c')).detail(0.1);
      for (let k = 0; k < 9; k++) {
        const z = R.z0 + rng() * (R.z1 - R.z0), l = 2 + rng() * 6, xs = x + rng() * Math.max(0.1, x1 - x - l);
        Bc.box(xs, WATER_Y, z, xs + l, WATER_Y + 0.004, z + 0.04 + rng() * 0.08, { skip: 'bnsew' });
      }
    }
    // patches on the surface: grey-green scum, black oil, white foam, hyacinth
    for (let k = 0; k < 70; k++) {
      const x = xa + rng() * (xb - xa), z = R.z0 - 0.6 + rng() * (R.z1 - R.z0 + 1.2);
      const Bc = ctx.ch.at(x, z);
      const roll = rng();
      const w = 0.6 + rng() * 2.4, d = 0.4 + rng() * 1.6;
      if (roll < 0.35) Bc.color(hex('#6d7150')).detail(0.8).box(x - w / 2, WATER_Y, z - d / 2, x + w / 2, WATER_Y + 0.008, z + d / 2, { skip: 'bnsew' });
      else if (roll < 0.55) Bc.color(hex('#2a2a26')).detail(0.2).box(x - w / 2, WATER_Y, z - d / 2, x + w / 2, WATER_Y + 0.006, z + d / 2, { skip: 'bnsew' });
      else if (roll < 0.75) {
        Bc.color(hex('#dcdccf')).detail(0.6);
        for (let q = 0; q < 5; q++) Bc.sphere(x + (rng() - 0.5) * w, WATER_Y, z + (rng() - 0.5) * d, 0.12 + rng() * 0.18, 0, 0.35);
      } else {
        Bc.color(hex(pick(rng, ['#3f6b2a', '#4c7a31', '#355d24']))).detail(0.7);
        for (let q = 0; q < 6; q++) Bc.sphere(x + (rng() - 0.5) * w, WATER_Y, z + (rng() - 0.5) * d, 0.2 + rng() * 0.2, 0, 0.45);
        if (rng() < 0.5) Bc.color(hex('#b39ddb')).boxC(x, WATER_Y + 0.12, z, 0.08, 0.08, 0.08);
      }
    }
  }
  // on into the haze
  const far = ctx.ch.far;
  far.color(C.water).detail(0.3);
  for (const [xa, xb] of [[-480, -100], [100, 480]]) far.quad([xa, WATER_Y, R.far], [xb, WATER_Y, R.far], [xb, WATER_Y, R.step], [xa, WATER_Y, R.step]);
}

/** A bridge parapet: plastered brick, white with black bands at the ends, the way the PWD paints them. */
function parapet(B, p) {
  const x = p.x, y = SURF_HEIGHT[SURF.WALK];
  B.color(hex('#c8c1b2')).detail(0.9).box(x - 0.15, y, p.z0, x + 0.15, y + 0.95, p.z1, { skip: 'b' });
  B.color(hex('#9a9386')).box(x - 0.18, y + 0.95, p.z0, x + 0.18, y + 1.02, p.z1, { skip: 'b' });
  for (const z0 of [p.z0, p.z1 - 1.2]) {
    for (let k = 0; k < 4; k++) B.color(hex(k % 2 ? '#1d1d1d' : '#f2f0ea')).box(x - 0.17, y, z0 + k * 0.3, x + 0.17, y + 1.0, z0 + (k + 1) * 0.3, { skip: 'b' });
  }
}

/** "Keep the river clean": a board on two posts by the bridge, facing the town. */
function riverSign(B, p, uv) {
  const { x, z } = p, y0 = 0.03;
  B.color(hex('#6d7277')).detail(0.3);
  for (const dx of [-0.6, 0.6]) B.box(x + dx - 0.04, y0, z - 0.04, x + dx + 0.04, y0 + 2.2, z + 0.04, { skip: 'b' });
  B.color([1, 1, 1]).detail(0.2).box(x - 1.0, y0 + 1.5, z - 0.03, x + 1.0, y0 + 2.1, z, { uvFace: { n: uv.riversign } });
}

/** A drain spilling into the nala from under the bank, with its stain and its froth. */
function drainPipe(B, p) {
  const { x, z } = p;
  B.color(hex('#8d877c')).detail(0.8).rod([x, -0.06, z - 0.6], [x, -0.06, z + 0.55], 0.24, 10);
  B.color(hex('#141210')).box(x - 0.17, -0.23, z + 0.55, x + 0.17, 0.11, z + 0.56, { skip: 'bnew' });
  // the outflow: a dark tongue down into the water, and a raft of froth below it
  B.color(hex('#2b2418')).detail(0.4).box(x - 0.14, WATER_Y, z + 0.55, x + 0.14, -0.06, z + 0.62, { skip: 'b' });
  B.color(hex('#e4e2d6')).detail(0.6);
  for (let k = 0; k < 7; k++) B.sphere(x + Math.sin(k * 2.1) * 0.5, WATER_Y, z + 1.0 + (k % 3) * 0.3, 0.14 + (k % 2) * 0.08, 0, 0.35);
}

/** Rubbish scattered down a bank: bags, bottles, wrappers, the odd shoe. */
function litter(ctx, p, rng) {
  const cols = ['#e8e8e8', '#3d6fb5', '#d32f2f', '#f1c40f', '#2e8b57', '#ff7043', '#ad1457', '#bdbdbd', '#212121', '#8d6e63'];
  for (let k = 0; k < p.n; k++) {
    const x = p.x + (rng() - 0.5) * p.r * 2, z = p.z + (rng() - 0.5) * p.r;
    const B = ctx.ch.at(x, z);
    const y = Math.max(baseY(ctx.W, x, z), WATER_Y);
    B.uv(ctx.uv.white).bone(0).slot(0).emissive(0).sway(0).color(hex(pick(rng, cols))).detail(0.4);
    if (rng() < 0.5) B.sphere(x, y + 0.03, z, 0.06 + rng() * 0.1, 0, 0.6);             // a bag
    else B.boxC(x, y + 0.03, z, 0.08 + rng() * 0.22, 0.05, 0.05 + rng() * 0.12);         // a bottle, a wrapper, a carton
  }
}

/** The rope walker's rig: a bamboo tripod at each end, the rope between them, guy ropes pegged out. */
function tightrope(B, p, y0) {
  const { x0, x1, z, h } = p;
  const bamboo = hex('#b8975a');
  for (const [x, s] of [[x0, -1], [x1, 1]]) {
    B.color(bamboo).detail(0.5);
    const top = [x, y0 + h + 0.18, z];
    for (const [fx, fz] of [[s * 0.55, 0], [-s * 0.25, 0.75], [-s * 0.25, -0.75]]) B.rod([x + fx, y0, z + fz], top, 0.045, 5);
    B.rod([x - 0.08, y0 + h + 0.25, z], [x + 0.08, y0 + h + 0.12, z], 0.05, 5);
    // guy ropes to stakes beyond each end
    B.color(hex('#d8cfb8')).detail(0.2);
    for (const fz of [-0.9, 0.9]) {
      B.rod(top, [x + s * 1.6, y0 + 0.05, z + fz], 0.012, 4);
      B.color(hex('#6b4f36')).box(x + s * 1.6 - 0.03, y0, z + fz - 0.03, x + s * 1.6 + 0.03, y0 + 0.2, z + fz + 0.03, { skip: 'b' }).color(hex('#d8cfb8'));
    }
  }
  // the rope itself, with a little sag
  B.color(hex('#e8dfc8')).detail(0.2);
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a = k / n, b = (k + 1) / n;
    const sag = (t) => -0.06 * Math.sin(Math.PI * t);
    B.rod([x0 + (x1 - x0) * a, y0 + h + sag(a), z], [x0 + (x1 - x0) * b, y0 + h + sag(b), z], 0.016, 4);
  }
  // a rolled mat and a tin trunk at the foot of the west tripod
  B.color(hex('#a33b2c')).detail(0.6).cyl(x0 - 1.6, y0, z - 0.9, 0.16, y0 + 0.9, 0.16, 7);
  B.color(hex('#2e6b8a')).box(x0 - 1.9, y0, z - 0.4, x0 - 1.2, y0 + 0.35, z + 0.05, { skip: 'b' });
}

function pole(B, p, y0, rng) {
  const { x, z } = p;
  B.color(hex('#bcb8ae')).detail(0.8);
  B.taper(x, y0, z, 0.24, 0.24, 8.2, 0.14, 0.14);
  B.color(hex('#6b6f73')).detail(0.2);
  const along = p.arm !== null && p.arm !== undefined ? p.arm + Math.PI / 2 : 0;
  B.push().translate(x, 0, z).rotate(along);
  B.box(-0.85, 7.55, -0.05, 0.85, 7.67, 0.05);
  B.box(-0.6, 7.0, -0.05, 0.6, 7.1, 0.05);
  B.color(hex('#e8e4da'));
  for (const xx of [-0.75, -0.25, 0.25, 0.75]) B.cyl(xx, 7.67, 0, 0.035, 7.8, 0.03, 5);
  B.pop();
  if (p.arm !== null && p.arm !== undefined) {
    const ax = Math.sin(p.arm), az = Math.cos(p.arm);
    B.color(hex('#5c6166')).detail(0);
    B.rod([x, 6.6, z], [x + ax * 1.6, 7.45, z + az * 1.6], 0.04, 4);
    B.color(hex('#3f4347')).boxC(x + ax * 1.65, 7.38, z + az * 1.65, 0.34, 0.12, 0.34);
    B.color(hex('#ffd9a0')).emissive(120).boxC(x + ax * 1.65, 7.3, z + az * 1.65, 0.22, 0.05, 0.22);
    B.emissive(0);
  }
  // the knot of service cables everyone has added over the years
  if (rng() < 0.55) {
    B.color(C.black).detail(0);
    for (let k = 0; k < 3; k++) {
      const yy = 5.5 + rng() * 1.5;
      B.boxC(x, yy, z, 0.34 + rng() * 0.12, 0.05, 0.34 + rng() * 0.12);
    }
  }
  if (rng() < 0.08) {
    B.color(hex('#7d8288')).detail(0.4).box(x - 0.45, 4.2, z - 0.35, x + 0.45, 5.3, z + 0.35);
    B.color(hex('#9aa0a6'));
    for (const xx of [-0.3, 0, 0.3]) B.cyl(x + xx, 5.3, z, 0.07, 5.6, 0.05, 5);
  }
}

function lampPost(B, p, y0) {
  const { x, z, h } = p;
  B.color(hex('#2d4a3a')).detail(0.2);
  B.cyl(x, y0, z, 0.12, y0 + 0.5, 0.1, 8);
  B.cyl(x, y0 + 0.5, z, 0.06, y0 + h - 0.4, 0.05, 6);
  B.color(hex('#ffe2a8')).emissive(120).cyl(x, y0 + h - 0.45, z, 0.16, y0 + h - 0.05, 0.2, 6);
  B.emissive(0).color(hex('#2d4a3a')).pyramid(x, y0 + h - 0.05, z, 0.24, 0.24, y0 + h + 0.25);
}

function tree(B, p, y0, rng) {
  const s = p.s || 1;
  const { x, z } = p;
  const trunkH = (p.kind === 'ashoka' ? 2.5 : 3.6) * s;
  B.color(hex('#6b4f36')).detail(0.9);
  B.cyl(x, y0, z, 0.3 * s, y0 + trunkH, 0.2 * s, 7);
  if (p.paint) {
    // white and red bands on the trunk — painted by the municipality, everywhere
    B.color(C.white).detail(0.3).cyl(x, y0, z, 0.305 * s, y0 + 0.65, 0.29 * s, 7, { caps: '' });
    B.color(hex('#b3261e')).cyl(x, y0 + 0.65, z, 0.29 * s, y0 + 0.9, 0.285 * s, 7, { caps: '' });
  }
  if (p.platform) {
    B.color(hex('#d1c4a8')).detail(0.9).cyl(x, y0, z, p.platform, y0 + 0.5, p.platform, 16);
    B.color(hex('#b3261e')).detail(0.4).cyl(x, y0 + 0.5, z, p.platform + 0.02, y0 + 0.55, p.platform + 0.02, 16, { caps: '' });
  }
  // a few limbs, then the canopy as a cluster of low-poly blobs
  B.color(hex('#5d4330')).detail(0.6);
  const limbs = 3 + Math.floor(rng() * 2);
  const crown = [];
  for (let k = 0; k < limbs; k++) {
    const a = (k / limbs) * TAU + rng() * 0.6;
    const len = (1.4 + rng() * 1.2) * s;
    const ex = x + Math.cos(a) * len, ez = z + Math.sin(a) * len, ey = y0 + trunkH + (1.2 + rng() * 1.4) * s;
    B.rod([x, y0 + trunkH - 0.3, z], [ex, ey, ez], 0.12 * s, 5, { r1: 0.06 * s });
    crown.push([ex, ey, ez]);
  }
  const greens = p.kind === 'ashoka' ? ['#2f5d2a', '#356b2e', '#2a5225'] : p.kind === 'peepal' ? ['#4f8a33', '#5c9a3a', '#447a2c', '#6aa842'] : ['#4a7d2c', '#5a8f34', '#3f6f27', '#6b9c3c'];
  B.sway(0.9).detail(0.4);
  const blobs = p.kind === 'ashoka' ? 5 : 7 + Math.floor(rng() * 4);
  for (let k = 0; k < blobs; k++) {
    let cxx, cyy, czz, r;
    if (p.kind === 'ashoka') {
      cxx = x + (rng() - 0.5) * 0.5 * s; czz = z + (rng() - 0.5) * 0.5 * s;
      cyy = y0 + trunkH + (k * 1.1 + 0.6) * s; r = (1.1 - k * 0.12) * s;
    } else {
      const c = crown[k % crown.length];
      cxx = c[0] + (rng() - 0.5) * 1.8 * s; czz = c[2] + (rng() - 0.5) * 1.8 * s;
      cyy = c[1] + (rng() - 0.3) * 1.2 * s; r = (1.3 + rng() * 0.9) * s;
    }
    B.color(jitterRgb(rng, hex(pick(rng, greens)), 0.12));
    B.sphere(cxx, cyy, czz, r, 1, 0.8);
  }
  B.sway(0);
  if (p.kind === 'peepal' && p.platform) {
    // a sacred thread wound around the trunk, and a little lamp at its foot
    B.color(hex('#e53935')).detail(0).cyl(x, y0 + 1.3, z, 0.47, y0 + 1.38, 0.47, 8, { caps: '' });
    B.color(hex('#ffcc66')).emissive(100).boxC(x + 0.9, y0 + 0.56, z + 0.6, 0.08, 0.06, 0.08);
    B.emissive(0);
  }
}

function produce(B, rng, kind, cx, cy, cz, w, d) {
  const pal = (C.produce[kind] || C.produce.veg).map(hex);
  const heaps = Math.max(2, Math.round(w / 0.6));
  for (let k = 0; k < heaps; k++) {
    const col = pick(rng, pal);
    const hx = cx - w / 2 + (w * (k + 0.5)) / heaps;
    B.color(col).detail(0);
    if (kind === 'banana') {
      for (let q = 0; q < 3; q++) B.taper(hx, cy + q * 0.07, cz + (q - 1) * 0.12, 0.28, 0.08, cy + q * 0.07 + 0.07, 0.24, 0.05);
      continue;
    }
    const n = 3 + Math.floor(rng() * 2);
    for (let q = 0; q < n; q++) {
      const r = kind === 'coconut' ? 0.11 : 0.075 + rng() * 0.03;
      B.sphere(hx + (rng() - 0.5) * (w / heaps) * 0.7, cy + r * 0.8 + (q > 3 ? r : 0), cz + (rng() - 0.5) * d * 0.6, r, 0);
    }
  }
}

function stall(B, p, y0, rng, uv) {
  const { x, z, yaw, w, d, kind } = p;
  B.push().translate(x, y0, z).rotate(yaw);
  if (kind === 'chai') {
    B.color(C.darkWood).detail(0.6).box(-w / 2, 0, -d / 2, w / 2, 1.0, d / 2);
    B.color(C.wood).box(-w / 2 - 0.05, 1.0, -d / 2 - 0.05, w / 2 + 0.05, 1.05, d / 2 + 0.05);
    B.color(C.metal).rod([-w / 2 + 0.05, 1.05, -d / 2 + 0.05], [-w / 2 + 0.05, 2.3, -d / 2 + 0.05], 0.03, 4).rod([w / 2 - 0.05, 1.05, -d / 2 + 0.05], [w / 2 - 0.05, 2.3, -d / 2 + 0.05], 0.03, 4);
    B.color(hex('#8a9096')).detail(0.4).slab([-w / 2 - 0.3, 2.35, -d / 2 - 0.3], [w / 2 + 0.3, 2.35, -d / 2 - 0.3], [w / 2 + 0.3, 2.15, d / 2 + 0.5], [-w / 2 - 0.3, 2.15, d / 2 + 0.5]);
    B.color([1, 1, 1]).emissive(30).box(-0.8, 1.8, d / 2 + 0.4, 0.8, 2.15, d / 2 + 0.45, { uvFace: { s: uv.chai } });
    B.emissive(0);
    B.color(hex('#222222')).box(-0.5, 1.05, -0.2, -0.1, 1.2, 0.2);              // stove
    B.color(hex('#c9ced3')).cyl(-0.3, 1.2, 0, 0.17, 1.45, 0.15, 10, { smooth: true }); // kettle
    B.rod([-0.15, 1.35, 0], [0.05, 1.45, 0.05], 0.025, 4);
    for (let k = 0; k < 4; k++) B.color(hex('#d8b07a')).cyl(0.3 + k * 0.13, 1.05, 0.2, 0.06, 1.3, 0.06, 6);
    B.color(hex('#e9c46a')).cyl(0.4, 1.05, -0.2, 0.09, 1.3, 0.09, 8);          // biscuit jar
  } else {
    // table on legs
    const top = kind === 'flower' ? 0.8 : 0.75;
    B.color(C.wood).detail(0.6).box(-w / 2, top - 0.06, -d / 2, w / 2, top, d / 2);
    B.color(C.darkWood);
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.box(lx * (w / 2 - 0.1) - 0.04, 0, lz * (d / 2 - 0.1) - 0.04, lx * (w / 2 - 0.1) + 0.04, top - 0.06, lz * (d / 2 - 0.1) + 0.04);
    B.color(hex('#c2a878')).box(-w / 2 + 0.05, 0.08, -d / 2 + 0.05, w / 2 - 0.05, 0.12, d / 2 - 0.05);
    produce(B, rng, kind, 0, top, 0, w - 0.2, d - 0.2);
    if (kind === 'flower') {
      // garlands hung from a bamboo frame
      B.color(hex('#b08a4a')).rod([-w / 2, top, -d / 2], [-w / 2, 2.0, -d / 2], 0.03, 4).rod([w / 2, top, -d / 2], [w / 2, 2.0, -d / 2], 0.03, 4).rod([-w / 2, 2.0, -d / 2], [w / 2, 2.0, -d / 2], 0.03, 4);
      for (let k = 0; k < 7; k++) {
        const gx = -w / 2 + 0.15 + k * ((w - 0.3) / 6);
        B.color(hex(k % 2 ? '#ff8f00' : '#ffca28')).sway(0.6);
        for (let q = 0; q < 5; q++) B.sphere(gx, 1.9 - q * 0.12, -d / 2, 0.05, 0);
      }
      B.sway(0);
    }
    if (p.umbrella) umbrella(B, 0, 0, p.color, rng);
  }
  B.pop();
}

function umbrella(B, x, z, col, rng) {
  B.color(hex('#e0e0e0')).detail(0).rod([x, 0, z], [x, 2.45, z], 0.03, 4);
  const segs = 8;
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * TAU, c = ((k + 1) / segs) * TAU;
    B.color(k % 2 ? col : C.white).detail(0.2);
    const r = 1.35;
    B.tri([x, 2.75, z], [x + Math.cos(c) * r, 2.25, z + Math.sin(c) * r], [x + Math.cos(a) * r, 2.25, z + Math.sin(a) * r]);
    B.tri([x, 2.73, z], [x + Math.cos(a) * r, 2.23, z + Math.sin(a) * r], [x + Math.cos(c) * r, 2.23, z + Math.sin(c) * r]);
  }
}

function cart(B, p, y0, rng) {
  const { x, z, yaw, kind } = p;
  B.push().translate(x, y0, z).rotate(yaw);
  // in cart frame: long axis along x, customers at +z
  B.color(C.wood).detail(0.6).box(-0.85, 0.82, -0.5, 0.85, 0.9, 0.5);
  B.color(C.darkWood).box(-0.88, 0.9, -0.52, 0.88, 0.98, -0.47).box(-0.88, 0.9, 0.47, 0.88, 0.98, 0.52);
  B.color(hex('#1d1d1f')).detail(0);
  // axle across the cart (along z): in a frame yawed a quarter turn, local x is cart -z
  B.push().translate(0, 0.38, 0).rotate(Math.PI / 2, 0, 0);
  B.wheel(-0.56, 0, 0, 0.36, 0.05, 10).wheel(0.56, 0, 0, 0.36, 0.05, 10);
  B.pop();
  B.color(C.darkWood).rod([0.85, 0.85, -0.3], [1.45, 0.95, -0.3], 0.025, 4).rod([0.85, 0.85, 0.3], [1.45, 0.95, 0.3], 0.025, 4);
  B.rod([-0.75, 0.82, 0], [-0.75, 0, 0], 0.03, 4);
  produce(B, rng, kind, 0, 0.9, 0, 1.5, 0.85);
  umbrella(B, -0.3, -0.2, p.color, rng);
  B.pop();
}

function bench(B, p, y0) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  B.color(hex('#b8b2a5')).detail(0.9);
  B.box(-0.9, 0.38, -0.25, 0.9, 0.45, 0.25);
  B.box(-0.75, 0, -0.18, -0.6, 0.38, 0.18).box(0.6, 0, -0.18, 0.75, 0.38, 0.18);
  B.pop();
}

function charpai(B, p, y0) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  B.color(C.darkWood).detail(0.5);
  for (const [lx, lz] of [[-0.88, -0.44], [0.88, -0.44], [-0.88, 0.44], [0.88, 0.44]]) B.box(lx - 0.04, 0, lz - 0.04, lx + 0.04, 0.42, lz + 0.04);
  B.box(-0.95, 0.36, -0.5, 0.95, 0.42, -0.44).box(-0.95, 0.36, 0.44, 0.95, 0.42, 0.5);
  B.box(-0.95, 0.36, -0.44, -0.89, 0.42, 0.44).box(0.89, 0.36, -0.44, 0.95, 0.42, 0.44);
  B.color(hex('#d8c49a')).detail(0.9).box(-0.89, 0.37, -0.44, 0.89, 0.41, 0.44);
  B.pop();
}

function garbage(B, p, y0, rng) {
  const r = p.r;
  for (let k = 0; k < 11; k++) {
    const a = rng() * TAU, d = rng() * r * 0.7;
    B.color(hex(pick(rng, ['#5b4a3a', '#4a4038', '#6b5a48', '#3d3a36', '#7a6a50']))).detail(1);
    B.sphere(p.x + Math.cos(a) * d, y0, p.z + Math.sin(a) * d, r * (0.35 + rng() * 0.35), 0, 0.45);
  }
  for (let k = 0; k < 14; k++) {
    const a = rng() * TAU, d = rng() * r;
    B.color(hex(pick(rng, ['#e63946', '#ffffff', '#457b9d', '#ffb703', '#2a9d8f', '#111111']))).detail(0);
    B.push().translate(p.x + Math.cos(a) * d, y0 + 0.05 + rng() * 0.25, p.z + Math.sin(a) * d).rotate(rng() * TAU, rng() - 0.5, rng() - 0.5);
    B.boxC(0, 0, 0, 0.12 + rng() * 0.2, 0.03, 0.1 + rng() * 0.15);
    B.pop();
  }
}

function handpump(B, p, y0) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  B.color(C.concrete).detail(0.9).box(-0.7, 0, -0.7, 0.7, 0.14, 0.7, { skip: 'b' });
  B.color(hex('#2e6b45')).detail(0.3);
  B.cyl(0, 0.14, 0, 0.11, 0.95, 0.09, 8);
  B.boxC(0, 1.02, 0, 0.18, 0.18, 0.18);
  B.rod([0, 1.0, 0.08], [0, 0.95, 0.35], 0.04, 5);
  B.rod([0, 1.08, -0.05], [0, 1.25, -0.85], 0.03, 4);
  B.pop();
}

function tap(B, p, y0) {
  B.color(C.metal).detail(0.2).cyl(p.x, y0, p.z, 0.05, y0 + 0.95, 0.05, 6);
  B.color(hex('#c9a227')).rod([p.x, y0 + 0.9, p.z], [p.x, y0 + 0.85, p.z + 0.25], 0.03, 4);
  B.color(hex('#9e978a')).detail(0.9).box(p.x - 0.9, y0, p.z - 0.6, p.x + 0.9, y0 + 0.45, p.z + 0.4, { skip: 'b' });
  B.color(hex('#56707a')).detail(0.2).box(p.x - 0.8, y0 + 0.4, p.z - 0.5, p.x + 0.8, y0 + 0.455, p.z + 0.3);
}

function clocktower(B, p, uv) {
  const y = 0.45;
  const stone = hex('#d9b382'), red = hex('#b5523b'), cream = hex('#efe2c4');
  B.color(stone).detail(0.9).box(-2.1, y, -2.1, 2.1, y + 1.0, 2.1, { skip: 'b' });
  B.color(cream).detail(0.8).box(-1.7, y + 1.0, -1.7, 1.7, y + 11.0, 1.7);
  B.color(red).detail(0.6);
  for (const yy of [y + 3.5, y + 7.0, y + 10.6]) B.box(-1.82, yy, -1.82, 1.82, yy + 0.3, 1.82);
  // arched windows (dark recesses) up the shaft
  B.color(hex('#3a2f28')).detail(0);
  for (const yy of [y + 4.4, y + 7.9]) {
    for (let s = 0; s < 4; s++) {
      B.push().rotate((s * Math.PI) / 2);
      B.box(-0.35, yy, 1.69, 0.35, yy + 1.8, 1.72);
      B.pyramid(0, yy + 1.8, 1.705, 0.35, 0.015, yy + 2.2);
      B.pop();
    }
  }
  // clock storey
  B.color(stone).detail(0.8).box(-2.0, y + 11.0, -2.0, 2.0, y + 13.9, 2.0);
  for (let s = 0; s < 4; s++) {
    B.push().rotate((s * Math.PI) / 2);
    B.color([1, 1, 1]).emissive(45).quad([-1.25, y + 11.2, 2.02], [1.25, y + 11.2, 2.02], [1.25, y + 13.7, 2.02], [-1.25, y + 13.7, 2.02], uv.clock);
    B.emissive(0);
    B.pop();
  }
  B.color(red).box(-2.2, y + 13.9, -2.2, 2.2, y + 14.3, 2.2);
  // cupola: eight-sided drum and dome
  B.color(cream).cyl(0, y + 14.3, 0, 1.5, y + 15.2, 1.5, 8);
  B.color(hex('#e8d9b0')).cyl(0, y + 15.2, 0, 1.6, y + 16.4, 0.7, 8, { smooth: true });
  B.cyl(0, y + 16.4, 0, 0.7, y + 16.9, 0.1, 8, { smooth: true });
  B.color(hex('#c9a227')).rod([0, y + 16.9, 0], [0, y + 17.6, 0], 0.05, 5);
  B.sphere(0, y + 17.3, 0, 0.12, 0);
}

function temple(B, p, y0, rng) {
  const { x0, z0, x1, z1 } = p;
  const stone = hex('#d8c8a8'), white = hex('#f6efe2'), saffron = hex('#f28c28'), red = hex('#c0392b');
  // plinth
  B.color(stone).detail(1).box(x0, 0.18, z0, x1, 1.2, z1, { skip: 'b' });
  B.color(red).detail(0.4).box(x0 - 0.02, 1.05, z0 - 0.02, x1 + 0.02, 1.2, z1 + 0.02, { skip: 'tb' });
  // steps
  B.color(stone).detail(0.9);
  for (let s = 0; s < 3; s++) B.box(-38.5, 0.18, z1, -33.5, 0.3 * (s + 1), z1 + (3 - s) * 1.0, { skip: 'b' });
  // sanctum and porch
  B.color(white).detail(0.7).box(-39, 1.2, -48.6, -33, 5.4, -43.2);
  B.color(hex('#2a1d14')).detail(0).box(-36.7, 1.2, -43.25, -35.3, 3.6, -43.15);  // doorway, dark
  B.color(hex('#ffcc66')).emissive(90).boxC(-36, 2.0, -43.4, 0.25, 0.25, 0.1);     // the lamp inside
  B.emissive(0);
  B.color(white).detail(0.7);
  for (const xx of [-39.3, -37.6, -34.4, -32.7]) B.box(xx - 0.18, 1.2, -42.0, xx + 0.18, 4.0, -41.7);
  B.color(saffron).detail(0.4).box(-39.8, 4.0, -43.3, -32.2, 4.35, -41.4);
  B.color(white).box(-39.6, 4.35, -43.2, -32.4, 4.6, -41.5);
  // marigold toran over the door
  for (let k = 0; k < 14; k++) {
    const t = k / 13;
    B.color(hex(k % 2 ? '#ff8f00' : '#ffca28')).detail(0);
    B.sphere(-37.4 + t * 2.8, 3.75 - Math.sin(t * Math.PI) * 0.3, -41.5, 0.07, 0);
  }
  // the bell
  B.color(hex('#b08d3c')).detail(0.2).rod([-36, 4.0, -42.0], [-36, 3.55, -42.0], 0.015, 4);
  B.cyl(-36, 3.25, -42.0, 0.17, 3.55, 0.08, 10, { smooth: true });
  // shikhara: stacked, tapering tiers with saffron bands, up to the kalash and flag
  let yy = 5.4, half = 3.1;
  const cx = -36, cz = -45.9;
  for (let t = 0; t < 8; t++) {
    const h = 0.95 - t * 0.04;
    B.color(t % 2 ? white : hex('#f3e3c6')).detail(0.6);
    B.taper(cx, yy, cz, half * 2, half * 2, yy + h, half * 2 - 0.5, half * 2 - 0.5);
    B.color(t % 3 === 2 ? red : saffron).detail(0.3).box(cx - half + 0.2, yy + h - 0.1, cz - half + 0.2, cx + half - 0.2, yy + h, cz + half - 0.2);
    yy += h;
    half -= 0.31;
  }
  B.color(white).detail(0.5).cyl(cx, yy, cz, 0.7, yy + 0.25, 0.75, 12, { smooth: true });
  B.color(hex('#d4a017')).detail(0.1).cyl(cx, yy + 0.25, cz, 0.3, yy + 0.7, 0.12, 10, { smooth: true });
  B.sphere(cx, yy + 0.8, cz, 0.15, 0);
  B.color(hex('#8a6a3a')).rod([cx + 0.2, yy, cz], [cx + 0.2, yy + 2.6, cz], 0.03, 4);
  B.color(saffron).sway(1).tri([cx + 0.2, yy + 2.55, cz], [cx + 0.2, yy + 1.85, cz], [cx + 1.5, yy + 2.15, cz]);
  B.tri([cx + 0.2, yy + 2.55, cz], [cx + 1.5, yy + 2.15, cz], [cx + 0.2, yy + 1.85, cz]);
  B.sway(0);
  // slippers left at the steps
  for (let k = 0; k < 9; k++) {
    B.color(hex(pick(rng, ['#2f6db5', '#3b2b20', '#e63946', '#111111', '#f1faee']))).detail(0);
    B.boxC(-38 + rng() * 4, 0.21, z1 + 3.3 + rng() * 0.6, 0.09, 0.03, 0.24);
  }
}

function shrine(B, p, y0) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  B.color(hex('#f6efe2')).detail(0.6).box(-0.8, 0, -0.8, 0.8, 1.6, 0.8, { skip: 'b' });
  B.color(hex('#2a1d14')).box(-0.35, 0.5, 0.78, 0.35, 1.25, 0.82);
  B.color(hex('#ffcc66')).emissive(100).boxC(0, 0.62, 0.84, 0.1, 0.08, 0.06);
  B.emissive(0);
  B.color(hex('#f28c28')).detail(0.3).pyramid(0, 1.6, 0, 0.95, 0.95, 2.6);
  B.color(hex('#c0392b')).rod([0, 2.5, 0], [0, 3.3, 0], 0.02, 4).sway(1).tri([0, 3.3, 0], [0, 3.0, 0], [0.5, 3.15, 0]).tri([0, 3.3, 0], [0.5, 3.15, 0], [0, 3.0, 0]).sway(0);
  B.pop();
}

function kiosk(B, p, y0, uv) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  B.color(hex('#e9e5d9')).detail(0.6).box(-0.9, 0, -0.9, 0.9, 2.3, 0.9, { skip: 'b' });
  B.color(C.glass).box(-0.7, 1.1, 0.88, 0.7, 2.0, 0.92);
  B.color([1, 1, 1]).emissive(25).box(-0.8, 2.3, 0.9, 0.8, 2.6, 0.94, { uvFace: { s: uv.police } });
  B.emissive(0);
  B.color(hex('#c62828')).detail(0.3).box(-1.05, 2.6, -1.05, 1.05, 2.72, 1.05);
  B.pop();
}

function busstop(B, p, y0, uv) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  // in the shelter frame +z faces the road
  B.color(C.metal).detail(0.2);
  for (const xx of [-2.9, 2.9]) B.box(xx - 0.05, 0, -0.75, xx + 0.05, 2.5, -0.65).box(xx - 0.05, 0, 0.55, xx + 0.05, 2.5, 0.65);
  B.color(hex('#1e6fb5')).detail(0.4).box(-3.05, 2.5, -0.85, 3.05, 2.62, 0.85);
  B.color([1, 1, 1]).emissive(30).box(-2.6, 0.6, -0.78, -0.6, 2.2, -0.72, { uvFace: { s: uv['ad:3'] } });
  B.emissive(0);
  B.color(hex('#9aa0a6')).box(-2, 0.42, -0.6, 2, 0.48, -0.1);
  B.pop();
}

function sacks(B, p, y0) {
  B.color(hex('#c2a878')).detail(1);
  for (let k = 0; k < (p.n || 3); k++) {
    B.taper(p.x - 0.75 + k * 0.5, y0, p.z + (k % 2) * 0.2, 0.48, 0.7, y0 + 0.5, 0.42, 0.6);
  }
}

function clutter(B, p, y0, rng) {
  const { x, z } = p;
  switch (p.kind) {
    case 'drum': B.color(hex('#1f5fa8')).detail(0.2).cyl(x, y0, z, 0.27, y0 + 0.85, 0.27, 10, { smooth: true }); break;
    case 'cylinder':
      B.color(hex('#c62828')).detail(0.2).cyl(x, y0, z, 0.15, y0 + 0.55, 0.15, 8, { smooth: true });
      B.cyl(x, y0 + 0.55, z, 0.15, y0 + 0.62, 0.06, 8, { smooth: true });
      break;
    case 'pots':
      B.color(hex('#b5562f')).detail(0.4);
      B.sphere(x - 0.12, y0 + 0.2, z, 0.2, 1, 0.85).sphere(x + 0.15, y0 + 0.18, z + 0.1, 0.18, 1, 0.85);
      B.sphere(x, y0 + 0.5, z + 0.03, 0.17, 1, 0.85);
      break;
    case 'crates':
      B.color(hex('#9c6b3f')).detail(0.7).box(x - 0.28, y0, z - 0.25, x + 0.28, y0 + 0.32, z + 0.25);
      B.color(hex('#8a5d36')).box(x - 0.26, y0 + 0.32, z - 0.23, x + 0.24, y0 + 0.6, z + 0.23);
      break;
    case 'sacks':
      B.color(hex('#c2a878')).detail(1).taper(x, y0, z, 0.5, 0.42, y0 + 0.55, 0.42, 0.36);
      break;
    case 'bucket':
      B.color(hex(pick(rng, ['#e63946', '#2a9d8f', '#ffb703', '#1f5fa8']))).detail(0.1).cyl(x, y0, z, 0.13, y0 + 0.3, 0.16, 8, { caps: 'b' });
      break;
    case 'plant':
      B.color(hex('#a0522d')).detail(0.3).cyl(x, y0, z, 0.16, y0 + 0.32, 0.2, 7);
      B.color(hex('#3f8a35')).sway(0.6).sphere(x, y0 + 0.55, z, 0.28, 0).sway(0);
      break;
    default: // desert cooler
      B.push().translate(x, y0, z).rotate(p.yaw);
      B.color(hex('#d9d2c0')).detail(0.4).box(-0.32, 0.05, -0.25, 0.32, 1.0, 0.25);
      B.color(hex('#8d8676')).box(-0.25, 0.3, 0.25, 0.25, 0.85, 0.27);
      B.pop();
  }
}

function tarp(B, p) {
  const { x0, x1, z0, z1, color, y } = p;
  B.color(color).detail(0.3);
  B.slab([x0, y + 0.2, z0], [x1, y + 0.2, z0], [x1, y - 0.1, z1], [x0, y - 0.1, z1], 0.02);
  B.color(hex('#b08a4a')).detail(0.2);
  for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / 4) {
    B.rod([x, 0, z0], [x, y + 0.2, z0], 0.035, 4);
    B.rod([x, 0, z1], [x, y - 0.1, z1], 0.035, 4);
  }
}

function median(ctx, p) {
  const { x0, x1 } = p;
  const h = LAYOUT.medianHalf;
  for (let x = x0; x < x1 - 1e-6; x += 1) {
    const b = ctx.ch.at(x + 0.5, 0);
    const k = Math.round(x);
    b.uv(ctx.uv.white).color(k % 2 ? C.black : C.yellow).detail(0.4);
    b.box(x, 0, -h, Math.min(x1, x + 1), 0.25, h, { skip: 'b' });
    if (k % 6 === 0) b.color(hex('#4f7f35')).sway(0.4).sphere(x + 0.5, 0.45, 0, 0.32, 0, 0.8).sway(0);
  }
}

function barricade(B, p, y0) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  for (let k = 0; k < 6; k++) {
    B.color(k % 2 ? C.black : C.yellow).detail(0.2);
    B.box(-1.2 + k * 0.4, 0.5, -0.03, -0.8 + k * 0.4, 0.95, 0.03);
  }
  B.color(C.metal).box(-1.25, 0, -0.04, -1.15, 1.0, 0.04).box(1.15, 0, -0.04, 1.25, 1.0, 0.04);
  B.box(-1.25, 0, -0.35, -1.15, 0.05, 0.35).box(1.15, 0, -0.35, 1.25, 0.05, 0.35);
  B.pop();
}

function gate(B, p, y0) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  const w = p.w;
  B.color(hex('#2f4f3a')).detail(0.2);
  B.box(-w / 2, 0, -0.06, w / 2, 0.1, 0.06).box(-w / 2, 2.1, -0.06, w / 2, 2.2, 0.06);
  for (let x = -w / 2; x <= w / 2; x += 0.2) B.box(x - 0.02, 0.1, -0.02, x + 0.02, 2.1, 0.02);
  B.color(hex('#b5a58a')).detail(1).box(-w / 2, 2.2, -0.15, w / 2, 3.6, 0.15);
  B.pop();
}

function stumps(B, p, y0) {
  B.push().translate(p.x, y0, p.z).rotate(p.yaw);
  B.color(hex('#d9b47a')).detail(0.2);
  for (const xx of [-0.11, 0, 0.11]) B.box(xx - 0.02, 0, -0.02, xx + 0.02, 0.71, 0.02);
  B.box(-0.13, 0.71, -0.012, 0.13, 0.735, 0.012);
  B.pop();
}

function pitch(B, p) {
  B.color(hex('#c9a87a')).detail(1);
  const w = p.w / 2;
  const z = p.z;
  B.quad([p.x0, 0.036, z + w], [p.x1, 0.036, z + w], [p.x1, 0.036, z - w], [p.x0, 0.036, z - w]);
  B.color(C.white).detail(0);
  // the creases, scratched in the dust
  for (const x of [p.x0 + 1.2, p.x1 - 1.2]) B.quad([x - 0.04, 0.04, z + 1.2], [x + 0.04, 0.04, z + 1.2], [x + 0.04, 0.04, z - 1.2], [x - 0.04, 0.04, z - 1.2]);
}

function bricks(B, p, y0, rng) {
  for (let l = 0; l < 4; l++) {
    for (let k = 0; k < 5; k++) {
      B.color(jitterRgb(rng, hex('#a5492f'), 0.15)).detail(0.6);
      const x = p.x - 1.1 + k * 0.45 + (l % 2) * 0.12, z = p.z - 0.6 + (l % 2) * 0.1;
      B.box(x, y0 + l * 0.17, z, x + 0.42, y0 + l * 0.17 + 0.16, z + 1.15);
    }
  }
}

function planter(B, p, y0) {
  B.color(hex('#c9b38a')).detail(0.9).box(p.x - 0.6, y0, p.z - 0.6, p.x + 0.6, y0 + 0.7, p.z + 0.6, { skip: 'b' });
  B.color(hex('#c0392b')).detail(0.2).box(p.x - 0.62, y0 + 0.55, p.z - 0.62, p.x + 0.62, y0 + 0.62, p.z + 0.62, { skip: 'tb' });
  B.color(hex('#2f7d32')).sway(0.6);
  for (let k = 0; k < 5; k++) B.sphere(p.x + Math.cos(k * 1.3) * 0.2, y0 + 0.9 + (k % 2) * 0.2, p.z + Math.sin(k * 1.3) * 0.2, 0.18, 0);
  B.sway(0);
}

function counter(B, p, y0, rng) {
  const { x, z, w, d } = p;
  B.color(hex('#7a5230')).detail(0.6).box(x - w / 2, y0, z - d / 2, x + w / 2, y0 + 0.95, z + d / 2, { skip: 'b' });
  // glass case of sweets on the left, the kadhai of jalebis on the right, samosas between
  B.color(hex('#bfd6dd')).detail(0).box(x - w / 2 + 0.05, y0 + 0.95, z - d / 2 + 0.05, x - 0.15, y0 + 1.35, z + d / 2 - 0.05);
  for (let k = 0; k < 10; k++) {
    B.color(hex(pick(rng, ['#f5a623', '#ffd36b', '#fff1c9', '#e8743b', '#f8bbd0']))).box(x - w / 2 + 0.1 + (k % 5) * 0.18, y0 + 1.0 + Math.floor(k / 5) * 0.16, z - 0.1, x - w / 2 + 0.24 + (k % 5) * 0.18, y0 + 1.08 + Math.floor(k / 5) * 0.16, z + 0.12);
  }
  B.color(hex('#202020')).detail(0.2).cyl(x + 0.75, y0 + 0.95, z, 0.18, y0 + 1.12, 0.36, 10, { caps: 'b' });
  B.color(hex('#f39c12'));
  for (let k = 0; k < 6; k++) B.cyl(x + 0.68 + (k % 3) * 0.08, y0 + 1.05, z - 0.08 + Math.floor(k / 3) * 0.14, 0.06, y0 + 1.09, 0.06, 6);
  B.color(hex('#c0c4c8')).box(x + 0.0, y0 + 0.95, z - 0.25, x + 0.5, y0 + 0.98, z + 0.25);
  B.color(hex('#d9952f'));
  for (let k = 0; k < 6; k++) B.pyramid(x + 0.1 + (k % 3) * 0.15, y0 + 0.98, z - 0.12 + Math.floor(k / 3) * 0.2, 0.05, 0.04, y0 + 1.05);
}

/* -------------------------------------------------------------------- wires */

function buildWires(ctx) {
  const { W, ch, uv } = ctx;
  const cols = [hex('#151515'), hex('#2a2a2a'), hex('#0e0e0e')];
  for (const w of W.wires) {
    const mid = [(w.a[0] + w.b[0]) / 2, (w.a[2] + w.b[2]) / 2];
    const B = ch.at(mid[0], mid[1]);
    B.uv(uv.white).color(cols[w.color % 3]).detail(0).bone(0).slot(0).emissive(0);
    const len = Math.hypot(w.b[0] - w.a[0], w.b[2] - w.a[2]);
    const segs = Math.max(4, Math.min(9, Math.round(len / 2.2)));
    const pts = hangingLine(w.a, w.b, w.sag, segs);
    for (let k = 0; k < segs; k++) B.rod(pts[k], pts[k + 1], w.color === 2 ? 0.03 : 0.014, 3);
  }
  // bunting: small triangles on a string
  const flagCols = ['#ff9933', '#ffffff', '#138808', '#e91e63', '#ffeb3b', '#2196f3', '#9c27b0'].map(hex);
  for (const s of W.bunting) {
    const mid = [(s.a[0] + s.b[0]) / 2, (s.a[2] + s.b[2]) / 2];
    const B = ch.at(mid[0], mid[1]);
    const len = Math.hypot(s.b[0] - s.a[0], s.b[2] - s.a[2]);
    const pts = hangingLine(s.a, s.b, s.sag, Math.max(6, Math.round(len / 0.38)));
    B.color(hex('#333333')).sway(0.5);
    for (let k = 0; k + 1 < pts.length; k++) B.rod(pts[k], pts[k + 1], 0.006, 3);
    B.sway(1);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1];
      const tip = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 - 0.28, (p[2] + q[2]) / 2];
      B.color(flagCols[(k + s.seed) % flagCols.length]);
      B.tri(p, q, tip);
      B.tri(q, p, tip);
    }
    B.sway(0);
  }
  // laundry lines
  const clothCols = ['#e63946', '#457b9d', '#f1faee', '#ffb703', '#8338ec', '#2a9d8f', '#fb8500', '#ff006e', '#3a86ff'].map(hex);
  for (const l of W.laundry) {
    const mid = [(l.a[0] + l.b[0]) / 2, (l.a[2] + l.b[2]) / 2];
    const B = ch.at(mid[0], mid[1]);
    const rng = makeRng(l.seed);
    const len = Math.hypot(l.b[0] - l.a[0], l.b[2] - l.a[2]);
    const pts = hangingLine(l.a, l.b, 0.25, Math.max(4, Math.round(len / 0.5)));
    B.color(hex('#dddddd')).sway(0.4);
    for (let k = 0; k + 1 < pts.length; k++) B.rod(pts[k], pts[k + 1], 0.006, 3);
    B.sway(0.8);
    for (let k = 1; k + 1 < pts.length; k++) {
      if (rng() < 0.3) continue;
      const p = pts[k], q = pts[k + 1];
      const hh = 0.35 + rng() * 0.45;
      B.color(pick(rng, clothCols));
      B.quad([p[0], p[1] - hh, p[2]], [q[0], q[1] - hh, q[2]], q, p);
      B.quad([q[0], q[1] - hh, q[2]], [p[0], p[1] - hh, p[2]], p, q);
    }
    B.sway(0);
  }
}

/* ------------------------------------------------------------------ skyline */

function buildSkyline(ctx) {
  const B = ctx.ch.far;
  const rng = makeRng(555);
  B.uv(ctx.uv.white).bone(0).slot(0).emissive(0).sway(0);
  const hazy = ['#b9a58e', '#c4b3a0', '#a9998a', '#c9b8a0', '#b5a898', '#d1c2ad'].map(hex);
  for (let k = 0; k < 170; k++) {
    const a = rng() * TAU;
    const r = 112 + rng() * 130;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // leave the four roads and the railway open so they run on into the haze
    if (Math.abs(z) < 14 && Math.abs(x) > 95) continue;
    if (Math.abs(z - (LAYOUT.rail.z0 + LAYOUT.rail.z1) / 2) < 18 && Math.abs(x) > 95) continue;
    if (Math.abs(z - (LAYOUT.river.z0 + LAYOUT.river.z1) / 2) < 14 && Math.abs(x) > 95) continue;
    if (Math.abs(x) < 11 && Math.abs(z) > 95) continue;
    const w = 6 + rng() * 14, d = 6 + rng() * 14, h = 6 + rng() * (r > 170 ? 34 : 18);
    B.color(pick(rng, hazy)).detail(0.5);
    B.box(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, { skip: 'b' });
    if (rng() < 0.5) B.color(C.tank).cyl(x, h, z, 0.8, h + 1.3, 0.8, 6);
  }
  // landmarks on the horizon: a mosque, a water tower, a mobile tower, a temple
  B.color(hex('#efe7da')).detail(0.4);
  B.box(-170, 0, -150, -150, 9, -134);
  B.sphere(-160, 9, -142, 6, 1, 0.9);
  for (const xx of [-172, -148]) {
    B.cyl(xx, 0, -152, 1.1, 24, 0.9, 8);
    B.cyl(xx, 24, -152, 1.3, 25, 1.3, 8);
    B.cyl(xx, 25, -152, 1.0, 27, 0.05, 8, { smooth: true });
  }
  B.color(hex('#c8c2b6')).cyl(150, 0, 140, 1.4, 22, 1.4, 8);
  B.cyl(150, 22, 140, 6.5, 27, 7.5, 12, { smooth: true });
  B.cyl(150, 27, 140, 7.5, 28.5, 1.5, 12, { smooth: true });
  B.color(hex('#8d8f92')).taper(135, 0, -160, 4, 4, 48, 0.6, 0.6);
  B.color(hex('#ff3b30')).emissive(110).boxC(135, 48.5, -160, 0.6, 0.6, 0.6).emissive(0);
  B.color(hex('#efd9b4')).detail(0.5);
  let yy = 0, half = 7;
  for (let t = 0; t < 7; t++) { B.taper(-150, yy, 170, half * 2, half * 2, yy + 4, half * 2 - 1.4, half * 2 - 1.4); yy += 4; half -= 0.8; }
}
