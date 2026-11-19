// demo.js -- deterministic synthetic terrain for tests and ?demo. No DOM.
import { Grid, Terrain } from '../core/terrain.js?v=1118.1811-86b42d8';

export const DEMO = { lat: 40.58, lon: -111.83, name: 'Demo ridge' };

const BASE = 1400;
const g = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));

/** Elevation in meters at e meters east, n meters north of the demo spot. */
function elevation(e, n) {
  // eastern ridge: crest wanders a little, summits along it, one notch
  const crestE = 15000 + 700 * Math.sin(n / 2600) + 300 * Math.sin(n / 900 + 1);
  let H = 1000 + 900 * g(n, 0, 2500) + 700 * g(n, -5500, 2000) + 800 * g(n, 5500, 2200)
    + 600 * g(n, 11000, 2600) + 500 * g(n, -12000, 3000) + 350 * g(n, -20000, 4000)
    + 450 * g(n, 20000, 4500);
  H -= 650 * g(n, 2800, 450);                       // the notch
  H += 80 * Math.sin(n / 400) * Math.sin(n / 1100 + 2);
  const flank = e < crestE ? 3200 : 2200;           // gentler western side
  let z = BASE + H * g(e, crestE, flank);
  // lower hills to the west, rolling and gentle
  const west = Math.max(0, -e) / 1000;
  z += 120 * Math.min(1, west / 10) * (1 + 0.5 * Math.sin(n / 3000 + e / 4000)) * (0.5 + 0.5 * Math.sin(e / 3500));
  // ripple everywhere
  z += 25 * Math.sin(e / 700) * Math.sin(n / 900);
  return z;
}

function makeGrid(halfM, stepM) {
  const { lat, lon } = DEMO;
  const cosl = Math.cos(lat * Math.PI / 180);
  const dLat = halfM / 110540, dLon = halfM / (111320 * cosl);
  const cols = Math.round(2 * halfM / stepM) + 1, rows = cols;
  const meta = { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat, cols, rows };
  const data = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const n = (halfM - r * stepM);
    for (let c = 0; c < cols; c++) {
      const e = -halfM + c * stepM;
      data[r * cols + c] = Math.round(elevation(e, n) / 0.25);
    }
  }
  return new Grid(meta, data, 0.25);
}

/** Fine 6 km square at 20 m, coarse 100 km square at 200 m, centered on DEMO. */
export function demoTerrain() {
  return new Terrain(makeGrid(3000, 20), makeGrid(50000, 200));
}
