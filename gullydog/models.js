/*
 * models.js — every moving thing, built from boxes at load time.
 *
 * Each model faces +Z with its feet (or wheels) on y = 0, and is split into
 * BONES: rigid parts that rotate about a pivot, each with a parent. rig.js poses
 * them; the shader moves each vertex by its bone's matrix. A model is
 *   { name, mesh, bones: [{ name, parent, pivot }] }
 *
 * Colour slots (see geom.js) let one mesh dress a whole crowd:
 *   people   1 skin   2 top (shirt/kurta/saree)   3 bottom (trousers/blouse)   4 hair/cap
 *   dogs     1 coat   2 light (chest, socks)       3 dark (saddle, muzzle)     4 collar
 *   cattle   1 hide   2 muzzle & hooves            3 horns                     4 spare
 *   birds    1 body   2 wings                       3 neck sheen                4 spare
 *   vehicles 1 body   2 secondary (roof, stripe)    3 seats & trim              4 spare
 */

import { MeshBuilder } from './geom.js';
import { hex } from './util.js';

const WHITE = [1, 1, 1];
const BLACK = hex('#1a1714');
const TYRE = hex('#1d1d1f');
const CHROME = hex('#b8bcc2');
const GLASS = hex('#2c3a46');
const HEADLIGHT = hex('#fff6d8');
const TAILLIGHT = hex('#e8202a');
const CHAPPAL = hex('#3b2b20');

function model(name, bones, build) {
  const b = new MeshBuilder();
  build(b);
  return { name, mesh: b.build(), bones, boneCount: bones.length };
}

/* ======================================================================= DOG */

export const DOG_BONES = [
  { name: 'body', parent: -1, pivot: [0, 0.45, 0] },
  { name: 'head', parent: 0, pivot: [0, 0.5, 0.3] },
  { name: 'jaw', parent: 1, pivot: [0, 0.64, 0.53] },
  { name: 'tail', parent: 0, pivot: [0, 0.53, -0.33] },
  { name: 'tailTip', parent: 3, pivot: [0, 0.63, -0.43] },
  { name: 'flU', parent: 0, pivot: [0.075, 0.46, 0.25] },
  { name: 'flL', parent: 5, pivot: [0.075, 0.26, 0.26] },
  { name: 'frU', parent: 0, pivot: [-0.075, 0.46, 0.25] },
  { name: 'frL', parent: 7, pivot: [-0.075, 0.26, 0.26] },
  { name: 'blU', parent: 0, pivot: [0.075, 0.47, -0.24] },
  { name: 'blL', parent: 9, pivot: [0.075, 0.25, -0.28] },
  { name: 'brU', parent: 0, pivot: [-0.075, 0.47, -0.24] },
  { name: 'brL', parent: 11, pivot: [-0.075, 0.25, -0.28] },
  { name: 'earL', parent: 1, pivot: [0.055, 0.76, 0.45] },
  { name: 'earR', parent: 1, pivot: [-0.055, 0.76, 0.45] },
];

export function buildDog() {
  return model('dog', DOG_BONES, (b) => {
    b.color(WHITE);
    // ---- body (bone 0)
    b.bone(0).slot(1);
    b.taper(0, 0.3, 0.22, 0.13, 0.25, 0.565, 0.21, 0.3);          // chest, deep and narrow at the keel
    b.taper(0, 0.37, -0.02, 0.11, 0.26, 0.55, 0.17, 0.26);        // loin, tucked up
    b.taper(0, 0.35, -0.24, 0.15, 0.2, 0.57, 0.19, 0.22);         // hips
    b.slot(2);
    b.taper(0, 0.33, 0.352, 0.07, 0.03, 0.5, 0.11, 0.035);         // cream blaze down the chest
    b.box(-0.05, 0.355, -0.15, 0.05, 0.375, 0.12, { skip: 't' }); // pale belly
    b.slot(3);
    b.box(-0.07, 0.555, -0.3, 0.07, 0.585, 0.26, { skip: 'b' });  // darker saddle along the spine
    // ---- head (bone 1): neck, skull, muzzle
    b.bone(1).slot(1);
    b.push().translate(0, 0.585, 0.37).rotate(0, 0.65, 0);
    b.boxC(0, 0, 0, 0.115, 0.22, 0.13);                            // neck, leaning forward
    b.slot(4).boxC(0, -0.03, 0, 0.13, 0.035, 0.145);               // collar
    b.pop();
    b.slot(1);
    b.taper(0, 0.62, 0.465, 0.15, 0.17, 0.77, 0.13, 0.15);         // skull
    b.slot(3);
    b.taper(0, 0.635, 0.6, 0.075, 0.13, 0.7, 0.06, 0.12, 0.004);   // muzzle (dark mask)
    b.color(BLACK).slot(0);
    b.boxC(0, 0.69, 0.667, 0.045, 0.035, 0.03);                   // nose
    b.boxC(0.05, 0.712, 0.553, 0.024, 0.024, 0.012);               // eyes
    b.boxC(-0.05, 0.712, 0.553, 0.024, 0.024, 0.012);
    b.color(hex('#f2c94c')).boxC(0, 0.535, 0.43, 0.03, 0.03, 0.03); // the bell on the collar
    b.color(WHITE);
    // ---- jaw (bone 2) with a tongue that shows when it opens
    b.bone(2).slot(2);
    b.boxC(0, 0.628, 0.6, 0.062, 0.03, 0.12);
    b.slot(0).color(hex('#e07a8a'));
    b.boxC(0, 0.646, 0.6, 0.045, 0.01, 0.1);
    b.color(WHITE);
    // ---- ears (13, 14): upright, pointed
    b.slot(1).bone(13);
    b.pyramid(0.052, 0.76, 0.45, 0.028, 0.02, 0.855, 0.012, -0.006);
    b.bone(14);
    b.pyramid(-0.052, 0.76, 0.45, 0.028, 0.02, 0.855, -0.012, -0.006);
    b.slot(3).bone(13).pyramid(0.058, 0.825, 0.447, 0.011, 0.008, 0.86, 0.006, -0.004);
    b.bone(14).pyramid(-0.058, 0.825, 0.447, 0.011, 0.008, 0.86, -0.006, -0.004);
    // ---- tail (3, 4): the Indie's sickle tail, carried up over the back
    b.slot(1).bone(3);
    b.rod([0, 0.53, -0.33], [0, 0.635, -0.435], 0.033, 6);
    b.bone(4);
    b.rod([0, 0.63, -0.43], [0, 0.73, -0.37], 0.034, 6, { r1: 0.02 });
    b.slot(2).rod([0, 0.725, -0.372], [0, 0.755, -0.335], 0.02, 5, { r1: 0.006 });
    // ---- legs
    const leg = (side, front) => {
      const x = side * 0.075;
      const ub = front ? (side > 0 ? 5 : 7) : side > 0 ? 9 : 11;
      const z = front ? 0.25 : -0.24;
      b.bone(ub).slot(1);
      if (front) b.boxC(x, 0.36, z + 0.005, 0.07, 0.22, 0.085);
      else b.taper(x, 0.25, z - 0.03, 0.075, 0.1, 0.48, 0.085, 0.15, 0.03);
      b.bone(ub + 1).slot(1);
      const lz = front ? 0.26 : -0.28;
      b.boxC(x, 0.145, lz, 0.05, 0.23, 0.055);
      b.slot(2);
      b.boxC(x, 0.022, lz + 0.03, 0.06, 0.044, 0.09);             // white sock / paw
    };
    leg(1, true); leg(-1, true); leg(1, false); leg(-1, false);
  });
}

/* ===================================================================== PEOPLE */

export const HUMAN_BONES = [
  { name: 'hips', parent: -1, pivot: [0, 0.92, 0] },
  { name: 'torso', parent: 0, pivot: [0, 0.98, 0] },
  { name: 'head', parent: 1, pivot: [0, 1.43, 0] },
  { name: 'armL', parent: 1, pivot: [0.19, 1.37, 0] },
  { name: 'foreL', parent: 3, pivot: [0.205, 1.1, 0] },
  { name: 'armR', parent: 1, pivot: [-0.19, 1.37, 0] },
  { name: 'foreR', parent: 5, pivot: [-0.205, 1.1, 0] },
  { name: 'thighL', parent: 0, pivot: [0.085, 0.9, 0] },
  { name: 'shinL', parent: 7, pivot: [0.085, 0.48, 0] },
  { name: 'thighR', parent: 0, pivot: [-0.085, 0.9, 0] },
  { name: 'shinR', parent: 9, pivot: [-0.085, 0.48, 0] },
];

/**
 * One body with options:
 *   lower: 'trousers' | 'kurta' | 'lungi' | 'saree' | 'salwar' | 'shorts' | 'frock'
 *   top:   'shirt' | 'blouse' | 'tee'
 *   hair:  'short' | 'bun' | 'braid' | 'turban' | 'cap' | 'bald' | 'pigtails'
 *   extras: mustache, bindi, stick, bat, beard, sleeves ('half' | 'full')
 */
function buildPerson(name, o) {
  return model(name, HUMAN_BONES, (b) => {
    const sleeves = o.sleeves || 'half';
    b.color(WHITE);
    // ---- hips (0)
    b.bone(0).slot(o.lower === 'saree' ? 2 : 3);
    b.boxC(0, 0.92, 0, 0.3, 0.14, 0.19);
    if (o.lower === 'kurta' || o.lower === 'salwar') {
      b.slot(2);
      b.taper(0, 0.5, 0, 0.36, 0.25, 0.98, 0.31, 0.2);       // the long tunic hem, flared
    } else if (o.lower === 'lungi' || o.lower === 'saree') {
      b.slot(o.lower === 'saree' ? 2 : 3);
      b.taper(0, 0.06, 0.01, 0.4, 0.32, 0.98, 0.31, 0.2);     // wrapped to the ankle
      if (o.lower === 'saree') {
        b.color([0.82, 0.82, 0.82]);
        b.box(-0.205, 0.06, 0.13, 0.205, 0.16, 0.175, { skip: 'b' }); // border along the hem
        b.color(WHITE);
      }
    } else if (o.lower === 'frock') {
      b.slot(2);
      b.taper(0, 0.5, 0, 0.42, 0.32, 0.98, 0.3, 0.2);
    }
    // ---- torso (1)
    b.bone(1);
    if (o.top === 'blouse') {
      b.slot(1).taper(0, 0.96, 0, 0.27, 0.17, 1.1, 0.28, 0.17); // midriff
      b.slot(3).taper(0, 1.1, 0, 0.29, 0.18, 1.4, 0.36, 0.19);
      // the pallu: over the left shoulder and down the back
      b.slot(2);
      b.push().translate(0.02, 1.2, 0.005).rotate(0, 0, -0.55);
      b.boxC(0, 0, 0.0, 0.16, 0.6, 0.215);
      b.pop();
      b.box(0.08, 0.72, -0.13, 0.2, 1.38, -0.095);
    } else {
      b.slot(2);
      b.taper(0, 0.96, 0, 0.3, 0.18, 1.41, 0.38, 0.2);
      if (o.dupatta) {
        b.slot(3);
        b.box(-0.17, 1.28, 0.1, 0.17, 1.38, 0.125);
        b.box(-0.2, 0.86, 0.1, -0.12, 1.32, 0.13);
        b.box(0.12, 0.86, 0.1, 0.2, 1.32, 0.13);
      }
      if (o.lower === 'kurta' && !o.dupatta) {
        b.color([0.85, 0.85, 0.85]).boxC(0, 1.3, 0.103, 0.05, 0.16, 0.01); // placket
        b.color(WHITE);
      }
    }
    b.slot(1).boxC(0, 1.43, 0.0, 0.1, 0.09, 0.1); // neck
    // ---- head (2)
    b.bone(2).slot(1);
    b.taper(0, 1.45, 0.012, 0.16, 0.18, 1.68, 0.18, 0.2);
    b.boxC(0, 1.555, 0.11, 0.035, 0.05, 0.03);    // nose
    b.color(BLACK).slot(0);
    b.boxC(0.045, 1.585, 0.105, 0.03, 0.02, 0.01);
    b.boxC(-0.045, 1.585, 0.105, 0.03, 0.02, 0.01);
    b.color(WHITE).slot(4);
    const hair = o.hair || 'short';
    if (hair === 'turban') {
      b.taper(0, 1.6, 0.0, 0.215, 0.235, 1.77, 0.19, 0.2);
      b.boxC(0, 1.72, 0.06, 0.07, 0.07, 0.11);
    } else if (hair === 'cap') {
      b.box(-0.1, 1.66, -0.11, 0.1, 1.73, 0.11);
      b.box(-0.09, 1.665, 0.1, 0.09, 1.68, 0.19);                 // peak
    } else if (hair !== 'bald') {
      b.box(-0.095, 1.64, -0.112, 0.095, 1.7, 0.1);              // crown
      b.box(-0.093, 1.47, -0.115, 0.093, 1.66, -0.07);           // back
      if (hair === 'bun') b.sphere(0, 1.6, -0.15, 0.065, 0);
      if (hair === 'braid' || hair === 'pigtails') {
        b.box(-0.025, 1.08, -0.14, 0.025, 1.5, -0.1);
      }
      if (hair === 'pigtails') {
        b.box(0.09, 1.38, -0.06, 0.13, 1.56, -0.02);
        b.box(-0.13, 1.38, -0.06, -0.09, 1.56, -0.02);
      }
    }
    if (o.mustache) b.box(-0.055, 1.515, 0.1, 0.055, 1.535, 0.125);
    if (o.beard) b.taper(0, 1.38, 0.06, 0.12, 0.08, 1.52, 0.17, 0.1);
    if (o.bindi) {
      b.slot(0).color(hex('#d1162d')).boxC(0, 1.625, 0.115, 0.018, 0.018, 0.006);
      b.color(WHITE);
    }
    // ---- arms (3..6)
    const arm = (side) => {
      const x = side * 0.205;
      b.bone(side > 0 ? 3 : 5);
      b.slot(o.top === 'blouse' ? 3 : 2);
      b.boxC(x, 1.25, 0, 0.088, 0.26, 0.095);
      b.bone(side > 0 ? 4 : 6);
      b.slot(sleeves === 'full' || o.lower === 'kurta' ? 2 : 1);
      b.boxC(x, 0.975, 0, 0.075, 0.25, 0.08);
      b.slot(1).boxC(x, 0.81, 0.005, 0.068, 0.09, 0.085);         // hand
      if (o.bangles && side > 0) {
        b.slot(0).color(hex('#e9b949')).boxC(x, 0.875, 0.002, 0.084, 0.02, 0.092);
        b.color(WHITE);
      }
    };
    arm(1); arm(-1);
    if (o.stick) {
      b.bone(6).slot(0).color(hex('#7a5230'));
      b.rod([-0.21, 0.8, 0.06], [-0.24, 0.0, 0.14], 0.016, 5);
      b.color(WHITE);
    }
    if (o.bat) {
      b.bone(6).slot(0).color(hex('#d9b47a'));
      b.boxC(-0.21, 0.74, 0.07, 0.025, 0.1, 0.03);
      b.boxC(-0.21, 0.42, 0.07, 0.09, 0.56, 0.035);
      b.color(WHITE);
    }
    // ---- legs (7..10)
    const legs = (side) => {
      const x = side * 0.085;
      const shortLeg = o.lower === 'shorts' || o.lower === 'frock';
      b.bone(side > 0 ? 7 : 9).slot(3);
      b.boxC(x, 0.69, 0, 0.13, 0.42, 0.14);
      b.bone(side > 0 ? 8 : 10).slot(shortLeg ? 1 : 3);
      b.boxC(x, 0.27, 0, 0.105, 0.42, 0.115);
      b.slot(0).color(CHAPPAL);
      b.boxC(x, 0.025, 0.035, 0.1, 0.05, 0.24);
      b.color(WHITE);
    };
    legs(1); legs(-1);
  });
}

export function buildPeople() {
  return {
    man: buildPerson('man', { lower: 'trousers', top: 'shirt' }),
    manMustache: buildPerson('manMustache', { lower: 'trousers', top: 'shirt', mustache: true, sleeves: 'full' }),
    kurta: buildPerson('kurta', { lower: 'kurta', top: 'shirt', mustache: true }),
    lungi: buildPerson('lungi', { lower: 'lungi', top: 'shirt', mustache: true }),
    turban: buildPerson('turban', { lower: 'kurta', top: 'shirt', hair: 'turban', beard: true }),
    cap: buildPerson('cap', { lower: 'trousers', top: 'shirt', hair: 'cap', mustache: true }),
    saree: buildPerson('saree', { lower: 'saree', top: 'blouse', hair: 'bun', bindi: true, bangles: true }),
    salwar: buildPerson('salwar', { lower: 'salwar', top: 'shirt', hair: 'braid', dupatta: true, bindi: true, bangles: true }),
    kid: buildPerson('kid', { lower: 'shorts', top: 'tee' }),
    girl: buildPerson('girl', { lower: 'frock', top: 'tee', hair: 'pigtails' }),
    elder: buildPerson('elder', { lower: 'kurta', top: 'shirt', hair: 'short', stick: true, mustache: true }),
    batter: buildPerson('batter', { lower: 'shorts', top: 'tee', bat: true }),
  };
}

/* ===================================================================== CATTLE */

export const QUAD_BONES = [
  { name: 'body', parent: -1, pivot: [0, 1.0, 0] },
  { name: 'head', parent: 0, pivot: [0, 1.12, 0.66] },
  { name: 'tail', parent: 0, pivot: [0, 1.15, -0.82] },
  { name: 'fl', parent: 0, pivot: [0.2, 0.92, 0.55] },
  { name: 'fr', parent: 0, pivot: [-0.2, 0.92, 0.55] },
  { name: 'bl', parent: 0, pivot: [0.2, 0.92, -0.6] },
  { name: 'br', parent: 0, pivot: [-0.2, 0.92, -0.6] },
];

export function buildCow() {
  return model('cow', QUAD_BONES, (b) => {
    b.color(WHITE).bone(0).slot(1);
    b.taper(0, 0.62, 0.0, 0.42, 1.55, 1.22, 0.5, 1.6);             // barrel
    b.taper(0, 1.18, 0.5, 0.36, 0.34, 1.44, 0.2, 0.22, -0.02);      // the zebu hump
    b.taper(0, 1.0, -0.68, 0.44, 0.3, 1.25, 0.44, 0.28);            // rump
    b.color([0.95, 0.95, 0.95]);
    b.box(-0.05, 0.42, 0.45, 0.05, 0.9, 0.85);                       // dewlap
    b.color(WHITE);
    // head (1)
    b.bone(1).slot(1);
    b.push().translate(0, 1.12, 0.78).rotate(0, 0.55, 0);
    b.boxC(0, 0, 0.0, 0.26, 0.32, 0.3);                               // neck root
    b.pop();
    b.push().translate(0, 1.03, 1.0).rotate(0, -0.9, 0);
    b.taper(0, -0.25, 0, 0.17, 0.2, 0.1, 0.24, 0.26);                 // long face, pointing down
    b.slot(2).taper(0, -0.32, 0.01, 0.15, 0.17, -0.22, 0.17, 0.19);   // dark muzzle
    b.pop();
    b.slot(1);
    b.box(0.1, 1.12, 0.92, 0.27, 1.17, 1.0);                         // ears, sideways
    b.box(-0.27, 1.12, 0.92, -0.1, 1.17, 1.0);
    b.slot(3);
    b.rod([0.07, 1.2, 0.93], [0.13, 1.36, 0.88], 0.028, 5, { r1: 0.012 });
    b.rod([-0.07, 1.2, 0.93], [-0.13, 1.36, 0.88], 0.028, 5, { r1: 0.012 });
    b.color(BLACK).slot(0);
    b.boxC(0.115, 1.06, 1.06, 0.02, 0.03, 0.03);
    b.boxC(-0.115, 1.06, 1.06, 0.02, 0.03, 0.03);
    b.color(WHITE);
    // tail (2)
    b.bone(2).slot(1);
    b.rod([0, 1.15, -0.83], [0, 0.45, -0.9], 0.03, 5);
    b.slot(2).rod([0, 0.48, -0.9], [0, 0.28, -0.9], 0.055, 5, { r1: 0.02 });
    // legs (3..6)
    for (const [bi, x, z] of [[3, 0.17, 0.55], [4, -0.17, 0.55], [5, 0.17, -0.6], [6, -0.17, -0.6]]) {
      b.bone(bi).slot(1);
      b.taper(x, 0.12, z, 0.1, 0.1, 0.95, 0.15, 0.17);
      b.slot(2).boxC(x, 0.06, z + 0.01, 0.11, 0.12, 0.12);
    }
  });
}

export function buildGoat() {
  return model('goat', QUAD_BONES, (b) => {
    // Built at cow proportions in the same skeleton, then everything is scaled at
    // instance time; the goat is narrower and shorter-legged in its own right.
    b.color(WHITE).bone(0).slot(1);
    b.taper(0, 0.62, 0.0, 0.3, 1.2, 1.05, 0.36, 1.3);
    b.bone(1).slot(1);
    b.push().translate(0, 1.15, 0.78).rotate(0, 0.5, 0);
    b.boxC(0, 0, 0.0, 0.16, 0.34, 0.18);
    b.pop();
    b.push().translate(0, 1.32, 0.95).rotate(0, -0.6, 0);
    b.taper(0, -0.2, 0, 0.12, 0.14, 0.08, 0.18, 0.2);
    b.pop();
    b.slot(2);
    b.box(0.09, 1.18, 0.88, 0.25, 1.22, 0.96);
    b.box(-0.25, 1.18, 0.88, -0.09, 1.22, 0.96);
    b.slot(3);
    b.rod([0.05, 1.38, 0.9], [0.09, 1.52, 0.78], 0.025, 4, { r1: 0.01 });
    b.rod([-0.05, 1.38, 0.9], [-0.09, 1.52, 0.78], 0.025, 4, { r1: 0.01 });
    b.color(BLACK).slot(0);
    b.boxC(0.075, 1.3, 1.02, 0.02, 0.025, 0.025);
    b.boxC(-0.075, 1.3, 1.02, 0.02, 0.025, 0.025);
    b.color(WHITE);
    b.bone(2).slot(1);
    b.rod([0, 1.0, -0.66], [0, 1.18, -0.78], 0.04, 4, { r1: 0.015 });
    for (const [bi, x, z] of [[3, 0.12, 0.45], [4, -0.12, 0.45], [5, 0.12, -0.5], [6, -0.12, -0.5]]) {
      b.bone(bi).slot(1);
      b.taper(x, 0.1, z, 0.07, 0.07, 0.95, 0.11, 0.12);
      b.slot(2).boxC(x, 0.05, z + 0.01, 0.08, 0.1, 0.09);
    }
  });
}

/* ====================================================================== BIRDS */

export const BIRD_BONES = [
  { name: 'body', parent: -1, pivot: [0, 0.1, 0] },
  { name: 'wingL', parent: 0, pivot: [0.04, 0.14, 0.01] },
  { name: 'wingR', parent: 0, pivot: [-0.04, 0.14, 0.01] },
  { name: 'head', parent: 0, pivot: [0, 0.15, 0.07] },
];

export function buildBird() {
  return model('bird', BIRD_BONES, (b) => {
    b.color(WHITE).bone(0).slot(1);
    b.taper(0, 0.05, 0, 0.08, 0.17, 0.16, 0.09, 0.15, 0.01);
    b.box(-0.04, 0.09, -0.17, 0.04, 0.12, -0.07);                    // tail
    b.slot(0).color(hex('#c0645a'));
    b.box(0.015, 0.0, 0.0, 0.025, 0.06, 0.02);                        // legs
    b.box(-0.025, 0.0, 0.0, -0.015, 0.06, 0.02);
    b.color(WHITE);
    b.bone(3).slot(3);
    b.boxC(0, 0.17, 0.07, 0.065, 0.07, 0.07);
    b.slot(1).boxC(0, 0.205, 0.095, 0.055, 0.05, 0.06);
    b.slot(0).color(hex('#3a3430')).boxC(0, 0.2, 0.135, 0.015, 0.015, 0.03);
    b.color(WHITE);
    b.bone(1).slot(2);
    b.box(0.035, 0.12, -0.09, 0.2, 0.135, 0.07);
    b.bone(2).slot(2);
    b.box(-0.2, 0.12, -0.09, -0.035, 0.135, 0.07);
  });
}

/* =================================================================== VEHICLES */

export const VEHICLE_BONES_4 = [
  { name: 'body', parent: -1, pivot: [0, 0, 0] },
  { name: 'w0', parent: 0, pivot: [0, 0, 0] },
  { name: 'w1', parent: 0, pivot: [0, 0, 0] },
  { name: 'w2', parent: 0, pivot: [0, 0, 0] },
  { name: 'w3', parent: 0, pivot: [0, 0, 0] },
];

/** Vehicles keep a list of wheel pivots so the rig can spin each about its own axle. */
function wheels(defs) {
  const bones = [{ name: 'body', parent: -1, pivot: [0, 0, 0] }];
  defs.forEach((d, i) => bones.push({ name: 'w' + i, parent: 0, pivot: d }));
  return bones;
}

export function buildAuto() {
  const W = [[0, 0.22, 0.92], [0.56, 0.22, -0.72], [-0.56, 0.22, -0.72]];
  const m = model('auto', wheels(W), (b) => {
    b.color(WHITE).bone(0);
    // body tub and nose (slot 1: green or black)
    b.slot(1);
    b.box(-0.62, 0.3, -1.15, 0.62, 0.62, 0.45);                       // passenger tub
    b.taper(0, 0.3, 0.72, 0.6, 0.55, 1.05, 0.42, 0.42, 0.06);          // nose cowl
    b.box(-0.62, 0.62, -1.15, -0.56, 0.95, -0.25);                    // side panels at the back
    b.box(0.56, 0.62, -1.15, 0.62, 0.95, -0.25);
    // canopy (slot 2: yellow)
    b.slot(2);
    b.box(-0.66, 1.55, -1.18, 0.66, 1.72, 0.62);                      // roof
    b.taper(0, 1.05, 0.62, 1.2, 0.08, 1.62, 1.28, 0.1, -0.12);         // front hood over the windscreen
    b.box(-0.66, 0.95, -1.18, 0.66, 1.55, -1.08);                     // back canvas
    b.box(-0.66, 0.95, -1.15, -0.6, 1.55, -0.5);
    b.box(0.6, 0.95, -1.15, 0.66, 1.55, -0.5);
    b.slot(0).color(GLASS);
    b.push().translate(0, 1.33, 0.7).rotate(0, 0.32, 0);
    b.boxC(0, 0, 0, 1.0, 0.5, 0.03);                                   // windscreen
    b.pop();
    b.color(CHROME).box(-0.62, 0.95, 0.5, -0.58, 1.6, 0.56).box(0.58, 0.95, 0.5, 0.62, 1.6, 0.56); // pillars
    b.box(-0.35, 1.12, 0.45, 0.35, 1.15, 0.5);                        // handlebar
    b.color(hex('#2a2a2a'));
    b.box(-0.55, 0.62, -0.95, 0.55, 0.78, -0.35);                     // passenger seat
    b.box(-0.55, 0.78, -1.08, 0.55, 1.15, -0.95);
    b.box(-0.2, 0.7, 0.05, 0.2, 0.82, 0.38);                          // driver seat
    b.color(HEADLIGHT).emissive(110).boxC(0, 0.86, 1.08, 0.16, 0.12, 0.04);
    b.color(TAILLIGHT).emissive(70).boxC(0.5, 0.55, -1.16, 0.1, 0.06, 0.02).boxC(-0.5, 0.55, -1.16, 0.1, 0.06, 0.02);
    b.emissive(0).color(TYRE);
    b.box(-0.08, 0.36, 0.86, 0.08, 0.5, 1.0);                        // front mudguard
    // wheels
    W.forEach((p, i) => {
      b.bone(i + 1).color(TYRE).wheel(p[0], p[1], p[2], 0.22, 0.13, 10);
      b.color(CHROME).wheel(p[0] + (p[0] > 0 ? 0.04 : p[0] < 0 ? -0.04 : 0), p[1], p[2], 0.1, 0.12, 6);
    });
  });
  m.seats = { driver: [0, 0.72, 0.18], back: [[0.28, 0.72, -0.62], [-0.28, 0.72, -0.62], [0, 0.72, -0.62]] };
  m.halfLen = 1.2; m.halfWidth = 0.66; m.height = 1.75;
  return m;
}

export function buildScooter(kind = 'scooter') {
  const bike = kind === 'bike';
  const r = bike ? 0.3 : 0.24;
  const W = [[0, r, bike ? 0.68 : 0.6], [0, r, bike ? -0.62 : -0.58]];
  const m = model(kind, wheels(W), (b) => {
    b.color(WHITE).bone(0).slot(1);
    if (bike) {
      b.taper(0, 0.75, 0.2, 0.22, 0.4, 0.92, 0.26, 0.36);             // tank
      b.color(hex('#3a3a3a')).slot(0).box(-0.12, 0.35, -0.25, 0.12, 0.65, 0.2); // engine
      b.color(CHROME).rod([0.12, 0.38, -0.1], [0.14, 0.42, -0.75], 0.035, 5); // silencer
      b.color(WHITE).slot(1).box(-0.1, 0.62, -0.75, 0.1, 0.72, -0.35); // tail panel
    } else {
      b.taper(0, 0.3, -0.35, 0.36, 0.55, 0.75, 0.3, 0.6);             // rear body
      b.box(-0.17, 0.3, -0.05, 0.17, 0.4, 0.42);                     // floorboard
      b.taper(0, 0.3, 0.5, 0.32, 0.14, 1.0, 0.24, 0.12, 0.05);        // front apron
    }
    b.slot(0).color(hex('#1f1f1f'));
    b.box(-0.13, bike ? 0.9 : 0.75, -0.62, 0.13, bike ? 0.97 : 0.84, bike ? 0.02 : -0.05); // seat
    b.color(hex('#555555')).rod([0, r, W[0][2]], [0, 1.0, W[0][2] - 0.12], 0.03, 5); // fork
    b.color(hex('#2b2b2b')).box(-0.33, 1.0, W[0][2] - 0.16, 0.33, 1.04, W[0][2] - 0.1); // handlebar
    b.color(HEADLIGHT).emissive(110).boxC(0, 0.95, W[0][2] - 0.04, 0.12, 0.1, 0.05);
    b.color(TAILLIGHT).emissive(70).boxC(0, bike ? 0.7 : 0.62, -0.78, 0.12, 0.05, 0.03);
    b.emissive(0);
    W.forEach((p, i) => {
      b.bone(i + 1).color(TYRE).wheel(p[0], p[1], p[2], r, 0.1, 10);
      b.color(CHROME).wheel(p[0], p[1], p[2], r * 0.45, 0.11, 6);
    });
  });
  m.seats = { driver: [0, bike ? 0.95 : 0.82, bike ? -0.18 : -0.22], back: [[0, bike ? 1.0 : 0.88, -0.5]] };
  m.halfLen = 0.9; m.halfWidth = 0.35; m.height = 1.15;
  return m;
}

export function buildCycle() {
  const W = [[0, 0.33, 0.55], [0, 0.33, -0.5]];
  const bones = wheels(W);
  bones.push({ name: 'crank', parent: 0, pivot: [0, 0.3, 0.02] });
  const m = model('cycle', bones, (b) => {
    b.color(WHITE).bone(0).slot(1);
    b.rod([0, 0.3, 0.02], [0, 0.85, -0.18], 0.022, 5);                // seat tube
    b.rod([0, 0.3, 0.02], [0, 0.88, 0.45], 0.024, 5);                 // down tube
    b.rod([0, 0.85, -0.18], [0, 0.88, 0.45], 0.022, 5);               // top tube
    b.rod([0, 0.33, -0.5], [0, 0.3, 0.02], 0.018, 5);                 // chain stay
    b.rod([0, 0.33, -0.5], [0, 0.85, -0.18], 0.018, 5);
    b.rod([0, 0.33, 0.55], [0, 1.0, 0.42], 0.022, 5);                 // fork
    b.box(-0.3, 1.0, 0.38, 0.3, 1.03, 0.42);                          // handlebar
    b.slot(0).color(hex('#222222')).box(-0.09, 0.88, -0.27, 0.09, 0.93, -0.08);
    b.color(CHROME).box(-0.12, 0.62, -0.68, 0.12, 0.64, -0.45);       // carrier
    W.forEach((p, i) => {
      b.bone(i + 1).color(TYRE).wheel(p[0], p[1], p[2], 0.33, 0.05, 12);
      b.color(CHROME).wheel(p[0], p[1], p[2], 0.27, 0.06, 8);
      b.color(TYRE).wheel(p[0], p[1], p[2], 0.04, 0.08, 5);
    });
    b.bone(3).color(hex('#333333'));
    b.box(0.07, 0.29, -0.14, 0.09, 0.31, 0.18).box(-0.09, 0.29, -0.14, -0.07, 0.31, 0.18);
  });
  m.seats = { driver: [0, 0.92, -0.2], back: [[0, 0.68, -0.56]] };
  m.halfLen = 0.95; m.halfWidth = 0.32; m.height = 1.1;
  return m;
}

export function buildCar() {
  const W = [[0.68, 0.3, 1.15], [-0.68, 0.3, 1.15], [0.68, 0.3, -1.12], [-0.68, 0.3, -1.12]];
  const m = model('car', wheels(W), (b) => {
    b.color(WHITE).bone(0).slot(1);
    b.taper(0, 0.25, 0.0, 1.6, 3.6, 0.82, 1.56, 3.5, -0.02);          // lower body
    b.slot(2);
    b.taper(0, 0.82, -0.25, 1.5, 2.25, 1.38, 1.28, 1.6, -0.12);       // cabin
    b.slot(0).color(GLASS);
    b.push().translate(0, 1.1, 0.88).rotate(0, 0.62, 0).boxC(0, 0, 0, 1.3, 0.62, 0.02).pop();       // windscreen
    b.push().translate(0, 1.1, -1.35).rotate(0, -0.55, 0).boxC(0, 0, 0, 1.3, 0.55, 0.02).pop();     // rear glass
    b.box(0.73, 0.92, -1.15, 0.755, 1.28, 0.62).box(-0.755, 0.92, -1.15, -0.73, 1.28, 0.62);       // side glass
    b.color(hex('#3b3b3b')).box(-0.8, 0.22, 1.72, 0.8, 0.45, 1.85).box(-0.8, 0.22, -1.85, 0.8, 0.45, -1.72); // bumpers
    b.color(HEADLIGHT).emissive(120).boxC(0.55, 0.66, 1.79, 0.32, 0.12, 0.04).boxC(-0.55, 0.66, 1.79, 0.32, 0.12, 0.04);
    b.color(TAILLIGHT).emissive(80).boxC(0.6, 0.68, -1.79, 0.26, 0.12, 0.04).boxC(-0.6, 0.68, -1.79, 0.26, 0.12, 0.04);
    b.emissive(0);
    b.color(hex('#f2f2f2')).boxC(0, 0.42, 1.86, 0.42, 0.11, 0.01).boxC(0, 0.42, -1.86, 0.42, 0.11, 0.01); // plates
    W.forEach((p, i) => {
      b.bone(i + 1).color(TYRE).wheel(p[0], p[1], p[2], 0.3, 0.2, 10);
      b.color(CHROME).wheel(p[0] + Math.sign(p[0]) * 0.03, p[1], p[2], 0.17, 0.18, 8);
    });
  });
  m.halfLen = 1.85; m.halfWidth = 0.8; m.height = 1.45;
  return m;
}

export function buildBus() {
  const W = [[1.1, 0.48, 3.4], [-1.1, 0.48, 3.4], [1.1, 0.48, -2.9], [-1.1, 0.48, -2.9]];
  const m = model('bus', wheels(W), (b) => {
    b.color(WHITE).bone(0).slot(1);
    b.box(-1.25, 0.45, -5.0, 1.25, 1.55, 5.0);                        // lower body
    b.box(-1.25, 2.6, -5.0, 1.25, 3.05, 5.0);                         // roof band
    b.slot(2);
    b.box(-1.27, 1.3, -5.0, 1.27, 1.55, 5.0, { skip: 'tb' });         // stripe
    b.slot(1);
    for (let z = -4.9; z < 4.9; z += 1.15) {                           // window pillars
      b.box(-1.25, 1.55, z, -1.2, 2.6, z + 0.12).box(1.2, 1.55, z, 1.25, 2.6, z + 0.12);
    }
    b.slot(0).color(GLASS);
    b.box(-1.22, 1.55, -4.95, 1.22, 2.6, 4.95);                       // glass band
    b.color(hex('#141414'));
    // heads of the standing crowd inside — the bus is always full
    for (let z = -4.4; z < 4.0; z += 0.55) {
      for (const x of [0.75, -0.75, 0.2, -0.3]) {
        if (((z * 7 + x * 3) | 0) % 3 === 0) continue;
        b.boxC(x, 2.12 + (((z * 13) | 0) % 3) * 0.04, z, 0.2, 0.26, 0.2);
      }
    }
    b.color(hex('#2b2b2b')).box(-1.27, 0.35, 4.9, 1.27, 0.6, 5.08).box(-1.27, 0.35, -5.08, 1.27, 0.6, -4.9);
    b.color(HEADLIGHT).emissive(120).boxC(0.85, 0.85, 5.02, 0.3, 0.16, 0.03).boxC(-0.85, 0.85, 5.02, 0.3, 0.16, 0.03);
    b.color(hex('#ffcc33')).emissive(90).boxC(0, 2.8, 5.02, 1.6, 0.32, 0.03); // route board
    b.color(TAILLIGHT).emissive(80).boxC(0.95, 0.9, -5.02, 0.18, 0.22, 0.03).boxC(-0.95, 0.9, -5.02, 0.18, 0.22, 0.03);
    b.emissive(0);
    W.forEach((p, i) => {
      b.bone(i + 1).color(TYRE).wheel(p[0], p[1], p[2], 0.48, 0.3, 12);
      b.color(CHROME).wheel(p[0] + Math.sign(p[0]) * 0.04, p[1], p[2], 0.24, 0.28, 8);
    });
  });
  m.halfLen = 5.05; m.halfWidth = 1.27; m.height = 3.05;
  return m;
}

export function buildTruck() {
  const W = [[1.05, 0.45, 2.6], [-1.05, 0.45, 2.6], [1.05, 0.45, -2.2], [-1.05, 0.45, -2.2]];
  const m = model('truck', wheels(W), (b) => {
    b.color(WHITE).bone(0).slot(1);
    b.box(-1.15, 0.6, 2.0, 1.15, 2.5, 3.55);                          // cab
    b.taper(0, 2.5, 2.85, 2.2, 1.3, 2.75, 2.0, 1.1);                  // cab roof
    b.slot(0).color(GLASS).box(-1.0, 1.6, 3.5, 1.0, 2.35, 3.57);
    b.color(hex('#2b2b2b')).box(-1.2, 0.4, 3.5, 1.2, 0.7, 3.7);
    b.slot(2).color(WHITE);
    b.box(-1.2, 0.85, -3.4, 1.2, 2.9, 1.9);                           // cargo body
    b.slot(1);
    b.box(-1.22, 2.6, -3.42, 1.22, 2.9, 1.92, { skip: 'b' });         // painted crown
    for (let z = -3.2; z < 1.8; z += 0.7) b.box(-1.23, 1.0, z, 1.23, 2.5, z + 0.08, { skip: 'tb' }); // ribs
    b.slot(0).color(hex('#7a4b26')).box(-1.2, 0.6, -3.4, 1.2, 0.85, 1.9); // chassis
    b.color(HEADLIGHT).emissive(110).boxC(0.8, 0.95, 3.57, 0.26, 0.16, 0.03).boxC(-0.8, 0.95, 3.57, 0.26, 0.16, 0.03);
    b.color(TAILLIGHT).emissive(70).boxC(0.9, 0.95, -3.42, 0.2, 0.14, 0.03).boxC(-0.9, 0.95, -3.42, 0.2, 0.14, 0.03);
    b.emissive(0);
    W.forEach((p, i) => {
      b.bone(i + 1).color(TYRE).wheel(p[0], p[1], p[2], 0.45, 0.32, 12);
      b.color(CHROME).wheel(p[0] + Math.sign(p[0]) * 0.03, p[1], p[2], 0.2, 0.3, 8);
    });
  });
  m.halfLen = 3.6; m.halfWidth = 1.22; m.height = 2.9;
  m.backPlate = true;
  return m;
}

export function buildRickshaw() {
  const W = [[0, 0.33, 1.05], [0.5, 0.33, -0.35], [-0.5, 0.33, -0.35]];
  const bones = wheels(W);
  bones.push({ name: 'crank', parent: 0, pivot: [0, 0.32, 0.55] });
  const m = model('rickshaw', bones, (b) => {
    b.color(WHITE).bone(0).slot(1);
    b.rod([0, 0.33, 1.05], [0, 1.0, 0.92], 0.025, 5);
    b.rod([0, 0.32, 0.55], [0, 0.88, 0.62], 0.025, 5);
    b.rod([0, 0.32, 0.55], [0, 0.95, 0.95], 0.025, 5);
    b.rod([0, 0.88, 0.62], [0, 0.95, 0.95], 0.022, 5);
    b.rod([0, 0.32, 0.55], [0, 0.4, -0.1], 0.03, 5);
    b.box(-0.3, 1.0, 0.9, 0.3, 1.03, 0.94);
    b.slot(0).color(hex('#222222')).box(-0.09, 0.9, 0.53, 0.09, 0.95, 0.7);
    b.slot(1).box(-0.58, 0.45, -0.75, 0.58, 0.55, 0.05);              // passenger platform
    b.slot(3).box(-0.55, 0.55, -0.6, 0.55, 0.75, -0.15);               // seat
    b.box(-0.55, 0.75, -0.7, 0.55, 1.15, -0.6);
    b.slot(2);
    // the folding hood, three hoops
    for (let i = 0; i < 3; i++) {
      const z = -0.72 + i * 0.12, y = 1.15 + i * 0.25;
      b.box(-0.58, 0.75, z, -0.54, y, z + 0.08).box(0.54, 0.75, z, 0.58, y, z + 0.08);
    }
    b.taper(0, 1.55, -0.55, 1.16, 0.4, 1.75, 1.0, 0.3, 0.02);
    W.forEach((p, i) => {
      b.bone(i + 1).color(TYRE).wheel(p[0], p[1], p[2], 0.33, 0.05, 12);
      b.color(CHROME).wheel(p[0], p[1], p[2], 0.27, 0.06, 8);
    });
    b.bone(4).color(hex('#333333'));
    b.box(0.07, 0.31, 0.4, 0.09, 0.33, 0.7).box(-0.09, 0.31, 0.4, -0.07, 0.33, 0.7);
  });
  m.seats = { driver: [0, 0.94, 0.62], back: [[0.25, 0.75, -0.38], [-0.25, 0.75, -0.38]] };
  m.halfLen = 1.3; m.halfWidth = 0.6; m.height = 1.75;
  return m;
}

/* ===================================================================== TRAINS */

// One rigid bone each. y = 0 is the ground; the rail heads are at RAIL_TOP and
// the wheels sit on them. Slots: 1 body paint, 2 bands, 3 roof.
const RAIL_TOP = 0.46;
const BODY = [{ name: 'body', parent: -1, pivot: [0, 0, 0] }];
const IRON = hex('#2a2827');
const UNDER = hex('#353230');
const SKINS = ['#8d5524', '#a0662f', '#6b4423', '#c68642', '#7a4a26'].map(hex);
const SHIRTS = ['#e8e4d8', '#3d6fb5', '#c0392b', '#f1c40f', '#2e8b57', '#8e44ad', '#ecf0f1', '#d35400'].map(hex);

/** A bogie: a frame and `axles` pairs of wheels on the two rails. */
function bogie(b, zc, axles, r, pitch, gauge = 1.676) {
  b.slot(0).color(IRON);
  const half = ((axles - 1) * pitch) / 2;
  b.box(-1.15, RAIL_TOP + r * 0.6, zc - half - 0.6, 1.15, RAIL_TOP + r * 1.55, zc + half + 0.6, { skip: 'b' });
  b.box(-0.35, RAIL_TOP + r * 1.55, zc - 0.5, 0.35, RAIL_TOP + r * 1.55 + 0.25, zc + 0.5, { skip: 'b' });
  for (let k = 0; k < axles; k++) {
    const z = zc - half + k * pitch;
    for (const x of [-gauge / 2, gauge / 2]) b.color(hex('#1f1d1c')).wheel(x, RAIL_TOP + r, z, r, 0.13, 10);
    b.color(hex('#6b6560')).box(-gauge / 2, RAIL_TOP + r - 0.05, z - 0.05, gauge / 2, RAIL_TOP + r + 0.05, z + 0.05);
  }
}

/** Buffers and a coupler at one end (s = +1 front, -1 back) of a body whose end is at z. */
function buffers(b, z, s, y) {
  b.slot(0).color(IRON).box(-1.45, y - 0.25, Math.min(z, z + s * 0.12), 1.45, y + 0.25, Math.max(z, z + s * 0.12));
  for (const x of [-0.9, 0.9]) {
    b.color(hex('#3f3c3a'));
    const z1 = z + s * 0.45;
    b.box(x - 0.17, y - 0.17, Math.min(z, z1), x + 0.17, y + 0.17, Math.max(z, z1));
  }
  b.color(hex('#3f3c3a')).box(-0.12, y - 0.12, Math.min(z, z + s * 0.4), 0.12, y + 0.12, Math.max(z, z + s * 0.4));
}

export function buildCoach() {
  const L = 10.8, W = 1.6, y0 = 1.25, yWin0 = 2.3, yWin1 = 3.2, yTop = 4.0;
  const m = model('coach', BODY, (b) => {
    b.bone(0);
    bogie(b, 7.6, 2, 0.46, 2.6);
    bogie(b, -7.6, 2, 0.46, 2.6);
    // underframe, battery boxes, the water tanks under the floor
    b.slot(0).color(UNDER).box(-1.4, 1.05, -L, 1.4, y0, L, { skip: 'b' });
    b.color(hex('#2b2b2b')).box(-1.1, 0.7, -4.5, 1.1, 1.05, -1.5, { skip: 't' }).box(-0.9, 0.75, 1.0, 0.9, 1.05, 4.2, { skip: 't' });
    // body below and above the windows, then the pillars between them
    b.slot(1).color(WHITE);
    b.box(-W, y0, -L, W, yWin0, L, { skip: 'b' });
    b.box(-W, yWin1, -L, W, yTop, L, { skip: 'b' });
    const doorZ = L - 0.95;
    const winZ = [];
    for (let z = -L + 2.1; z <= L - 2.0; z += 1.32) winZ.push(z);
    // the ends of the window band are solid (the doors and the vestibules)
    b.box(-W, yWin0, -L, W, yWin1, -L + 1.75, { skip: 'tb' }).box(-W, yWin0, L - 1.75, W, yWin1, L, { skip: 'tb' });
    for (const z of winZ) b.box(-W, yWin0, z + 0.48, W, yWin1, z + 0.84, { skip: 'tb' });
    // the bands: one under the windows, one over them (slot 2)
    b.slot(2).box(-W - 0.012, yWin0 - 0.16, -L, W + 0.012, yWin0 - 0.02, L, { skip: 'tb' });
    b.box(-W - 0.012, yWin1 + 0.08, -L, W + 0.012, yWin1 + 0.2, L, { skip: 'tb' });
    // the glass (open windows, dark inside) with their bars, and the crowd inside
    b.slot(0).color(hex('#1b2024')).box(-W + 0.08, yWin0, -L + 1.75, W - 0.08, yWin1, L - 1.75, { skip: 'tb' });
    let k = 0;
    for (const z of winZ) {
      for (const sx of [-1, 1]) {
        b.color(hex('#9a9a96'));
        for (let yb = yWin0 + 0.2; yb < yWin1 - 0.05; yb += 0.22) b.box(sx * W - 0.02, yb, z - 0.4, sx * W + 0.02, yb + 0.035, z + 0.48, { skip: 'tb' });
        // two or three faces at each window, and a shirt under each
        for (let q = 0; q < 2 + (k % 2); q++, k++) {
          const hz = z - 0.25 + q * 0.32, hy = 2.72 + ((k * 7) % 3) * 0.05;
          b.color(SHIRTS[k % SHIRTS.length]).box(sx * (W - 0.45), yWin0, hz - 0.13, sx * (W - 0.15), hy - 0.12, hz + 0.13);
          b.color(SKINS[k % SKINS.length]).boxC(sx * (W - 0.28), hy, hz, 0.2, 0.25, 0.19);
          if (k % 5 === 0) b.color(hex('#141414')).boxC(sx * (W - 0.29), hy + 0.13, hz, 0.21, 0.06, 0.2);
        }
      }
    }
    // the doors: open, dark, with two steps below each
    for (const ez of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const zc = ez * doorZ;
        b.color(hex('#141210')).box(sx * W - 0.03, y0 + 0.05, zc - 0.45, sx * W + 0.03, yWin1 + 0.15, zc + 0.45, { skip: 'tb' });
        b.color(hex('#7d7a75')).box(sx * W - 0.2, 0.92, zc - 0.45, sx * W + 0.04, 0.98, zc + 0.45).box(sx * W - 0.1, 1.12, zc - 0.45, sx * W + 0.06, 1.18, zc + 0.45);
        b.color(hex('#c9c6c0')).box(sx * (W + 0.03), y0 + 0.3, zc - 0.5, sx * (W + 0.06), yWin1, zc - 0.46).box(sx * (W + 0.03), y0 + 0.3, zc + 0.46, sx * (W + 0.06), yWin1, zc + 0.5);
      }
    }
    // the roof: a shallow curve in three facets, with its vents
    b.slot(3).color(WHITE);
    b.taper(0, yTop, 0, W * 2, L * 2, yTop + 0.3, W * 1.4, L * 2);
    b.taper(0, yTop + 0.3, 0, W * 1.4, L * 2, 4.42, W * 0.7, L * 2, 0, { skip: 'b' });
    b.slot(0).color(hex('#4a4744'));
    for (let z = -L + 1.6; z < L - 1; z += 2.4) b.boxC(0, 4.47, z, 0.42, 0.12, 0.42);
    // the vestibule bellows that join it to the next coach
    b.color(hex('#1c1b1a')).box(-0.75, 1.3, -L - 0.36, 0.75, 3.6, -L).box(-0.75, 1.3, L, 0.75, 3.6, L + 0.36);
    buffers(b, L, 1, 1.0);
    buffers(b, -L, -1, 1.0);
  });
  m.halfLen = 10.8; m.halfWidth = 1.6; m.height = 4.45;
  return m;
}

export function buildLoco() {
  const L = 9.0;
  const m = model('loco', BODY, (b) => {
    b.bone(0);
    bogie(b, 5.6, 3, 0.54, 1.9);
    bogie(b, -5.6, 3, 0.54, 1.9);
    // the running board, with a rail along each side
    b.slot(0).color(UNDER).box(-1.5, 1.35, -L, 1.5, 1.65, L, { skip: 'b' });
    b.color(hex('#2b2b2b')).box(-1.0, 0.9, -2.8, 1.0, 1.35, 2.6, { skip: 't' }); // fuel tank
    b.color(hex('#d8d4ca'));
    for (const sx of [-1.42, 1.42]) {
      b.box(sx - 0.02, 2.55, -L + 0.3, sx + 0.02, 2.6, 2.6);
      for (let z = -L + 0.4; z < 2.6; z += 1.6) b.box(sx - 0.02, 1.65, z, sx + 0.02, 2.55, z + 0.04);
    }
    // the long hood (behind the cab) and the short hood (the nose)
    b.slot(1).color(WHITE);
    b.box(-1.18, 1.65, -L + 0.2, 1.18, 3.75, 2.9, { skip: 'b' });
    b.box(-1.18, 1.65, 6.1, 1.18, 3.0, L - 0.25, { skip: 'b' });
    // the cab, with its windows
    b.box(-1.5, 1.65, 2.9, 1.5, 2.6, 6.1, { skip: 'b' });
    b.box(-1.5, 3.55, 2.9, 1.5, 4.1, 6.1, { skip: 'b' });
    b.box(-1.5, 2.6, 2.9, 1.5, 3.55, 3.2, { skip: 'tb' }).box(-1.5, 2.6, 5.8, 1.5, 3.55, 6.1, { skip: 'tb' });
    b.box(-1.5, 2.6, 4.35, 1.5, 3.55, 4.65, { skip: 'tb' });
    b.box(-0.18, 2.6, 6.0, 0.18, 3.55, 6.12, { skip: 'tb' });
    b.slot(0).color(GLASS).box(-1.46, 2.6, 3.2, 1.46, 3.55, 5.8, { skip: 'tb' }).box(-1.46, 2.6, 6.0, 1.46, 3.55, 6.08, { skip: 'tb' });
    // the bands: round the nose and along the hoods (slot 2), chevrons on the nose
    b.slot(2).box(-1.2, 2.25, 6.1, 1.2, 2.45, L - 0.24, { skip: 'tb' }).box(-1.2, 2.25, -L + 0.18, 1.2, 2.45, 2.9, { skip: 'tb' });
    b.box(-1.52, 2.0, 2.9, 1.52, 2.2, 6.1, { skip: 'tb' });
    for (let k = 0; k < 3; k++) {
      const yy = 1.75 + k * 0.4;
      b.rod([-1.15, yy, L - 0.24], [0, yy + 0.32, L - 0.24], 0.06, 4).rod([1.15, yy, L - 0.24], [0, yy + 0.32, L - 0.24], 0.06, 4);
    }
    // roof of the cab and the hood tops (slot 3), the exhaust stack, the horns
    b.slot(3).color(WHITE).box(-1.55, 4.1, 2.85, 1.55, 4.22, 6.15).box(-1.2, 3.75, -L + 0.2, 1.2, 3.85, 2.9, { skip: 'b' });
    b.box(-1.2, 3.0, 6.1, 1.2, 3.08, L - 0.25, { skip: 'b' });
    b.slot(0).color(hex('#1e1e1e')).cyl(0, 3.85, -1.2, 0.26, 4.25, 0.3, 8);
    for (let z = -7.5; z < 1.5; z += 1.5) b.color(hex('#555049')).box(-0.9, 3.85, z, 0.9, 3.95, z + 0.9);
    b.color(hex('#b8b4ac')).cyl(0.4, 4.22, 4.0, 0.06, 4.45, 0.1, 6).cyl(-0.4, 4.22, 4.0, 0.06, 4.45, 0.1, 6);
    // the lights: a big one on the nose and two on the cab roof
    b.color(HEADLIGHT).emissive(220).cyl(0, 2.7, L - 0.2, 0.2, 2.72, 0.2, 10).boxC(0, 2.75, L - 0.2, 0.3, 0.3, 0.06);
    b.boxC(0.6, 4.0, 6.13, 0.22, 0.16, 0.05).boxC(-0.6, 4.0, 6.13, 0.22, 0.16, 0.05);
    b.color(TAILLIGHT).emissive(60).boxC(1.0, 1.85, -L + 0.17, 0.16, 0.16, 0.05).boxC(-1.0, 1.85, -L + 0.17, 0.16, 0.16, 0.05);
    b.emissive(0);
    // the cowcatcher under the nose
    b.color(hex('#2b2b2b')).taper(0, 0.62, L + 0.05, 2.6, 0.5, 1.35, 2.8, 0.3, -0.12);
    buffers(b, L - 0.1, 1, 1.0);
    buffers(b, -L, -1, 1.0);
  });
  m.halfLen = 9.0; m.halfWidth = 1.55; m.height = 4.45;
  return m;
}

/** A crossing boom: pivot at the origin, swinging shut along +z. Red and white, with its red disc. */
export function buildBoom() {
  return model('boom', BODY, (b) => {
    b.bone(0).slot(0);
    for (let k = 0; k < 15; k++) {
      const z0 = k * 0.5, z1 = Math.min(7.5, z0 + 0.5);
      b.color(k % 2 ? hex('#f4f2ec') : hex('#c62828')).box(-0.055, -0.06, z0, 0.055, 0.06, z1, { skip: k ? '' : 'n' });
    }
    b.color(hex('#c62828')).wheel(0, 0, 3.75, 0.3, 0.025, 14);
    b.color(hex('#f4f2ec')).wheel(0, 0, 3.75, 0.2, 0.03, 14);
    b.color(hex('#3a3a3a')).box(-0.13, -0.16, -1.05, 0.13, 0.16, -0.2).box(-0.09, -0.09, -0.2, 0.09, 0.09, 0.15);
    // the hanging grille along its length that keeps people from ducking (it does not work)
    b.color(hex('#3d3d3d'));
    for (let z = 0.6; z < 7.3; z += 0.45) b.box(-0.01, -0.62, z, 0.01, -0.06, z + 0.02);
    b.box(-0.012, -0.64, 0.6, 0.012, -0.6, 7.2);
  });
}

/* ===================================================================== ITEMS */

/** Small things the dog can carry or eat. One bone; drawn as instances. */
export const ITEM_BONES = [{ name: 'item', parent: -1, pivot: [0, 0, 0] }];

export function buildItems() {
  const one = (name, fn) => model(name, ITEM_BONES, (b) => { b.color(WHITE).bone(0); fn(b); });
  return {
    biscuit: one('biscuit', (b) => b.color(hex('#d9a35b')).box(-0.05, 0, -0.035, 0.05, 0.012, 0.035)),
    roti: one('roti', (b) => b.color(hex('#e3b871')).cyl(0, 0, 0, 0.09, 0.012, 0.09, 9)),
    samosa: one('samosa', (b) => b.color(hex('#d9952f')).pyramid(0, 0, 0, 0.055, 0.045, 0.07)),
    jalebi: one('jalebi', (b) => b.color(hex('#f39c12')).cyl(0, 0, 0, 0.06, 0.02, 0.06, 7)),
    ladoo: one('ladoo', (b) => b.color(hex('#f5a623')).sphere(0, 0.035, 0, 0.035, 0)),
    bone: one('bone', (b) => {
      b.color(hex('#efe6d2')).rod([-0.07, 0.02, 0], [0.07, 0.02, 0], 0.012, 5);
      b.sphere(-0.075, 0.02, 0.012, 0.018, 0).sphere(-0.075, 0.02, -0.012, 0.018, 0);
      b.sphere(0.075, 0.02, 0.012, 0.018, 0).sphere(0.075, 0.02, -0.012, 0.018, 0);
    }),
    ball: one('ball', (b) => b.color(hex('#d61f26')).sphere(0, 0, 0, 0.036, 1)),
    chappal: one('chappal', (b) => {
      b.color(hex('#2f6db5')).box(-0.045, 0, -0.12, 0.045, 0.02, 0.12);
      b.color(hex('#f2f2f2')).box(-0.04, 0.02, 0.0, 0.04, 0.03, 0.03);
    }),
    // what floats down the nala
    bag: one('bag', (b) => {
      b.color(hex('#f2f2ee')).sphere(0, 0.03, 0, 0.12, 0, 0.45).sphere(0.09, 0.04, 0.05, 0.08, 0, 0.5);
      b.color(hex('#3d6fb5')).box(-0.03, 0.06, -0.1, 0.03, 0.08, -0.04);
    }),
    bagb: one('bagb', (b) => {
      b.color(hex('#2f5fa8')).sphere(0, 0.03, 0, 0.13, 0, 0.45).sphere(-0.08, 0.04, 0.06, 0.07, 0, 0.5);
    }),
    bagp: one('bagp', (b) => {
      b.color(hex('#d6457a')).sphere(0, 0.03, 0, 0.11, 0, 0.45);
    }),
    bottle: one('bottle', (b) => {
      b.color(hex('#a9cbb4')).rod([-0.1, 0.035, 0], [0.08, 0.035, 0], 0.035, 6);
      b.color(hex('#d23c2c')).rod([0.08, 0.035, 0], [0.13, 0.035, 0], 0.018, 5);
    }),
    cup: one('cup', (b) => {
      b.color(hex('#efefe8')).rod([-0.05, 0.03, 0], [0.04, 0.03, 0], 0.035, 7);
    }),
    foam: one('foam', (b) => {
      b.color(hex('#f4f4ef')).box(-0.2, 0, -0.12, 0.2, 0.06, 0.12).box(0.05, 0, 0.05, 0.3, 0.05, 0.2);
    }),
    carton: one('carton', (b) => {
      b.color(hex('#f5f5f0')).box(-0.05, 0, -0.03, 0.05, 0.16, 0.03);
      b.color(hex('#c62828')).box(-0.051, 0.05, -0.031, 0.051, 0.11, 0.031);
    }),
    tyre: one('tyre', (b) => {
      b.color(hex('#1d1d1f'));
      for (let k = 0; k < 10; k++) {
        const a0 = (k / 10) * Math.PI * 2, a1 = ((k + 1) / 10) * Math.PI * 2;
        b.rod([Math.cos(a0) * 0.28, 0.04, Math.sin(a0) * 0.28], [Math.cos(a1) * 0.28, 0.04, Math.sin(a1) * 0.28], 0.07, 5);
      }
    }),
    // luggage on the train roofs, and the gateman's flag
    bundle: one('bundle', (b) => {
      b.color(hex('#b03a2e')).sphere(0, 0.2, 0, 0.3, 1, 0.65);
      b.color(hex('#f1c40f')).boxC(0, 0.36, 0, 0.12, 0.08, 0.12);
    }),
    trunk: one('trunk', (b) => {
      b.color(hex('#2e6b8a')).box(-0.38, 0, -0.24, 0.38, 0.32, 0.24);
      b.color(hex('#b8bcc2')).box(-0.39, 0.29, -0.25, 0.39, 0.33, 0.25).boxC(0, 0.2, 0.245, 0.08, 0.08, 0.02);
    }),
    // things the street kids and the rope walker's family carry
    balloons: one('balloons', (b) => {
      const cols = ['#e53935', '#fdd835', '#1e88e5', '#43a047', '#e91e63', '#ff9800'];
      cols.forEach((c, i) => {
        const a = (i / cols.length) * Math.PI * 2, r = i % 2 ? 0.16 : 0.1;
        const top = [Math.cos(a) * r, 0.75 + (i % 3) * 0.12, Math.sin(a) * r];
        b.color(hex('#e8e8e8')).rod([0, 0, 0], top, 0.004, 3);
        b.color(hex(c)).sphere(top[0], top[1] + 0.11, top[2], 0.11, 1, 1.2);
      });
    }),
    garlands: one('garlands', (b) => {
      // three loops of marigold and jasmine hanging from the hand
      [['#ff8f00', 0.0], ['#ffd54f', 0.05], ['#fafafa', -0.05]].forEach(([c, dx]) => {
        b.color(hex(c));
        for (let k = 0; k <= 8; k++) {
          const t = k / 8, a = Math.PI * t;
          b.boxC(dx + Math.cos(a) * 0.09, -Math.sin(a) * 0.38, 0.02, 0.045, 0.045, 0.045);
        }
      });
    }),
    pole: one('pole', (b) => {
      b.color(hex('#c9a66b')).rod([-1.7, 0, 0], [1.7, 0, 0], 0.022, 5);
      b.color(hex('#d32f2f')).rod([-1.72, 0, 0], [-1.55, 0, 0], 0.03, 5).rod([1.55, 0, 0], [1.72, 0, 0], 0.03, 5);
    }),
    pot: one('pot', (b) => {
      b.color(hex('#d4a017')).sphere(0, 0.13, 0, 0.13, 1, 0.9);
      b.cyl(0, 0.22, 0, 0.06, 0.3, 0.085, 8, { smooth: true });
    }),
    dholak: one('dholak', (b) => {
      b.color(hex('#8d3b1f')).cyl(0, -0.15, 0, 0.14, 0.15, 0.14, 10, { smooth: true });
      b.color(hex('#efe6d2'));
      for (let k = 0; k < 6; k++) b.boxC(0, -0.15 + k * 0.06, 0, 0.3, 0.012, 0.3);
    }),
    plate: one('plate', (b) => {
      b.color(hex('#c0c4c8')).cyl(0, 0, 0, 0.17, 0.025, 0.19, 10, { caps: 'b' });
      b.color(hex('#e6c35c')).boxC(0.04, 0.03, 0.02, 0.04, 0.008, 0.04).boxC(-0.05, 0.03, -0.03, 0.04, 0.008, 0.04);
    }),
    flag: one('flag', (b) => {
      b.color(hex('#7a5230')).rod([0, 0, 0], [0, 0.55, 0], 0.012, 4);
      b.color(hex('#1f9d3a')).box(0, 0.32, -0.005, 0.34, 0.55, 0.005);
    }),
    bowl: one('bowl', (b) => {
      b.color(hex('#9a9da3')).cyl(0, 0, 0, 0.09, 0.06, 0.13, 10, { caps: 'b' });
      b.color(hex('#f4f1e8')).cyl(0, 0.045, 0, 0.115, 0.05, 0.115, 10, { caps: 't' });
    }),
  };
}

/** Every model the renderer instances, by name. */
export function buildAllModels() {
  const people = buildPeople();
  const items = buildItems();
  return Object.assign({
    dog: buildDog(),
    cow: buildCow(),
    goat: buildGoat(),
    bird: buildBird(),
    auto: buildAuto(),
    scooter: buildScooter('scooter'),
    bike: buildScooter('bike'),
    cycle: buildCycle(),
    car: buildCar(),
    bus: buildBus(),
    truck: buildTruck(),
    rickshaw: buildRickshaw(),
    loco: buildLoco(),
    coach: buildCoach(),
    boom: buildBoom(),
  }, people, items);
}

export const PEOPLE_KINDS = ['man', 'manMustache', 'kurta', 'lungi', 'turban', 'cap', 'saree', 'salwar', 'kid', 'girl', 'elder', 'batter'];
