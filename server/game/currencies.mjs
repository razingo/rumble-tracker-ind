// Currency names come from the game data: events.json's currencyNames, or rules.json's for older game data.
// The three event ticket slots (A, B, C) are shared by many events and reset between them, so each is named after the
// event using it now.
import { occurrences } from '../../web/scripts/lib/schedule.js';

/** { name, slot, event }. Only ticket currencies have a slot and an event; the event is null while no event uses it. */
export function currencyInfo(id, { events, rules, activeEvents = [], now = Date.now() }) {
  const slot = Object.entries(events?.currencies || {}).find(([, v]) => v === id)?.[0];
  if (!slot) {
    const role = Object.entries(rules?.currencyIds || {}).find(([, v]) => v === id)?.[0];
    return { name: events?.currencyNames?.[id] || rules?.currencyDefaultNames?.[role] || null };
  }
  // The schedule decides first, the latest start winning, because the save's list of running events is only as recent
  // as the last game session and can still name an event that has ended. The save's list covers events the game files
  // give no dates for.
  const users = (events.events || []).filter((ev) => ev.currency === slot);
  const scheduled = users
    .map((ev) => ({ ev, start: ev.schedule ? occurrences(ev, now, now + 1)[0]?.start : undefined }))
    .filter((x) => x.start !== undefined)
    .sort((a, b) => b.start - a.start);
  const live = scheduled[0]?.ev || users.find((ev) => activeEvents.includes(ev.saveId));
  const event = live ? live.name || live.id : null;
  return { name: event ? `${event} tickets` : 'Event tickets', slot, event };
}
