// menu.js -- the Menu sheet: Location, Camera, Display, Info tabs. Built once from the app's
// functions (passed in by main.js, so there is no import cycle).
import { whereAmI, terrainEstimate, createPlace, listPlaces, openPlace, removePlace, updatePlace, storageUse, nameFor } from './places.js?v=1122.0212-79fa2c9';
import { pickSpot } from './mappick.js?v=1122.0212-79fa2c9';
import { SENSORS, FOCALS, frameSize, fovDeg, nearestFocalIndex } from './optics.js?v=1122.0212-79fa2c9';
import { tick } from './haptic.js?v=1122.0212-79fa2c9';
import { validZone, getZone, formatFull } from './tz.js?v=1122.0212-79fa2c9';
import { listPlans, savePlan, removePlan, defaultName } from './plans.js?v=1122.0212-79fa2c9';
import { addToCalendar, REMINDERS } from './calendar.js?v=1122.0212-79fa2c9';

const R2D = 180 / Math.PI;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MB = b => (b / 1e6 < 10 ? (b / 1e6).toFixed(1) : Math.round(b / 1e6)) + ' MB';
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

export function initMenu(api) {
  const { S } = api;
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = `
  <header>
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="place" aria-selected="true">Location</button>
      <button role="tab" data-tab="plans" aria-selected="false">Plans</button>
      <button role="tab" data-tab="camera" aria-selected="false">Camera</button>
      <button role="tab" data-tab="display" aria-selected="false">Display</button>
      <button role="tab" data-tab="info" aria-selected="false">Info</button>
    </div>
    <button class="x" id="sheetClose" aria-label="Close menu"><svg viewBox="0 0 18 18"><path d="M3 3l12 12M15 3L3 15"/></svg></button>
  </header>

  <div class="pane" data-pane="place">
    <div class="prompt" id="pPrompt" hidden></div>
    <div class="cur" id="pCur"></div>
    <div class="three four">
      <button class="btn" id="pHere">Current location</button>
      <button class="btn" id="pMap">Pick location</button>
      <button class="btn" id="pSolve">Pick subject</button>
      <button class="btn" id="pShadow">Shadow map</button>
    </div>
    <div class="msg" id="pMsg" role="status"></div>
    <div id="pNew" hidden>
      <div class="row"><label for="pName">Name</label><input type="text" id="pName" maxlength="60" autocomplete="off"></div>
      <div class="row"><label>How far to see</label>
        <div class="seg two" id="pReach">
          <button data-reach="normal" aria-pressed="true">Normal 60 km</button>
          <button data-reach="far" aria-pressed="false">Far 120 km</button>
        </div>
      </div>
      <div class="est" id="pEst"></div>
      <progress id="pProg" max="1" value="0" hidden></progress>
      <div class="two">
        <button class="btn go" id="pGo">Download</button>
        <button class="btn" id="pCancel">Cancel</button>
      </div>
    </div>
    <div class="row"><label for="pEye">Eye height above ground (m)</label><input type="number" id="pEye" inputmode="decimal" min="0" max="3000" step="0.1" value="1.7"></div>
    <div class="legend">Locations on this device</div>
    <div id="pList"></div>
    <div class="est" id="pStore"></div>
  </div>

  <div class="pane" data-pane="plans" hidden>
    <div class="cur" id="sCur"></div>
    <div class="row"><label for="sName">Name</label><input type="text" id="sName" maxlength="80" autocomplete="off"></div>
    <button class="btn go wide" id="sSave">Save this plan</button>
    <div class="msg" id="sMsg" role="status"></div>
    <div class="legend">Saved plans</div>
    <div id="sList"></div>
    <div class="legend">Calendar reminders</div>
    <div id="sRem"></div>
  </div>

  <div class="pane" data-pane="camera" hidden>
    <label class="sw">Camera mode<input id="cOn" type="checkbox"></label>
    <div class="row"><label for="cSensor">Sensor</label><select id="cSensor"></select></div>
    <div class="row"><label for="cFocal">Focal length (mm) <span id="cFov"></span></label>
      <div class="fread" id="cRead" aria-hidden="true"></div>
      <input type="range" id="cSlide" class="fslide" min="0" max="${FOCALS.length - 1}" step="1" value="0" aria-label="Focal length">
      <div class="fticks" id="cTicks" aria-hidden="true"></div>
      <input type="number" id="cFocal" inputmode="numeric" min="8" max="2000" step="1">
    </div>
    <div class="row"><label>Orientation</label>
      <div class="seg two" id="cOri"><button data-p="0" aria-pressed="true">Landscape</button><button data-p="1" aria-pressed="false">Portrait</button></div>
    </div>
    <label class="sw">Rule-of-thirds grid<input id="cThirds" type="checkbox"></label>
  </div>

  <div class="pane" data-pane="display" hidden>
    <label class="sw">Sun and moon paths<input id="dPaths" data-k="paths" type="checkbox"></label>
    <label class="sw">Ridge lines<input id="dRidges" data-k="ridges" type="checkbox"></label>
    <label class="sw">Peak names<input id="dPeaks" data-k="peaks" type="checkbox"></label>
    <label class="sw">Scales (compass ticks, level line)<input id="dScales" data-k="scales" type="checkbox"></label>
    <label class="sw">Thirds grid (camera mode)<input id="dThirds" data-k="thirds" type="checkbox"></label>
    <div class="row"><label>Time zone <span id="zCur"></span></label>
      <div class="seg two" id="zSeg"><button data-z="device" aria-pressed="true">Device</button><button data-z="UTC" aria-pressed="false">UTC</button></div>
      <div class="zrow"><input type="text" id="zName" placeholder="Zone name, e.g. America/Denver" autocapitalize="off" autocorrect="off" spellcheck="false"><button class="btn" id="zSet">Use</button></div>
      <div class="msg" id="zMsg" role="status"></div>
    </div>
  </div>

  <div class="pane" data-pane="info" hidden>
    <details class="info" open><summary>Credits</summary>
      <p>Terrain: <b>Mapzen / AWS Terrain Tiles</b>. Map and place search: &copy; <b>OpenStreetMap contributors</b> (also peak names, via Overpass). Astronomy: <b>astronomy-engine</b> (MIT, Don Cross). Map display: <b>Leaflet</b> (BSD-2-Clause).</p>
    </details>
    <details class="info" open><summary>Take care</summary>
      <p>Positions are computed, terrain is a 10 to 120 m model. Trees and buildings are not included. Check the scene on site.</p>
    </details>
    <p class="ver-line">Moonshot, version <span class="ver">dev</span></p>
  </div>`;

  const $ = id => sheet.querySelector('#' + id);
  const panes = [...sheet.querySelectorAll('.pane')], tabs = [...sheet.querySelectorAll('.tabs button')];
  const bar = document.getElementById('bar'), menuBtn = bar.querySelector('[data-k="menu"]');

  // ------------------------------------------------------------- sheet
  let current = 'place';
  function tab(name) {
    current = name;
    tabs.forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
    panes.forEach(p => { p.hidden = p.dataset.pane !== name; });
    if (name === 'place') refreshList();
    if (name === 'plans') refreshPlans();
  }
  function open(name = current, prompt = '') {
    tab(name);
    if (prompt) { $('pPrompt').textContent = prompt; $('pPrompt').hidden = false; }
    sheet.hidden = false; document.body.classList.add('sheet-open');
    menuBtn.setAttribute('aria-pressed', true);
  }
  function close() {
    sheet.hidden = true; document.body.classList.remove('sheet-open');
    menuBtn.setAttribute('aria-pressed', false);
  }
  tabs.forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
  $('sheetClose').addEventListener('click', close);
  menuBtn.addEventListener('click', () => (sheet.hidden ? open() : close()));
  addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden && !document.querySelector('.mp-root')) close(); });

  // ------------------------------------------------------------- place
  let draft = null, abort = null, reach = 'normal', busy = false;
  const say = (t, bad = true) => { const m = $('pMsg'); m.textContent = t || ''; m.className = 'msg' + (t && bad ? ' bad' : ''); };
  const eyeValue = () => { const v = parseFloat($('pEye').value); return v >= 0 && v <= 3000 ? v : 1.7; };

  function showCurrent() {
    const p = S.place;
    $('pCur').innerHTML = p ? `Showing <b>${esc(p.name)}</b>${p.id ? ` <small>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}, reach ${p.reach === 'far' ? 120 : 60} km</small>` : ' <small>(built-in test terrain)</small>'}` : '';
    if (document.activeElement !== $('pEye') && p) $('pEye').value = p.eyeM;
  }

  // The name box starts with the best name the map knows for the spot (town, park, road...);
  // whatever the user types wins. Returns a promise for the name once looked up.
  function showDraft(d) {
    draft = d;
    $('pNew').hidden = false;
    const box = $('pName');
    box.value = d.name || ''; box.placeholder = 'Looking up a name…'; box.dataset.auto = '1';
    updateEst();
    $('pNew').scrollIntoView?.({ block: 'nearest' });
    const want = d;
    return autoName(d).then(n => {
      if (draft !== want) return n;
      box.placeholder = 'Name this location';
      if (n && box.dataset.auto === '1') box.value = n;
      return box.value.trim() || n;
    });
  }
  $('pName').addEventListener('input', () => { $('pName').dataset.auto = ''; });

  const EV = { moon: ['Moonrise', 'Moonset'], sun: ['Sunrise', 'Sunset'], gc: ['Milky Way rise', 'Milky Way set'] };
  async function autoName(d) {
    if (d.name && !d.plan) return d.name;                       // a search result already has its name
    const spot = await nameFor(d.lat, d.lon);
    if (!d.plan) return spot?.name || null;
    const ev = EV[d.plan.body]?.[d.plan.kind === 'rise' ? 0 : 1] || 'Subject';
    const sj = d.plan.subject;
    let subj = sj?.name || null;
    if (!subj && sj) { const r = await nameFor(sj.lat, sj.lon, { zoom: 14 }); subj = r?.feature ? r.name.split(',')[0] : null; }
    return [subj ? `${ev} over ${subj}` : ev, spot?.name].filter(Boolean).join(' · ');
  }
  function updateEst() {
    if (!draft) return;
    try {
      const e = terrainEstimate(draft.lat, draft.lon, reach);
      $('pEst').textContent = `${draft.lat.toFixed(4)}, ${draft.lon.toFixed(4)}. About ${MB(e.downloadBytes)} to download, ${MB(e.storeBytes)} kept on this device.`;
    } catch (e) { $('pEst').textContent = e.message; }
  }
  $('pReach').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || busy) return;
    reach = b.dataset.reach;
    $('pReach').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    updateEst();
  });

  const lines = () => S.sm ? [
    { azDeg: S.sm.moon.az * R2D, color: '#dfe8ff', label: 'Moon' },
    { azDeg: S.sm.sun.az * R2D, color: '#ffd76a', label: 'Sun' },
  ] : [];

  $('pHere').addEventListener('click', async () => {
    if (busy) return;
    say('Finding your current location…', false); $('pHere').disabled = true;
    try {
      const p = await whereAmI();
      say(`Position found, accurate to about ${Math.round(p.acc)} m.`, false);
      showDraft({ lat: p.lat, lon: p.lon, name: null });
    } catch (e) { say(e.message); } finally { $('pHere').disabled = false; }
  });
  const openMap = async mode => {
    if (busy) return;
    say('');
    const start = S.place?.id ? { lat: S.place.lat, lon: S.place.lon } : {};
    sheet.hidden = true;
    let r = null;
    try { r = await pickSpot({ ...start, lines: lines(), mode, date: S.date, onTime: d => api.setTime(d) }); } catch (e) { say(e.message); }
    sheet.hidden = false;
    if (!r) return;
    const named = showDraft({ lat: r.lat, lon: r.lon, name: r.name, plan: r.plan || null });
    if (r.plan) {                          // a solver spot goes straight on: name it, download, then the main view at the alignment time
      say('Naming the spot…', false);
      await Promise.race([named, new Promise(res => setTimeout(res, 3000))]);
      $('pGo').click();
    }
  };
  $('pMap').addEventListener('click', () => openMap('spot'));
  $('pSolve').addEventListener('click', () => openMap('solver'));
  $('pShadow').addEventListener('click', () => openMap('shadow'));

  function setBusy(on) {
    busy = on;
    $('pProg').hidden = !on;
    $('pGo').disabled = on;
    for (const id of ['pHere', 'pMap', 'pSolve', 'pShadow', 'pName']) $(id).disabled = on;
    $('pCancel').textContent = on ? 'Cancel download' : 'Cancel';
  }
  $('pCancel').addEventListener('click', () => {
    if (busy) { abort?.abort(); return; }
    draft = null; $('pNew').hidden = true; say('');
  });
  $('pGo').addEventListener('click', async () => {
    if (!draft || busy) return;
    const d = draft, name = $('pName').value.trim() || d.name || `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;
    abort = new AbortController(); setBusy(true); $('pProg').value = 0; say('Starting…', false);
    try {
      const r = await createPlace({ name, lat: d.lat, lon: d.lon, eyeM: eyeValue(), reach }, (f, m) => { $('pProg').value = f; say(m, false); }, abort.signal);
      say('Building the horizon…', false);
      await nextFrame();
      api.usePlace(r);
      if (d.plan) api.applyPlan(d.plan);   // solver result: the alignment moment, aimed at the subject
      if (d.saved) api.loadPlan(d.saved);  // a saved plan whose place was not on this device
      draft = null; $('pNew').hidden = true; $('pPrompt').hidden = true;
      say(r.place.saved ? '' : 'This device would not keep the place, so it works until you close the page.');
      refreshList();
      if (r.place.saved || d.plan || d.saved) close();
    } catch (e) {
      say(e?.name === 'AbortError' ? 'Download canceled.' : (e?.message || 'The download failed.'), e?.name !== 'AbortError');
    } finally { setBusy(false); abort = null; }
  });

  $('pEye').addEventListener('change', async () => {
    const v = parseFloat($('pEye').value);
    if (!(v >= 0 && v <= 3000)) { $('pEye').value = S.place?.eyeM ?? 1.7; return; }
    if (!S.place) return;
    const id = S.place.id;
    api.setEye(v);                                   // horizon only, no download
    if (id) { try { await updatePlace(id, { eyeM: v }); } catch (e) { say(e.message); } }
  });

  async function refreshList() {
    showCurrent();
    let list = [];
    try { list = await listPlaces(); } catch { /* storage blocked */ }
    const box = $('pList');
    const rows = [`<div class="area"><button class="sel" data-demo="1"><b>Demo ridge</b><small>Built-in test terrain, no download</small></button><span class="tag">${S.place && !S.place.id ? 'In use' : ''}</span></div>`];
    for (const p of list) {
      const on = S.place?.id === p.id;
      rows.push(`<div class="area"><button class="sel" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><small>${p.lat.toFixed(3)}, ${p.lon.toFixed(3)} &middot; ${p.reach === 'far' ? 120 : 60} km${p.saved ? '' : ' &middot; this session only'}</small></button><span class="acts"><button class="btn" data-ren="${esc(p.id)}" aria-label="Rename ${esc(p.name)}">Rename</button>${on ? '<span class="tag">In use</span>' : `<button class="btn danger" data-del="${esc(p.id)}">Delete</button>`}</span></div>`);
    }
    box.innerHTML = rows.join('');
    const u = await storageUse();
    $('pStore').textContent = u ? `Using ${MB(u.used)} of the ${MB(u.quota)} this browser allows.` : '';
  }
  $('pList').addEventListener('click', async e => {
    const sel = e.target.closest('.sel'), del = e.target.closest('[data-del]'), ren = e.target.closest('[data-ren]');
    if (ren) {
      const id = ren.dataset.ren, old = ren.closest('.area').querySelector('.sel b')?.textContent || '';
      const name = prompt('Name this location', old)?.trim();
      if (!name || name === old) return;
      try {
        await updatePlace(id, { name });
        if (S.place?.id === id) { S.place.name = name; api.invalidate(); document.getElementById('statName').textContent = name; }
      } catch (er) { say(er.message); }
      refreshList(); return;
    }
    if (sel && !busy) {
      if (sel.dataset.demo) { api.useDemo(); close(); return; }
      say('Opening…', false);
      try { api.usePlace(await openPlace(sel.dataset.id)); say(''); close(); } catch (er) { say(er.message); }
    } else if (del) {
      if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Sure?'; setTimeout(() => { del.dataset.sure = ''; del.textContent = 'Delete'; }, 3000); return; }
      try { await removePlace(del.dataset.del); } catch (er) { say(er.message); }
      refreshList();
    }
  });

  // ------------------------------------------------------------- plans
  const sSay = (t, bad = false) => { const m = $('sMsg'); m.textContent = t || ''; m.className = 'msg' + (t && bad ? ' bad' : ''); };
  let remind = ['day', '2h', 'leave'];
  try { const v = JSON.parse(localStorage.getItem('moonshot.remind')); if (Array.isArray(v)) remind = v; } catch { /* defaults */ }
  $('sRem').innerHTML = REMINDERS.map(r => `<label class="sw">${esc(r.label)}<input type="checkbox" data-rem="${r.id}"${remind.includes(r.id) ? ' checked' : ''}></label>`).join('');
  $('sRem').addEventListener('change', () => {
    remind = [...$('sRem').querySelectorAll('input:checked')].map(i => i.dataset.rem);
    try { localStorage.setItem('moonshot.remind', JSON.stringify(remind)); } catch { /* not kept */ }
  });
  let plans = [];
  const until = t => {
    const d = (Date.parse(t) - Date.now()) / 864e5;
    return d < -0.05 ? 'past' : d < 1 ? 'within a day' : `in ${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
  };
  async function refreshPlans() {
    const ok = !!S.place?.id;
    $('sCur').innerHTML = ok ? `Saves <b>${esc(S.place.name)}</b> at ${esc(formatFull(S.date))}: the aim, the lens${S.subject ? ', the subject' : ''} and the layers shown.`
      : 'Choose a downloaded location first: a plan is saved for a place on this device.';
    $('sSave').disabled = !ok;
    if (document.activeElement !== $('sName')) { $('sName').value = ''; $('sName').placeholder = ok ? defaultName(S) : ''; }
    try { plans = await listPlans(); } catch { plans = []; }
    $('sList').innerHTML = plans.length ? plans.map(p => `<div class="area"><button class="sel" data-open="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(formatFull(new Date(p.time)))} &middot; ${until(p.time)}</small></button><span class="acts"><button class="btn" data-cal="${esc(p.id)}">Calendar</button><button class="btn danger" data-pdel="${esc(p.id)}">Delete</button></span></div>`).join('')
      : '<div class="est">No plans yet. Set up a shot (place, time, aim, lens), then save it here.</div>';
  }
  $('sSave').addEventListener('click', async () => {
    const plan = api.currentPlan($('sName').value.trim() || null);
    if (!plan) return;
    try { await savePlan(plan); $('sName').value = ''; sSay(`Saved “${plan.name}”. Add it to your calendar below.`); tick(); } catch (e) { sSay(e.message, true); }
    refreshPlans();
  });
  const planLink = p => {
    if (window.Capacitor?.isNativePlatform?.() || !/^https?:/.test(location.protocol)) return null;
    const v = p.view, c = p.camera;
    const h = [`lat=${p.place.lat.toFixed(5)}`, `lon=${p.place.lon.toFixed(5)}`, `t=${p.time.replace(/\.\d+Z$/, 'Z')}`, `az=${v.azDeg.toFixed(1)}`, `alt=${v.altDeg.toFixed(1)}`,
      c?.on ? `cam=${c.sensor},${Math.round(c.focal)},${c.portrait ? 'p' : 'l'}` : `fov=${v.hfovDeg.toFixed(1)}`, `plan=${p.id}`];
    return `${location.origin}${location.pathname}#${h.join('&')}`;
  };
  async function openPlan(p) {
    sSay('Opening…');
    try {
      if (S.place?.id !== p.place.id) {
        let r = null;
        try { r = await openPlace(p.place.id); } catch { /* deleted, or made on another device */ }
        if (!r) {
          const near = (await listPlaces()).find(x => Math.hypot((x.lat - p.place.lat) * 110540, (x.lon - p.place.lon) * 111320 * Math.cos(x.lat * Math.PI / 180)) <= 50);
          if (near) r = await openPlace(near.id);
        }
        if (!r) {                          // the terrain is not here: download it, then load the plan
          sSay('');
          reach = p.place.reach || 'normal';
          $('pReach').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.reach === reach));
          $('pEye').value = p.place.eyeM ?? 1.7;
          open('place', `The terrain for “${p.name}” is not on this device. Download it to load the plan.`);
          showDraft({ lat: p.place.lat, lon: p.place.lon, name: p.place.name, saved: p });
          return;
        }
        api.usePlace(r);
      }
      api.loadPlan(p); sSay(''); close();
    } catch (e) { sSay(e.message, true); }
  }
  $('sList').addEventListener('click', async e => {
    const o = e.target.closest('[data-open]'), c = e.target.closest('[data-cal]'), d = e.target.closest('[data-pdel]');
    const p = plans.find(x => x.id === (o?.dataset.open || c?.dataset.cal || d?.dataset.pdel));
    if (!p) return;
    if (o) openPlan(p);
    else if (c) {
      try {
        const r = await addToCalendar(p, { reminders: remind, url: planLink(p) });
        sSay(r === 'saved' ? 'Added to your calendar.' : r === 'file' ? 'Calendar file made: open it to add the event.' : '');
      } catch (er) { sSay(er.message || 'The calendar could not be opened.', true); }
    } else if (d) {
      if (d.dataset.sure !== '1') { d.dataset.sure = '1'; d.textContent = 'Sure?'; setTimeout(() => { d.dataset.sure = ''; d.textContent = 'Delete'; }, 3000); return; }
      await removePlan(p.id).catch(() => {}); refreshPlans();
    }
  });

  // ------------------------------------------------------------- camera
  $('cSensor').innerHTML = SENSORS.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('cTicks').innerHTML = [9, 14, 24, 35, 50, 85, 135, 200, 400, 800].map(f =>
    `<span style="--p:${FOCALS.indexOf(f) / (FOCALS.length - 1)}">${f}</span>`).join('');
  let slideIdx = -1, sliding = false;
  $('cOn').addEventListener('change', e => api.setCamera({ on: e.target.checked }));
  $('cSensor').addEventListener('change', e => api.setCamera({ sensor: e.target.value }));
  $('cSlide').addEventListener('input', e => {
    const i = +e.target.value, moved = i !== slideIdx;
    slideIdx = i; sliding = true;
    api.setCamera({ focal: FOCALS[i] });
    sliding = false;
    if (moved) tick();
  });
  $('cFocal').addEventListener('change', e => api.setCamera({ focal: +e.target.value }));
  $('cOri').addEventListener('click', e => { const b = e.target.closest('button'); if (b) api.setCamera({ portrait: b.dataset.p === '1' }); });
  $('cThirds').addEventListener('change', e => { S.show.thirds = e.target.checked; api.requestDraw(); syncDisplay(); });

  function syncCamera() {
    const c = S.camera, s = SENSORS.find(x => x.id === c.sensor) || SENSORS[0], f = frameSize(s, c.portrait);
    $('cOn').checked = c.on; $('cSensor').value = c.sensor;
    if (document.activeElement !== $('cFocal')) $('cFocal').value = c.focal;
    const sl = $('cSlide'), idx = nearestFocalIndex(c.focal);
    if (!sliding) { sl.value = idx; slideIdx = idx; }
    sl.setAttribute('aria-valuetext', `${c.focal} mm`);
    $('cRead').textContent = `${c.focal} mm`;
    $('cOri').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', (b.dataset.p === '1') === c.portrait));
    $('cFov').textContent = `${fovDeg(f.w, c.focal).toFixed(2)}° × ${fovDeg(f.h, c.focal).toFixed(2)}°`;
    $('cThirds').checked = S.show.thirds;
  }

  // ------------------------------------------------------------- display
  const swIds = ['dPaths', 'dRidges', 'dPeaks', 'dScales', 'dThirds'];
  for (const id of swIds) $(id).addEventListener('change', e => {
    S.show[e.target.dataset.k] = e.target.checked; api.invalidate(); syncCamera();
  });
  function syncDisplay() {
    for (const id of swIds) $(id).checked = !!S.show[$(id).dataset.k];
    const z = getZone();
    $('zSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.z === z));
    $('zCur').textContent = z === 'device' ? 'device' : z;
    if (document.activeElement !== $('zName')) $('zName').value = z !== 'device' && z !== 'UTC' ? z : '';
  }
  $('zSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { api.setTz(b.dataset.z); $('zMsg').textContent = ''; syncDisplay(); } });
  const applyZone = () => {
    const name = $('zName').value.trim(), m = $('zMsg');
    if (!name) { m.textContent = 'Type a zone name such as Europe/Paris, or choose Device.'; m.className = 'msg bad'; return; }
    if (!validZone(name)) { m.textContent = `"${name}" is not a time zone this browser knows. Use names like America/Denver or Asia/Tokyo.`; m.className = 'msg bad'; return; }
    api.setTz(name); m.textContent = ''; m.className = 'msg'; syncDisplay();
  };
  $('zSet').addEventListener('click', applyZone);
  $('zName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyZone(); } });

  api.onChange(() => { syncCamera(); syncDisplay(); if (!sheet.hidden && current === 'place') showCurrent(); });
  syncCamera(); syncDisplay(); showCurrent();

  return { open, close, tab, note: t => say(t), say, openPlan };
}
