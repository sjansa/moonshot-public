// skyart.js -- pictures for the sky: the Milky Way panorama, the moon and the sun.
// Images are NASA material (see app/img/CREDITS.md). Each is used once it has loaded;
// until then, and if loading fails, draw.js falls back to its plain shapes.
import { TAU } from '../core/terrain.js?v=1117.2337-166b81d';

const img = {};
let onReady = () => {};
/** Start loading; `ready` is called each time one picture becomes usable. */
export function loadSkyArt(ready) {
  onReady = ready || onReady;
  if (typeof Image === 'undefined' || img.started) return;
  img.started = true;
  for (const name of ['milkyway', 'moon', 'sun']) {
    const im = new Image();
    im.onload = () => { img[name] = im; if (name === 'milkyway') prepareMw(im); onReady(); };
    im.src = new URL(`./img/${name}.jpg`, document.baseURI).href;
  }
}
export const art = name => img[name] || null;

// ---- Milky Way: an all-sky panorama in galactic coordinates (l = 0 in the middle, l grows to the left) ----
let mwLevels = null;          // [{w, h, data}] full size and two smaller copies, against shimmer when zoomed out
function prepareMw(im) {
  try {
    mwLevels = [1, 2, 4].map(div => {
      const c = document.createElement('canvas'); c.width = im.naturalWidth / div; c.height = im.naturalHeight / div;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
    });
  } catch { mwLevels = null; }
}
export const milkyWayReady = () => !!mwLevels;

let mwCanvas = null, mwKey = '';
/**
 * The panorama as seen through `cam`, as a small canvas to be stretched over the screen
 * (sw x sh device pixels). basis = galactic axes as ENU directions (astro.milkyWayAt).
 * The result is kept until `key` changes, so the second (dimmed) pass costs nothing.
 */
export function milkyWayLayer(cam, sw, sh, basis, key) {
  if (!mwLevels) return null;
  if (mwCanvas && key === mwKey) return mwCanvas;
  const bw = Math.min(160, Math.max(64, Math.round(sw / 8))), bh = Math.max(1, Math.round(bw * sh / sw));
  if (!mwCanvas) mwCanvas = document.createElement('canvas');
  if (mwCanvas.width !== bw || mwCanvas.height !== bh) { mwCanvas.width = bw; mwCanvas.height = bh; }
  const g = mwCanvas.getContext('2d'), out = g.createImageData(bw, bh), o = out.data, d = [0, 0, 0];
  const radPerPx = (sw / bw) / (cam.fn * sw);                    // angle one buffer pixel covers, near the center
  const texel = TAU / mwLevels[0].w;                              // radians per pixel of the full picture
  const lv = mwLevels[radPerPx > 3 * texel ? 2 : radPerPx > 1.5 * texel ? 1 : 0], tw = lv.w, th = lv.h, td = lv.data;
  const [gx, gy, gz] = basis, sx = sw / bw, sy = sh / bh;
  for (let j = 0, k = 0; j < bh; j++) for (let i = 0; i < bw; i++, k += 4) {
    cam.unproject((i + 0.5) * sx, (j + 0.5) * sy, sw, sh, d);
    const n = 1 / Math.hypot(d[0], d[1], d[2]), e = d[0] * n, nn = d[1] * n, u = d[2] * n;
    const x = e * gx[0] + nn * gx[1] + u * gx[2], y = e * gy[0] + nn * gy[1] + u * gy[2], z = e * gz[0] + nn * gz[1] + u * gz[2];
    // bilinear, wrapping in longitude
    const fu = (0.5 - Math.atan2(y, x) / TAU) * tw - 0.5, fv = Math.min(th - 1.001, Math.max(0, (0.5 - Math.asin(z < -1 ? -1 : z > 1 ? 1 : z) / Math.PI) * th - 0.5));
    const u0 = Math.floor(fu), v0 = fv | 0, a = fu - u0, b = fv - v0;
    const c0 = ((u0 % tw) + tw) % tw, c1 = (c0 + 1) % tw, r0 = v0 * tw, r1 = r0 + tw;
    const p00 = 4 * (r0 + c0), p01 = 4 * (r0 + c1), p10 = 4 * (r1 + c0), p11 = 4 * (r1 + c1);
    const w00 = (1 - a) * (1 - b), w01 = a * (1 - b), w10 = (1 - a) * b, w11 = a * b;
    o[k] = td[p00] * w00 + td[p01] * w01 + td[p10] * w10 + td[p11] * w11;
    o[k + 1] = td[p00 + 1] * w00 + td[p01 + 1] * w01 + td[p10 + 1] * w10 + td[p11 + 1] * w11;
    o[k + 2] = td[p00 + 2] * w00 + td[p01 + 2] * w01 + td[p10 + 2] * w10 + td[p11 + 2] * w11;
    o[k + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  mwKey = key;
  return mwCanvas;
}

/** Angle to turn a north-up picture by so that its north points along (dx, dy) on the screen. */
export const northTurn = (dx, dy) => Math.atan2(dy, dx) + Math.PI / 2;
