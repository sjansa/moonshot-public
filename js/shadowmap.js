// shadowmap.js -- the map sheet's Shadows mode: terrain shadows of the sun or the moon over
// the area on screen, at a time picked on the same time ruler as the main view.
//
// Fidelity follows the map: the grid under the screen is the finest terrain that fits in 16
// tiles (Terrarium z15, 3 to 5 m, once the view is a few hundred metres across); two wider,
// coarser grids around it (4 km and 40 km margins) carry shadows in from ridges off screen.
// Zoomed out past terrain, the shading is the earth's own: day, night and the twilight bands
// between, drawn for the whole view, with high ground seeing past the sea-level horizon
// (coarse terrain for the view). Both use the same darkness for the same sun, so they
// cross-fade into each other at the zoom where terrain takes over.
import * as astro from './astro.js?v=1122.0212-79fa2c9';
import * as TZ from './tz.js?v=1122.0212-79fa2c9';
import { Ruler } from './ruler.js?v=1122.0212-79fa2c9';
import { tick } from './haptic.js?v=1122.0212-79fa2c9';
import { fetchElevGrid, gridTiles, MAX_ZOOM } from './elev.js?v=1122.0212-79fa2c9';
import { pxToLonLat, lonLatToPx } from './solver.js?v=1122.0212-79fa2c9';
import { altLattice, castNested, discFraction, skyShade, latticeAt } from './shadow.js?v=1122.0212-79fa2c9';

const R2D = 180 / Math.PI, D2R = Math.PI / 180;
const MIN_MAP_ZOOM = 7;                       // wider than this: the earth's day and night only, no terrain
// [margin km, max tiles]; the screen grid first
const LEVELS = [[0, 16], [4, 9], [40, 9]];
const BODY = { sun: astro.Body.Sun, moon: astro.Body.Moon };
const SHADE = [8, 14, 34], MOON_SHADE = 0.62; // colour; opacity of moon shadow (the sun's: skyShade)
const GLOBAL_PX = 2, GLOBAL_TILES = 16;                          // screen pixels per pixel of the day/night canvas

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
  const st = { gElev: null, gKey: '', gCtl: null, on: false, body: 'sun', time: new Date(+ui.date || Date.now()), changed: false, grids: [], keys: [], fetchCtl: null, timer: 0, raf: 0, ready: false };
  const obsAt = () => { const c = map.getCenter(); return astro.observer(c.lat, c.lng, 0); };

  // ---- controls: body chips, then the time ruler -------------------------------------
  const row = document.createElement('div'); row.className = 'mp-row';
  const chips = [['sun', 'Sun'], ['moon', 'Moon']].map(([k, t]) => {
    const b = ui.chip(t, k === st.body); b.onclick = () => { st.body = k; chips.forEach(c => c.setAttribute('aria-pressed', String(c === b))); ruler.invalidate(); recompute(); };
    return b;
  });
  const info = document.createElement('span'); info.className = 'mp-small'; info.style.cssText = 'flex:1;min-width:0;text-align:right';
  const seg = document.createElement('div'); seg.className = 'mp-seg'; seg.style.flex = '0 0 150px'; seg.append(...chips);
  row.append(seg, info); row.style.paddingBottom = '6px';
  const rEl = document.createElement('div'); rEl.className = 'mp-ruler';
  ui.panel.append(ui.fold ? ui.fold(row) : row, rEl);

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

  // ---- overlays: a canvas for terrain (the screen grid) and one for the earth's day and night --
  // svgOverlay takes any element as is. Only one shows at a time; the other fades out.
  const layer = () => {
    const canvas = document.createElement('canvas'); canvas.className = 'mp-shade';
    const o = { canvas, ov: null, vis: false };
    o.place = b => {
      if (!o.ov) o.ov = L.svgOverlay(canvas, b, { interactive: false, opacity: 0 });
      else o.ov.setBounds(L.latLngBounds(b));
      if (st.on && !map.hasLayer(o.ov)) { o.ov.addTo(map); o.ov.setOpacity(0); o.vis = false; }
    };
    // a frame after the opacity was set to 0, so the change is a CSS transition (the fade)
    o.show = on => { if (o.vis === on || !o.ov) return; o.vis = on; requestAnimationFrame(() => o.ov.setOpacity(o.vis ? 1 : 0)); };
    o.remove = () => { o.ov?.remove(); o.vis = false; };
    return o;
  };
  const terr = layer(), glob = layer();
  const showOnly = which => { terr.show(which === terr); glob.show(which === glob); };
  const paint = (cv, nx, ny, alpha) => {
    if (cv.width !== nx || cv.height !== ny) { cv.width = nx; cv.height = ny; }
    const cx = cv.getContext('2d'), img = cx.createImageData(nx, ny), px = img.data;
    for (let i = 0, k = 0; i < alpha.length; i++, k += 4) {
      const a = alpha[i];
      if (a <= 0.004) continue;
      px[k] = SHADE[0]; px[k + 1] = SHADE[1]; px[k + 2] = SHADE[2]; px[k + 3] = Math.round(a * 255);
    }
    cx.putImageData(img, 0, 0);
  };
  const useTerrain = () => map.getZoom() >= MIN_MAP_ZOOM && st.ready;

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
  // coarse terrain for the day/night view: only how far each place sees past the sea-level horizon
  const fetchGlobal = async () => {
    const mb = map.getBounds();
    const bb = [Math.max(-180, mb.getWest()), Math.max(-85, mb.getSouth()), Math.min(180, mb.getEast()), Math.min(85, mb.getNorth())];
    const key = tileKey(gridTiles(bb, { maxTiles: GLOBAL_TILES, maxZoom: MAX_ZOOM }));
    if (key === st.gKey) return;
    st.gCtl?.abort();
    const ctl = st.gCtl = new AbortController();
    try {
      const g = await fetchElevGrid(bb, { maxTiles: GLOBAL_TILES, maxZoom: MAX_ZOOM, signal: ctl.signal });
      if (ctl !== st.gCtl) return;
      st.gElev = g; st.gKey = key; recompute();
    } catch (e) { /* without it the shading is for sea level */ }
  };
  const refetch = (delay = 300) => {
    clearTimeout(st.timer);
    if (!st.on) return;
    st.timer = setTimeout(async () => {
      if (map.getZoom() < MIN_MAP_ZOOM) {                 // the earth's shading only; drop terrain from elsewhere
        st.fetchCtl?.abort(); st.fetchCtl = null; st.ready = false; st.grids = []; st.keys = []; ui.say(''); recompute(); fetchGlobal(); return;
      }
      const want = wanted();
      if (want.length === st.keys.length && want.every((w, i) => w.key === st.keys[i])) return;
      st.fetchCtl?.abort();
      const ctl = st.fetchCtl = new AbortController();
      if (st.ready) ui.say('Loading terrain…', true);   // over the day/night shading the wait shows as is
      try {
        const grids = await Promise.all(want.map((w, i) => (st.keys[i] === w.key ? st.grids[i] : fetchElevGrid(w.bb, { maxTiles: w.maxTiles, maxZoom: MAX_ZOOM, signal: ctl.signal }))));
        if (ctl !== st.fetchCtl || map.getZoom() < MIN_MAP_ZOOM) return;
        st.grids = grids; st.keys = want.map(w => w.key); st.ready = true;
        ui.say('');
        recompute();
      } catch (e) { if (e?.name !== 'AbortError' && ctl === st.fetchCtl) ui.say(e.message || 'The terrain data could not be loaded.'); }
    }, delay);
  };
  const onMove = () => { refetch(); ruler.invalidate(); if (!useTerrain()) recompute(); };
  map.on('moveend resize', onMove);

  // ---- shadows ----------------------------------------------------------------------------
  const recompute = () => {
    if (!st.on || st.raf) return;
    st.raf = requestAnimationFrame(() => { st.raf = 0; compute(); });
  };
  // darkness of a cell from the visible fraction of the disc and the sun's geometric altitude there
  const dark = (lit, altDeg) => (1 - lit) * (st.body === 'sun' ? skyShade(altDeg) : MOON_SHADE);
  const compute = () => {
    const body = BODY[st.body], date = st.time, obs = obsAt();
    const here = astro.sunMoon(date, obs)[st.body], field = astro.altField(body, date);
    if (useTerrain()) drawTerrain(here, field); else drawGlobal(here, field);
    // readout
    const altD = here.alt * R2D, name = st.body === 'sun' ? 'Sun' : 'Moon';
    let t = altD < -1 ? `${name} below the horizon` : `${name} ${altD.toFixed(1)}° up, bearing ${Math.round((here.az * R2D + 360) % 360)}°`;
    if (st.body === 'moon') {
      t += ` · ${Math.round(here.fraction * 100)}% lit`;
      if (astro.altAz(astro.Body.Sun, date, obs).alt * R2D > -6) t += ' · daylight';
    } else if (altD < -0.5) {
      const g = field(map.getCenter().lat, map.getCenter().lng, false) * R2D;
      t += g > -6 ? ' · civil twilight' : g > -12 ? ' · nautical twilight' : g > -18 ? ' · astronomical twilight' : ' · night';
    }
    if (useTerrain()) {
      const fine = st.grids[st.grids.length - 1], mpp = 40075016.686 * Math.cos(map.getCenter().lat * D2R) / (256 * 2 ** fine.z);
      t += ` · terrain ${mpp < 10 ? mpp.toFixed(1) : Math.round(mpp)} m`;
    } else t += map.getZoom() < MIN_MAP_ZOOM ? ' · zoom in for terrain' : ' · loading terrain…';
    info.textContent = t;
  };

  const drawTerrain = (here, field) => {
    const grids = st.grids, fine = grids[grids.length - 1], outer = grids[0];
    const box = g => { const a = pxToLonLat(g.x0, g.y0, g.z), b = pxToLonLat(g.x0 + g.nx, g.y0 + g.ny, g.z); return { a, b, bb: [a.lon, b.lat, b.lon, a.lat] }; };
    const O = box(outer), F = box(fine);
    const lattice = altLattice(O.bb, (lat, lon) => field(lat, lon));
    const res = castNested(grids, { az: here.az, lattice, radius: here.radius });
    const geo = altLattice(F.bb, (lat, lon) => field(lat, lon, false) * R2D, 17);   // for the twilight bands
    const { nx, ny, x0, y0, z } = fine, sc = 2 ** z, lit = res.lit, alpha = new Float32Array(nx * ny);
    for (let j = 0, c = 0; j < ny; j++) {
      const Y = (y0 + j + 0.5) / sc;
      for (let i = 0; i < nx; i++, c++) alpha[c] = lit[c] >= 1 ? 0 : dark(lit[c], latticeAt(geo, geo.alt, (x0 + i + 0.5) / sc, Y));
    }
    paint(terr.canvas, nx, ny, alpha);
    terr.place([[F.b.lat, F.a.lon], [F.a.lat, F.b.lon]]);
    showOnly(terr);
  };

  // the earth's shading over the whole view: the disc against a sea-level horizon, and twilight
  const drawGlobal = (here, field) => {
    const size = map.getSize(), nx = Math.max(2, Math.ceil(size.x / GLOBAL_PX)), ny = Math.max(2, Math.ceil(size.y / GLOBAL_PX));
    const mb = map.getBounds(), n = Math.min(85.05, mb.getNorth()), s = Math.max(-85.05, mb.getSouth()), w = mb.getWest(), e = mb.getEast();
    const yOf = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)), yn = yOf(n), ys = yOf(s);
    const alpha = new Float32Array(nx * ny), rad = here.radius, eg = st.gElev;
    // dip of the sea-level horizon seen from the ground at (lat, lon): sqrt(2 h / R)
    const dip = (lat, lon) => {
      if (!eg) return 0;
      const p = lonLatToPx(((lon + 540) % 360) - 180, lat, eg.z), u = Math.floor(p.x - eg.x0), v = Math.floor(p.y - eg.y0);
      if (u < 0 || v < 0 || u >= eg.nx || v >= eg.ny) return 0;
      const h = eg.data[v * eg.nx + u];
      return h > 0 ? Math.sqrt(2 * h / 6371000) : 0;
    };
    for (let j = 0, c = 0; j < ny; j++) {
      const lat = (2 * Math.atan(Math.exp(yn + (ys - yn) * (j + 0.5) / ny)) - Math.PI / 2) * R2D;
      for (let i = 0; i < nx; i++, c++) {
        const lon = w + (e - w) * (i + 0.5) / nx, a = field(lat, lon);
        const lit = discFraction((a + dip(lat, lon)) / rad);
        alpha[c] = lit >= 1 ? 0 : dark(lit, field(lat, lon, false) * R2D);
      }
    }
    paint(glob.canvas, nx, ny, alpha);
    glob.place([[s, w], [n, e]]);
    showOnly(glob);
  };

  return {
    show(on) {
      st.on = !!on;
      ui.panel.style.display = st.on ? '' : 'none';
      if (st.on) { map.invalidateSize(); ruler.resize(); refetch(0); recompute(); } else { clearTimeout(st.timer); terr.remove(); glob.remove(); }
    },
    destroy() { clearTimeout(st.timer); st.fetchCtl?.abort(); st.gCtl?.abort(); if (st.raf) cancelAnimationFrame(st.raf); map.off('moveend resize', onMove); ruler.destroy(); terr.remove(); glob.remove(); },
    /** Small ruler: just the scale and a one-line date, time and moon phase. */
    setCompact(on) { ruler.setCompact(on); },
    get changed() { return st.changed; },
    get time() { return st.time; },
  };
}
