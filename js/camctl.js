// camctl.js -- the camera controls shown over a USB camera's live view: ISO,
// shutter, aperture, exposure compensation, drive (self-timer, number of shots,
// interval, bulb time) and the shutter button. Talks to cameralink.CameraLink.
import { LABEL, choices, shutterLabel } from './cameralink.js?v=1122.0212-79fa2c9';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KEYS = ['iso', 'shutter', 'fnumber', 'ev'];

export function initCamCtl(link, { say, haptic = () => {} }) {
  const box = document.createElement('div');
  box.id = 'camCtl'; box.hidden = true;
  box.innerHTML = `
    <div class="cc-mode" id="ccMode"></div>
    ${KEYS.map(k => `<button class="cc-v" data-k="${k}"></button>`).join('')}
    <button class="cc-v" data-k="drive" id="ccDrive">1×</button>
    <button class="cc-shoot" id="ccShoot" aria-label="Take the picture"><span></span></button>
    <div class="cc-bat" id="ccBat"></div>`;
  const pick = document.createElement('div');
  pick.id = 'camPick'; pick.hidden = true;
  document.body.append(box, pick);
  const $ = id => document.getElementById(id);

  const drive = { delayS: 0, count: 1, intervalS: 0, bulbS: 30 };
  try { Object.assign(drive, JSON.parse(localStorage.getItem('moonshot.drive')) || {}); } catch { /* defaults */ }
  const saveDrive = () => { try { localStorage.setItem('moonshot.drive', JSON.stringify(drive)); } catch { /* not kept */ } };

  function sync() {
    const p = link.props;
    $('ccMode').textContent = p.mode ? LABEL.mode(p.mode.value) : '';
    for (const k of KEYS) {
      const b = box.querySelector(`[data-k="${k}"]`), v = p[k];
      b.textContent = v ? LABEL[k](v.value) : '–';
      b.disabled = !v || !v.writable;
    }
    $('ccBat').textContent = p.battery && p.battery.value >= 0 ? `${p.battery.value}%` : '';
    const bulb = p.shutter?.value === 0;
    $('ccDrive').textContent = [drive.delayS ? `${drive.delayS}s⏱` : '', drive.count > 1 ? `${drive.count}×` : '1×', bulb ? `${drive.bulbS}″` : ''].filter(Boolean).join(' ');
  }
  link.on('props', sync).on('attached', sync);

  // ---- value picker: the camera's own list
  let open = null;
  const closePick = () => { pick.hidden = true; open = null; };
  function showList(k) {
    const p = link.props[k], list = choices(k, p);
    if (!list.length) { say(`The camera gives no choices for ${k}.`, 'bad'); return; }
    open = k;
    pick.innerHTML = `<div class="cp-head">${{ iso: 'ISO', shutter: 'Shutter', fnumber: 'Aperture', ev: 'Exposure comp.' }[k]}<button class="cp-x" aria-label="Close">✕</button></div>
      <div class="cp-list">${list.map(v => `<button data-v="${v}" aria-pressed="${v === p.value}">${esc(LABEL[k](v))}</button>`).join('')}</div>`;
    pick.hidden = false;
    pick.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'center' });
  }
  function showDrive() {
    open = 'drive';
    const bulb = link.props.shutter?.value === 0;
    pick.innerHTML = `<div class="cp-head">Drive<button class="cp-x" aria-label="Close">✕</button></div>
      <div class="cp-form">
        <label>Self-timer<span class="seg" id="cdDelay">${[0, 2, 5, 10].map(s => `<button data-d="${s}" aria-pressed="${s === drive.delayS}">${s ? s + ' s' : 'Off'}</button>`).join('')}</span></label>
        <label>Shots<input id="cdCount" type="number" inputmode="numeric" min="1" max="9999" value="${drive.count}"></label>
        <label>Interval (s, start to start)<input id="cdInt" type="number" inputmode="decimal" min="0" step="0.5" value="${drive.intervalS}"></label>
        <label>Bulb time (s)${bulb ? '' : ' <small>(shutter on BULB)</small>'}<input id="cdBulb" type="number" inputmode="decimal" min="1" step="1" value="${drive.bulbS}"></label>
      </div>`;
    pick.hidden = false;
    const num = (id, min) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= min ? v : null; };
    pick.querySelector('#cdDelay').onclick = e => { const b = e.target.closest('button'); if (!b) return; drive.delayS = +b.dataset.d; pick.querySelectorAll('#cdDelay button').forEach(x => x.setAttribute('aria-pressed', x === b)); saveDrive(); sync(); };
    for (const [id, key, min] of [['cdCount', 'count', 1], ['cdInt', 'intervalS', 0], ['cdBulb', 'bulbS', 1]]) {
      $(id).onchange = () => { const v = num(id, min); if (v != null) drive[key] = key === 'count' ? Math.round(v) : v; $(id).value = drive[key]; saveDrive(); sync(); };
    }
  }
  box.addEventListener('click', e => {
    const b = e.target.closest('.cc-v'); if (!b) return;
    const k = b.dataset.k;
    if (open === k) { closePick(); return; }
    if (k === 'drive') showDrive(); else showList(k);
  });
  pick.addEventListener('click', async e => {
    if (e.target.closest('.cp-x')) { closePick(); return; }
    const b = e.target.closest('[data-v]'); if (!b || !open || open === 'drive') return;
    const k = open, v = +b.dataset.v;
    pick.querySelectorAll('[data-v]').forEach(x => x.setAttribute('aria-pressed', x === b));
    haptic();
    say(`Setting ${LABEL[k](v)}…`);
    try { await link.set(k, v); say(''); } catch (er) { say(er?.message || 'The camera did not take the setting.', 'bad'); }
    sync();
  });

  // ---- shutter
  const shoot = $('ccShoot');
  shoot.addEventListener('click', async () => {
    haptic();
    if (link.drive) { link.cancelDrive(); return; }
    closePick();
    shoot.classList.add('busy');
    let last = '';
    const fmt = ms => (ms >= 60000 ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : `${Math.ceil(ms / 1000)} s`);
    await link.runDrive({ ...drive }, p => {
      const of = p.total > 1 ? ` ${p.shot}/${p.total}` : '';
      if (p.phase === 'wait') say(`${last}Shot${of} in ${fmt(p.nextInMs)}`);
      else if (p.phase === 'shoot') say(`Shooting${of}${p.exposureS >= 1 ? ` (${shutterLabel(link.props.shutter?.value) === 'BULB' ? p.exposureS + ' s bulb' : shutterLabel(link.props.shutter.value)})` : ''}…`);
      else if (p.phase === 'done') {
        say(`Shot${of} taken${p.result?.files?.length ? `: ${p.result.files.join(', ')}` : ' (saved on the camera card)'}`, 'ok');
        last = p.total > 1 ? `${p.shot}/${p.total} done · ` : '';
      }
      else if (p.phase === 'error') say(`Shot${of} failed: ${p.error}`, 'bad');
      else if (p.phase === 'cancelled') say('Stopped.');
      else if (p.phase === 'finished' && p.total > 1) say(`All ${p.total} shots taken.`, 'ok');
    });
    shoot.classList.remove('busy');
  });

  return {
    show(on) { box.hidden = !on; if (!on) closePick(); sync(); },
  };
}
