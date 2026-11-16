// view.js -- where the screen looks, and the gestures that move it.
import { Camera, rotFromYPR } from '../core/camera.js?v=1115.1805-901b992';

export const LIM = { alt: [-30, 80], fov: [1, 120] };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Wrap az into [0, 360), clamp alt and fov into LIM. Mutates and returns v. */
export function clampView(v) {
  v.azDeg = ((v.azDeg % 360) + 360) % 360;
  v.altDeg = clamp(v.altDeg, ...LIM.alt);
  v.hfovDeg = clamp(v.hfovDeg, ...LIM.fov);
  return v;
}

/** The screen camera for a view. fn is a fraction of the frame width. */
export function screenCamera(v) {
  return new Camera(rotFromYPR(v.azDeg, v.altDeg, 0), Camera.hfovToFn(v.hfovDeg));
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
export function attachGestures(el, v, { onChange, onDoubleTap }) {
  const ptrs = new Map();
  let pinch = null, lastTap = 0, moved = 0, tapX = 0, tapY = 0;
  const width = () => el.clientWidth || 1;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

  const down = e => {
    el.setPointerCapture?.(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { moved = 0; tapX = e.clientX; tapY = e.clientY; }
    if (ptrs.size === 2) pinch = { d: dist(), fov: v.hfovDeg };
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
      v.hfovDeg = pinch.fov * pinch.d / dist();    // fingers apart = zoom in
      clampView(v);
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
    zoomBy(v, Math.exp(dy * 0.0015));
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
      case '+': case '=': zoomBy(v, 1 / 1.25); break;
      case '-': case '_': zoomBy(v, 1.25); break;
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
