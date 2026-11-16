// ar.js -- augmented reality: the phone camera behind the drawing, aimed by the
// compass and motion sensors, then pulled onto the real ridges by matching the
// skyline in the picture (Ridgeline's align.js, shared through app/core).
//
// The drawing keeps using S.view and the screen camera; this module only
// supplies S.ar = {R, fn}: the world -> camera rotation and the focal length as
// a fraction of the SCREEN width (the video is shown object-fit: cover, so the
// screen is a centred crop of the frame).
//
// Dragging the picture nudges the correction (the gesture code moves S.view;
// the difference is taken up here), pinching changes the lens's focal length.

import { buildPano, chainCrests } from '../core/terrain.js?v=1116.1400-424dc31';
import { Camera, matMul, yawMat, pitchRollMat, orthonormalize, yprFromRot, IDENT } from '../core/camera.js?v=1116.1400-424dc31';
import { analyzeFrame, alignModel, solveAlignment } from '../core/align.js?v=1116.1400-424dc31';
import { startCamera, Orientation } from '../core/sensors.js?v=1116.1400-424dc31';
import { declination } from '../core/geomag.js?v=1116.1400-424dc31';

const DEFAULT_HFOV = 64;          // phone main camera, video mode, along the long side of the frame
const ZOOMS = [1, 0.6, 1.65];     // focal guesses while the lens is unknown: main, ultra-wide, tele
const ANALYSIS_W = 320;
const FN_MIN = Camera.hfovToFn(110), FN_MAX = Camera.hfovToFn(4);
const wrap180 = d => ((d % 360) + 540) % 360 - 180;

/** Focal length (fraction of screen width) of a video frame vw x vh shown with cover scaling on sw x sh. */
export function screenFn(fnVideo, vw, vh, sw, sh) {
  const sc = Math.max(sw / vw, sh / vh);
  return fnVideo * vw * sc / sw;
}

export class AR {
  /** video: <video> element; S: app state; hooks: {draw(), status(text, kind), lat/lon via S.place} */
  constructor(video, S, hooks) {
    this.video = video; this.S = S; this.h = hooks;
    this.orient = new Orientation();
    this.on = false; this.stream = null; this.raf = 0;
    this.ana = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    this.actx = this.ana?.getContext('2d', { willReadFrequently: true });
    this.loop = this.loop.bind(this);
  }

  /** Must be called from a tap (iOS asks for motion access only inside a user gesture). */
  async start() {
    const S = this.S;
    if (!S.place || !S.terrain) throw new Error('Choose a location first.');
    await this.orient.start();                    // first: iOS needs the gesture still fresh
    try { this.stream = await startCamera(this.video); } catch (e) {
      this.orient.stop();
      throw new Error(e?.name === 'NotAllowedError' ? 'Camera access was denied. Allow it in the browser settings.' : 'The camera could not be started.');
    }
    this.orient.declination = declination(S.place.lat, S.place.lon);
    Object.assign(this, { yawCorr: 0, camCorr: IDENT, fnVideo: null, k1: 0, lensFor: null, lensKnown: false,
      locked: false, misses: 0, lastSolve: 0, holdUntil: 0, model: null, last: null });
    this.on = true;
    this.video.hidden = false;
    document.body.classList.add('ar-on');
    this.h.status('Point the phone at the mountains. Drag to line the ridges up if they are off.');
    // the full panorama is only needed here, so it is built on entry (the horizon keeps a slim copy)
    setTimeout(() => {
      if (!this.on) return;
      try {
        const pano = buildPano(S.terrain, S.place.lat, S.place.lon, { eye: S.place.eyeM ?? 1.7, maxDist: S.place.maxDist ?? 60000 });
        this.model = alignModel(pano, chainCrests(pano));
      } catch { this.model = null; }
    }, 50);
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.on = false;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.orient.stop();
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.video.srcObject = null; this.video.hidden = true;
    document.body.classList.remove('ar-on');
    this.S.ar = null;
    this.h.draw();
  }

  /** Lens guess, or the one found earlier for this frame size. */
  recallLens(vw, vh) {
    this.fnVideo = Camera.hfovToFn(DEFAULT_HFOV) * Math.max(vw, vh) / vw; this.k1 = 0; this.lensKnown = false;
    try {
      const v = JSON.parse(localStorage.getItem(`moonshot.lens.${vw}x${vh}`));
      if (v && v.fn > 0.1 && v.fn < 30 && Math.abs(v.k1) < 0.3) { this.fnVideo = v.fn; this.k1 = v.k1; this.lensKnown = true; }
    } catch { /* nothing kept */ }
  }
  rememberLens(vw, vh) {
    try { localStorage.setItem(`moonshot.lens.${vw}x${vh}`, JSON.stringify({ fn: this.fnVideo, k1: this.k1 })); } catch { /* not kept */ }
    this.lensKnown = true;
  }

  currentR() { return matMul(matMul(this.camCorr, this.orient.R), yawMat(this.yawCorr)); }

  loop(now) {
    if (!this.on) return;
    this.raf = requestAnimationFrame(this.loop);
    const S = this.S, v = this.video, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !this.orient.R) return;
    if (this.lensFor !== `${vw}x${vh}`) { this.lensFor = `${vw}x${vh}`; this.recallLens(vw, vh); }
    const sw = innerWidth, sh = innerHeight;
    // take up what the gestures did to the view since the last frame: drag = nudge, pinch = focal length
    if (this.last) {
      const dAz = wrap180(S.view.azDeg - this.last.az), dAlt = S.view.altDeg - this.last.alt, f = this.last.hfov / S.view.hfovDeg;
      if (dAz || dAlt || Math.abs(f - 1) > 1e-6) {
        this.yawCorr += dAz;
        if (dAlt) this.camCorr = orthonormalize(matMul(pitchRollMat(dAlt, 0), this.camCorr));
        if (Math.abs(f - 1) > 1e-6) { this.fnVideo = Math.min(FN_MAX, Math.max(FN_MIN, this.fnVideo * f)); this.rememberLens(vw, vh); }
        this.holdUntil = now + 4000;
      }
    }
    const R = this.currentR(), fn = screenFn(this.fnVideo, vw, vh, sw, sh);
    S.ar = { R, fn, k1: this.k1 };
    const ypr = yprFromRot(R);
    S.view.azDeg = ypr.yaw; S.view.altDeg = ypr.pitch; S.view.hfovDeg = 2 * Math.atan(0.5 / fn) * 180 / Math.PI;
    this.last = { az: S.view.azDeg, alt: S.view.altDeg, hfov: S.view.hfovDeg };
    this.h.draw();
    if (this.model && now - this.lastSolve > (this.locked ? 1800 : 900) && now >= this.holdUntil) this.solve(now, vw, vh);
  }

  solve(now, vw, vh) {
    if (this.orient.rate > 12) return;                     // phone is swinging
    this.lastSolve = now;
    const ah = Math.round(ANALYSIS_W * vh / vw);
    this.ana.width = ANALYSIS_W; this.ana.height = ah;
    this.actx.imageSmoothingQuality = 'high';
    this.actx.drawImage(this.video, 0, 0, ANALYSIS_W, ah);
    const an = analyzeFrame({ w: ANALYSIS_W, h: ah, data: this.actx.getImageData(0, 0, ANALYSIS_W, ah).data });
    const base = new Camera(this.currentR(), this.fnVideo, this.k1);
    const sol = solveAlignment(this.model, base, an, {
      maxYaw: this.locked ? 10 : 45, lens: true, strict: true,
      zooms: this.locked ? null : this.lensKnown ? null : ZOOMS,
    });
    if (sol && sol.ok) {
      const k = this.locked && Math.abs(sol.yaw) < 3 ? 0.5 : 1;   // once locked, half steps: steady but still tracks drift
      this.yawCorr += sol.yaw * k;
      this.camCorr = orthonormalize(matMul(pitchRollMat(sol.pitch * k, sol.roll * k), this.camCorr));
      this.fnVideo = Math.min(FN_MAX, Math.max(FN_MIN, this.fnVideo * Math.pow(sol.fScale, k)));
      this.k1 += (sol.k1 - this.k1) * k;
      if (this.locked) this.rememberLens(vw, vh);
      this.locked = true; this.misses = 0;
      this.h.status(`Locked to the skyline (compass was ${Math.abs(this.yawCorr).toFixed(0)}° off)`, 'ok');
    } else {
      if (++this.misses > 3) this.locked = false;
      if (!this.locked || sol?.hidden) this.h.status(sol?.hidden ? 'Mountains hidden: going by the compass. Drag to adjust.'
        : sol ? 'Skyline match is weak. Drag to line it up.' : 'No skyline in view. Tilt up, or drag to line it up.');
    }
  }
}
