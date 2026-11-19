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
//
// Source: the phone camera, or a camera on the USB port (cameralink.js): its live
// view frames are drawn into a canvas shown whole (contain, not cover). The phone
// is then mounted on the camera's shoe, so the phone's sensors still aim the view
// (back of the phone facing where the lens looks); the fixed offset between the
// two is taken up by the skyline match and by dragging.

import { buildPano, chainCrests } from '../core/terrain.js?v=1118.1811-86b42d8';
import { Camera, matMul, yawMat, pitchRollMat, orthonormalize, yprFromRot, rotFromYPR, IDENT } from '../core/camera.js?v=1118.1811-86b42d8';
import { analyzeFrame, alignModel, solveAlignment } from '../core/align.js?v=1118.1811-86b42d8';
import { startCamera, Orientation } from '../core/sensors.js?v=1118.1811-86b42d8';
import { declination } from '../core/geomag.js?v=1118.1811-86b42d8';

const DEFAULT_HFOV = 64;          // phone main camera, video mode, along the long side of the frame
const ZOOMS = [1, 0.6, 1.65];     // focal guesses while the lens is unknown: main, ultra-wide, tele
const ANALYSIS_W = 320;
const FN_MIN = Camera.hfovToFn(110), FN_MAX = Camera.hfovToFn(4);
const wrap180 = d => ((d % 360) + 540) % 360 - 180;

/** Focal length (fraction of screen width) of a frame vw x vh shown on sw x sh, scaled to cover (or contain). */
export function screenFn(fnVideo, vw, vh, sw, sh, contain = false) {
  const sc = contain ? Math.min(sw / vw, sh / vh) : Math.max(sw / vw, sh / vh);
  return fnVideo * vw * sc / sw;
}

export class AR {
  /** video: <video> element; S: app state; hooks: {draw(), status(text, kind), lat/lon via S.place} */
  constructor(video, S, hooks, frameCanvas = null) {
    this.video = video; this.S = S; this.h = hooks; this.frame = frameCanvas;
    this.orient = new Orientation();
    this.on = false; this.stream = null; this.raf = 0;
    this.ana = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    this.actx = this.ana?.getContext('2d', { willReadFrequently: true });
    this.loop = this.loop.bind(this);
  }

  /** Must be called from a tap (iOS asks for motion access only inside a user gesture). */
  /**
   * source: 'phone', or {link, fnGuess} for a USB camera (link: cameralink.CameraLink;
   * fnGuess: focal length as a fraction of the frame width, from the lens and sensor set in the menu).
   */
  async start(source = 'phone') {
    const S = this.S;
    if (!S.place || !S.terrain) throw new Error('Choose a location first.');
    this.ext = source !== 'phone' ? source : null;
    this.sensorsOff = false;
    // first: iOS asks for motion access only while a tap is fresh. A camera plugged in is not a tap:
    // then the view starts aimed where the screen looked and the sensors join on the next tap.
    try { await this.orient.start(); } catch (e) {
      if (!this.ext) throw e;
      this.sensorsOff = true;
    }
    Object.assign(this, { yawCorr: 0, camCorr: IDENT, fnVideo: null, k1: 0, lensFor: null, lensKnown: false,
      locked: false, misses: 0, lastSolve: 0, holdUntil: 0, model: null, last: null, fixedR: null, t0: null });
    if (this.ext) {
      this.src = this.frame;
      this.offFrame = this.ext.link.on('frame', d => this.showFrame(d.jpeg));
      this.frame.hidden = false;
      if (this.sensorsOff) this.fixedR = rotFromYPR(S.view.azDeg, S.view.altDeg, 0);
    } else {
      try { this.stream = await startCamera(this.video); } catch (e) {
        this.orient.stop();
        throw new Error(e?.name === 'NotAllowedError' ? 'Camera access was denied. Allow it in the browser settings.' : 'The camera could not be started.');
      }
      this.src = this.video;
      this.video.hidden = false;
    }
    this.orient.declination = declination(S.place.lat, S.place.lon);
    this.on = true;
    document.body.classList.add('ar-on');
    if (this.ext) document.body.classList.add('cam-on');
    this.h.status(this.ext ? (this.sensorsOff ? 'Camera view. Drag to line the ridges up, or tap “Use compass”.' : 'Camera view. Drag to line the ridges up if they are off.')
      : 'Point the phone at the mountains. Drag to line the ridges up if they are off.', '', this.sensorsOff ? 'compass' : null);
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

  /** From a tap: turn the motion sensors on after a start without them. */
  async enableSensors() {
    await this.orient.start();
    this.sensorsOff = false; this.fixedR = null;
    this.yawCorr = 0; this.camCorr = IDENT; this.locked = false; this.last = null;
    this.h.status('Compass on. Drag to line the ridges up if they are off.');
  }

  /** Draw one live-view JPEG (base64) into the frame canvas. Frames that arrive while one is decoding are dropped. */
  showFrame(b64) {
    if (!this.on || this.decoding) return;
    this.decoding = true;
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    createImageBitmap(new Blob([u], { type: 'image/jpeg' })).then(bmp => {
      const c = this.frame;
      if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      this.gotFrame = true;
    }).catch(() => {}).finally(() => { this.decoding = false; });
  }

  stop() {
    this.on = false;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.orient.stop();
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.video.srcObject = null; this.video.hidden = true;
    if (this.frame) this.frame.hidden = true;
    if (this.ext) { const fns = this.ext.link.fns.frame; const i = fns?.indexOf(this.offFrame); if (i >= 0) fns.splice(i, 1); }
    this.ext = null; this.gotFrame = false;
    document.body.classList.remove('ar-on', 'cam-on');
    this.S.ar = null;
    this.h.draw();
  }

  /** Lens guess, or the one found earlier for this frame size. */
  recallLens(vw, vh) {
    if (this.ext) { this.fnVideo = this.ext.fnGuess; this.k1 = 0; this.lensKnown = false; return; }
    this.fnVideo = Camera.hfovToFn(DEFAULT_HFOV) * Math.max(vw, vh) / vw; this.k1 = 0; this.lensKnown = false;
    try {
      const v = JSON.parse(localStorage.getItem(`moonshot.lens.${vw}x${vh}`));
      if (v && v.fn > 0.1 && v.fn < 30 && Math.abs(v.k1) < 0.3) { this.fnVideo = v.fn; this.k1 = v.k1; this.lensKnown = true; }
    } catch { /* nothing kept */ }
  }
  rememberLens(vw, vh) {
    if (this.ext) return;                                   // a camera's zoom lens changes; the menu's focal length is the guess
    try { localStorage.setItem(`moonshot.lens.${vw}x${vh}`, JSON.stringify({ fn: this.fnVideo, k1: this.k1 })); } catch { /* not kept */ }
    this.lensKnown = true;
  }

  currentR() { return matMul(matMul(this.camCorr, this.fixedR || this.orient.R), yawMat(this.yawCorr)); }

  loop(now) {
    if (!this.on) return;
    this.raf = requestAnimationFrame(this.loop);
    const S = this.S, ext = !!this.ext;
    const vw = ext ? (this.gotFrame ? this.frame.width : 0) : this.video.videoWidth, vh = ext ? this.frame.height : this.video.videoHeight;
    if (ext && !this.orient.R && !this.fixedR) {          // no sensor readings yet (or none at all): aim by the screen until they come
      this.t0 ??= now;
      if (now - this.t0 > 1500) { this.fixedR = rotFromYPR(S.view.azDeg, S.view.altDeg, 0); this.sensorsOff = true; }
    }
    if (this.fixedR && this.orient.R && !this.sensorsOff) this.fixedR = null;
    if (!vw || !(this.fixedR || this.orient.R)) return;
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
    const R = this.currentR(), fn = screenFn(this.fnVideo, vw, vh, sw, sh, ext);
    S.ar = { R, fn, k1: this.k1 };
    const ypr = yprFromRot(R);
    S.view.azDeg = ypr.yaw; S.view.altDeg = ypr.pitch; S.view.hfovDeg = 2 * Math.atan(0.5 / fn) * 180 / Math.PI;
    this.last = { az: S.view.azDeg, alt: S.view.altDeg, hfov: S.view.hfovDeg };
    this.h.draw();
    if (this.model && now - this.lastSolve > (this.locked ? 1800 : 900) && now >= this.holdUntil) this.solve(now, vw, vh);
  }

  solve(now, vw, vh) {
    if (!this.fixedR && this.orient.rate > 12) return;     // phone is swinging
    this.lastSolve = now;
    const ah = Math.round(ANALYSIS_W * vh / vw);
    this.ana.width = ANALYSIS_W; this.ana.height = ah;
    this.actx.imageSmoothingQuality = 'high';
    this.actx.drawImage(this.src, 0, 0, ANALYSIS_W, ah);
    const an = analyzeFrame({ w: ANALYSIS_W, h: ah, data: this.actx.getImageData(0, 0, ANALYSIS_W, ah).data });
    const base = new Camera(this.currentR(), this.fnVideo, this.k1);
    const sol = solveAlignment(this.model, base, an, {
      maxYaw: this.locked ? 10 : this.fixedR ? 180 : 45, lens: true, strict: true,
      zooms: this.locked || this.ext ? null : this.lensKnown ? null : ZOOMS,
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
