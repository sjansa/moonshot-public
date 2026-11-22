// plans.js -- saved shot plans: where to stand, what to aim at, when, and with what lens, kept on
// the device beside the places so a shot worked out at home can be loaded on site. No DOM.
import { kvGet, kvPut } from './places.js?v=1122.0212-79fa2c9';
import { R_EFF, R_EARTH, D2R } from '../core/terrain.js?v=1122.0212-79fa2c9';

const KEY = 'plans', M_DEG = R_EARTH * D2R;

/**
 * A plan from the app state. S: main.js state; tz: the zone in use ('device', 'UTC' or IANA).
 * {id, name, created, place: {id, name, lat, lon, eyeM, reach}, time (ISO), tz,
 *  view: {azDeg, altDeg, hfovDeg}, camera: {on, sensor, focal, portrait},
 *  subject: {azDeg, altDeg, body, kind, target: {lat, lon, elev, name} | null} | null, show: {sun, moon, milkyWay}}
 */
export function planFrom(S, name) {
  const p = S.place, sj = S.subject, c = S.camera;
  return {
    id: 's-' + Date.now().toString(36),
    name: name || defaultName(S),
    created: new Date().toISOString(),
    place: { id: p.id, name: p.name, lat: p.lat, lon: p.lon, eyeM: p.eyeM, reach: p.reach },
    time: S.date.toISOString(), tz: S.tz || 'device',
    view: { ...S.view },
    camera: { on: c.on, sensor: c.sensor, focal: c.exact, portrait: c.portrait },
    subject: sj ? { azDeg: sj.az / D2R, altDeg: sj.alt / D2R, body: sj.body, kind: sj.kind, target: sj.target || null } : null,
    show: { sun: S.show.sun, moon: S.show.moon, milkyWay: S.show.milkyWay },
  };
}

const EV = { moon: ['Moonrise', 'Moonset'], sun: ['Sunrise', 'Sunset'], gc: ['Milky Way rise', 'Milky Way set'] };
/** "Moonrise over Lone Rock · Tooele County", or the place name. */
export function defaultName(S) {
  const sj = S.subject, ev = sj && EV[sj.body]?.[sj.kind === 'rise' ? 0 : 1];
  if (!ev) return S.place?.name || 'Plan';
  return [sj.target?.name ? `${ev} over ${sj.target.name}` : ev, S.place?.name].filter(Boolean).join(' · ');
}

/** Saved plans, soonest first (those already past at the end, latest first). */
export async function listPlans(now = Date.now()) {
  const list = (await kvGet(KEY)) || [];
  const t = p => Date.parse(p.time);
  return list.slice().sort((a, b) => {
    const pa = t(a) < now, pb = t(b) < now;
    return pa !== pb ? (pa ? 1 : -1) : pa ? t(b) - t(a) : t(a) - t(b);
  });
}
export async function savePlan(plan) {
  const list = ((await kvGet(KEY)) || []).filter(p => p.id !== plan.id);
  list.push(plan);
  if (!await kvPut(KEY, list)) throw new Error('Could not save the plan: storage is blocked or full.');
  return plan;
}
export async function renamePlan(id, name) {
  const list = (await kvGet(KEY)) || [], p = list.find(x => x.id === id);
  if (!p) return;
  p.name = String(name);
  if (!await kvPut(KEY, list)) throw new Error('Could not save the change: storage is blocked or full.');
}
export async function removePlan(id) {
  await kvPut(KEY, ((await kvGet(KEY)) || []).filter(p => p.id !== id));
}
export async function getPlan(id) {
  return ((await kvGet(KEY)) || []).find(p => p.id === id) || null;
}

/**
 * Aim at a subject point from where you stand: {az, alt} in radians (alt includes the earth's
 * curve and refraction, as the solver does), or null when the subject is under your feet.
 * h0: eye height above sea level (m); target: {lat, lon, elev}.
 */
export function aimAt(lat, lon, h0, target) {
  const kx = Math.cos((lat + target.lat) / 2 * D2R) * M_DEG;
  const e = (target.lon - lon) * kx, n = (target.lat - lat) * M_DEG, d = Math.hypot(e, n);
  if (!(d > 1)) return null;
  return { az: (Math.atan2(e, n) + 2 * Math.PI) % (2 * Math.PI), alt: Math.atan((target.elev - h0) / d - d / (2 * R_EFF)), distM: d };
}
