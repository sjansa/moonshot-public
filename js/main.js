// main.js -- state, wiring, readouts, URL state, startup. The menu (menu.js) gets the functions it needs through initMenu().
import { observer, sunMoon, altAz, path, Body, milkyWay, milkyWayAt, nightSky, enu } from './astro.js?v=1122.0212-79fa2c9';
import { loadSkyArt } from './skyart.js?v=1122.0212-79fa2c9';
import * as TZ from './tz.js?v=1122.0212-79fa2c9';
import { Ruler } from './ruler.js?v=1122.0212-79fa2c9';
import { makeHorizon, terrainEvents, hidden } from './horizon.js?v=1122.0212-79fa2c9';
import { DEMO, demoTerrain } from './demo.js?v=1122.0212-79fa2c9';
import { draw } from './draw.js?v=1122.0212-79fa2c9';
import { clampView, attachGestures } from './view.js?v=1122.0212-79fa2c9';
import { SENSORS } from './optics.js?v=1122.0212-79fa2c9';
import { listPlaces, openPlace, getLastPlaceId, setLastPlaceId, loadPeaks } from './places.js?v=1122.0212-79fa2c9';
import { visiblePeaks } from './peaks.js?v=1122.0212-79fa2c9';
import { initMenu } from './menu.js?v=1122.0212-79fa2c9';
import { tick } from './haptic.js?v=1122.0212-79fa2c9';
import { AR } from './ar.js?v=1122.0212-79fa2c9';
import { openCameraLink } from './cameralink.js?v=1122.0212-79fa2c9';
import { initCamCtl } from './camctl.js?v=1122.0212-79fa2c9';
import { whereAmI, createPlace, nameFor } from './places.js?v=1122.0212-79fa2c9';
import { planFrom, aimAt, getPlan } from './plans.js?v=1122.0212-79fa2c9';

const R2D = 180 / Math.PI;

export const S = {
  date: new Date(),
  view: { azDeg: 90, altDeg: 10, hfovDeg: 60 },
  show: { sun: true, moon: true, milkyWay: true, paths: true, ridges: true, peaks: true, scales: true, thirds: false },
  camera: { on: false, sensor: 'ff', focal: 50, exact: 50, portrait: false },
  place: null, terrain: null, obs: null, horizon: null,
  mw: milkyWay(), mwNow: null, sm: null,
  peaks: [], paths: null, events: null, dayKey: null, placeSeq: 0,
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

const dayStartOf = d => TZ.dayStart(d);
const nowMinute = () => new Date(Math.round(Date.now() / 60000) * 60000);   // start of the local day in the chosen zone

function updateStatus() {
  if (!S.place) return;
  $('statName').textContent = S.place.name;
  $('statTime').textContent = TZ.formatFull(S.date);
  updateLines();
}

// ---- the drawer holding the place and sky pills: shown for a moment, then tucked away ----
const DRAWER_FIRST_MS = 4000, DRAWER_TAP_MS = 10000;
let drawerTimer = 0;
function showDrawer(ms) {
  $('drawer').classList.remove('shut'); $('drawerTab').setAttribute('aria-expanded', true);
  clearTimeout(drawerTimer); drawerTimer = setTimeout(hideDrawer, ms);
}
function hideDrawer() {
  clearTimeout(drawerTimer);
  $('drawer').classList.add('shut'); $('drawerTab').setAttribute('aria-expanded', false);
}
$('drawerTab').addEventListener('click', () => ($('drawer').classList.contains('shut') ? showDrawer(DRAWER_TAP_MS) : hideDrawer()));
$('drawer').addEventListener('transitionend', e => { if (e.propertyName === 'max-height') resize(); });

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
  if (ruler && ruler.time.getTime() !== Math.round(S.date.getTime() / 1000) * 1000) ruler.setTime(S.date);
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
export function setPlace({ name, lat, lon, terrain, eyeM = 1.7, maxDist = 60000, id = null, reach = null }, { keep = false } = {}) {
  const ground = terrain.elev(lon, lat);
  S.place = { id, name, lat, lon, eyeM, maxDist, reach: reach || (maxDist > 60000 ? 'far' : 'normal') };
  S.terrain = terrain;
  S.obs = observer(lat, lon, Number.isFinite(ground) ? ground : 0);
  S.horizon = makeHorizon(terrain, lat, lon, eyeM, maxDist);
  S.placeSeq++;
  // keep: the live camera moved to where you stand; it stays on, still aimed at the same subject
  if (ar?.on && !keep) setAR(false);
  const prev = S.subject;
  S.subject = keep && prev?.target ? retarget(prev) : null;
  if (keep && ar?.on) ar.placeChanged();
  S.peaks = [];
  if (id) {
    const seq = S.placeSeq;
    loadPeaks({ id, lat, lon, reach: S.place.reach }).then(list => {
      if (seq !== S.placeSeq) return;
      S.peaks = visiblePeaks(S.horizon, terrain, list, { maxDist }); requestDraw();
    }).catch(() => {});
  }
  ruler?.invalidate();
  setTime(S.date);
  changed();
  showDrawer(DRAWER_FIRST_MS);
}

/** The subject seen from the place in use: the same point on the ground, aimed at anew. */
function retarget(sj) {
  const a = aimAt(S.place.lat, S.place.lon, S.obs.height + S.place.eyeM, sj.target);
  return a ? { ...sj, az: a.az, alt: a.alt, dir: enu(a.az, a.alt) } : null;
}

/**
 * A subject-solver result for the place just shown: go to the alignment moment, aim at the
 * subject, mark it, show the body, and put the ruler on its 2 hour span for exact timing.
 */
export function applyPlan(plan) {
  const az = plan.azDeg * Math.PI / 180, alt = plan.altDeg * Math.PI / 180;
  const tg = plan.subject || plan.target;
  S.subject = { az, alt, dir: enu(az, alt), body: plan.body, kind: plan.kind, target: tg?.lat != null ? { lat: tg.lat, lon: tg.lon, elev: tg.elev, name: tg.name || null } : null };
  S.show[plan.body === 'gc' ? 'milkyWay' : plan.body] = true;
  ruler.setSpan(2 * 3600e3);
  setTime(new Date(Math.round(+plan.time / 1000) * 1000));
  setView({ azDeg: plan.azDeg, altDeg: plan.altDeg, hfovDeg: S.camera.on ? undefined : Math.min(S.view.hfovDeg, 25) });
  changed();
}

/** Show a place from storage ({place, terrain} as openPlace / createPlace return it) and remember it. */
export function usePlace({ place, terrain }, opts) {
  setPlace({ name: place.name, lat: place.lat, lon: place.lon, terrain, eyeM: place.eyeM ?? 1.7, maxDist: place.reach === 'far' ? 120000 : 60000, id: place.id, reach: place.reach }, opts);
  if (place.saved !== false) setLastPlaceId(place.id).catch(() => {});
}

/** A saved plan for what is on screen now (plans.js); name may be left out. */
export const currentPlan = name => (S.place?.id ? planFrom(S, name) : null);

/**
 * Load a saved plan on the place it was made for (already shown by the caller, or a place
 * within 50 m): time, aim, lens, the subject (aimed anew if the place moved) and the layers.
 */
export function loadPlan(plan) {
  if (plan.tz && plan.tz !== 'device' && plan.tz !== S.tz) setTz(plan.tz);
  for (const k of ['sun', 'moon', 'milkyWay']) if (plan.show?.[k] != null) S.show[k] = plan.show[k];
  syncDock();
  const c = plan.camera;
  if (c) setCamera({ sensor: c.sensor, focal: c.focal, portrait: c.portrait, on: c.on });
  const sj = plan.subject;
  S.subject = null;
  if (sj) {
    const az = sj.azDeg * Math.PI / 180, alt = sj.altDeg * Math.PI / 180;
    S.subject = { az, alt, dir: enu(az, alt), body: sj.body, kind: sj.kind, target: sj.target || null };
    if (sj.target && metersApart(S.place, plan.place) > 5) S.subject = retarget(S.subject) || S.subject;
  }
  ruler.setSpan(2 * 3600e3);
  setTime(new Date(plan.time));
  setView({ azDeg: plan.view.azDeg, altDeg: plan.view.altDeg, hfovDeg: c?.on ? undefined : plan.view.hfovDeg });
  ruler.invalidate();
  changed();
}
const syncDock = () => {
  for (const b of document.querySelectorAll('#bar .tog:not(#more)')) {
    const k = layer[b.dataset.k];
    if (k) b.setAttribute('aria-pressed', !!S.show[k]);
  }
};

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
  haptic: tick,
  time: S.date, onChange: d => setTime(d),
  sunAltDeg: d => (S.obs ? altAz(Body.Sun, d, S.obs).alt * R2D : -90),
  sky: d => (S.obs ? { ...nightSky(dayStartOf(d), S.obs), south: S.place?.lat < 0 } : null),
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
const zoomLens = f => { if (!S.camera.on || S.ar) return false; setCamera({ focal: S.camera.exact * f }); return true; };

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

attachGestures($('stage'), S.view, { onChange: requestDraw, onDoubleTap: () => { if (!S.ar) lookAtMoon(); }, zoom: zoomLens });

// ---- AR: phone camera (or a USB camera) + compass, ridges pulled onto the real skyline (ar.js) ----
const arMsg = $('arMsg'), arBtn = $('arBtn'), arCompass = $('arCompass');
const arSay = (text, kind = '') => { arMsg.textContent = text || ''; arMsg.className = `chip ${kind}`; arMsg.hidden = !text; };
const ar = new AR($('arVideo'), S, {
  draw: () => {
    if (S.horizon && S.sm) draw(ctx, S, canvas.width, canvas.height, window.devicePixelRatio || 1);
    arCompass.hidden = !(ar.on && ar.sensorsOff);
  },
  status: (t, k) => { if (!camLink?.drive) arSay(t, k); },     // a running drive owns the message line
}, $('arFrame'));
let arPrev = null, camLink = null, camCtl = null;
const fnFromMenu = () => S.camera.exact / (SENSORS.find(s => s.id === S.camera.sensor) || SENSORS[0]).w;   // focal / sensor width
/** AR on or off. source: 'phone' or 'camera' (the USB camera, when one is attached). */
export async function setAR(on, source = 'phone') {
  const want = on ? source : null, have = ar.on ? (ar.ext ? 'camera' : 'phone') : null;
  if (want === have) return;
  if (ar.on) {
    ar.stop(); arBtn.setAttribute('aria-pressed', false); arSay(''); camCtl?.show(false); camLink?.setLive(false);
    if (arPrev && !want) setView({ altDeg: Math.max(-5, Math.min(30, S.view.altDeg)), hfovDeg: arPrev.hfovDeg });
  }
  if (!want) return;
  arPrev = { ...S.view };
  arBtn.setAttribute('aria-pressed', true);
  try {
    if (want === 'camera') { await camLink.setLive(true); await ar.start({ link: camLink, fnGuess: fnFromMenu() }); camCtl.show(true); }
    else await ar.start();
    setTime(nowMinute());
    followHere();
  } catch (e) { ar.stop(); arBtn.setAttribute('aria-pressed', false); arSay(''); camCtl?.show(false); menu.note(e.message); menu.open('place'); }
}

// ---- live camera: draw from where you stand ----
// On entry the phone's position is asked for. Within HERE_M of the place in use nothing changes;
// else a saved place that close is opened, or one is downloaded for the spot. The subject, time
// and aim are kept (the subject re-aimed from the new spot).
const HERE_M = 50, POOR_FIX_M = 150;
let hereSeq = 0;
async function followHere() {
  const seq = ++hereSeq, live = () => ar.on && seq === hereSeq;
  let p;
  try { p = await whereAmI(); } catch (e) {
    if (live()) arSay(S.place?.id ? `${e.message} The ridges are drawn from ${S.place.name}.` : e.message, 'bad');
    return;
  }
  if (!live()) return;
  if (S.place?.id && metersApart(p, S.place) <= Math.max(HERE_M, Math.min(p.acc, POOR_FIX_M))) return;
  if (p.acc > POOR_FIX_M) { arSay(`Your position is only known to ${Math.round(p.acc)} m, so the ridges stay drawn from ${S.place?.name || 'the chosen place'}.`, 'bad'); return; }
  const view = { ...S.view }, date = S.date;
  const hit = (await listPlaces().catch(() => [])).map(x => ({ x, d: metersApart(p, x) })).filter(o => o.d <= HERE_M).sort((a, b) => a.d - b.d)[0];
  try {
    let r;
    if (hit) r = await openPlace(hit.x.id);
    else {
      arSay('Downloading the terrain where you stand…');
      const name = await Promise.race([nameFor(p.lat, p.lon).then(n => n?.name).catch(() => null), new Promise(res => setTimeout(res, 3000, null))]);
      r = await createPlace({ name: name || `Here ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, lat: p.lat, lon: p.lon, eyeM: S.place?.eyeM ?? 1.7, reach: S.place?.reach || 'normal' },
        (f, m) => { if (live()) arSay(`${m} ${Math.round(100 * f)}%`); });
    }
    if (!live()) return;
    usePlace(r, { keep: true });
    setTime(date); setView(view);
    arSay(`Drawing from where you stand: ${r.place.name}.`);
    setTimeout(() => { if (seq === hereSeq) arSay(''); }, 4000);
  } catch (e) {
    if (live()) arSay(S.place?.id ? `Could not get the terrain where you stand (${e.message}). The ridges are drawn from ${S.place.name}.` : e.message, 'bad');
  }
}
// the compass button: the USB camera's view when one is attached, else the phone camera
arBtn.addEventListener('click', () => setAR(!ar.on, camLink?.state.attached && camLink.state.supported ? 'camera' : 'phone'));
arCompass.addEventListener('click', () => ar.enableSensors().catch(e => arSay(e.message, 'bad')));

// A camera on the USB port (native app): switch to its view when it is plugged in, back when it is unplugged.
openCameraLink().then(async link => {
  if (!link) return;
  camLink = link;
  camCtl = initCamCtl(link, { say: arSay, haptic: tick });
  link.on('status', d => { if (d.text && (!ar.on || d.kind === 'bad')) arSay(d.text, d.kind || ''); });
  link.on('attached', d => {
    if (!d.supported) return;
    if (/ILCE-6|ZV-E10|NEX|ILCE-6\d00|a6\d00/i.test(d.name || '') && S.camera.sensor === 'ff') setCamera({ sensor: 'apsc' });
    setAR(true, 'camera');
  });
  link.on('detached', () => { if (ar.ext) { setAR(false); arSay('Camera unplugged.'); setTimeout(() => arSay(''), 3000); } });
  await link.start();
}).catch(e => console.error('camera link', e));

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
const menu = initMenu({ S, setPlace, usePlace, applyPlan, loadPlan, currentPlan, useDemo, setEye, setTime, setView, setTz, setCamera, requestDraw, onChange, invalidate: () => { ruler.invalidate(); updateLines(); requestDraw(); } });

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
    if (!isDemo) menu.open('place', 'Choose a location to see its real horizon.');
  }
  const tv = hash.t || q.get('t'), td = tv ? new Date(tv) : null;
  setTime(td && !Number.isNaN(td.getTime()) ? td : isDemo ? new Date('2026-11-25T00:30:00Z') : nowMinute());
  if (isDemo && numOr(hash.az) == null && num('az') == null) lookAtMoon(); else setView({ azDeg: 180, altDeg: 15 });
  const cam = (hash.cam || '').split(',');
  if (cam.length === 3 && SENSORS.some(s => s.id === cam[0])) setCamera({ on: true, sensor: cam[0], focal: +cam[1] || 50, portrait: cam[2] === 'p' });
  setView({
    azDeg: numOr(hash.az) ?? num('az'), altDeg: numOr(hash.alt) ?? num('alt'),
    hfovDeg: numOr(hash.fov) ?? num('fov') ?? (isDemo ? 40 : 60),
  });
  started = true; scheduleHash();
  if (hash.plan) {                              // a calendar link: the saved plan, if it is on this device
    const p = await getPlan(hash.plan).catch(() => null);
    if (p) menu.openPlan(p);
  }
}
start();

loadSkyArt(requestDraw);
window.moonshot = { S, setAR, get camLink() { return camLink; }, ar: () => ar, setTime, setView, setPlace, usePlace, applyPlan, useDemo, requestDraw, setTz, setCamera, ruler, rulerMarks, hashString, menu };

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
