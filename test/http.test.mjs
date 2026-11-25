// The HTTP server and API handlers, through real requests to a server on a free port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHttpServer } from '../server/http/server.mjs';
import { createRoutes } from '../server/http/routes.mjs';
import { cleanArmy, addArmory, armoryFile } from '../server/http/handlers.mjs';
import { flushWrites } from '../server/store.mjs';
import { cleanAppSettings } from '../server/userdata.mjs';
import { testContext, hexId } from './helpers.mjs';

const ACC = hexId(1, 1), UNIT = hexId(0xa, 0xb), OTHER = hexId(0xc, 0xd);
let ctx, cleanup, server, base;
const calls = { quit: [], update: 0, checks: 0, autostart: false };

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const api = async (method, p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}),
    ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  ({ ctx, cleanup } = await testContext({ standalone: true }));
  ctx.port = await freePort();
  ctx.accounts.set(ACC, { snapshot: { units: [{ id: UNIT, level: 1 }], currencies: [] }, events: [] });
  ctx.user.pvpHistory[ACC] = [{ t: 'T1', season: 's', honor: 5, vp: 50, dh: 5, dv: 50, unexplained: true }];
  server = createHttpServer(ctx, {
    shutdown: (reason) => calls.quit.push(reason),
    startUpdate: async () => {
      calls.update++;
      return [200, { ok: true }];
    },
    checkForUpdate: () => { calls.checks++; },
    notifier: { test: async () => true },
    gameRunning: async () => false,
    autostart: { get: async () => calls.autostart, set: async (on) => {
      calls.autostart = on;
      return true;
    } },
  });
  await new Promise((r) => server.listen(ctx.port, '127.0.0.1', r));
  base = `http://localhost:${ctx.port}`;
});
after(async () => {
  server.close();
  await flushWrites();
  await cleanup();
});

test('state, and "unchanged" for a revision the page already has', async () => {
  const s = (await api('GET', '/api/state')).body;
  assert.equal(s.account, ACC);
  assert.equal(s.units[0].slug, 'kobold-miner');
  assert.equal(s.pvpLog.length, 0); // no PvP reading in the snapshot yet
  const u = (await api('GET', `/api/state?rev=${s.rev}&for=${ACC}`)).body;
  assert.equal(u.unchanged, true);
  assert.deepEqual(Object.keys(u).sort(), ['gameRunning', 'lastError', 'lastScan', 'problems', 'rev', 'unchanged', 'update']);
  // Another account or an old revision gets the full state.
  assert.equal((await api('GET', `/api/state?rev=${s.rev - 1}&for=${ACC}`)).body.unchanged, undefined);
});

test('the page, game data and refused requests', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  const rules = await fetch(`${base}/static/rules.json`);
  assert.equal(rules.status, 200);
  // a file the window already has is not sent again; one it has another version of is
  const again = (tag) => fetch(`${base}/static/rules.json`, { headers: { 'if-none-match': tag } });
  const same = await again(rules.headers.get('etag'));
  assert.deepEqual([same.status, await same.text()], [304, '']);
  assert.equal((await again('"other"')).status, 200);
  assert.equal((await fetch(`${base}/static/../../data/names.json`)).status, 404);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await api('POST', '/api/name', { kind: 'account', id: ACC, value: 'x' }, { origin: 'https://evil.example' })).status, 403);
  const form = await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 403);
  assert.equal(ctx.errorLog.list().length, 0); // none of these is a server error
});

test('saves account names and unit assignments', async () => {
  const rev = ctx.rev;
  assert.equal((await api('POST', '/api/name', { kind: 'account', id: ACC, value: ' Main ' })).status, 200);
  assert.equal(ctx.user.names.accounts[ACC], 'Main');
  assert.ok(ctx.rev > rev);
  assert.equal((await api('POST', '/api/name', { kind: 'unit', id: OTHER, value: 'kobold-miner' })).status, 409); // taken by UNIT
  assert.equal((await api('POST', '/api/name', { kind: 'unit', id: OTHER, value: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/name', { kind: 'unit', id: OTHER, value: 'footmen' })).status, 200);
  assert.equal((await api('POST', '/api/name', { kind: 'x', id: ACC, value: 'a' })).status, 400);
  await flushWrites();
  assert.equal(JSON.parse(await readFile(path.join(ctx.paths.DATA, 'names.json'), 'utf8')).units[OTHER], 'footmen');
});

test('talents, army slots, plans, drafts and saved armies are cleaned', async () => {
  assert.deepEqual((await api('POST', '/api/talents', { account: ACC, unitId: UNIT, picks: [2, 2, 7, 0] })).body.picks, [0, 2]);
  const slots = (await api('POST', '/api/army', { account: ACC, unitId: UNIT,
    slots: Array.from({ length: 7 }, (_, i) => ({ type: 'Melee', tier: 9, boost: true })) })).body.slots;
  assert.equal(slots[0].type, 'Leader');
  assert.equal(slots[1].tier, 2);
  assert.deepEqual(slots.map((s) => !!s.boost), [false, false, false, false, false, false, true]);
  assert.equal((await api('POST', '/api/army', { account: ACC, unitId: UNIT, slots: [] })).status, 400);
  assert.equal((await api('POST', '/api/plans', { account: ACC, eventId: 'ev', plan: { cost: 50, label: 'x' } })).status, 200);
  assert.equal(ctx.user.plans[ACC].ev.cost, 50);
  await api('POST', '/api/plans', { account: ACC, eventId: 'ev', plan: null });
  assert.equal(ctx.user.plans[ACC].ev, undefined);
  const rev = ctx.rev;
  assert.equal((await api('POST', '/api/draft', { account: ACC,
    draft: { name: 'D', leader: 'kobold-miner', minis: ['footmen', 'bogus'] } })).status, 200);
  assert.equal(ctx.rev, rev); // drafts don't bump the revision
  assert.deepEqual(ctx.user.drafts[ACC].minis.slice(0, 2), ['footmen', null]);
  const armies = (await api('POST', '/api/armies', { account: ACC, armies: [{ name: '', tags: ['a', 'A', ' b '] }] })).body.armies;
  assert.deepEqual([armies[0].name, armies[0].tags], ['Army', ['a', 'b']]);
  assert.equal((await api('POST', '/api/armies', { account: ACC, armies: Array(51).fill({}) })).status, 400);
});

test('army cleaning', () => {
  const slugs = new Set(['a']);
  assert.deepEqual(cleanArmy({ id: '', leader: 'x', minis: ['a'], talents: { a: 1, b: 2, c: 9 } }, slugs, { keepEmptyId: true }),
    { id: null, name: 'Army', leader: null, minis: ['a', null, null, null, null, null], talents: { a: 1 }, description: '', tags: [] });
});

test('exports the Armory and imports it, skipping armies already there', async () => {
  await api('POST', '/api/armies', { account: ACC, armies: [
    { id: 'x1', name: 'Rush', leader: 'kobold-miner', minis: ['footmen'], talents: { footmen: 1 }, description: 'Fast', tags: ['pvp'] },
  ] });
  const r = await fetch(`${base}/api/armory?account=${ACC}`);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="rumble-armory-\d{4}-\d{2}-\d{2}\.json"/);
  const file = await r.json();
  assert.equal(file.format, 'rumble-tracker-armory');
  assert.deepEqual(file.armies, [{ name: 'Rush', leader: 'kobold-miner', minis: ['footmen', null, null, null, null, null],
    talents: { footmen: 1 }, description: 'Fast', tags: ['pvp'] }]);
  let res = await api('POST', '/api/armory/import', { account: ACC, file });
  assert.deepEqual(res.body, { ok: true, added: 0, duplicates: 1, full: 0 });
  file.armies.push({ ...file.armies[0], name: 'Rush 2' });
  res = await api('POST', '/api/armory/import', { account: ACC, file });
  assert.deepEqual([res.body.added, res.body.duplicates], [1, 1]);
  const saved = ctx.user.armies[ACC];
  assert.deepEqual(saved.map((a) => a.name), ['Rush', 'Rush 2']);
  assert.notEqual(saved[1].id, saved[0].id);
  assert.equal((await api('POST', '/api/armory/import', { account: ACC, file: { armies: [] } })).status, 400);
});

test('an imported Armory is cleaned and stops at the limit', () => {
  const slugs = new Set(['a']);
  const file = armoryFile(Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, name: `A${i}`, leader: 'x', minis: ['a'],
    talents: {}, description: '', tags: [] })));
  const r = addArmory([], file, slugs);
  assert.deepEqual([r.added, r.duplicates, r.full], [50, 0, 10]);
  assert.equal(r.armies[0].leader, null);
  assert.equal(new Set(r.armies.map((a) => a.id)).size, 50);
  assert.equal(addArmory([], { format: 'other', armies: [] }, slugs), null);
});

test('marks an unexplained PvP change as a win or a loss', async () => {
  assert.equal((await api('POST', '/api/pvp/result', { account: ACC, t: 'T1', result: 'win' })).status, 200);
  assert.equal(ctx.user.pvpHistory[ACC][0].wins, 1);
  assert.equal((await api('POST', '/api/pvp/result', { account: ACC, t: 'nope', result: 'win' })).status, 400);
  assert.equal((await api('POST', '/api/pvp/result', { account: ACC, t: 'T1', result: null })).status, 200);
  assert.equal(ctx.user.pvpHistory[ACC][0].wins, undefined);
});

test('backup and restore', async () => {
  const r = await fetch(`${base}/api/backup`);
  assert.match(r.headers.get('content-disposition'), /rumble-tracker-backup-\d{4}-\d{2}-\d{2}\.json/);
  const backup = await r.json();
  assert.ok(backup.data.pvp_history[ACC]);
  ctx.user.names.accounts[ACC] = 'Changed';
  const res = await api('POST', '/api/restore', { backup });
  assert.equal(res.status, 200);
  assert.ok(res.body.restored.includes('pvp_history'));
  assert.equal(ctx.user.names.accounts[ACC], 'Main');
  assert.equal((await api('POST', '/api/restore', { backup: { format: 'x' } })).status, 400);
});

test('turns Start with Windows on and off', async () => {
  assert.equal((await api('GET', '/api/settings')).body.startWithWindows, false);
  assert.equal((await api('POST', '/api/settings', { startWithWindows: true })).body.startWithWindows, true);
  assert.equal(calls.autostart, true);
  assert.equal((await api('POST', '/api/settings', { startWithWindows: false })).body.startWithWindows, false);
  assert.equal(calls.autostart, false);
});

test('saves what closing the window does', async () => {
  assert.equal((await api('GET', '/api/settings')).body.closeWindow, 'ask');
  assert.equal((await api('POST', '/api/settings', { closeWindow: 'tray' })).body.closeWindow, 'tray');
  assert.equal(ctx.user.appSettings.closeWindow, 'tray');
  assert.equal((await api('POST', '/api/settings', { closeWindow: 'later' })).status, 400);
  // a saved choice that isn't one any more falls back to asking
  assert.deepEqual(cleanAppSettings({ closeWindow: 'later' }), { closeWindow: 'ask', checkUpdates: true });
  assert.deepEqual(cleanAppSettings(undefined), { closeWindow: 'ask', checkUpdates: true });
});

test('turns the check for new versions off and on', async () => {
  assert.equal((await api('GET', '/api/settings')).body.checkUpdates, true);
  assert.equal((await api('POST', '/api/settings', { checkUpdates: false })).body.checkUpdates, false);
  assert.equal(ctx.user.appSettings.checkUpdates, false);
  assert.equal(calls.checks, 1, 'a check follows at once, which clears a version found before');
  assert.equal((await api('POST', '/api/settings', { checkUpdates: true })).body.checkUpdates, true);
});

test('the page asks for a check when its window comes into view, at most every few minutes', async () => {
  const before = calls.checks;
  ctx.appUpdate.lastCheck = null;
  assert.equal((await api('POST', '/api/update/check', {})).status, 200);
  assert.equal(calls.checks, before + 1);
  ctx.appUpdate.lastCheck = new Date().toISOString(); // (the real check writes this down)
  await api('POST', '/api/update/check', {});
  assert.equal(calls.checks, before + 1, 'not again so soon');
  ctx.appUpdate.lastCheck = new Date(Date.now() - 10 * 60000).toISOString();
  ctx.appUpdate.checkError = 'GitHub answered 503.';
  await api('POST', '/api/update/check', {});
  assert.equal(calls.checks, before + 2);
  const s = (await api('GET', '/api/settings')).body;
  assert.equal(s.lastUpdateCheck, ctx.appUpdate.lastCheck);
  assert.equal(s.updateCheckError, 'GitHub answered 503.');
  ctx.appUpdate.checkError = null;
});

test('running from source, there are no routes that act on the exe', async () => {
  const source = await testContext();
  try {
    const routes = createRoutes(source.ctx, {});
    const exeOnly = ['quit', 'update', 'screenshot', 'show-window', 'uninstall'].map((r) => `POST /api/${r}`);
    assert.deepEqual(exeOnly.filter((r) => routes.has(r)), []);
    assert.ok(routes.has('POST /api/update/later'), 'Later is there too: the pop-up opens GitHub Releases from source');
  } finally {
    await source.cleanup();
  }
});

test('quit, update and Later in the exe', async () => {
  await api('POST', '/api/update', {});
  assert.equal(calls.update, 1);
  ctx.appUpdate.newVersion = '9.9.9';
  await api('POST', '/api/update/later', {});
  assert.equal((await api('GET', '/api/state')).body.update.later, true);
  ctx.appUpdate.newVersion = null;
  assert.equal((await api('POST', '/api/quit', {})).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(calls.quit, ['Quit from the page']);
});

test('lists automatic backups and restores one by day', async () => {
  const { writeDailyBackup } = await import('../server/backup.mjs');
  ctx.user.names.accounts[ACC] = 'Backed up';
  await writeDailyBackup(ctx.paths.BACKUPS, ctx.user.backupFiles(), { now: new Date(2026, 10, 18, 12) });
  ctx.user.names.accounts[ACC] = 'Later';
  const list = (await api('GET', '/api/backups')).body.backups;
  assert.deepEqual(list.map((b) => b.day), ['2026-11-18']);
  assert.equal((await api('POST', '/api/backups/restore', { day: '2026-11-18' })).status, 200);
  assert.equal(ctx.user.names.accounts[ACC], 'Backed up');
  assert.equal((await api('POST', '/api/backups/restore', { day: '../names' })).status, 404);
  assert.equal((await api('POST', '/api/backups/restore', { day: '2020-01-01' })).status, 404);
});

test("the exe's window is shown on request, and the tracker uninstalls", async () => {
  const { host } = await import('../server/host.mjs');
  let shown = 0, uninstalled = 0;
  host.attach({ options: {}, showWindow: () => shown++, uninstall: () => uninstalled++ });
  // the exe started again: the running tracker shows its window
  assert.equal((await api('POST', '/api/show-window', {})).status, 200);
  assert.equal(shown, 1);
  // Uninstall in Settings, once the answer has reached the page
  assert.equal((await api('POST', '/api/uninstall', {})).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(uninstalled, 1);
});

test("the tracker's folder: a move from Settings is noted, then the tracker restarts; a folder is opened only by its kind", async () => {
  const { host } = await import('../server/host.mjs');
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'rt-http-storage-'));
  const storage = { folder: path.join(dir, 'now', 'RumbleTracker'), note: path.join(dir, 'roaming', 'location.json') };
  await mkdir(path.join(storage.folder, 'data'), { recursive: true });
  await mkdir(path.dirname(storage.note), { recursive: true });
  await writeFile(storage.note, JSON.stringify({ folder: storage.folder }));
  let restarted = 0;
  const reading = ctx.gameData;
  try {
    // where the folder is set by the one who started the tracker, there is no choice
    host.attach({ options: {}, restart: () => restarted++ });
    assert.equal((await api('GET', '/api/settings')).body.storageFolder, null);
    assert.match((await api('POST', '/api/storage', { folder: path.join(dir, 'games') })).body.error, /set where it was started/);
    host.attach({ options: { storage }, restart: () => restarted++ });
    assert.equal((await api('GET', '/api/settings')).body.storageFolder, storage.folder);
    // not while the game data is read, nor to a folder that will not do
    ctx.gameData = { ...reading, reading: true };
    assert.match((await api('POST', '/api/storage', { folder: path.join(dir, 'games') })).body.error, /game data is being read/);
    ctx.gameData = { ...reading, reading: false };
    assert.match((await api('POST', '/api/storage', { folder: 'games' })).body.error, /whole path/);
    assert.equal(restarted, 0);
    const moved = await api('POST', '/api/storage', { folder: path.join(dir, 'games') });
    assert.deepEqual([moved.status, moved.body.folder], [200, path.join(dir, 'games', 'RumbleTracker')]);
    assert.deepEqual(JSON.parse(await readFile(storage.note, 'utf8')), { folder: storage.folder, moveTo: moved.body.folder,
      made: [moved.body.folder, path.join(dir, 'games')] });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(restarted, 1);
    // (a folder of a kind that is known would open in Explorer, so only the refusal is tried)
    assert.equal((await api('POST', '/api/open-folder', { which: path.join(dir, 'games') })).status, 400);
    assert.equal((await api('POST', '/api/open-folder', {})).status, 400);
  } finally {
    ctx.gameData = reading;
    host.attach({ options: {} });
    await rm(dir, { recursive: true, force: true });
  }
});
