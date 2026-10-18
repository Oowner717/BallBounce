/*
 * spatial.js — a uniform grid over the world for "who is near here" questions.
 *
 * Rebuilt every step from scratch: clearing is just resetting each touched
 * cell's length, so there is no allocation in steady state. Entries are
 * circles { kind, ref, x, z, r } and live only for the step that inserted them.
 */

export class SpatialHash {
  constructor(cell = 3, half = 112) {
    this.cell = cell;
    this.half = half;
    this.n = Math.ceil((2 * half) / cell);
    this.cells = Array.from({ length: this.n * this.n }, () => []);
    this.touched = [];
    this.pool = [];
    this.used = 0;
  }

  clear() {
    for (const k of this.touched) this.cells[k].length = 0;
    this.touched.length = 0;
    this.used = 0;
  }

  key(x, z) {
    const i = Math.min(this.n - 1, Math.max(0, Math.floor((x + this.half) / this.cell)));
    const j = Math.min(this.n - 1, Math.max(0, Math.floor((z + this.half) / this.cell)));
    return j * this.n + i;
  }

  insert(kind, ref, x, z, r) {
    let e = this.pool[this.used];
    if (!e) { e = { kind: '', ref: null, x: 0, z: 0, r: 0 }; this.pool.push(e); }
    this.used++;
    e.kind = kind; e.ref = ref; e.x = x; e.z = z; e.r = r;
    const k = this.key(x, z);
    const c = this.cells[k];
    if (c.length === 0) this.touched.push(k);
    c.push(e);
    return e;
  }

  /** Entries whose centres lie in cells touching the circle (x, z, r). Caller filters by distance. */
  query(x, z, r, out) {
    out.length = 0;
    const c = this.cell, n = this.n;
    const i0 = Math.max(0, Math.floor((x - r + this.half) / c)), i1 = Math.min(n - 1, Math.floor((x + r + this.half) / c));
    const j0 = Math.max(0, Math.floor((z - r + this.half) / c)), j1 = Math.min(n - 1, Math.floor((z + r + this.half) / c));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = this.cells[j * n + i];
        for (let k = 0; k < cell.length; k++) out.push(cell[k]);
      }
    }
    return out;
  }
}
