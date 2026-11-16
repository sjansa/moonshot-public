// mappick.js -- full-screen map sheet to choose a spot.
//
// pickSpot() resolves to {lat, lon, name} or null (canceled). In solver mode with a
// subject and a valid alignment it is {lat, lon, name, plan: {time, azDeg, altDeg, body, kind, subject}}.
// A native picker can replace Leaflet: if the Capacitor 'SpotPicker' plugin exists it is used
// (not in solver mode).

import { whereAmI } from './places.js?v=1116.1309-f833c0b';
import * as astro from './astro.js?v=1116.1309-f833c0b';
import * as TZ from './tz.js?v=1116.1309-f833c0b';
import { tick } from './haptic.js?v=1116.1309-f833c0b';
import { makeSkyGlyph } from './skyglyph.js?v=1116.1309-f833c0b';
import { fetchElevGrid } from './elev.js?v=1116.1309-f833c0b';
import { bodyTrack, solveGrid, solveSpot, elevAt, lonLatToPx, pxToLonLat } from './solver.js?v=1116.1309-f833c0b';

const LINE_KM = 20;
let leafletReady = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletReady) return leafletReady;
  const url = p => new URL(p, document.baseURI).href;      // relative to the page, not to this module
  leafletReady = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = url('./vendor/leaflet.css');
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = url('./vendor/leaflet.js');
    js.onload = () => (window.L ? resolve() : reject(new Error('The map library did not start.')));
    js.onerror = () => reject(new Error('The map library could not be loaded.'));
    document.head.appendChild(js);
  }).catch(e => { leafletReady = null; throw e; });
  return leafletReady;
}

const CSS = `
.mp-root{position:fixed;inset:0;z-index:2000;display:flex;flex-direction:column;background:#0c1a22;color:#e6eef2;font:15px/1.3 Barlow,system-ui,-apple-system,sans-serif}
.mp-root *{box-sizing:border-box}
.mp-bar{display:flex;gap:8px;padding:calc(env(safe-area-inset-top) + 8px) calc(env(safe-area-inset-right) + 10px) 8px calc(env(safe-area-inset-left) + 10px);background:rgba(12,26,34,.96);border-bottom:1px solid #26404f}
.mp-bar input{flex:1;min-width:0;height:44px;padding:0 12px;border-radius:10px;border:1px solid #33505f;background:#14273a;color:inherit;font:inherit}
.mp-btn{min-height:44px;min-width:44px;padding:0 14px;border-radius:10px;border:1px solid #33505f;background:#1b3447;color:inherit;font:inherit;cursor:pointer}
.mp-btn:disabled{opacity:.4;cursor:default}
.mp-btn.mp-go{background:#e8c66a;border-color:#e8c66a;color:#1a1405;font-weight:600}
.mp-map{flex:1;min-height:0;background:#0c1a22}
.mp-foot{padding:8px calc(env(safe-area-inset-right) + 10px) calc(env(safe-area-inset-bottom) + 8px) calc(env(safe-area-inset-left) + 10px);background:rgba(12,26,34,.96);border-top:1px solid #26404f}
.mp-msg{min-height:20px;font-size:13px;color:#f0b0a0;margin-bottom:4px}
.mp-msg.mp-ok{color:#9fb6c3}
.mp-row{display:flex;gap:8px;align-items:center}
.mp-pos{flex:1;font-variant-numeric:tabular-nums;font-size:13px;color:#9fb6c3;min-width:0;margin-bottom:6px}
.mp-root .leaflet-control-attribution{background:rgba(12,26,34,.8);color:#9fb6c3}
.mp-root .leaflet-control-attribution a{color:#e8c66a}
.mp-modes{display:flex;gap:6px;padding:6px calc(env(safe-area-inset-right) + 10px) 6px calc(env(safe-area-inset-left) + 10px);background:rgba(12,26,34,.96)}
.mp-chip{min-height:40px;padding:0 11px;border-radius:20px;border:1px solid #33505f;background:#14273a;color:inherit;font:inherit;font-size:14px;cursor:pointer}
.mp-chip[aria-pressed=true]{background:#e8c66a;border-color:#e8c66a;color:#1a1405;font-weight:600}
.mp-modes .mp-chip{flex:1}
.mp-panel{display:flex;flex-direction:column;gap:4px;margin-bottom:6px}
.mp-panel .mp-row{flex-wrap:wrap;gap:6px}
.mp-panel .mp-sep{width:1px;height:20px;background:#33505f}
.mp-small{font-size:13px;color:#9fb6c3}
.mp-num{width:64px;height:40px;padding:0 6px;border-radius:10px;border:1px solid #33505f;background:#14273a;color:inherit;font:inherit}
.mp-day{flex:1;min-width:80px;height:40px;accent-color:#e8c66a}
.mp-dl{min-width:96px;font-size:12px;line-height:1.2;text-align:right;color:#e6eef2}
.mp-sq{min-width:40px;padding:0}
.mp-tri{width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-bottom:22px solid #e5483a;filter:drop-shadow(0 0 2px #fff)}
.mp-shade{image-rendering:auto}
.mp-root .leaflet-control-layers-toggle{background-image:none!important;width:44px;height:44px;display:grid;place-items:center;color:#14273a;font:600 13px/1 Barlow,system-ui,sans-serif;text-decoration:none}
.mp-root .leaflet-control-layers-toggle::after{content:'Map'}
.mp-root .leaflet-control-layers-expanded{padding:8px 12px;font:15px/2.2 Barlow,system-ui,sans-serif;color:#14273a}
.mp-lbl{background:rgba(12,26,34,.85);border:1px solid #33505f;color:#e6eef2}
`;

function addStyles() {
  if (document.getElementById('mp-style')) return;
  const s = document.createElement('style');
  s.id = 'mp-style'; s.textContent = CSS;
  document.head.appendChild(s);
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fixed = (lat, lon) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
const BODY_NAME = { moon: 'Moon', sun: 'Sun', gc: 'Galactic centre' };
const EVENT = { moon: ['moonrise', 'moonset'], sun: ['sunrise', 'sunset'], gc: ['galactic centre rise', 'galactic centre set'] };
const R2D = 180 / Math.PI, DAY_MS = 86400000;

async function pickNative(opts) {
  const r = await window.Capacitor.nativePromise('SpotPicker', 'pick', { lat: opts.lat, lon: opts.lon });
  if (!r || r.cancelled || r.canceled || !Number.isFinite(+r.lat) || !Number.isFinite(+r.lon)) return null;
  return { lat: +r.lat, lon: +r.lon, name: r.name || null };
}

/**
 * opts: {lat, lon, zoom} to start from; lines: [{azDeg, color, label}] drawn
 * from the marker as 20 km azimuth lines; mode: 'spot' (default) | 'solver'; date: Date for the solver's day slider.
 * Resolves to {lat, lon, name[, plan]} or null.
 */
export async function pickSpot(opts = {}) {
  if (opts.mode !== 'solver' && window.Capacitor?.PluginHeaders?.some(h => h.name === 'SpotPicker')) return pickNative(opts);

  addStyles();
  const root = el('div', 'mp-root');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Choose a spot');
  const bar = el('div', 'mp-bar'), input = el('input'), find = el('button', 'mp-btn', 'Search');
  input.type = 'search'; input.placeholder = 'Search for a place'; input.setAttribute('aria-label', 'Search for a place');
  input.enterKeyHint = 'search'; input.autocomplete = 'off';
  bar.append(input, find);
  const mapEl = el('div', 'mp-map');
  const foot = el('div', 'mp-foot'), msg = el('div', 'mp-msg', 'Loading the map…'), pos = el('div', 'mp-pos', 'Tap the map to place the spot.');
  const here = el('button', 'mp-btn', 'Where I am'), cancel = el('button', 'mp-btn', 'Cancel'), use = el('button', 'mp-btn mp-go', 'Use this spot');
  use.disabled = true;
  const row1 = el('div', 'mp-row'), row2 = el('div', 'mp-row');
  row1.style.marginBottom = '8px';
  row2.append(cancel, here, el('div'), use);
  row2.children[2].style.flex = '1';
  // solver panel
  const chip = (t, on) => { const b = el('button', 'mp-chip', t); b.setAttribute('aria-pressed', on ? 'true' : 'false'); return b; };
  const group = (parent, labels, get, set) => {
    const bs = labels.map(([k, t]) => { const b = chip(t, k === get()); b.dataset.k = k; b.onclick = () => { set(k); mark(); }; return b; });
    const mark = () => bs.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === get())));
    parent.append(...bs);
    return mark;
  };
  const panel = el('div', 'mp-panel'), pr1 = el('div', 'mp-row'), pr2 = el('div', 'mp-row'), pr3 = el('div', 'mp-row');
  const modes = el('div', 'mp-modes'), modeSpot = chip('Spot', true), modeSolver = chip('Solver', false);
  modes.append(modeSpot, modeSolver);
  const hInput = el('input', 'mp-num');
  hInput.type = 'number'; hInput.min = '0'; hInput.max = '1000'; hInput.step = '1'; hInput.value = '0'; hInput.inputMode = 'numeric';
  hInput.setAttribute('aria-label', 'Subject height above ground (m)'); hInput.title = 'Subject height above ground (m)';
  const prev = el('button', 'mp-btn mp-sq', '‹'), next = el('button', 'mp-btn mp-sq', '›'), day = el('input', 'mp-day'), dl = el('div', 'mp-dl');
  prev.setAttribute('aria-label', 'Previous day'); next.setAttribute('aria-label', 'Next day');
  day.type = 'range'; day.min = '0'; day.max = '365'; day.step = '1'; day.value = '0'; day.setAttribute('aria-label', 'Day');
  const gl = makeSkyGlyph({ size: 24 }), dt = el('span', '');
  dl.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:4px'; dl.append(gl.el, dt);
  pr3.append(prev, day, next, dl);
  panel.append(pr1, pr2, pr3);
  foot.append(msg, panel, pos, row2);
  root.append(bar, modes, mapEl, foot);
  document.body.appendChild(root);

  const say = (t, ok) => { msg.textContent = t || ''; msg.className = 'mp-msg' + (ok ? ' mp-ok' : ''); };

  try { await loadLeaflet(); } catch (e) {
    say(e.message + ' Check the connection, or close this and try again.');
    return new Promise(res => { cancel.onclick = () => { root.remove(); res(null); }; use.disabled = true; find.disabled = true; here.disabled = true; });
  }
  const L = window.L;
  const hasStart = Number.isFinite(opts.lat) && Number.isFinite(opts.lon);
  const map = L.map(mapEl, { zoomControl: true, attributionControl: true })
    .setView(hasStart ? [opts.lat, opts.lon] : [30, 0], opts.zoom ?? (hasStart ? 12 : 2));
  // map types; the choice is remembered on this device. Topographic (contours and hill shading) is the default.
  const osm = '&copy; OpenStreetMap contributors';
  const bases = {
    Topographic: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 17, subdomains: 'abc', attribution: `${osm}, SRTM | &copy; OpenTopoMap (CC-BY-SA)` }),
    Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
    Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osm }),
  };
  let baseName = 'Topographic';
  try { const v = localStorage.getItem('moonshot-map'); if (bases[v]) baseName = v; } catch { /* storage blocked */ }
  bases[baseName].addTo(map);
  L.control.layers(bases, null, { position: 'topright', collapsed: true }).addTo(map);
  map.on('baselayerchange', e => { try { localStorage.setItem('moonshot-map', e.name); } catch { /* storage blocked */ } });
  let tileErrors = 0;
  map.on('tileerror', () => { if (++tileErrors === 3) say('Map tiles are not loading. Check the connection; you can still search or use the position.'); });
  say('');
  setTimeout(() => map.invalidateSize(), 0);

  let marker = null, name = null;
  const linesGroup = L.layerGroup().addTo(map);
  const drawLines = () => {
    linesGroup.clearLayers();
    if (!marker || S.mode === 'solver') return;   // the lines are for the app's current time, not the solver's day
    const { lat, lng } = marker.getLatLng();
    for (const ln of opts.lines || []) {
      const a = ln.azDeg * Math.PI / 180;
      const end = [lat + LINE_KM * Math.cos(a) / 110.54, lng + LINE_KM * Math.sin(a) / (111.32 * Math.cos(lat * Math.PI / 180))];
      const line = L.polyline([[lat, lng], end], { color: ln.color || '#e8c66a', weight: 3, opacity: .9 }).addTo(linesGroup);
      if (ln.label) line.bindTooltip(ln.label, { permanent: true, direction: 'center', className: 'mp-lbl', opacity: 1 }).openTooltip(L.latLng(end));
    }
  };
  const place = (lat, lon, hitName) => {
    if (marker) marker.setLatLng([lat, lon]);
    else marker = L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 2, fillColor: '#e8c66a', fillOpacity: 1 }).addTo(map);
    name = hitName || null;
    use.disabled = false;
    drawLines();
    refreshSpot();
    loadNear(lat, lon);
  };
  // fine terrain around the spot, so that a rise just in front of it is not missed by the wide, coarse grid
  let nearSeq = 0;
  const loadNear = async (lat, lon) => {
    const my = ++nearSeq;
    if (S.mode !== 'solver') return;
    if (S.near && Number.isFinite(elevAt(S.near, lon - 0.012, lat - 0.009)) && Number.isFinite(elevAt(S.near, lon + 0.012, lat + 0.009))) return;
    try {
      const g = await fetchElevGrid([lon - 0.018, lat - 0.0135, lon + 0.018, lat + 0.0135], { maxZoom: 14, maxTiles: 9 });
      if (my !== nearSeq) return;
      S.near = g; refreshSpot();
    } catch { /* the coarse answer stays */ }
  };
  map.on('click', e => {
    if (S.mode === 'solver' && S.tap === 'subject') { setSubject(e.latlng.lat, e.latlng.lng); return; }
    const hit = S.mode === 'solver' ? snapToBand(e.latlng.lat, e.latlng.lng) : null;
    place(hit ? hit.lat : e.latlng.lat, hit ? hit.lon : e.latlng.lng, null); say('');
  });
  // a tap within about a fingertip of the shaded band lands on its best-aligned cell (the band is thin)
  const snapToBand = (lat, lon) => {
    const g = S.grid, res = S.res;
    if (!g || !res || !S.subject) return null;
    const p = lonLatToPx(lon, lat, g.z), ci = Math.floor((p.x - g.x0) / res.stride), cj = Math.floor((p.y - g.y0) / res.stride);
    const rc = Math.min(40, Math.max(1, Math.ceil(28 * 2 ** (g.z - map.getZoom()) / res.stride)));
    let best = null, bm = Infinity;
    for (let j = Math.max(0, cj - rc); j <= Math.min(res.ny - 1, cj + rc); j++) for (let i = Math.max(0, ci - rc); i <= Math.min(res.nx - 1, ci + rc); i++) {
      const m = Math.abs(res.miss[j * res.nx + i]);
      if (m < bm && Math.hypot(i - ci, j - cj) <= rc) { bm = m; best = [i, j]; }
    }
    return best && pxToLonLat(g.x0 + (best[0] + .5) * res.stride, g.y0 + (best[1] + .5) * res.stride, g.z);
  };


  // ---- solver ----------------------------------------------------------------
  const S = { mode: opts.mode === 'solver' ? 'solver' : 'spot', body: 'moon', kind: 'rise', tap: 'subject', dayIdx: 0, subject: null, grid: null, near: null, runs: [], res: null, spot: null };
  const baseDay = TZ.dayStart(opts.date instanceof Date ? opts.date : new Date());
  const dayAt = i => TZ.dayStart(new Date(+baseDay + i * DAY_MS + 12 * 3600000));
  let subjMarker = null, spotLine = null, overlay = null, token = 0, fetchTimer = 0, fetchCtl = null, wantedArea = 0;
  const solverOn = () => S.mode === 'solver';

  const markBody = group(pr1, [['moon', 'Moon'], ['sun', 'Sun'], ['gc', 'Galactic centre']], () => S.body, k => { S.body = k; changed(); });
  pr1.append(el('div', 'mp-sep'));
  const markKind = group(pr1, [['rise', 'Rise'], ['set', 'Set']], () => S.kind, k => { S.kind = k; changed(); });
  pr2.append(el('span', 'mp-small', 'Tap sets:'));
  const markTap = group(pr2, [['subject', 'Subject'], ['spot', 'Spot']], () => S.tap, k => { S.tap = k; });
  const hLbl = el('span', 'mp-small', 'Height m'); hLbl.title = 'Subject height above ground (m)';
  pr2.append(el('div', 'mp-sep'), hLbl, hInput);
  const markMode = () => { modeSpot.setAttribute('aria-pressed', String(!solverOn())); modeSolver.setAttribute('aria-pressed', String(solverOn())); };

  const heightM = () => Math.max(0, +hInput.value || 0);
  const subjIcon = L.divIcon({ className: '', html: '<div class="mp-tri"></div>', iconSize: [22, 22], iconAnchor: [11, 20] });

  const dayLabel = () => {
    const d = dayAt(S.dayIdx);
    let mc = null; try { mc = map.getCenter(); } catch (e) { /* no view yet */ }
    const c = S.subject || mc || {}, lat = c.lat ?? opts.lat ?? 0, lon = c.lng ?? c.lon ?? opts.lon ?? 0;
    let t = TZ.format(d, 'date');
    try {
      const k = astro.nightSky(d, astro.observer(lat, lon, 0));
      if (S.body === 'moon') t += `\n${Math.round(k.fraction * 100)}% lit`;
      gl.update(k, { south: lat < 0 });
    } catch (e) { gl.update(null); }
    dt.textContent = t; dt.style.whiteSpace = 'pre-line'; dt.style.textAlign = 'right';
  };

  const refreshInfo = () => {
    const parts = [];
    if (marker) { const { lat, lng } = marker.getLatLng(); parts.push(fixed(lat, lng)); }
    if (solverOn()) {
      if (S.subject) parts.push(`subject top ${Math.round(S.subject.elev)} m`);
      if (S.spot) parts.push(S.spot.text);
      else if (!S.subject) parts.push('tap the map to mark the subject');
    }
    pos.textContent = parts.join(' · ') || 'Tap the map to place the spot.';
    use.disabled = !marker;
  };

  const spotResult = () => {
    S.spot = null;
    if (!solverOn() || !S.subject || !marker) return;
    if (!S.grid) { S.spot = { text: 'Terrain not loaded yet.' }; return; }
    const { lat, lng } = marker.getLatLng();
    const r = solveSpot(S.grid, S.subject, S.runs, lat, lng, 1.7, S.near);
    if (!r || Math.abs(r.miss) > 1.5 / R2D) { S.spot = { text: 'No alignment from here on this day.' }; return; }
    if (!r.visible) { S.spot = { text: 'The subject is hidden by terrain from here.' }; return; }
    const m = r.miss * R2D, nm = BODY_NAME[S.body];
    S.spot = { r, text: `${nm} behind the subject at ${TZ.format(new Date(r.t), 'time')} · ${(r.distM / 1000).toFixed(1)} km away · subject top ${(r.alt * R2D).toFixed(1)}° up · ${nm.toLowerCase()} centre passes ${Math.abs(m).toFixed(1)}° ${m >= 0 ? 'above' : 'below'} the top` };
  };
  const drawSpotLine = () => {
    if (spotLine) { spotLine.remove(); spotLine = null; }
    if (solverOn() && S.subject && marker) spotLine = L.polyline([marker.getLatLng(), [S.subject.lat, S.subject.lon]], { color: '#e5483a', weight: 1.5, opacity: .9, interactive: false }).addTo(map);
  };
  const refreshSpot = () => { spotResult(); drawSpotLine(); refreshInfo(); };

  const paint = res => {
    const g = S.grid, c = document.createElement('canvas');
    c.width = res.nx; c.height = res.ny;
    const cx = c.getContext('2d'), img = cx.createImageData(res.nx, res.ny);
    let shaded = 0;
    for (let i = 0; i < res.miss.length; i++) {
      const m = Math.abs(res.miss[i]) * R2D;
      if (!(m < 1.5)) { img.data.set([8, 16, 24, 50], 4 * i); continue; }   // dim where there is no alignment
      const a = m <= 0.4 ? 1 : (1.5 - m) / 1.1;
      img.data.set([255, 186, 30, Math.round((.25 + a * .6) * 255)], 4 * i);
      shaded++;
    }
    cx.putImageData(img, 0, 0);
    const nw = pxToLonLat(g.x0, g.y0, g.z), se = pxToLonLat(g.x0 + res.nx * res.stride, g.y0 + res.ny * res.stride, g.z);
    if (overlay) overlay.remove();
    overlay = L.imageOverlay(c.toDataURL(), [[nw.lat, nw.lon], [se.lat, se.lon]], { opacity: 1, interactive: false, className: 'mp-shade' });
    if (solverOn()) overlay.addTo(map);
    return shaded;
  };

  const recompute = () => {
    const my = ++token;
    if (!solverOn() || !S.subject || !S.grid) { refreshSpot(); return; }
    requestAnimationFrame(() => setTimeout(() => {
      if (my !== token) return;
      const sj = S.subject;
      S.runs = bodyTrack(S.body, S.kind, dayAt(S.dayIdx), astro.observer(sj.lat, sj.lon, sj.elev));
      const res = S.res = solveGrid(S.grid, sj, S.runs);
      if (my !== token) return;
      const n = paint(res);
      say(n ? '' : `No ${EVENT[S.body][S.kind === 'rise' ? 0 : 1]} behind the subject is visible in this area on this day.`, !!n);
      refreshSpot();
    }, 0));
  };
  const changed = () => { dayLabel(); recompute(); };

  const contains = (g, [w, s, e, n]) => {
    const a = pxToLonLat(g.x0, g.y0, g.z), b = pxToLonLat(g.x0 + g.nx, g.y0 + g.ny, g.z);
    return w >= a.lon && e <= b.lon && n <= a.lat && s >= b.lat;
  };
  const wantedBbox = () => {
    const mb = map.getBounds(), sj = S.subject, dLat = 100 / 111.32, dLon = dLat / Math.cos(sj.lat * Math.PI / 180);
    return [Math.max(Math.min(mb.getWest(), sj.lon), sj.lon - dLon), Math.max(Math.min(mb.getSouth(), sj.lat), sj.lat - dLat),
      Math.min(Math.max(mb.getEast(), sj.lon), sj.lon + dLon), Math.min(Math.max(mb.getNorth(), sj.lat), sj.lat + dLat)];
  };
  const refetch = (delay = 400, force = false) => {
    clearTimeout(fetchTimer);
    if (!solverOn() || !S.subject) return;
    fetchTimer = setTimeout(async () => {
      const bb = wantedBbox(), area = (bb[2] - bb[0]) * (bb[3] - bb[1]);
      if (!force && S.grid && contains(S.grid, bb) && area > wantedArea / 4) return;
      if (fetchCtl) fetchCtl.abort();
      const ctl = fetchCtl = new AbortController();
      say('Loading terrain…', true);
      try {
        const g = await fetchElevGrid(bb, { signal: ctl.signal });
        if (ctl !== fetchCtl) return;
        S.grid = g; wantedArea = area; say('');
        recompute();
      } catch (e) { if (e?.name !== 'AbortError' && ctl === fetchCtl) say(e.message || 'The terrain data could not be loaded.'); }
    }, delay);
  };
  map.on('moveend', () => refetch());

  const setSubject = async (lat, lon, sname = null) => {
    say('Loading terrain…', true);
    try {
      let g = S.grid && Number.isFinite(elevAt(S.grid, lon, lat)) ? S.grid : null;
      if (!g) g = await fetchElevGrid([lon - 0.02, lat - 0.02, lon + 0.02, lat + 0.02]);
      // snap to the highest cell within 250 m
      const c = lonLatToPx(lon, lat, g.z), mpp = 156543.03 * Math.cos(lat * Math.PI / 180) / 2 ** g.z, r = 250 / mpp;
      let bx = c.x, by = c.y, bz = -Infinity;
      for (let y = Math.floor(c.y - r); y <= c.y + r; y++) for (let x = Math.floor(c.x - r); x <= c.x + r; x++) {
        const i = x - g.x0, j = y - g.y0;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.ny || Math.hypot(x + .5 - c.x, y + .5 - c.y) > r) continue;
        const z = g.data[j * g.nx + i];
        if (z > bz) { bz = z; bx = x + .5; by = y + .5; }
      }
      if (!Number.isFinite(bz)) throw new Error('No terrain data at that point.');
      const p = pxToLonLat(bx, by, g.z);
      S.subject = { lat: p.lat, lon: p.lon, ground: bz, elev: bz + heightM(), name: sname };
      if (!S.grid) S.grid = g;
      if (subjMarker) subjMarker.setLatLng([p.lat, p.lon]);
      else subjMarker = L.marker([p.lat, p.lon], { icon: subjIcon, interactive: false, keyboard: false }).addTo(map);
      S.tap = 'spot'; markTap();
      say(''); dayLabel();
      refetch(0, true); recompute();
    } catch (e) { say(e.message || 'The terrain data could not be loaded.'); }
  };

  const applyMode = () => {
    markMode();
    panel.style.display = solverOn() ? '' : 'none';
    for (const l of [subjMarker, overlay]) if (l) (solverOn() ? l.addTo(map) : l.remove());
    if (solverOn()) { dayLabel(); refetch(0); recompute(); } else { token++; if (spotLine) { spotLine.remove(); spotLine = null; } S.spot = null; refreshInfo(); }
    refreshInfo();
    setTimeout(() => map.invalidateSize(), 0);
  };
  modeSpot.onclick = () => { S.mode = 'spot'; applyMode(); };
  modeSolver.onclick = () => { S.mode = 'solver'; if (S.subject) S.tap = 'spot'; markTap(); applyMode(); };

  hInput.onchange = () => {
    if (!S.subject) return;
    S.subject.elev = S.subject.ground + heightM(); refetch(0, false); recompute();
  };
  const setDay = i => { i = Math.max(0, Math.min(365, i)); if (i === S.dayIdx) return; S.dayIdx = i; day.value = String(i); tick(); changed(); };
  day.oninput = () => setDay(+day.value);
  prev.onclick = () => setDay(S.dayIdx - 1);
  next.onclick = () => setDay(S.dayIdx + 1);
  if (hasStart) place(opts.lat, opts.lon, null);
  applyMode();

  let busy = false;
  const search = async () => {
    const q = input.value.trim();
    if (!q) { say('Type a place name first.'); return; }
    if (busy) return;
    busy = true; say('Searching…', true);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error('status ' + r.status);
      const hit = (await r.json())[0];
      if (!hit) { say('Nothing found by that name.'); return; }
      const lat = +hit.lat, lon = +hit.lon;
      if (S.mode === 'solver' && S.tap === 'subject') setSubject(lat, lon, hit.name || null); else place(lat, lon, hit.name || q);   // in the solver a search finds the subject
      map.flyTo([lat, lon], Math.max(map.getZoom(), 12));
      say('');
    } catch { say('Search failed. Check the connection and try again.'); } finally { busy = false; }
  };
  find.onclick = search;
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };

  here.onclick = async () => {
    here.disabled = true; say('Finding where you are…', true);
    try {
      const p = await whereAmI();
      place(p.lat, p.lon, null);
      map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 13));
      say(`Position found, accurate to about ${Math.round(p.acc)} m.`, true);
    } catch (e) { say(e.message); } finally { here.disabled = false; }
  };

  return new Promise(resolve => {
    const done = v => { map.remove(); root.remove(); resolve(v); };
    cancel.onclick = () => done(null);
    use.onclick = () => {
      if (!marker) return;
      const { lat, lng } = marker.getLatLng(), out = { lat, lon: lng, name: name || null };
      const r = solverOn() && S.subject && S.spot?.r;
      if (r && r.visible) {
        const sj = S.subject;
        out.plan = { time: new Date(r.t), azDeg: r.az * R2D, altDeg: r.alt * R2D, body: S.body, kind: S.kind, subject: { lat: sj.lat, lon: sj.lon, elev: sj.elev, name: sj.name || null } };
      }
      done(out);
    };
  });
}
