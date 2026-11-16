// main.js -- state, wiring, URL overrides. Later phases import the plain functions below.
import { observer, sunMoon, path, Body, milkyWay, milkyWayAt } from './astro.js?v=1115.1805-901b992';
import { makeHorizon, terrainEvents } from './horizon.js?v=1115.1805-901b992';
import { DEMO, demoTerrain } from './demo.js?v=1115.1805-901b992';
import { draw } from './draw.js?v=1115.1805-901b992';
import { clampView, attachGestures } from './view.js?v=1115.1805-901b992';

const R2D = 180 / Math.PI;

export const S = {
  date: new Date(),
  view: { azDeg: 90, altDeg: 10, hfovDeg: 60 },
  show: { sun: true, moon: true, milkyWay: true, paths: true, ridges: true, scales: true },
  place: null, obs: null, horizon: null,
  mw: milkyWay(), mwNow: null, sm: null,
  paths: null, events: null, dayKey: null, placeSeq: 0,
  cam: null, ui: { top: 56 },
};

const $ = id => document.getElementById(id);
const canvas = $('cv'), ctx = canvas.getContext('2d');
let raf = 0;

/** Coalesce redraws: one animation frame per burst of changes, never a loop. */
export function requestDraw() {
  if (raf || !S.horizon || !S.sm) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw(ctx, S, canvas.width, canvas.height, window.devicePixelRatio || 1);
  });
}

const dayStartOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());   // local midnight

const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

function updateStatus() {
  if (!S.place) return;
  $('statName').textContent = S.place.name;
  $('statTime').textContent = fmt.format(S.date);
}

/** Day paths and terrain events: only when the local day or the place changes. */
function refreshDay() {
  const start = dayStartOf(S.date), key = `${S.placeSeq}|${start.getTime()}`;
  if (key === S.dayKey) return;
  S.dayKey = key;
  S.dayStart = start;
  S.paths = { sun: path(Body.Sun, S.obs, start), moon: path(Body.Moon, S.obs, start) };
  const pos = body => d => { const m = sunMoon(d, S.obs)[body]; return { az: m.az, alt: m.alt }; };
  S.events = { sun: terrainEvents(S.horizon, pos('sun'), start), moon: terrainEvents(S.horizon, pos('moon'), start) };
}

/** Move to a time. Positions and the Milky Way are recomputed every call. */
export function setTime(date) {
  S.date = date instanceof Date ? date : new Date(date);
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

/** Choose a place: builds the horizon and the observer, then refreshes everything. */
export function setPlace({ name, lat, lon, terrain, eyeM = 1.7, maxDist = 60000 }) {
  const ground = terrain.elev(lon, lat);
  S.place = { name, lat, lon, eyeM, maxDist };
  S.obs = observer(lat, lon, Number.isFinite(ground) ? ground : 0);
  S.horizon = makeHorizon(terrain, lat, lon, eyeM, maxDist);
  S.placeSeq++;
  setTime(S.date);
}

/** Center the view on the moon (double tap). */
export function lookAtMoon() {
  if (S.sm) setView({ azDeg: S.sm.moon.az * R2D, altDeg: S.sm.moon.alt * R2D });
}

// canvas size in device pixels
function resize() {
  const k = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * k); canvas.height = Math.round(innerHeight * k);
  S.ui.top = $('status').getBoundingClientRect().bottom + 6;
  requestDraw();
}
addEventListener('resize', resize);

// dock
const layer = { sun: 'sun', moon: 'moon', mw: 'milkyWay' };
for (const b of document.querySelectorAll('#bar .tog')) {
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on);
    const k = layer[b.dataset.k];
    if (k) { S.show[k] = on; requestDraw(); }
  });
}

attachGestures($('stage'), S.view, { onChange: requestDraw, onDoubleTap: lookAtMoon });

// start up
const q = new URLSearchParams(location.search);
const num = k => (q.has(k) && q.get(k) !== '' && Number.isFinite(+q.get(k)) ? +q.get(k) : null);
const isDemo = q.has('demo');
for (const k of (q.get('off') || '').split(',')) if (k in S.show) S.show[k] = false;   // testing: ?off=ridges,scales
resize();
setPlace({ ...DEMO, terrain: demoTerrain() });     // phase 6 replaces this with saved places
const tq = q.has('t') ? new Date(q.get('t')) : null;
setTime(tq && !Number.isNaN(tq.getTime()) ? tq : isDemo ? new Date('2026-11-25T00:30:00Z') : new Date());
if (isDemo) lookAtMoon(); else setView({ azDeg: 180, altDeg: 15 });
setView({ azDeg: num('az'), altDeg: num('alt'), hfovDeg: num('fov') ?? (isDemo ? 40 : 60) });

window.moonshot = { S, setTime, setView, setPlace, requestDraw };
