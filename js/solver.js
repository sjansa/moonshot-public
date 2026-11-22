// solver.js -- where must an observer stand so that a body rises/sets behind a subject? No DOM.
// Angles in radians unless a name ends in Deg. Elevation grids are in web-mercator pixel space.
import { R_EFF, R_EARTH, D2R, TAU } from '../core/terrain.js?v=1122.0212-79fa2c9';
import * as astro from './astro.js?v=1122.0212-79fa2c9';

const MIN_D = 300, LOS_N = 64, M_DEG = R_EARTH * D2R;

// ---- web mercator -----------------------------------------------------------
export function lonLatToPx(lon, lat, z) {
  const s = 256 * 2 ** z, r = Math.max(-85.0511, Math.min(85.0511, lat)) * D2R;
  return { x: (lon + 180) / 360 * s, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * s };
}
export function pxToLonLat(x, y, z) {
  const s = 256 * 2 ** z;
  return { lon: x / s * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))) / D2R };
}

/** Bilinear elevation (m); cell (i, j) is the value at the centre of pixel (x0 + i, y0 + j). NaN outside. */
export function elevAt(g, lon, lat) {
  const p = lonLatToPx(lon, lat, g.z), u = p.x - g.x0 - 0.5, v = p.y - g.y0 - 0.5;
  if (!(u >= 0 && v >= 0 && u <= g.nx - 1 && v <= g.ny - 1)) return NaN;
  const i = Math.min(Math.floor(u), g.nx - 2), j = Math.min(Math.floor(v), g.ny - 2);
  const fu = u - i, fv = v - j, d = g.data, k = j * g.nx + i;
  if (g.nx < 2 || g.ny < 2) return d[0];
  return (d[k] * (1 - fu) + d[k + 1] * fu) * (1 - fv) + (d[k + g.nx] * (1 - fu) + d[k + g.nx + 1] * fu) * fv;
}

// ---- body tracks ------------------------------------------------------------
const BODIES = { moon: astro.Body.Moon, sun: astro.Body.Sun };

/** Runs of the body rising (or setting) between -2 and +40 deg altitude within `hours` of dayStart. */
export function bodyTrack(body, kind, dayStart, obs, hours = 24) {
  const t0 = +dayStart, n = Math.round(hours * 60), up = kind === 'rise';
  const pos = d => (body === 'gc' ? astro.gcAltAz(d, obs) : astro.altAz(BODIES[body], d, obs));
  const lo = -2 * D2R, hi = 40 * D2R, dark = -12 * D2R;
  const runs = [];
  let cur = null, prev = NaN;
  for (let i = 0; i <= n; i++) {
    const d = new Date(t0 + i * 60000), p = pos(d);
    let keep = i > 0 && p.alt >= lo && p.alt <= hi && (up ? p.alt > prev : p.alt < prev);
    if (keep && body === 'gc') keep = astro.altAz(astro.Body.Sun, d, obs).alt < dark;
    prev = p.alt;
    if (!keep) { cur = null; continue; }
    if (!cur) runs.push(cur = { t: [], az: [], alt: [] });
    let az = p.az;
    if (cur.az.length) { const l = cur.az[cur.az.length - 1]; az += Math.round((l - az) / TAU) * TAU; }
    cur.t.push(+d); cur.az.push(az); cur.alt.push(p.alt);
  }
  return runs.map(r => {
    const mid = new Date(r.t[r.t.length >> 1]);
    const radius = body === 'gc' ? 0 : astro.sunMoon(mid, obs)[body].radius;
    return { t: Float64Array.from(r.t), az: Float64Array.from(r.az), alt: Float64Array.from(r.alt), radius };
  });
}

// longest monotonic part of a run: [a, b] and direction (cached on the run)
function mono(r) {
  if (r._m) return r._m;
  const n = r.az.length;
  let best = [0, Math.max(0, n - 1), 1], a = 0, dir = 0;
  for (let i = 1; i < n; i++) {
    const s = Math.sign(r.az[i] - r.az[i - 1]);
    if (dir && s && s !== dir) { if (i - 1 - a > best[1] - best[0]) best = [a, i - 1, dir]; a = i - 1; }
    if (s) dir = s;
  }
  if (n - 1 - a > best[1] - best[0]) best = [a, n - 1, dir || 1];
  return (r._m = best);
}

/** Time and altitude at which the run passes azimuth `az`, or null. */
export function lookup(run, az) {
  const [a, b, dir] = mono(run), A = run.az;
  if (b <= a) return null;
  for (const k of [0, 1, -1]) {
    const x = az + k * TAU;
    if (dir > 0 ? (x < A[a] || x > A[b]) : (x > A[a] || x < A[b])) continue;
    let l = a, h = b;
    while (h - l > 1) { const m = (l + h) >> 1; if (dir > 0 ? A[m] <= x : A[m] >= x) l = m; else h = m; }
    const f = A[h] === A[l] ? 0 : (x - A[l]) / (A[h] - A[l]);
    return { t: run.t[l] + f * (run.t[h] - run.t[l]), alt: run.alt[l] + f * (run.alt[h] - run.alt[l]) };
  }
  return null;
}

// ---- subject geometry -------------------------------------------------------
/** View of subject {lat, lon, elev} from an observer: {az, alt, distM, visible} or null. */
export function subjectView(grid, subject, lat, lon, eyeM = 1.7, noLos = false, near = null) {
  // `near`: an optional finer grid around the observer; it is used where it has data
  const E = (lo, la) => { const z = near ? elevAt(near, lo, la) : NaN; return Number.isFinite(z) ? z : elevAt(grid, lo, la); };
  const g0 = E(lon, lat);
  if (!Number.isFinite(g0)) return null;
  const kx = Math.cos((lat + subject.lat) / 2 * D2R) * M_DEG;
  const e = (subject.lon - lon) * kx, n = (subject.lat - lat) * M_DEG, d = Math.hypot(e, n);
  if (d < MIN_D) return null;
  const h0 = g0 + eyeM, hs = subject.elev;
  const az = (Math.atan2(e, n) + TAU) % TAU;
  const alt = Math.atan((hs - h0) / d - d / (2 * R_EFF));
  let visible = true;
  if (!noLos) {
    // one sample per grid cell (at least LOS_N, at most 600), starting right in front of the observer:
    // a low rise 100 m away hides more sky than a ridge at 10 km. The allowance grows with distance.
    const cell = 40075017 * Math.cos(lat * D2R) / (256 * 2 ** grid.z);
    const nS = Math.min(600, Math.max(LOS_N, Math.ceil(d / cell)));
    for (let i = 1; i < nS && visible; i++) {
      const f = 0.95 * i / nS, x = f * d;
      const z = E(lon + (subject.lon - lon) * f, lat + (subject.lat - lat) * f);
      if (z > h0 + f * (hs - h0) - x * (d - x) / (2 * R_EFF) + Math.min(10, 2 + 0.01 * x)) visible = false;
    }
    // the first 1.5 km again in 15 m steps when a finer grid is there
    for (let x = 15; near && visible && x < Math.min(1500, 0.95 * d); x += 15) {
      const f = x / d, z = E(lon + (subject.lon - lon) * f, lat + (subject.lat - lat) * f);
      if (z > h0 + f * (hs - h0) - x * (d - x) / (2 * R_EFF) + Math.min(10, 2 + 0.01 * x)) visible = false;
    }
  }
  return { az, alt, distM: d, visible };
}

// the run whose body altitude at the subject's azimuth is closest to the subject's altitude
function match(runs, v) {
  let m = null;
  for (const r of runs) {
    const q = lookup(r, v.az);
    if (q && (!m || Math.abs(q.alt - v.alt) < Math.abs(m.miss))) m = { t: q.t, miss: q.alt - v.alt, radius: r.radius };
  }
  return m;
}

/** Shade grid: for every (strided) cell the miss in radians (NaN = no answer) and the time. */
export function solveGrid(grid, subject, runs, opts = {}) {
  const { eyeM = 1.7, tolDeg = 1.5, maxKm = 100 } = opts;
  const stride = opts.stride || Math.max(1, Math.ceil(Math.max(grid.nx, grid.ny) / 260));
  const nx = Math.floor(grid.nx / stride), ny = Math.floor(grid.ny / stride);
  const miss = new Float32Array(nx * ny).fill(NaN), t = new Float64Array(nx * ny);
  const tol = tolDeg * D2R;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = pxToLonLat(grid.x0 + (i + 0.5) * stride, grid.y0 + (j + 0.5) * stride, grid.z);
    const v = subjectView(grid, subject, p.lat, p.lon, eyeM, true);
    if (!v || v.distM > maxKm * 1000) continue;
    const m = match(runs, v);
    if (!m || Math.abs(m.miss) > tol) continue;
    if (!subjectView(grid, subject, p.lat, p.lon, eyeM).visible) continue;
    miss[j * nx + i] = m.miss; t[j * nx + i] = m.t;
  }
  return { nx, ny, stride, miss, t };
}

/** One point: {t (ms), az, alt (subject top), miss, distM, visible, radius} or null. */
export function solveSpot(grid, subject, runs, lat, lon, eyeM = 1.7, near = null) {
  const v = subjectView(grid, subject, lat, lon, eyeM, false, near);
  if (!v) return null;
  const m = match(runs, v);
  return m && { t: m.t, az: v.az, alt: v.alt, miss: m.miss, distM: v.distM, visible: v.visible, radius: m.radius };
}
