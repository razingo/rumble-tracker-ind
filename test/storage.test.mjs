// The tracker's folder: what the launcher copies and removes when it is first picked or changed, and what it does
// with a folder that is in use (desktop/launcher.cjs); and what Settings checks before it notes a move
// (server/storage.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeIn, noteMove } from '../server/storage.mjs';
import { BACKUP_KEYS } from '../server/userdata.mjs';
import { restoreBackup, writeDailyBackup, listDailyBackups } from '../server/backup.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const LAUNCHER = path.join(DESKTOP, 'launcher.cjs');
// (the launcher is one program with no parts to import: its functions for the folder are read out of it)
const source = /\/\/ The tracker's folder\n[\s\S]*?\n\/\/ Starting up\n/.exec(fs.readFileSync(LAUNCHER, 'utf8'))[0];
const launcher = new Function('fs', 'path', 'FOLDER_NAME', `${source}
  return { homeIn, readNote, writeNote, movePairs, moveList, copyAll, roomFor, clearOld, tidyOld, homeProblem, takeOver,
    profileBackup, inUse, reachable, dropEmpty, stillToClear, madeFor, dropShells, dropCopies, PROFILE };`)(fs, path, 'RumbleTracker');

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
/** A move as the launcher makes it: everything copied, then the old files removed. Returns what was to be removed. */
function move(s, moving, noteDir) {
  const list = launcher.moveList(launcher.movePairs(moving, noteDir));
  const old = launcher.copyAll(list);
  assert.deepEqual(old.filter((p) => !fs.existsSync(p)), [], 'what was copied is still where it was');
  assert.deepEqual(launcher.clearOld(old), []);
  launcher.tidyOld(moving.from, moving.to);
  return old;
}

test('the tracker makes a folder of its own in the one picked', () => {
  assert.equal(homeIn('D:\\Games'), 'D:\\Games\\RumbleTracker');
  assert.equal(homeIn('D:\\Games\\rumbletracker'), 'D:\\Games\\rumbletracker', 'a folder already named so is used as it is');
  assert.equal(launcher.homeIn('D:\\Games\\'), homeIn('D:\\Games'), 'the launcher and the server agree');
});

test('the launcher\'s own pop-up uses up the hidden start, and says what was pressed', () => {
  // (PowerShell is started hidden, and Windows hides the first window shown: a window nobody sees can't be answered)
  const popup = fs.readFileSync(path.join(DESKTOP, 'popup.ps1'), 'utf8');
  assert.match(popup, /ShowWindow\(\$f\.Handle, 0\)\r?\n[^\n]*\r?\n[^\n]*\$f\.ShowDialog\(\)/);
  // the launcher takes anything but "ok" and "cancel" as the pop-up not having been shown, and shows Windows' own
  assert.match(popup, /\$said = 'cancel'/);
  assert.match(popup, /\[Console\]::Out\.Write\(\$said\)\s*$/);
  assert.match(fs.readFileSync(LAUNCHER, 'utf8'), /if \(\/\^\(ok\|cancel\)\\b\/\.test\(out\)\) return out;/);
});

test('the first start since there is a choice copies the data and the window\'s data into the one folder', () => {
  const s = scratch();
  try {
    for (const f of ['roaming/RumbleTracker/names.json', 'roaming/RumbleTracker/backups/b.json',
      'roaming/RumbleTracker/gamedata/minis.json', 'local/RumbleTracker/app/v1/main.mjs', 'local/RumbleTracker/window/old.txt',
      'local/RumbleTracker/webview2/cache', 'local/RumbleTracker/webview2-rdmodule/cache']) s.file(f);
    const noteDir = s.at('roaming', 'RumbleTracker');
    const moving = { legacy: true, from: s.at('local', 'RumbleTracker'), to: s.at('picked', 'RumbleTracker') };
    launcher.writeNote(path.join(noteDir, 'location.json'), { moving });
    move(s, moving, noteDir);
    assert.deepEqual(s.files(), ['picked/RumbleTracker/data/backups/b.json', 'picked/RumbleTracker/data/gamedata/minis.json',
      'picked/RumbleTracker/data/names.json', 'picked/RumbleTracker/webview2-rdmodule/cache',
      'picked/RumbleTracker/webview2/cache', 'roaming/RumbleTracker/location.json']);
    assert.ok(!fs.existsSync(moving.from), 'the old folder is gone, with its unpacked program and what an earlier version left');
  } finally {
    s.cleanup();
  }
});

test('into the usual place, the data is copied and what is already there stays', () => {
  const s = scratch();
  try {
    for (const f of ['roaming/RumbleTracker/names.json', 'local/RumbleTracker/app/v1/main.mjs',
      'local/RumbleTracker/webview2/cache']) s.file(f);
    const home = s.at('local', 'RumbleTracker');
    move(s, { legacy: true, from: home, to: home }, s.at('roaming', 'RumbleTracker'));
    assert.deepEqual(s.files(), ['local/RumbleTracker/app/v1/main.mjs', 'local/RumbleTracker/data/names.json',
      'local/RumbleTracker/webview2/cache']);
  } finally {
    s.cleanup();
  }
});

test('a move that can\'t be finished leaves the files where they were, whole, and nothing half copied', () => {
  const s = scratch();
  try {
    for (const f of ['old/RumbleTracker/data/names.json', 'old/RumbleTracker/data/state/a.json',
      'old/RumbleTracker/app/v1/main.mjs', 'old/RumbleTracker/webview2/cache', 'old/mine.txt']) s.file(f);
    const moving = { from: s.at('old', 'RumbleTracker'), to: s.at('new', 'RumbleTracker') };
    const before = s.files();
    const list = launcher.moveList(launcher.movePairs(moving, s.at('roaming', 'RumbleTracker')));
    assert.deepEqual(list.map((e) => [path.basename(e.from), e.spare]), [['names.json', false], ['state', false], ['webview2', true]]);
    assert.equal(launcher.roomFor(list).needed, 3, 'the room is needed on the same disk too');
    // one that is not there to copy: the copies made before it go again
    assert.throws(() => launcher.copyAll([list[0], { from: s.at('old', 'nothing'), to: s.at('new', 'RumbleTracker', 'data', 'nothing') }]));
    assert.deepEqual(s.files(), before);
    // the window's data may be left behind (its files can be in use): the rest is copied all the same
    const old = launcher.copyAll([...list.slice(0, 2), { from: s.at('old', 'nothing'), to: s.at('new', 'w'), spare: true }]);
    assert.equal(old.length, 3);
    assert.deepEqual(s.files().filter((f) => f.startsWith('new/')), ['new/RumbleTracker/data/names.json',
      'new/RumbleTracker/data/state/a.json']);
    // a leftover of a move that was cut off while copying is written over; then the old files go
    s.file('new/RumbleTracker/data/names.json', 'half');
    move(s, moving, s.at('roaming', 'RumbleTracker'));
    assert.equal(fs.readFileSync(s.at('new', 'RumbleTracker', 'data', 'names.json'), 'utf8'), 'x');
    assert.deepEqual(s.files(), ['new/RumbleTracker/data/names.json', 'new/RumbleTracker/data/state/a.json',
      'new/RumbleTracker/webview2/cache', 'old/mine.txt'], 'the folder it was in keeps what else it holds');
    // what could not be removed yet is told, for a later start
    assert.deepEqual(launcher.clearOld([s.at('gone')]), []);
  } finally {
    s.cleanup();
  }
});

test('a folder in use: a new tracker takes over the data found, one with data of its own sets it aside', async () => {
  const s = scratch();
  const found = () => {
    for (const f of ['there/RumbleTracker/app/v0/main.mjs', 'there/RumbleTracker/webview2/cache',
      'there/RumbleTracker/data/gamedata/minis.json', 'there/RumbleTracker/data/state/a.json',
      'there/RumbleTracker/data/backups/rumble-tracker-backup-2026-01-01.json', 'there/RumbleTracker/data/rdmodule/ready.json']) s.file(f);
    s.file('there/RumbleTracker/data/names.json', '{"accounts":{"1":"Found"}}');
    s.file('there/RumbleTracker/data/settings.json', '{"closeWindow":"tray"}');
  };
  try {
    assert.deepEqual(launcher.PROFILE.slice().sort(), Object.keys(BACKUP_KEYS).sort(),
      'what the launcher sets aside is what a backup holds');
    const home = s.at('there', 'RumbleTracker');
    assert.equal(launcher.inUse(home), false);
    // a new tracker: what the tracker makes again by itself goes, the data and the backups stay
    found();
    assert.equal(launcher.inUse(home), true);
    assert.equal(launcher.takeOver(home, false), null);
    assert.deepEqual(s.files(), ['there/RumbleTracker/data/backups/rumble-tracker-backup-2026-01-01.json',
      'there/RumbleTracker/data/names.json', 'there/RumbleTracker/data/rdmodule/ready.json', 'there/RumbleTracker/data/settings.json']);
    // a tracker with data of its own: the data found becomes one more backup, which Import backup reads
    found();
    s.file('there/RumbleTracker/data/backups/rumble-tracker-backup-2026-11-23.json', 'found');
    const kept = launcher.takeOver(home, true, { now: new Date(Date.UTC(2026, 10, 24, 12)) });
    assert.equal(path.relative(home, kept), path.join('data', 'backups', 'pre_existing', 'found-2026-11-24T12-00-00-000Z.json'));
    const files = { names: {}, settings: {}, plans: { kept: 1 } };
    assert.deepEqual(restoreBackup(files, JSON.parse(fs.readFileSync(kept, 'utf8'))), ['names', 'settings']);
    assert.deepEqual(files, { names: { accounts: { 1: 'Found' } }, settings: { closeWindow: 'tray' }, plans: { kept: 1 } });
    // only the backups found stay, in a folder of their own
    assert.deepEqual(s.files(), ['there/RumbleTracker/data/backups/pre_existing/found-2026-11-24T12-00-00-000Z.json',
      'there/RumbleTracker/data/backups/pre_existing/rumble-tracker-backup-2026-01-01.json',
      'there/RumbleTracker/data/backups/pre_existing/rumble-tracker-backup-2026-11-23.json']);
    // its own files come in; a backup of its own of a day that one found there has too stays its own
    s.file('own/RumbleTracker/data/names.json', '{"accounts":{"1":"Own"}}');
    s.file('own/RumbleTracker/data/backups/rumble-tracker-backup-2026-11-23.json', 'own');
    move(s, { from: s.at('own', 'RumbleTracker'), to: home }, s.at('roaming', 'RumbleTracker'));
    assert.deepEqual(s.files().filter((f) => f.includes('/backups/')), [
      'there/RumbleTracker/data/backups/pre_existing/found-2026-11-24T12-00-00-000Z.json',
      'there/RumbleTracker/data/backups/pre_existing/rumble-tracker-backup-2026-01-01.json',
      'there/RumbleTracker/data/backups/pre_existing/rumble-tracker-backup-2026-11-23.json',
      'there/RumbleTracker/data/backups/rumble-tracker-backup-2026-11-23.json']);
    const backups = path.join(home, 'data', 'backups');
    assert.equal(fs.readFileSync(path.join(backups, 'rumble-tracker-backup-2026-11-23.json'), 'utf8'), 'own');
    assert.equal(fs.readFileSync(path.join(backups, 'pre_existing', 'rumble-tracker-backup-2026-11-23.json'), 'utf8'), 'found');
    assert.match(fs.readFileSync(path.join(home, 'data', 'names.json'), 'utf8'), /Own/);
    // a second take-over keeps what the first set aside, under the same name too
    s.file('there/RumbleTracker/data/backups/rumble-tracker-backup-2026-11-23.json', 'own');
    launcher.takeOver(home, true, { now: new Date(Date.UTC(2026, 10, 26, 12)) });
    assert.equal(fs.readFileSync(path.join(backups, 'pre_existing', 'rumble-tracker-backup-2026-11-23.json'), 'utf8'), 'found');
    assert.equal(fs.readFileSync(path.join(backups, 'pre_existing',
      '2026-11-26T12-00-00-000Z-rumble-tracker-backup-2026-11-23.json'), 'utf8'), 'own');
    // the daily backups' clean-up leaves the ones set aside, and they are not listed as daily ones
    s.file('there/RumbleTracker/data/backups/rumble-tracker-backup-2026-11-23.json', 'own');
    await writeDailyBackup(backups, { names: {} }, { now: new Date(2026, 10, 25, 12) });
    assert.ok(fs.existsSync(kept) && fs.existsSync(path.join(backups, 'pre_existing', 'rumble-tracker-backup-2026-01-01.json')));
    assert.deepEqual((await listDailyBackups(backups)).map((b) => b.day), ['2026-11-25', '2026-11-23']);
    // a folder with nothing of a tracker's in it (the exe's own, say) is left as it is
    s.file('plain/RumbleTracker/RumbleTracker.exe');
    launcher.takeOver(s.at('plain', 'RumbleTracker'), false);
    assert.ok(fs.existsSync(s.at('plain', 'RumbleTracker', 'RumbleTracker.exe')));
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
    // a folder refused leaves nothing behind: not the tracker's own folder, and no new folder above it
    assert.match(launcher.homeProblem(s.at('roaming', 'RumbleTracker', 'location.json', 'a', 'RumbleTracker'), s.at('no')), /can't write/);
    s.file('made/mine.txt');
    fs.mkdirSync(s.at('made', 'a', 'RumbleTracker'), { recursive: true });
    launcher.dropEmpty([s.at('made', 'a', 'RumbleTracker'), s.at('made', 'a'), s.at('made')]);
    assert.deepEqual(fs.readdirSync(s.at('made')), ['mine.txt'], 'a folder with something in it stays');
    // the tracker's folder is where the note says only while its data folder is: one that is gone is not made again
    assert.equal(launcher.reachable(storage.folder), true);
    assert.equal(launcher.reachable(s.at('gone', 'RumbleTracker')), false);
    assert.ok(!fs.existsSync(s.at('gone')), 'asking does not make it');
    await assert.rejects(noteMove(storage, 'Games'), /whole path/);
    await assert.rejects(noteMove(storage, s.at('now')), /already there/);
    await assert.rejects(noteMove(storage, s.at('now', 'RumbleTracker', 'data')), /outside the one/);
    await assert.rejects(noteMove(storage, s.at('roaming')), /holds the note/);
    await assert.rejects(noteMove(storage, s.at('taken')), /already has files/);
    // a folder that can't be written to: the note's own file stands where the tracker's folder would go
    await assert.rejects(noteMove(storage, s.at('roaming', 'RumbleTracker', 'location.json', 'x')), /holds the note|can't write/);
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.note, 'utf8')), {}, 'nothing is noted for a folder refused');
    // no room there (the note can't be written, here): the folders made for the try go again, the new one above too
    await assert.rejects(noteMove({ ...storage, note: s.at('no', 'such', 'location.json') }, s.at('deep', 'er')));
    assert.ok(!fs.existsSync(s.at('deep')));
    // a folder that will do: the move is noted for the next start, with what an earlier move left to remove
    const clear = [s.at('before', 'RumbleTracker', 'data', 'in-use.json')];
    fs.writeFileSync(storage.note, JSON.stringify({ folder: storage.folder, clear }));
    assert.equal(await noteMove(storage, s.at('games')), s.at('games', 'RumbleTracker'));
    const made = [s.at('games', 'RumbleTracker'), s.at('games')];
    assert.deepEqual(JSON.parse(fs.readFileSync(storage.note, 'utf8')),
      { folder: storage.folder, moveTo: s.at('games', 'RumbleTracker'), made, clear });
    // a move that then can't be done takes the folders made for it away again, and no folder of the user's
    const moving = { from: storage.folder, to: s.at('games', 'RumbleTracker'), made: [...made, s.at('now'), 'C:\\'] };
    assert.deepEqual(launcher.madeFor(moving), [s.at('games', 'RumbleTracker', 'data'), ...made]);
    launcher.dropEmpty(launcher.madeFor(moving));
    assert.ok(!fs.existsSync(s.at('games')) && fs.existsSync(storage.folder));
  } finally {
    s.cleanup();
  }
});

test('what a move left behind: nothing of the new copy is removed, and the folders it was in go once empty', () => {
  const s = scratch();
  try {
    // old files still to remove where the tracker now moves back to: they are the new copy from then on
    const clear = [s.at('a', 'RumbleTracker', 'data', 'names.json'), s.at('a', 'RumbleTracker'), s.at('b', 'RumbleTracker', 'webview2')];
    assert.deepEqual(launcher.stillToClear(clear, s.at('a', 'RumbleTracker')), [clear[2]]);
    assert.deepEqual(launcher.stillToClear(undefined, s.at('a')), []);
    // files that were in use go at a later start: so do their data folder and the tracker's old folder, once empty
    for (const f of ['old/RumbleTracker/data/tracker.log', 'old/mine.txt', 'kept/RumbleTracker/data/names.json',
      'other/RumbleTracker/data/in-use.json', 'other/RumbleTracker/data/gone.json']) s.file(f);
    const gone = [s.at('old', 'RumbleTracker', 'data', 'tracker.log'), s.at('other', 'RumbleTracker', 'data', 'gone.json'),
      s.at('kept', 'RumbleTracker', 'window')];
    assert.deepEqual(launcher.clearOld(gone), []);
    launcher.dropShells(gone, s.at('kept', 'RumbleTracker'));
    assert.deepEqual(s.files(), ['kept/RumbleTracker/data/names.json', 'old/mine.txt', 'other/RumbleTracker/data/in-use.json']);
    assert.ok(!fs.existsSync(s.at('old', 'RumbleTracker')) && fs.existsSync(s.at('old')), 'the folder it was made in stays');
    // backups added to a folder that was there go again when the move can't be finished; what was there stays
    s.file('own/RumbleTracker/data/backups/rumble-tracker-backup-2026-11-23.json');
    s.file('there/RumbleTracker/data/backups/pre_existing/rumble-tracker-backup-2026-11-23.json', 'found');
    const [own, there] = [s.at('own', 'RumbleTracker'), s.at('there', 'RumbleTracker')];
    const list = launcher.moveList(launcher.movePairs({ from: own, to: there }, s.at('r')));
    assert.throws(() => launcher.copyAll([...list, { from: path.join(own, 'nothing'), to: path.join(there, 'data', 'nothing') }]));
    assert.deepEqual(s.files().filter((f) => f.startsWith('there/')),
      ['there/RumbleTracker/data/backups/pre_existing/rumble-tracker-backup-2026-11-23.json']);
  } finally {
    s.cleanup();
  }
});

test('a move that is not done leaves no copies: those of a cut-off try go, the backups found there stay', () => {
  const s = scratch();
  try {
    for (const f of ['old/RumbleTracker/data/names.json', 'old/RumbleTracker/data/backups/mine.json',
      'old/RumbleTracker/webview2/cache', 'new/RumbleTracker/data/names.json', 'new/RumbleTracker/data/backups/mine.json',
      'new/RumbleTracker/data/backups/pre_existing/theirs.json']) s.file(f);
    const moving = { from: s.at('old', 'RumbleTracker'), to: s.at('new', 'RumbleTracker') };
    launcher.dropCopies(launcher.moveList(launcher.movePairs(moving, s.at('roaming'))));
    assert.deepEqual(s.files('new/'), ['new/RumbleTracker/data/backups/pre_existing/theirs.json']);
    assert.equal(s.files('old/').length, 3, 'where the files come from, all stay');
  } finally {
    s.cleanup();
  }
});
