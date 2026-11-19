// elev.js -- elevation grids from AWS Terrarium tiles (browser). See solver.js for the grid shape.
import { lonLatToPx } from './solver.js?v=1119.0458-060f738';

const URL_T = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const CACHE_MAX = 64, cache = new Map();   // key -> Float32Array(65536), insertion-ordered (oldest first)
let canvas = null;

async function decode(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  if (!canvas) canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  cx.clearRect(0, 0, 256, 256); cx.drawImage(bmp, 0, 0, 256, 256); bmp.close?.();
  const px = cx.getImageData(0, 0, 256, 256).data, out = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) out[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
  return out;
}

async function tile(z, x, y, signal) {
  const key = `${z}/${x}/${y}`, hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const r = await fetch(URL_T.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal });
  if (!r.ok) throw new Error('status ' + r.status);
  const d = await decode(await r.blob());
  cache.set(key, d);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return d;
}

/** bbox [w, s, e, n] -> {nx, ny, data (m, row 0 north), x0, y0, z}, whole tiles, zoom <= maxZoom with <= maxTiles tiles. */
export const MAX_ZOOM = 15;               // the finest Terrarium tiles (about 3 to 5 m)

/** The tiles fetchElevGrid would use for bbox: {z, tx0, tx1, ty0, ty1}. */
export function gridTiles([w, s, e, n], { maxTiles = 16, maxZoom = 12 } = {}) {
  let z = Math.min(maxZoom, MAX_ZOOM), tx0, tx1, ty0, ty1;
  for (; z >= 0; z--) {
    const a = lonLatToPx(w, n, z), b = lonLatToPx(e, s, z), top = 2 ** z - 1;
    tx0 = Math.max(0, Math.floor(a.x / 256)); tx1 = Math.min(top, Math.floor(b.x / 256));
    ty0 = Math.max(0, Math.floor(a.y / 256)); ty1 = Math.min(top, Math.floor(b.y / 256));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles) break;
  }
  return { z: Math.max(z, 0), tx0, tx1, ty0, ty1 };
}

export async function fetchElevGrid(bbox, { maxTiles = 16, maxZoom = 12, signal } = {}) {
  const { z, tx0, tx1, ty0, ty1 } = gridTiles(bbox, { maxTiles, maxZoom });
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1, nx = cols * 256, ny = rows * 256;
  const data = new Float32Array(nx * ny), jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(tile(z, tx, ty, signal).then(d => {
      for (let r = 0; r < 256; r++) data.set(d.subarray(r * 256, r * 256 + 256), ((ty - ty0) * 256 + r) * nx + (tx - tx0) * 256);
    }));
  }
  try { await Promise.all(jobs); } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('The terrain data could not be loaded. Check the connection and try again.');
  }
  return { nx, ny, data, x0: tx0 * 256, y0: ty0 * 256, z };
}
