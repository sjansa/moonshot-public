// mappick.js -- full-screen map sheet to choose a spot.
//
// pickSpot() resolves to {lat, lon, name} or null (canceled). A native picker
// can replace Leaflet: if the Capacitor 'SpotPicker' plugin exists it is used.

import { whereAmI } from './places.js?v=1115.1805-901b992';

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
.mp-pos{flex:1;font-variant-numeric:tabular-nums;font-size:13px;color:#9fb6c3;min-width:0}
.mp-root .leaflet-control-attribution{background:rgba(12,26,34,.8);color:#9fb6c3}
.mp-root .leaflet-control-attribution a{color:#e8c66a}
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

async function pickNative(opts) {
  const r = await window.Capacitor.nativePromise('SpotPicker', 'pick', { lat: opts.lat, lon: opts.lon });
  if (!r || r.cancelled || r.canceled || !Number.isFinite(+r.lat) || !Number.isFinite(+r.lon)) return null;
  return { lat: +r.lat, lon: +r.lon, name: r.name || fixed(+r.lat, +r.lon) };
}

/**
 * opts: {lat, lon, zoom} to start from; lines: [{azDeg, color, label}] drawn
 * from the marker as 20 km azimuth lines. Resolves to {lat, lon, name} or null.
 */
export async function pickSpot(opts = {}) {
  if (window.Capacitor?.PluginHeaders?.some(h => h.name === 'SpotPicker')) return pickNative(opts);

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
  row1.append(pos, here);
  row2.append(cancel, el('div'), use);
  row2.children[1].style.flex = '1';
  foot.append(msg, row1, row2);
  root.append(bar, mapEl, foot);
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
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  let tileErrors = 0;
  map.on('tileerror', () => { if (++tileErrors === 3) say('Map tiles are not loading. Check the connection; you can still search or use the position.'); });
  say('');
  setTimeout(() => map.invalidateSize(), 0);

  let marker = null, name = null;
  const linesGroup = L.layerGroup().addTo(map);
  const drawLines = () => {
    linesGroup.clearLayers();
    if (!marker) return;
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
    pos.textContent = fixed(lat, lon);
    use.disabled = false;
    drawLines();
  };
  if (hasStart) place(opts.lat, opts.lon, null);
  map.on('click', e => { place(e.latlng.lat, e.latlng.lng, null); say(''); });

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
      place(lat, lon, hit.name || q);
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
      const { lat, lng } = marker.getLatLng();
      done({ lat, lon: lng, name: name || fixed(lat, lng) });
    };
  });
}
