// The connection between the exe's launcher and the server (server/host.mjs). Each test file runs in its own
// process, so attaching here doesn't affect other tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { host } from '../server/host.mjs';

test('before the launcher attaches, the server works on its own', async () => {
  assert.equal(host.attached, false);
  assert.deepEqual(host.options, {});
  assert.equal(host.quit('Quit from the tray'), false); // nothing to stop yet
  await assert.rejects(host.applyUpdate({ exe: 'x', version: '1.0.0' }), /can't install updates/);
  host.takeScreenshot(); // ignored
});

test('Quit, game reports and notification identity', () => {
  const quits = [];
  host.onQuit((reason) => quits.push(reason));
  assert.equal(host.quit('Windows is signing out or shutting down'), true);
  assert.deepEqual(quits, ['Windows is signing out or shutting down']);

  host.reportGame(true); // before anyone listens: passed on when they do
  const seen = [];
  host.onGame((running) => seen.push(running), () => seen.push('failed'));
  host.reportGame(true); // no change
  host.reportGame(false);
  host.gameWatchFailed();
  assert.deepEqual(seen, [true, false, 'failed']);

  assert.deepEqual(host.notificationIdentity(), { appId: null, launch: null });
  host.setNotificationIdentity({ appId: 'app' });
  host.setNotificationIdentity({ launch: 'rumble-tracker:open' });
  assert.deepEqual(host.notificationIdentity(), { appId: 'app', launch: 'rumble-tracker:open' });
});

test('the launcher\'s hooks', async () => {
  const calls = [];
  host.attach({
    options: { port: 8790, dataDir: 'D' },
    applyUpdate: async (u) => { calls.push(['update', u.version]); },
    takeScreenshot: () => calls.push(['screenshot']),
    showWindow: () => calls.push(['show']),
    uninstall: () => calls.push(['uninstall']),
  });
  assert.equal(host.attached, true);
  assert.equal(host.options.port, 8790);
  await host.applyUpdate({ exe: 'x', version: '2.0.0' });
  host.takeScreenshot();
  host.showWindow();
  host.uninstall();
  assert.deepEqual(calls, [['update', '2.0.0'], ['screenshot'], ['show'], ['uninstall']]);
  // the window program's report reaches the server's listener
  let closed = 0;
  host.windowClosed(); // nobody listens yet
  host.onWindowClosed(() => closed++);
  host.windowClosed();
  assert.equal(closed, 1);
});
