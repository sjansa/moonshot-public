// shadow.js -- terrain shadows cast by the sun or the moon over an elevation grid. No DOM.
//
// Grids are the web-mercator pixel grids of elev.js / solver.js ({nx, ny, data, x0, y0, z}).
// One sweep per grid, in the direction the light travels: every cell takes the light ray
// arriving from its upstream neighbour (interpolated), lowered by one step times
// tan(altitude), and raises it to its own ground if the ground is higher. A cell is in
// shadow when the ray arriving at it passes above its ground.
//
// - Altitude is sampled per cell (bilinear on a small lattice), so the sun sitting lower
//   farther from it carries the earth's curvature as well (parallel rays over a sphere).
// - Each ray keeps the distance back to the ground that last topped it, so the depth of
//   the shadow is an angle: the sun's disc is cut by that horizon and the edge is soft
//   (penumbra) instead of a hard step.
// - Nested grids: a coarse, wide grid first, then finer ones inside it. A finer grid takes
//   the rays crossing its upstream edges from the next coarser one, so a ridge 30 km away
//   still shades a 250 m view drawn from 4 m terrain.
import { D2R, R_EARTH } from '../core/terrain.js?v=1122.0212-79fa2c9';
import { pxToLonLat } from './solver.js?v=1122.0212-79fa2c9';

const EQUATOR_M = 40075016.686;
export const NONE = -1e9;                 // ray height for "no ray": nothing upstream blocks the light

/** Visible fraction of a disc whose centre is m radii above a straight horizon. */
export function discFraction(m) {
  if (m >= 1) return 1;
  if (m <= -1) return 0;
  return (Math.acos(-m) + m * Math.sqrt(1 - m * m)) / Math.PI;
}

/**
 * Altitude of the light over a box: a lattice in world pixels at zoom 0 that
 * castShadows() samples per cell. altFn(lat, lon) -> radians.
 * bbox [w, s, e, n]; n x n points (corners included).
 */
export function altLattice(bbox, altFn, n = 6) {
  const [w, s, e, nn] = bbox, alt = new Float64Array(n * n), tan = new Float64Array(n * n);
  const toX = lon => (lon + 180) / 360 * 256;
  const toY = lat => { const r = Math.max(-85.0511, Math.min(85.0511, lat)) * D2R; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256; };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const lon = w + (e - w) * i / (n - 1), lat = nn + (s - nn) * j / (n - 1);
    const a = altFn(lat, lon);
    alt[j * n + i] = a; tan[j * n + i] = Math.tan(Math.max(-1.5, Math.min(1.5, a)));
  }
  return { n, alt, tan, X0: toX(w), X1: toX(e), Y0: toY(nn), Y1: toY(s) };
}

/**
 * Darkness (0..1 opacity of the shade colour) of ground the sun does not reach, by the sun's
 * geometric altitude in degrees: skylight in the day and through civil twilight, then a step
 * darker at the end of civil (-6), nautical (-12) and astronomical (-18) twilight. Each step is
 * eased over a degree so the bands read as bands without a hard line.
 */
export const TWILIGHT = [[-6, 0.64], [-12, 0.76], [-18, 0.86]], DAY_SHADE = 0.5;
export function skyShade(altDeg) {
  let a = DAY_SHADE, prev = DAY_SHADE;
  for (const [t, v] of TWILIGHT) {
    const u = Math.max(0, Math.min(1, (t + 0.5 - altDeg)));
    a += (v - prev) * u * u * (3 - 2 * u); prev = v;
  }
  return a;
}

/** Value of a lattice array (lattice.alt, lattice.tan, ...) at world pixel (X, Y) at zoom 0. */
export function latticeAt(L, arr, X, Y) { return lat2(L, arr, X, Y); }

// bilinear lattice lookup at world pixel (X, Y), clamped to the lattice
function lat2(L, arr, X, Y) {
  const n = L.n;
  let u = (X - L.X0) / (L.X1 - L.X0) * (n - 1), v = (Y - L.Y0) / (L.Y1 - L.Y0) * (n - 1);
  u = u < 0 ? 0 : u > n - 1 ? n - 1 : u; v = v < 0 ? 0 : v > n - 1 ? n - 1 : v;
  const i = Math.min(n - 2, u | 0), j = Math.min(n - 2, v | 0), fu = u - i, fv = v - j, k = j * n + i;
  return (arr[k] * (1 - fu) + arr[k + 1] * fu) * (1 - fv) + (arr[k + n] * (1 - fu) + arr[k + n + 1] * fu) * fv;
}

/**
 * Light rays over one grid.
 * opts: az (radians, toward the body), lattice (altLattice), radius (body's angular radius),
 *       outer: the result of castShadows on a coarser grid that holds this one (optional).
 * -> {grid, inc (ray height arriving at each cell, m; NONE = no ray), dist (m back to the
 *     ground that set that ray), lit (0..1, visible fraction of the disc)}
 */
export function castShadows(g, { az, lattice, radius = 0.0046, outer = null }) {
  const { nx, ny, data, x0, y0, z } = g, N = nx * ny, scale = 2 ** z;
  const R = new Float32Array(N), D = new Float32Array(N), inc = new Float32Array(N), dist = new Float32Array(N), lit = new Float32Array(N);
  // the light travels away from the body; grid axes are x east, y south
  const ux = -Math.sin(az), uy = Math.cos(az);
  const xMajor = Math.abs(ux) >= Math.abs(uy);
  const na = xMajor ? nx : ny, nb = xMajor ? ny : nx;
  const ua = xMajor ? ux : uy, ub = xMajor ? uy : ux;
  const sa = ua >= 0 ? 1 : -1, m = ub / Math.abs(ua), stepK = Math.hypot(1, m);
  const mpp = new Float32Array(ny);
  for (let j = 0; j < ny; j++) mpp[j] = EQUATOR_M * Math.cos(pxToLonLat(0, y0 + j + 0.5, z).lat * D2R) / (256 * scale);
  const k2o = outer ? 2 ** (outer.grid.z - z) : 0;

  // the ray entering at a cell on an upstream edge: from the coarser grid, or the sea-level horizon
  const edge = (i, j, alt, out) => {
    if (outer) {
      const o = outer.grid, u = (x0 + i + 0.5) * k2o - o.x0 - 0.5, v = (y0 + j + 0.5) * k2o - o.y0 - 0.5;
      if (u >= 0 && v >= 0 && u <= o.nx - 1 && v <= o.ny - 1) {
        const a = Math.min(o.nx - 2, u | 0), b = Math.min(o.ny - 2, v | 0), fu = u - a, fv = v - b, k = b * o.nx + a;
        const I = outer.inc, c = [k, k + 1, k + o.nx, k + o.nx + 1], w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
        let sum = 0, sw = 0, best = -1, bw = -1;
        for (let q = 0; q < 4; q++) {
          if (I[c[q]] <= NONE / 2) continue;
          sum += I[c[q]] * w[q]; sw += w[q];
          if (w[q] > bw) { bw = w[q]; best = c[q]; }
        }
        if (sw > 0.25) { out[0] = sum / sw; out[1] = outer.dist[best]; return; }
        out[0] = NONE; out[1] = 0; return;
      }
    }
    // below the astronomical horizon a point sees the body only from above R a^2 / 2
    if (alt < 0) { out[0] = R_EARTH * alt * alt / 2; out[1] = R_EARTH * -alt; } else { out[0] = NONE; out[1] = 0; }
  };

  const tmp = [0, 0];
  for (let k = 0; k < na; k++) {
    const a = sa > 0 ? k : na - 1 - k, ap = a - sa;
    for (let b = 0; b < nb; b++) {
      const i = xMajor ? a : b, j = xMajor ? b : a, c = j * nx + i;
      const X = (x0 + i + 0.5) / scale, Y = (y0 + j + 0.5) / scale;
      const zc = data[c];
      let r, d;
      const bs = b - m;
      if (k > 0 && bs >= 0 && bs <= nb - 1) {
        const b0 = nb < 2 ? 0 : Math.min(Math.floor(bs), nb - 2), f = bs - b0;
        const c0 = xMajor ? b0 * nx + ap : ap * nx + b0, c1 = nb < 2 ? c0 : (xMajor ? c0 + nx : c0 + 1);
        const r0 = R[c0], r1 = R[c1];
        if (r0 <= NONE / 2 && r1 <= NONE / 2) { r = NONE; d = 0; }
        else if (r0 <= NONE / 2) { r = r1; d = D[c1]; }
        else if (r1 <= NONE / 2) { r = r0; d = D[c0]; }
        else { r = r0 * (1 - f) + r1 * f; d = r0 >= r1 ? D[c0] : D[c1]; }
        if (r > NONE / 2) {
          const s = mpp[j] * stepK;
          r -= s * lat2(lattice, lattice.tan, X, Y); d += s;
        }
      } else {
        edge(i, j, lat2(lattice, lattice.alt, X, Y), tmp); r = tmp[0]; d = tmp[1];
      }
      inc[c] = r; dist[c] = d;
      if (!(zc > -1000)) { lit[c] = 1; R[c] = r; D[c] = d; continue; }   // no terrain (or a hole in the tiles): let the ray through
      // how far (as an angle) the ray clears or misses the ground, in units of the disc's radius
      const marg = r <= NONE / 2 ? 1e9 : (zc - r) / Math.max(1, d);
      lit[c] = discFraction(Math.atan(marg) / radius);
      if (zc >= r) { R[c] = zc; D[c] = 0; } else { R[c] = r; D[c] = d; }
    }
  }
  return { grid: g, inc, dist, lit };
}

/** Run castShadows over nested grids, coarsest first. -> result for the last (finest) grid. */
export function castNested(grids, opts) {
  let outer = null;
  for (const g of grids) outer = castShadows(g, { ...opts, outer });
  return outer;
}
