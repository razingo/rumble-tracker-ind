// The steps of the game-data build (tools/gamedata/build.mjs): how they are run, when a program among them is stopped,
// and which of them are due.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runSteps, runProgram, versionsOf, withTools, stepsDue, stepVersions, checkTables } from '../tools/gamedata/build.mjs';
import { testContext, fakeGame } from './helpers.mjs';

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

test('a program that is not done in time is stopped, and its step fails', async () => {
  await assert.rejects(runProgram(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], process.env, { minutes: 0.005 }),
    /was not done after 0.005 minutes and was stopped/);
  assert.deepEqual(await runProgram(process.execPath, ['-e', 'console.log(1)'], process.env), ['1']);
});

test("a step's version follows its files and its settings", async () => {
  const { dir, cleanup } = await testContext();
  try {
    await writeFile(path.join(dir, 'a.py'), 'one');
    const sources = { Icons: ['a.py'], Tables: ['a.py'] };
    const before = versionsOf(sources, dir, { Icons: ['icons', '64'] });
    assert.deepEqual(versionsOf(sources, dir, { Icons: ['icons', '64'] }), before);
    const resized = versionsOf(sources, dir, { Icons: ['icons', '96'] });
    assert.notEqual(resized.Icons, before.Icons, 'another size: the step is due');
    assert.equal(resized.Tables, before.Tables, 'and only that step');
    await writeFile(path.join(dir, 'a.py'), 'two');
    assert.notEqual(versionsOf(sources, dir, { Icons: ['icons', '64'] }).Tables, before.Tables);
  } finally {
    await cleanup();
  }
});

test('the tools a step uses count in its version, and only in that step', async () => {
  const { dir, cleanup } = await testContext();
  try {
    await writeFile(path.join(dir, 'a.py'), 'one');
    const sources = { Icons: ['a.py'], Sounds: ['a.py'], Tables: ['a.py'] };
    const versions = (python, decoder) => versionsOf(sources, dir,
      withTools(withTools({ Icons: ['64'] }, ['Icons', 'Sounds'], python), ['Sounds'], decoder));
    const before = versions({ python: '3.14.10', packages: { pillow: '13.0.0' } }, 'r2168');
    const newPillow = versions({ python: '3.14.10', packages: { pillow: '13.1.0' } }, 'r2168');
    assert.notEqual(newPillow.Icons, before.Icons);
    assert.equal(newPillow.Tables, before.Tables, 'a step Python does not run stays as it was');
    const newDecoder = versions({ python: '3.14.10', packages: { pillow: '13.0.0' } }, 'r2200');
    assert.notEqual(newDecoder.Sounds, before.Sounds);
    assert.equal(newDecoder.Icons, before.Icons);
    // without the private Python (a Python found on the PC), the settings stand alone
    assert.deepEqual(withTools({ Icons: ['64'] }, ['Icons'], null), { Icons: ['64'] });
  } finally {
    await cleanup();
  }
});

test('tables a broken read left are refused, a normal patch\'s are not', async () => {
  const { dir, cleanup } = await testContext();
  try {
    const mini = (slug) => ({ slug, name: slug, art: `art/${slug}.webp` });
    const write = async (tables) => {
      const all = { 'unit_ids.json': { units: { a1: 'footman', b2: 'ghoul' } }, 'minis.json': { minis: [mini('footman'), mini('ghoul')] },
        'events.json': { events: [{ id: 'e' }] }, 'store.json': { offers: { daily: {} } }, 'pvp.json': { ranks: [{}] }, ...tables };
      for (const [file, value] of Object.entries(all)) await writeFile(path.join(dir, file), JSON.stringify(value));
    };
    await write({});
    checkTables(dir);
    await write({ 'minis.json': { minis: [mini('footman'), mini('ghoul'), mini('new-mini')] } }); // a patch added one
    checkTables(dir);
    await write({ 'minis.json': { minis: [mini('footman')] } });
    assert.throws(() => checkTables(dir), /1 minis, where 2 are known/);
    // the tracker may know a mini before the installed game has it: one of ten missing is no broken read
    const ten = Array.from({ length: 10 }, (_, i) => `mini-${i}`);
    await write({ 'unit_ids.json': { units: Object.fromEntries(ten.map((s, i) => [`id${i}`, s])) },
      'minis.json': { minis: ten.slice(0, 9).map(mini) } });
    checkTables(dir);
    await write({ 'unit_ids.json': { units: { a1: 'footman', b2: 'ghoul' } } });
    await write({ 'minis.json': { minis: [mini('footman'), { slug: 'ghoul', name: 'Ghoul' }] } });
    assert.throws(() => checkTables(dir), /1 minis without a name or portrait \(ghoul\)/);
    await write({ 'events.json': { events: [] }, 'pvp.json': {} });
    assert.throws(() => checkTables(dir), /no events; no PvP ranks/);
    await writeFile(path.join(dir, 'store.json'), '{nope');
    assert.throws(() => checkTables(dir), /not usable/);
  } finally {
    await cleanup();
  }
});
