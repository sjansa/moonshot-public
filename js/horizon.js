// horizon.js -- skyline of a place and terrain rise/set. No DOM.
import { buildPano, chainCrests, TAU } from '../core/terrain.js?v=1115.1805-901b992';

/**
 * Build the horizon for a place. Keeps only what is needed so the big pano
 * rasters can be garbage collected.
 * -> { lat, lon, hEye, na, skyT, skyD, ridges: [{cols, t, d}] }
 */
export function makeHorizon(terrain, lat, lon, eyeM = 1.7, maxDist = 60000) {
  const pano = buildPano(terrain, lat, lon, { eye: eyeM, maxDist });
  const ridges = chainCrests(pano).map(r => ({ cols: r.cols, t: r.t, d: r.d }));
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
 * terrain. positionAt(date) -> {az, alt} radians.
 * -> [{date: Date, kind: 'clears' | 'drops'}]
 */
export function terrainEvents(h, positionAt, dayStart) {
  const f = d => { const p = positionAt(d); return p.alt - Math.atan(skyTAt(h, p.az)); };
  const t0 = dayStart.getTime(), step = 120000, n = 720;
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
