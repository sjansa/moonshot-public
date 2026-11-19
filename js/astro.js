// Sun, moon and Milky Way positions. No DOM. Angles in radians unless the name
// ends in Deg. Directions are ENU unit vectors [east, north, up].
import * as A from '../vendor/astronomy.js?v=1119.0437-fbafc20';

export const Body = A.Body;

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const R_SUN_KM = 695700, R_MOON_KM = 1737.4;

export function observer(latDeg, lonDeg, heightM) { return new A.Observer(latDeg, lonDeg, heightM); }

export function enu(az, alt) {
  const c = Math.cos(alt);
  return [Math.sin(az) * c, Math.cos(az) * c, Math.sin(alt)];
}

const toTime = d => (d instanceof A.AstroTime ? d : A.MakeTime(d));

// body position: {az, alt (refracted), dir, distKm}
function bodyPos(body, t, obs) {
  const eq = A.Equator(body, t, obs, true, true);   // topocentric, required for the moon
  const hor = A.Horizon(t, obs, eq.ra, eq.dec, 'normal');
  const az = hor.azimuth * D2R, alt = hor.altitude * D2R;
  return { az, alt, dir: enu(az, alt), distKm: eq.dist * A.KM_PER_AU };
}

export function sunMoon(date, obs) {
  const t = toTime(date);
  const s = bodyPos(A.Body.Sun, t, obs);
  const m = bodyPos(A.Body.Moon, t, obs);
  const ill = A.Illumination(A.Body.Moon, t);
  // north pole of each body as an ENU direction, to turn its picture the right way up on the sky
  const hor = A.Rotation_EQJ_HOR(t, obs);
  const north = body => { const v = A.RotateVector(hor, A.RotationAxis(body, t).north); return [-v.y, v.x, v.z]; };
  return {
    sun: { az: s.az, alt: s.alt, dir: s.dir, radius: Math.asin(R_SUN_KM / s.distKm), north: north(A.Body.Sun) },
    moon: { az: m.az, alt: m.alt, dir: m.dir, radius: Math.asin(R_MOON_KM / m.distKm), north: north(A.Body.Moon),
            phaseAngle: ill.phase_angle * D2R, fraction: ill.phase_fraction },
  };
}

/** Just the position of one body: {az, alt} radians (refracted, topocentric). Cheaper than sunMoon. */
export function altAz(body, date, obs) {
  const p = bodyPos(body, toTime(date), obs);
  return { az: p.az, alt: p.alt };
}

/**
 * Altitude of a body anywhere on the earth at one moment, cheaply: (latDeg, lonDeg, refract = true)
 * -> radians, topocentric at sea level on a sphere, refracted as altAz() is (geometric with refract false).
 * For shading whole regions, where altAz() per point would be too slow.
 */
export function altField(body, date) {
  const t = toTime(date);
  const eq = A.EquatorFromVector(A.RotateVector(A.Rotation_EQJ_EQD(t), A.GeoVector(body, t, true)));
  const dec = eq.dec * D2R, lon0 = (eq.ra - A.SiderealTime(t)) * 15 * D2R;
  const sd = Math.sin(dec), cd = Math.cos(dec), sinP = 6371.0 / (eq.dist * A.KM_PER_AU);
  return (latDeg, lonDeg, refract = true) => {
    const p = latDeg * D2R, g = Math.asin(Math.max(-1, Math.min(1, Math.sin(p) * sd + Math.cos(p) * cd * Math.cos(lonDeg * D2R - lon0))));
    const a = Math.atan2(Math.sin(g) - sinP, Math.cos(g));     // seen from the surface, not the centre
    return refract ? a + A.Refraction('normal', a * R2D) * D2R : a;
  };
}

export function path(body, obs, startDate, hours = 24, stepMin = 10) {
  const out = [];
  const t0 = startDate.getTime(), n = Math.round(hours * 60 / stepMin);
  for (let i = 0; i <= n; i++) {
    const date = new Date(t0 + i * stepMin * 60000);
    const p = bodyPos(body, A.MakeTime(date), obs);
    out.push({ date, az: p.az, alt: p.alt, dir: p.dir });
  }
  return out;
}

// Milky Way model. Choice for the core: it is NOT in `points`; it is a separate
// entry `core = {gal: A.Vector, w: 1}` at l = 0, b = 0 (the grid also holds a
// point there, so the band is unchanged).
export function milkyWay() {
  const points = [];
  for (let l = 0; l < 360; l += 3) {
    const dl = l > 180 ? l - 360 : l;
    const sigma = 5 + 5 * Math.exp(-0.5 * (dl / 25) ** 2);
    const wl = 0.25 + 0.75 * Math.exp(-0.5 * (dl / 35) ** 2);
    for (let b = -12; b <= 12; b += 3) {
      const w = Math.exp(-0.5 * (b / sigma) ** 2) * wl;
      const cb = Math.cos(b * D2R);
      points.push({ gal: new A.Vector(cb * Math.cos(l * D2R), cb * Math.sin(l * D2R), Math.sin(b * D2R), null), w });
    }
  }
  return { points, core: { gal: new A.Vector(1, 0, 0, null), w: 1 } };
}

const vecEnu = v => [-v.y, v.x, v.z];

// -> {dirs: Float32Array (3 per point, ENU), core: [e, n, u], basis}
// Takes the object returned by milkyWay() (or just its points array; then core is null).
export function milkyWayAt(mw, date, obs) {
  const points = Array.isArray(mw) ? mw : mw.points;
  const t = toTime(date);
  const m = A.CombineRotation(A.Rotation_GAL_EQJ(), A.Rotation_EQJ_HOR(t, obs));
  const dirs = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    const [e, n, u] = vecEnu(A.RotateVector(m, p.gal));
    dirs[3 * i] = e; dirs[3 * i + 1] = n; dirs[3 * i + 2] = u;
  });
  const core = Array.isArray(mw) || !mw.core ? null : vecEnu(A.RotateVector(m, mw.core.gal));
  // the galactic x, y, z axes as ENU directions: a sky direction d has galactic coordinates (d.gx, d.gy, d.gz)
  const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => vecEnu(A.RotateVector(m, new A.Vector(a[0], a[1], a[2], t))));
  return { dirs, core, basis };
}

// Sea-level rise and set within the 24 h from dayStart: {rise: Date|null, set: Date|null}
export function riseSet(body, obs, dayStart) {
  const t = toTime(dayStart);
  const r = A.SearchRiseSet(body, obs, +1, t, 1);
  const s = A.SearchRiseSet(body, obs, -1, t, 1);
  return { rise: r ? r.date : null, set: s ? s.date : null };
}

export function sunBand(altDeg) {
  if (altDeg > 6) return 'day';
  if (altDeg > -4) return 'golden';
  if (altDeg > -6) return 'blue';
  if (altDeg > -12) return 'nautical';
  if (altDeg > -18) return 'astro';
  return 'night';
}

/** Galactic centre (J2000 RA 17h45m40.04s, Dec -29d00m28.1s): {az, alt} radians, refracted. */
export function gcAltAz(date, obs) {
  const t = toTime(date);
  A.DefineStar(A.Body.Star1, 17 + 45 / 60 + 40.04 / 3600, -(29 + 28.1 / 3600), 1000);
  const eq = A.Equator(A.Body.Star1, t, obs, true, true);
  const hor = A.Horizon(t, obs, eq.ra, eq.dec, 'normal');
  return { az: hor.azimuth * D2R, alt: hor.altitude * D2R };
}

/** Night sky summary for the night that begins on local day dayStart: {fraction, waxing, mwHours, dots 0..5}. */
export function nightSky(dayStart, obs) {
  const t0 = +dayStart, mid = new Date(t0 + 24 * 3600e3);
  const fraction = A.Illumination(A.Body.Moon, toTime(mid)).phase_fraction;
  const waxing = A.MoonPhase(toTime(mid)) < 180;
  let w = 0;
  for (let m = 12 * 60; m < 36 * 60; m += 10) {
    const d = new Date(t0 + m * 60e3), sun = altAz(A.Body.Sun, d, obs).alt / D2R;
    const dark = sun < -18 ? 1 : sun < -12 ? 0.5 : 0;
    if (!dark || gcAltAz(d, obs).alt / D2R <= 5) continue;
    w += dark * (altAz(A.Body.Moon, d, obs).alt < 0 ? 1 : 1 - 0.85 * fraction);
  }
  const mwHours = w * 10 / 60;
  const dots = mwHours < 0.25 ? 0 : mwHours < 1 ? 1 : mwHours < 2 ? 2 : mwHours < 3.5 ? 3 : mwHours < 5 ? 4 : 5;
  return { fraction, waxing, mwHours, dots };
}
