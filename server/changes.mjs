// Keeps track of which of the player's own entries changed and when, in changes.json:
//   { rev, records: { property: { key: { rev, t, deleted? } } } }
// Each change gets the next `rev`, a count that only goes up in this data folder, and the time `t`. An entry that was
// removed keeps its note with `deleted: true`, so that a removal can be told from an entry that was never there.
// Nothing reads the notes yet: they are there so that the data of two trackers can be put together later.
//
// Only what the player enters is tracked. The history the tracker keeps from the save (PvP readings, G.R.I.D.s,
// progress) is only ever added to, and each of its entries has an ID and a time of its own.

/** { key: entry } for a file kept as { account: { id: entry } }. */
const byAccountAndId = (contents) => Object.fromEntries(Object.entries(contents).flatMap(([account, entries]) =>
  Object.entries(entries || {}).map(([id, entry]) => [`${account}/${id}`, entry])));

// property -> its contents as { key: entry }, an entry being the smallest part that changes as one
export const RECORDS = {
  // accounts/<account ID> and units/<unit ID>
  names: (c) => ({
    ...Object.fromEntries(Object.entries(c.accounts || {}).map(([id, name]) => [`accounts/${id}`, name])),
    ...Object.fromEntries(Object.entries(c.units || {}).map(([id, slug]) => [`units/${id}`, slug])),
  }),
  talents: byAccountAndId, // <account ID>/<unit ID>
  army: byAccountAndId,    // <account ID>/<unit ID>
  plans: byAccountAndId,   // <account ID>/<event ID>
  // <account ID>/<army ID> (the order of the armies in their list is not tracked)
  armies: (c) => Object.fromEntries(Object.entries(c).flatMap(([account, list]) =>
    (list || []).filter((a) => a?.id).map((a) => [`${account}/${a.id}`, a]))),
};

const snapshot = (prop, contents) => new Map(Object.entries(RECORDS[prop](contents)).map(([k, v]) => [k, JSON.stringify(v)]));

/** What changes.json holds when it is whole. */
export const changesShape = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (v.rev === undefined || Number.isInteger(v.rev))
  && (v.records === undefined || (v.records !== null && typeof v.records === 'object' && !Array.isArray(v.records)));

/**
 * The notes of what changed. `log` is what changes.json held (changed in place) and `files` the data as it was
 * loaded, { property: contents }: changes are told by comparing a file with what it held when it was last noted.
 */
export function createChangeLog(log, files) {
  log.rev = Number.isInteger(log.rev) ? log.rev : 0;
  log.records ??= {};
  const known = new Map(Object.keys(RECORDS).map((prop) => [prop, snapshot(prop, files[prop])]));
  return {
    log,
    tracks: (prop) => known.has(prop),
    /** Notes what changed in a file since it was last noted. Returns whether anything did. */
    note(prop, contents, now = new Date()) {
      const before = known.get(prop), after = snapshot(prop, contents);
      const notes = (log.records[prop] ??= {});
      const t = now.toISOString();
      let changed = false;
      for (const [key, value] of after) {
        if (before.get(key) === value) continue;
        notes[key] = { rev: ++log.rev, t };
        changed = true;
      }
      for (const key of before.keys()) {
        if (after.has(key)) continue;
        notes[key] = { rev: ++log.rev, t, deleted: true };
        changed = true;
      }
      known.set(prop, after);
      return changed;
    },
  };
}
