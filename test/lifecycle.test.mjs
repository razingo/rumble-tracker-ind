import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { flushWrites } from '../server/store.mjs';
import { createUpdater } from '../server/update/updater.mjs';
import { host } from '../server/host.mjs';
import { createUpdateChecker } from '../server/update/checker.mjs';
import { testContext } from './helpers.mjs';

const app = { version: '9.9.9', zip: 'RumbleTracker-9.9.9-win-x64.zip', zipSha256: 'a'.repeat(64), exeSha256: 'b'.repeat(64) };
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('the updater downloads, has the launcher install, then stops', async (t) => {
  const { ctx, cleanup } = await testContext({ standalone: true });
  t.after(cleanup); // (also when the test fails)
  ctx.official = true;
  Object.assign(ctx.appUpdate, { newVersion: '9.9.9', latestApp: app });
  const stops = [];
  const download = async (a, dir, { onProgress }) => {
    onProgress(5, 10);
    return path.join(dir, 'new.exe');
  };
  const start = createUpdater(ctx, { shutdown: (r) => stops.push(r), download, applyDelay: 0 });
  const installed = [];
  host.attach({ options: {}, applyUpdate: async (update) => { installed.push(update); } });
  assert.deepEqual(await start(), [200, { ok: true }]);
  await until(() => stops.length);
  assert.equal(installed[0].version, '9.9.9');
  assert.match(installed[0].exe, /new\.exe$/);
  assert.equal(ctx.appUpdate.state, 'restarting');
  assert.deepEqual([ctx.appUpdate.done, ctx.appUpdate.total], [5, 10]);
  assert.deepEqual(stops, ['App update: restarting as 9.9.9']);
});

test('the updater shows a failed install and refuses when there is nothing to install', async (t) => {
  const { ctx, cleanup } = await testContext({ standalone: true });
  t.after(cleanup); // (also when the test fails)
  const start = createUpdater(ctx, { shutdown: () => assert.fail('must not stop'), download: async () => 'x.exe', applyDelay: 0 });
  assert.equal((await start())[0], 409);
  Object.assign(ctx.appUpdate, { newVersion: '9.9.9', latestApp: app });
  assert.equal((await start())[0], 409, 'an exe built by hand does not replace itself');
  ctx.official = true;
  host.attach({ options: {}, applyUpdate: async () => { throw new Error('The program file could not be replaced (EPERM).'); } });
  await start();
  await until(() => ctx.appUpdate.state === 'failed');
  assert.match(ctx.appUpdate.error, /EPERM/);
  assert.equal(ctx.errorLog.list().length, 1);
});

test('checks for a new version run one at a time and announce a newer one once', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  let calls = 0, news = 0, found = { version: '9.9.9', app };
  const latest = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return found;
  };
  const check = createUpdateChecker(ctx, { latest, onNews: () => news++ });
  await Promise.all([check(), check(), check()]);
  assert.equal(calls, 1);
  assert.equal(ctx.appUpdate.newVersion, '9.9.9');
  assert.deepEqual(ctx.appUpdate.latestApp, app);
  assert.equal(news, 1);
  await check();
  assert.equal(calls, 2);
  assert.equal(news, 1); // already announced
  // this version or an older one is no news
  found = { version: ctx.appVersion, app: null };
  await check();
  assert.equal(ctx.appUpdate.newVersion, null);
});

test('no check for a new version when that is turned off, or GitHub does not answer', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  ctx.appUpdate.newVersion = '9.9.9';
  ctx.user.appSettings.checkUpdates = false;
  let calls = 0;
  const check = createUpdateChecker(ctx, { latest: async () => { calls++; throw new Error('offline'); } });
  await check();
  assert.equal(calls, 0);
  assert.equal(ctx.appUpdate.newVersion, null, 'what was found before is forgotten');
  ctx.user.appSettings.checkUpdates = true;
  await check();
  assert.equal(calls, 1);
  assert.equal(ctx.appUpdate.checkError, 'offline');
  assert.equal(ctx.errorLog.list().length, 0, 'being offline is not a problem to report');
});

test('a damaged user file is moved aside and reported; the rest loads', async (t) => {
  const { ctx, cleanup } = await testContext({ files: { 'plans.json': '{"broken": ',
    'names.json': { accounts: { a: 'Main' }, units: {} } } });
  t.after(cleanup); // (also when the test fails)
  assert.deepEqual(ctx.user.plans, {});
  assert.equal(ctx.user.names.accounts.a, 'Main');
  assert.equal(ctx.errorLog.list()[0].source, 'data file');
  assert.ok((await readdir(ctx.paths.DATA)).some((n) => n.startsWith('plans.json.corrupt-')));
});

test('a user file that holds something else than the tracker keeps in it is moved aside too', async (t) => {
  const { ctx, cleanup } = await testContext({ files: { 'names.json': 'null', 'plans.json': '[1]', 'armies.json': '7',
    'talents.json': { a: { u: [1] } }, 'notified.json': { sent: { k: '2026-01-01T00:00:00.000Z' } } } });
  t.after(cleanup); // (also when the test fails)
  assert.deepEqual([ctx.user.names, ctx.user.plans, ctx.user.armies], [{ accounts: {}, units: {} }, {}, {}]);
  assert.deepEqual(ctx.user.talents, { a: { u: [1] } }, 'a whole file is read as it is');
  // a part that is only missing is filled in, and the file kept
  assert.deepEqual(ctx.user.sentLog, { sent: { k: '2026-01-01T00:00:00.000Z' }, log: [], pending: [] });
  assert.equal(ctx.user.notifyBaseline, false);
  const moved = (await readdir(ctx.paths.DATA)).filter((n) => n.includes('.corrupt-')).map((n) => n.split('.corrupt-')[0]).sort();
  assert.deepEqual(moved, ['armies.json', 'names.json', 'plans.json']);
  assert.equal(ctx.errorLog.list().length, 3);
});

test('what a file holds for one account that is something else is dropped, and the other accounts stay', async (t) => {
  const army = { id: 'x', name: 'Rush', tags: [] };
  const { ctx, cleanup } = await testContext({ files: { 'armies.json': { a: 7, b: [army] }, 'grid_history.json': { a: [1] },
    'progress.json': { a: 'text', b: { days: [] } }, 'talents.json': { a: [1], b: { u: [0] } } } });
  t.after(cleanup); // (also when the test fails)
  assert.deepEqual(ctx.user.armies, { b: [army] });
  assert.deepEqual([ctx.user.gridHistory, ctx.user.progress, ctx.user.talents], [{}, { b: { days: [] } }, { b: { u: [0] } }]);
  assert.equal(ctx.errorLog.list().filter((e) => e.source === 'data file').length, 4);
  // the files are written as they are now, and none is moved aside
  await flushWrites();
  assert.deepEqual(JSON.parse(await readFile(path.join(ctx.paths.DATA, 'armies.json'), 'utf8')), { b: [army] });
  assert.deepEqual((await readdir(ctx.paths.DATA)).filter((n) => n.includes('.corrupt-')), []);
  // the same after a restore: repair() says which were changed
  ctx.user.plans.a = 7;
  assert.deepEqual(ctx.user.repair(), ['plans']);
  assert.deepEqual(ctx.user.plans, {});
});

test('damaged game tables throw, so the caller can have them read again', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup); // (also when the test fails)
  await writeFile(path.join(ctx.paths.STATIC, 'rules.json'), '{nope');
  await assert.rejects(ctx.tables.load(), /rules\.json is not valid JSON/);
});
