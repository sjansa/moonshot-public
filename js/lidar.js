// lidar.js -- 1 m bare-earth terrain close to the viewer, from USGS 3DEP (The National Map),
// where it exists. The service mosaics the best data it has (1 m lidar over most of the US,
// coarser elsewhere, resampled to the grid asked for). No key; it answers browsers (CORS).
// Trial: used for places only, within NEAR_M of the viewer.
import { Grid } from '../core/terrain.js?v=1119.0458-060f738';
import { DEM_UNIT } from '../core/build.js?v=1119.0458-060f738';
import { readFloatTiff } from './tiff.js?v=1119.0458-060f738';

const URL3DEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
export const NEAR_M = 500, NEAR_RES = 1;      // half side of the square (m), grid step (m)
export const ATTRIBUTION = 'Near terrain: USGS 3D Elevation Program.';

/** Rough check that a spot is in the US data (lower 48, Alaska, Hawaii, Puerto Rico). */
export function in3dep(lat, lon) {
  return (lat > 24 && lat < 50 && lon > -125.5 && lon < -66) || (lat > 51 && lat < 72 && (lon < -129 || lon > 172))
    || (lat > 18.5 && lat < 22.5 && lon > -161 && lon < -154) || (lat > 17.5 && lat < 18.7 && lon > -68 && lon < -65);
}

/**
 * 1 m grid around (lat, lon), as a Grid in the place pack's format. Holes in the data are
 * filled from fallback (a Grid), or the whole grid is dropped (null) if there are many.
 */
export async function fetchNear(lat, lon, fallback, signal) {
  const dLat = NEAR_M / 110540, dLon = NEAR_M / (111320 * Math.cos(lat * Math.PI / 180));
  const n = Math.round(2 * NEAR_M / NEAR_RES) + 1;
  // pixel centres on the bbox edges: widen by half a pixel so cols/rows land on west..east
  const hx = dLon / (n - 1) / 2, hy = dLat / (n - 1) / 2;
  const meta = { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat, cols: n, rows: n };
  const q = new URLSearchParams({
    bbox: [meta.west - hx, meta.south - hy, meta.east + hx, meta.north + hy].join(','), bboxSR: 4326, imageSR: 4326,
    size: `${n},${n}`, format: 'tiff', pixelType: 'F32', compression: 'None', interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  const res = await fetch(`${URL3DEP}?${q}`, { signal });
  if (!res.ok || !/tiff/.test(res.headers.get('content-type') || '')) throw new Error('The 1 m terrain service did not answer.');
  const t = readFloatTiff(await res.arrayBuffer());
  if (t.width !== n || t.height !== n) throw new Error('The 1 m terrain came back the wrong size.');
  const data = new Uint16Array(n * n);
  let holes = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    let z = t.data[r * n + c];
    if (!(z > -500 && z < 9000)) {
      holes++;
      z = fallback ? fallback.sample(meta.west + c * (meta.east - meta.west) / (n - 1), meta.north - r * (meta.north - meta.south) / (n - 1)) : NaN;
      if (!(z === z)) return null;
    }
    data[r * n + c] = Math.max(0, Math.round(z / DEM_UNIT));
  }
  if (holes > 0.2 * n * n) return null;
  return new Grid(meta, data, DEM_UNIT);
}
