import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readdir } from 'node:fs/promises';
import { createUpdater } from '../server/update/updater.mjs';
import { host } from '../server/host.mjs';
import { createPackChecker } from '../server/datapack/checker.mjs';
import { testContext } from './helpers.mjs';

const app = { version: '9.9.9', zip: 'RumbleTracker-9.9.9-win-x64.zip', zipSha256: 'a'.repeat(64), exeSha256: 'b'.repeat(64) };
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('the updater downloads, has the launcher install, then stops', async () => {
  const { ctx, cleanup } = await testContext({ standalone: true });
  Object.assign(ctx.dataPack, { newVersion: '9.9.9', latestApp: app });
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
  await cleanup();
});

test('the updater shows a failed install and refuses when there is nothing to install', async () => {
  const { ctx, cleanup } = await testContext({ standalone: true });
  const start = createUpdater(ctx, { shutdown: () => assert.fail('must not stop'), download: async () => 'x.exe', applyDelay: 0 });
  assert.equal((await start())[0], 409);
  Object.assign(ctx.dataPack, { newVersion: '9.9.9', latestApp: app });
  host.attach({ options: {}, applyUpdate: async () => { throw new Error('The program file could not be replaced (EPERM).'); } });
  await start();
  await until(() => ctx.appUpdate.state === 'failed');
  assert.match(ctx.appUpdate.error, /EPERM/);
  assert.equal(ctx.errorLog.list().length, 1);
  await cleanup();
});

test('data pack checks run one at a time and announce a newer app', async () => {
  const { ctx, cleanup } = await testContext();
  ctx.dataPack.url = 'https://example.invalid/';
  let calls = 0, news = 0;
  const update = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return { updated: false, reason: 'up to date', latestAppVersion: '9.9.9', latestApp: app };
  };
  const check = createPackChecker(ctx, { update, onNews: () => news++ });
  await Promise.all([check(), check(), check()]);
  assert.equal(calls, 1);
  assert.equal(ctx.dataPack.newVersion, '9.9.9');
  assert.deepEqual(ctx.dataPack.latestApp, app);
  assert.equal(news, 1);
  await check();
  assert.equal(calls, 2);
  assert.equal(news, 1); // already announced
  await cleanup();
});

test('a damaged user file is moved aside and reported; the rest loads', async () => {
  const { ctx, cleanup } = await testContext({ files: { 'plans.json': '{"broken": ',
    'names.json': { accounts: { a: 'Main' }, units: {} } } });
  assert.deepEqual(ctx.user.plans, {});
  assert.equal(ctx.user.names.accounts.a, 'Main');
  assert.equal(ctx.errorLog.list()[0].source, 'data file');
  assert.ok((await readdir(ctx.paths.DATA)).some((n) => n.startsWith('plans.json.corrupt-')));
  await cleanup();
});

test('damaged game tables throw, so the caller can set the pack aside', async () => {
  const { ctx, cleanup } = await testContext();
  await writeFile(path.join(ctx.paths.STATIC, 'rules.json'), '{nope');
  await assert.rejects(ctx.tables.load(), /rules\.json is not valid JSON/);
  await cleanup();
});
