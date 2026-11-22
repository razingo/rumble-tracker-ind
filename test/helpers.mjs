// Shared test helpers: hand-built save values (written with lib/protobuf.js), and a tracker context in a temporary
// folder with small made-up game tables (tests don't need the real game data).
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createContext } from '../server/context.mjs';
import { createTables } from '../server/tables.mjs';
import { loadUserData } from '../server/userdata.mjs';
import { int, embedded, fixed64 } from '../web/scripts/lib/protobuf.js';

export const id = (fn, a, b) => embedded(fn, fixed64(1, a), fixed64(2, b));
export const hexId = (a, b) => a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0');

/** A MiniProgressionManagerState value: units [{ a, b, level, xp, xpNeeded, xpLevel, rarity, stars }]. */
export const unitsValue = (units) => Buffer.concat(units.map((u) => embedded(1,
  id(1, u.a, u.b), int(2, u.level ?? 1), int(3, u.xp ?? 0), int(6, u.xpNeeded ?? 10), int(7, u.xpLevel ?? 1),
  int(8, 0), int(10, u.stars ?? 0), embedded(9, int(1, u.talents ?? 0), int(2, u.rarity ?? 0)))));
/** A currencies value: [{ a, b, balance, lifetime }]. */
export const currenciesValue = (list) => Buffer.concat(list.flatMap((c) =>
  [embedded(1, id(1, c.a, c.b), int(2, c.balance)), embedded(4, id(1, c.a, c.b), int(2, c.lifetime ?? c.balance))]));
/** A PvpPlayerRankState value. */
export const pvpValue = ({ season = [1, 2], honor, vp }) => Buffer.concat([embedded(2, fixed64(1, season[0]),
  fixed64(2, season[1])), embedded(3, int(1, honor), int(2, honor)), embedded(4, int(1, vp))]);

export const RULES = {
  rarities: [{ name: 'Common' }], rarityUpgrade: [{ stars: 5, arcEnergy: 10 }], xpToNext: { 1: 10, 2: 20 }, maxXpLevel: 10,
  currencyIds: { gold: hexId(1, 2) },
  armySlots: { count: 7, leaderSlot: 0, boostSlot: 6, tiers: [{ bonus: 0 }, { bonus: 1 }, { bonus: 2 }] },
};
const MINIS = [{ slug: 'kobold-miner', name: 'Kobold Miner' }, { slug: 'footmen', name: 'Footmen' }];
const PVP = { victoryPoints: { base: 80, win: 2, loss: 1 } };

/**
 * A context in a new temporary folder, with tables and user data loaded. `files` are extra files to create first, as
 * { 'names.json': {...} } in the data folder. Returns { ctx, dir, cleanup() }.
 */
export async function testContext({ files = {}, standalone = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-ctx-'));
  const root = path.join(dir, 'app'), data = path.join(dir, 'data');
  const gd = path.join(root, 'gamedata');
  await mkdir(gd, { recursive: true });
  await mkdir(path.join(data, 'state'), { recursive: true });
  await mkdir(path.join(root, 'web'), { recursive: true });
  const tables = { 'rules.json': RULES, 'minis.json': { minis: MINIS }, 'pvp.json': PVP,
    'unit_ids.json': { units: { [hexId(0xa, 0xb)]: 'kobold-miner' } },
    'gamedata.json': { gameBuild: '1.0.0.1', dataVersion: '2026-01-01T00:00:00.000Z' } };
  for (const [name, value] of Object.entries(tables)) await writeFile(path.join(gd, name), JSON.stringify(value));
  await writeFile(path.join(root, 'web', 'index.html'), '<!doctype html><title>t</title>');
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(data, name),
    typeof value === 'string' ? value : JSON.stringify(value));
  const ctx = createContext({ root, data, standalone, appVersion: '1.0.0' });
  ctx.tables = createTables(ctx.paths);
  await ctx.tables.load();
  ctx.user = await loadUserData(ctx);
  return { ctx, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
