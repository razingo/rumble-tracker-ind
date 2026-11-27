// The user's own files in the data folder: what they entered, and history the save can't give back.
import path from 'node:path';
import { writeJson, isRecord } from './store.mjs';
import { cleanSettings } from './notifications/notify.mjs';
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
const list = (ok) => (v) => Array.isArray(v) && v.every(ok);
const BY_ACCOUNT = {
  talents: isRecord, army: isRecord, drafts: isRecord, plans: isRecord,
  armies: list(isRecord),
  gridHistory: list((g) => isRecord(g) && Array.isArray(g.items)),
  pvpHistory: list(isRecord),
  progress: (p) => isRecord(p) && (p.first == null || isRecord(p.first)) && list(isRecord)(p.days),
};
/** Drops the accounts' parts of `files` ({ property: contents }) that hold something else: [[property, account]]. */
export function dropBadParts(files) {
  const dropped = [];
  for (const [prop, ok] of Object.entries(BY_ACCOUNT)) {
    for (const [account, part] of Object.entries(files[prop] || {})) {
      if (ok(part)) continue;
      delete files[prop][account];
      dropped.push([prop, account]);
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
    /** The files a backup holds, by backup key. */
    backupFiles: () => Object.fromEntries(Object.entries(BACKUP_KEYS).map(([k, prop]) => [k, u[prop]])),
    /**
     * After a restore, fills in what older, partial or hand-edited backups may lack, and drops what they hold for an
     * account that is something else than the tracker keeps there (noted as a problem). Returns the properties it
     * dropped something from.
     */
    repair() {
      u.names.accounts ??= {};
      u.names.units ??= {};
      Object.assign(u.appSettings, cleanAppSettings(u.appSettings));
      Object.assign(u.notifySettings, cleanSettings(u.notifySettings));
      const dropped = dropBadParts(u);
      for (const [prop, account] of dropped) {
        ctx.errorLog.add('data file', `${FILES[prop]} held something else than the tracker keeps for account …${account.slice(16, 24)}. `
          + 'That part was left out; the other accounts in the file are as they were.');
      }
      return [...new Set(dropped.map(([prop]) => prop))];
    },
  };
  // (a file a part was dropped from is written as it is now, so the same is not found at every start)
  for (const prop of u.repair()) await u.save(prop);
  return u;
}
