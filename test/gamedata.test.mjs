// Reading the game data from the game install: the game's folder given by hand, the runner of the build's steps, the
// read in the background after a game patch, and the rdmodule's part of the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { givenGameFolder, setGameFolder, isGameFolder } from '../server/game/folder.mjs';
import { createRdmodule } from '../server/rdmodule.mjs';
import { createHttpServer } from '../server/http/server.mjs';
import { createGameData } from '../server/gamedata.mjs';
import { runSteps, findGame, stepsDue, stepVersions } from '../tools/gamedata/build.mjs';
import { testContext } from './helpers.mjs';

/** A folder that looks like the game's: it has the folder the game's files are in. */
async function fakeGame(dir) {
  const game = path.join(dir, 'Warcraft Rumble');
  await mkdir(path.join(game, 'Data', 'StreamingAssets', 'Bundles'), { recursive: true });
  return game;
}

test('keeps a game folder given by hand, and refuses one that is not the game', async () => {
  const { ctx, dir, cleanup } = await testContext();
  try {
    const game = await fakeGame(dir);
    assert.equal(await givenGameFolder(ctx), '');
    assert.equal(await isGameFolder(game), true);
    assert.equal(await isGameFolder(dir), false);
    // as pasted from Explorer: in quotes, with a slash at its end
    assert.equal(await setGameFolder(ctx, ` "${game}${path.sep}" `), game);
    assert.equal(await givenGameFolder(ctx), game);
    assert.equal(findGame(await givenGameFolder(ctx)), game);
    await assert.rejects(setGameFolder(ctx, dir), /not the game's folder/);
    await assert.rejects(setGameFolder(ctx, 'Warcraft Rumble'), /whole path/);
    assert.equal(await givenGameFolder(ctx), game, 'a refused folder changes nothing');
    // other settings in the file stay
    const file = path.join(ctx.paths.DATA, 'config.json');
    await writeFile(file, JSON.stringify({ gameFolder: game, other: 1 }));
    assert.equal(await setGameFolder(ctx, ''), '');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other: 1 });
  } finally {
    await cleanup();
  }
});

test('runs steps side by side, each after the ones it waits for', async () => {
  const order = [], progress = [];
  let running = 0, most = 0;
  const step = (name, ms) => async () => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    order.push(name);
    return [`${name} out`];
  };
  const lines = await runSteps([
    ['a', [], step('a', 30)],
    ['b', [], step('b', 5)],
    ['c', ['a', 'b'], step('c', 5)],
    ['d', ['c'], step('d', 1)],
  ], { atOnce: 2, onStep: (done, total, label) => progress.push([done, total, label]) });
  assert.deepEqual(order, ['b', 'a', 'c', 'd']);
  assert.equal(most, 2);
  assert.deepEqual(lines.sort(), ['a out', 'b out', 'c out', 'd out']);
  assert.deepEqual(progress[0], [0, 4, 'a, b']);
  assert.equal(progress.at(-1)[0], 3, 'the last report is before the last step ends');
});

test('a failed step stops the rest, once the running ones have finished', async () => {
  const done = [];
  await assert.rejects(runSteps([
    ['bad', [], async () => { throw new Error('broke'); }],
    ['slow', [], async () => { await new Promise((r) => setTimeout(r, 20)); done.push('slow'); }],
    ['after', ['slow'], async () => { done.push('after'); }],
  ], { atOnce: 2 }), /broke/);
  assert.deepEqual(done, ['slow']);
});

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
    assert.deepEqual(await rdmodule.status(),
      { available: false, state: 'none', extracted: null, outOfDate: false, done: 0, total: 0, label: '', error: null });
    assert.equal(await rdmodule.start(), false);
    assert.equal((await fetch(`${base}/api/rdmodule/extract`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{}' })).status, 400);
    await mkdir(rdmodule.folders.code, { recursive: true });
    await writeFile(path.join(rdmodule.folders.code, 'index.html'), '<!doctype html><title>m</title>');
    await mkdir(path.join(rdmodule.folders.extracted, 'sprites'), { recursive: true });
    await writeFile(path.join(rdmodule.folders.extracted, 'sprites', 'index.json'), '{}');
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

/** A stand-in for tools/gamedata/build.mjs: "reads" a made-up game of the given version, or fails. */
function fakeBuilder(game) {
  const b = {
    BuildError: class extends Error {}, builds: 0, version: '2.0.0.1', fail: null,
    findGame: () => game,
    gameVersion: () => b.version,
    due: [], // what the last build was asked for
    stepsDue: (g, stamp) => (!stamp || (!!g && stamp.gameBuild !== b.version) ? 'all' : b.changed),
    changed: [],
    async buildGameData({ out, due }) {
      b.builds++;
      b.due = due;
      if (b.fail) throw new b.BuildError(b.fail);
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, 'rules.json'), JSON.stringify({ rarities: [], marker: b.version }));
      await writeFile(path.join(out, 'minis.json'), JSON.stringify({ minis: [{ slug: 'new-mini', name: 'New' }] }));
      await writeFile(path.join(out, 'gamedata.json'), JSON.stringify({ gameBuild: b.version }));
      return { gameBuild: b.version, steps: ['Minis'] };
    },
  };
  return b;
}

test('the real builder: everything is due without a stamp; data is kept when the game is not here', () => {
  assert.equal(stepsDue(null, null), 'all');
  assert.equal(stepsDue('C:\\game', { gameBuild: '1.0.0.1' }), 'all', 'a stamp from before steps had versions');
  assert.deepEqual(stepsDue('C:\\no\\such\\game', { gameBuild: '1.0.0.1', steps: stepVersions() }), []);
});

test('the real builder: a step is due when its own script or inputs changed, everything when the game did', async () => {
  const { dir, cleanup } = await testContext();
  try {
    const game = await fakeGame(dir);
    await writeFile(path.join(game, '.build.info'), 'Branch!STRING:0|Active!DEC:1|Version!STRING:0\neu|1|2.0.0.1\n');
    const steps = stepVersions();
    assert.deepEqual(stepsDue(game, { gameBuild: '2.0.0.1', steps }), []);
    assert.equal(stepsDue(game, { gameBuild: '1.9.9.9', steps }), 'all');
    assert.deepEqual(stepsDue(game, { gameBuild: '2.0.0.1', steps: { ...steps, Store: 'older', 'Card frames': undefined } }),
      ['Store', 'Card frames']);
    assert.equal(stepsDue(game, { gameBuild: '2.0.0.1', steps: { ...steps, 'Starting tables': 'older' } }), 'all',
      'the tables kept by hand feed every step');
  } finally {
    await cleanup();
  }
});

test('game data is read again in the background when the game is another version', async () => {
  const { ctx, cleanup } = await testContext();
  try {
    const builder = fakeBuilder('C:\game');
    const gameData = await createGameData(ctx, { builder });
    assert.equal(ctx.gameData.canBuild, true);
    await gameData.firstRead(); // there is data already (the test's own): nothing to do
    assert.equal(builder.builds, 0);
    const rev = ctx.rev;
    const reading = gameData.check();
    await gameData.check(); // a second one while the first runs does nothing
    await reading;
    assert.equal(builder.builds, 1);
    assert.equal(ctx.tables.gameData.gameBuild, '2.0.0.1');
    assert.equal(ctx.tables.rules.marker, '2.0.0.1', 'the tables in use are the new ones');
    assert.ok(ctx.tables.slugs.has('new-mini'));
    assert.deepEqual(ctx.gameData, { canBuild: true, reading: false, part: false, error: null });
    assert.ok(ctx.rev > rev, 'the page is told');
    assert.equal(builder.due, 'all');
    await gameData.check(); // the same version: nothing to do
    assert.equal(builder.builds, 1);
    // a new version of the tracker changed one step: only that is asked for, on the data there is
    builder.changed = ['Store'];
    await gameData.check();
    assert.equal(builder.builds, 2);
    assert.deepEqual(builder.due, ['Store']);
  } finally {
    await cleanup();
  }
});

test('a failed read in the background leaves the game data as it was, and is not tried again at once', async () => {
  const { ctx, cleanup } = await testContext();
  try {
    const builder = fakeBuilder('C:\game');
    builder.fail = 'The game is being updated.';
    const gameData = await createGameData(ctx, { builder });
    await gameData.check();
    assert.equal(ctx.tables.gameData.gameBuild, '1.0.0.1');
    assert.equal(ctx.gameData.error, 'The game is being updated.');
    assert.equal(ctx.errorLog.list()[0].source, 'game data');
    builder.fail = null;
    await gameData.check();
    assert.equal(builder.builds, 1);
  } finally {
    await cleanup();
  }
});
