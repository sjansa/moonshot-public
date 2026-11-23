// calendar.js -- put a saved plan in the phone's calendar. In the native app the system's own
// event editor opens, filled in (alerts, the spot as a map location; travel time can be set
// there). In a browser an .ics file is offered, which every calendar app opens.
import { formatFull } from './tz.js?v=1122.2110-c56454d';
import { SENSORS } from './optics.js?v=1122.2110-c56454d';

export const SETUP_MIN = 30, AFTER_MIN = 15;       // the event runs from set-up time to a little after the moment
/** Reminder choices: id -> seconds before the event starts. 'leave' is the OS's travel-time alert. */
export const REMINDERS = [
  { id: 'day', label: 'Day before', s: 86400 },
  { id: '2h', label: '2 hours before', s: 7200 },
  { id: 'leave', label: 'Time to leave (travel time)', s: null },
];

const BODY = { moon: 'Moon', sun: 'Sun', gc: 'Milky Way core' };
const compass = az => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((az % 360) + 360) % 360 / 22.5) % 16];

/** The event for a plan: {title, start, end (ms), location, lat, lon, notes, url, alarms (s before start), travel}. */
export function planEvent(plan, { reminders = ['day', '2h', 'leave'], url = null } = {}) {
  const t = Date.parse(plan.time), p = plan.place, v = plan.view, c = plan.camera, sj = plan.subject;
  const lines = [`Shot at ${formatFull(new Date(t))}.`,
    `Stand at ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${p.name ? ` (${p.name})` : ''}.`,
    `Aim ${Math.round(v.azDeg)}° ${compass(v.azDeg)}, ${v.altDeg.toFixed(1)}° up.`];
  if (sj) lines.push(`${BODY[sj.body] || 'Subject'} ${sj.kind === 'set' ? 'sets' : 'rises'} behind ${sj.target?.name || 'the subject'} at ${sj.azDeg.toFixed(1)}°, ${sj.altDeg.toFixed(2)}° up.`);
  if (c?.on) lines.push(`Lens ${Math.round(c.focal)} mm on ${(SENSORS.find(s => s.id === c.sensor) || {}).name || c.sensor}, ${c.portrait ? 'portrait' : 'landscape'}.`);
  lines.push(url ? `Open the plan: ${url}` : 'Open Moonshot, Menu > Plans, to load the plan.');
  return {
    title: plan.name, start: t - SETUP_MIN * 60e3, end: t + AFTER_MIN * 60e3,
    location: p.name || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, lat: p.lat, lon: p.lon,
    notes: lines.join('\n'), url,
    alarms: REMINDERS.filter(r => r.s && reminders.includes(r.id)).map(r => r.s),
    travel: reminders.includes('leave'),
  };
}

const icsDate = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// lines longer than 75 octets are folded (RFC 5545 3.1); counting characters is close enough for this text
const fold = l => l.length <= 74 ? l : l.match(/.{1,73}/gu).join('\r\n ');

/** An iCalendar file for one event, with its alerts. Apple's calendar adds the travel-time alert. */
export function icsFor(ev, uid = `${ev.start}@moonshot`) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Moonshot//Plan//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(ev.start)}`, `DTEND:${icsDate(ev.end)}`,
    `SUMMARY:${icsText(ev.title)}`, `LOCATION:${icsText(ev.location)}`, `GEO:${ev.lat.toFixed(6)};${ev.lon.toFixed(6)}`,
    `DESCRIPTION:${icsText(ev.notes)}`];
  if (ev.url) L.push(`URL:${ev.url}`);
  L.push(`X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=50;X-TITLE="${String(ev.location).replace(/"/g, "'")}":geo:${ev.lat.toFixed(6)},${ev.lon.toFixed(6)}`);
  if (ev.travel) L.push('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
  for (const s of ev.alarms) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(ev.title)}`, `TRIGGER:-PT${Math.round(s / 60)}M`, 'END:VALARM');
  L.push('END:VEVENT', 'END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

const native = () => {
  const C = typeof window !== 'undefined' && window.Capacitor;
  if (!C?.isNativePlatform?.()) return null;
  try { return C.registerPlugin ? C.registerPlugin('Calendar') : C.Plugins?.Calendar || null; } catch { return null; }
};

/**
 * Offer the plan to the calendar. Resolves to 'saved', 'canceled' (native editor closed without
 * saving) or 'file' (an .ics handed to the browser).
 */
export async function addToCalendar(plan, opts) {
  const ev = planEvent(plan, opts), cal = native();
  if (cal) {
    const r = await cal.addEvent({ ...ev, travel: undefined });
    return r?.saved ? 'saved' : 'canceled';
  }
  const blob = new Blob([icsFor(ev, `${plan.id}@moonshot`)], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (plan.name || 'plan').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) + '.ics';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
  return 'file';
}
