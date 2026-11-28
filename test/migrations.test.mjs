import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { flushWrites } from '../server/store.mjs';
import { buildBackup } from '../server/backup.mjs';
import { SCHEMA, migrate, schemaOf } from '../server/migrations.mjs';
import { loadUserData } from '../server/userdata.mjs';
import { testContext } from './helpers.mjs';

const ACC = 'a'.repeat(32);
const json = async (...parts) => JSON.parse(await readFile(path.join(...parts), 'utf8'));
// a made-up step to version 2: every saved army gets a mark, once
const steps = [{ to: 2, run(files) {
  let changed = false;
  for (const list of Object.values(files.armies)) for (const a of list) if (!a.marked) changed = a.marked = true;
  return changed ? ['armies'] : [];
} }];

test('steps run from the version the data has, oldest first, and name what they changed', () => {
  const ran = [];
  const list = [2, 3, 4].map((to) => ({ to, run: () => { ran.push(to); return to === 4 ? [] : ['names', `v${to}`]; } }));
  assert.deepEqual(migrate({}, 2, list), ['names', 'v3']);
  assert.deepEqual(ran, [3, 4]);
  assert.deepEqual(migrate({}, 4, list), []);
  for (const v of [undefined, null, 0, -1, 1.5, '2']) assert.equal(schemaOf(v), 1);
  assert.equal(schemaOf(3), 3);
});

test('a data folder gets a note of its version, and a backup names it', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup);
  await flushWrites();
  assert.deepEqual(await json(ctx.paths.DATA, 'schema.json'), { schema: SCHEMA });
  assert.equal(buildBackup(ctx.user.backupFiles()).schema, SCHEMA);
});

test('data of an older version is brought up to date once, and kept as it was in a backup', async (t) => {
  const { ctx, cleanup } = await testContext({ files: { 'armies.json': { [ACC]: [{ id: 'a1', name: 'One' }] } } });
  t.after(cleanup);
  const u = await loadUserData(ctx, { schema: 2, steps });
  await flushWrites();
  assert.equal(u.armies[ACC][0].marked, true);
  assert.equal((await json(ctx.paths.DATA, 'armies.json'))[ACC][0].marked, true);
  assert.deepEqual(await json(ctx.paths.DATA, 'schema.json'), { schema: 2 });
  assert.deepEqual(await readdir(ctx.paths.BACKUPS), ['rumble-tracker-backup-before-data-v2.json']);
  const before = await json(ctx.paths.BACKUPS, 'rumble-tracker-backup-before-data-v2.json');
  assert.equal(before.schema, 1);
  assert.deepEqual(before.data.armies, { [ACC]: [{ id: 'a1', name: 'One' }] });
  // the next start finds the note and leaves the data alone
  await writeFile(path.join(ctx.paths.DATA, 'armies.json'), JSON.stringify({ [ACC]: [{ id: 'a2', name: 'Two' }] }));
  assert.equal((await loadUserData(ctx, { schema: 2, steps })).armies[ACC][0].marked, undefined);
});

test('data of a newer tracker is used as it is, and its note stays', async (t) => {
  const files = { 'schema.json': { schema: SCHEMA + 5 }, 'names.json': { accounts: { [ACC]: 'Main' } } };
  const { ctx, cleanup } = await testContext({ files });
  t.after(cleanup);
  await flushWrites();
  assert.equal(ctx.user.names.accounts[ACC], 'Main');
  assert.deepEqual(await json(ctx.paths.DATA, 'schema.json'), { schema: SCHEMA + 5 });
  assert.equal(ctx.errorLog.list().filter((e) => e.source === 'data version').length, 1);
});

test('a backup of an older version is brought up to date when it is restored', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup);
  const u = await loadUserData(ctx, { schema: 2, steps });
  const old = buildBackup({ armies: { [ACC]: [{ id: 'a1', name: 'One' }] } }, new Date(), 1);
  assert.deepEqual((await u.restore(JSON.parse(JSON.stringify(old)))).restored, ['armies']);
  assert.equal(u.armies[ACC][0].marked, true);
  await flushWrites();
  assert.equal((await json(ctx.paths.DATA, 'armies.json'))[ACC][0].marked, true);
  // (a backup from before there were versions names none)
  delete old.schema;
  old.data.armies[ACC][0].marked = undefined;
  await u.restore(JSON.parse(JSON.stringify(old)));
  assert.equal(u.armies[ACC][0].marked, true);
});
