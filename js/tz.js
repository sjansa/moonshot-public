// tz.js -- the one place that turns instants into text. No DOM.
// zone is 'device', 'UTC' or an IANA name. Everything the app shows as a time,
// date or day boundary goes through here.

let zone = 'device';

/** Is name a zone Intl accepts? */
export function validZone(name) {
  if (!name || typeof name !== 'string') return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: name }); return true; } catch { return false; }
}

export function getZone() { return zone; }
/** Set the zone; returns false (and changes nothing) if it is not valid. */
export function setZone(z) {
  if (z !== 'device' && !validZone(z)) return false;
  zone = z;
  return true;
}
/** Zone name for Intl, undefined for the device's own. */
const tzOpt = () => (zone === 'device' ? undefined : zone);

const cache = new Map();
function dtf(key, opts) {
  const k = zone + '|' + key;
  let f = cache.get(k);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tzOpt(), hourCycle: 'h23', ...opts }); cache.set(k, f); }
  return f;
}
const O = {
  hm: { hour: '2-digit', minute: '2-digit' },
  h: { hour: '2-digit' },
  d: { day: 'numeric' },
  date: { weekday: 'short', day: 'numeric', month: 'short' },
  ymd: { year: 'numeric', month: '2-digit', day: '2-digit' },
  full: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
  name: { timeZoneName: 'short', hour: '2-digit' },
};
function parts(d, key) {
  const o = {};
  for (const p of dtf(key, O[key]).formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** what: 'time' HH:MM (24 h), 'hour' HH, 'day' day number, 'date' "Wed 25 Nov". */
export function format(d, what = 'time') {
  if (what === 'time') { const p = parts(d, 'hm'); return `${p.hour}:${p.minute}`; }
  if (what === 'hour') return parts(d, 'h').hour;
  if (what === 'day') return parts(d, 'd').day;
  const p = parts(d, 'date');
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** Short zone label for display: "UTC", "MST", "GMT+2"... */
export function zoneName(d) { return parts(d, 'name').timeZoneName || ''; }

/** "Wed 25 Nov 17:30 MST" */
export function formatFull(d) { return `${format(d, 'date')} ${format(d, 'time')} ${zoneName(d)}`.trim(); }

/** yyyy-mm-dd of d in the zone, for <input type="date">. */
export function dateInputValue(d) { const p = parts(d, 'ymd'); return `${p.year}-${p.month}-${p.day}`; }

/** The instant that shows y-m-d hh:mm in the zone (iterates on the zone offset). */
function zonedToInstant(y, m, d, hh, mm) {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let g = want;
  for (let i = 0; i < 3; i++) {
    const q = parts(new Date(g), 'full');
    g += want - Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute);
  }
  return new Date(g);
}

/** The date in "yyyy-mm-dd" at the clock time of d (in the zone). */
export function dateFromInput(str, d) {
  const c = parts(d, 'hm'), [y, m, dd] = str.split('-').map(Number);
  return zonedToInstant(y, m, dd, +c.hour, +c.minute);
}

/** Start (00:00) of the zone's calendar day that contains d. */
export function dayStart(d) {
  const p = parts(d, 'ymd');
  return zonedToInstant(+p.year, +p.month, +p.day, 0, 0);
}
