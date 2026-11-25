// Reading the game data from the game install: the game's folder given by hand, the first start's loading page, the
// read in the background after a game patch or a tracker update, and the queue the heavy background jobs share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { givenGameFolder, setGameFolder, isGameFolder } from '../server/game/folder.mjs';
import { createGameData } from '../server/gamedata.mjs';
import { findGame } from '../tools/gamedata/build.mjs';
import { testContext, fakeGame } from './helpers.mjs';

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
    // a file that was cut off counts as empty, and the next folder given is kept
    await writeFile(file, '{"gameFolder": "D:');
    assert.equal(await givenGameFolder(ctx), '');
    assert.equal(await setGameFolder(ctx, game), game);
    assert.equal(await givenGameFolder(ctx), game);
  } finally {
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
      b.onBuild?.();
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

test('game data is read again in the background when the game is another version', async () => {
  const { ctx, cleanup } = await testContext();
  try {
    const builder = fakeBuilder('C:\\game');
    const gameData = await createGameData(ctx, { builder });
    assert.equal(ctx.gameData.canBuild, true);
    await gameData.firstRead(); // there is data already (the test's own): nothing to do
    assert.equal(builder.builds, 0);
    const rev = ctx.rev;
    const forTracker = []; // while each read runs: is it the tracker that changed, not the game?
    builder.onBuild = () => forTracker.push(ctx.gameData.reading && ctx.gameData.forTracker);
    const reading = gameData.check();
    await gameData.check(); // a second one while the first runs does nothing
    await reading;
    assert.equal(builder.builds, 1);
    assert.equal(ctx.tables.gameData.gameBuild, '2.0.0.1');
    assert.equal(ctx.tables.rules.marker, '2.0.0.1', 'the tables in use are the new ones');
    assert.ok(ctx.tables.slugs.has('new-mini'));
    assert.deepEqual(ctx.gameData, { canBuild: true, reading: false, forTracker: false, error: null });
    assert.ok(ctx.rev > rev, 'the page is told');
    assert.equal(builder.due, 'all');
    await gameData.check(); // the same version: nothing to do
    assert.equal(builder.builds, 1);
    // a new version of the tracker changed one step: only that is asked for, on the data there is
    builder.changed = ['Store'];
    await gameData.check();
    assert.equal(builder.builds, 2);
    assert.deepEqual(builder.due, ['Store']);
    // data from before steps had versions is read anew in full, and that is the tracker's doing too
    await writeFile(path.join(ctx.paths.GAMEDATA, 'gamedata.json'), JSON.stringify({ gameBuild: '2.0.0.1' }));
    await ctx.tables.load();
    builder.stepsDue = () => 'all';
    await gameData.check();
    assert.deepEqual(forTracker, [false, true, true], 'the banner blames the game only for the first read');
  } finally {
    await cleanup();
  }
});

test('a failed read in the background leaves the game data as it was, and is not tried again at once', async () => {
  const { ctx, cleanup } = await testContext();
  try {
    const builder = fakeBuilder('C:\\game');
    builder.fail = 'The game is being updated.';
    const gameData = await createGameData(ctx, { builder });
    await gameData.check();
    assert.equal(ctx.tables.gameData.gameBuild, '1.0.0.1');
    assert.equal(ctx.gameData.error, 'The game is being updated.');
    assert.equal(ctx.errorLog.list()[0].source, 'game data');
    builder.fail = null;
    await gameData.check();
    assert.equal(builder.builds, 1);
    // a change that may be what it wanted (the game's folder, in Settings) has it tried again at once
    await gameData.check({ retry: true });
    assert.equal(builder.builds, 2);
    assert.equal(ctx.tables.gameData.gameBuild, '2.0.0.1');
    assert.equal(ctx.gameData.error, null);
  } finally {
    await cleanup();
  }
});

test('heavy background jobs run one at a time, in the order they were asked for', async () => {
  const { ctx, cleanup } = await testContext();
  try {
    const log = [];
    const first = ctx.oneAtATime(async () => {
      log.push('first starts');
      await new Promise((r) => setTimeout(r, 30));
      log.push('first ends');
      throw new Error('it failed');
    });
    const second = ctx.oneAtATime(async () => log.push('second starts'));
    await assert.rejects(first, /it failed/);
    await second; // a job that failed does not hold up the next
    assert.deepEqual(log, ['first starts', 'first ends', 'second starts']);
  } finally {
    await cleanup();
  }
});

test('the first start shows a loading page, which asks for the game folder when the game is not found', async () => {
  const { ctx, dir, cleanup } = await testContext();
  try {
    await rm(ctx.paths.STATIC, { recursive: true }); // no game data yet
    ctx.port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
    const builder = fakeBuilder(null);
    builder.findGame = (given) => given || null;
    const read = builder.buildGameData;
    builder.buildGameData = async (o) => {
      if (!o.game) throw Object.assign(new builder.BuildError('Warcraft Rumble was not found on this PC.'), { needsFolder: true });
      return read(o);
    };
    const gameData = await createGameData(ctx, { builder });
    const reading = gameData.firstRead();
    const base = `http://localhost:${ctx.port}`;
    const page = async () => (await fetch(base)).text();
    const give = (folder, headers = {}) => fetch(`${base}/game-folder`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ dir: folder }) });
    let html = '';
    for (let i = 0; i < 100 && !html.includes('was not found'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      html = await page().catch(() => '');
    }
    assert.match(html, /Warcraft Rumble was not found on this PC/);
    assert.match(html, /action="\/game-folder"/, 'the page asks for the folder');
    // a folder that is not the game's is refused, with the reason on the page
    assert.equal((await give(dir)).status, 303);
    assert.match(await page(), /is not the game(&#39;|')s folder/);
    // another site's form is not taken
    const game = await fakeGame(dir);
    assert.equal((await give(game, { origin: 'http://evil.example' })).status, 403);
    assert.equal(await givenGameFolder(ctx), '');
    assert.equal((await give(game)).status, 303);
    await reading; // read from that folder at once, and the page is gone
    assert.equal(await givenGameFolder(ctx), game);
    assert.equal(await ctx.tables.hasGameData(), true);
    await assert.rejects(fetch(base));
  } finally {
    await cleanup();
  }
});

test('a check without the game fails as a read does, and a retry asked for during a check follows it', async () => {
  const { ctx, cleanup } = await testContext();
  try {
    // data from before steps had versions, and the game gone: everything is due, and there is no version to read
    const builder = fakeBuilder(null);
    builder.stepsDue = () => 'all';
    builder.gameVersion = () => { throw new TypeError('no folder to read the version from'); };
    builder.fail = 'Warcraft Rumble was not found on this PC.';
    const gameData = await createGameData(ctx, { builder });
    await gameData.check(); // (does not throw)
    assert.equal(ctx.gameData.error, 'Warcraft Rumble was not found on this PC.');
    assert.deepEqual(ctx.gameData.reading, false);

    // the game's version can't be read just now (a patch is rewriting it): nothing is built, and it is no error
    const patching = fakeBuilder('C:\\game');
    patching.stepsDue = () => { throw new Error('EBUSY: .build.info'); };
    const errors = ctx.errorLog.list().length;
    await (await createGameData(ctx, { builder: patching })).check();
    assert.equal(patching.builds, 0);
    assert.equal(ctx.errorLog.list().length, errors);

    // a retry asked for while a check runs: the running one looked before the change, so another follows
    const slow = fakeBuilder('C:\\game');
    let looked = 0;
    const due = slow.stepsDue;
    slow.stepsDue = (...a) => { looked++; return due(...a); };
    const read = slow.buildGameData;
    slow.buildGameData = async (o) => { await new Promise((r) => setTimeout(r, 30)); return read(o); };
    const second = await createGameData(ctx, { builder: slow });
    const running = second.check();
    await new Promise((r) => setTimeout(r, 5));
    second.check({ retry: true });
    await running;
    await new Promise((r) => setTimeout(r, 20));
    await second.check();
    assert.ok(looked >= 2, 'the game was looked at again after the running check');
    assert.equal(slow.builds, 1, 'and nothing more was due');
  } finally {
    await cleanup();
  }
});
