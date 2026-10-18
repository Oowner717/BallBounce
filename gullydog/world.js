/*
 * world.js — the neighbourhood, as data.
 *
 * The LAYOUT is hand-designed: two roads crossing at a roundabout (the chowk, with
 * its clock tower), and four districts in the four quadrants they make —
 *
 *        NW  Mandir Square: temple, peepal tree, flower sellers, pigeons
 *        NE  the Maidan: dusty ground where the kids play cricket
 *        SW  residential galis around a hand-pump courtyard (Aunty lives here)
 *        SE  the Sabzi Mandi: rows of vegetable stalls
 *
 * Everything that fills it in is PROCEDURAL but deterministic from the seed:
 * building lots, shop types, paint, props, wires. Nothing here touches the DOM, so
 * the node tests build the same world the browser does.
 *
 * Coordinates: metres. X east, Z south (north is -Z), Y up. A 0.5 m grid covers
 * [-100,100]^2 and records the surface type of every cell; buildings are then
 * claimed out of whatever is not open ground.
 *
 * Traffic drives on the LEFT. That one fact decides which side of each road a
 * lane is on and which way the roundabout turns (island on your right: so the
 * ring runs with atan2(z, x) increasing).
 */

import {
  makeRng, rand, randInt, pick, chance, pickWeighted, hex, jitterRgb, clamp, TAU,
  dist2, segDist2,
} from './util.js';
import {
  SHOP_TYPES, SHOP_MIX, UPPER_SIGNS, WALL_ADS, WALL_COLORS, TRIM_COLORS, SHUTTER_COLORS,
  AWNING_COLORS, DOOR_COLORS,
} from './data.js';

export const SURF = { MASS: 0, ROAD: 1, WALK: 2, GALI: 3, PLAZA: 4, DIRT: 5, ISLAND: 6, BUILDING: 7, MARKET: 8, CROSS: 9 };
/** Ground height by surface. Sidewalks and plazas stand on a kerb; galis are near flush. */
export const SURF_HEIGHT = [0, 0, 0.18, 0.06, 0.18, 0.03, 0.45, 0, 0.06, 0];
export const WALKABLE = [false, false, true, true, true, true, false, false, true, false];

export const GRID = { half: 100, res: 0.5, n: 400 };
/** The dog stays inside this square. Roads run on to +-100 so traffic arrives out of the haze. */
export const PLAY_HALF = 86;

export const LAYOUT = {
  mgHalf: 7, mgWalk: 10,          // MG Road carriageway |z|<=7, sidewalks to |z|=10
  bzHalf: 4.5, bzWalk: 7,         // Bazaar Road carriageway |x|<=4.5, sidewalks to |x|=7
  medianHalf: 0.3,                // MG Road median kerb
  ringIn: 5, ringMid: 8.5, ringOut: 12, chowkSq: 16,
  mgLane: 3.65, mgLaneHalf: 3.35, // one carriageway per direction, centre and half-width
  bzLane: 2.25, bzLaneHalf: 2.25,
};

const N = GRID.n, RES = GRID.res, HALF = GRID.half;
const { MASS, ROAD, WALK, GALI, PLAZA, DIRT, ISLAND, BUILDING, MARKET, CROSS } = SURF;

export const cellOf = (v) => Math.floor((v + HALF) / RES);
export const cellCenter = (i) => -HALF + (i + 0.5) * RES;

function rectCells(x0, z0, x1, z1) {
  return [
    Math.max(0, Math.ceil((x0 + HALF) / RES - 0.5)),
    Math.max(0, Math.ceil((z0 + HALF) / RES - 0.5)),
    Math.min(N - 1, Math.ceil((x1 + HALF) / RES - 0.5) - 1),
    Math.min(N - 1, Math.ceil((z1 + HALF) / RES - 0.5) - 1),
  ];
}

export function surfAt(W, x, z) {
  const i = cellOf(x), j = cellOf(z);
  if (i < 0 || j < 0 || i >= N || j >= N) return MASS;
  return W.surf[j * N + i];
}

export function baseHeightAt(W, x, z) {
  return SURF_HEIGHT[surfAt(W, x, z)];
}

/** True when a pedestrian may stand here: open, walkable, not under a prop. */
export function pedWalkable(W, x, z) {
  const i = cellOf(x), j = cellOf(z);
  if (i < 0 || j < 0 || i >= N || j >= N) return false;
  const k = j * N + i;
  return WALKABLE[W.surf[k]] && !W.block[k];
}

/* ------------------------------------------------------------------ areas */

/**
 * Open ground, painted in order (later wins). `front` is the frontage class the
 * buildings lining this area get; `zone` names it on the HUD.
 */
const AREAS = [
  // The chowk square first, so the roads and the ring cut through it.
  { s: PLAZA, r: [-16, -16, 16, 16], front: 'main' },
  // MG Road (E-W) and Bazaar Road (N-S)
  { s: WALK, r: [-100, -10, 100, -7], front: 'main' },
  { s: WALK, r: [-100, 7, 100, 10], front: 'main' },
  { s: WALK, r: [-7, -100, -4.5, 100], front: 'bazaar' },
  { s: WALK, r: [4.5, -100, 7, 100], front: 'bazaar' },
  { s: ROAD, r: [-100, -7, 100, 7] },
  { s: ROAD, r: [-4.5, -100, 4.5, 100] },
  // Auto stand lay-by off MG Road
  { s: PLAZA, r: [-30, -13, -16, -10], front: 'main' },

  // NW — Mandir Square
  { s: GALI, r: [-37, -24, -33, -10], front: 'gali' },
  { s: GALI, r: [-22, -38, -7, -34], front: 'gali' },
  { s: GALI, r: [-86, -66, -7, -62], front: 'gali' },
  { s: GALI, r: [-48, -62, -44, -50], front: 'gali' },
  { s: GALI, r: [-74, -62, -70, -10], front: 'gali' },
  { s: PLAZA, r: [-50, -50, -22, -24], front: 'plaza' },

  // NE — the Maidan
  { s: GALI, r: [40, -26, 44, -10], front: 'gali' },
  { s: GALI, r: [7, -44, 24, -40], front: 'gali' },
  { s: GALI, r: [7, -72, 86, -68], front: 'gali' },
  { s: GALI, r: [52, -68, 56, -58], front: 'gali' },
  { s: GALI, r: [74, -68, 78, -10], front: 'gali' },
  { s: DIRT, r: [24, -58, 64, -26], front: 'dirt' },

  // SW — residential galis around the pump courtyard
  { s: GALI, r: [-31, 10, -27, 78], front: 'gali' },
  { s: GALI, r: [-63, 10, -59, 78], front: 'gali' },
  { s: GALI, r: [-86, 39, -7, 43], front: 'gali' },
  { s: GALI, r: [-86, 74, -7, 78], front: 'gali' },
  { s: PLAZA, r: [-35, 35, -23, 47], front: 'court' },

  // SE — Sabzi Mandi
  { s: GALI, r: [34, 10, 40, 22], front: 'gali' },
  { s: GALI, r: [7, 30, 20, 35], front: 'gali' },
  { s: GALI, r: [7, 68, 86, 72], front: 'gali' },
  { s: GALI, r: [52, 54, 56, 68], front: 'gali' },
  { s: GALI, r: [74, 10, 78, 68], front: 'gali' },
  { s: MARKET, r: [20, 22, 62, 54], front: 'market' },
];

/** Lot shape and use by frontage class. */
const FRONTAGE = {
  main:   { w: [5, 9], d: [9, 14], floors: [2, 5], shop: 0.9 },
  bazaar: { w: [4, 7], d: [8, 12], floors: [2, 4], shop: 0.95 },
  plaza:  { w: [5, 8], d: [5, 10], floors: [2, 3], shop: 0.5 },
  court:  { w: [4, 6], d: [6, 9], floors: [2, 3], shop: 0.1 },
  market: { w: [4, 7], d: [6, 10], floors: [1, 3], shop: 0.75 },
  dirt:   { w: [6, 10], d: [6, 10], floors: [2, 3], shop: 0.1 },
  gali:   { w: [4.5, 7.5], d: [6, 11], floors: [2, 4], shop: 0.18 },
};
const FRONT_ORDER = ['main', 'bazaar', 'plaza', 'court', 'market', 'dirt', 'gali'];

/** HUD place names. First match wins, so the specific ones come first. */
const ZONES = [
  { name: 'Ghanta Ghar Chowk', c: [0, 0, 19] },
  { name: 'Auto Stand', r: [-31, -14, -15, -7] },
  { name: 'Mandir Square', r: [-50, -50, -22, -24] },
  { name: 'Gully Maidan', r: [24, -58, 64, -26] },
  { name: 'Sabzi Mandi', r: [20, 22, 62, 54] },
  { name: 'Pump Wala Chowk', r: [-35, 35, -23, 47] },
  { name: 'MG Road', r: [-100, -10.5, 100, 10.5] },
  { name: 'Bazaar Road', r: [-7.5, -100, 7.5, 100] },
  { name: 'Mandir Gali', r: [-86, -66, -7, -10] },
  { name: 'Maidan Gali', r: [7, -72, 86, -10] },
  { name: 'Gali No. 4', r: [-31.5, 10, -26.5, 78] },
  { name: 'Gali No. 7', r: [-63.5, 10, -58.5, 78] },
  { name: 'Peepal Gali', r: [-86, 38.5, -7, 43.5] },
  { name: 'Pichhli Gali', r: [-86, 73.5, -7, 78.5] },
  { name: 'Mandi Gali', r: [7, 10, 86, 72] },
];

export function zoneAt(W, x, z) {
  for (const zn of W.zones) {
    if (zn.c) {
      if (dist2(x, z, zn.c[0], zn.c[1]) <= zn.c[2] * zn.c[2]) return zn.name;
    } else if (x >= zn.r[0] && x <= zn.r[2] && z >= zn.r[1] && z <= zn.r[3]) return zn.name;
  }
  return 'The Galis';
}

/* --------------------------------------------------------------- generator */

export function generateWorld(seed = 7) {
  const rng = makeRng(seed);
  const W = {
    seed,
    surf: new Uint8Array(N * N),
    block: new Uint8Array(N * N),   // pedestrians may not stand here (props, buildings)
    claim: new Int32Array(N * N).fill(-1), // building id per cell
    buildings: [],
    props: [],
    colliders: [],
    shades: [],                     // extra sun blockers: awnings, canopies, roofs
    wires: [],
    bunting: [],
    laundry: [],
    lights: [],                     // night lights: {x,y,z,r,color,kind}
    pois: { water: [], food: [], posts: [], sleep: [], garbage: [], landmarks: [] },
    zones: ZONES,
    spawns: {},
    special: {},
    stalls: [],
    seats: [],
    routes: [],
    peds: null,
  };

  paintAreas(W);
  placeLots(W, rng);
  backfill(W, rng);
  placeLandmarks(W, rng);
  placeStreetProps(W, rng);
  placeWires(W, rng);
  finishBuildings(W, rng);
  buildColliderIndex(W);
  W.routes = buildRoutes();
  W.peds = buildPedGraph(W);
  return W;
}

function paintAreas(W) {
  for (const a of AREAS) paintRect(W, a.s, a.r);
  // The roundabout: ring road, then the raised island.
  paintCircle(W, ROAD, 0, 0, LAYOUT.ringOut);
  paintCircle(W, ISLAND, 0, 0, LAYOUT.ringIn);
  // Zebra crossings on each arm, just outside the ring.
  for (const c of zebraRects()) paintRect(W, CROSS, c, ROAD);
}

/** The four zebra crossings as rects on the carriageway. */
export function zebraRects() {
  const { mgHalf, bzHalf } = LAYOUT;
  return [
    [-17, -mgHalf, -14.5, mgHalf],
    [14.5, -mgHalf, 17, mgHalf],
    [-bzHalf, -17, bzHalf, -14.5],
    [-bzHalf, 14.5, bzHalf, 17],
  ];
}

function paintRect(W, s, r, onlyOver = -1) {
  const [i0, j0, i1, j1] = rectCells(r[0], r[1], r[2], r[3]);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * N + i;
      if (onlyOver >= 0 && W.surf[k] !== onlyOver) continue;
      W.surf[k] = s;
    }
  }
}

function paintCircle(W, s, cx, cz, r) {
  const [i0, j0, i1, j1] = rectCells(cx - r, cz - r, cx + r, cz + r);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (dist2(cellCenter(i), cellCenter(j), cx, cz) <= r * r) W.surf[j * N + i] = s;
    }
  }
}

/* -------------------------------------------------------------------- lots */

function lotFree(W, x0, z0, x1, z1) {
  if (x0 < -HALF || z0 < -HALF || x1 > HALF || z1 > HALF) return false;
  const [i0, j0, i1, j1] = rectCells(x0, z0, x1, z1);
  if (i1 < i0 || j1 < j0) return false;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * N + i;
      if (W.surf[k] !== MASS || W.claim[k] >= 0) return false;
    }
  }
  return true;
}

function claimLot(W, x0, z0, x1, z1, id) {
  const [i0, j0, i1, j1] = rectCells(x0, z0, x1, z1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * N + i;
      W.claim[k] = id;
      W.surf[k] = BUILDING;
      W.block[k] = 1;
    }
  }
}

const snap = (v) => Math.round(v * 2) / 2;

function lotRect(side, R, t, w, d) {
  switch (side) {
    case 'N': return [t, R[1] - d, t + w, R[1]];
    case 'S': return [t, R[3], t + w, R[3] + d];
    case 'W': return [R[0] - d, t, R[0], t + w];
    default: return [R[2], t, R[2] + d, t + w];
  }
}
/** The lot north of an area faces south into it, and so on. */
const FACE_FOR_SIDE = { N: 'S', S: 'N', W: 'E', E: 'W' };

function placeLots(W, rng) {
  for (const front of FRONT_ORDER) {
    const P = FRONTAGE[front];
    for (const a of AREAS) {
      if (a.front !== front) continue;
      for (const side of ['N', 'S', 'W', 'E']) {
        const along = side === 'N' || side === 'S' ? [a.r[0], a.r[2]] : [a.r[1], a.r[3]];
        let t = Math.max(along[0], -HALF);
        const end = Math.min(along[1], HALF);
        while (t < end - P.w[0] + 0.01) {
          let w = snap(rand(rng, P.w[0], P.w[1]));
          if (end - t - w < P.w[0]) w = end - t; // absorb a leftover sliver
          w = Math.min(w, end - t);
          let placed = false;
          for (let tryW = w; tryW >= P.w[0] - 0.01 && !placed; tryW -= 1) {
            let d = snap(rand(rng, P.d[0], P.d[1]));
            for (; d >= 4; d -= 0.5) {
              const r = lotRect(side, a.r, t, tryW, d);
              if (lotFree(W, r[0], r[1], r[2], r[3])) {
                addBuilding(W, rng, r, FACE_FOR_SIDE[side], front, 'front');
                t += tryW;
                placed = true;
                break;
              }
            }
          }
          if (!placed) t += 0.5;
        }
      }
    }
  }
}

function addBuilding(W, rng, r, face, front, kind) {
  const id = W.buildings.length;
  const P = FRONTAGE[front] || FRONTAGE.gali;
  const b = {
    id, x0: r[0], z0: r[1], x1: r[2], z1: r[3], face, front, kind,
    floors: kind === 'back' ? randInt(rng, 1, 4) : randInt(rng, P.floors[0], P.floors[1]),
    seed: (rng() * 0x7fffffff) | 0,
    wall: jitterRgb(rng, hex(pick(rng, WALL_COLORS)), 0.12),
    trim: hex(pick(rng, TRIM_COLORS)),
    shutter: hex(pick(rng, SHUTTER_COLORS)),
    door: hex(pick(rng, DOOR_COLORS)),
    shop: null,
    upperSign: -1,
    wallAd: -1,
    balconies: false,
    roof: { tank: false, dish: false, rebar: false, billboard: -1, hut: false },
    special: null,
  };
  // Distant buildings along the roads beyond the play area stand taller, so the
  // haze has a skyline to swallow.
  const far = Math.max(Math.abs((r[0] + r[2]) / 2), Math.abs((r[1] + r[3]) / 2));
  if (far > PLAY_HALF) b.floors = Math.max(b.floors, randInt(rng, 3, 6));
  if (kind === 'front' && chance(rng, P.shop)) {
    b.shop = makeShop(rng, front);
  }
  claimLot(W, r[0], r[1], r[2], r[3], id);
  W.buildings.push(b);
  return b;
}

function makeShop(rng, front, forcedType) {
  const mix = SHOP_MIX[front] || SHOP_MIX.gali;
  const type = forcedType || pick(rng, mix);
  const T = SHOP_TYPES[type];
  return {
    type,
    idx: randInt(rng, 0, T.name.length - 1),
    awning: chance(rng, 0.62) ? hex(pick(rng, AWNING_COLORS)) : null,
    stripes: chance(rng, 0.3),
  };
}

/** Fill everything still unclaimed with plain buildings, in rectangles up to 12 m. */
function backfill(W, rng) {
  const maxCells = Math.round(12 / RES);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (W.surf[k] !== MASS || W.claim[k] >= 0) continue;
      let wi = 1;
      while (i + wi < N && wi < maxCells && W.surf[j * N + i + wi] === MASS && W.claim[j * N + i + wi] < 0) wi++;
      let hj = 1;
      outer: while (j + hj < N && hj < maxCells) {
        for (let q = 0; q < wi; q++) {
          const kk = (j + hj) * N + i + q;
          if (W.surf[kk] !== MASS || W.claim[kk] >= 0) break outer;
        }
        hj++;
      }
      const x0 = -HALF + i * RES, z0 = -HALF + j * RES;
      addBuilding(W, rng, [x0, z0, x0 + wi * RES, z0 + hj * RES], 'N', 'gali', 'back');
    }
  }
}

/* ---------------------------------------------------------------- colliders */

/**
 * Collider heights are given relative to the ground the prop stands on (the way
 * cityMesh draws them) unless opts.abs, and stored as absolute world heights.
 */
function groundUnder(W, x, z) {
  const s = surfAt(W, x, z);
  return s === ISLAND || s === BUILDING || s === MASS ? 0 : SURF_HEIGHT[s];
}

function addBox(W, x0, z0, x1, z1, y1, opts = {}) {
  const base = opts.abs ? 0 : groundUnder(W, (x0 + x1) / 2, (z0 + z1) / 2);
  const c = { kind: 'box', x0, z0, x1, z1, y0: (opts.y0 || 0) + base, y1: y1 + base, platform: !!opts.platform, tag: opts.tag || '' };
  W.colliders.push(c);
  if (opts.block !== false) markBlock(W, x0 - 0.2, z0 - 0.2, x1 + 0.2, z1 + 0.2);
  return c;
}

function addCircle(W, x, z, r, y1, opts = {}) {
  const base = opts.abs ? 0 : groundUnder(W, x, z);
  const c = { kind: 'circle', x, z, r, y0: (opts.y0 || 0) + base, y1: y1 + base, platform: !!opts.platform, tag: opts.tag || '' };
  W.colliders.push(c);
  if (opts.block !== false) markBlock(W, x - r - 0.15, z - r - 0.15, x + r + 0.15, z + r + 0.15);
  return c;
}

function markBlock(W, x0, z0, x1, z1) {
  const [i0, j0, i1, j1] = rectCells(x0, z0, x1, z1);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) W.block[j * N + i] = 1;
}

/** Is this rectangle open, walkable and not already taken by another prop? */
function propFree(W, x0, z0, x1, z1) {
  const [i0, j0, i1, j1] = rectCells(x0, z0, x1, z1);
  if (i1 < i0 || j1 < j0) return false;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * N + i;
      if (!WALKABLE[W.surf[k]] || W.block[k]) return false;
    }
  }
  return true;
}

/** A uniform 4 m grid over the colliders so the dog only tests what is near. */
function buildColliderIndex(W) {
  const size = 4, n = Math.ceil((2 * HALF) / size);
  const cells = Array.from({ length: n * n }, () => []);
  const add = (idx, x0, z0, x1, z1) => {
    const i0 = clamp(Math.floor((x0 + HALF) / size), 0, n - 1), i1 = clamp(Math.floor((x1 + HALF) / size), 0, n - 1);
    const j0 = clamp(Math.floor((z0 + HALF) / size), 0, n - 1), j1 = clamp(Math.floor((z1 + HALF) / size), 0, n - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * n + i].push(idx);
  };
  // Buildings are colliders too; append them once, here, so nothing else can forget.
  for (const b of W.buildings) {
    W.colliders.push({ kind: 'box', x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, y0: 0, y1: b.h, platform: false, tag: 'building', building: b.id });
  }
  W.colliders.forEach((c, idx) => {
    if (c.kind === 'box') add(idx, c.x0, c.z0, c.x1, c.z1);
    else add(idx, c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r);
  });
  W.colIndex = { size, n, cells };
}

/** Colliders whose bounds touch the square around (x,z) of half-size r. */
export function collidersNear(W, x, z, r, out) {
  const { size, n, cells } = W.colIndex;
  out.length = 0;
  const i0 = clamp(Math.floor((x - r + HALF) / size), 0, n - 1), i1 = clamp(Math.floor((x + r + HALF) / size), 0, n - 1);
  const j0 = clamp(Math.floor((z - r + HALF) / size), 0, n - 1), j1 = clamp(Math.floor((z + r + HALF) / size), 0, n - 1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      for (const idx of cells[j * n + i]) if (out.indexOf(idx) < 0) out.push(idx);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- landmarks */

function prop(W, type, x, z, extra) {
  const p = Object.assign({ type, x, z, yaw: 0 }, extra || {});
  W.props.push(p);
  return p;
}

function placeLandmarks(W, rng) {
  /* ---- Ghanta Ghar: the clock tower on the island ---- */
  prop(W, 'clocktower', 0, 0, { h: 17 });
  addBox(W, -1.9, -1.9, 1.9, 1.9, 17.5, { tag: 'clocktower', abs: true });
  addCircle(W, 0, 0, LAYOUT.ringIn, SURF_HEIGHT[ISLAND], { platform: true, tag: 'island', block: false, abs: true });
  W.pois.landmarks.push({ id: 'clocktower', x: 0, z: 2.6, name: 'Ghanta Ghar' });
  W.pois.posts.push({ x: 1.95, z: 1.95, tag: 'clocktower' });
  W.spawns.cop = { x: -4.2, z: 0.8, yaw: -Math.PI / 2 };
  W.lights.push({ x: 0, y: 12, z: 0, r: 16, color: [1.0, 0.85, 0.6], kind: 'tower' });

  /* ---- Mandir Square ---- */
  const T = { x0: -41, z0: -49.5, x1: -31, z1: -41.5 };
  prop(W, 'temple', -36, -45.5, { x0: T.x0, z0: T.z0, x1: T.x1, z1: T.z1 });
  // Plinth (a platform you can climb), three steps on the south face, sanctum on top.
  addBox(W, T.x0, T.z0, T.x1, T.z1, 1.2, { platform: true, tag: 'temple', abs: true });
  for (let s = 0; s < 3; s++) {
    const z0 = T.z1 + (2 - s) * 1.0;
    addBox(W, -38.5, T.z1, -33.5, z0 + 1.0, 0.3 * (s + 1), { platform: true, tag: 'steps', abs: true });
  }
  addBox(W, -39, -48.6, -33, -43.2, 1.2 + 4.2, { tag: 'sanctum', y0: 1.2, abs: true });
  W.special.temple = { x: -36, z: -41, door: { x: -36, z: -42.6 }, bell: { x: -36, y: 3.3, z: -42.2 } };
  W.pois.landmarks.push({ id: 'temple', x: -36, z: -37.6, name: 'Shiv Mandir' });
  W.pois.sleep.push({ x: -36, z: -38.2, tag: 'steps' });
  W.pois.food.push({ x: -36, z: -37.6, kind: 'prasad' });
  W.spawns.priest = { x: -36, z: -42.2, yaw: 0 };
  W.lights.push({ x: -36, y: 3, z: -41.6, r: 9, color: [1.0, 0.7, 0.35], kind: 'diya' });

  // The peepal tree on its round platform — the best nap in the neighbourhood.
  prop(W, 'tree', -27, -29.5, { kind: 'peepal', s: 1.5, platform: 2.4, paint: true, seed: 4242 });
  addCircle(W, -27, -29.5, 2.4, 0.5, { platform: true, tag: 'chabutra' });
  addCircle(W, -27, -29.5, 0.6, 9, { tag: 'trunk' });
  W.shades.push({ kind: 'sphere', x: -27, y: 8.5, z: -29.5, r: 6.2 });
  W.pois.sleep.push({ x: -25.1, z: -29.5, y: 0.5, tag: 'chabutra' });
  W.pois.posts.push({ x: -27, z: -28.7, tag: 'tree' });

  // Water tap with a stone trough.
  prop(W, 'tap', -43, -40.2, { yaw: 0 });
  addBox(W, -43.9, -40.8, -42.1, -39.8, 0.45, { tag: 'trough' });
  W.pois.water.push({ x: -43, z: -39.3, kind: 'trough', clean: true });

  // Flower sellers along the west side and by the steps.
  for (const [x, z, yaw] of [[-48.6, -38, Math.PI / 2], [-48.6, -32, Math.PI / 2], [-43, -36.5, 0]]) {
    stall(W, rng, x, z, yaw, 'flower', 1.8, 1.1);
  }
  bench(W, -24.2, -37, -Math.PI / 2);
  bench(W, -46, -26.2, Math.PI);
  bench(W, -30.5, -26.2, Math.PI);
  W.spawns.flocks = [{ x: -37, z: -31.5, n: 16, kind: 'pigeon', grain: true }];
  W.special.squareCenter = { x: -36, z: -32 };
  for (const [x, z] of [[-48.8, -25.2], [-23.2, -48.8], [-48.8, -48.8], [-23.2, -25.2]]) lampPost(W, x, z, 4.2);

  /* ---- Gully Maidan ---- */
  W.special.pitch = { x0: 34, x1: 54, z: -42, batter: { x: 52.4, z: -42 }, bowler: { x: 36.5, z: -42 } };
  prop(W, 'stumps', 53.4, -42, { yaw: Math.PI / 2 });
  prop(W, 'stumps', 34.6, -42, { yaw: Math.PI / 2 });
  prop(W, 'pitch', 44, -42, { x0: 34, x1: 54, w: 2.6 });
  for (const [x, z, s] of [[26.6, -28.6, 1.1], [61.4, -28.8, 1.25], [26.8, -55.2, 1.0], [61.2, -55.4, 1.15], [44, -56.2, 1.05], [33, -56.4, 0.9]]) {
    tree(W, rng, x, z, 'neem', s, true);
  }
  prop(W, 'sandpile', 58.5, -31.5, { r: 2.2 });
  addCircle(W, 58.5, -31.5, 1.6, 0.55, { platform: true, tag: 'sand' });
  W.pois.sleep.push({ x: 58.5, z: -31.5, y: 0.55, tag: 'sand' });
  prop(W, 'bricks', 55, -28.2, { yaw: 0 });
  addBox(W, 53.8, -28.9, 56.2, -27.5, 0.7, { platform: true, tag: 'bricks' });
  garbage(W, 25.6, -47, 1.6);
  bench(W, 37, -27.4, Math.PI);
  W.spawns.flocks.push({ x: 30, z: -50, n: 10, kind: 'pigeon' });
  W.spawns.goats = [{ x: 58, z: -50 }, { x: 57, z: -52 }, { x: 59.5, z: -48.5 }];
  lampPost(W, 25, -27, 4.2);
  lampPost(W, 63, -57, 4.2);

  /* ---- Pump Wala Chowk (SW courtyard) ---- */
  prop(W, 'handpump', -24.4, 36.2, { yaw: -Math.PI / 2 });
  addCircle(W, -24.4, 36.2, 0.32, 1.1, { tag: 'pump' });
  puddle(W, -25.4, 37.4, 0.95, true);
  W.pois.water.push({ x: -25.4, z: 37.4, kind: 'pump', clean: true });
  W.pois.landmarks.push({ id: 'pump', x: -25.4, z: 37.4, name: 'the hand pump' });
  charpai(W, -33.4, 45.4, 0);
  prop(W, 'planter', -24.2, 46, {});
  addBox(W, -24.8, 45.4, -23.6, 46.6, 0.7, { platform: true, tag: 'planter' });
  tree(W, rng, -34, 36.2, 'neem', 0.9, true);
  W.spawns.flocks.push({ x: -29, z: 44, n: 7, kind: 'pigeon' });
  lampPost(W, -34.6, 46.6, 4.2);

  /* ---- Sabzi Mandi ---- */
  placeMarket(W, rng);

  /* ---- Chowk corners ---- */
  // SW: the chai stall, where the day starts.
  const chai = stall(W, rng, -13.6, 14.3, Math.PI, 'chai', 2.2, 1.3);
  W.special.chai = { x: -13.6, z: 14.3, front: chai.front, vendor: chai.vendor };
  bench(W, -11, 12.3, Math.PI);
  bench(W, -15.6, 11.6, Math.PI / 2);
  prop(W, 'sacks', -8.4, 14.6, { n: 4 });
  addBox(W, -9.3, 14.0, -7.5, 15.2, 0.5, { platform: true, tag: 'sacks' });
  W.pois.sleep.push({ x: -8.4, z: 14.6, y: 0.68, tag: 'sacks', home: true });
  W.spawns.dog = { x: -8.4, z: 14.5, yaw: Math.PI * 0.85 };
  // NE: a little roadside shrine.
  prop(W, 'shrine', 13.6, -13.6, { yaw: -Math.PI * 0.75 });
  addBox(W, 12.8, -14.6, 14.6, -12.8, 1.6, { tag: 'shrine' });
  W.lights.push({ x: 13.4, y: 1.0, z: -13.4, r: 5, color: [1, 0.6, 0.3], kind: 'diya' });
  // NW: the traffic police booth.
  prop(W, 'kiosk', -13.2, -13.4, { yaw: Math.PI * 0.25 });
  addBox(W, -14.2, -14.4, -12.2, -12.4, 2.6, { tag: 'kiosk' });
  // SE: a fruit cart in the shade of the corner tree.
  tree(W, rng, 14.2, 14.2, 'neem', 1.0, true);
  cart(W, rng, 11.6, 13.6, Math.PI / 2, 'fruit');
  for (const [x, z] of [[-15.2, -15.2], [15.2, -15.2], [-15.2, 15.2], [15.2, 15.2]]) {
    if (!W.colliders.some((c) => c.kind === 'circle' && dist2(c.x, c.z, x, z) < 1)) lampPost(W, x, z, 6);
  }
  W.spawns.flocks.push({ x: -2.8, z: 3.2, n: 12, kind: 'pigeon', island: true });

  /* ---- MG Road: the bus stop and the auto stand ---- */
  prop(W, 'busstop', 30, 9.2, { yaw: Math.PI, w: 6 });
  addBox(W, 27, 9.6, 33, 10, 2.6, { tag: 'busstop' });
  addBox(W, 28, 9.0, 32, 9.6, 0.45, { platform: true, tag: 'bench' });
  W.shades.push({ kind: 'box', x0: 27, z0: 8.4, x1: 33, z1: 10, y0: 2.4, y1: 2.6 });
  W.special.busStop = { x: 30, z: 8.6, roadX: 31 };
  W.pois.sleep.push({ x: 30, z: 9.3, tag: 'busstop' });
  W.special.autoStand = { x0: -30, z0: -13, x1: -16, z1: -10 };
  for (let i = 0; i < 4; i++) {
    const x = -27.6 + i * 3.4;
    prop(W, 'parked', x, -11.6, { vtype: 'auto', yaw: Math.PI / 2 + (rng() - 0.5) * 0.2, color: i });
    addBox(W, x - 1.3, -12.3, x + 1.3, -10.9, 1.7, { tag: 'auto' });
  }
}

function placeMarket(W, rng) {
  const rowsZ = [25.0, 30.2, 35.4, 40.6, 45.8];
  const kinds = ['veg', 'veg', 'fruit', 'veg', 'banana', 'veg', 'fruit', 'veg'];
  const stalls = [];
  for (let r = 0; r < rowsZ.length; r++) {
    const z0 = rowsZ[r], z1 = z0 + 2.2;
    let x = 22.5;
    for (let seg = 0; seg < 4; seg++) {
      for (let s = 0; s < 3; s++) {
        const cx = x + 1.2 + s * 2.4;
        if (cx > 59.4) break;
        const kind = kinds[(r * 5 + seg * 3 + s) % kinds.length];
        stalls.push({ x: cx, z: (z0 + z1) / 2, kind, row: r });
      }
      x += 7.2 + 2.6;
    }
  }
  for (const s of stalls) {
    const yaw = s.row % 2 === 0 ? 0 : Math.PI; // vendor sits on alternating sides
    stall(W, rng, s.x, s.z, yaw, s.kind, 2.3, 2.1, true);
  }
  // Tarps over every row, strung on bamboo.
  for (let r = 0; r < rowsZ.length; r++) {
    const z0 = rowsZ[r] - 0.6, z1 = rowsZ[r] + 2.8;
    prop(W, 'tarp', 41, (z0 + z1) / 2, { x0: 22.2, x1: 59.8, z0, z1, color: hex(pick(rng, ['#2f6db5', '#e67e22', '#2f6db5', '#c0392b', '#16a085'])), y: 2.7 });
    W.shades.push({ kind: 'box', x0: 22.2, z0, x1: 59.8, z1, y0: 2.6, y1: 2.8 });
  }
  W.special.market = { x0: 20, z0: 22, x1: 62, z1: 54 };
  garbage(W, 60.6, 52.6, 1.4);
  cart(W, rng, 23.2, 51.8, 0, 'veg');
  cart(W, rng, 31, 51.9, 0, 'banana');
  W.spawns.flocks.push({ x: 50, z: 50, n: 9, kind: 'pigeon' });
  for (let i = 0; i < 5; i++) {
    for (let k = 0; k < 4; k++) {
      W.lights.push({ x: 26 + k * 10, y: 2.5, z: rowsZ[i] + 1.1, r: 6.5, color: [1.0, 0.82, 0.55], kind: 'bulb' });
    }
  }
}

/* -------------------------------------------------------------- prop kinds */

function stall(W, rng, x, z, yaw, kind, w, d, market) {
  const p = prop(W, 'stall', x, z, { yaw, kind, w, d, umbrella: !market && chance(rng, 0.6), color: hex(pick(rng, AWNING_COLORS)), seed: (rng() * 1e9) | 0 });
  const ax = Math.abs(Math.sin(yaw)) > 0.5;
  const hw = (ax ? d : w) / 2, hd = (ax ? w : d) / 2;
  addBox(W, x - hw, z - hd, x + hw, z + hd, kind === 'chai' ? 1.0 : 0.85, { tag: 'stall' });
  if (p.umbrella) W.shades.push({ kind: 'sphere', x, y: 2.3, z, r: 1.4 });
  // The vendor sits behind the stall, on the side away from the customers.
  p.vendor = { x: x - Math.sin(yaw) * (d / 2 + 0.45), z: z - Math.cos(yaw) * (d / 2 + 0.45), yaw };
  p.front = { x: x + Math.sin(yaw) * (d / 2 + 0.7), z: z + Math.cos(yaw) * (d / 2 + 0.7) };
  W.stalls.push(p);
  return p;
}

/**
 * A handcart: 1.7 m long, 1.0 m wide, customers on the `yaw` side of its long
 * flank. The vendor stands at the handle end so a kerbside cart never puts him in
 * the traffic.
 */
function cart(W, rng, x, z, yaw, kind) {
  const p = prop(W, 'cart', x, z, { yaw, kind, color: hex(pick(rng, AWNING_COLORS)), seed: (rng() * 1e9) | 0 });
  const ax = Math.abs(Math.sin(yaw)) > 0.5; // facing +-x: long axis runs along z
  const hx = ax ? 0.5 : 0.85, hz = ax ? 0.85 : 0.5;
  addBox(W, x - hx, z - hz, x + hx, z + hz, 0.95, { tag: 'cart' });
  const lx = Math.cos(yaw), lz = -Math.sin(yaw); // along the long axis
  p.vendor = { x: x + lx * 1.25 + Math.sin(yaw) * 0.2, z: z + lz * 1.25 + Math.cos(yaw) * 0.2, yaw: yaw - Math.PI / 2 };
  p.front = { x: x + Math.sin(yaw) * 1.1, z: z + Math.cos(yaw) * 1.1 };
  W.stalls.push(p);
  W.shades.push({ kind: 'sphere', x, y: 2.2, z, r: 1.3 });
  return p;
}

function bench(W, x, z, yaw) {
  prop(W, 'bench', x, z, { yaw });
  const ax = Math.abs(Math.sin(yaw)) > 0.5;
  const hw = ax ? 0.3 : 0.9, hd = ax ? 0.9 : 0.3;
  addBox(W, x - hw, z - hd, x + hw, z + hd, 0.45, { platform: true, tag: 'bench' });
  W.seats.push({ x, z, yaw, n: 2 });
}

function charpai(W, x, z, yaw) {
  prop(W, 'charpai', x, z, { yaw });
  const ax = Math.abs(Math.sin(yaw)) > 0.5;
  const hw = ax ? 0.5 : 0.95, hd = ax ? 0.95 : 0.5;
  addBox(W, x - hw, z - hd, x + hw, z + hd, 0.45, { platform: true, tag: 'charpai' });
  W.pois.sleep.push({ x, z, y: 0.45, tag: 'charpai' });
  W.seats.push({ x, z, yaw, n: 1, lie: true });
}

function tree(W, rng, x, z, kind, s, paint) {
  prop(W, 'tree', x, z, { kind, s, paint, seed: (rng() * 1e9) | 0 });
  addCircle(W, x, z, 0.28 * s, 7 * s, { tag: 'trunk' });
  W.shades.push({ kind: 'sphere', x, y: 5.2 * s, z, r: 3.4 * s });
  W.pois.posts.push({ x, z, tag: 'tree' });
}

function garbage(W, x, z, r) {
  prop(W, 'garbage', x, z, { r });
  addCircle(W, x, z, r * 0.75, 0.5, { platform: true, tag: 'garbage', block: true });
  W.pois.garbage.push({ x, z, r });
  W.pois.food.push({ x, z, kind: 'garbage' });
}

function puddle(W, x, z, r, permanent) {
  prop(W, 'puddle', x, z, { r, permanent: !!permanent });
  if (!permanent) W.pois.water.push({ x, z, kind: 'puddle', clean: false });
}

function lampPost(W, x, z, h) {
  prop(W, 'lamp', x, z, { h });
  addCircle(W, x, z, 0.12, h, { tag: 'post' });
  W.pois.posts.push({ x, z, tag: 'lamp' });
  W.lights.push({ x, y: h - 0.3, z, r: 9, color: [1.0, 0.78, 0.45], kind: 'lamp' });
}

/** An electric pole at the kerb; `arm` is the yaw its lamp leans out toward, or null. */
function pole(W, x, z, arm, line) {
  const p = prop(W, 'pole', x, z, { h: 8.2, arm, line, transformer: false });
  addCircle(W, x, z, 0.16, 8.2, { tag: 'post' });
  W.pois.posts.push({ x, z, tag: 'pole' });
  if (arm !== null) {
    const lx = x + Math.sin(arm) * 1.6, lz = z + Math.cos(arm) * 1.6;
    W.lights.push({ x: lx, y: 7.4, z: lz, r: 13, color: [1.0, 0.66, 0.32], kind: 'sodium' });
  }
  return p;
}

/* ------------------------------------------------------------ street props */

function placeStreetProps(W, rng) {
  const { mgHalf, bzHalf } = LAYOUT;

  /* Poles along MG Road, staggered on both kerbs, lamps leaning over the road. */
  W.poleLines = [];
  for (const side of [-1, 1]) {
    const line = [];
    const z = side * (mgHalf + 0.45);
    for (let x = -96 + (side > 0 ? 9 : 0); x <= 96; x += 18) {
      if (Math.abs(x) < 19) continue;
      const px = x + rand(rng, -1.2, 1.2);
      if (!propFree(W, px - 0.2, z - 0.2, px + 0.2, z + 0.2)) continue;
      line.push(pole(W, px, z, side > 0 ? Math.PI : 0, W.poleLines.length));
    }
    W.poleLines.push(line);
  }
  /* Bazaar Road */
  for (const side of [-1, 1]) {
    const line = [];
    const x = side * (bzHalf + 0.4);
    for (let z = -96 + (side > 0 ? 7 : 0); z <= 96; z += 14) {
      if (Math.abs(z) < 19) continue;
      const pz = z + rand(rng, -1, 1);
      if (!propFree(W, x - 0.2, pz - 0.2, x + 0.2, pz + 0.2)) continue;
      line.push(pole(W, x, pz, line.length % 2 === 0 ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : null, W.poleLines.length));
    }
    W.poleLines.push(line);
  }
  /* Galis: one line of poles hugging one wall, every ~13 m. */
  for (const a of AREAS) {
    if (a.s !== GALI) continue;
    const [x0, z0, x1, z1] = a.r;
    const horiz = x1 - x0 > z1 - z0;
    const line = [];
    const len = horiz ? x1 - x0 : z1 - z0;
    const side = chance(rng, 0.5) ? 0 : 1;
    for (let t = 3; t < len - 2; t += 13 + rand(rng, -1.5, 1.5)) {
      const px = horiz ? x0 + t : (side ? x1 - 0.35 : x0 + 0.35);
      const pz = horiz ? (side ? z1 - 0.35 : z0 + 0.35) : z0 + t;
      if (Math.abs(px) > PLAY_HALF + 2 || Math.abs(pz) > PLAY_HALF + 2) continue;
      if (!propFree(W, px - 0.25, pz - 0.25, px + 0.25, pz + 0.25)) continue;
      line.push(pole(W, px, pz, horiz ? (side ? Math.PI : 0) : (side ? -Math.PI / 2 : Math.PI / 2), W.poleLines.length));
    }
    if (line.length) W.poleLines.push(line);
  }

  /* MG Road median: black-and-yellow kerb, with gaps for the crossings. */
  for (const [a, b] of [[-100, -46], [-44, -19], [19, 44], [46, 100]]) {
    prop(W, 'median', (a + b) / 2, 0, { x0: a, x1: b });
    addBox(W, a, -LAYOUT.medianHalf, b, LAYOUT.medianHalf, 0.25, { platform: true, tag: 'median', block: false });
  }

  /* Trees along MG Road: painted trunks, in the kerb strip. */
  for (const side of [-1, 1]) {
    for (let x = -84 + (side > 0 ? 12 : 0); x <= 84; x += 24) {
      if (Math.abs(x) < 22) continue;
      const tx = x + rand(rng, -2, 2), tz = side * (mgHalf + 0.6);
      if (!propFree(W, tx - 0.4, tz - 0.4, tx + 0.4, tz + 0.4)) continue;
      tree(W, rng, tx, tz, pick(rng, ['neem', 'neem', 'ashoka', 'peepal']), rand(rng, 0.85, 1.15), true);
    }
  }

  /* The halwai's counter: the sweets shop nearest the chowk on MG Road's north side. */
  const sweets = W.buildings
    .filter((b) => b.kind === 'front' && b.face === 'S' && b.z1 === -LAYOUT.mgWalk && b.x0 >= 16 && b.x1 <= 60 && b.x1 - b.x0 >= 5)
    .sort((p, q) => p.x0 - q.x0)[0];
  if (sweets) {
    sweets.shop = makeShop(rng, 'main', 'sweets');
    sweets.shop.idx = 0;
    sweets.shop.awning = hex('#c0392b');
    sweets.special = 'halwai';
    const cx = (sweets.x0 + sweets.x1) / 2;
    prop(W, 'counter', cx, -8.65, { w: 2.4, d: 0.8 });
    addBox(W, cx - 1.2, -9.05, cx + 1.2, -8.25, 0.95, { tag: 'counter' });
    W.special.halwai = { x: cx, z: -8.65, front: { x: cx, z: -7.8 }, vendor: { x: cx, z: -9.55, yaw: 0 }, building: sweets.id };
    W.pois.food.push({ x: cx, z: -7.8, kind: 'counter' });
  }

  /* Bus stop dog: Kalu sleeps under the bench there. NPC dog homes. */
  W.spawns.dogs = [
    { id: 'kalu', name: 'Kalu', x: 31.5, z: 8.4, coat: 'black' },
    { id: 'moti', name: 'Moti', x: -24.6, z: -31.6, coat: 'spotted' },
    { id: 'sheru', name: 'Sheru', x: 21.5, z: 50.5, coat: 'tan' },
    { id: 'lali', name: 'Lali', x: -61, z: 60, coat: 'red', puppies: 3 },
  ];
  W.spawns.cows = [
    { x: 54, z: -3.2, lie: true, r: 4 },
    { x: 44, z: 49.6, r: 9 },
    { x: -29, z: 24, r: 10 },
    { x: -31, z: -47, r: 6 },
    { x: 1.5, z: -58, r: 14 },
    { x: -61, z: 30, r: 10 },
  ];

  /* Garbage, puddles, carts, clutter. */
  garbage(W, -72, -8.4, 1.3);
  garbage(W, -45, 41, 1.2);
  garbage(W, 76, 60, 1.2);
  garbage(W, 5.9, -78, 1.0);
  for (const [x, z] of [[-61.2, 64], [62, 3.2], [-2.6, 38], [-55, -64], [45, -9.4]]) puddle(W, x, z, rand(rng, 0.7, 1.2), false);

  // Fruit and vegetable carts along the bazaar kerbs.
  for (const z of [-30, -52, 24, 46, 63]) {
    const side = Math.abs(z) % 2 === 0 ? 1 : -1;
    const x = side * (bzHalf + 0.6);
    if (propFree(W, x - 0.55, z - 0.9, x + 0.55, z + 0.9)) cart(W, rng, x, z, side > 0 ? Math.PI / 2 : -Math.PI / 2, pick(rng, ['fruit', 'veg', 'banana', 'coconut']));
  }
  for (const x of [-58, -40, 24, 64]) {
    const z = x > 0 ? -(mgHalf + 0.6) : mgHalf + 0.6;
    if (propFree(W, x - 0.9, z - 0.55, x + 0.9, z + 0.55)) cart(W, rng, x, z, z > 0 ? 0 : Math.PI, pick(rng, ['fruit', 'banana', 'coconut']));
  }

  // Parked two-wheelers in short rows at the kerbs and by gali doors.
  // r is kept small on the narrow bazaar pavement so the walking line stays clear.
  const parkRow = (x, z, dx, dz, n, yaw, r = 0.45) => {
    for (let i = 0; i < n; i++) {
      const px = x + dx * i, pz = z + dz * i;
      if (!propFree(W, px - 0.3, pz - 0.3, px + 0.3, pz + 0.3)) continue;
      const vtype = pick(rng, ['scooter', 'scooter', 'bike', 'bike', 'cycle']);
      prop(W, 'parked', px, pz, { vtype, yaw: yaw + rand(rng, -0.15, 0.15), color: randInt(rng, 0, 7) });
      addCircle(W, px, pz, r, 1.1, { tag: 'bike' });
    }
  };
  for (const x of [-80, -64, -50, -12 - 9, 22, 52, 66, 82]) {
    const side = Math.abs(x) % 2 === 0 ? -1 : 1;
    parkRow(x, side * (mgHalf + 0.8), 0.9, 0, randInt(rng, 2, 5), Math.PI / 2 + 0.6);
  }
  for (const z of [-84, -58, -24, 28, 52, 80]) {
    const side = Math.abs(z) % 4 === 0 ? -1 : 1;
    parkRow(side * (bzHalf + 0.45), z, 0, 0.9, randInt(rng, 2, 4), 0.6, 0.32);
  }

  /* Gali life: charpais, drums, gas cylinders, scooters by the doors, cows' spots. */
  for (const a of AREAS) {
    if (a.s !== GALI) continue;
    const [x0, z0, x1, z1] = a.r;
    const horiz = x1 - x0 > z1 - z0;
    const len = horiz ? x1 - x0 : z1 - z0;
    for (let t = 2; t < len - 2; t += rand(rng, 4, 9)) {
      const side = chance(rng, 0.5);
      const inset = 0.55;
      const px = horiz ? x0 + t : (side ? x1 - inset : x0 + inset);
      const pz = horiz ? (side ? z1 - inset : z0 + inset) : z0 + t;
      if (Math.abs(px) > PLAY_HALF || Math.abs(pz) > PLAY_HALF) continue;
      const along = horiz ? Math.PI / 2 : 0;
      const roll = rng();
      if (roll < 0.22) {
        if (propFree(W, px - 0.4, pz - 0.4, px + 0.4, pz + 0.4)) {
          prop(W, 'parked', px, pz, { vtype: pick(rng, ['scooter', 'bike', 'cycle']), yaw: along + rand(rng, -0.2, 0.2), color: randInt(rng, 0, 7) });
          addCircle(W, px, pz, 0.42, 1.1, { tag: 'bike' });
        }
      } else if (roll < 0.34) {
        const cx = horiz ? px : (side ? px - 0.25 : px + 0.25), cz = horiz ? (side ? pz - 0.25 : pz + 0.25) : pz;
        const ax = horiz;
        if (propFree(W, cx - (ax ? 0.95 : 0.5), cz - (ax ? 0.5 : 0.95), cx + (ax ? 0.95 : 0.5), cz + (ax ? 0.5 : 0.95))) {
          charpai(W, cx, cz, ax ? 0 : Math.PI / 2);
        }
      } else if (roll < 0.62) {
        const kind = pick(rng, ['drum', 'cylinder', 'pots', 'crates', 'sacks', 'bucket', 'plant', 'cooler']);
        if (propFree(W, px - 0.3, pz - 0.3, px + 0.3, pz + 0.3)) {
          prop(W, 'clutter', px, pz, { kind, yaw: rand(rng, 0, TAU), seed: (rng() * 1e9) | 0 });
          addCircle(W, px, pz, 0.3, kind === 'crates' || kind === 'sacks' ? 0.6 : 0.8, { platform: kind === 'crates' || kind === 'sacks', tag: 'clutter' });
        }
      }
    }
  }

  /* Bunting across the galis and the bazaar; laundry between balconies. */
  for (const a of AREAS) {
    if (a.s !== GALI) continue;
    const [x0, z0, x1, z1] = a.r;
    const horiz = x1 - x0 > z1 - z0;
    const len = horiz ? x1 - x0 : z1 - z0;
    for (let t = 4; t < len - 3; t += rand(rng, 6, 11)) {
      const y = rand(rng, 4.4, 5.6);
      const p0 = horiz ? [x0 + t, y, z0 - 0.1] : [x0 - 0.1, y, z0 + t];
      const p1 = horiz ? [x0 + t + rand(rng, -2, 2), y + rand(rng, -0.4, 0.4), z1 + 0.1] : [x1 + 0.1, y + rand(rng, -0.4, 0.4), z0 + t + rand(rng, -2, 2)];
      if (Math.abs(p0[0]) > PLAY_HALF + 4 || Math.abs(p0[2]) > PLAY_HALF + 4) continue;
      if (chance(rng, 0.35)) {
        W.laundry.push({ a: p0.map((v, i) => (i === 1 ? v - 0.9 : v)), b: p1.map((v, i) => (i === 1 ? v - 0.9 : v)), seed: (rng() * 1e9) | 0 });
      } else {
        W.bunting.push({ a: p0, b: p1, seed: (rng() * 1e9) | 0, sag: rand(rng, 0.3, 0.8) });
      }
    }
  }
  for (const z of [-60, -36, 36, 60]) {
    W.bunting.push({ a: [-7.2, 6.8, z], b: [7.2, 6.8, z + rand(rng, -1.5, 1.5)], seed: (rng() * 1e9) | 0, sag: 0.9 });
  }

  /* Edges of the world: barricades on the pavements, gates at gali ends. */
  for (const s of [-1, 1]) {
    for (const z of [-8.5, 8.5]) prop(W, 'barricade', s * PLAY_HALF, z, { yaw: Math.PI / 2 });
    for (const x of [-5.75, 5.75]) prop(W, 'barricade', x, s * PLAY_HALF, { yaw: 0 });
  }
  for (const a of AREAS) {
    if (a.s !== GALI) continue;
    const [x0, z0, x1, z1] = a.r;
    if (x0 <= -PLAY_HALF) prop(W, 'gate', x0 + 0.1, (z0 + z1) / 2, { yaw: Math.PI / 2, w: z1 - z0 });
    if (x1 >= PLAY_HALF) prop(W, 'gate', x1 - 0.1, (z0 + z1) / 2, { yaw: Math.PI / 2, w: z1 - z0 });
  }

  /* Rangoli at a few doorsteps, posters on walls happen in finishBuildings. */
}

/* --------------------------------------------------------------------- wires */

function placeWires(W, rng) {
  const wire = (ax, ay, az, bx, by, bz, sag, color) => W.wires.push({ a: [ax, ay, az], b: [bx, by, bz], sag, color: color || 0 });
  for (const line of W.poleLines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const p = line[i], q = line[i + 1];
      if (dist2(p.x, p.z, q.x, q.z) > 24 * 24) continue;
      const n = randInt(rng, 2, 4);
      for (let k = 0; k < n; k++) {
        const y = 7.7 - k * 0.32;
        wire(p.x, y, p.z, q.x, y - rand(rng, -0.1, 0.1), q.z, rand(rng, 0.35, 1.1), k === 0 ? 1 : 0);
      }
      // The famous tangle: a loose bundle that hangs much lower near some poles.
      if (chance(rng, 0.3)) wire(p.x, 6.5, p.z, q.x, 6.6, q.z, rand(rng, 1.4, 2.4), 2);
    }
  }
  // House drops: pole to a facade within reach.
  const poles = W.props.filter((p) => p.type === 'pole');
  for (const b of W.buildings) {
    if (b.kind !== 'front' || !chance(rng, 0.55)) continue;
    const f = facadePoint(b, rand(rng, 0.2, 0.8));
    let best = null, bd = 14 * 14;
    for (const p of poles) {
      const d = dist2(p.x, p.z, f.x, f.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) continue;
    const y = Math.min(rand(rng, 4.2, 6.2), 3.4 + (b.floors - 1) * 3 - 0.4);
    wire(best.x, rand(rng, 6.4, 7.4), best.z, f.x, y, f.z, rand(rng, 0.3, 0.9), 0);
  }
  // A few wires straight across MG Road and the bazaar.
  const mg = W.poleLines[0] || [], mg2 = W.poleLines[1] || [];
  for (let i = 0; i < mg.length; i += 2) {
    const p = mg[i];
    let best = null, bd = 1e9;
    for (const q of mg2) {
      const d = Math.abs(q.x - p.x);
      if (d < bd) { bd = d; best = q; }
    }
    if (best && bd < 12) wire(p.x, 7.9, p.z, best.x, 7.9, best.z, rand(rng, 0.8, 1.6), 0);
  }
}

/** A point on a building's street face, t in 0..1 along it. */
export function facadePoint(b, t) {
  switch (b.face) {
    case 'S': return { x: b.x0 + (b.x1 - b.x0) * t, z: b.z1, nx: 0, nz: 1 };
    case 'N': return { x: b.x0 + (b.x1 - b.x0) * t, z: b.z0, nx: 0, nz: -1 };
    case 'E': return { x: b.x1, z: b.z0 + (b.z1 - b.z0) * t, nx: 1, nz: 0 };
    default: return { x: b.x0, z: b.z0 + (b.z1 - b.z0) * t, nx: -1, nz: 0 };
  }
}

export function facadeWidth(b) {
  return b.face === 'N' || b.face === 'S' ? b.x1 - b.x0 : b.z1 - b.z0;
}

/* --------------------------------------------------------- building details */

function finishBuildings(W, rng) {
  for (const b of W.buildings) {
    b.groundH = b.shop ? 3.6 : 3.2;
    b.h = b.groundH + (b.floors - 1) * 3.0;
    if (b.kind === 'back') {
      b.roof.tank = chance(rng, 0.55);
      b.roof.rebar = chance(rng, 0.2);
      continue;
    }
    const fw = facadeWidth(b);
    b.balconies = b.floors > 1 && chance(rng, 0.55);
    b.roof.tank = chance(rng, 0.75);
    b.roof.dish = chance(rng, 0.25);
    b.roof.rebar = chance(rng, 0.18);
    b.roof.hut = b.floors >= 3 && chance(rng, 0.3);
    if (b.front === 'main' && fw >= 6 && chance(rng, 0.12)) b.roof.billboard = randInt(rng, 0, WALL_ADS.length - 1);
    if (b.floors > 1 && fw >= 5 && chance(rng, b.front === 'main' || b.front === 'bazaar' ? 0.3 : 0.08)) b.upperSign = randInt(rng, 0, UPPER_SIGNS.length - 1);
    if (!b.shop && chance(rng, 0.12)) b.wallAd = randInt(rng, 0, WALL_ADS.length - 1);
    b.rangoli = !b.shop && (b.front === 'gali' || b.front === 'court') && chance(rng, 0.25);

    // Awnings shade the pavement in front of the shop.
    if (b.shop && b.shop.awning) {
      const f0 = facadePoint(b, 0), f1 = facadePoint(b, 1);
      const depth = b.front === 'gali' ? 1.0 : 1.6;
      const ex = f0.nx * depth, ez = f0.nz * depth;
      W.shades.push({ kind: 'box', x0: Math.min(f0.x, f1.x, f0.x + ex, f1.x + ex), z0: Math.min(f0.z, f1.z, f0.z + ez, f1.z + ez), x1: Math.max(f0.x, f1.x, f0.x + ex, f1.x + ex), z1: Math.max(f0.z, f1.z, f0.z + ez, f1.z + ez), y0: 2.7, y1: 2.9 });
    }
    // Shop fronts glow at night.
    if (b.shop) {
      const f = facadePoint(b, 0.5);
      W.lights.push({ x: f.x + f.nx * 0.9, y: 2.6, z: f.z + f.nz * 0.9, r: 7, color: [0.85, 0.95, 1.0], kind: 'shop' });
      if (SHOP_TYPES[b.shop.type].food === 'beg') {
        W.pois.food.push({ x: f.x + f.nx * 1.4, z: f.z + f.nz * 1.4, kind: 'shop', building: b.id });
      }
    }
  }

  // Aunty's house: the courtyard house nearest its east side, painted pink with a blue door.
  const court = W.buildings
    .filter((b) => b.kind === 'front' && b.front === 'court')
    .sort((p, q) => dist2((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, -22, 45) - dist2((q.x0 + q.x1) / 2, (q.z0 + q.z1) / 2, -22, 45))[0];
  if (court) {
    court.special = 'aunty';
    court.shop = null;
    court.wall = hex('#ef9ab2');
    court.door = hex('#2b59c3');
    court.rangoli = true;
    court.balconies = true;
    const f = facadePoint(court, 0.5);
    W.special.aunty = {
      building: court.id,
      door: { x: f.x + f.nx * 0.5, z: f.z + f.nz * 0.5 },
      bowl: { x: f.x + f.nx * 1.3 + f.nz * 0.8, z: f.z + f.nz * 1.3 + f.nx * 0.8 },
      yaw: Math.atan2(f.nx, f.nz),
    };
    W.pois.food.push({ x: W.special.aunty.bowl.x, z: W.special.aunty.bowl.z, kind: 'aunty' });
    W.pois.water.push({ x: W.special.aunty.bowl.x, z: W.special.aunty.bowl.z, kind: 'bowl', clean: true });
    W.pois.landmarks.push({ id: 'aunty', x: W.special.aunty.bowl.x, z: W.special.aunty.bowl.z, name: "Aunty's house" });
  }
}

/* ------------------------------------------------------------ vehicle routes */

/**
 * Arms of the roundabout. `inStart` is where traffic appears out of the haze,
 * `outEnd` where it leaves. Inbound is on the left of the road for its direction.
 */
export const ARMS = [
  { id: 'W', inStart: [-100, -LAYOUT.mgLane], inDir: [1, 0], outEnd: [-100, LAYOUT.mgLane], outDir: [-1, 0], halfW: LAYOUT.mgLaneHalf, speed: 11, road: 'mg' },
  { id: 'E', inStart: [100, LAYOUT.mgLane], inDir: [-1, 0], outEnd: [100, -LAYOUT.mgLane], outDir: [1, 0], halfW: LAYOUT.mgLaneHalf, speed: 11, road: 'mg' },
  { id: 'N', inStart: [LAYOUT.bzLane, -100], inDir: [0, 1], outEnd: [-LAYOUT.bzLane, -100], outDir: [0, -1], halfW: LAYOUT.bzLaneHalf, speed: 8, road: 'bazaar' },
  { id: 'S', inStart: [-LAYOUT.bzLane, 100], inDir: [0, -1], outEnd: [LAYOUT.bzLane, 100], outDir: [0, 1], halfW: LAYOUT.bzLaneHalf, speed: 8, road: 'bazaar' },
];

const ENTRY_R = 15.5;   // where an arm hands over to its curve into the ring
const RING_DELTA = 0.42; // radians of ring used by each entry / exit curve
const RING_SPEED = 5.5;

/** Point on a carriageway centreline at radius ENTRY_R from the chowk. */
function armPointAtRadius(start, dir, r) {
  // start + dir * t, solve |p| = r for the t nearest the chowk.
  const px = start[0], pz = start[1];
  const b = px * dir[0] + pz * dir[1];
  const c = px * px + pz * pz - r * r;
  const disc = Math.sqrt(Math.max(0, b * b - c));
  const t = -b - disc;
  return [px + dir[0] * t, pz + dir[1] * t];
}

function bezier(p0, p1, p2, p3, n, out) {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

/**
 * Every (arm in, arm out) pair becomes a route: a polyline resampled every 0.5 m,
 * with per-sample tangent, speed limit, carriageway half-width and a ring flag.
 */
export function buildRoutes() {
  const routes = [];
  const R = LAYOUT.ringMid;
  for (const A of ARMS) {
    const entry = armPointAtRadius(A.inStart, A.inDir, ENTRY_R);
    const thIn = Math.atan2(entry[1], entry[0]);
    for (const B of ARMS) {
      const exit = armPointAtRadius(B.outEnd, [-B.outDir[0], -B.outDir[1]], ENTRY_R);
      let thOut = Math.atan2(exit[1], exit[0]);
      const ringA = thIn + RING_DELTA;
      while (thOut - RING_DELTA < ringA + 0.05) thOut += TAU;
      const ringB = thOut - RING_DELTA;

      const pts = [[A.inStart[0], A.inStart[1]], entry];
      const tags = [0, 0];
      const p2 = [R * Math.cos(ringA), R * Math.sin(ringA)];
      const t2 = [-Math.sin(ringA), Math.cos(ringA)];
      const k = 4.5;
      const before = pts.length;
      bezier(entry, [entry[0] + A.inDir[0] * k, entry[1] + A.inDir[1] * k], [p2[0] - t2[0] * k * 0.8, p2[1] - t2[1] * k * 0.8], p2, 14, pts);
      for (let i = before; i < pts.length; i++) tags.push(1);
      const steps = Math.max(2, Math.ceil(((ringB - ringA) * R) / 0.75));
      for (let i = 1; i <= steps; i++) {
        const th = ringA + ((ringB - ringA) * i) / steps;
        pts.push([R * Math.cos(th), R * Math.sin(th)]);
        tags.push(2);
      }
      const p3 = [R * Math.cos(ringB), R * Math.sin(ringB)];
      const t3 = [-Math.sin(ringB), Math.cos(ringB)];
      const before2 = pts.length;
      bezier(p3, [p3[0] + t3[0] * k * 0.8, p3[1] + t3[1] * k * 0.8], [exit[0] - B.outDir[0] * k, exit[1] - B.outDir[1] * k], exit, 14, pts);
      for (let i = before2; i < pts.length; i++) tags.push(3);
      pts.push([B.outEnd[0], B.outEnd[1]]);
      tags.push(4);

      const route = resampleRoute(pts, tags, A, B);
      route.from = A.id;
      route.to = B.id;
      route.turn = turnKind(A.id, B.id);
      routes.push(route);
    }
  }
  return routes;
}

function turnKind(a, b) {
  if (a === b) return 'u';
  const order = ['W', 'N', 'E', 'S']; // circulation order around the ring
  const d = (order.indexOf(b) - order.indexOf(a) + 4) % 4;
  return d === 1 ? 'left' : d === 2 ? 'straight' : 'right';
}

function resampleRoute(pts, tags, A, B) {
  // cumulative length of the raw polyline
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const step = 0.5;
  const n = Math.floor(total / step) + 1;
  const x = new Float32Array(n), z = new Float32Array(n), tx = new Float32Array(n), tz = new Float32Array(n);
  const speed = new Float32Array(n), halfW = new Float32Array(n), tag = new Uint8Array(n);
  let seg = 1;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    while (seg < pts.length - 1 && cum[seg] < s) seg++;
    const s0 = cum[seg - 1], s1 = cum[seg];
    const u = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    x[i] = pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * u;
    z[i] = pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * u;
    tag[i] = tags[seg];
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = x[b] - x[a], dz = z[b] - z[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
    const t = tag[i];
    const r = Math.hypot(x[i], z[i]);
    if (t === 0) {
      speed[i] = A.speed; halfW[i] = A.halfW;
    } else if (t === 4) {
      speed[i] = B.speed; halfW[i] = B.halfW;
    } else {
      speed[i] = RING_SPEED;
      halfW[i] = t === 2 ? 3.2 : Math.min(3.0, t === 1 ? A.halfW : B.halfW);
    }
    // Ease the speed limit down approaching the chowk so nobody brakes at the line.
    if ((t === 0 || t === 4) && r < 34) speed[i] = Math.min(speed[i], RING_SPEED + (r - ENTRY_R) * 0.32);
  }
  let ringStart = -1, ringEnd = -1, entryS = 0;
  for (let i = 0; i < n; i++) {
    if (tag[i] === 1 && entryS === 0) entryS = i * step;
    if (tag[i] === 2 && ringStart < 0) ringStart = i * step;
    if (tag[i] === 2) ringEnd = i * step;
  }
  return { n, step, length: (n - 1) * step, x, z, tx, tz, speed, halfW, tag, ringStart, ringEnd, entryS, ringAngle: Math.atan2(z[Math.round(ringStart / step)], x[Math.round(ringStart / step)]) };
}

/** Sample a route at arc length s with lateral offset d (positive = to the right). */
export function routePose(route, s, d, out) {
  const f = clamp(s / route.step, 0, route.n - 1);
  const i = Math.min(route.n - 2, Math.floor(f)), u = f - i;
  const tx = route.tx[i] + (route.tx[i + 1] - route.tx[i]) * u;
  const tz = route.tz[i] + (route.tz[i + 1] - route.tz[i]) * u;
  const l = Math.hypot(tx, tz) || 1;
  const nx = -tz / l, nz = tx / l; // right-hand normal
  out.x = route.x[i] + (route.x[i + 1] - route.x[i]) * u + nx * d;
  out.z = route.z[i] + (route.z[i + 1] - route.z[i]) * u + nz * d;
  out.tx = tx / l;
  out.tz = tz / l;
  out.halfW = route.halfW[i];
  out.speed = route.speed[i];
  out.tag = route.tag[i];
  return out;
}

/* ------------------------------------------------------------ pedestrian graph */

/**
 * Pedestrians walk a graph laid over the open areas: centrelines along every
 * narrow strip, a lattice across every wide one, joined wherever a straight walk
 * between two nodes stays on open, unobstructed pavement. Road crossings are
 * explicit edges — zebras at the chowk, and the jaywalking spots everyone uses.
 */
function buildPedGraph(W) {
  const nodes = []; // {x, z, w (half-width for lateral spread), kind}
  const add = (x, z, w, kind) => {
    if (!pedWalkable(W, x, z)) {
      // nudge off a prop if possible
      for (const r of [0.5, 1.0, 1.5]) {
        for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
          if (pedWalkable(W, x + dx, z + dz)) return add2(x + dx, z + dz, w, kind);
        }
      }
      return -1;
    }
    return add2(x, z, w, kind);
  };
  const add2 = (x, z, w, kind) => {
    for (let i = 0; i < nodes.length; i++) if (dist2(nodes[i].x, nodes[i].z, x, z) < 1.0) return i;
    nodes.push({ x, z, w, kind: kind || 'walk', edges: [] });
    return nodes.length - 1;
  };

  for (const a of AREAS) {
    if (a.s === ROAD) continue;
    let [x0, z0, x1, z1] = a.r;
    x0 = Math.max(x0, -PLAY_HALF - 3); z0 = Math.max(z0, -PLAY_HALF - 3);
    x1 = Math.min(x1, PLAY_HALF + 3); z1 = Math.min(z1, PLAY_HALF + 3);
    const w = x1 - x0, h = z1 - z0;
    if (w <= 0 || h <= 0) continue;
    if (Math.min(w, h) <= 6.5) {
      const horiz = w >= h;
      const len = horiz ? w : h;
      const segs = Math.max(1, Math.ceil(len / 5.5));
      const half = (horiz ? h : w) / 2;
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        const x = horiz ? x0 + w * t : (x0 + x1) / 2;
        const z = horiz ? (z0 + z1) / 2 : z0 + h * t;
        add(x, z, Math.max(0.2, half - 0.65));
      }
    } else {
      const sp = 4.5;
      const nx = Math.max(1, Math.round((w - 2) / sp)), nz = Math.max(1, Math.round((h - 2) / sp));
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= nz; j++) {
          add(x0 + 1 + ((w - 2) * i) / nx, z0 + 1 + ((h - 2) * j) / nz, 1.2);
        }
      }
    }
  }

  // Crossings: zebras at the chowk, and the places people just walk across.
  const crossings = [];
  const { mgWalk, mgHalf, bzWalk, bzHalf } = LAYOUT;
  const mgZ = (mgHalf + mgWalk) / 2, bzX = (bzHalf + bzWalk) / 2;
  crossings.push([-15.75, -mgZ, -15.75, mgZ, 'zebra'], [15.75, -mgZ, 15.75, mgZ, 'zebra']);
  crossings.push([-bzX, -15.75, bzX, -15.75, 'zebra'], [-bzX, 15.75, bzX, 15.75, 'zebra']);
  for (const x of [-70, -51, -29, 27, 49, 69]) crossings.push([x, -mgZ, x, mgZ, 'jay']);
  for (const z of [-62, -47, -27, 26, 47, 61]) crossings.push([-bzX, z, bzX, z, 'jay']);
  const crossPairs = [];
  for (const [ax, az, bx, bz, kind] of crossings) {
    const a = add(ax, az, 0.8, 'curb'), b = add(bx, bz, 0.8, 'curb');
    if (a >= 0 && b >= 0) crossPairs.push([a, b, kind]);
  }

  // Destinations: shop doors, stalls, seats, the temple, the pump, the bus stop.
  const dests = [];
  const addDest = (x, z, yaw, kind, extra) => {
    const node = add(x, z, 0.3, 'dest');
    if (node >= 0) dests.push(Object.assign({ node, x: nodes[node].x, z: nodes[node].z, yaw, kind, busy: 0 }, extra || {}));
  };
  for (const b of W.buildings) {
    if (b.kind !== 'front' || !b.shop) continue;
    const f = facadePoint(b, 0.5);
    const x = f.x + f.nx * 0.9, z = f.z + f.nz * 0.9;
    if (Math.abs(x) > PLAY_HALF || Math.abs(z) > PLAY_HALF) continue;
    addDest(x, z, Math.atan2(-f.nx, -f.nz), 'shop', { building: b.id, cap: 2 });
  }
  for (const p of W.stalls || []) {
    const fx = p.x + Math.sin(p.yaw) * 1.6, fz = p.z + Math.cos(p.yaw) * 1.6;
    addDest(fx, fz, p.yaw + Math.PI, 'stall', { cap: 2 });
  }
  for (const s of W.seats || []) {
    if (s.lie) continue;
    addDest(s.x + Math.sin(s.yaw) * 0.45, s.z + Math.cos(s.yaw) * 0.45, s.yaw, 'seat', { seat: s, cap: s.n });
  }
  if (W.special.temple) addDest(-36, -37.4, Math.PI, 'pray', { cap: 6 });
  addDest(-24.9, 37.2, -Math.PI / 2, 'pump', { cap: 1 });
  addDest(29, 8.4, 0, 'wait', { cap: 5, bus: true });
  addDest(-37, -31.5, 0, 'feed', { cap: 3 });

  // Portals: where people arrive from and leave to — the far ends of the roads.
  const portals = [];
  for (const [x, z] of [[-PLAY_HALF - 2, -mgZ], [-PLAY_HALF - 2, mgZ], [PLAY_HALF + 2, -mgZ], [PLAY_HALF + 2, mgZ], [-bzX, -PLAY_HALF - 2], [bzX, -PLAY_HALF - 2], [-bzX, PLAY_HALF + 2], [bzX, PLAY_HALF + 2]]) {
    const n = add(x, z, 0.8, 'portal');
    if (n >= 0) portals.push(n);
  }

  // Edges: every pair within reach whose straight line stays on clear pavement.
  const reach = 7.6;
  const cell = 8;
  const bucket = new Map();
  const key = (x, z) => Math.floor((x + 200) / cell) * 1000 + Math.floor((z + 200) / cell);
  nodes.forEach((n, i) => {
    const k = key(n.x, n.z);
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k).push(i);
  });
  const link = (a, b, cost, kind) => {
    if (a === b || nodes[a].edges.some((e) => e.to === b)) return;
    nodes[a].edges.push({ to: b, cost, kind });
    nodes[b].edges.push({ to: a, cost, kind });
  };
  for (let a = 0; a < nodes.length; a++) {
    const na = nodes[a];
    const ca = Math.floor((na.x + 200) / cell), cb = Math.floor((na.z + 200) / cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = bucket.get((ca + di) * 1000 + cb + dj);
        if (!list) continue;
        for (const b of list) {
          if (b <= a) continue;
          const nb = nodes[b];
          const d = Math.sqrt(dist2(na.x, na.z, nb.x, nb.z));
          if (d > reach) continue;
          if (clearLine(W, na.x, na.z, nb.x, nb.z)) link(a, b, d, 'walk');
        }
      }
    }
  }
  for (const [a, b, kind] of crossPairs) {
    const d = Math.sqrt(dist2(nodes[a].x, nodes[a].z, nodes[b].x, nodes[b].z));
    link(a, b, d * (kind === 'zebra' ? 1.6 : 3.2), kind);
  }

  // Keep only the largest connected component; an island of nodes behind a stall
  // is a place people would spawn into and never leave.
  const comp = new Int32Array(nodes.length).fill(-1);
  let best = -1, bestSize = 0;
  for (let s = 0, c = 0; s < nodes.length; s++) {
    if (comp[s] >= 0) continue;
    let size = 0;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const e of nodes[u].edges) if (comp[e.to] < 0) { comp[e.to] = c; stack.push(e.to); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  for (let i = 0; i < nodes.length; i++) nodes[i].ok = comp[i] === best;
  return {
    nodes,
    dests: dests.filter((d) => nodes[d.node].ok),
    portals: portals.filter((p) => nodes[p].ok),
    walkNodes: nodes.map((n, i) => i).filter((i) => nodes[i].ok && nodes[i].kind === 'walk'),
  };
}

/** Straight walk from a to b over open pavement, never onto the carriageway. */
export function clearLine(W, ax, az, bx, bz) {
  const d = Math.sqrt(dist2(ax, az, bx, bz));
  const steps = Math.max(1, Math.ceil(d / 0.25));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!pedWalkable(W, ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}

/** A* over the pedestrian graph. Returns node indices from a to b, or null. */
export function pedPath(G, a, b) {
  if (a === b) return [a];
  const n = G.nodes.length;
  const g = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = [a];
  g[a] = 0;
  const bx = G.nodes[b].x, bz = G.nodes[b].z;
  const h = (i) => Math.hypot(G.nodes[i].x - bx, G.nodes[i].z - bz);
  const f = new Float32Array(n).fill(Infinity);
  f[a] = h(a);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const u = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (u === b) {
      const path = [b];
      let c = b;
      while (came[c] >= 0) { c = came[c]; path.push(c); }
      return path.reverse();
    }
    closed[u] = 1;
    for (const e of G.nodes[u].edges) {
      if (closed[e.to]) continue;
      const ng = g[u] + e.cost;
      if (ng < g[e.to]) {
        if (g[e.to] === Infinity) open.push(e.to);
        g[e.to] = ng;
        f[e.to] = ng + h(e.to);
        came[e.to] = u;
      }
    }
  }
  return null;
}

/** Nearest usable graph node to a point (linear scan; called rarely). */
export function nearestPedNode(G, x, z, filter) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < G.nodes.length; i++) {
    const nd = G.nodes[i];
    if (!nd.ok || (filter && !filter(nd))) continue;
    const d = dist2(nd.x, nd.z, x, z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* ------------------------------------------------------------- sun & shade */

/**
 * Is the point (x, y, z) shaded from a sun in direction (sx, sy, sz)? Marches the
 * ray across the collider index; buildings, awnings, canopies and roofs all count.
 */
export function inShade(W, x, y, z, sx, sy, sz) {
  if (sy <= 0.02) return true;
  const maxH = 22;
  const len = Math.min(60, (maxH - y) / sy);
  const scratch = W._shadeScratch || (W._shadeScratch = []);
  for (let t = 0.4; t < len; t += 0.8) {
    const px = x + sx * t, py = y + sy * t, pz = z + sz * t;
    collidersNear(W, px, pz, 0.01, scratch);
    for (const idx of scratch) {
      const c = W.colliders[idx];
      if (py > c.y1 || py < c.y0) continue;
      if (c.kind === 'box') {
        if (px >= c.x0 && px <= c.x1 && pz >= c.z0 && pz <= c.z1) return true;
      } else if (c.tag !== 'island' && dist2(px, pz, c.x, c.z) <= c.r * c.r) return true;
    }
  }
  for (const s of W.shades) {
    if (s.kind === 'sphere') {
      // ray-sphere test
      const ox = x - s.x, oy = y - s.y, oz = z - s.z;
      const b = ox * sx + oy * sy + oz * sz;
      const c = ox * ox + oy * oy + oz * oz - s.r * s.r;
      if (b * b - c >= 0 && -b + Math.sqrt(b * b - c) > 0) return true;
    } else {
      // ray-box (slab) test
      let t0 = 0, t1 = 80;
      const slab = (o, d, lo, hi) => {
        if (Math.abs(d) < 1e-6) return o >= lo && o <= hi;
        let a = (lo - o) / d, b2 = (hi - o) / d;
        if (a > b2) { const tmp = a; a = b2; b2 = tmp; }
        t0 = Math.max(t0, a); t1 = Math.min(t1, b2);
        return t0 <= t1;
      };
      if (slab(x, sx, s.x0, s.x1) && slab(y, sy, s.y0, s.y1) && slab(z, sz, s.z0, s.z1)) return true;
    }
  }
  return false;
}
