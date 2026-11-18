// peaks.js -- which named peaks can be seen from a place, and where their labels go. No DOM at import time.
import { R_EFF } from '../core/terrain.js?v=1117.2337-166b81d';
import { skyTAt } from './horizon.js?v=1117.2337-166b81d';

const D2R = Math.PI / 180;

/**
 * Peaks (from places.js loadPeaks) that can be seen from the horizon's spot, best first.
 * opts.maxDist: reach in meters (default horizon.maxDist or 60000).
 * -> [{name, ele, az, t, dist, dir: [e, n, u], score}]
 */
export function visiblePeaks(horizon, terrain, peaks, opts = {}) {
  const { lat, lon, hEye, na } = horizon, reach = opts.maxDist ?? horizon.maxDist ?? 60000;
  const cosL = Math.cos(lat * D2R), out = [];
  for (const p of peaks || []) {
    const e = (p.lon - lon) * D2R * 6371008.8 * cosL, n = (p.lat - lat) * D2R * 6371008.8, d = Math.hypot(e, n);
    if (d < 500 || d > reach) continue;
    const tz = terrain.elev(p.lon, p.lat);
    let ele = p.ele ?? tz;
    if (Number.isFinite(tz) && tz > ele) ele = tz;
    if (!Number.isFinite(ele)) continue;
    const t = (ele - hEye) / d - d / (2 * R_EFF), az = Math.atan2(e, n);
    let blocked = false;
    for (let i = 0; i < 120 && !blocked; i++) {
      const f = 0.01 + 0.96 * i / 119, x = f * d;
      const z = terrain.elev(lon + (p.lon - lon) * f, lat + (p.lat - lat) * f);
      if (z > hEye + f * (ele - hEye) - x * (d - x) / (2 * R_EFF) + 15) blocked = true;
    }
    if (blocked) continue;
    const onSky = t >= skyTAt(horizon, az) - 0.004;
    let low = Infinity;
    for (let a = -3; a <= 3; a += 0.25) low = Math.min(low, skyTAt(horizon, az + a * D2R));
    const prom = Math.max(0, t - low);
    out.push({ name: p.name, ele, az, t, dist: d, dir: [e / d * Math.cos(Math.atan(t)), n / d * Math.cos(Math.atan(t)), Math.sin(Math.atan(t))], score: (onSky ? 1 : 0) + 8 * prom + ele / 20000 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Greedy declutter. items [{x, y, name, score}] best first; (x, y) is the bottom centre of the label.
 * opts: {max = 14, h = 14 (box height), pad = 3}. -> the items kept.
 */
export function layoutLabels(items, measure, opts = {}) {
  const max = opts.max ?? 14, h = opts.h ?? 14, pad = opts.pad ?? 3, boxes = [], out = [];
  for (const it of items) {
    if (out.length >= max) break;
    const w = measure(it.name) / 2 + pad, b = [it.x - w, it.y - h - pad, it.x + w, it.y + pad];
    if (boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
    boxes.push(b); out.push(it);
  }
  return out;
}

/** Paint peak names over the picture. S.peaks is the visiblePeaks result; k = device pixel ratio. */
export function drawPeaks(ctx, S, cam, sw, sh, k) {
  const top = (S.ui?.top ?? 56) * k, P = [0, 0], fs = 11 * k, tick = 10 * k;
  ctx.save();
  ctx.font = `600 ${fs}px sans-serif`;
  const measure = s => ctx.measureText(s).width, items = [];
  for (const p of S.peaks) {
    if (!cam.project(p.dir[0], p.dir[1], p.dir[2], sw, sh, P) || P[0] < 0 || P[0] > sw || P[1] > sh) continue;
    const y = P[1] - tick - 2 * k, w = measure(p.name) / 2 + 4 * k;
    if (y - fs < top) continue;
    items.push({ x: Math.min(sw - w, Math.max(w, P[0])), px: P[0], py: P[1], y, name: p.name, score: p.score });
  }
  const keep = layoutLabels(items, measure, { h: fs * 1.25, pad: 3 * k });
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4 * k;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2 * k;
  for (const it of keep) {
    ctx.beginPath(); ctx.moveTo(it.px, it.py); ctx.lineTo(it.px, it.py - tick); ctx.stroke();
    ctx.fillText(it.name, it.x, it.y);
  }
  ctx.restore();
}
