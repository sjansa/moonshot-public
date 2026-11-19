// Time ruler: a 96 px strip, two rows. Top row: buttons and the time readout (a
// date button). Below: the sliding scale with a fixed center needle.
// Fine mode (PhotoPills style): press and hold the scale for 400 ms without moving
// 8 px and the scale switches to FINE_SPAN (5 min across the width, a tick every
// 10 s, labels each minute, time to the second) while the finger stays down; the gesture continues without
// a jump and the selected span returns on release. The haptic tick is opts.haptic.
// Only import: skyglyph.js (moon + Milky Way glyph in the readout). See PLAN.md section 8.

import { makeSkyGlyph, drawPhase } from './skyglyph.js?v=1119.0437-fbafc20';

export const SPANS = [2 * 3600e3, 12 * 3600e3, 3 * 86400e3, 30 * 86400e3];
const SPAN_LABELS = ['2h', '12h', '3d', '30d'];
const MIN = 60000, SEC = 1000;
export const FINE_SPAN = 5 * MIN;
export const FINE_TICK = 10 * SEC;
const LONG_PRESS_MS = 400, LONG_PRESS_PX = 8;

// ---------- pure time maths (exported for tests) ----------

export const snapMinute = (ms) => Math.round(ms / MIN) * MIN;
export const snapSecond = (ms) => Math.round(ms / SEC) * SEC;
const mod = (a, n) => ((a % n) + n) % n;

/** New time (ms, unsnapped) after dragging dxPx pixels. Dragging left (dx<0) moves forward. */
export function dragTime(startMs, dxPx, spanMs, widthPx) {
  return startMs - dxPx * spanMs / widthPx;
}

/**
 * Momentum after a toss: the extra distance (px) and the time it takes to
 * coast, for a release speed v (px/ms), decaying as exp(-t / tau).
 * Returns the offset at time t (ms) after release.
 */
export const FLING = { tau: 325, minV: 0.25, stopV: 0.01 };
export function flingOffset(v, t, tau = FLING.tau) {
  return v * tau * (1 - Math.exp(-t / tau));
}

/**
 * Tick instants (epoch minutes) between fromMs and toMs on round local times.
 * localMinuteOfDay(epochMinute) -> 0..1439 (derived from the app's format function).
 * stepMin must divide 1440.
 */
export function tickMinutes(fromMs, toMs, stepMin, localMinuteOfDay) {
  const out = [];
  const offAt = (em) => mod(localMinuteOfDay(em) - mod(em, 1440), 1440);
  let t = Math.ceil(fromMs / MIN);
  const end = Math.floor(toMs / MIN);
  let guard = 0;
  while (t <= end && guard++ < 5000) {
    const off = offAt(t);
    let d = mod(-(t + off), stepMin);
    const last = out.length ? out[out.length - 1] : -Infinity;
    if (d !== 0) {
      if (out.length && d > stepMin / 2) d -= stepMin; // DST shift: nearest round time
      t += d;
      if (t <= last) t = last + stepMin;
      continue;
    }
    out.push(t);
    t += stepMin;
  }
  return out;
}

export function bandColor(alt) {
  if (alt > 6) return '#3f7fc4';
  if (alt > -4) return '#f0a860';
  if (alt > -6) return '#6a6f9a';
  if (alt > -12) return '#2b3558';
  if (alt > -18) return '#141c33';
  return '#05080f';
}

// ---------- style ----------

let styled = false;
function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
.rl-root { position: relative; overflow: hidden; user-select: none; -webkit-user-select: none; touch-action: none;
  background: var(--panel, rgba(12,26,34,.82)); border-top: 1px solid var(--line, rgba(255,255,255,.16)); box-sizing: border-box; }
.rl-root * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.rl-canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: ew-resize; outline: none; display: block; }
.rl-canvas:focus-visible { outline: 2px solid var(--go, #3fb6ff); outline-offset: -2px; }
.rl-grp { position: absolute; top: 2px; display: flex; gap: 3px; align-items: center; }
.rl-l { left: calc(env(safe-area-inset-left, 0px) + 4px); }
.rl-r { right: calc(env(safe-area-inset-right, 0px) + 4px); }
.rl-btn { position: relative; min-width: 44px; height: 44px; padding: 0 6px; border: 1px solid var(--line, rgba(255,255,255,.16)); border-radius: 12px;
  background: var(--panel, rgba(12,26,34,.82)); color: var(--text, #f2f6f8); font: 600 15px/1 var(--display, "Barlow Condensed", "Helvetica Neue", Arial, sans-serif);
  letter-spacing: .04em; display: grid; place-items: center; cursor: pointer; touch-action: none;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.rl-btn:active { background: rgba(255,255,255,.18); }
.rl-btn:focus-visible { outline: 2px solid var(--go, #3fb6ff); outline-offset: 2px; }
.rl-span { color: var(--go, #3fb6ff); }
.rl-step { font-size: 24px; font-weight: 500; letter-spacing: 0; }
.rl-read { position: absolute; top: 2px; left: 50%; transform: translateX(-50%); height: 44px; min-width: 96px; padding: 0 8px; border-radius: 12px; border: 1px solid var(--line, rgba(255,255,255,.16));
  background: rgba(8,16,22,.78); color: var(--text, #f2f6f8); display: flex; align-items: center; justify-content: center; gap: 6px; overflow: hidden; cursor: pointer; }
.rl-tx { display: grid; gap: 1px; text-align: center; }
.rl-read:focus-within { outline: 2px solid var(--go, #3fb6ff); outline-offset: 2px; }
.rl-rd { font: 500 11px/1 var(--body, system-ui, sans-serif); color: #c9d6dd; white-space: nowrap; pointer-events: none; }
.rl-rt { font: 700 19px/1 var(--display, "Barlow Condensed", "Helvetica Neue", Arial, sans-serif); letter-spacing: .04em; white-space: nowrap; pointer-events: none; }
.rl-grp, .rl-read, .rl-tx, .rl-rd, .rl-rt, .rl-read > span:first-child { transition: all .45s cubic-bezier(.32,.72,0,1); }
.rl-compact .rl-grp { opacity: 0; transform: translateY(-14px) scale(.85); pointer-events: none; }
.rl-compact .rl-read { height: 26px; top: 1px; padding: 0 9px; gap: 4px; border-radius: 9px; }
.rl-compact .rl-tx { display: flex; gap: 6px; align-items: baseline; }
.rl-compact .rl-rd { font-size: 11px; }
.rl-compact .rl-rt { font-size: 15px; }
.rl-compact .rl-read > span:first-child { transform: scale(.72); margin: 0 -5px; }
@media (prefers-reduced-motion: reduce) { .rl-grp, .rl-read, .rl-tx, .rl-rd, .rl-rt, .rl-read > span:first-child { transition: none; } }
.rl-date { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; margin: 0; font-size: 16px; }
`;
  document.head.appendChild(s);
}

const SCALE_H = 48;   // height of the sliding scale; the top row (buttons, readout) takes the rest (48 px, or less when compact)

// ---------- component ----------

export class Ruler {
  constructor(container, opts) {
    injectStyle();
    this.el = container;
    this.o = opts;
    this._exact = snapMinute(opts.time instanceof Date ? opts.time.getTime() : Date.now());
    this._spanIdx = 1;
    this._bands = null;   // {center, spanIdx, t0, step, alt: Float32Array}
    this._marks = null;   // {center, spanIdx, list}
    this._raf = 0;
    this._w = 0; this._h = 96; this._dpr = 1;
    this._drag = null;
    this._rep = null;
    this._fine = false;
    this._lpTimer = 0;

    container.classList.add('rl-root');
    container.textContent = '';
    this.cv = document.createElement('canvas');
    this.cv.className = 'rl-canvas';
    this.cv.tabIndex = 0;
    this.cv.setAttribute('role', 'slider');
    this.cv.setAttribute('aria-label', 'Time');
    container.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d');

    const mk = (cls, text, label) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rl-btn ' + cls; b.textContent = text; b.setAttribute('aria-label', label);
      return b;
    };
    const left = document.createElement('div'); left.className = 'rl-grp rl-l';
    const right = document.createElement('div'); right.className = 'rl-grp rl-r';
    this.bNow = mk('rl-now', 'Now', 'Now');
    this.bSpan = mk('rl-span', SPAN_LABELS[this._spanIdx], 'Change time span');
    this.bMinus = mk('rl-step', '−', 'Back one minute');
    this.bPlus = mk('rl-step', '+', 'Forward one minute');
    this.read = document.createElement('div'); this.read.className = 'rl-read';
    this.rd = document.createElement('span'); this.rd.className = 'rl-rd';
    this.rt = document.createElement('span'); this.rt.className = 'rl-rt';
    this.dateIn = document.createElement('input');
    this.dateIn.type = 'date'; this.dateIn.className = 'rl-date'; this.dateIn.setAttribute('aria-label', 'Pick date');
    this.glyph = makeSkyGlyph({ size: 26 });
    const tx = document.createElement('span'); tx.className = 'rl-tx'; tx.append(this.rd, this.rt);
    this.read.append(this.glyph.el, tx, this.dateIn);
    this._skyDay = null;
    left.append(this.bNow, this.bSpan);
    right.append(this.bMinus, this.bPlus);
    container.append(left, right, this.read);
    this._left = left; this._right = right;

    this.bNow.addEventListener('click', () => this._user(Date.now()));
    this.bSpan.addEventListener('click', () => this.setSpan(SPANS[(this._spanIdx + 1) % SPANS.length]));
    this._hold(this.bMinus, -1);
    this._hold(this.bPlus, 1);
    this.dateIn.addEventListener('change', () => {
      if (!this.dateIn.value) return;
      this._user(this.o.dateFromInput(this.dateIn.value, this.time).getTime());
    });
    this.dateIn.addEventListener('click', () => { try { this.dateIn.showPicker && this.dateIn.showPicker(); } catch (e) { /* ignore */ } });

    const cv = this.cv;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      if (this._drag && this._drag.id !== e.pointerId) {   // second pointer: no long press, no fine mode
        this._clearLP(); this._leaveFine(); this._drag.noLong = true;
        return;
      }
      this._stopFling();
      cv.focus({ preventScroll: true });
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this._drag = { id: e.pointerId, x0: e.clientX, t0: this._exact, sx: e.clientX, sy: e.clientY, lx: e.clientX, hist: [{ x: e.clientX, t: e.timeStamp || performance.now() }] };
      this._lpTimer = setTimeout(() => this._enterFine(), LONG_PRESS_MS);
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || d.id !== e.pointerId) return;
      d.lx = e.clientX;
      const now = e.timeStamp || performance.now();
      d.hist.push({ x: e.clientX, t: now });
      while (d.hist.length > 2 && now - d.hist[0].t > 100) d.hist.shift();
      if (this._lpTimer && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= LONG_PRESS_PX) this._clearLP();
      const prev = Math.floor(+this.time / FINE_TICK);
      this._user(dragTime(d.t0, e.clientX - d.x0, this._curSpan(), this._w || 1), true);
      if (this._fine && Math.floor(+this.time / FINE_TICK) !== prev) this.o.haptic?.();
    });
    const end = (e) => {
      const d = this._drag;
      if (!d || d.id !== e.pointerId) return;
      const fine = this._fine;
      this._clearLP(); this._leaveFine(); this._drag = null;
      // a toss keeps the time moving and slows it down (not in fine mode, not after a second finger)
      if (e.type !== 'pointerup' || fine || d.noLong) return;
      const now = e.timeStamp || performance.now(), h = d.hist.filter(p => now - p.t <= 100);
      if (h.length < 2 || now - h[h.length - 1].t > 80) return;          // stopped before letting go
      const v = (h[h.length - 1].x - h[0].x) / Math.max(8, h[h.length - 1].t - h[0].t);
      if (Math.abs(v) >= FLING.minV) this._fling(v);
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', end);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      let d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= this._w;
      this._user(this._exact + d * this.span / (this._w || 1) * 0.5, true);
    }, { passive: false });
    cv.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
      e.preventDefault();
      this._user(snapMinute(this._exact) + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 60 : 1) * MIN);
    });

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(container);
    }
    this._syncDate();
    this.resize();
  }

  get span() { return SPANS[this._spanIdx]; }
  // to the second after fine mode (or setTime with seconds), else to the minute
  get time() { return new Date(this._fine || this._sec ? snapSecond(this._exact) : snapMinute(this._exact)); }

  _curSpan() { return this._fine ? FINE_SPAN : SPANS[this._spanIdx]; }
  _cacheIdx() { return this._fine ? SPANS.length : this._spanIdx; }

  _fling(v) {
    if (typeof requestAnimationFrame === 'undefined') return;
    const span = this._curSpan(), w = this._w || 1, t0 = this._exact, start = performance.now();
    const step = () => {
      const t = performance.now() - start;
      this._user(dragTime(t0, flingOffset(v, t), span, w), true);
      this._flingRaf = Math.abs(v * Math.exp(-t / FLING.tau)) > FLING.stopV ? requestAnimationFrame(step) : 0;
    };
    this._flingRaf = requestAnimationFrame(step);
  }

  _stopFling() { if (this._flingRaf) { cancelAnimationFrame(this._flingRaf); this._flingRaf = 0; } }

  _clearLP() { if (this._lpTimer) { clearTimeout(this._lpTimer); this._lpTimer = 0; } }

  _enterFine() {
    this._lpTimer = 0;
    const d = this._drag;
    if (!d || d.noLong || this._fine) return;
    this._fine = true;
    d.x0 = d.lx; d.t0 = this._exact;          // re-anchor: no jump
    this._bands = null; this._marks = null;
    this.o.haptic?.();
    this._schedule();
  }

  _leaveFine() {
    if (!this._fine) return;
    this._exact = snapSecond(this._exact); this._sec = true;     // keep the second that was picked
    this._fine = false;
    const d = this._drag;
    if (d) { d.x0 = d.lx; d.t0 = this._exact; }
    this._bands = null; this._marks = null;
    this._schedule();
  }

  setTime(date) {
    this._exact = snapSecond(date.getTime());
    this._sec = this._exact % MIN !== 0;
    this._syncDate();
    this._schedule();
  }

  setSpan(ms) {
    this._stopFling();
    let i = SPANS.indexOf(ms);
    if (i < 0) i = SPANS.reduce((b, s, j) => (Math.abs(s - ms) < Math.abs(SPANS[b] - ms) ? j : b), 0);
    this._spanIdx = i;
    this.bSpan.textContent = SPAN_LABELS[i];
    this._bands = null; this._marks = null;
    this._schedule();
  }

  /** Compact: no buttons, a small one-line readout; the container sets the height (the scale keeps 48 px). */
  setCompact(on) { this.el.classList.toggle('rl-compact', !!on); }

  /** Stop observing and drawing (the container can then be removed). */
  destroy() { this._ro?.disconnect(); this._stopFling(); this._clearLP(); if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }

  invalidate() { this._bands = null; this._marks = null; this._skyDay = null; this._syncDate(); this._schedule(); }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 96;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    if (w === this._w && h === this._h && dpr === this._dpr && this.cv.width) { return; }
    this._w = w; this._h = h; this._dpr = dpr;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this._schedule();
  }

  // ----- internals -----

  _user(ms, fromDrag) {
    const prev = +this.time;
    if (!this._fine) this._sec = false;            // outside fine mode the scale works in whole minutes
    this._exact = fromDrag ? ms : snapMinute(ms);
    // drag keeps the unsnapped value so the gesture stays exact; the visible time is snapped
    const now = +this.time;
    this._syncDate();
    this._schedule();
    if (now !== prev || !fromDrag) this.o.onChange && this.o.onChange(new Date(now));
  }

  _hold(btn, dir) {
    const stop = () => { clearTimeout(this._rep && this._rep.to); clearInterval(this._rep && this._rep.iv); this._rep = null; };
    const step = () => this._user(snapMinute(this._exact) + dir * MIN);
    btn.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      this._stopFling();
      e.preventDefault(); e.stopPropagation();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      stop(); step();
      const r = this._rep = {};
      r.to = setTimeout(() => { r.iv = setInterval(step, 70); }, 420);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); step(); } });
  }

  _syncDate() {
    try {
      const v = this.o.dateInputValue(this.time);
      if (v && this.dateIn.value !== v) this.dateIn.value = v;
      if (this.o.sky && v !== this._skyDay) { this._skyDay = v; const d = this.o.sky(this.time); this.glyph.update(d, { south: !!(d && d.south) }); }
    } catch (e) { /* ignore */ }
    const ds = this.o.format(this.time, 'date'), ts = this.o.format(this.time, this._fine || this._sec ? 'timeS' : 'time');
    this.rd.textContent = ds; this.rt.textContent = ts;
    this.cv.setAttribute('aria-valuetext', ds + ' ' + ts);
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _xOf(ms, t) { return this._w / 2 + (ms - t) * this._w / this._curSpan(); }

  _ensureCaches(t) {
    const span = this._curSpan(), W = this._w, ci = this._cacheIdx();
    const stale = (c) => !c || c.spanIdx !== ci || Math.abs(t - c.center) > span / 2;
    if (stale(this._bands)) {
      const step = 8 * span / W;                 // ms per 8 px
      const t0 = t - span, n = Math.ceil(2 * span / step) + 1;
      const alt = new Float32Array(n);
      for (let i = 0; i < n; i++) alt[i] = this.o.sunAltDeg(new Date(t0 + i * step));
      this._bands = { center: t, spanIdx: ci, t0, step, alt };
    }
    if (stale(this._marks)) {
      let list = [];
      try { list = this.o.marks ? this.o.marks(new Date(t - span), new Date(t + span)) || [] : []; } catch (e) { list = []; }
      this._marks = { center: t, spanIdx: ci, list, sky: new Map() };
    }
  }

  _localMinute(em) {
    const m = /(\d{1,2})\D(\d{2})/.exec(this.o.format(new Date(em * MIN), 'time'));
    return m ? mod(+m[1] * 60 + +m[2], 1440) : 0;
  }

  _ticks(t0, t1) {
    const fmt = this.o.format;
    const out = [];
    if (this._fine) {                                // every 10 s, a long tick and a label on each minute
      for (let ms = Math.ceil(t0 / FINE_TICK) * FINE_TICK; ms <= t1; ms += FINE_TICK) {
        const major = ms % MIN === 0;
        out.push({ ms, major, label: major ? fmt(new Date(ms), 'time') : null, bold: false });
      }
      return out;
    }
    const idx = this._spanIdx;
    const step = [5, 60, 360, 1440][idx];
    for (const em of tickMinutes(t0, t1, step, (m) => this._localMinute(m))) {
      const d = new Date(em * MIN);
      const lm = this._localMinute(em);
      let major = false, label = null, bold = false;
      if (idx === 0) { if (lm % 30 === 0) { major = true; label = fmt(d, 'time'); } }
      else if (idx === 1) { label = fmt(d, 'hour'); major = lm % 360 === 0; }
      else if (idx === 2) {
        if (lm === 0) { major = true; bold = true; label = fmt(d, 'date'); } else label = fmt(d, 'hour');
      } else {
        const dd = parseInt(fmt(d, 'day'), 10);
        if (dd % 5 === 0 || dd === 1) { major = true; label = String(dd); }
        if (dd === 1) bold = true;
      }
      out.push({ ms: em * MIN, major, label, bold });
    }
    return out;
  }

  _draw() {
    const ctx = this.ctx, W = this._w, H = this._h, dpr = this._dpr, ROW = Math.max(0, H - SCALE_H);
    if (!W) return;
    const t = +this.time, span = this._curSpan();
    this._ensureCaches(t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const font = (px, w) => `${w || 600} ${px}px ${getComputedStyle(this.el).getPropertyValue('--display').trim() || '"Barlow Condensed","Helvetica Neue",Arial,sans-serif'}`;

    // light bands
    const b = this._bands;
    const pxStep = b.step * W / span;
    for (let i = 0; i < b.alt.length; i++) {
      const x = this._xOf(b.t0 + i * b.step, t) - pxStep / 2;
      if (x > W || x + pxStep < 0) continue;
      ctx.fillStyle = bandColor(b.alt[i]);
      ctx.fillRect(Math.floor(x), ROW, Math.ceil(pxStep) + 1, H - ROW);
    }
    // darken for legibility
    const g = ctx.createLinearGradient(0, ROW, 0, H);
    g.addColorStop(0, 'rgba(6,12,18,0.30)'); g.addColorStop(1, 'rgba(6,12,18,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, ROW, W, H - ROW);
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(0, ROW, W, 1);

    // ticks and labels
    const tf = t - span / 2 - span * 0.1, tt = t + span / 2 + span * 0.1;
    const ticks = this._ticks(tf, tt);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 1;
    for (const k of ticks) {
      const x = Math.round(this._xOf(k.ms, t)) + 0.5;
      ctx.strokeStyle = k.major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)';
      ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, H - (k.major ? 12 : 6)); ctx.stroke();
      if (this._spanIdx === 3 && !this._fine && this.o.sky) {   // moon phase above each day tick
        const sk = this._marks.sky;
        if (!sk.has(k.ms)) { let d = null; try { d = this.o.sky(new Date(k.ms)); } catch (e) { /* ignore */ } sk.set(k.ms, d); }
        const d = sk.get(k.ms);
        if (d) drawPhase(ctx, x, H - 36, 4.5, d.fraction, d.waxing, d.south);
      }
      if (k.label) {
        ctx.font = font(k.bold ? 12 : 11, k.bold ? 700 : 500);
        ctx.fillStyle = k.bold ? '#ffffff' : 'rgba(242,246,248,0.85)';
        ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 3;
        ctx.fillText(k.label, x, H - 18);
        ctx.shadowBlur = 0;
      }
    }

    // marks (triangle on the top edge, short label when there is room)
    ctx.textAlign = 'left';
    const marks = (this._spanIdx === 3 ? [] : this._marks.list).map((m) => ({ ...m, x: this._xOf(m.date.getTime(), t) }))
      .filter((m) => m.x > -40 && m.x < W + 40).sort((a, c) => a.x - c.x);
    let lastEnd = -1e9;
    ctx.font = font(10, 600);
    for (let mi = 0; mi < marks.length; mi++) {
      const m = marks[mi];
      ctx.fillStyle = m.color || '#f4f1e6';
      ctx.beginPath(); ctx.moveTo(m.x - 4.5, ROW + 1); ctx.lineTo(m.x + 4.5, ROW + 1); ctx.lineTo(m.x, ROW + 8); ctx.closePath(); ctx.fill();
      if (m.label) {
        const w = ctx.measureText(m.label).width;
        const room = mi + 1 >= marks.length || marks[mi + 1].x - m.x > w + 10;
        if (room && m.x + 7 > lastEnd + 4) {
          ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
          ctx.fillText(m.label, m.x + 6, ROW + 10);
          ctx.shadowBlur = 0;
          lastEnd = m.x + 6 + w;
        }
      }
    }

    // needle
    const cx = Math.round(W / 2) + 0.5;
    ctx.strokeStyle = getComputedStyle(this.el).getPropertyValue('--go').trim() || '#3fb6ff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, ROW - 3); ctx.lineTo(cx, H); ctx.stroke();
    if (this._fine) {
      ctx.textAlign = 'left'; ctx.font = font(11, 700);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
      ctx.fillText('FINE', cx + 6, ROW + 22);
      ctx.shadowBlur = 0;
    }
  }
}
