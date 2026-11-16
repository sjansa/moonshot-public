// Sky glyph: moon phase icon + Milky Way visibility dots (PhotoPills-style). No other imports.

/** Draw a moon phase disc centred at (cx, cy) with radius r. Lit side on the right when waxing (north), mirrored when south. */
export function drawPhase(ctx, cx, cy, r, fraction, waxing, south = false) {
  const f = Math.min(1, Math.max(0, fraction));
  ctx.save();
  ctx.translate(cx, cy);
  if (waxing === !!south) ctx.scale(-1, 1);          // lit side on the left
  ctx.fillStyle = '#2a2f36';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4f1e6';
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);        // right half
  ctx.ellipse(0, 0, Math.abs(1 - 2 * f) * r, r, 0, Math.PI / 2, -Math.PI / 2, f < 0.5);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = Math.max(0.5, r / 10);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

export function glyphText(d) {
  return `Moon ${Math.round(d.fraction * 100)}% ${d.waxing ? 'waxing' : 'waning'}. Milky Way ${d.dots} of 5`;
}

export function makeSkyGlyph({ size = 26 } = {}) {
  const el = document.createElement('span');
  el.style.cssText = 'display:inline-flex;align-items:center;pointer-events:none;flex:none';
  const cv = document.createElement('canvas');
  const w = Math.round(size * 0.9 + 8), dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(size * dpr);
  cv.style.cssText = `width:${w}px;height:${size}px;display:block`;
  el.appendChild(cv);
  const ctx = cv.getContext('2d');
  const r = size * 0.4;
  function update(data, { south = false } = {}) {
    if (!data) { el.style.display = 'none'; el.removeAttribute('title'); el.removeAttribute('aria-label'); return; }
    el.style.display = 'inline-flex';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, size);
    drawPhase(ctx, r + 1, size / 2, r, data.fraction, data.waxing, south);
    const dr = 1.6, gap = 2, x = 2 * r + 2 + 5, n = 5, h = n * 2 * dr + (n - 1) * gap, y0 = (size + h) / 2 - dr;
    for (let i = 0; i < n; i++) {
      const y = y0 - i * (2 * dr + gap);
      ctx.beginPath(); ctx.arc(x, y, dr, 0, Math.PI * 2);
      if (i < data.dots) { ctx.fillStyle = 'rgb(190,205,255)'; ctx.fill(); }
      else { ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1; ctx.stroke(); }
    }
    el.title = glyphText(data); el.setAttribute('aria-label', el.title);
  }
  return { el, update };
}
