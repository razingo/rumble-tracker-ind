// Scans: snapshots, events, history and saving, with a made-up save instead of the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createScanner, FAILS_BEFORE_ERROR } from '../server/scan/scanner.mjs';
import { recordProgress, logGrid } from '../server/scan/history.mjs';
import { flushWrites } from '../server/store.mjs';
import { embedded, string } from '../web/scripts/lib/protobuf.js';
import { testContext, unitsValue, currenciesValue, pvpValue, hexId, RULES } from './helpers.mjs';

const ACC = hexId(0x0100000000, 0xff00);
const save = ({ xp = 0, gold = 100, pvp } = {}) => ({
  [ACC]: { units: unitsValue([{ a: 0xa, b: 0xb, level: 3, xp, xpNeeded: 10, xpLevel: 1 }]),
    currencies: currenciesValue([{ a: 1, b: 2, balance: gold }]), ...(pvp ? { pvp: pvpValue(pvp) } : {}) },
});
const readJsonFile = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('a scan stores snapshots, events, progress and PvP readings, and bumps the revision', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
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
});

test('a PvP log from an older version moves to pvp_history.json', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  const old = [{ t: '2026-01-01T00:00:00.000Z', season: 'x', honor: 1, vp: 0, start: true }];
  await writeFile(path.join(ctx.paths.STATE, `${ACC}.json`), JSON.stringify({ snapshot: null, events: [], pvpLog: old }));
  const { scan } = createScanner(ctx, { readPrefs: async () => save() });
  await scan();
  await flushWrites();
  assert.deepEqual(ctx.user.pvpHistory[ACC], old);
  assert.equal(ctx.accounts.get(ACC).pvpLog, undefined);
  assert.deepEqual((await readJsonFile(path.join(ctx.paths.DATA, 'pvp_history.json')))[ACC], old);
});

test('read failures are reported only when they persist', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
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
});

test('a damaged account value keeps the last snapshot', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  let next = save();
  const { scan } = createScanner(ctx, { readPrefs: async () => next });
  await scan();
  next = { [ACC]: { units: Buffer.from([0x0b]), currencies: Buffer.alloc(0) } };
  await scan();
  assert.equal(ctx.accounts.get(ACC).snapshot.units.length, 1);
});

test('an account file that holds something else is moved aside, and one account never stops another', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  const OTHER = hexId(0x0200000000, 0xff00);
  for (const [id, text] of [[ACC, 'null'], [OTHER, '{"snapshot":7,"events":"x"}']]) {
    await writeFile(path.join(ctx.paths.STATE, `${id}.json`), text);
  }
  const both = { ...save(), [OTHER]: save()[ACC] };
  const { scan } = createScanner(ctx, { readPrefs: async () => both });
  await scan();
  assert.deepEqual([ctx.accounts.get(ACC).snapshot.units.length, ctx.accounts.get(OTHER).events], [1, []]);
  assert.equal(ctx.errorLog.list().filter((e) => e.source === 'data file').length, 2);
  // an account that can't be updated is reported once it keeps failing; the other is read all the same
  ctx.user.progress = null; // (what stops the first account's update)
  const failing = createScanner(ctx, { readPrefs: async () => ({ [ACC]: save({ xp: 5 })[ACC], [OTHER]: both[OTHER] }) });
  for (let i = 0; i < FAILS_BEFORE_ERROR; i++) await failing.scan(); // (does not throw)
  assert.match(ctx.scan.lastError, /Could not update/);
});

test('a history file that can\'t be written does not stop the scan, and is written by a later one', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  const { scan } = createScanner(ctx, { readPrefs: async () => save({ pvp: { honor: 1000, vp: 0 } }) });
  const real = ctx.user.save, saved = [];
  ctx.user.save = async () => { throw new Error('ENOSPC: no space left'); };
  for (let i = 0; i < FAILS_BEFORE_ERROR; i++) await scan(); // (does not throw: the tracker starts with a full disk)
  assert.match(ctx.scan.lastError, /Could not save the history: ENOSPC/);
  assert.equal(ctx.errorLog.list().at(-1).source, 'saving the history');
  // nothing changes in the save any more: what was not written is all the same
  ctx.user.save = async (key) => { saved.push(key); return real(key); };
  await scan();
  assert.deepEqual(saved.sort(), ['progress', 'pvpHistory']);
  assert.equal(ctx.scan.lastError, null);
});

test('an account file that can\'t be written is written by a later scan, though nothing changed', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  let next = save();
  const { scan } = createScanner(ctx, { readPrefs: async () => next });
  const file = path.join(ctx.paths.STATE, `${ACC}.json`);
  await scan();
  await flushWrites();
  // (a folder where the file goes: it can't be written)
  await rm(file);
  await mkdir(file);
  next = save({ xp: 5 });
  const rev = ctx.rev;
  await scan();
  assert.equal(ctx.accounts.get(ACC).snapshot.units[0].xp, 5, 'the account is read all the same');
  assert.ok(ctx.rev > rev, 'and the page is told of the change');
  await rm(file, { recursive: true });
  await scan(); // the same save as before
  await flushWrites();
  assert.equal((await readJsonFile(file)).snapshot.units[0].xp, 5);
});

test('the game build is the newest any account names, whichever is listed last', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  const commerce = (build) => embedded(1, string(3, `${build}.dp-live`));
  const OTHER = hexId(0x0200000000, 0xff00);
  // (the second account was not played since the patch)
  const prefs = { [ACC]: { ...save()[ACC], commerce: commerce('16.2.0.120000') }, [OTHER]: { commerce: commerce('16.1.9.119999') } };
  const { scan } = createScanner(ctx, { readPrefs: async () => prefs });
  await scan();
  assert.equal(ctx.scan.gameBuild, '16.2.0.120000');
});

test('one scan at a time', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  let reads = 0;
  const { scan } = createScanner(ctx, { readPrefs: async () => {
    reads++;
    await new Promise((r) => setTimeout(r, 30));
    return save();
  } });
  await Promise.all([scan(), scan(), scan()]);
  assert.equal(reads, 1);
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
