// The game tables: rules, minis, events, shop and PvP data, read from the game install (gamedata.mjs) into
// <data>/gamedata, or by npm run build-gamedata into gamedata/, which is used where the first has no copy.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './store.mjs';

export function createTables({ GAMEDATA, STATIC }) {
  const t = {
    rules: null, minis: [], slugs: new Set(), builtinUnits: {}, gameData: null, events: null, store: null, pvp: null,

    /** The file to use for a game-data path. */
    async staticPath(rel) {
      const p = path.join(GAMEDATA, rel);
      try {
        await stat(p);
        return p;
      } catch {
        return path.join(STATIC, rel);
      }
    },

    /** Whether there is any game data. */
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
  };
  return t;
}
