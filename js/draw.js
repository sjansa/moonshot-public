// draw.js -- everything painted on the canvas (PLAN 7.2, 7.3). All sizes are device pixels.
import { skyTAt } from './horizon.js?v=1115.1805-901b992';
import { screenCamera } from './view.js?v=1115.1805-901b992';
import { TAU, D2R } from '../core/terrain.js?v=1115.1805-901b992';

const clamp01 = x => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;

// sky colors per sun band, top / bottom (7.3), ordered day -> night
const SKY = [['#3f7fc4', '#a9cdea'], ['#35507c', '#f0a860'], ['#1c2f55', '#6a6f9a'],
  ['#101d38', '#2b3558'], ['#0a1226', '#141c33'], ['#05080f', '#0a101c']].map(p => p.map(hex));
const EDGES = [6, -4, -6, -12, -18];               // sun altitude where the band changes
function hex(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const mix = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));

/** Sky gradient colors [top, bottom] for a sun altitude, blended across 2 degrees at each edge. */
export function skyColors(sunAltDeg) {
  let x = 0;
  for (const e of EDGES) x += clamp01((e - sunAltDeg) / 2 + 0.5);
  const i = Math.min(4, Math.floor(x)), f = x - i;
  return [0, 1].map(k => mix(SKY[i][k], SKY[i + 1][k], f));
}

// soft round sprite for the Milky Way, built once
let sprite = null;
function getSprite() {
  if (sprite) return sprite;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (let i = 0; i <= 10; i++) { const t = i / 10; gr.addColorStop(t, `rgba(215,225,255,${Math.exp(-2 * t * t) * (1 - t ** 4)})`); }   // gaussian: no lattice where sprites overlap
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return (sprite = c);
}

const ridgeDirs = new WeakMap();             // ridge -> Float32Array of ENU dirs, built once
function dirsOf(h, r) {
  let d = ridgeDirs.get(r);
  if (!d) {
    d = new Float32Array(r.cols.length * 3);
    for (let i = 0; i < r.cols.length; i++) {
      const az = r.cols[i] * TAU / h.na, t = r.t[i], k = 1 / Math.hypot(1, t);
      d[3 * i] = Math.sin(az) * k; d[3 * i + 1] = Math.cos(az) * k; d[3 * i + 2] = t * k;
    }
    ridgeDirs.set(r, d);
  }
  return d;
}

/** Terrain edge by per-column bisection (7.2). -> {skyY: Float32Array, xs, path, line} */
function terrainEdge(S, cam, sw, sh) {
  const h = S.horizon, n = Math.ceil(sw / 2) + 1, xs = new Float32Array(n), skyY = new Float32Array(n);
  const out = [0, 0, 0];
  const g = (x, y) => {
    cam.unproject(x, y, sw, sh, out);
    return out[2] / Math.hypot(out[0], out[1]) - skyTAt(h, Math.atan2(out[0], out[1]));
  };
  const path = new Path2D(), line = new Path2D();
  path.moveTo(0, sh);
  let pen = false;
  for (let i = 0; i < n; i++) {
    const x = Math.min(sw, i * 2); xs[i] = x;
    let y;
    if (g(x, 0) <= 0) y = 0;
    else if (g(x, sh) > 0) y = sh;
    else {
      let lo = 0, hi = sh;
      for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (g(x, m) > 0) lo = m; else hi = m; }
      y = (lo + hi) / 2;
    }
    skyY[i] = y;
    path.lineTo(x, y);
    if (y > 0 && y < sh) { if (pen) line.lineTo(x, y); else { line.moveTo(x, y); pen = true; } } else pen = false;
  }
  path.lineTo(sw, sh); path.closePath();
  return { skyY, xs, path, line };
}

// Sky objects: one function, called twice (full strength, then dim through the terrain).
function drawSky(ctx, S, cam, sw, sh, k, alpha) {
  const { show, sm, mwNow, paths } = S, P = [0, 0], P2 = [0, 0];
  const pxPer = ang => Math.tan(ang) * cam.fn * sw;        // length on the sky -> pixels
  const near = (x, y, m) => x > -m && x < sw + m && y > -m && y < sh + m;
  const sunAlt = sm.sun.alt / D2R;
  ctx.save();
  ctx.globalAlpha = alpha;

  if (show.milkyWay && mwNow) {
    const dark = clamp01((-6 - sunAlt) / 12);
    if (dark > 0) {
      const r = pxPer(3.5 * D2R), sp = getSprite(), d = mwNow.dirs, pts = S.mw.points;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < pts.length; i++) {
        if (!cam.project(d[3 * i], d[3 * i + 1], d[3 * i + 2], sw, sh, P) || !near(P[0], P[1], r)) continue;
        ctx.globalAlpha = alpha * 0.10 * pts[i].w * dark;
        ctx.drawImage(sp, P[0] - r, P[1] - r, 2 * r, 2 * r);
      }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = alpha;
      if (mwNow.core && cam.project(...mwNow.core, sw, sh, P)) {
        ctx.strokeStyle = `rgba(215,225,255,${0.8 * Math.max(dark, 0.25)})`; ctx.lineWidth = 1.5 * k;
        ctx.beginPath(); ctx.arc(P[0], P[1], 10 * k, 0, TAU); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle; ctx.font = `500 ${12 * k}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('Galactic core', P[0] + 15 * k, P[1]);
      }
    }
  }

  if (show.paths && paths) {
    for (const [pts, color] of [[paths.sun, '#ffd76a'], [paths.moon, '#cfe0ff']]) {
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.2 * k;
      ctx.globalAlpha = alpha * 0.7;
      ctx.beginPath();
      let pen = false, px = 0, py = 0;
      for (const p of pts) {
        if (!cam.project(p.dir[0], p.dir[1], p.dir[2], sw, sh, P) || (pen && Math.hypot(P[0] - px, P[1] - py) > sw)) { pen = false; continue; }
        if (pen) ctx.lineTo(P[0], P[1]); else { ctx.moveTo(P[0], P[1]); pen = true; }
        px = P[0]; py = P[1];
      }
      ctx.stroke();
      ctx.font = `500 ${11 * k}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      for (const p of pts) {
        if (p.date.getMinutes() !== 0 || !cam.project(p.dir[0], p.dir[1], p.dir[2], sw, sh, P) || !near(P[0], P[1], 0)) continue;
        ctx.beginPath(); ctx.arc(P[0], P[1], 2.6 * k, 0, TAU); ctx.fill();
        ctx.fillText(String(p.date.getHours()).padStart(2, '0'), P[0], P[1] - 5 * k);
      }
    }
    ctx.globalAlpha = alpha;
  }

  // a ring and a name keep a tiny disc findable; the disc itself stays true size
  const marker = (b, name, r) => {
    if (r >= 5 * k) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.2 * k;
    ctx.beginPath(); ctx.arc(b[0], b[1], 11 * k, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = `600 ${12 * k}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(name, b[0] + 16 * k, b[1]);
  };

  const sun = sm.sun;
  if (show.sun && cam.project(sun.dir[0], sun.dir[1], sun.dir[2], sw, sh, P)) {
    const r = pxPer(sun.radius), gr = Math.max(r * 4, 14 * k);
    const g = ctx.createRadialGradient(P[0], P[1], r * 0.8, P[0], P[1], gr);
    g.addColorStop(0, 'rgba(255,215,106,0.55)'); g.addColorStop(1, 'rgba(255,215,106,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(P[0], P[1], gr, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffd76a'; ctx.beginPath(); ctx.arc(P[0], P[1], Math.max(r, 0.8 * k), 0, TAU); ctx.fill();
    marker(P, 'Sun', r);
  }

  const moon = sm.moon;
  if (show.moon && cam.project(moon.dir[0], moon.dir[1], moon.dir[2], sw, sh, P)) {
    const r = pxPer(moon.radius), md = moon.dir, sd = sun.dir;
    const dot = sd[0] * md[0] + sd[1] * md[1] + sd[2] * md[2];
    let T = [sd[0] - dot * md[0], sd[1] - dot * md[1], sd[2] - dot * md[2]];
    const tl = Math.hypot(...T) || 1;
    const q = [md[0] + 0.01 * T[0] / tl, md[1] + 0.01 * T[1] / tl, md[2] + 0.01 * T[2] / tl];
    const ql = Math.hypot(...q);
    const theta = cam.project(q[0] / ql, q[1] / ql, q[2] / ql, sw, sh, P2) ? Math.atan2(P2[1] - P[1], P2[0] - P[0]) : 0;
    const rr = Math.max(r, 0.8 * k);
    ctx.save();
    ctx.translate(P[0], P[1]); ctx.rotate(theta);
    ctx.fillStyle = '#2a2f36'; ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f4f1e6'; ctx.beginPath();
    ctx.arc(0, 0, rr, -Math.PI / 2, Math.PI / 2);
    ctx.ellipse(0, 0, rr * Math.abs(Math.cos(moon.phaseAngle)), rr, 0, Math.PI / 2, -Math.PI / 2, moon.phaseAngle > Math.PI / 2);
    ctx.fill();
    ctx.restore();
    marker(P, 'Moon', r);
  }
  ctx.restore();
}

function drawScales(ctx, S, cam, sw, sh, k, edge) {
  const v = S.view, P = [0, 0];
  const top = (S.ui?.top ?? 56) * k;
  const pxDeg = sw / v.hfovDeg;                           // rough, for choosing the tick step
  const step = [1, 5, 10, 30].find(s => s * pxDeg >= 40 * k) ?? 30;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2 * k;
  ctx.font = `500 ${11 * k}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let a = 0; a < 360; a += step) {
    const d = [Math.sin(a * D2R), Math.cos(a * D2R)].map(x => x * Math.cos(v.altDeg * D2R));
    if (!cam.project(d[0], d[1], Math.sin(v.altDeg * D2R), sw, sh, P) || P[0] < 0 || P[0] > sw) continue;
    const major = a % 90 === 0;
    ctx.beginPath(); ctx.moveTo(P[0], top); ctx.lineTo(P[0], top + (major ? 10 : 6) * k); ctx.stroke();
    ctx.font = `${major ? 700 : 500} ${(major ? 13 : 11) * k}px sans-serif`;
    ctx.fillText(names[a] ?? `${a}°`, P[0], top + 12 * k);
  }
  // level line at 0 degrees altitude, only where it is in the sky
  const clip = new Path2D(); clip.rect(0, 0, sw, sh); clip.addPath(edge.path);
  ctx.clip(clip, 'evenodd');
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1 * k; ctx.setLineDash([6 * k, 6 * k]);
  ctx.beginPath();
  let pen = false;
  for (let a = 0; a <= 720; a++) {
    const az = a * 0.5 * D2R;
    if (cam.project(Math.sin(az), Math.cos(az), 0, sw, sh, P)) { if (pen) ctx.lineTo(P[0], P[1]); else { ctx.moveTo(P[0], P[1]); pen = true; } }
    else pen = false;
  }
  ctx.stroke();
  ctx.restore();
}

/** Paint the whole picture. W, H in device pixels; k = device pixel ratio. */
export function draw(ctx, S, W, H, k = 1) {
  const cam = S.cam = screenCamera(S.view);
  const sunAlt = S.sm.sun.alt / D2R;
  const [top, bot] = skyColors(sunAlt);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  // 1 sky
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgb(top)); g.addColorStop(1, rgb(bot));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // 2 sky objects at full strength
  drawSky(ctx, S, cam, W, H, k, 1);

  // 3 terrain, lifted toward the sky color by day
  const edge = terrainEdge(S, cam, W, H);
  ctx.fillStyle = rgb(mix([11, 20, 24], bot, 0.35 * clamp01((sunAlt + 4) / 10)));
  ctx.fill(edge.path);

  // 4 the same objects again, dimmed and blue-washed, only where terrain covers them
  ctx.save();
  ctx.clip(edge.path);
  drawSky(ctx, S, cam, W, H, k, 0.38);
  ctx.fillStyle = 'rgba(70,110,150,0.18)'; ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // 5 interior ridges, then the skyline over everything
  if (S.show.ridges) {
    const P = [0, 0], h = S.horizon;
    for (const r of S.horizon.ridges) {
      const kd = Math.max(0.25, Math.min(1, 2500 / r.d[r.d.length >> 1]));
      ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.4 * kd})`; ctx.lineWidth = (0.8 + 0.9 * kd) * k;
      const d = dirsOf(h, r);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < r.cols.length; i++) {
        if (cam.project(d[3 * i], d[3 * i + 1], d[3 * i + 2], W, H, P)) { if (pen) ctx.lineTo(P[0], P[1]); else { ctx.moveTo(P[0], P[1]); pen = true; } }
        else pen = false;
      }
      ctx.stroke();
    }
  }
  ctx.lineJoin = 'round';
  for (const [color, lw] of [['rgba(8,16,22,0.55)', 4.2], ['#ffffff', 2]]) {
    ctx.strokeStyle = color; ctx.lineWidth = lw * k; ctx.stroke(edge.line);
  }

  // 6 scales
  if (S.show.scales) drawScales(ctx, S, cam, W, H, k, edge);
  S.edge = edge;
}
