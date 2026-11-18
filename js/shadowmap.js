// shadowmap.js -- the map sheet's Shadows mode: terrain shadows of the sun or the moon over
// the area on screen, at a time picked on the same time ruler as the main view.
//
// Fidelity follows the map: the grid under the screen is the finest terrain that fits in 16
// tiles (Terrarium z15, 3 to 5 m, once the view is a few hundred metres across); two wider,
// coarser grids around it (4 km and 40 km margins) carry shadows in from ridges off screen.
import * as astro from './astro.js?v=1117.2337-166b81d';
import * as TZ from './tz.js?v=1117.2337-166b81d';
import { Ruler } from './ruler.js?v=1117.2337-166b81d';
import { tick } from './haptic.js?v=1117.2337-166b81d';
import { fetchElevGrid, gridTiles, MAX_ZOOM } from './elev.js?v=1117.2337-166b81d';
import { pxToLonLat } from './solver.js?v=1117.2337-166b81d';
import { altLattice, castNested } from './shadow.js?v=1117.2337-166b81d';

const R2D = 180 / Math.PI, D2R = Math.PI / 180;
const MIN_MAP_ZOOM = 7;                       // wider than this the shading is not worth the download
// [margin km, max tiles]; the screen grid first
const LEVELS = [[0, 16], [4, 9], [40, 9]];
const BODY = { sun: astro.Body.Sun, moon: astro.Body.Moon };
const SHADE = [8, 14, 34], SHADE_A = 0.62;    // colour and opacity of full shadow

const expand = ([w, s, e, n], km) => {
  const dLat = km / 110.54, dLon = km / (111.32 * Math.cos((s + n) / 2 * D2R));
  return [w - dLon, Math.max(-85, s - dLat), e + dLon, Math.min(85, n + dLat)];
};
const tileKey = t => `${t.z}/${t.tx0}/${t.ty0}/${t.tx1}/${t.ty1}`;

/**
 * Attach to a Leaflet map. ui: {panel (element for the controls), say(text, ok), date (start), chip(label, on)}.
 * -> {show(on), destroy(), changed (true once the time was moved), get time()}
 */
export function attachShadows(L, map, ui) {
  const st = { on: false, body: 'sun', time: new Date(+ui.date || Date.now()), changed: false, grids: [], keys: [], fetchCtl: null, timer: 0, raf: 0, ready: false };
  const obsAt = () => { const c = map.getCenter(); return astro.observer(c.lat, c.lng, 0); };

  // ---- controls: body chips, then the time ruler -------------------------------------
  const row = document.createElement('div'); row.className = 'mp-row';
  const chips = [['sun', 'Sun'], ['moon', 'Moon']].map(([k, t]) => {
    const b = ui.chip(t, k === st.body); b.onclick = () => { st.body = k; chips.forEach(c => c.setAttribute('aria-pressed', String(c === b))); ruler.invalidate(); recompute(); };
    return b;
  });
  const info = document.createElement('span'); info.className = 'mp-small'; info.style.cssText = 'flex:1;min-width:0;text-align:right';
  row.append(...chips, info);
  const rEl = document.createElement('div'); rEl.style.cssText = 'height:96px;border-radius:14px;border:1px solid #26404f;margin-top:6px';
  ui.panel.append(row, rEl);

  const dayStart = d => TZ.dayStart(d);
  const markCache = new Map();
  const ruler = new Ruler(rEl, {
    haptic: tick, time: st.time,
    onChange: d => { st.time = d; st.changed = true; recompute(); },
    sunAltDeg: d => astro.altAz(astro.Body.Sun, d, obsAt()).alt * R2D,
    sky: d => { const c = map.getCenter(); return { ...astro.nightSky(dayStart(d), obsAt()), south: c.lat < 0 }; },
    marks: (from, to) => {
      const long = to - from > 40 * 86400e3, c = map.getCenter(), obs = obsAt(), out = [];
      for (const [name, label, color] of [['moon', 'Moon', '#e6edff'], ['sun', 'Sun', '#ffd76a']]) {
        if (long && name !== 'moon') continue;
        for (let d = dayStart(from); d < to; d = dayStart(new Date(+d + 30 * 3600e3))) {
          const key = `${name}|${c.lat.toFixed(1)}|${c.lng.toFixed(1)}|${+d}`;
          let rs = markCache.get(key);
          if (!rs) { rs = astro.riseSet(BODY[name], obs, d); if (markCache.size > 500) markCache.clear(); markCache.set(key, rs); }
          if (rs.rise) out.push({ date: rs.rise, color, label: `${label} ↑` });
          if (rs.set) out.push({ date: rs.set, color, label: `${label} ↓` });
        }
      }
      return out;
    },
    format: TZ.format, dateInputValue: TZ.dateInputValue, dateFromInput: TZ.dateFromInput,
  });

  // ---- overlay: a canvas the size of the screen grid -------------------------------------
  const canvas = document.createElement('canvas');
  canvas.className = 'mp-shade';
  let overlay = null;
  const place = g => {
    const nw = pxToLonLat(g.x0, g.y0, g.z), se = pxToLonLat(g.x0 + g.nx, g.y0 + g.ny, g.z), b = [[se.lat, nw.lon], [nw.lat, se.lon]];
    if (!overlay) overlay = L.svgOverlay(canvas, b, { interactive: false, opacity: 1 });   // svgOverlay takes any element as is
    else overlay.setBounds(L.latLngBounds(b));
    if (st.on && !map.hasLayer(overlay)) overlay.addTo(map);
  };

  // ---- terrain for the view ---------------------------------------------------------------
  const wanted = () => {
    const mb = map.getBounds().pad(0.1);
    const view = [mb.getWest(), Math.max(-85, mb.getSouth()), mb.getEast(), Math.min(85, mb.getNorth())];
    const out = [];
    let zPrev = Infinity;
    for (const [km, maxTiles] of LEVELS) {
      const bb = expand(view, km), t = gridTiles(bb, { maxTiles, maxZoom: MAX_ZOOM });
      if (t.z >= zPrev) continue;                    // no coarser than the grid inside it: not needed
      zPrev = t.z; out.push({ bb, maxTiles, key: tileKey(t), z: t.z });
    }
    return out.reverse();                            // coarsest first
  };
  const refetch = (delay = 300) => {
    clearTimeout(st.timer);
    if (!st.on) return;
    st.timer = setTimeout(async () => {
      if (map.getZoom() < MIN_MAP_ZOOM) { st.ready = false; overlay?.remove(); info.textContent = ''; ui.say('Zoom in to see shadows.', true); return; }
      const want = wanted();
      if (want.length === st.keys.length && want.every((w, i) => w.key === st.keys[i])) return;
      st.fetchCtl?.abort();
      const ctl = st.fetchCtl = new AbortController();
      ui.say('Loading terrain…', true);
      try {
        const grids = await Promise.all(want.map((w, i) => (st.keys[i] === w.key ? st.grids[i] : fetchElevGrid(w.bb, { maxTiles: w.maxTiles, maxZoom: MAX_ZOOM, signal: ctl.signal }))));
        if (ctl !== st.fetchCtl) return;
        st.grids = grids; st.keys = want.map(w => w.key); st.ready = true;
        ui.say('');
        recompute();
      } catch (e) { if (e?.name !== 'AbortError' && ctl === st.fetchCtl) ui.say(e.message || 'The terrain data could not be loaded.'); }
    }, delay);
  };
  const onMove = () => { refetch(); ruler.invalidate(); };
  map.on('moveend', onMove);

  // ---- shadows ----------------------------------------------------------------------------
  const recompute = () => {
    if (!st.on || !st.ready || st.raf) return;
    st.raf = requestAnimationFrame(() => { st.raf = 0; compute(); });
  };
  const compute = () => {
    const grids = st.grids, fine = grids[grids.length - 1], outer = grids[0];
    const ob = pxToLonLat(outer.x0, outer.y0, outer.z), oe = pxToLonLat(outer.x0 + outer.nx, outer.y0 + outer.ny, outer.z);
    const body = BODY[st.body], date = st.time, obs = obsAt();
    const here = astro.sunMoon(date, obs)[st.body];
    const lattice = altLattice([ob.lon, oe.lat, oe.lon, ob.lat], (lat, lon) => astro.altAz(body, date, astro.observer(lat, lon, 0)).alt);
    const res = castNested(grids, { az: here.az, lattice, radius: here.radius });
    // paint
    if (canvas.width !== fine.nx || canvas.height !== fine.ny) { canvas.width = fine.nx; canvas.height = fine.ny; }
    const cx = canvas.getContext('2d'), img = cx.createImageData(fine.nx, fine.ny), px = img.data, lit = res.lit;
    for (let i = 0, k = 0; i < lit.length; i++, k += 4) {
      const a = (1 - lit[i]) * SHADE_A;
      if (a <= 0.004) continue;
      px[k] = SHADE[0]; px[k + 1] = SHADE[1]; px[k + 2] = SHADE[2]; px[k + 3] = Math.round(a * 255);
    }
    cx.putImageData(img, 0, 0);
    place(fine);
    // readout
    const c = map.getCenter(), mpp = 40075016.686 * Math.cos(c.lat * D2R) / (256 * 2 ** fine.z);
    const altD = here.alt * R2D, name = st.body === 'sun' ? 'Sun' : 'Moon';
    let t = altD < -1 ? `${name} below the horizon` : `${name} ${altD.toFixed(1)}° up, bearing ${Math.round((here.az * R2D + 360) % 360)}°`;
    if (st.body === 'moon') {
      t += ` · ${Math.round(here.fraction * 100)}% lit`;
      if (astro.altAz(astro.Body.Sun, date, obs).alt * R2D > -6) t += ' · daylight';
    }
    info.textContent = `${t} · terrain ${mpp < 10 ? mpp.toFixed(1) : Math.round(mpp)} m`;
  };

  return {
    show(on) {
      st.on = !!on;
      ui.panel.style.display = st.on ? '' : 'none';
      if (st.on) { ruler.resize(); refetch(0); recompute(); } else { clearTimeout(st.timer); overlay?.remove(); }
    },
    destroy() { clearTimeout(st.timer); st.fetchCtl?.abort(); if (st.raf) cancelAnimationFrame(st.raf); map.off('moveend', onMove); ruler.destroy(); overlay?.remove(); },
    get changed() { return st.changed; },
    get time() { return st.time; },
  };
}
