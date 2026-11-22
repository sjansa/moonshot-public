// lidar.js -- 1 m bare-earth terrain close to the viewer, from USGS 3DEP (The National Map),
// where it exists. The service mosaics the best data it has (1 m lidar over most of the US,
// coarser elsewhere, resampled to the grid asked for). No key; it answers browsers (CORS).
// Sent as LERC at half our storage step (12.5 cm): about five times smaller than raw floats.
// Trial: used for places only, within NEAR_M of the viewer.
import { Grid } from '../core/terrain.js?v=1122.0212-79fa2c9';
import { DEM_UNIT } from '../core/build.js?v=1122.0212-79fa2c9';
import { decodeLerc1 } from '../core/lerc1.js';

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
  // The service only makes pixels square in the image SR (degrees here); asked for anything
  // else it quietly widens the extent. So: square in degrees, NEAR_RES north-south (about
  // 0.76 m east-west at 40 degrees), and as many columns as that takes.
  const rows = Math.round(2 * NEAR_M / NEAR_RES) + 1, step = 2 * (NEAR_M / 110540) / (rows - 1);
  const cols = Math.round(2 * (NEAR_M / (111320 * Math.cos(lat * Math.PI / 180))) / step) + 1;
  const dLat = step * (rows - 1) / 2, dLon = step * (cols - 1) / 2, h = step / 2;   // h: pixel centres on the edges
  const meta = { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat, cols, rows };
  const q = new URLSearchParams({
    bbox: [meta.west - h, meta.south - h, meta.east + h, meta.north + h].join(','), bboxSR: 4326, imageSR: 4326,
    size: `${cols},${rows}`, format: 'lerc', compressionTolerance: DEM_UNIT / 2, pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  const res = await fetch(`${URL3DEP}?${q}`, { signal });
  if (!res.ok) throw new Error('The 1 m terrain service did not answer.');
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 10 || String.fromCharCode(...new Uint8Array(buf, 0, 9)) !== 'CntZImage') throw new Error('The 1 m terrain service did not answer.');
  const t = decodeLerc1(buf);
  if (t.width !== cols || t.height !== rows) throw new Error('The 1 m terrain came back the wrong size.');
  const data = new Uint16Array(cols * rows);
  let holes = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let z = t.data[r * cols + c];
    if (!(z > -500 && z < 9000)) {
      holes++;
      z = fallback ? fallback.sample(meta.west + c * step, meta.north - r * step) : NaN;
      if (!(z === z)) return null;
    }
    data[r * cols + c] = Math.max(0, Math.round(z / DEM_UNIT));
  }
  if (holes > 0.2 * cols * rows) return null;
  return new Grid(meta, data, DEM_UNIT);
}
