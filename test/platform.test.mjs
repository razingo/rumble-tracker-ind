import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platform } from '../server/platform/index.mjs';
import * as windows from '../server/platform/windows/index.mjs';
import * as none from '../server/platform/none.mjs';

test('every system offers the same things', () => {
  const names = Object.keys(windows).sort();
  assert.deepEqual(Object.keys(none).sort(), names);
  for (const name of names) {
    if (name === 'name' || name === 'autostart') continue;
    assert.equal(typeof windows[name], 'function', name);
    assert.equal(typeof none[name], 'function', name);
  }
  assert.deepEqual(Object.keys(windows.autostart).sort(), ['command', 'read', 'refresh', 'set']);
  assert.equal(platform, process.platform === 'win32' ? windows : none);
});

test('a system without code of its own reads no save and shows nothing, and says so', async () => {
  await assert.rejects(none.readSave(), /can't read the game's saved data on this system/);
  assert.equal(none.watchGame(() => {}).running(), null);
  assert.equal(none.watchGameFromTray(() => {}).running(), null);
  assert.equal(await none.gameRunningOnce(), false);
  assert.equal(await none.showNotification('a', 'b'), false);
  assert.equal(none.autostart, null);
});
