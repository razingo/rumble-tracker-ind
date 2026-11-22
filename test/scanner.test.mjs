// Scans: snapshots, events, history and saving, with a made-up save instead of the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createScanner, FAILS_BEFORE_ERROR } from '../server/scan/scanner.mjs';
import { recordProgress, logGrid } from '../server/scan/history.mjs';
import { flushWrites } from '../server/store.mjs';
import { testContext, unitsValue, currenciesValue, pvpValue, hexId, RULES } from './helpers.mjs';

const ACC = hexId(0x0100000000, 0xff00);
const save = ({ xp = 0, gold = 100, pvp } = {}) => ({
  [ACC]: { units: unitsValue([{ a: 0xa, b: 0xb, level: 3, xp, xpNeeded: 10, xpLevel: 1 }]),
    currencies: currenciesValue([{ a: 1, b: 2, balance: gold }]), ...(pvp ? { pvp: pvpValue(pvp) } : {}) },
});
const readJsonFile = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('a scan stores snapshots, events, progress and PvP readings, and bumps the revision', async () => {
  const { ctx, cleanup } = await testContext();
  let next = save({ pvp: { honor: 1000, vp: 0 } });
  const { scan } = createScanner(ctx, { readPrefs: async () => next });
  const rev0 = ctx.rev;
  await scan();
  assert.ok(ctx.rev > rev0);
  const acc = ctx.accounts.get(ACC);
  assert.equal(acc.snapshot.units[0].level, 3);
  assert.equal(ctx.scan.lastScan !== null, true);
  assert.equal(ctx.user.pvpHistory[ACC][0].start, true);
  // The second scan has XP gained, gold spent and a PvP win.
  next = save({ xp: 5, gold: 40, pvp: { honor: 1030, vp: 160 } });
  await scan();
  assert.deepEqual(acc.events.map((e) => e.type).sort(), ['currency', 'unit_xp']);
  assert.equal(ctx.user.pvpHistory[ACC].at(-1).wins, 1);
  await flushWrites();
  const onDisk = await readJsonFile(path.join(ctx.paths.STATE, `${ACC}.json`));
  assert.equal(onDisk.snapshot.currencies[0].balance, 40);
  assert.equal(onDisk.pvpLog, undefined);
  assert.equal((await readJsonFile(path.join(ctx.paths.DATA, 'pvp_history.json')))[ACC].length, 2);
  assert.ok((await readJsonFile(path.join(ctx.paths.DATA, 'progress.json')))[ACC]);
  // nothing changed, so no new revision
  const rev = ctx.rev;
  await scan();
  assert.equal(ctx.rev, rev);
  await cleanup();
});

test('a PvP log from an older version moves to pvp_history.json', async () => {
  const { ctx, cleanup } = await testContext();
  const old = [{ t: '2026-01-01T00:00:00.000Z', season: 'x', honor: 1, vp: 0, start: true }];
  await writeFile(path.join(ctx.paths.STATE, `${ACC}.json`), JSON.stringify({ snapshot: null, events: [], pvpLog: old }));
  const { scan } = createScanner(ctx, { readPrefs: async () => save() });
  await scan();
  await flushWrites();
  assert.deepEqual(ctx.user.pvpHistory[ACC], old);
  assert.equal(ctx.accounts.get(ACC).pvpLog, undefined);
  assert.deepEqual((await readJsonFile(path.join(ctx.paths.DATA, 'pvp_history.json')))[ACC], old);
  await cleanup();
});

test('read failures are reported only when they persist', async () => {
  const { ctx, cleanup } = await testContext();
  let fail = true;
  const { scan } = createScanner(ctx, { readPrefs: async () => {
    if (fail) throw new Error('key busy');
    return save();
  } });
  for (let i = 1; i < FAILS_BEFORE_ERROR; i++) {
    await scan();
    assert.equal(ctx.scan.lastError, null);
  }
  await scan();
  assert.equal(ctx.scan.lastError, 'key busy');
  assert.equal(ctx.errorLog.list().length, 1);
  fail = false;
  await scan();
  assert.equal(ctx.scan.lastError, null);
  await cleanup();
});

test('a damaged account value keeps the last snapshot', async () => {
  const { ctx, cleanup } = await testContext();
  let next = save();
  const { scan } = createScanner(ctx, { readPrefs: async () => next });
  await scan();
  next = { [ACC]: { units: Buffer.from([0x0b]), currencies: Buffer.alloc(0) } };
  await scan();
  assert.equal(ctx.accounts.get(ACC).snapshot.units.length, 1);
  await cleanup();
});

test('one scan at a time', async () => {
  const { ctx, cleanup } = await testContext();
  let reads = 0;
  const { scan } = createScanner(ctx, { readPrefs: async () => {
    reads++;
    await new Promise((r) => setTimeout(r, 30));
    return save();
  } });
  await Promise.all([scan(), scan(), scan()]);
  assert.equal(reads, 1);
  await cleanup();
});

test('keeps one progress sample a day and skips unchanged ones', () => {
  const progress = {};
  const snap = { units: [{ level: 3, xpLevel: 1, rarity: 0, stars: 2 }], currencies: [{ id: 'g', balance: 5, lifetime: 9 }] };
  const day = Date.parse('2026-03-01T12:00:00');
  assert.equal(recordProgress(progress, 'a', snap, day, RULES), true);
  assert.equal(recordProgress(progress, 'a', snap, day + 60000, RULES), false);
  assert.equal(recordProgress(progress, 'a', { ...snap, currencies: [{ id: 'g', balance: 6, lifetime: 10 }] }, day + 120000, RULES), true);
  assert.equal(progress.a.days.length, 1);
  assert.equal(recordProgress(progress, 'a', snap, day + 86400000, RULES), true);
  assert.equal(progress.a.days.length, 2);
});

test('logs the G.R.I.D. when its refresh time or items change', () => {
  const h = {};
  const grid = (refresh, minis) => ({ refresh, rows: [minis.map((m) => ({ mini: m, rarity: 1 }))] });
  assert.equal(logGrid(h, 'a', grid('t1', ['x', 'y']), 'now'), true);
  assert.equal(logGrid(h, 'a', grid('t1', ['x']), 'now'), false); // one bought: same grid
  assert.equal(logGrid(h, 'a', grid('t1', ['x', 'z']), 'now'), true); // reset
  assert.equal(logGrid(h, 'a', grid('t2', ['x', 'z']), 'now'), true);
  assert.equal(h.a.length, 3);
});

