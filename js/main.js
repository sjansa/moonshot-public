// main.js -- state, wiring, readouts, URL state, startup. The menu (menu.js) gets the functions it needs through initMenu().
import { observer, sunMoon, altAz, path, Body, milkyWay, milkyWayAt } from './astro.js?v=1115.1836-90d6dbb';
import * as TZ from './tz.js?v=1115.1836-90d6dbb';
import { Ruler } from './ruler.js?v=1115.1836-90d6dbb';
import { makeHorizon, terrainEvents, hidden } from './horizon.js?v=1115.1836-90d6dbb';
import { DEMO, demoTerrain } from './demo.js?v=1115.1836-90d6dbb';
import { draw } from './draw.js?v=1115.1836-90d6dbb';
import { clampView, attachGestures } from './view.js?v=1115.1836-90d6dbb';
import { SENSORS } from './optics.js?v=1115.1836-90d6dbb';
import { listPlaces, openPlace, getLastPlaceId, setLastPlaceId } from './places.js?v=1115.1836-90d6dbb';
import { initMenu } from './menu.js?v=1115.1836-90d6dbb';

const R2D = 180 / Math.PI;

export const S = {
  date: new Date(),
  view: { azDeg: 90, altDeg: 10, hfovDeg: 60 },
  show: { sun: true, moon: true, milkyWay: true, paths: true, ridges: true, scales: true, thirds: false },
  camera: { on: false, sensor: 'ff', focal: 50, exact: 50, portrait: false },
  place: null, terrain: null, obs: null, horizon: null,
  mw: milkyWay(), mwNow: null, sm: null,
  paths: null, events: null, dayKey: null, placeSeq: 0,
  cam: null, ui: { top: 56, bottom: 600 }, tz: 'device',
};

const $ = id => document.getElementById(id);
const canvas = $('cv'), ctx = canvas.getContext('2d');
let raf = 0;

/** Coalesce redraws: one animation frame per burst of changes, never a loop. */
export function requestDraw() {
  scheduleHash();
  if (raf || !S.horizon || !S.sm) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw(ctx, S, canvas.width, canvas.height, window.devicePixelRatio || 1);
  });
}

const dayStartOf = d => TZ.dayStart(d);   // start of the local day in the chosen zone

function updateStatus() {
  if (!S.place) return;
  $('statName').textContent = S.place.name;
  $('statTime').textContent = TZ.formatFull(S.date);
  updateLines();
}

// ---- readouts: one line per object that is switched on ----
const deg1 = r => `${(((r * R2D) % 360 + 360) % 360).toFixed(1)}\u00b0`;
const altS = r => `${(r * R2D).toFixed(1)}\u00b0`;
const sameDay = (a, b) => TZ.dayStart(a).getTime() === TZ.dayStart(b).getTime();
const when = d => (sameDay(d, S.date) ? TZ.format(d, 'time') : `${TZ.format(d, 'date')} ${TZ.format(d, 'time')}`);

/** "behind terrain, clears 17:21" / "visible, drops behind terrain 19:02" for a body that is switched on. */
function terrainNote(name, az, alt) {
  const h = S.horizon, now = S.date.getTime(), hid = hidden(h, az, alt);
  const today = S.events?.[name] || [];
  if (hid) {
    let next = today.find(e => e.kind === 'clears' && e.date.getTime() > now);
    if (!next) { const t2 = TZ.dayStart(new Date(S.dayStart.getTime() + 30 * 3600e3)); next = eventsFor(name, t2).find(e => e.kind === 'clears'); }
    return `${alt < 0 ? 'below horizon' : 'behind terrain'}${next ? `, clears ${when(next.date)}` : ''}`;
  }
  const drop = today.find(e => e.kind === 'drops' && e.date.getTime() > now);
  return drop ? `visible, drops behind terrain ${TZ.format(drop.date, 'time')}` : 'visible';
}

function updateLines() {
  const box = $('lines');
  if (!S.sm || !S.horizon) return;
  const rows = [];
  const add = (color, name, text) => rows.push(`<div class="ln"><i style="background:${color}"></i><b>${name}</b>${text}</div>`);
  const { sun, moon } = S.sm;
  if (S.show.moon) add('#e6edff', 'Moon', `az ${deg1(moon.az)}  alt ${altS(moon.alt)}  ${Math.round(moon.fraction * 100)}%  ${terrainNote('moon', moon.az, moon.alt)}`);
  if (S.show.sun) add('#ffd76a', 'Sun', `az ${deg1(sun.az)}  alt ${altS(sun.alt)}  ${terrainNote('sun', sun.az, sun.alt)}`);
  const c = S.mwNow?.core;
  if (S.show.milkyWay && c) {
    const az = Math.atan2(c[0], c[1]), alt = Math.asin(Math.max(-1, Math.min(1, c[2])));
    const sky = sun.alt * R2D > -6 ? 'sky too bright' : sun.alt * R2D > -18 ? 'twilight' : '';
    add('#aab8ff', 'Milky Way core', `az ${deg1(az)}  alt ${altS(alt)}  ${hidden(S.horizon, az, alt) ? (alt < 0 ? 'below horizon' : 'behind terrain') : 'visible'}${sky ? ', ' + sky : ''}`);
  }
  box.hidden = !rows.length;
  box.innerHTML = rows.join('');
  const top = $('top').getBoundingClientRect().bottom + 6;
  if (Math.abs(top - S.ui.top) > 1) { S.ui.top = top; }
}

// Terrain events (moon / sun clearing or dropping behind terrain), cached per body, place and local day.
const evCache = new Map();
const posFn = (body, obs) => d => altAz(body, d, obs);
function eventsFor(name, start, coarse) {
  const key = `${S.placeSeq}|${name}|${start.getTime()}|${coarse ? 1 : 0}`;
  let ev = evCache.get(key);
  if (!ev) {
    const next = TZ.dayStart(new Date(start.getTime() + 30 * 3600e3));
    ev = terrainEvents(S.horizon, posFn(name === 'sun' ? Body.Sun : Body.Moon, S.obs), start,
      { hours: (next - start) / 3600e3, stepMs: coarse ? 600000 : 120000 });
    if (evCache.size > 400) evCache.clear();
    evCache.set(key, ev);
  }
  return ev;
}

/** Day paths and terrain events: only when the local day or the place changes. */
function refreshDay() {
  const start = dayStartOf(S.date), key = `${S.placeSeq}|${S.tz}|${start.getTime()}`;
  if (key === S.dayKey) return;
  S.dayKey = key;
  S.dayStart = start;
  S.paths = { sun: path(Body.Sun, S.obs, start), moon: path(Body.Moon, S.obs, start) };
  S.events = { sun: eventsFor('sun', start), moon: eventsFor('moon', start) };
}

/** Ruler marks: terrain rise/set of the moon and sun for every local day in [from, to]. */
function rulerMarks(from, to) {
  if (!S.horizon) return [];
  const long = to - from > 40 * 86400e3;           // the 30 day span: moon only, coarse steps
  const out = [];
  for (const [name, label, color] of [['moon', 'Moon', '#e6edff'], ['sun', 'Sun', '#ffd76a']]) {
    if (!S.show[name] || (long && name !== 'moon')) continue;
    for (let d = dayStartOf(from); d < to; d = dayStartOf(new Date(d.getTime() + 30 * 3600e3))) {
      for (const e of eventsFor(name, d, long)) out.push({ date: e.date, color, label: `${label} ${e.kind === 'clears' ? '↑' : '↓'}` });
    }
  }
  return out;
}

/** Move to a time. Positions and the Milky Way are recomputed every call. */
export function setTime(date) {
  S.date = date instanceof Date ? date : new Date(date);
  if (ruler && ruler.time.getTime() !== Math.round(S.date.getTime() / 60000) * 60000) ruler.setTime(S.date);
  if (!S.obs) return;
  S.sm = sunMoon(S.date, S.obs);
  S.mwNow = milkyWayAt(S.mw, S.date, S.obs);
  refreshDay();
  updateStatus();
  requestDraw();
}

/** Where the screen looks. Any field may be left out. */
export function setView({ azDeg, altDeg, hfovDeg } = {}) {
  const v = S.view;
  if (azDeg != null) v.azDeg = azDeg;
  if (altDeg != null) v.altDeg = altDeg;
  if (hfovDeg != null) v.hfovDeg = hfovDeg;
  clampView(v);
  requestDraw();
}

/**
 * Choose a place: builds the horizon and the observer, then refreshes everything.
 * id / reach are set for saved places (and kept in the link); the demo has neither.
 */
export function setPlace({ name, lat, lon, terrain, eyeM = 1.7, maxDist = 60000, id = null, reach = null }) {
  const ground = terrain.elev(lon, lat);
  S.place = { id, name, lat, lon, eyeM, maxDist, reach: reach || (maxDist > 60000 ? 'far' : 'normal') };
  S.terrain = terrain;
  S.obs = observer(lat, lon, Number.isFinite(ground) ? ground : 0);
  S.horizon = makeHorizon(terrain, lat, lon, eyeM, maxDist);
  S.placeSeq++;
  ruler?.invalidate();
  setTime(S.date);
  changed();
}

/** Show a place from storage ({place, terrain} as openPlace / createPlace return it) and remember it. */
export function usePlace({ place, terrain }) {
  setPlace({ name: place.name, lat: place.lat, lon: place.lon, terrain, eyeM: place.eyeM ?? 1.7, maxDist: place.reach === 'far' ? 120000 : 60000, id: place.id, reach: place.reach });
  if (place.saved !== false) setLastPlaceId(place.id).catch(() => {});
}

/** The built-in demo ridge. */
export function useDemo() { setPlace({ ...DEMO, terrain: demoTerrain() }); }

/** Change eye height: rebuilds the horizon only. */
export function setEye(m) {
  if (!S.place || !S.terrain || !(m >= 0 && m <= 3000)) return;
  setPlace({ ...S.place, terrain: S.terrain, eyeM: m });
}

/** Center the view on the moon (double tap). */
export function lookAtMoon() {
  if (S.sm) setView({ azDeg: S.sm.moon.az * R2D, altDeg: S.sm.moon.alt * R2D });
}

// the time ruler
let ruler = null;
ruler = new Ruler($('ruler'), {
  time: S.date, onChange: d => setTime(d),
  sunAltDeg: d => (S.obs ? altAz(Body.Sun, d, S.obs).alt * R2D : -90),
  marks: rulerMarks, format: TZ.format, dateInputValue: TZ.dateInputValue, dateFromInput: TZ.dateFromInput,
});

/** Choose the time zone: 'device', 'UTC' or an IANA name. Returns false if it is not valid. */
export function setTz(z) {
  if (!TZ.setZone(z)) return false;
  S.tz = z; S.dayKey = null;
  if (S.obs) { refreshDay(); updateStatus(); }
  ruler.invalidate(); requestDraw();
  return true;
}

// ---- camera mode (PLAN 9) ----
const changeFns = [];
/** Subscribe to state changes the menu shows (camera settings, time zone, place). */
export const onChange = fn => changeFns.push(fn);
const changed = () => changeFns.forEach(f => f());

/** Change camera settings: {on, sensor, focal (mm), portrait}. Leaving camera mode keeps the center and width. */
export function setCamera(patch = {}) {
  const c = S.camera;
  if (patch.sensor && SENSORS.some(s => s.id === patch.sensor)) c.sensor = patch.sensor;
  if (patch.portrait != null) c.portrait = !!patch.portrait;
  if (patch.focal != null && Number.isFinite(+patch.focal)) { c.exact = Math.min(2000, Math.max(8, +patch.focal)); c.focal = Math.round(c.exact); }
  if (patch.on != null && !!patch.on !== c.on) {
    c.on = !!patch.on;
    if (!c.on) clampView(S.view);        // hfovDeg already holds what the screen showed (draw keeps it in step)
    document.querySelector('#bar [data-k="camera"]')?.setAttribute('aria-pressed', c.on);
  }
  requestDraw(); changed();
}
// pinch / wheel / +- zoom the lens in camera mode, in whole millimeters
const zoomLens = f => { if (!S.camera.on) return false; setCamera({ focal: S.camera.exact * f }); return true; };

// canvas size in device pixels
function resize() {
  const k = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * k); canvas.height = Math.round(innerHeight * k);
  S.ui.top = $('top').getBoundingClientRect().bottom + 6;
  S.ui.bottom = $('ruler').getBoundingClientRect().top - 6;
  requestDraw();
}
addEventListener('resize', resize);

// dock
const layer = { sun: 'sun', moon: 'moon', mw: 'milkyWay' };
for (const b of document.querySelectorAll('#bar .tog:not(#more)')) {
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on);
    const k = layer[b.dataset.k];
    if (k) { S.show[k] = on; ruler.invalidate(); requestDraw(); }
    else if (b.dataset.k === 'camera') setCamera({ on });
  });
}

attachGestures($('stage'), S.view, { onChange: requestDraw, onDoubleTap: lookAtMoon, zoom: zoomLens });

// ---- link state: #lat=..&lon=..&t=..&az=..&alt=..&fov=..&cam=ff,600,l (written at most once a second) ----
let hashTimer = 0, lastHash = -1e9, started = false;
const r1 = x => (Math.round(x * 10) / 10).toString();
export function hashString() {
  const p = [], c = S.camera;
  if (S.place?.id) p.push(`lat=${S.place.lat.toFixed(5)}`, `lon=${S.place.lon.toFixed(5)}`);
  p.push(`t=${S.date.toISOString().replace(/\.\d+Z$/, 'Z')}`, `az=${r1(S.view.azDeg)}`, `alt=${r1(S.view.altDeg)}`);
  if (c.on) p.push(`cam=${c.sensor},${c.focal},${c.portrait ? 'p' : 'l'}`); else p.push(`fov=${r1(S.view.hfovDeg)}`);
  return p.join('&');
}
function scheduleHash() {
  if (hashTimer || !started) return;
  hashTimer = setTimeout(() => {
    hashTimer = 0; lastHash = performance.now();
    try { history.replaceState(null, '', location.pathname + location.search + '#' + hashString()); } catch { /* sandboxed frame */ }
  }, Math.max(0, 1000 - (performance.now() - lastHash)));
}
function parseHash() {
  const o = {};
  for (const kv of location.hash.replace(/^#/, '').split('&')) {
    const [k, v = ''] = kv.split('=');
    if (k) o[k] = decodeURIComponent(v);
  }
  return o;
}
const numOr = v => (v != null && v !== '' && Number.isFinite(+v) ? +v : null);
/** Metres between two nearby points (equirectangular, fine for a 50 m test). */
const metersApart = (a, b) => Math.hypot((a.lat - b.lat) * 110540, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));

// ---- start up ----
const q = new URLSearchParams(location.search);
const num = k => numOr(q.get(k));
const isDemo = q.has('demo');
for (const k of (q.get('off') || '').split(',')) if (k in S.show) S.show[k] = false;   // testing: ?off=ridges,scales
resize();
const menu = initMenu({ S, setPlace, usePlace, useDemo, setEye, setTime, setTz, setCamera, requestDraw, onChange, invalidate: () => { ruler.invalidate(); updateLines(); requestDraw(); } });

async function start() {
  const hash = parseHash();
  let opened = false;
  const want = { lat: numOr(hash.lat), lon: numOr(hash.lon) };
  try {
    if (want.lat != null && want.lon != null) {
      // a link naming coordinates opens the saved place within 50 m; otherwise lat/lon are ignored
      const hit = (await listPlaces()).filter(p => metersApart(p, want) <= 50).sort((a, b) => metersApart(a, want) - metersApart(b, want))[0];
      if (hit) { usePlace(await openPlace(hit.id)); opened = true; }
    }
    if (!opened && !isDemo) {
      const id = await getLastPlaceId();
      if (id) { usePlace(await openPlace(id)); opened = true; }
    }
  } catch (e) { menu.note(e.message); }
  if (!opened) {
    useDemo();
    if (!isDemo) menu.open('place', 'Choose a place to see its real horizon.');
  }
  const tv = hash.t || q.get('t'), td = tv ? new Date(tv) : null;
  setTime(td && !Number.isNaN(td.getTime()) ? td : isDemo ? new Date('2026-11-25T00:30:00Z') : new Date());
  if (isDemo && numOr(hash.az) == null && num('az') == null) lookAtMoon(); else setView({ azDeg: 180, altDeg: 15 });
  const cam = (hash.cam || '').split(',');
  if (cam.length === 3 && SENSORS.some(s => s.id === cam[0])) setCamera({ on: true, sensor: cam[0], focal: +cam[1] || 50, portrait: cam[2] === 'p' });
  setView({
    azDeg: numOr(hash.az) ?? num('az'), altDeg: numOr(hash.alt) ?? num('alt'),
    hfovDeg: numOr(hash.fov) ?? num('fov') ?? (isDemo ? 40 : 60),
  });
  started = true; scheduleHash();
}
start();

window.moonshot = { S, setTime, setView, setPlace, usePlace, useDemo, requestDraw, setTz, setCamera, ruler, rulerMarks, hashString, menu };

// ---- offline shell: not in the native app (Capacitor serves the files itself) ----
if ('serviceWorker' in navigator && !window.Capacitor) {
  addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      // The worker starts after this page has already loaded its files, so on a first visit it has
      // seen none of them. Hand it the list, or one visit would not be enough to work offline.
      const reg = await navigator.serviceWorker.ready;
      const mine = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.startsWith(location.origin));
      const extra = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png', './vendor/leaflet.js', './vendor/leaflet.css']
        .map(u => new URL(u, location.href).href);
      reg.active?.postMessage({ cache: [...new Set([location.href.split(/[?#]/)[0], ...mine, ...extra])] });
    } catch { /* no offline shell; the app still works online */ }
  });
}
