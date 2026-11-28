// The version of what the player's data files hold, and the steps that bring older data up to it. The version is one
// number for all the files together, noted in schema.json in the data folder and in every backup. Data without a note
// is version 1, which is what every tracker before 0.6.10 wrote. docs/DATA-FORMAT.md describes the files.
//
// To change what a file holds: raise SCHEMA, add a step for it and describe the change in docs/DATA-FORMAT.md. A step
// must leave data alone that already has the change, as a backup is only restored in parts and its step then runs
// over files that were not restored too.
import { newId } from '../web/scripts/lib/ids.js';

export const SCHEMA = 2;

/** Gives an ID to the entries of each account's list that have none. Returns whether any did. */
export function giveIds(byAccount) {
  let changed = false;
  for (const list of Object.values(byAccount || {})) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (entry.id) continue;
      entry.id = newId();
      changed = true;
    }
  }
  return changed;
}

// [{ to: the version a step brings the data to, run(files): the properties it changed }], oldest first.
// `files` is { property: contents } as in userdata.mjs.
const STEPS = [
  // 2 (0.6.11): PvP readings and G.R.I.D.s have an ID
  { to: 2, run: (files) => ['pvpHistory', 'gridHistory'].filter((prop) => giveIds(files[prop])) },
];

/** Brings `files` from version `from` up to date, in place. Returns the properties that changed. */
export function migrate(files, from, steps = STEPS) {
  const changed = new Set();
  for (const step of steps) {
    if (step.to > from) for (const prop of step.run(files)) changed.add(prop);
  }
  return [...changed];
}

/** The version a note or a backup names: a whole number from 1, else 1. */
export const schemaOf = (v) => (Number.isInteger(v) && v >= 1 ? v : 1);
