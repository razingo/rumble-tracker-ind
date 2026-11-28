import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA } from '../server/migrations.mjs';
import { playerData } from '../server/playerdata.mjs';
import { BACKUP_KEYS, PLAYER_FILES } from '../server/userdata.mjs';
import { testContext } from './helpers.mjs';

const ACC = 'a'.repeat(32), OTHER = 'c'.repeat(32), UNIT = 'b'.repeat(32);

test('the player\'s data: the collections and the player\'s own files, without what belongs to this install', async (t) => {
  const { ctx, cleanup } = await testContext();
  t.after(cleanup);
  const units = [{ id: UNIT, level: 3 }], currencies = [{ id: UNIT, balance: 5, lifetime: 9 }];
  ctx.accounts.set(ACC, { snapshot: { units, currencies }, events: [{ t: 'x' }], lastChange: '2026-11-28T10:00:00.000Z', shop: {} });
  ctx.accounts.set(OTHER, { snapshot: null, events: [] });
  await ctx.user.setTalents(ACC, UNIT, [1]);
  await ctx.user.setDraft(ACC, { id: null, name: 'Draft' });
  const data = playerData(ctx);
  assert.deepEqual(data.collections, { [ACC]: { changed: '2026-11-28T10:00:00.000Z', units, currencies } });
  assert.deepEqual(Object.keys(data.files).sort(),
    ['armies', 'army', 'grid_history', 'names', 'plans', 'progress', 'pvp_history', 'talents']);
  assert.equal(data.files.talents, ctx.user.talents);
  assert.deepEqual([data.schema, data.device, data.rev], [SCHEMA, ctx.user.device.id, 1]);
});

test('every file in a backup is either the player\'s or this install\'s', () => {
  const install = ['drafts', 'notifySettings', 'appSettings'];
  assert.deepEqual([...PLAYER_FILES, ...install].sort(), Object.values(BACKUP_KEYS).sort());
});
