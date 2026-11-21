// horizon.js -- skyline of a place and terrain rise/set. No DOM.
import { buildPano, chainCrests, TAU, PANO_T_MAX } from '../core/terrain.js?v=1120.1904-45b57d5';

// Which interior crests are drawn as ridges. Seen from a valley, every low
// swell and bench within a couple of km hides the plain behind it and chains
// into a line near level; from Sandy there are dozens of them, 30 to 90 m up,
// and they read as clutter under the real mountains. Ridges that shape the
// picture stand well above the eye, and run for more than a degree or two.
export const MIN_RIDGE_M = 100;        // median height above or below eye level
export const MIN_RIDGE_COLS = 15;      // length in azimuth columns (0.1 degree each)
// ...unless the crest is a near feature masking far terrain: a rock or a butte a few hundred
// metres off, with mountains tens of km behind it, is drawn however low it is (mean
// log(dFar / d) at least this: the hidden ground is 8 times farther than the crest), and it
// stands clearly above eye level (a low swell on the plain hides far ground too, but reads
// as clutter: the demo's 25 m ripple is 0.7 degrees up).
export const MASK_JUMP = Math.log(8), MASK_MIN_T = Math.tan(1.5 * Math.PI / 180);
// Sides of near features: where the visible distance jumps between neighbouring azimuth
// columns, the near side is an outline too (the skyline and crests only trace tops).
export const SIDE_NEAR_M = 5000;       // only features closer than this
export const SIDE_RATIO = 4;           // far side at least this many times farther
export const SIDE_MIN_M = 8;           // and the side at least this tall (metres)

/** Median height of a chain's crest points relative to eye level, meters (absolute value). */
function ridgeHeight(r) {
  const v = Array.from(r.t, (t, i) => Math.abs(t * r.d[i])).sort((a, b) => a - b);
  return v[v.length >> 1];
}

function medianT(r) { const v = Array.from(r.t).sort((a, b) => a - b); return v[v.length >> 1]; }

/**
 * Build the horizon for a place. Keeps only what is needed so the big pano
 * rasters can be garbage collected.
 * -> { lat, lon, hEye, na, skyT, skyD, ridges: [{cols, t, d}] }
 */
export function makeHorizon(terrain, lat, lon, eyeM = 1.7, maxDist = 60000) {
  const pano = buildPano(terrain, lat, lon, { eye: eyeM, maxDist });
  const ridges = chainCrests(pano).filter(r => r.cols.length >= MIN_RIDGE_COLS && (ridgeHeight(r) >= MIN_RIDGE_M || (r.jump >= MASK_JUMP && medianT(r) >= MASK_MIN_T))).map(r => ({ cols: r.cols, t: r.t, d: r.d }));
  ridges.push(...sideEdges(pano));
  return { lat, lon, hEye: pano.hEye, na: pano.na, skyT: pano.skyT, skyD: pano.skyD, ridges };
}

/**
 * Vertical outlines of near features against farther terrain: runs of rows where the visible
 * distance jumps between neighbouring columns. Same shape as ridges ({cols, t, d}), one column
 * per point, so they draw the same way.
 */
export function sideEdges(p) {
  const { na, nt, dT, dist } = p, PT = PANO_T_MAX, out = [];
  const open = new Map();                      // near column -> run being built
  const close = (key, run) => {
    open.delete(key);
    const n = run.rows.length;
    if (n < 3) return;
    const dMed = run.d.slice().sort((a, b) => a - b)[n >> 1];
    if ((n - 1) * dT * dMed < SIDE_MIN_M) return;
    out.push({ cols: Int32Array.from(run.cols), t: Float32Array.from(run.rows, r => PT - (r + 0.5) * dT), d: Float32Array.from(run.d) });
  };
  for (let r = 0; r < nt; r++) {
    const seen = new Set();
    for (let a = 0; a < na; a++) {
      const b = (a + 1) % na, dA = dist[r * na + a], dB = dist[r * na + b];
      if (!(dA > 0 && dB > 0)) continue;                   // sky on one side: the skyline draws it
      const near = Math.min(dA, dB), far = Math.max(dA, dB);
      if (near > SIDE_NEAR_M || far < SIDE_RATIO * near) continue;
      const col = dA < dB ? a : b;
      // continue a run from the row above in this column or one beside it
      let key = null;
      for (const c of [col, col - 1, col + 1]) { const k = (c + na) % na; if (open.has(k) && open.get(k).last === r - 1 && !seen.has(k)) { key = k; break; } }
      const run = key != null ? open.get(key) : { cols: [], rows: [], d: [], last: -1 };
      if (key != null) open.delete(key);
      run.cols.push(col); run.rows.push(r); run.d.push(near); run.last = r;
      open.set(col, run); seen.add(col);
    }
    for (const [k, run] of [...open]) if (run.last < r) close(k, run);
  }
  for (const [k, run] of [...open]) close(k, run);
  return out;
}

/** tan(elevation) of the skyline at az (radians), interpolated, wrapping at 2 pi. */
export function skyTAt(h, az) {
  const na = h.na;
  let x = (az % TAU) * na / TAU;
  if (x < 0) x += na;
  let i = Math.floor(x);
  const f = x - i;
  if (i >= na) i -= na;
  const j = i + 1 === na ? 0 : i + 1;
  return h.skyT[i] + (h.skyT[j] - h.skyT[i]) * f;
}

/** Is a direction (az, alt radians) behind terrain? */
export function hidden(h, az, alt) {
  return Math.tan(alt) < skyTAt(h, az);
}

/**
 * Times in the 24 h from dayStart (Date) when a body clears or drops behind the
 * terrain. positionAt(date) -> {az, alt} radians. opts: {stepMs = 120000, hours = 24}.
 * -> [{date: Date, kind: 'clears' | 'drops'}]
 */
export function terrainEvents(h, positionAt, dayStart, opts = {}) {
  const f = d => { const p = positionAt(d); return p.alt - Math.atan(skyTAt(h, p.az)); };
  const t0 = dayStart.getTime(), step = opts.stepMs || 120000, n = Math.round((opts.hours || 24) * 3600000 / step);
  const out = [];
  let prevT = t0, prev = f(new Date(prevT));
  for (let i = 1; i <= n; i++) {
    const t = t0 + i * step, cur = f(new Date(t));
    if ((prev > 0) !== (cur > 0)) {
      let lo = prevT, hi = t;
      while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2);
        if ((f(new Date(mid)) > 0) === (prev > 0)) lo = mid; else hi = mid;
      }
      out.push({ date: new Date(hi), kind: cur > 0 ? 'clears' : 'drops' });
    }
    prevT = t; prev = cur;
  }
  return out;
}
