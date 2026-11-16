// Time ruler: a 64 px strip with a fixed center needle; the scale slides under it.
// No imports. See PLAN.md section 8.

export const SPANS = [2 * 3600e3, 12 * 3600e3, 3 * 86400e3, 30 * 86400e3];
const SPAN_LABELS = ['2h', '12h', '3d', '30d'];
const MIN = 60000;

// ---------- pure time maths (exported for tests) ----------

export const snapMinute = (ms) => Math.round(ms / MIN) * MIN;
const mod = (a, n) => ((a % n) + n) % n;

/** New time (ms, unsnapped) after dragging dxPx pixels. Dragging left (dx<0) moves forward. */
export function dragTime(startMs, dxPx, spanMs, widthPx) {
  return startMs - dxPx * spanMs / widthPx;
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
.rl-grp { position: absolute; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; align-items: center; margin-top: 1px; }
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
.rl-cal svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.rl-date { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; margin: 0; font-size: 16px; }
`;
  document.head.appendChild(s);
}

const CAL_SVG = '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';

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
    this._w = 0; this._h = 64; this._dpr = 1;
    this._drag = null;
    this._rep = null;

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
    this.bCal = mk('rl-cal', '', 'Pick date');
    this.bCal.innerHTML = CAL_SVG;
    this.dateIn = document.createElement('input');
    this.dateIn.type = 'date'; this.dateIn.className = 'rl-date'; this.dateIn.setAttribute('aria-label', 'Date');
    this.bCal.appendChild(this.dateIn);
    left.append(this.bNow, this.bSpan);
    right.append(this.bMinus, this.bPlus, this.bCal);
    container.append(left, right);
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
      cv.focus({ preventScroll: true });
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this._drag = { id: e.pointerId, x0: e.clientX, t0: this._exact };
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || d.id !== e.pointerId) return;
      this._user(dragTime(d.t0, e.clientX - d.x0, this.span, this._w || 1), true);
    });
    const end = (e) => { if (this._drag && this._drag.id === e.pointerId) this._drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
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
  get time() { return new Date(snapMinute(this._exact)); }

  setTime(date) {
    this._exact = snapMinute(date.getTime());
    this._syncDate();
    this._schedule();
  }

  setSpan(ms) {
    let i = SPANS.indexOf(ms);
    if (i < 0) i = SPANS.reduce((b, s, j) => (Math.abs(s - ms) < Math.abs(SPANS[b] - ms) ? j : b), 0);
    this._spanIdx = i;
    this.bSpan.textContent = SPAN_LABELS[i];
    this._bands = null; this._marks = null;
    this._schedule();
  }

  invalidate() { this._bands = null; this._marks = null; this._syncDate(); this._schedule(); }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 64;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    if (w === this._w && h === this._h && dpr === this._dpr && this.cv.width) { return; }
    this._w = w; this._h = h; this._dpr = dpr;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this._schedule();
  }

  // ----- internals -----

  _user(ms, fromDrag) {
    const prev = snapMinute(this._exact);
    this._exact = fromDrag ? ms : snapMinute(ms);
    // drag keeps the unsnapped value so the gesture stays exact; the visible time is snapped
    const now = snapMinute(this._exact);
    this._syncDate();
    this._schedule();
    if (now !== prev || !fromDrag) this.o.onChange && this.o.onChange(new Date(now));
  }

  _hold(btn, dir) {
    const stop = () => { clearTimeout(this._rep && this._rep.to); clearInterval(this._rep && this._rep.iv); this._rep = null; };
    const step = () => this._user(snapMinute(this._exact) + dir * MIN);
    btn.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
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
    try { const v = this.o.dateInputValue(this.time); if (v && this.dateIn.value !== v) this.dateIn.value = v; } catch (e) { /* ignore */ }
    this.cv.setAttribute('aria-valuetext', this.o.format(this.time, 'date') + ' ' + this.o.format(this.time, 'time'));
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _xOf(ms, t) { return this._w / 2 + (ms - t) * this._w / this.span; }

  _ensureCaches(t) {
    const span = this.span, W = this._w;
    const stale = (c) => !c || c.spanIdx !== this._spanIdx || Math.abs(t - c.center) > span / 2;
    if (stale(this._bands)) {
      const step = 8 * span / W;                 // ms per 8 px
      const t0 = t - span, n = Math.ceil(2 * span / step) + 1;
      const alt = new Float32Array(n);
      for (let i = 0; i < n; i++) alt[i] = this.o.sunAltDeg(new Date(t0 + i * step));
      this._bands = { center: t, spanIdx: this._spanIdx, t0, step, alt };
    }
    if (stale(this._marks)) {
      let list = [];
      try { list = this.o.marks ? this.o.marks(new Date(t - span), new Date(t + span)) || [] : []; } catch (e) { list = []; }
      this._marks = { center: t, spanIdx: this._spanIdx, list };
    }
  }

  _localMinute(em) {
    const m = /(\d{1,2})\D(\d{2})/.exec(this.o.format(new Date(em * MIN), 'time'));
    return m ? mod(+m[1] * 60 + +m[2], 1440) : 0;
  }

  _ticks(t0, t1) {
    const idx = this._spanIdx;
    const step = [5, 60, 360, 1440][idx];
    const fmt = this.o.format;
    const out = [];
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
    const ctx = this.ctx, W = this._w, H = this._h, dpr = this._dpr;
    if (!W) return;
    const t = snapMinute(this._exact), span = this.span;
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
      ctx.fillRect(Math.floor(x), 0, Math.ceil(pxStep) + 1, H);
    }
    // darken for legibility
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(6,12,18,0.30)'); g.addColorStop(1, 'rgba(6,12,18,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // ticks and labels
    const tf = t - span / 2 - span * 0.1, tt = t + span / 2 + span * 0.1;
    const ticks = this._ticks(tf, tt);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 1;
    for (const k of ticks) {
      const x = Math.round(this._xOf(k.ms, t)) + 0.5;
      ctx.strokeStyle = k.major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)';
      ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, H - (k.major ? 12 : 6)); ctx.stroke();
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
    const marks = this._marks.list.map((m) => ({ ...m, x: this._xOf(m.date.getTime(), t) }))
      .filter((m) => m.x > -40 && m.x < W + 40).sort((a, c) => a.x - c.x);
    let lastEnd = -1e9;
    ctx.font = font(10, 600);
    for (let mi = 0; mi < marks.length; mi++) {
      const m = marks[mi];
      ctx.fillStyle = m.color || '#f4f1e6';
      ctx.beginPath(); ctx.moveTo(m.x - 4.5, 0); ctx.lineTo(m.x + 4.5, 0); ctx.lineTo(m.x, 7); ctx.closePath(); ctx.fill();
      if (m.label) {
        const w = ctx.measureText(m.label).width;
        const room = mi + 1 >= marks.length || marks[mi + 1].x - m.x > w + 10;
        if (room && m.x + 7 > lastEnd + 4) {
          ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
          ctx.fillText(m.label, m.x + 6, 9);
          ctx.shadowBlur = 0;
          lastEnd = m.x + 6 + w;
        }
      }
    }

    // needle
    const cx = Math.round(W / 2) + 0.5;
    ctx.strokeStyle = getComputedStyle(this.el).getPropertyValue('--go').trim() || '#3fb6ff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, 24); ctx.lineTo(cx, H); ctx.stroke();

    // selected time readout
    const d = new Date(t);
    const dateS = this.o.format(d, 'date'), timeS = this.o.format(d, 'time');
    const half = Math.min(W / 2 - (this._left.offsetLeft + this._left.offsetWidth), this._right.offsetLeft - W / 2);
    const avail = Math.max(50, 2 * half - 20);
    ctx.fillStyle = '#f2f6f8'; ctx.textAlign = 'center';
    ctx.font = font(15, 700);
    const oneW = ctx.measureText(dateS + '  ' + timeS).width;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
    if (oneW <= avail) {          // one line: "Tue 24 Nov  17:30"
      const pw = oneW + 18, ph = 22, py = 12;
      ctx.fillStyle = 'rgba(8,16,22,0.78)';
      ctx.beginPath(); ctx.roundRect(W / 2 - pw / 2, py, pw, ph, 11); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f2f6f8';
      ctx.fillText(dateS + '  ' + timeS, W / 2, py + 16);
    } else {                      // two lines when the buttons leave little room
      let dpx = 11;
      ctx.font = font(dpx, 600);
      const dw = ctx.measureText(dateS).width;
      if (dw > avail) { dpx = Math.max(8, Math.floor(dpx * avail / dw)); }
      ctx.font = font(18, 700);
      const tw = ctx.measureText(timeS).width;
      ctx.font = font(dpx, 600);
      const pw = Math.max(ctx.measureText(dateS).width, tw) + 16, ph = 34, py = 2;
      ctx.fillStyle = 'rgba(8,16,22,0.78)';
      ctx.beginPath(); ctx.roundRect(W / 2 - pw / 2, py, pw, ph, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c9d6dd'; ctx.fillText(dateS, W / 2, py + 12);
      ctx.fillStyle = '#f2f6f8'; ctx.font = font(18, 700); ctx.fillText(timeS, W / 2, py + 29);
    }
  }
}
