// Display formatting shared by the page and the server. Numbers and dates are always shown in en-US.
import { SECOND, MINUTE, HOUR, DAY, MB } from './constants.js';

const LOCALE = 'en-US';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (n) => (typeof n === 'number' ? n.toLocaleString(LOCALE) : n);
/** "1 win", "3 wins". `many` defaults to `one` with an s. */
export const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
export const megabytes = (bytes) => (bytes / MB).toFixed(1);

const dateFormat = (options) => (t) => new Date(t).toLocaleString(LOCALE, options);
/** "Thu, Nov 19, 7:00 PM" */
export const when = dateFormat({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "Nov 19, 7:00 PM" */
export const dateTime = dateFormat({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "Nov 19" */
export const dayOnly = dateFormat({ month: 'short', day: 'numeric' });
/** "Nov 19, 2026" */
export const dayWithYear = dateFormat({ month: 'short', day: 'numeric', year: 'numeric' });
/** "Thursday, November 19" */
export const longDay = dateFormat({ weekday: 'long', month: 'long', day: 'numeric' });
/** "Thu, Nov 19" */
export const shortDay = dateFormat({ weekday: 'short', month: 'short', day: 'numeric' });
/** "Thu 7:00 PM" */
export const weekdayTime = dateFormat({ weekday: 'short', hour: 'numeric', minute: '2-digit' });
/** "7:00 PM" */
export const timeOnly = dateFormat({ hour: 'numeric', minute: '2-digit' });

/** The local calendar day of a time as YYYY-MM-DD. A key for daily records, not for display. */
export function localDay(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A countdown in short form: "2d 3h", "4h 12m", "35m". */
export function span(ms) {
  const m = Math.max(0, Math.round(ms / MINUTE));
  const perDay = DAY / MINUTE, perHour = HOUR / MINUTE;
  const d = Math.floor(m / perDay), h = Math.floor((m % perDay) / perHour), min = m % perHour;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${min}m`;
  return `${min}m`;
}

/** A duration for a sentence: "2 days", "5 hours", "20 minutes". */
export function spanWords(ms) {
  if (ms >= 2 * DAY) return plural(Math.round(ms / DAY), 'day');
  if (ms >= HOUR) return plural(Math.round(ms / HOUR), 'hour');
  return plural(Math.max(1, Math.round(ms / MINUTE)), 'minute');
}

/** How long ago a time was: "12 seconds ago", "5 minutes ago", "3 hours ago", then the date. */
export function ago(t) {
  if (!t) return 'never';
  const ms = Math.max(0, Date.now() - new Date(t));
  if (ms < SECOND / 2) return 'just now';
  if (ms < MINUTE) return `${plural(Math.round(ms / SECOND), 'second')} ago`;
  if (ms < HOUR) return `${plural(Math.round(ms / MINUTE), 'minute')} ago`;
  if (ms < DAY) return `${plural(Math.round(ms / HOUR), 'hour')} ago`;
  return dateTime(t);
}

/** Game text in capitals ("MAJOR TOME") in title case ("Major Tome"); other text unchanged. */
export const titleCase = (s) => (s && s === s.toUpperCase()
  ? s.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/'S\b/g, "'s")
  : s);
