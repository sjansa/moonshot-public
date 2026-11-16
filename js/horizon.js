// horizon.js -- skyline of a place and terrain rise/set. No DOM.
import { buildPano, chainCrests, TAU } from '../core/terrain.js?v=1115.1822-4403c80';

// Interior crests that stand less than this far above or below eye level are
// ground ripple (a field's swell, a levee, sampling noise at the edge of the
// fine grid), not ridges. On gentle ground a 15 m swell 1 km away hides the
// whole plain behind it, so it chains into a long, straight line that reads as
// an artifact in the picture. Real ridgelines stand hundreds of meters up.
export const MIN_RIDGE_M = 30;

/** Median height of a chain's crest points relative to eye level, meters (absolute value). */
function ridgeHeight(r) {
  const v = Array.from(r.t, (t, i) => Math.abs(t * r.d[i])).sort((a, b) => a - b);
  return v[v.length >> 1];
}

/**
 * Build the horizon for a place. Keeps only what is needed so the big pano
 * rasters can be garbage collected.
 * -> { lat, lon, hEye, na, skyT, skyD, ridges: [{cols, t, d}] }
 */
export function makeHorizon(terrain, lat, lon, eyeM = 1.7, maxDist = 60000) {
  const pano = buildPano(terrain, lat, lon, { eye: eyeM, maxDist });
  const ridges = chainCrests(pano).filter(r => ridgeHeight(r) >= MIN_RIDGE_M).map(r => ({ cols: r.cols, t: r.t, d: r.d }));
  return { lat, lon, hEye: pano.hEye, na: pano.na, skyT: pano.skyT, skyD: pano.skyD, ridges };
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
