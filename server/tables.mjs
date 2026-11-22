// The game tables: rules, minis, events, shop and PvP data. An installed data pack (<data>/gamedata) is used before
// gamedata/, which npm run fetch-gamedata fills when running from source.
import { stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { readJson, fileTimestamp } from './store.mjs';

export function createTables({ GAMEDATA, STATIC }) {
  const t = {
    rules: null, minis: [], slugs: new Set(), builtinUnits: {}, gameData: null, events: null, store: null, pvp: null,

    /** The file to use for a game-data path: the pack's copy if it has one. */
    async staticPath(rel) {
      const p = path.join(GAMEDATA, rel);
      try {
        await stat(p);
        return p;
      } catch {
        return path.join(STATIC, rel);
      }
    },

    /** Whether any game data is installed, from npm run fetch-gamedata or the exe's first start. */
    async hasGameData() {
      for (const dir of [GAMEDATA, STATIC]) {
        try {
          await stat(path.join(dir, 'rules.json'));
          return true;
        } catch {
          // next
        }
      }
      return false;
    },

    /** Whether the tables come from an installed pack. */
    async fromPack() { return (await t.staticPath('gamedata.json')).startsWith(GAMEDATA); },

    /** (Re)loads every table. Throws on missing or damaged required files. */
    async load() {
      const read = async (rel, fallback) => readJson(await t.staticPath(rel), fallback);
      const next = {
        events: await read('events.json', null),
        store: await read('store.json', null),
        pvp: await read('pvp.json', null),
        rules: await read('rules.json'),
        minis: (await read('minis.json')).minis,
        // Unit ID to mini; the player's assignments in names.json come first.
        builtinUnits: (await read('unit_ids.json', { units: {} })).units,
        gameData: await read('gamedata.json', null), // game build and data version of the tables
      };
      Object.assign(t, next, { slugs: new Set(next.minis.map((m) => m.slug)) });
    },

    /** Moves a damaged installed pack aside (to <dir>.damaged-<time>); returns the folder name it was moved to. */
    async setPackAside() {
      const moved = `${GAMEDATA}.damaged-${fileTimestamp()}`;
      await rename(GAMEDATA, moved);
      return path.basename(moved);
    },

    async packInstalled() { return !!(await stat(path.join(GAMEDATA, 'gamedata.json')).catch(() => null)); },
  };
  return t;
}
