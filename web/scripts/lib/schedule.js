// Event schedules and dungeon and raid rotations from gamedata/events.json. The Calendar and the server's
// notifications and currency names all use these, so they follow the same rules.
import { DAY } from './constants.js';

/** UTC time of the n-th weekday of a month at the given hour. */
function nthWeekdayUtc(y, m0, nth, weekday, hour) {
  const first = new Date(Date.UTC(y, m0, 1)).getUTCDay();
  return Date.UTC(y, m0, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7, hour);
}

/** Every run of an event overlapping [from, to): [{ start, end }] in ms. */
export function occurrences(ev, from, to) {
  const s = ev.schedule;
  const out = [];
  if (s.kind === 'once') {
    const a = Date.parse(s.start), b = Date.parse(s.end);
    if (b > from && a < to) out.push({ start: a, end: b });
    return out;
  }
  const until = s.until ? Date.parse(`${s.until}T23:59:59Z`) : Infinity;
  const y0 = Math.max(s.fromYear, new Date(from).getUTCFullYear() - 1);
  const y1 = new Date(to).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {
    const months = s.every === 'month' ? [...Array(12).keys()].filter((m) => y > s.fromYear || m >= s.month - 1) : [s.month - 1];
    for (const m of months) {
      const a = s.kind === 'nthWeekday' ? nthWeekdayUtc(y, m, s.nth, s.weekday, s.hourUtc) : Date.UTC(y, m, s.day, s.hourUtc);
      const b = a + s.days * DAY;
      if (a <= until && b > from && a < to) out.push({ start: a, end: b });
    }
  }
  return out;
}

/** The rotation entry active at time t: { item, start, end }. */
export function rotationAt(rot, t) {
  const t0 = Date.parse(rot.start), p = rot.periodDays * DAY;
  const k = Math.floor((t - t0) / p);
  const n = rot.list.length;
  return { item: rot.list[((k % n) + n) % n], start: t0 + k * p, end: t0 + (k + 1) * p };
}

/** Display name of a rotation entry: a string, or { name, type } ("… Siege"). */
export const rotationName = (item) => (typeof item === 'string' ? item : `${item.name}${item.type === 'Siege' ? ' Siege' : ''}`);
