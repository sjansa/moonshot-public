// cameralink.js -- a camera on the phone's USB port (native app only; see
// ios/App/App/SonyPTP.swift). Wraps the CameraLink plugin, turns the camera's raw
// values into labels, and runs the drive: self-timer, several shots, interval, bulb.
//
// `?mockcam` in the address gives a pretend camera (cameramock.js) for testing
// the screen without hardware.

// ---------------------------------------------------------------- labels (pure)

const SHUTTER_SLOW = [[300, 10], [250, 10], [200, 10], [150, 10], [130, 10], [100, 10], [80, 10], [60, 10], [50, 10], [40, 10],
  [32, 10], [25, 10], [20, 10], [16, 10], [13, 10], [10, 10], [8, 10], [6, 10], [5, 10], [4, 10]];
const SHUTTER_FAST = [3, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000,
  1250, 1600, 2000, 2500, 3200, 4000];
/** Sony shutter values slow -> fast, (numerator << 16 | denominator); 0 is BULB. */
export const SHUTTER_LADDER = [0, ...SHUTTER_SLOW.map(([n, d]) => n * 65536 + d), ...SHUTTER_FAST.map(d => 65536 + d)];

/** Exposure time in seconds of a Sony shutter value; 0 for BULB. */
export function shutterSeconds(v) {
  if (!v) return 0;
  const n = Math.floor(v / 65536), d = v % 65536 || 1;
  return n / d;
}

export function shutterLabel(v) {
  if (!v) return 'BULB';
  const n = Math.floor(v / 65536), d = v % 65536 || 1;
  if (n === 1 && d > 1) return `1/${d}`;
  const s = n / d;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}″`;
}

export function isoLabel(v) {
  const x = v % 0x1000000;
  return x === 0xFFFFFF ? 'ISO AUTO' : `ISO ${x}`;
}

export const fLabel = v => `f/${v / 100 >= 10 ? Math.round(v / 10) / 10 : (v / 100).toFixed(1)}`.replace(/\.0$/, '');

export function evLabel(v) {
  const ev = v / 1000;
  if (Math.abs(ev) < 0.05) return '±0';
  return `${ev > 0 ? '+' : '−'}${Math.abs(ev).toFixed(1)}`;
}

const MODES = { 1: 'M', 2: 'P', 3: 'A', 4: 'S', 0x8000: 'AUTO', 0x8001: 'AUTO+', 0x8050: 'Movie P', 0x8051: 'Movie A', 0x8052: 'Movie S', 0x8053: 'Movie M' };
export const modeLabel = v => MODES[v % 0x10000] || `Mode ${(v % 0x10000).toString(16)}`;

export const LABEL = { iso: isoLabel, shutter: shutterLabel, fnumber: fLabel, ev: evLabel, mode: modeLabel };

/** Choices for a setting: the camera's list when it gives one, else a sensible ladder. */
export function choices(name, prop) {
  if (prop?.options?.length) return prop.options;
  if (name === 'shutter') return SHUTTER_LADDER;
  if (prop?.range) {
    const [a, b, s] = prop.range, out = [];
    for (let v = a; v <= b && out.length < 200; v += s || 1) out.push(v);
    return out;
  }
  return [];
}

// ---------------------------------------------------------------- drive (pure)

/**
 * When each shot starts, in ms from now. delayS: self-timer before the first;
 * count shots; intervalS between starts, never less than the exposure plus 1.5 s
 * for the camera to save.
 */
export function shotPlan({ delayS = 0, count = 1, intervalS = 0, exposureS = 0 }) {
  const n = Math.max(1, Math.min(9999, Math.round(count)));
  const gap = Math.max(intervalS, exposureS + 1.5);
  return Array.from({ length: n }, (_, i) => Math.round((delayS + i * gap) * 1000));
}

// ---------------------------------------------------------------- the link

function nativePlugin() {
  const C = window.Capacitor;
  if (!C?.isNativePlatform?.()) return null;
  try { return C.registerPlugin ? C.registerPlugin('CameraLink') : C.Plugins?.CameraLink || null; } catch { return null; }
}

export class CameraLink {
  constructor(plugin) {
    this.p = plugin;
    this.fns = {};
    this.state = { attached: false, supported: false, name: '', props: {} };
    this.drive = null;              // running drive: {cancel, shot, total}
  }

  on(ev, fn) { (this.fns[ev] ||= []).push(fn); return this; }
  fire(ev, d) { (this.fns[ev] || []).forEach(f => { try { f(d); } catch (e) { console.error(e); } }); }

  async start() {
    for (const ev of ['attached', 'detached', 'frame', 'props', 'status']) {
      await this.p.addListener(ev, d => {
        if (ev === 'attached') Object.assign(this.state, { attached: true, supported: !!d.supported, name: d.name || 'Camera', props: d.props || {} });
        if (ev === 'detached') { this.state.attached = false; this.cancelDrive(); }
        if (ev === 'props') this.state.props = d;
        this.fire(ev, d);
      });
    }
    await this.p.start();
  }

  get props() { return this.state.props || {}; }

  async set(name, value) {
    const r = await this.p.setProperty({ name, value });
    if (r?.props) { this.state.props = r.props; this.fire('props', r.props); }
  }

  setLive(on) { return this.p.setLive({ on }); }

  /** One shot. bulbS is used when the shutter is on BULB. */
  shoot(bulbS = 0) {
    const sh = this.props.shutter?.value;
    return this.p.capture({ holdMs: sh === 0 ? Math.round(bulbS * 1000) : 0 });
  }

  /**
   * Run the drive: {delayS, count, intervalS, bulbS}. progress({phase, shot, total, nextInMs, result, error}).
   * Resolves when done or cancelled.
   */
  async runDrive(opts, progress = () => {}) {
    this.cancelDrive();
    const sh = this.props.shutter?.value;
    const exposureS = sh === 0 ? (opts.bulbS || 0) : shutterSeconds(sh);
    const plan = shotPlan({ ...opts, exposureS });
    let cancelled = false, timer = 0, wake = null;
    this.drive = { cancel: () => { cancelled = true; clearTimeout(timer); wake?.(); }, total: plan.length, shot: 0 };
    const t0 = performance.now();
    try {
      for (let i = 0; i < plan.length && !cancelled; i++) {
        // count down to the shot, telling the screen once a second
        for (;;) {
          const left = plan[i] - (performance.now() - t0);
          if (left <= 0 || cancelled) break;
          progress({ phase: 'wait', shot: i + 1, total: plan.length, nextInMs: left });
          await new Promise(r => { wake = r; timer = setTimeout(r, Math.min(left, 1000)); });
        }
        if (cancelled) break;
        this.drive.shot = i + 1;
        progress({ phase: 'shoot', shot: i + 1, total: plan.length, exposureS });
        try { progress({ phase: 'done', shot: i + 1, total: plan.length, result: await this.shoot(opts.bulbS) }); } catch (e) { progress({ phase: 'error', shot: i + 1, total: plan.length, error: e?.message || String(e) }); if (plan.length === 1) break; }
      }
    } finally { this.drive = null; }
    progress({ phase: cancelled ? 'cancelled' : 'finished', total: plan.length });
  }

  cancelDrive() { this.drive?.cancel(); }
}

/** The camera link for this run: native, the mock (?mockcam), or null. */
export async function openCameraLink() {
  let plugin = nativePlugin();
  if (!plugin && /[?&]mockcam\b/.test(location.search)) plugin = (await import('./cameramock.js?v=1122.0212-79fa2c9')).mockPlugin();
  return plugin ? new CameraLink(plugin) : null;
}
