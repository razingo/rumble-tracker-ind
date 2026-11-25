// The rdmodule: its part of the server, and its extraction as far as it can be checked without the game (which steps
// run again, the picture server, and that the list of what is drawn and the rdmodule's code name the same things).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stepsDue, stepVersions, remadeFor, renderServer, outOfDate } from '../tools/rdmodule/extract.mjs';
import { runSteps } from '../tools/gamedata/build.mjs';
import { createRdmodule } from '../server/rdmodule.mjs';
import { createHttpServer } from '../server/http/server.mjs';
import { testContext } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the rdmodule: nothing extracted at first, and its page is served with its own policy', async () => {
  const { ctx, cleanup } = await testContext();
  ctx.port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  const rdmodule = createRdmodule(ctx);
  const server = createHttpServer(ctx, { notifier: {}, gameRunning: async () => false, rdmodule });
  await new Promise((r) => server.listen(ctx.port, '127.0.0.1', r));
  const base = `http://localhost:${ctx.port}`;
  try {
    // (the made-up app folder has no extraction tools)
    const { smallPc, freeSpace, neededSpace, ...status } = await rdmodule.status();
    assert.equal(typeof smallPc, 'boolean'); // (by this PC's memory)
    assert.ok(freeSpace > 0 && neededSpace > 2 ** 30, 'the free and the needed disk space, in bytes');
    assert.deepEqual(status, { available: false, state: 'none', waiting: false, extracted: null, outOfDate: false,
      done: 0, total: 0, label: '', error: null });
    assert.equal(await rdmodule.start(), false);
    assert.equal((await fetch(`${base}/api/rdmodule/extract`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{}' })).status, 400);
    await mkdir(rdmodule.folders.code, { recursive: true });
    await writeFile(path.join(rdmodule.folders.code, 'index.html'), '<!doctype html><title>m</title>');
    await mkdir(path.join(rdmodule.folders.extracted, 'sprites'), { recursive: true });
    await writeFile(path.join(rdmodule.folders.extracted, 'sprites', 'index.json'), '{}');
    // a stamp that was cut off is no extraction
    await writeFile(path.join(rdmodule.folders.extracted, 'ready.json'), '{"extracted":"2026-01-02T03');
    assert.equal((await rdmodule.status()).state, 'none');
    assert.equal((await rdmodule.status()).extracted, null);
    assert.equal(outOfDate(rdmodule.folders.extracted), false);
    await writeFile(path.join(rdmodule.folders.extracted, 'ready.json'), '{"extracted":"2026-01-02T03:04:05.000Z"}');
    assert.equal((await rdmodule.status()).state, 'ready');
    assert.equal((await rdmodule.status()).extracted, '2026-01-02T03:04:05.000Z');
    const page = await fetch(`${base}/rdmodule/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /media-src 'self' blob:/);
    assert.equal((await fetch(`${base}/rdmodule/sprites/index.json`)).status, 200);
    // nothing outside its folders, such as the data folder's own files
    assert.equal((await fetch(`${base}/rdmodule/sprites/..%2F..%2Fconfig.json`)).status, 403);
    assert.doesNotMatch((await fetch(`${base}/`)).headers.get('content-security-policy'), /blob:/);
  } finally {
    server.close();
    await cleanup();
  }
});

test('a step is due when its script or inputs changed, everything without a stamp', () => {
  const steps = stepVersions();
  assert.equal(stepsDue(null, null), 'all');
  assert.equal(stepsDue(null, { extracted: '2026-01-02T03:04:05.000Z' }), 'all', 'a stamp from before steps had versions');
  assert.equal(stepsDue(null, { steps }), 'all', 'a stamp from before the output was hashed');
  const hashes = {};
  assert.deepEqual(stepsDue(null, { steps, hashes }), []);
  assert.deepEqual(stepsDue(null, { hashes, steps: { ...steps, Sprites: 'older', Sounds: undefined } }), ['Sounds', 'Sprites']);
});

test('the steps that read the tracker\'s game data are due when its tables change, and only those', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-tables-'));
  try {
    await writeFile(path.join(dir, 'minis.json'), '{"minis":[]}');
    await writeFile(path.join(dir, 'unit_ids.json'), '{"units":{}}');
    const stamp = { steps: stepVersions(dir), hashes: {} };
    assert.deepEqual(stepsDue(null, stamp, dir), []);
    await writeFile(path.join(dir, 'unit_ids.json'), '{"units":{"a":"new-mini"}}');
    const due = stepsDue(null, stamp, dir);
    assert.ok(due.includes('List of minis') && due.includes('Animations'), due.join(', '));
    assert.deepEqual(due.filter((s) => /^(Sprites|Backdrops|Effect sprites|Map|Index of the game files)$/.test(s)), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a step runs after one that made something else, and the bulky exports it reads are made again first', async () => {
  const run = async (due, changed) => {
    const order = [];
    const step = (name) => async () => { order.push(name); };
    const steps = [['Python', []], ['Animations 1/2', ['Python']], ['Animations 2/2', ['Python']],
      ['Animations', ['Animations 1/2', 'Animations 2/2']], ['Tower models', ['Python']], ['Catalog', ['Animations']],
      ['Sprites', ['Catalog', 'Animations', 'Tower models']], ['Sounds', ['Python']], ['Sounds picked', ['Sounds']]]
      .map(([name, needs]) => [name, needs, step(name)]);
    const names = steps.map((x) => x[0]);
    await runSteps(steps, { atOnce: 1, only: new Set(names.filter((n) => due.includes(n.replace(/ \d+\/\d+$/, '')))),
      ran: (name) => / \d/.test(name) || changed.includes(name), remade: (name) => remadeFor(names, name) });
    return order;
  };
  // the sprite page changed: the models and animations it draws were deleted, and nothing else runs
  assert.deepEqual(await run(['Sprites'], []), ['Animations 1/2', 'Animations 2/2', 'Animations', 'Tower models', 'Sprites']);
  // the catalog's script changed, the catalog did not: nothing is drawn, nothing is made again
  assert.deepEqual(await run(['Catalog'], []), ['Catalog']);
  assert.deepEqual(await run(['Catalog'], ['Catalog']), ['Catalog', 'Animations 1/2', 'Animations 2/2', 'Animations',
    'Tower models', 'Sprites']);
  // a split step is due as a whole; what is drawn from it only when it made something else
  assert.deepEqual(await run(['Animations'], []), ['Animations 1/2', 'Animations 2/2', 'Animations']);
  assert.deepEqual(await run(['Animations'], ['Animations']), ['Animations 1/2', 'Animations 2/2', 'Animations', 'Catalog',
    'Tower models', 'Sprites']);
  assert.deepEqual(await run(['Sounds picked'], []), ['Sounds', 'Sounds picked']);
});

test('the list of what is drawn and the code name the same sprites and effects', async () => {
  const code = await readFile(path.join(ROOT, 'rdmodule', 'game.js'), 'utf8');
  const { sprites, effects } = JSON.parse(await readFile(path.join(ROOT, 'tools', 'rdmodule', 'render', 'sprites.json'), 'utf8'));
  // (towers are named by kind: `tower-${kind}`)
  const named = (key) => code.includes(`'${key}'`) || code.includes(`${key}:`) || (key.startsWith('tower-') && code.includes('`tower-'));
  assert.deepEqual(Object.keys(sprites).filter((k) => !named(k)), [], 'sprites drawn that the code never shows');
  assert.deepEqual(Object.keys(effects).filter((k) => !named(k)), [], 'effects drawn that the code never shows');
  const art = [...code.matchAll(/art: '([\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(art.filter((id) => !sprites[id]), [], 'sprites the code shows that are not drawn');
});

test('the picture server saves what its own pages post, and nothing from another site or under another name', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-render-'));
  const work = path.join(dir, 'work'), sprites = path.join(dir, 'sprites');
  await mkdir(work);
  await mkdir(sprites);
  const server = await renderServer(work, sprites);
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = (name, headers = {}) => fetch(`${base}/save/${name}`, { method: 'POST', body: 'picture', headers });
  try {
    assert.equal((await save('footman.png', { origin: base })).status, 204, 'its own page');
    assert.equal(await readFile(path.join(sprites, 'footman.png'), 'utf8'), 'picture');
    assert.equal((await save('log-page.json', { origin: base })).status, 204);
    assert.equal(await readFile(path.join(work, 'log-page.json'), 'utf8'), 'picture', 'a page\'s log goes to the working folder');
    assert.equal((await save('index.json', { origin: 'http://evil.example' })).status, 403, 'a page of another site');
    assert.equal((await save('ready.exe', { origin: base })).status, 400, 'only pictures and indexes');
    assert.equal((await save('..%2Fwork%2Fx.json', { origin: base })).status, 400);
    assert.equal((await fetch(`${base}/models/..%2F..%2Fsprites%2Ffootman.png`)).status, 404, 'nothing outside its folders');
    assert.equal((await fetch(`${base}/sprites/footman.png`)).status, 200);
    // the pages it serves load three.js from here: they name nothing on the web, so nothing is downloaded
    for (const page of ['render.html', 'fx/effects.html']) {
      const r = await fetch(`${base}/${page}`);
      assert.equal(r.status, 200, page);
      assert.doesNotMatch(await r.text(), /https?:\/\//, `${page} names a web address`);
    }
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});
