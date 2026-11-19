// places.js -- named spots, each with its own downloaded terrain.
//
// Terrain comes from core build.js; files live in IndexedDB (database
// `moonshot`, one store). Storage that is missing or blocked never breaks the
// app: a new place then works until the page closes (kept in `session`).
// The only geolocation call in the app is whereAmI().
//
// Nothing here touches browser globals at import time (tests run it in Node).

import { buildTerrain, estimate, expandBbox, DEM_UNIT } from '../core/build.js?v=1119.0437-fbafc20';
import { Grid, Terrain } from '../core/terrain.js?v=1119.0437-fbafc20';

export const REACH = { normal: { km: 60, coarseRes: 60 }, far: { km: 120, coarseRes: 120 } };
export const FINE_KM = 8, FINE_RES = 10;

const DB = 'moonshot', STORE = 'files';
const session = new Map();     // id -> {place, terrain}: places that could not be saved

// ---------------------------------------------------------------- pure parts

/** Download recipe for a spot: an 8 km box on it, fine at 10 m, coarse out to the reach. */
export function terrainSpec(lat, lon, reach = 'normal') {
  const r = REACH[reach] || REACH.normal;
  return { bbox: expandBbox([lon, lat, lon, lat], FINE_KM / 2), fineRes: FINE_RES, coarseRes: r.coarseRes, marginKm: r.km - FINE_KM / 2 };
}

export function terrainEstimate(lat, lon, reach) {
  const s = terrainSpec(lat, lon, reach);
  return estimate(s.bbox, s);
}

/** pack.json: a Ridgeline pack's fields without features and declination. */
export function packMeta(place, built) {
  const side = (g, b, file) => ({ file, west: b[0], south: b[1], east: b[2], north: b[3], cols: g.cols, rows: g.rows });
  return {
    id: place.id, name: place.name, built: place.built || new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    demUnit: DEM_UNIT,
    fine: side(built.fineGrid, built.fine, 'dem_fine.bin'),
    coarse: side(built.coarseGrid, built.coarse, 'dem_coarse.bin'),
    attribution: 'Terrain: Mapzen/AWS Terrain Tiles.',
  };
}

export function terrainFromPack(meta, fineBuf, coarseBuf) {
  return new Terrain(new Grid(meta.fine, new Uint16Array(fineBuf), meta.demUnit), new Grid(meta.coarse, new Uint16Array(coarseBuf), meta.demUnit));
}

// --------------------------------------------------------------------- peaks

const LATIN = /[A-Za-z\u00C0-\u024F]/;
/** Meters from an OSM ele tag ("3430", "3430 m", "3,430"), else null. */
export function parseEle(s) {
  const m = /^\s*(-?\d[\d,]*(?:\.\d+)?)\s*(?:m|meters?|metres?)?\s*$/i.exec(String(s ?? ''));
  const v = m ? +m[1].replace(/,/g, '') : NaN;
  return Number.isFinite(v) ? v : null;
}

/** Named peaks and volcanoes from OpenStreetMap (Overpass) within a place's reach. -> [{name, lat, lon, ele}] */
export async function fetchPeaks(lat, lon, reach = 'normal', signal) {
  const km = (REACH[reach] || REACH.normal).km, dLat = km / 110.54, dLon = km / (111.32 * Math.cos(lat * Math.PI / 180));
  const q = `[out:json][timeout:40];node["natural"~"^(peak|volcano)$"]["name"](${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon});out body;`;
  let j, last;
  // the public servers are often busy: try each in turn
  for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try {
      // 20 s per server, so a hung one does not block the next
      const quit = new AbortController(), timer = setTimeout(() => quit.abort(), 20000);
      signal?.addEventListener('abort', () => quit.abort(), { once: true });
      let r;
      try { r = await fetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: quit.signal }); } finally { clearTimeout(timer); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
      break;
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e;
    }
  }
  if (!j) throw new Error('Could not load peak names (' + (String(last?.message || last).slice(0, 60)) + ').');
  const out = [];
  for (const n of j.elements || []) {
    const t = n.tags || {};
    let name = t.name;
    if (name && !LATIN.test(name) && t['name:en']) name = t['name:en'];
    if (name && Number.isFinite(n.lat) && Number.isFinite(n.lon)) out.push({ name, lat: n.lat, lon: n.lon, ele: parseEle(t.ele) });
  }
  return out;
}

/** Peaks kept for a place; fetched (and kept, if the place is saved) when there are none yet. [] on failure. */
export async function loadPeaks(place) {
  const key = `${place.id}/peaks.json`;
  if (place.id) {
    const s = await get(key);
    if (s) try { const a = JSON.parse(typeof s === 'string' ? s : new TextDecoder().decode(s)); if (Array.isArray(a)) return a; } catch { /* refetch */ }
  }
  try {
    const list = await fetchPeaks(place.lat, place.lon, place.reach);
    if (place.id && !session.has(place.id)) await put(key, JSON.stringify(list));
    return list;
  } catch { return []; }
}

// ------------------------------------------------------------------- storage

function openDb() {
  return new Promise((res, rej) => {
    let rq;
    try { rq = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
    rq.onblocked = () => rej(new Error('blocked'));
  });
}
async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode), rq = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(rq?.result);
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
const get = key => idb('readonly', s => s.get(key)).catch(() => undefined);
const put = (key, val) => idb('readwrite', s => s.put(val, key)).then(() => true, () => false);

const readList = async () => (await get('places')) || [];
const clean = p => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, eyeM: p.eyeM, reach: p.reach, built: p.built, bytes: p.bytes });

/** Saved places, newest first, plus any that could only be kept for this session. */
export async function listPlaces() {
  const saved = await readList(), ids = new Set(saved.map(p => p.id));
  const extra = [...session.values()].map(v => v.place).filter(p => !ids.has(p.id));
  return [...saved, ...extra].map(p => ({ ...clean(p), saved: !session.has(p.id) }));
}
export async function getLastPlaceId() { return (await get('last')) || null; }
export async function setLastPlaceId(id) { await put('last', id); }

function readable(e) {
  if (e?.name === 'AbortError') return e;
  const m = String(e?.message || e);
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return new Error('Could not reach the terrain server. Check the connection and try again.');
  return e instanceof Error ? e : new Error(m);
}

/**
 * Download terrain for a spot and keep it. progress(fraction, message).
 * Resolves to {place, terrain}; place.saved is false if the device could not keep it.
 */
export async function createPlace({ name, lat, lon, eyeM = 1.7, reach = 'normal' }, progress = () => {}, signal) {
  if (!(Math.abs(lat) <= 80) || !(Math.abs(lon) <= 180)) throw new Error('That position is outside the area the terrain data covers.');
  const spec = terrainSpec(lat, lon, reach);
  let built;
  const peaksP = fetchPeaks(lat, lon, reach, signal).catch(() => null);   // a peaks failure never fails the place
  try { built = await buildTerrain(spec, (f, m) => progress(0.95 * f, m), signal); } catch (e) { throw readable(e); }
  const peaks = await Promise.race([peaksP, new Promise(r => setTimeout(r, 1500, null))]);   // never hold the place up for names; loadPeaks gets them later
  progress(0.96, 'Saving…');
  const id = 'p-' + Date.now().toString(36);
  const place = { id, name: name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon, eyeM, reach, built: new Date().toISOString().replace(/\.\d+Z$/, '+00:00') };
  const meta = packMeta(place, built);
  const fineBuf = built.fineGrid.data.buffer, coarseBuf = built.coarseGrid.data.buffer;
  const metaBuf = new TextEncoder().encode(JSON.stringify(meta)).buffer;
  place.bytes = fineBuf.byteLength + coarseBuf.byteLength + metaBuf.byteLength;
  const terrain = terrainFromPack(meta, fineBuf, coarseBuf);
  let ok = await put(`${id}/dem_fine.bin`, fineBuf) && await put(`${id}/dem_coarse.bin`, coarseBuf) && await put(`${id}/pack.json`, metaBuf);
  if (ok && peaks) await put(`${id}/peaks.json`, JSON.stringify(peaks));
  if (ok) {
    const list = (await readList()).filter(p => p.id !== id);
    list.unshift(clean(place));
    ok = await put('places', list);
  }
  if (ok) {
    place.saved = true;
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  } else {
    place.saved = false;
    session.set(id, { place, terrain });
    await idb('readwrite', s => s.delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`))).catch(() => {});
  }
  progress(1, 'Done');
  return { place, terrain };
}

/** A saved place and its terrain, read from the device. */
export async function openPlace(id) {
  if (session.has(id)) return session.get(id);
  const entry = (await readList()).find(p => p.id === id);
  if (!entry) throw new Error('That place is not on this device any more.');
  const [metaBuf, fine, coarse] = await Promise.all([get(`${id}/pack.json`), get(`${id}/dem_fine.bin`), get(`${id}/dem_coarse.bin`)]);
  if (!metaBuf || !fine || !coarse) throw new Error(`The terrain for "${entry.name}" is missing from this device. Download it again.`);
  const meta = JSON.parse(new TextDecoder().decode(metaBuf));
  return { place: { ...clean(entry), saved: true }, terrain: terrainFromPack(meta, fine, coarse) };
}

/** Change name or eye height. No download. */
export async function updatePlace(id, patch) {
  const allowed = {};
  if (patch.name != null) allowed.name = String(patch.name);
  if (patch.eyeM != null) allowed.eyeM = +patch.eyeM;
  if (session.has(id)) { Object.assign(session.get(id).place, allowed); return { ...session.get(id).place }; }
  const list = await readList(), p = list.find(x => x.id === id);
  if (!p) throw new Error('That place is not on this device any more.');
  Object.assign(p, allowed);
  if (!await put('places', list)) throw new Error('Could not save the change: storage is blocked or full.');
  return { ...p, saved: true };
}

export async function removePlace(id) {
  session.delete(id);
  await idb('readwrite', s => s.delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`))).catch(() => {});
  await put('places', (await readList()).filter(p => p.id !== id));
  if (await getLastPlaceId() === id) await idb('readwrite', s => s.delete('last')).catch(() => {});
}

/** Bytes used on this device and the room the browser allows, or null. */
export async function storageUse() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage, quota: e.quota }; } catch { return null; }
}

// ------------------------------------------------------------------ location

/** Current position. The only place geolocation is called in the app. */
export function whereAmI() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { reject(new Error('This device cannot tell where it is. Pick the spot on the map instead.')); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      e => reject(new Error(e.code === 1 ? 'Location is switched off for this app. Allow it in settings, or pick the spot on the map.'
        : e.code === 3 ? 'Finding your position took too long. Try again outdoors, or pick the spot on the map.'
          : 'Could not get your position. Pick the spot on the map instead.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

// ------------------------------------------------------------------ names

const NAMED = new Set(['natural', 'leisure', 'tourism', 'boundary', 'amenity', 'historic', 'waterway', 'water', 'landuse', 'man_made', 'aeroway']);

/**
 * A short human name from a Nominatim reverse-geocode answer (jsonv2): a named
 * feature (peak, park, lake, trailhead...) first, then road and town, then the
 * town, county or state. -> {name, feature} or null. feature is the OSM
 * category of a named feature ('natural' for a peak), else null.
 */
export function nameFromReverse(j) {
  if (!j || j.error) return null;
  const a = j.address || {};
  const town = a.village || a.hamlet || a.town || a.city || a.suburb || a.municipality || a.neighbourhood || null;
  const area = a.county || a.state || a.country || null;
  const feat = j.name && NAMED.has(j.category) && j.name !== town ? j.name : null;
  if (feat) return { name: town && !feat.includes(town) ? `${feat}, ${town}` : feat, feature: j.category };
  if (a.road && town) return { name: `${a.road}, ${town}`, feature: null };
  if (a.road) return { name: area ? `${a.road}, ${area}` : a.road, feature: null };
  const n = town || area;
  return n ? { name: n, feature: null } : null;
}

/** Best available name for a spot from OpenStreetMap (Nominatim reverse). Null on any failure. */
export async function nameFor(lat, lon, { zoom = 17, timeoutMs = 4000 } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=${zoom}&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, { signal: ctl.signal });
    if (!r.ok) return null;
    return nameFromReverse(await r.json());
  } catch { return null; } finally { clearTimeout(timer); }
}
