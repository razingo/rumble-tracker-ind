// The user's own files in the data folder: what they entered, and history the save can't give back. Everything that
// changes them goes through the object loadUserData returns, so there is one place that knows what changed. The rest
// of the server reads its parts (user.armies, user.talents, ...) and leaves them as they are.
import path from 'node:path';
import { writeJson, isRecord, keepCopy } from './store.mjs';
import { restoreBackup, replaceContents } from './backup.mjs';
import { cleanSettings } from './notifications/notify.mjs';
import { manualResult } from './game/pvp.mjs';
import { recordProgress, logGrid, recordPvp } from './scan/history.mjs';
import { CLOSE_CHOICES } from '../web/scripts/lib/constants.js';

// property -> file name
const FILES = {
  names: 'names.json',              // { accounts: { id: name }, units: { unitId: slug } }
  talents: 'talents.json',          // { [account]: { [unitId]: [talent index] } }
  army: 'army.json',                // army slots: { [account]: { [unitId]: [{ type, tier, boost? } x7] } }
  armies: 'armies.json',            // saved armies: { [account]: [{ id, name, leader, minis, talents, description, tags }] }
  drafts: 'drafts.json',            // army being edited, per account (auto-saved by the page)
  gridHistory: 'grid_history.json', // G.R.I.D.s seen: { [account]: [{ seen, refresh, items }] } (offer cooldowns)
  pvpHistory: 'pvp_history.json',   // PvP readings and inferred matches: { [account]: [entry] } (game/pvp.mjs)
  progress: 'progress.json',        // daily samples: { [account]: { first, days: [...] } }
  notifySettings: 'notifications.json',
  appSettings: 'settings.json',     // { closeWindow: 'ask' | 'tray' | 'quit' (the exe only), checkUpdates }
  plans: 'plans.json',              // reward goals: { [account]: { [eventId]: { cost, label, set } } }
  sentLog: 'notified.json',         // { sent: { key: time }, log, pending }; pending ones wait for quiet hours to end
};

// Backup key to property. Backups hold everything the player entered and the history the save can't give back; the
// scan snapshots in state/ are left out, as the next scan rebuilds them.
export const BACKUP_KEYS = {
  names: 'names', talents: 'talents', army: 'army', armies: 'armies', drafts: 'drafts',
  grid_history: 'gridHistory', pvp_history: 'pvpHistory', notifications: 'notifySettings', plans: 'plans', progress: 'progress',
  settings: 'appSettings',
};

// (a part that is not there is filled in when read; one that is something else makes the file a damaged one)
const parts = (kinds) => (v) => isRecord(v) && Object.entries(kinds).every(([k, ok]) => v[k] === undefined || ok(v[k]));
// What a file holds when it is more than an object with named parts, by property.
const SHAPES = {
  names: parts({ accounts: isRecord, units: isRecord }),
  sentLog: parts({ sent: isRecord, log: Array.isArray, pending: Array.isArray }),
};
/** Whether `value` is what a backup may hold under `key`: a restore leaves out a part that is something else. */
export const backupShape = (key, value) => (SHAPES[BACKUP_KEYS[key]] || isRecord)(value);

// What the files that are kept by account hold for each one. A file may be whole and still hold something else for
// an account (one changed by hand, or a backup of such a file): that account's part is dropped, the others stay.
// Of a list, only the entries that are something else are dropped, and the rest of the list stays.
const BY_ACCOUNT = {
  talents: { part: isRecord }, army: { part: isRecord }, drafts: { part: isRecord }, plans: { part: isRecord },
  armies: { part: Array.isArray, entry: isRecord },
  gridHistory: { part: Array.isArray, entry: (g) => isRecord(g) && Array.isArray(g.items) },
  pvpHistory: { part: Array.isArray, entry: isRecord },
  // (its list is its days; one that is missing is an empty one)
  progress: { part: (p) => isRecord(p) && (p.first == null || isRecord(p.first)) && (p.days == null || Array.isArray(p.days)),
    entry: isRecord, list: 'days' },
};
/**
 * Drops from `files` ({ property: contents }) what the accounts' parts hold that is something else: a whole part, or
 * the entries of its list. Returns [[property, account, the number of entries dropped (null: the whole part)]].
 */
function dropBadParts(files) {
  const dropped = [];
  for (const [prop, { part: ok, entry, list }] of Object.entries(BY_ACCOUNT)) {
    for (const [account, part] of Object.entries(files[prop] || {})) {
      if (!ok(part)) {
        delete files[prop][account];
        dropped.push([prop, account, null]);
        continue;
      }
      if (!entry) continue;
      if (list) part[list] ??= [];
      const entries = list ? part[list] : part;
      const good = entries.filter(entry);
      if (good.length === entries.length) continue;
      dropped.push([prop, account, entries.length - good.length]);
      if (list) part[list] = good; else files[prop][account] = good;
    }
  }
  return dropped;
}

/** App settings with unknown or missing values replaced by the defaults. */
export const cleanAppSettings = (s) => ({
  closeWindow: Object.hasOwn(CLOSE_CHOICES, s?.closeWindow ?? '') ? s.closeWindow : 'ask',
  checkUpdates: s?.checkUpdates !== false, // whether GitHub is asked for the latest version (update/checker.mjs)
});

/** The name the user gave an account, else a short form of its ID. */
export const accountLabel = (ctx, id) => ctx.user.names.accounts[id] || `Account …${id.slice(16, 24)}`;

/** The mini a unit ID stands for: the user's assignment, else the game data's, else null. */
export const unitSlug = (ctx, id) => ctx.user.names.units[id] || ctx.tables.builtinUnits[id] || null;

/** Loads every file (missing ones start empty). */
export async function loadUserData(ctx) {
  const dir = ctx.paths.DATA;
  const read = (key, fallback) => ctx.readUserJson(path.join(dir, FILES[key]), fallback, SHAPES[key]);
  const notified = await read('sentLog', null); // (its missing parts are filled in below)
  const u = {
    names: await read('names', { accounts: {}, units: {} }),
    talents: await read('talents', {}),
    army: await read('army', {}),
    armies: await read('armies', {}),
    drafts: await read('drafts', {}),
    gridHistory: await read('gridHistory', {}),
    pvpHistory: await read('pvpHistory', {}),
    progress: await read('progress', {}),
    notifySettings: cleanSettings(await read('notifySettings', {})),
    appSettings: cleanAppSettings(await read('appSettings', {})),
    plans: await read('plans', {}),
    sentLog: { sent: {}, log: [], pending: [], ...notified },
    notifyBaseline: !notified, // first run: record what is already due without notifying
    /** Saves one file. Writes to the same file are queued. */
    save: (key) => writeJson(path.join(dir, FILES[key]), u[key]),

    // What the player enters. Each takes values that are already checked (http/handlers.mjs) and saves its file.
    /** Names an account; an empty name takes the name away. */
    setAccountName(id, name) {
      if (name) u.names.accounts[id] = name;
      else delete u.names.accounts[id];
      return u.save('names');
    },
    /** Assigns a mini to a unit ID; an empty slug takes the assignment away. */
    setUnitSlug(id, slug) {
      if (slug) u.names.units[id] = slug;
      else delete u.names.units[id];
      return u.save('names');
    },
    setTalents(account, unitId, picks) {
      (u.talents[account] ??= {})[unitId] = picks;
      return u.save('talents');
    },
    setArmySlots(account, unitId, slots) {
      (u.army[account] ??= {})[unitId] = slots;
      return u.save('army');
    },
    /** Sets a reward goal, or clears it with null. */
    setPlan(account, eventId, plan) {
      const mine = (u.plans[account] ??= {});
      if (plan) mine[eventId] = plan;
      else delete mine[eventId];
      return u.save('plans');
    },
    setDraft(account, draft) {
      u.drafts[account] = draft;
      return u.save('drafts');
    },
    /** Replaces all saved armies of an account. */
    setArmies(account, armies) {
      u.armies[account] = armies;
      return u.save('armies');
    },
    /** The player's own result for the unexplained PvP entry read at `t`. Resolves with false when not allowed. */
    async setPvpResult(account, t, result) {
      const entry = (u.pvpHistory[account] || []).find((e) => e.t === t);
      if (!manualResult(entry, result)) return false;
      await u.save('pvpHistory');
      return true;
    },
    setNotifySettings(settings) {
      replaceContents(u.notifySettings, cleanSettings(settings));
      return u.save('notifySettings');
    },
    setAppSetting(key, value) {
      u.appSettings[key] = value;
      return u.save('appSettings');
    },

    // What scans add. Each returns whether it changed something; the scanner saves the files once per scan (save).
    /** The day's progress sample from a snapshot (scan/history.mjs); 'progress' is then to be saved. */
    recordProgress: (account, snap, now, rules) => recordProgress(u.progress, account, snap, now, rules),
    /** A G.R.I.D. when it is a new one; 'gridHistory' is then to be saved. */
    recordGrid: (account, grid, now) => logGrid(u.gridHistory, account, grid, now),
    /** A PvP reading when it differs from the last one in `acc`; 'pvpHistory' is then to be saved. */
    recordPvp: (account, acc, cur, now, vpRules) => recordPvp(u.pvpHistory, account, acc, cur, now, vpRules),
    /** Takes over a PvP log kept elsewhere by an earlier tracker, unless the account has one here. */
    adoptPvpLog(account, log) {
      if (u.pvpHistory[account]) return false;
      u.pvpHistory[account] = log;
      return true;
    },

    /**
     * Restores a backup file and saves what it restored. Resolves with { restored, leftOut, incomplete }: the backup
     * keys restored, those left out for what they hold, and of the restored ones those that lost some of what they
     * held for an account. Null when this isn't a backup.
     */
    async restore(backup) {
      const leftOut = [];
      const restored = restoreBackup(u.backupFiles(), backup, backupShape, leftOut);
      if (!restored) return null;
      const dropped = u.repair();
      for (const key of restored) await u.save(BACKUP_KEYS[key]);
      return { restored, leftOut, incomplete: restored.filter((key) => dropped.includes(BACKUP_KEYS[key])) };
    },
    /** The files a backup holds, by backup key. */
    backupFiles: () => Object.fromEntries(Object.entries(BACKUP_KEYS).map(([k, prop]) => [k, u[prop]])),
    /**
     * After a restore, fills in what older, partial or hand-edited backups may lack, and drops what they hold for an
     * account that is something else than the tracker keeps there (noted as a problem). Returns the properties it
     * dropped something from.
     */
    repair() {
      fillIn();
      return report(dropBadParts(u));
    },
  };
  const fillIn = () => {
    u.names.accounts ??= {};
    u.names.units ??= {};
    Object.assign(u.appSettings, cleanAppSettings(u.appSettings));
    Object.assign(u.notifySettings, cleanSettings(u.notifySettings));
  };
  /** Notes what was dropped as a problem (`kept`: { property: the copy of its file }); returns the properties. */
  const report = (dropped, kept = {}) => {
    for (const [prop, account, entries] of dropped) {
      const what = entries == null ? 'That part was left out; the other accounts in the file are as they were.'
        : `${entries === 1 ? 'One entry of its list was' : `${entries} entries of its list were`} left out; the rest is as it was.`;
      ctx.errorLog.add('data file', `${FILES[prop]} held something else than the tracker keeps for account …${account.slice(16, 24)}. `
        + `${what}${kept[prop] ? ` The file as it was is kept as ${path.basename(kept[prop])}.` : ''}`);
    }
    return [...new Set(dropped.map(([prop]) => prop))];
  };
  // A file something was dropped from is written as it is now, so the same is not found at every start; a copy of it
  // as it was stays beside it.
  fillIn();
  const dropped = dropBadParts(u), kept = {};
  for (const prop of new Set(dropped.map(([p]) => p))) {
    kept[prop] = await keepCopy(path.join(dir, FILES[prop])).catch(() => null);
  }
  for (const prop of report(dropped, kept)) await u.save(prop);
  return u;
}
