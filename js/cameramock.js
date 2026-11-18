// cameramock.js -- a pretend USB camera for testing the camera screen in a
// browser (?mockcam). Same calls and events as the native CameraLink plugin:
// live frames of a drawn ridge, Sony-style settings, shots that take the
// exposure time.
import { SHUTTER_LADDER, shutterSeconds } from './cameralink.js?v=1118.0316-c1b486d';

export function mockPlugin() {
  const fns = {};
  const fire = (ev, d) => (fns[ev] || []).forEach(f => f(d));
  const props = {
    iso: { value: 3200, writable: true, options: [0xFFFFFF, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600] },
    shutter: { value: 65536 * 300 + 10, writable: true },
    fnumber: { value: 280, writable: true, options: [280, 320, 350, 400, 450, 500, 560, 630, 710, 800, 1100, 1600] },
    ev: { value: 0, writable: true, options: [-3000, -2000, -1000, -667, -333, 0, 333, 667, 1000, 2000, 3000] },
    mode: { value: 1, writable: false },
    battery: { value: 83, writable: false },
    version: 0xC8,
  };
  let live = true, timer = 0, n = 0;
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 680;
  const g = cv.getContext('2d');
  const frame = () => {
    if (!live) return;
    const gr = g.createLinearGradient(0, 0, 0, 680); gr.addColorStop(0, '#0b1830'); gr.addColorStop(1, '#2c3a5a');
    g.fillStyle = gr; g.fillRect(0, 0, 1024, 680);
    g.fillStyle = '#05070a'; g.beginPath(); g.moveTo(0, 680);
    for (let x = 0; x <= 1024; x += 8) g.lineTo(x, 430 - 90 * Math.sin(x / 140) - 40 * Math.sin(x / 37 + 1) - 25 * Math.cos(x / 9));
    g.lineTo(1024, 680); g.fill();
    g.fillStyle = '#fff'; for (let i = 0; i < 60; i++) g.fillRect((i * 397) % 1024, (i * 113) % 360, 2, 2);
    g.font = '20px sans-serif'; g.fillText(`MOCK ${++n}`, 20, 660);
    fire('frame', { jpeg: cv.toDataURL('image/jpeg', 0.7).split(',')[1] });
  };
  return {
    addListener: async (ev, f) => { (fns[ev] ||= []).push(f); return { remove() {} }; },
    async start() {
      setTimeout(() => {
        fire('attached', { name: 'ILCE-6400 (mock)', supported: true, version: 0xC8, props });
        fire('status', { text: 'ILCE-6400 (mock) connected.', kind: 'ok' });
        timer = setInterval(frame, 120);
      }, 600);
      window.mockCamera = { detach: () => { clearInterval(timer); fire('detached', {}); }, props };
    },
    async setProperty({ name, value }) {
      const p = props[name];
      if (!p?.writable) throw new Error(`${name} is not settable`);
      await new Promise(r => setTimeout(r, 300));
      p.value = value; fire('props', props);
      return { props };
    },
    async setLive({ on }) { live = on; },
    async capture({ holdMs }) {
      const s = props.shutter.value === 0 ? holdMs / 1000 : shutterSeconds(props.shutter.value);
      await new Promise(r => setTimeout(r, Math.min(3000, s * 1000) + 300));
      return { files: [`mock_${Date.now()}.ARW`], onCard: false };
    },
    ladder: SHUTTER_LADDER,
  };
}
