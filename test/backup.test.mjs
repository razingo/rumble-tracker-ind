import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { buildBackup, restoreBackup, writeDailyBackup, BACKUP_FORMAT } from '../server/backup.mjs';
import { backupShape } from '../server/userdata.mjs';
import { testContext } from './helpers.mjs';

test('backup round trip replaces contents in place and skips missing or bad keys', () => {
  const names = { accounts: { a: 'Main' }, units: {} };
  const pvp = { a: [{ t: '1', wins: 1 }] };
  const plans = { keep: true };
  const files = { names, pvp_history: pvp, plans };
  const b = JSON.parse(JSON.stringify(buildBackup(files, new Date('2026-11-19T00:00:00Z'))));
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.created, '2026-11-19T00:00:00.000Z');
  names.accounts.a = 'Changed';
  pvp.b = [];
  delete b.data.plans;          // older backup without this key
  b.data.extra = { x: 1 };     // unknown keys are ignored
  const restored = restoreBackup(files, b);
  assert.deepEqual(restored.sort(), ['names', 'pvp_history']);
  assert.equal(files.names, names); // same objects: other code holds references
  assert.equal(names.accounts.a, 'Main');
  assert.deepEqual(Object.keys(pvp), ['a']);
  assert.deepEqual(plans, { keep: true });
  assert.equal(files.extra, undefined);
});

test('not a backup', () => {
  assert.equal(restoreBackup({}, null), null);
  assert.equal(restoreBackup({}, { format: 'other', data: {} }), null);
  assert.equal(restoreBackup({}, { format: BACKUP_FORMAT }), null);
  // Arrays and non-objects are never restored over an object.
  const files = { names: { accounts: {} } };
  assert.deepEqual(restoreBackup(files, { format: BACKUP_FORMAT, data: { names: [1, 2] } }), []);
  assert.deepEqual(files.names, { accounts: {} });
});

test('a part of a backup that holds something else than the tracker keeps in it is not restored', () => {
  const files = { names: { accounts: { a: 'Main' }, units: {} }, plans: { old: 1 }, notifications: {} };
  const data = { names: { accounts: 7, units: {} }, plans: { fresh: 1 }, notifications: { enabled: false } };
  assert.deepEqual(restoreBackup(files, { format: BACKUP_FORMAT, data }, backupShape), ['plans', 'notifications']);
  assert.deepEqual(files.names, { accounts: { a: 'Main' }, units: {} }, 'the names stay as they were');
  assert.deepEqual(files.plans, { fresh: 1 });
  // a part that is only missing is fine: repair() fills it in
  assert.deepEqual(restoreBackup(files, { format: BACKUP_FORMAT, data: { names: { accounts: { b: 'Alt' } } } }, backupShape), ['names']);
  // what was left out is told, so the page can say so; a part the backup does not have is not one of them
  const leftOut = [];
  assert.deepEqual(restoreBackup(files, { format: BACKUP_FORMAT, data: { names: { units: [] }, plans: 7 } }, backupShape, leftOut), []);
  assert.deepEqual(leftOut, ['names', 'plans']);
});

test('keeps one backup a day for 7 days', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-daily-'));
  await writeFile(path.join(dir, 'keep-me.txt'), 'other files are left alone');
  const files = { names: { accounts: { a: 'Main' } } };
  for (let d = 1; d <= 9; d++) await writeDailyBackup(dir, files, { now: new Date(2026, 0, d, 12) });
  // The same day again replaces the backup instead of adding one.
  files.names.accounts.a = 'Renamed';
  const last = await writeDailyBackup(dir, files, { now: new Date(2026, 0, 9, 18) });
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ['keep-me.txt', ...[3, 4, 5, 6, 7, 8, 9].map((d) => `rumble-tracker-backup-2026-01-0${d}.json`)]);
  const b = JSON.parse(await readFile(last, 'utf8'));
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.data.names.accounts.a, 'Renamed');
  await rm(dir, { recursive: true });
});

test('settings a restored backup left broken are made whole again', async () => {
  const { ctx, cleanup } = await testContext();
  try {
    const u = ctx.user;
    for (const k of Object.keys(u.notifySettings)) delete u.notifySettings[k]; // a hand-edited backup's "notifications": {}
    u.appSettings.closeWindow = 'nonsense';
    u.repair();
    assert.equal(u.notifySettings.enabled, true);
    assert.equal(typeof u.notifySettings.types.freeGift.on, 'boolean');
    assert.equal(u.notifySettings.quiet.from, '23:00');
    assert.equal(u.appSettings.closeWindow, 'ask');
  } finally {
    await cleanup();
  }
});
