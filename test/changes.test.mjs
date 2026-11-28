import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { flushWrites } from '../server/store.mjs';
import { buildBackup } from '../server/backup.mjs';
import { createChangeLog, changesShape } from '../server/changes.mjs';
import { loadUserData } from '../server/userdata.mjs';
import { testContext } from './helpers.mjs';

const ACC = 'a'.repeat(32), UNIT = 'b'.repeat(32);
const json = async (...parts) => JSON.parse(await readFile(path.join(...parts), 'utf8'));
const army = (id, name = 'Army') => ({ id, name, leader: null, minis: [], talents: {}, description: '', tags: [] });

test('what was added, changed or removed since the last note gets the next revisions', () => {
  const files = { names: { accounts: { [ACC]: 'Main' }, units: {} }, talents: {}, army: {}, plans: {}, armies: { [ACC]: [army('x')] } };
  const changes = createChangeLog({}, files);
  assert.equal(changes.note('armies', files.armies), false, 'what was loaded is no change');
  files.armies[ACC].push(army('y'));
  files.armies[ACC][0].name = 'Renamed';
  const at = new Date('2026-11-28T10:00:00Z');
  assert.equal(changes.note('armies', files.armies, at), true);
  assert.deepEqual(changes.log.records.armies, {
    [`${ACC}/x`]: { rev: 1, t: '2026-11-28T10:00:00.000Z' }, [`${ACC}/y`]: { rev: 2, t: '2026-11-28T10:00:00.000Z' } });
  files.armies[ACC].shift();
  changes.note('armies', files.armies, at);
  assert.deepEqual(changes.log.records.armies[`${ACC}/x`], { rev: 3, t: '2026-11-28T10:00:00.000Z', deleted: true });
  // an entry that comes back is not a deleted one any more
  files.armies[ACC].push(army('x'));
  changes.note('armies', files.armies, at);
  assert.deepEqual(changes.log.records.armies[`${ACC}/x`], { rev: 4, t: '2026-11-28T10:00:00.000Z' });
  // names are kept by kind
  delete files.names.accounts[ACC];
  files.names.units[UNIT] = 'footmen';
  changes.note('names', files.names, at);
  assert.deepEqual(Object.keys(changes.log.records.names).sort(), [`accounts/${ACC}`, `units/${UNIT}`]);
  assert.equal(changes.log.records.names[`accounts/${ACC}`].deleted, true);
  assert.equal(changes.log.rev, 6);
  assert.equal(changes.tracks('pvpHistory'), false);
  for (const bad of [null, [], { rev: 'x' }, { records: [] }]) assert.equal(changesShape(bad), false);
  assert.equal(changesShape({}), true);
});

test('the player\'s changes are noted in changes.json, and the count goes on after a restart', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup);
  const u = ctx.user;
  await u.setTalents(ACC, UNIT, [0, 2]);
  await u.setTalents(ACC, UNIT, [0, 2]); // the same again is no change
  await u.saveArmy(ACC, army('one'));
  await u.saveArmy(ACC, army('one', 'Renamed'));
  await u.deleteArmy(ACC, 'one');
  await u.setPlan(ACC, 'event', { cost: 5, label: 'x', set: 't' });
  await u.setPlan(ACC, 'event', null);
  // what scans add and what belongs to this PC is not tracked
  u.pvpHistory[ACC] = [{ id: 'p', t: '1' }];
  await u.save('pvpHistory');
  await u.setAppSetting('checkUpdates', false);
  await flushWrites();
  const log = await json(ctx.paths.DATA, 'changes.json');
  assert.equal(log.rev, 6);
  assert.deepEqual(Object.keys(log.records).sort(), ['armies', 'plans', 'talents']);
  assert.equal(log.records.talents[`${ACC}/${UNIT}`].rev, 1);
  assert.deepEqual({ ...log.records.armies[`${ACC}/one`], t: 0 }, { rev: 4, t: 0, deleted: true });
  assert.equal(log.records.plans[`${ACC}/event`].deleted, true);
  assert.ok(!Number.isNaN(Date.parse(log.records.talents[`${ACC}/${UNIT}`].t)));

  const again = await loadUserData(ctx);
  await again.setTalents(ACC, UNIT, [1]);
  assert.equal(again.changes.records.talents[`${ACC}/${UNIT}`].rev, 7);
});

test('a restored backup is noted as a change of what it changed', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup);
  const u = ctx.user;
  await u.saveArmy(ACC, army('stays'));
  await u.saveArmy(ACC, army('goes'));
  const backup = JSON.parse(JSON.stringify(buildBackup({ armies: { [ACC]: [army('stays'), army('back')] } })));
  await u.restore(backup);
  const notes = u.changes.records.armies;
  assert.equal(notes[`${ACC}/stays`].rev, 1, 'the same as before the restore');
  assert.equal(notes[`${ACC}/goes`].deleted, true);
  assert.equal(notes[`${ACC}/back`].deleted, undefined);
  assert.equal(u.changes.rev, 4);
});

test('a PvP result set by hand names when it was set', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup);
  const u = ctx.user;
  u.pvpHistory[ACC] = [{ id: 'p', t: '1', unexplained: true }];
  assert.equal(await u.setPvpResult(ACC, { id: 'p' }, 'win'), true);
  assert.ok(!Number.isNaN(Date.parse(u.pvpHistory[ACC][0].manualAt)));
  assert.equal(await u.setPvpResult(ACC, { id: 'p' }, null), true);
  assert.equal(u.pvpHistory[ACC][0].manualAt, undefined);
});
