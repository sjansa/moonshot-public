// view.js -- where the screen looks, and the gestures that move it.
import { Camera, rotFromYPR } from '../core/camera.js?v=1115.1822-4403c80';
import { SENSORS, frameSize, fovDeg } from './optics.js?v=1115.1822-4403c80';

const R2D = 180 / Math.PI;

export const LIM = { alt: [-30, 80], fov: [1, 120] };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Wrap az into [0, 360), clamp alt and fov into LIM. Mutates and returns v. */
export function clampView(v) {
  v.azDeg = ((v.azDeg % 360) + 360) % 360;
  v.altDeg = clamp(v.altDeg, ...LIM.alt);
  v.hfovDeg = clamp(v.hfovDeg, ...LIM.fov);
  return v;
}

/**
 * The screen camera for a view. fn is a fraction of the frame width. In camera
 * mode pass the geometry from cameraGeometry(): the focal length is then fixed
 * by the lens, not by the view's hfovDeg.
 */
export function screenCamera(v, geo = null) {
  return new Camera(rotFromYPR(v.azDeg, v.altDeg, 0), geo ? geo.fn : Camera.hfovToFn(v.hfovDeg));
}

/**
 * Camera mode geometry (PLAN 9). cm = {sensor: id, focal: mm, portrait}. sw, sh are the
 * canvas size, top / bottom the free band in the same units (below the status lines, above
 * the ruler). The frame is centered on the screen center (that is where the view points),
 * with the sensor's shape, as large as fits in 90% of the width and of the band.
 * -> {rect: {x, y, w, h}, fn, hfovDeg, fovW, fovH, frame: {w, h} (mm), sensor}
 */
export function cameraGeometry(cm, sw, sh, top, bottom) {
  const sensor = SENSORS.find(s => s.id === cm.sensor) || SENSORS[0];
  const frame = frameSize(sensor, cm.portrait), aspect = frame.w / frame.h;
  const halfH = Math.max(20, Math.min(sh / 2 - top, bottom - sh / 2));      // symmetric about the center
  const fw = Math.min(0.9 * sw, 0.9 * 2 * halfH * aspect), fh = fw / aspect;
  const rect = { x: (sw - fw) / 2, y: (sh - fh) / 2, w: fw, h: fh };
  const fn = (cm.focal / frame.w) * fw / sw;
  return { rect, fn, hfovDeg: 2 * Math.atan(0.5 / fn) * R2D, fovW: fovDeg(frame.w, cm.focal), fovH: fovDeg(frame.h, cm.focal), frame, sensor };
}

/** Zoom by a factor, keeping the view center. */
export function zoomBy(v, factor) { v.hfovDeg *= factor; return clampView(v); }

/** One pixel moves the view by hfov / width degrees; dragging right turns the view left. */
export function panBy(v, dxPx, dyPx, widthPx) {
  const k = v.hfovDeg / widthPx;
  v.azDeg -= dxPx * k; v.altDeg += dyPx * k;
  return clampView(v);
}

/**
 * Pointer, wheel and keyboard control of v. Calls onChange() after each change
 * and onDoubleTap() on a double tap or double click. Returns a detach function.
 */
export function attachGestures(el, v, { onChange, onDoubleTap, zoom = null }) {
  // zoom(factor) -> true when something else handles zooming (camera mode: the focal length); factor > 1 zooms in
  const ptrs = new Map();
  let pinch = null, lastTap = 0, moved = 0, tapX = 0, tapY = 0;
  const width = () => el.clientWidth || 1;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

  const down = e => {
    el.setPointerCapture?.(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { moved = 0; tapX = e.clientX; tapY = e.clientY; }
    if (ptrs.size === 2) pinch = { d: dist(), last: dist(), fov: v.hfovDeg };
  };
  const move = e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      panBy(v, dx, dy, width());
    } else if (ptrs.size === 2 && pinch) {
      const d = dist();
      if (zoom && zoom(d / pinch.last)) pinch.last = d;
      else { v.hfovDeg = pinch.fov * pinch.d / d; clampView(v); }    // fingers apart = zoom in
    }
    onChange();
  };
  const up = e => {
    if (!ptrs.delete(e.pointerId)) return;
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0 && moved < 8 && e.type === 'pointerup') {
      const now = performance.now();
      if (now - lastTap < 320 && Math.hypot(e.clientX - tapX, e.clientY - tapY) < 30) { lastTap = 0; onDoubleTap?.(); }
      else lastTap = now;
    }
  };
  const wheel = e => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const f = Math.exp(dy * 0.0015);
    if (!(zoom && zoom(1 / f))) zoomBy(v, f);
    onChange();
  };
  const key = e => {
    if (e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const step = v.hfovDeg / 12;
    let ok = true;
    switch (e.key) {
      case 'ArrowLeft': v.azDeg -= step; break;
      case 'ArrowRight': v.azDeg += step; break;
      case 'ArrowUp': v.altDeg += step; break;
      case 'ArrowDown': v.altDeg -= step; break;
      case '+': case '=': if (!(zoom && zoom(1.25))) zoomBy(v, 1 / 1.25); break;
      case '-': case '_': if (!(zoom && zoom(1 / 1.25))) zoomBy(v, 1.25); break;
      default: ok = false;
    }
    if (!ok) return;
    e.preventDefault(); clampView(v); onChange();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  addEventListener('keydown', key);
  return () => {
    el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel); removeEventListener('keydown', key);
  };
}
