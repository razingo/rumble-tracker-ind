// Scans: reads the save, updates each account's snapshot (state/<id>.json) and the history kept from it.
import path from 'node:path';
import { writeJson, isRecord } from '../store.mjs';
import { parsePvp } from '../game/pvp.mjs';
import { parseUnits, parseCurrencies, parseActiveEvents, parseIncomeBonuses, parseOwnedAvatars, parseStore,
  parseGameBuild, diffSnapshots } from '../game/model.mjs';
import { recordProgress, logGrid, recordPvp } from './history.mjs';
import { accountLabel } from '../userdata.mjs';

const MAX_EVENTS = 500;
// Reads can collide with the game saving; only failures that persist are reported.
export const FAILS_BEFORE_ERROR = 3;
// What state/<id>.json holds: the changes seen, and the last snapshot once there is one.
const stateShape = (v) => isRecord(v) && Array.isArray(v.events)
  && (v.snapshot == null || (isRecord(v.snapshot) && Array.isArray(v.snapshot.units) && Array.isArray(v.snapshot.currencies)));

/** readPrefs(): { [account]: { units, currencies, store, profile, commerce, pvp: Buffer } } (game/prefs.mjs). */
export function createScanner(ctx, { readPrefs }) {
  const failures = new Map(); // 'read', 'save', an account id or 'update <id>' -> consecutive failures
  const unsaved = new Set(); // user-data files changed in memory that are still to be written
  const unsavedStates = new Set(); // accounts whose state/<id>.json is still to be written
  const status = ctx.scan;
  const sourceOf = (key) => (key === 'read' ? 'reading the save' : key === 'save' ? 'saving the history'
    : key.startsWith('update ') ? 'updating an account' : 'decoding the save');

  // logMessage omits user-given names, for problem reports and tracker.log
  function noteFailure(key, message, logMessage = message) {
    const n = (failures.get(key) || 0) + 1;
    failures.set(key, n);
    if (n >= FAILS_BEFORE_ERROR) {
      status.lastError = message;
      status.lastErrorLog = logMessage;
      ctx.errorLog.add(sourceOf(key), logMessage);
    }
  }
  function noteSuccess(key) {
    failures.delete(key);
    if (![...failures.values()].some((n) => n >= FAILS_BEFORE_ERROR)) {
      status.lastError = null;
      status.lastErrorLog = null;
    }
  }

  /** The account's state, loaded from state/<id>.json on first use (and moved from an older form). */
  async function account(id, dirty) {
    let acc = ctx.accounts.get(id);
    if (acc) return acc;
    acc = await ctx.readUserJson(path.join(ctx.paths.STATE, `${id}.json`), { snapshot: null, events: [] }, stateShape);
    ctx.accounts.set(id, acc);
    if (acc.pvpLog) { // the earlier tracker, whose data this one uses, kept the PvP log here
      if (!ctx.user.pvpHistory[id]) {
        ctx.user.pvpHistory[id] = acc.pvpLog;
        dirty.add('pvpHistory');
      }
      delete acc.pvpLog;
    }
    return acc;
  }

  /** The units and currencies in the save, or null when a value was caught while the game was saving. */
  function decodeCollection(id, entries) {
    try {
      const collection = { units: parseUnits(entries.units), currencies: parseCurrencies(entries.currencies) };
      noteSuccess(id);
      return collection;
    } catch (e) {
      // keep the last snapshot and try again next time
      noteFailure(id, `Could not decode ${accountLabel(ctx, id)}: ${e.message}`, `Could not decode an account: ${e.message}`);
      return null;
    }
  }

  /** The new snapshot, the changes since the last one, and the history kept from them. Returns whether it changed. */
  function updateCollection(acc, cur, id, now, dirty) {
    const { rules } = ctx.tables;
    let changed = !acc.snapshot;
    const events = acc.snapshot ? diffSnapshots(acc.snapshot, cur, rules, now) : [];
    if (events.length) {
      acc.events = [...acc.events, ...events].slice(-MAX_EVENTS);
      acc.lastChange = now;
      changed = true;
    }
    acc.snapshot = cur;
    if (recordProgress(ctx.user.progress, id, cur, Date.parse(now), rules)) dirty.add('progress');
    return changed;
  }

  /** Running events, avatars and the shop. Returns whether any changed. */
  function updateStore(acc, id, entries, now, dirty) {
    let changed = false;
    // empty: what a value the account doesn't have yet counts as
    const replace = (key, value, empty = []) => {
      if (JSON.stringify(value) === JSON.stringify(acc[key] ?? empty)) return false;
      acc[key] = value;
      changed = true;
      return true;
    };
    if (entries.store && replace('activeEvents', parseActiveEvents(entries.store))) acc.activeEventsAt = now;
    if (entries.profile) replace('ownedAvatars', parseOwnedAvatars(entries.profile));
    const shop = parseStore(entries.store);
    if (shop && replace('shop', shop, null) && logGrid(ctx.user.gridHistory, id, shop.grid, now)) dirty.add('gridHistory');
    if (entries.store) replace('incomeBonuses', parseIncomeBonuses(entries.store));
    return changed;
  }

  function updatePvp(acc, id, entries, now, dirty) {
    if (!recordPvp(ctx.user.pvpHistory, id, acc, parsePvp(entries.pvp), now, ctx.tables.pvp?.victoryPoints)) return false;
    dirty.add('pvpHistory');
    return true;
  }

  /** A value caught while the game was saving keeps the previous one until the next scan. */
  const unlessMidSave = (update) => {
    try {
      return update();
    } catch {
      return false;
    }
  };

  /** Applies one account's entries. Returns whether its state changed. */
  async function scanAccount(id, entries, now, dirty) {
    const cur = decodeCollection(id, entries);
    if (!cur) return false;
    const acc = await account(id, dirty);
    let changed = updateCollection(acc, cur, id, now, dirty);
    if (unlessMidSave(() => updateStore(acc, id, entries, now, dirty))) changed = true;
    if (unlessMidSave(() => updatePvp(acc, id, entries, now, dirty))) changed = true;
    // (a file that could not be written, as on a full disk, is written at the next scan, changed or not)
    if (changed || unsavedStates.has(id)) {
      unsavedStates.add(id);
      await writeJson(path.join(ctx.paths.STATE, `${id}.json`), acc);
      unsavedStates.delete(id);
    }
    return changed;
  }

  /** One scan; does nothing while another is running. */
  async function scan() {
    if (status.scanning) return;
    status.scanning = true;
    try {
      let prefs;
      try {
        prefs = await readPrefs();
        noteSuccess('read');
      } catch (e) {
        noteFailure('read', e.message);
        return;
      }
      const now = new Date().toISOString();
      status.lastScan = now;
      for (const entries of Object.values(prefs)) {
        try {
          const b = parseGameBuild(entries.commerce);
          if (b) status.gameBuild = b;
        } catch {
          // caught mid-save
        }
      }
      const dirty = new Set(); // user-data files to save
      let changed = false;
      for (const [id, entries] of Object.entries(prefs)) {
        if (!entries.units) continue;
        try {
          if (await scanAccount(id, entries, now, dirty)) changed = true;
          noteSuccess(`update ${id}`);
        } catch (e) {
          // (one account's trouble does not stop the others, nor the tracker's start)
          noteFailure(`update ${id}`, `Could not update ${accountLabel(ctx, id)}: ${e.message}`,
            `Could not update an account: ${e.message}`);
        }
      }
      // (a data folder that can't be written just now does not stop the tracker: the next scan writes them again)
      for (const key of dirty) unsaved.add(key);
      try {
        for (const key of [...unsaved]) {
          await ctx.user.save(key);
          unsaved.delete(key);
        }
        noteSuccess('save');
      } catch (e) {
        noteFailure('save', `Could not save the history: ${e.message}`);
      }
      // A new G.R.I.D. comes with a changed shop, so its history needs no check of its own.
      if (changed || dirty.has('progress') || dirty.has('pvpHistory')) ctx.bump();
    } finally {
      status.scanning = false;
    }
  }

  return { scan };
}
