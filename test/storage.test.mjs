// The tracker's folder: what the launcher moves when it is first picked or changed (desktop/launcher.cjs), and what
// Settings checks before it notes a move (server/storage.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeIn, noteMove } from '../server/storage.mjs';

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'launcher.cjs');
// (the launcher is one program with no parts to import: its functions for the folder are read out of it)
const source = /\/\/ The tracker's folder\n[\s\S]*?\n\/\/ Starting up\n/.exec(fs.readFileSync(LAUNCHER, 'utf8'))[0];
const launcher = new Function('fs', 'path', 'FOLDER_NAME', `${source}
  return { homeIn, readNote, writeNote, movePairs, moveFiles, roomFor, tidyOld, homeProblem };`)(fs, path, 'RumbleTracker');

test('the launcher\'s own windows use up the hidden start before they are shown', () => {
  // (PowerShell is started hidden, and Windows hides the first window shown: a window nobody sees can't be answered)
  const popup = fs.readFileSync(path.join(path.dirname(LAUNCHER), 'popup.ps1'), 'utf8');
  assert.match(popup, /ShowWindow\(\$f\.Handle, 0\)\r?\n[^\n]*\$f\.ShowDialog\(\)/);
  // every window the launcher shows itself is that script's
  assert.doesNotMatch(fs.readFileSync(LAUNCHER, 'utf8'), /Windows\.Forms|ShowDialog/);
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-storage-'));
  const file = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const files = (rel = '', out = []) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.isDirectory()) files(`${rel}${e.name}/`, out);
      else out.push(rel + e.name);
    }
    return out.sort();
  };
  return { dir, file, files, at: (...rel) => path.join(dir, ...rel), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the tracker makes a folder of its own in the one picked', () => {
  assert.equal(homeIn('D:\\Games'), 'D:\\Games\\RumbleTracker');
  assert.equal(homeIn('D:\\Games\\rumbletracker'), 'D:\\Games\\rumbletracker', 'a folder already named so is used as it is');
  assert.equal(launcher.homeIn('D:\\Games\\'), homeIn('D:\\Games'), 'the launcher and the server agree');
});

test('the first start since there is a choice moves the data and the window\'s data into the one folder', () => {
  const s = scratch();
  try {
    for (const f of ['roaming/RumbleTracker/names.json', 'roaming/RumbleTracker/backups/b.json',
      'roaming/RumbleTracker/gamedata/minis.json', 'local/RumbleTracker/app/v1/main.mjs',
      'local/RumbleTracker/webview2/cache', 'local/RumbleTracker/webview2-rdmodule/cache']) s.file(f);
    const noteDir = s.at('roaming', 'RumbleTracker');
    const move = { legacy: true, from: s.at('local', 'RumbleTracker'), to: s.at('picked', 'RumbleTracker') };
    launcher.writeNote(path.join(noteDir, 'location.json'), { moving: move });
    launcher.moveFiles(launcher.movePairs(move, noteDir));
    launcher.tidyOld(move.from, move.to);
    assert.deepEqual(s.files(), ['picked/RumbleTracker/data/backups/b.json', 'picked/RumbleTracker/data/gamedata/minis.json',
      'picked/RumbleTracker/data/names.json', 'picked/RumbleTracker/webview2-rdmodule/cache',
      'picked/RumbleTracker/webview2/cache', 'roaming/RumbleTracker/location.json']);
    assert.ok(!fs.existsSync(move.from), 'the old folder is gone, with its unpacked program');
    assert.deepEqual(launcher.readNote(path.join(noteDir, 'location.json')).moving.to, move.to);
  } finally {
    s.cleanup();
  }
});

test('into the usual place, the data moves and what is already there stays', () => {
  const s = scratch();
  try {
    for (const f of ['roaming/RumbleTracker/names.json', 'local/RumbleTracker/app/v1/main.mjs',
      'local/RumbleTracker/webview2/cache']) s.file(f);
    const home = s.at('local', 'RumbleTracker');
    const move = { legacy: true, from: home, to: home };
    launcher.moveFiles(launcher.movePairs(move, s.at('roaming', 'RumbleTracker')));
    launcher.tidyOld(move.from, move.to);
    assert.deepEqual(s.files(), ['local/RumbleTracker/app/v1/main.mjs', 'local/RumbleTracker/data/names.json',
      'local/RumbleTracker/webview2/cache']);
  } finally {
    s.cleanup();
  }
});

test('a move from Settings takes everything but the unpacked program, and can be taken back', () => {
  const s = scratch();
  try {
    for (const f of ['old/RumbleTracker/data/names.json', 'old/RumbleTracker/data/state/a.json',
      'old/RumbleTracker/app/v1/main.mjs', 'old/RumbleTracker/webview2/cache', 'old/mine.txt']) s.file(f);
    const move = { from: s.at('old', 'RumbleTracker'), to: s.at('new', 'RumbleTracker') };
    const pairs = launcher.movePairs(move, s.at('roaming', 'RumbleTracker'));
    // a leftover of a move that was cut off is replaced
    s.file('new/RumbleTracker/data/names.json', 'half');
    launcher.moveFiles(pairs);
    assert.equal(fs.readFileSync(s.at('new', 'RumbleTracker', 'data', 'names.json'), 'utf8'), 'x');
    assert.deepEqual(s.files().filter((f) => f.startsWith('old/')), ['old/RumbleTracker/app/v1/main.mjs', 'old/mine.txt']);
    // a move that failed part of the way is taken back
    launcher.moveFiles(pairs, true);
    assert.deepEqual(s.files(), ['old/RumbleTracker/app/v1/main.mjs', 'old/RumbleTracker/data/names.json',
      'old/RumbleTracker/data/state/a.json', 'old/RumbleTracker/webview2/cache', 'old/mine.txt']);
    launcher.moveFiles(pairs);
    launcher.tidyOld(move.from, move.to);
    assert.deepEqual(s.files(), ['new/RumbleTracker/data/names.json', 'new/RumbleTracker/data/state/a.json',
      'new/RumbleTracker/webview2/cache', 'old/mine.txt'], 'the folder it was in keeps what else it holds');
    assert.deepEqual(launcher.roomFor(pairs), { needed: 0, free: null }, 'on the same disk no room is needed');
  } finally {
    s.cleanup();
  }
});

test('a folder the tracker can\'t use is refused, by the launcher and by Settings', async () => {
  const s = scratch();
  try {
    const noteDir = s.at('roaming', 'RumbleTracker');
    const storage = { folder: s.at('now', 'RumbleTracker'), note: path.join(noteDir, 'location.json') };
    s.file('now/RumbleTracker/data/names.json');
    s.file('roaming/RumbleTracker/location.json', '{}');
    s.file('taken/RumbleTracker/other.txt');
    assert.match(launcher.homeProblem('Games', noteDir), /whole path/);
    assert.match(launcher.homeProblem(noteDir, noteDir), /holds the note/);
    assert.equal(launcher.homeProblem(s.at('fine', 'RumbleTracker'), noteDir), null);
    await assert.rejects(noteMove(storage, 'Games'), /whole path/);
    await assert.rejects(noteMove(storage, s.at('now')), /already there/);
    await assert.rejects(noteMove(storage, s.at('now', 'RumbleTracker', 'data')), /outside the one/);
    await assert.rejects(noteMove(storage, s.at('roaming')), /holds the note/);
    await assert.rejects(noteMove(storage, s.at('taken')), /already has files/);
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.note, 'utf8')), {}, 'nothing is noted for a folder refused');
    // a folder that will do: the move is noted for the next start
    assert.equal(await noteMove(storage, s.at('games')), s.at('games', 'RumbleTracker'));
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.note, 'utf8')),
      { folder: storage.folder, moveTo: s.at('games', 'RumbleTracker') });
  } finally {
    s.cleanup();
  }
});
