import * as THREE from "three";
import { SUN_ANGULAR_DIAMETER, isUsDst, solarPosition } from "./solar.js";

/**
 * Words on the ground
 * -------------------
 * Which letters of the screen project onto the paving as clear, readable
 * glyphs for a given sun, and when in the year that happens.
 *
 * The render (tracer.js) is exact; this module is the fast judge that says
 * where to look. Per letter, using its real position on the plate
 * (public/kryptos_screen_layout.json, written by build_screen.py):
 *
 *   louvre   a ray crossing the 1/4-in plate drops t*sin(el)/cos(i) and
 *            shifts sideways t*(L.T)/cos(i); once the drop eats most of a
 *            horizontal stroke (~0.3 u) the letter degrades to dashes;
 *   blur     the 0.53 deg sun blurs by throw*delta, stretched by 1/cos(i)
 *            in the letter's own frame; clear while below 0.3 cap height;
 *   shape    on the ground the letter's up axis lies along the shadow
 *            direction (stretched by cot(el)) and its row along the panel,
 *            so a sun far to the side shears the letter;
 *   ground   (ray cast) the light must land on paving -- not water, rock or
 *            the other panel -- and nothing else may shade that spot.
 *
 * A "word" is a run of >= 3 consecutive readable letters in one row.
 */

// Thresholds calibrated against the ray-traced render (legibility audit,
// 2026-09-27): words read fluently to ~50 deg sun and are still readable at
// ~55 deg even though the horizontal strokes are mostly cut off -- readers
// recognise letters from stems, diagonals and stroke remnants; by ~60 deg
// they are dashes. They still read at an 8-12 deg sun and when slanted by
// up to ~0.8 (sin of the angle between shadow direction and panel normal).
export const CRITERIA = {
  maxDrop: 0.32, // vertical drop of a ray across the plate, u (~56 deg square-on)
  thinStem: 0.34, // thin diagonals/stems of N, M, W
  maxStemLoss: 0.6,
  maxBlur: 0.3, // blur (letter frame) / cap height
  maxShear: 0.8,
  minCosIncidence: 0.2,
  maxStretch: 7.1, // cot(el): el >= ~8 deg
  minRun: 3,
  waterY: 11, // the pool basin in the printable platform lies below this
  groundPlaneY: 14.0, // the lab's courtyard ground plane
  sample: 0.8, // sun-visibility samples +-0.8 u across each letter
};

export const REASON = {
  0: "readable",
  1: "the sun is too low",
  2: "the sun is too high: the ¼″ plate walls cut the letters into dashes (needs the sun below ~55°)",
  3: "the sun is too far to the side of the panels",
  4: "the letters are too blurred at this distance",
  5: "the sun strikes the panels too obliquely",
  6: "the sun is below the horizon",
  7: "the letter light lands on water, rock or the other panel",
  8: "the sun cannot reach those letters: another part of the sculpture, the tree or a rock shades them",
};

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();

/** Unit vector toward the sun in lab world coordinates (north = -Z, east = +X). */
export function sunVector(azimuthDeg, elevationDeg, out = new THREE.Vector3()) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export class WordFinder {
  /**
   * @param {object} layout parsed kryptos_screen_layout.json (Blender coords)
   * @param {THREE.Vector3} offset glTF scene offset inside modelRoot
   */
  constructor(layout, offset) {
    this.t = layout.thickness;
    this.cap = layout.cap;
    const cs = layout.curve.s;
    const cxy = layout.curve.xy;
    const at = (s) => {
      s = Math.min(Math.max(s, 0), cs[cs.length - 1]);
      let lo = 0;
      let hi = cs.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cs[mid] <= s) lo = mid;
        else hi = mid;
      }
      const seg = cs[hi] - cs[lo];
      const f = seg > 0 ? (s - cs[lo]) / seg : 0;
      const x = cxy[lo][0] + (cxy[hi][0] - cxy[lo][0]) * f;
      const y = cxy[lo][1] + (cxy[hi][1] - cxy[lo][1]) * f;
      let tx = cxy[hi][0] - cxy[lo][0];
      let ty = cxy[hi][1] - cxy[lo][1];
      const len = Math.hypot(tx, ty) || 1;
      return [x, y, tx / len, ty / len];
    };

    const g = layout.glyphs;
    const n = g.length;
    this.n = n;
    this.glyphs = g;
    // Positions/vectors in modelRoot-local space. Blender (x, y, z) maps to
    // glTF (x, z, -y); the lab adds the scene offset.
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    const rows = new Map();
    for (let k = 0; k < n; k++) {
      const gl = g[k];
      const [bx, by, btx, bty] = at((gl.s0 + gl.s1) / 2);
      this.px[k] = bx + offset.x;
      this.py[k] = (gl.z0 + gl.z1) / 2 + offset.y;
      this.pz[k] = -by + offset.z;
      this.tx[k] = btx;
      this.tz[k] = -bty;
      // Blender normal (-ty, tx, 0) -> glTF (-ty, 0, -tx)
      this.nx[k] = -bty;
      this.nz[k] = -btx;
      const key = `${gl.field}:${gl.row}`;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(k);
    }
    for (const list of rows.values()) list.sort((a, b) => g[a].i - g[b].i);
    // plan curve in modelRoot-local x/z, for "does this ray cross the screen
    // a second time" tests
    this.curveS = Float32Array.from(cs);
    this.curveX = Float32Array.from(cxy, (p) => p[0] + offset.x);
    this.curveZ = Float32Array.from(cxy, (p) => -p[1] + offset.z);
    this.glyphS = Float32Array.from(g, (gl) => (gl.s0 + gl.s1) / 2);
    this.plateY0 = layout.z_bottom + offset.y;
    this.plateY1 = this.plateY0 + 124.6;
    this.rows = [...rows.entries()];
    this.status = new Uint8Array(n);
    this.quality = new Float32Array(n);
  }

  /**
   * Analytic pass for sun direction L (unit, modelRoot-local).
   * Fills this.status (0 = readable) and this.quality (0..1).
   */
  evaluate(L, groundY) {
    const C = CRITERIA;
    const { t, cap, status, quality } = this;
    const Ly = L.y;
    const Lh = Math.hypot(L.x, L.z);
    const sinMin = Math.sin(Math.atan(1 / C.maxStretch));
    for (let k = 0; k < this.n; k++) {
      if (Ly <= 0) {
        status[k] = 6;
        continue;
      }
      if (Ly < sinMin) {
        status[k] = 1;
        continue;
      }
      const LN = L.x * this.nx[k] + L.z * this.nz[k];
      const cosi = Math.abs(LN);
      if (cosi < C.minCosIncidence) {
        status[k] = 5;
        continue;
      }
      const LT = L.x * this.tx[k] + L.z * this.tz[k];
      const shear = Math.abs(LT) / Lh;
      if (shear > C.maxShear) {
        status[k] = 3;
        continue;
      }
      const dv = (t * Ly) / cosi;
      const bar = dv / C.maxDrop;
      if (bar > 1) {
        status[k] = 2;
        continue;
      }
      const dl = (t * Math.abs(LT)) / cosi;
      const stem = dl / (C.thinStem * C.maxStemLoss);
      if (stem > 1) {
        status[k] = 3;
        continue;
      }
      const d = Math.max(this.py[k] - groundY, 0) / Ly;
      const blur = (d * SUN_ANGULAR_DIAMETER) / cosi / cap / C.maxBlur;
      if (blur > 1) {
        status[k] = 4;
        continue;
      }
      status[k] = 0;
      const stretch = Lh / Ly / C.maxStretch;
      quality[k] = 1 - 0.3 * blur - 0.3 * bar - 0.25 * (shear / C.maxShear) - 0.15 * stretch;
    }
  }

  /** Set the plate's vertical extent (modelRoot-local y). */
  setPlateY(y0, y1) {
    this.plateY0 = y0;
    this.plateY1 = y1;
  }

  /**
   * Does the ray from letter k toward the sun cross the screen again? It then
   * meets either copper (shade) or a second letter hole (light through two
   * stencils lands as fragments). Plan-curve test, so it also sees holes.
   */
  crossesScreenAgain(k, L) {
    const Lh = Math.hypot(L.x, L.z);
    if (Lh < 1e-6) return false;
    const dx = L.x / Lh;
    const dz = L.z / Lh;
    const rise = L.y / Lh;
    const ox = this.px[k];
    const oz = this.pz[k];
    const oy = this.py[k];
    const sk = this.glyphS[k];
    const { curveX: X, curveZ: Z, curveS: S } = this;
    for (let i = 0; i < X.length - 1; i++) {
      if (Math.abs(S[i] - sk) < 2.0 && Math.abs(S[i + 1] - sk) < 2.0) continue;
      const ex = X[i + 1] - X[i];
      const ez = Z[i + 1] - Z[i];
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = X[i] - ox;
      const wz = Z[i] - oz;
      const u = (wx * ez - wz * ex) / den; // along the ray (horizontal)
      const v = (wx * dz - wz * dx) / den; // along the segment
      if (u < 0.5 || v < 0 || v > 1) continue;
      const sHit = S[i] + v * (S[i + 1] - S[i]);
      if (Math.abs(sHit - sk) < 2.0) continue;
      const y = oy + u * rise;
      if (y > this.plateY0 - 0.2 && y < this.plateY1 + 0.2) return true;
    }
    return false;
  }

  /**
   * Ray-cast check for the given letters:
   *  - sun side: the sun must reach the letter (5 samples across it; the
   *    screen, platform, tree and rocks can all shade it), and the ray must
   *    not pass through the screen a second time;
   *  - ground side: the light must land where the camera sees paving --
   *    the platform above the waterline, or the courtyard plane where it is
   *    not cut away over the pool (groundOpen(x, z)).
   * @param {{screen:any, platform:any, context:any}} bvhs modelRoot-local BVHs
   */
  verify(L, groundY, bvhs, which, groundOpen = () => true) {
    const C = CRITERIA;
    const nL = _v.copy(L).negate();
    this.landing = this.landing ?? new Float32Array(this.n * 3);
    this.landed = this.landed ?? new Uint8Array(this.n);
    this.landed.fill(0);
    const bvhList = Object.entries(bvhs).filter(([, b]) => b);
    for (const k of which) {
      if (this.status[k] !== 0) continue;
      const cosi = Math.abs(L.x * this.nx[k] + L.z * this.nz[k]);
      const exit = (0.5 * this.t) / cosi + 0.05;

      // --- sun side
      if (this.crossesScreenAgain(k, L)) {
        this.status[k] = 8;
        continue;
      }
      let shaded = 0;
      const h = C.sample;
      for (const [a, b] of [[0, 0], [h, 0], [-h, 0], [0, h], [0, -h]]) {
        _ray.origin.set(
          this.px[k] + this.tx[k] * a + L.x * exit,
          this.py[k] + b + L.y * exit,
          this.pz[k] + this.tz[k] * a + L.z * exit,
        );
        _ray.direction.copy(L);
        for (const [, bvh] of bvhList) {
          if (bvh.raycastFirst(_ray, THREE.DoubleSide)) {
            shaded++;
            break;
          }
        }
        if (shaded >= 2) break;
      }
      if (shaded >= 2) {
        this.status[k] = 8;
        continue;
      }

      // --- ground side: from just beyond the plate, along the light, down
      // to below the waterline
      _ray.origin.set(this.px[k], this.py[k], this.pz[k]).addScaledVector(nL, exit);
      _ray.direction.copy(nL);
      const tPlane = (_ray.origin.y - C.groundPlaneY) / L.y;
      const tFar = (_ray.origin.y - (C.waterY - 1)) / L.y;
      let best = null;
      let bestWhat = null;
      for (const [what, bvh] of bvhList) {
        const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, tFar);
        if (hit && (!best || hit.distance < best.distance)) {
          best = hit;
          bestWhat = what;
        }
      }
      const px = _ray.origin.x + nL.x * tPlane;
      const pz = _ray.origin.z + nL.z * tPlane;
      let lx;
      let ly;
      let lz;
      if ((!best || best.distance > tPlane) && groundOpen(px, pz)) {
        lx = px;
        ly = C.groundPlaneY;
        lz = pz;
      } else if (best) {
        const up = best.face?.normal ? Math.abs(best.face.normal.y) : 1;
        if (bestWhat !== "platform" || best.point.y < C.waterY || up < 0.5) {
          this.status[k] = 7; // water, rock, tree, or the other panel
          continue;
        }
        ({ x: lx, y: ly, z: lz } = best.point);
      } else {
        this.status[k] = 7;
        continue;
      }
      this.landing[3 * k] = lx;
      this.landing[3 * k + 1] = ly;
      this.landing[3 * k + 2] = lz;
      this.landed[k] = 1;
    }
  }

  /** Runs of >= minRun readable letters. Returns {count, score, runs[]}. */
  runs() {
    const out = [];
    let count = 0;
    let score = 0;
    for (const [key, list] of this.rows) {
      let start = -1;
      for (let j = 0; j <= list.length; j++) {
        const ok = j < list.length && this.status[list[j]] === 0;
        if (ok && start < 0) start = j;
        if (!ok && start >= 0) {
          const len = j - start;
          if (len >= CRITERIA.minRun) {
            const idx = list.slice(start, j);
            let q = 0;
            for (const k of idx) q += this.quality[k];
            out.push({ key, idx, len, quality: q / len });
            count += len;
            score += q;
          }
          start = -1;
        }
      }
    }
    out.sort((a, b) => b.len * b.quality - a.len * a.quality);
    return { count, score, runs: out };
  }

  /**
   * Main reason letters fail (for the "why not" message). Panels that are
   * edge-on to the sun (3, 5) fail at every sun, so a reason that applies to
   * the panels that DO face the sun is reported first when it is common.
   */
  mainReason() {
    const tally = new Array(9).fill(0);
    for (let k = 0; k < this.n; k++) tally[this.status[k]]++;
    tally[0] = 0;
    let best = 1;
    for (const r of [1, 2, 4, 6, 7, 8]) if (tally[r] > tally[best]) best = r;
    if (tally[best] >= 0.05 * this.n) return REASON[best];
    for (let r = 1; r < tally.length; r++) if (tally[r] > tally[best]) best = r;
    return REASON[best];
  }

  /** Full evaluation (analytic + ray-cast check) for one sun. */
  evaluateVerified(L, groundY, bvhs, groundOpen) {
    this.evaluate(L, groundY);
    const first = this.runs();
    const which = first.runs.flatMap((r) => r.idx);
    this.verify(L, groundY, bvhs, which, groundOpen);
    return this.runs();
  }

  /** Text of a run in reading order, and where/how it lies on the ground. */
  describe(run, L, yawMatrix) {
    const g = this.glyphs;
    const first = g[run.idx[0]];
    const text = run.idx.map((k) => g[k].c).join("");
    // centre of the landing spots (modelRoot-local)
    const c = new THREE.Vector3();
    let n = 0;
    const lm = this.landing;
    for (const k of run.idx) {
      if (lm && this.landed?.[k]) {
        c.x += lm[3 * k];
        c.y += lm[3 * k + 1];
        c.z += lm[3 * k + 2];
      } else {
        const d = (this.py[k] - CRITERIA.groundPlaneY) / L.y;
        c.x += this.px[k] - L.x * d;
        c.y += CRITERIA.groundPlaneY;
        c.z += this.pz[k] - L.z * d;
      }
      n++;
    }
    c.multiplyScalar(1 / n);
    // letter "up" on the ground points away from the sun; reading direction
    // follows the panel tangent (times the row's reading sign)
    const k0 = run.idx[Math.floor(run.idx.length / 2)];
    const up = new THREE.Vector3(-L.x, 0, -L.z).normalize();
    const read = new THREE.Vector3(this.tx[k0], 0, this.tz[k0]).multiplyScalar(g[k0].dir);
    const center = c.applyMatrix4(yawMatrix);
    up.transformDirection(yawMatrix);
    read.transformDirection(yawMatrix);
    // Seen from above with a proper (x, -z) screen frame, the letters read
    // correctly iff (reading, up) is counter-clockwise.
    const det = -read.x * up.z + read.z * up.x;
    const kl = run.idx[0];
    const kr = run.idx[run.idx.length - 1];
    const span = Math.hypot(this.px[kr] - this.px[kl], this.pz[kr] - this.pz[kl]);
    const stretch = Math.hypot(L.x, L.z) / L.y;
    return {
      text,
      field: first.field,
      row: first.row,
      center,
      up,
      mirrored: det < 0,
      width: span + this.cap,
      depth: this.cap * stretch,
    };
  }

  /**
   * Scan a year of suns (analytic pass only), then ray-check the best
   * candidates. `toLocal(azimuth, elevation)` returns the modelRoot-local
   * sun vector. Returns the best distinct times.
   */
  async scanYear({ year, latitude, longitude, standardOffset, toLocal, groundY, bvhs, groundOpen, onProgress, cancelled }) {
    const cands = [];
    const L = new THREE.Vector3();
    const doy0 = Date.UTC(year, 0, 1);
    for (let day = 0; day < 365; day += 2) {
      const date = new Date(doy0 + day * 86400000);
      const m = date.getUTCMonth() + 1;
      const d = date.getUTCDate();
      const dst = isUsDst(year, m, d);
      for (let minutes = 6 * 60; minutes <= 20 * 60; minutes += 10) {
        const pos = solarPosition({
          year, month: m, day: d, minutes, latitude, longitude,
          utcOffset: standardOffset + (dst ? 1 : 0),
        });
        if (pos.elevation < 8) continue;
        toLocal(pos.azimuth, pos.elevation, L);
        this.evaluate(L, groundY);
        const r = this.runs();
        if (r.count > 0) cands.push({ day, m, d, minutes, dst, az: pos.azimuth, el: pos.elevation, score: r.score });
      }
      if (day % 20 === 0) {
        onProgress?.((0.9 * day) / 365);
        await new Promise((res) => setTimeout(res, 0));
        if (cancelled?.()) return null;
      }
    }
    cands.sort((a, b) => b.score - a.score);
    // Ray-check the analytic leaders (shade can remove many of them), then
    // keep distinct SUN POSITIONS: dates either side of a solstice repeat
    // the same sun, so compare direction, not date.
    const checked = [];
    for (const c of cands) {
      if (checked.length >= 80) break;
      if (checked.some((p) => Math.abs(p.az - c.az) < 3 && Math.abs(p.el - c.el) < 1.5)) continue;
      toLocal(c.az, c.el, L);
      const r = this.evaluateVerified(L, groundY, bvhs, groundOpen);
      c.score = r.score;
      c.count = r.count;
      c.best = r.runs[0] ? r.runs[0].idx.map((k) => this.glyphs[k].c).join("") : "";
      c.bestKey = r.runs[0]?.key;
      checked.push(c);
      if (checked.length % 8 === 0) {
        onProgress?.(0.9 + (0.1 * checked.length) / 80);
        await new Promise((res) => setTimeout(res, 0));
        if (cancelled?.()) return null;
      }
    }
    checked.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of checked) {
      if (c.count === 0) continue;
      if (picked.some((p) => Math.abs(p.az - c.az) < 12 && Math.abs(p.el - c.el) < 6)) continue;
      picked.push(c);
      if (picked.length >= 6) break;
    }
    onProgress?.(1);
    return picked;
  }
}
