// Entry point of RumbleTracker.exe (Node.js single executable application), built by tools/build-release.mjs.
//
// Everything the tracker keeps is in one folder named RumbleTracker: in %LOCALAPPDATA% unless the user picked
// another place, on the first start or in Settings. In it: data (the user's data and what is read from the game), app
// (the program's files) and the window's WebView2 data. A note in %APPDATA%\RumbleTracker says where the folder is.
// The app's files are embedded as one asset and unpacked per version to the folder's app; a CommonJS helper imports
// the server from there (a single executable cannot import ES modules from disk).
//
// The exe has no console. The page opens in a window of its own: desktop/window.ps1 shows it with WebView2 (Windows'
// embeddable Chromium) and holds the tray icon too. Without WebView2 it only shows how to install it, and closing that
// stops the tracker. Output goes to tracker.log; start-up errors are shown in a message box.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { setTimeout: sleep } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');

const TITLE = 'Rumble Collection Tracker';
// First free port from 8765 to 8784; PORT forces one port, RUMBLE_FIRST_PORT moves the range (for testing).
const FIRST_PORT = Number(process.env.RUMBLE_FIRST_PORT || 8765);
const PORTS = process.env.PORT ? [Number(process.env.PORT)] : Array.from({ length: 20 }, (_, i) => FIRST_PORT + i);
let PORT = PORTS[0];
let PAGE = `http://localhost:${PORT}/`;
const usePort = (p) => {
  PORT = p;
  PAGE = `http://localhost:${p}/`;
};
const args = new Set(process.argv.slice(2));
// --background (used by Start with Windows) starts with only the tray icon
const NO_WINDOW = args.has('--background');
// --after-update=<pid>:<port>: started by an app update; waits for the old instance (pid) to stop
const afterUpdate = (() => {
  const m = /^--after-update=(\d+):(\d+)$/.exec(process.argv.slice(2).find((a) => a.startsWith('--after-update=')) || '');
  return m ? { pid: Number(m[1]), port: Number(m[2]) } : null;
})();
// --restart=<pid>: started by the tracker itself, to move its files (Settings); waits for that instance (pid) to stop
const restartOf = Number(/^--restart=(\d+)$/.exec(process.argv.slice(2).find((a) => a.startsWith('--restart=')) || '')?.[1]) || null;
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const FOLDER_NAME = 'RumbleTracker';
const DEFAULT_HOME = path.join(LOCAL, FOLDER_NAME);
// The note of where the tracker's folder is, and the folder that held the data before there was a choice.
const NOTE_DIR = path.join(ROAMING, FOLDER_NAME);
const NOTE = path.join(NOTE_DIR, 'location.json');
// RUMBLE_DATA_DIR (for testing) names the data folder itself: nothing is asked, moved or noted.
const FIXED_DATA = process.env.RUMBLE_DATA_DIR ? path.resolve(process.env.RUMBLE_DATA_DIR) : null;
let HOME = DEFAULT_HOME; // the tracker's folder: unpacked app, the window's WebView2 data and, in data, the rest
let DATA = null; // set once the folder is known (useHome)
let LOG = null;
let APP_DIR = null; // this version's unpacked files (set by main)
let host = null; // server/host.mjs, loaded by main before the server starts

process.title = TITLE;

// Logging
// A start's lines wait in `early` until this start has its own log (rotateLog), so they are in the log of the start
// they belong to, and nothing is written into the data folder while it may be moved. A start that ends before that
// (it hands over to a running tracker, or can't go on) adds them to the log that is there: the one of the folder it
// knows, or the one of the data folder from before there was a choice (`oldLog`, set when files are found there).
let early = [];
let logOpen = false;
let oldLog = null;
function useHome(home, data = path.join(home, 'data')) {
  HOME = home;
  DATA = data;
  fs.mkdirSync(DATA, { recursive: true });
  LOG = path.join(DATA, 'tracker.log');
}
// A tracker that has its folder knows its log from the start; one that still asks for it, once it has it.
if (!FIXED_DATA) {
  try {
    // (a whole path only, as soundNote asks of the note further down)
    const known = JSON.parse(fs.readFileSync(NOTE, 'utf8')).folder;
    if (typeof known === 'string' && path.isAbsolute(known) && fs.existsSync(path.join(known, 'data'))) useHome(known);
  } catch {
    // no note yet, or its folder is not there
  }
}
process.on('exit', () => {
  try {
    if ((LOG || oldLog) && early.length) fs.appendFileSync(LOG || oldLog, early.join(''));
  } catch {
    // nowhere to write
  }
});
// Called only by the instance that runs (not when handing over to a running one).
const rotateLog = () => {
  try {
    fs.renameSync(LOG, path.join(DATA, 'tracker.previous.log'));
  } catch {
    // first start
  }
  logBytes = 0;
  logOpen = true;
};
// The tracker can run for weeks in the tray, so the log is rotated once it passes MAX_LOG. At most two files of about
// MAX_LOG each are kept.
const MAX_LOG = 2 * 1024 * 1024;
const MAX_LINE = 4000;
// The log may be attached to a bug report, so its lines carry no Windows user name: the home folder is written as ~,
// and the name as <user> where it is a folder of another path. Only whole folder names count, so a word that happens
// to be the name, or a folder that only starts with it, stays as it is.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_FOLDER = os.homedir();
const USER_NAME = (() => { try { return os.userInfo().username; } catch { return ''; } })();
function withoutUserName(line, home = HOME_FOLDER, user = USER_NAME) {
  let s = line;
  const end = '(?=[\\\\/]|$|["\'\\s:;,)])'; // where a folder's name ends
  for (const h of home ? [home, home.replace(/\\/g, '/')] : []) s = s.replace(new RegExp(escapeRe(h) + end, 'gi'), '~');
  if (user) s = s.replace(new RegExp(`(?<=[\\\\/])${escapeRe(user)}${end}`, 'gi'), '<user>');
  return s;
}
let logBytes = null; // bytes in the current log; read from disk on the first write
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...a) => {
    let line = withoutUserName(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' '));
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}… (${line.length - MAX_LINE} more characters)`;
    let text = `${new Date().toISOString()} ${line}\n`;
    if (!LOG || !logOpen) return void early.push(text);
    text = early.join('') + text;
    early = [];
    try {
      if (logBytes === null) {
        try {
          logBytes = fs.statSync(LOG).size;
        } catch {
          logBytes = 0;
        }
      }
      const size = Buffer.byteLength(text);
      if (logBytes + size > MAX_LOG) rotateLog();
      fs.appendFileSync(LOG, text);
      logBytes += size;
    } catch {
      // nowhere to write
    }
  };
}

// PowerShell helpers
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64')];
// A longer script than a command line holds (32767 characters): a short command reads the file in RT_SCRIPT and runs
// it, which an execution policy set by an administrator doesn't block (as it would -File).
const PS_RUN_FILE = '. ([ScriptBlock]::Create([IO.File]::ReadAllText($env:RT_SCRIPT)))';

/**
 * Shows a start-up error in a pop-up, then exits. With `rollback`, the new version failed to start right after an
 * app update, so the previous exe is put back and started instead. This one then ends at once, without a pop-up: the
 * previous version says what happened once it runs (--restored, see showRestored), with the reason left in RESTORED.
 */
function fatal(message, { rollback = false } = {}) {
  console.log(`Stopped: ${message}`);
  if (rollback && afterUpdate && fs.existsSync(OLD_EXE)) {
    try {
      fs.mkdirSync(LAUNCHER_TEMP, { recursive: true });
      fs.writeFileSync(RESTORED, message);
    } catch {
      // the previous version then says it without the reason
    }
    try {
      fs.rmSync(FAILED_EXE, { force: true });
      fs.renameSync(process.execPath, FAILED_EXE); // a running exe can be renamed
      fs.renameSync(OLD_EXE, process.execPath);
      spawn(process.execPath, [`--after-update=${process.pid}:${afterUpdate.port}`, '--restored'],
        { detached: true, stdio: 'ignore' }).unref();
      console.log('App update: the new version failed to start; the previous version was restored');
      return process.exit(1);
    } catch (e) {
      console.log(`App update: could not restore the previous version: ${e.message}`);
      fs.rmSync(RESTORED, { force: true });
    }
  }
  popup('message', 'The tracker stopped', message).then(() => process.exit(1));
}

/** In the previous version, started again after a new one could not start: says so, with the new one's reason. */
function showRestored() {
  let why = '';
  try {
    why = fs.readFileSync(RESTORED, 'utf8').trim();
    fs.rmSync(RESTORED, { force: true });
  } catch {
    // no reason was left
  }
  popup('message', 'The tracker was not updated',
    `The new version could not start, so the previous version was restored and started again.${why ? `\n\n${why}` : ''}`);
}

/** Opens an address with the program Windows has for it (here, Windows' snipping overlay). */
function shellOpen(url) {
  execFile(path.join(SYSTEM32, 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
}

// The window and the tray icon (desktop/window.ps1)

let windowHost = null; // the window program while it runs
let windowRestarts = 0;
const MAX_WINDOW_RESTARTS = 3;

/** Opens the window or brings it to the front. */
function showWindow() {
  if (windowHost) windowHost.stdin.write('show\n');
  else console.log('Window: asked to open, but the window program isn\'t running');
}

/** Starts the window program; `show` opens the window right away. */
function startWindowHost(onQuit, show = !NO_WINDOW) {
  const child = spawn(POWERSHELL, psArgs(PS_RUN_FILE), {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RT_SCRIPT: path.join(APP_DIR, 'desktop', 'window.ps1'), RT_TITLE: TITLE, RT_AUMID: AUMID,
      RT_PAGE: PAGE, RT_DATA: DATA, RT_EXE: process.execPath,
      RT_PARENT: String(process.pid), RT_GAME: 'WarcraftRumble', RT_LIB: path.join(APP_DIR, 'desktop', 'webview2'),
      RT_PROFILE: path.join(HOME, 'webview2'), RT_FONT: path.join(APP_DIR, 'desktop', 'LilitaOne-Regular.ttf'),
      RT_CACHE: path.join(APP_DIR, 'desktop', 'window-helpers.dll'),
      RT_SHOW: show ? '1' : '' },
  });
  windowHost = child;
  let buf = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'closed') host.windowClosed();
      else if (line === 'quit') onQuit('Quit from the tray');
      else if (line === 'shutdown') onQuit('Windows is signing out or shutting down');
      // Whether the game runs, for the server (server/game/watch.mjs).
      else if (line === 'game 1' || line === 'game 0') host.reportGame(line === 'game 1');
      // Without WebView2 the window program shows how to install it, and closing that stops the tracker.
      else if (line === 'no-webview-closed') onQuit('Closed the pop-up about installing WebView2');
      else if (line.startsWith('no-webview')) console.log(`Window: WebView2 can't run (${line.slice('no-webview'.length).trim()})`);
    }
  });
  child.stdin.on('error', () => {}); // the window program has ended
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
  // Without the window program there's no window or tray icon, so the tracker says so and stops.
  child.on('error', (e) => {
    windowHost = null;
    fatal(`The tracker's window and tray icon could not start: ${e.message}`);
  });
  child.on('exit', (code) => {
    windowHost = null;
    // PowerShell starts redirected error output with an empty "#< CLIXML" header
    const msg = err.replace(/^#< CLIXML\s*/, '').trim();
    if (code || msg) console.log(`The window and tray icon stopped (${code}): ${msg.slice(0, 1000)}`);
    if (quitting) return;
    // started again (without opening the window), so the tracker isn't left running without its tray icon
    if (windowRestarts++ < MAX_WINDOW_RESTARTS) startWindowHost(onQuit, false);
    else host.gameWatchFailed();
  });
}

// The tracker's folder
// (the functions from here to "Starting up" use only fs and path, and the tests read them out of this file)

/** The folder the tracker makes for itself in the one the user picked; a folder already named so is used as it is. */
function homeIn(picked) {
  const p = path.resolve(picked);
  return path.basename(p).toLowerCase() === FOLDER_NAME.toLowerCase() ? p : path.join(p, FOLDER_NAME);
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (inner, outer) => (path.resolve(inner).toLowerCase() + path.sep).startsWith(path.resolve(outer).toLowerCase() + path.sep);

function readNote(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeNote(file, note) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(note, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** { files, bytes } under a folder, or of a file. */
function measure(p, sum = { files: 0, bytes: 0 }) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) {
    sum.files++;
    sum.bytes += st.size;
    return sum;
  }
  for (const name of fs.readdirSync(p)) measure(path.join(p, name), sum);
  return sum;
}

const remove = (p) => fs.rmSync(p, { recursive: true, force: true });
/** Whether a folder is there with something in it. */
function inUse(folder) {
  try {
    return fs.readdirSync(folder).length > 0;
  } catch {
    return false;
  }
}
/**
 * Whether the tracker's folder is where the note says: its data folder is there. It is not made here, so a folder
 * that is gone (its disk is not connected, or it was moved, renamed or deleted) is asked about, not started empty.
 */
const reachable = (home) => fs.existsSync(path.join(home, 'data'));

/** The folders that making `folder` would make: it and those above it that are not there, the deepest first. */
function notThere(folder) {
  const list = [];
  for (let d = path.resolve(folder); !fs.existsSync(d); d = path.dirname(d)) {
    list.push(d);
    if (path.dirname(d) === d) break;
  }
  return list;
}
/** Removes the folders of the list that are empty (the ones made for a try that did not work out). */
function dropEmpty(folders) {
  for (const d of folders) {
    try {
      fs.rmdirSync(d);
    } catch {
      // not there, or not empty
    }
  }
}

// What a backup holds (BACKUP_KEYS in server/userdata.mjs), each in a file of that name in the data folder.
const PROFILE = ['names', 'talents', 'army', 'armies', 'drafts', 'grid_history', 'pvp_history', 'notifications', 'plans',
  'progress', 'settings'];
// What the tracker makes again by itself: in its folder, and in the data folder.
const REMADE_HOME = ['app', 'webview2'];
const REMADE_DATA = ['gamedata', 'gamedata-build', 'state', 'update'];

/** The profile data in a data folder as a backup (server/backup.mjs), or null when there is none. */
function profileBackup(data, now = new Date()) {
  const files = {};
  for (const key of PROFILE) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(data, `${key}.json`), 'utf8'));
      if (value && typeof value === 'object') files[key] = value;
    } catch {
      // not there, or not readable
    }
  }
  return Object.keys(files).length ? { format: 'rumble-tracker-backup', version: 1, created: now.toISOString(), data: files } : null;
}

const PRE_EXISTING = 'pre_existing';
/**
 * Makes a tracker's folder that was found in the picked place ready for this tracker. What a tracker makes again by
 * itself goes (the program's files, the game data, the window's data), so that all of it is fresh; the backups stay.
 * A tracker without data of its own uses the data it finds. One that brings its own (`own`) keeps only the backups
 * found there, in a folder of their own in the backups folder (PRE_EXISTING), so that none has the name of one of
 * its own. The profile data found is saved there too, as one more file that Import backup reads, and that file's
 * path is returned; the rest of the data found goes. `keepHome`: the folder is this tracker's own already (its
 * program's files and window's data are in it).
 */
function takeOver(home, own, { keepHome = false, now = new Date() } = {}) {
  const data = path.join(home, 'data');
  if (!keepHome) for (const name of REMADE_HOME) remove(path.join(home, name));
  for (const name of REMADE_DATA) remove(path.join(data, name));
  if (!own) return null;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backups = path.join(data, 'backups');
  const aside = path.join(backups, PRE_EXISTING);
  const found = fs.existsSync(backups) ? fs.readdirSync(backups).filter((n) => n !== PRE_EXISTING) : [];
  const backup = profileBackup(data, now);
  if (found.length || backup) fs.mkdirSync(aside, { recursive: true });
  for (const name of found) {
    // (one set aside by an earlier take-over under the same name stays too)
    const to = path.join(aside, fs.existsSync(path.join(aside, name)) ? `${stamp}-${name}` : name);
    fs.renameSync(path.join(backups, name), to);
  }
  let kept = null;
  if (backup) {
    kept = path.join(aside, `found-${stamp}.json`);
    fs.writeFileSync(kept, JSON.stringify(backup));
  }
  for (const name of fs.existsSync(data) ? fs.readdirSync(data) : []) if (name !== 'backups') remove(path.join(data, name));
  return kept;
}

/** What a move of the tracker's files takes: [from, to, which names] for each folder. */
function movePairs(move, noteDir) {
  const window = (name) => name.startsWith('webview2');
  // from before there was a choice: the data in %APPDATA%, the window's data in %LOCALAPPDATA%
  if (move.legacy) {
    return [[noteDir, path.join(move.to, 'data'), (name) => !name.startsWith('location.json')],
      [move.from, move.to, window]];
  }
  return [[path.join(move.from, 'data'), path.join(move.to, 'data'), () => true], [move.from, move.to, window]];
}

/**
 * The files and folders the pairs name, one by one: { from, to, spare, merge }. A spare one (the window's data) may
 * be left behind when it can't be copied, as the window makes it again. The backups are added to the ones already in
 * the folder they go to (`merge`).
 */
function moveList(pairs) {
  const list = [];
  pairs.forEach(([from, to, wanted], i) => {
    if (samePath(from, to) || !fs.existsSync(from)) return;
    for (const name of fs.readdirSync(from)) {
      if (wanted(name)) {
        list.push({ from: path.join(from, name), to: path.join(to, name), spare: name.startsWith('webview2'),
          merge: i === 0 && name === 'backups' });
      }
    }
  });
  return list;
}

/**
 * Copies one of the list and counts the copy. Anything already at `to` goes first, but backups (see moveList): the
 * ones found there were set aside in a folder of their own (takeOver), so ours are added beside that folder.
 */
function copyEntry(e) {
  if (e.merge && fs.existsSync(e.to)) {
    e.added = [];
    for (const name of fs.readdirSync(e.from)) {
      const [from, to] = [path.join(e.from, name), path.join(e.to, name)];
      e.added.push(to);
      fs.cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true });
      const a = measure(from);
      const b = measure(to);
      if (a.files !== b.files || a.bytes !== b.bytes) throw new Error(`The copy of ${name} is not complete.`);
    }
    return;
  }
  remove(e.to);
  fs.mkdirSync(path.dirname(e.to), { recursive: true });
  fs.cpSync(e.from, e.to, { recursive: true, preserveTimestamps: true });
  const a = measure(e.from);
  const b = measure(e.to);
  if (a.files !== b.files || a.bytes !== b.bytes) throw new Error(`The copy of ${path.basename(e.from)} is not complete.`);
}

/**
 * Copies everything in the list; what it was copied from stays as it is. When one can't be copied, the copies made so
 * far are removed again and the error is thrown, so nothing is half there. Returns what a later clean-up removes: the
 * originals of what was copied.
 */
function copyAll(list) {
  const made = [];
  try {
    for (const e of list) {
      made.push(e);
      try {
        copyEntry(e);
      } catch (err) {
        if (!e.spare) throw err;
        made.pop();
        try {
          remove(e.to);
        } catch {
          // in use: the window makes what is missing in it again
        }
      }
    }
  } catch (err) {
    for (const e of made) {
      try {
        // (of backups added to a folder that was there, only the ones added go)
        for (const p of e.added || [e.to]) remove(p);
        if (e.added) dropEmpty([e.to]);
      } catch {
        // in use: it is written over by the next try
      }
    }
    throw err;
  }
  return list.map((e) => e.from);
}

/**
 * Removes what is where the list's files go: the copies of a try that was cut off or could not be finished. Of
 * backups, only the ones that are also where they come from go, so the ones found there stay.
 */
function dropCopies(list) {
  for (const e of list) {
    try {
      if (!e.merge) remove(e.to);
      else if (fs.existsSync(e.to) && fs.existsSync(e.from)) {
        for (const name of fs.readdirSync(e.from)) remove(path.join(e.to, name));
        dropEmpty([e.to]);
      }
    } catch {
      // in use: it is written over by the next try
    }
  }
}

/** The bytes the list holds, and the bytes free on the disk it goes to (null when that can't be told). */
function roomFor(list) {
  let needed = 0;
  let free = null;
  for (const e of list) needed += measure(e.from).bytes;
  if (list.length) {
    try {
      const s = fs.statfsSync(path.parse(path.resolve(list[0].to)).root);
      free = s.bavail * s.bsize;
    } catch {
      // not told
    }
  }
  return { needed, free };
}

/** Removes what a move left where the files were. Returns what could not be removed yet (in use). */
function clearOld(paths) {
  const left = [];
  for (const p of paths) {
    try {
      remove(p);
    } catch {
      // in use
    }
    if (fs.existsSync(p)) left.push(p);
  }
  return left;
}

/**
 * After a move: what the tracker makes again by itself goes from the old folder (with `window`, which an earlier
 * version kept there), and the folder itself once nothing is left in it.
 */
function tidyOld(old, kept) {
  if (samePath(old, kept)) return;
  for (const name of ['app', 'window', 'data']) {
    try {
      if (name !== 'data' || !fs.readdirSync(path.join(old, name)).length) remove(path.join(old, name));
    } catch {
      // not there, or in use
    }
  }
  try {
    fs.rmdirSync(old);
  } catch {
    // not empty: the user's own files
  }
}

/**
 * What an earlier move left to remove (a note's `clear`), without anything in the folder the files go to now: that
 * would be the new copy.
 */
const stillToClear = (clear, to) => (clear || []).filter((p) => !samePath(p, to) && !inside(p, to));

/**
 * A note as the tracker writes it, whatever the file holds (it may have been changed by hand): the folders it names
 * are whole paths, and of what it lists to remove only whole paths inside a folder named as the tracker's own count,
 * as when uninstalling (desktop/uninstall.ps1). Anything else is left out, so a note that names no folder is asked
 * about like a first start, and nothing outside the tracker's folders is ever removed.
 */
function soundNote(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return {};
  const whole = (p) => typeof p === 'string' && path.isAbsolute(p);
  const own = (p) => whole(p) && path.dirname(path.resolve(p)).toLowerCase().split(path.sep).includes(FOLDER_NAME.toLowerCase());
  const out = { ...note };
  for (const key of ['folder', 'moveTo']) if (!whole(out[key])) delete out[key];
  // (a move starts from the folder the note names: only the first one, from before there was a choice, has none)
  if (!out.folder) delete out.moveTo;
  const m = out.moving;
  if (!m || typeof m !== 'object' || !whole(m.from) || !whole(m.to) || !(m.legacy || out.folder)) delete out.moving;
  // the folders made for a move: a list of whole paths
  const made = (list) => (Array.isArray(list) ? list.filter(whole) : []);
  if (made(out.made).length) out.made = made(out.made);
  else delete out.made;
  if (out.moving) {
    const { made: list, ...rest } = out.moving;
    out.moving = { ...rest, ...(made(list).length && { made: made(list) }) };
  }
  const clear = Array.isArray(out.clear) ? out.clear.filter(own) : [];
  if (clear.length) out.clear = clear;
  else delete out.clear;
  return out;
}

/**
 * The folders made for a move: the tracker's folder there with its data folder, and those Settings made above it
 * (the note's `made`; only folders the tracker's folder is in count).
 */
function madeFor(moving) {
  const above = (moving.made || []).filter((d) => typeof d === 'string' && inside(moving.to, d) && !samePath(moving.to, d));
  return [path.join(moving.to, 'data'), moving.to, ...above];
}

/**
 * Removes the folders that held what a move left behind, once they are empty: a tracker's old data folder, and its
 * old folder. `kept` (the tracker's folder now) stays.
 */
function dropShells(gone, kept) {
  for (const p of gone) {
    let d = path.dirname(p);
    for (let i = 0; i < 2 && !samePath(d, kept); i++) {
      dropEmpty([d]);
      if (path.basename(d).toLowerCase() === FOLDER_NAME.toLowerCase()) break;
      d = path.dirname(d);
    }
  }
}

/** Why the tracker's folder can't be `home`, or null: it must be a folder the tracker can write to. */
function homeProblem(home, noteDir) {
  if (!path.isAbsolute(home)) return 'Give the whole path of a folder, such as D:\\Games.';
  if (samePath(home, noteDir) || inside(home, noteDir)) {
    return 'That folder holds the note of where the tracker\'s files are. Pick another.';
  }
  const made = notThere(home);
  try {
    fs.mkdirSync(home, { recursive: true });
    const probe = path.join(home, `.write-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
  } catch (e) {
    dropEmpty(made); // the folders made for the try do not stay
    return `The tracker can't write to that folder (${e.code || e.message}).`;
  }
  return null;
}

// Starting up
// This tracker's repository, as its server names it.
const OWN_REPO = process.env.RUMBLE_ISSUES_REPO || 'razingo/rumble-tracker-ind';

/** Port state: 'tracker' (this tracker already runs), 'free' or 'other'. */
function probe(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/report', headers: { host: `localhost:${port}` }, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => {
        try {
          const { repo } = JSON.parse(body);
          resolve(repo === OWN_REPO ? 'tracker' : 'other');
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

/** Whether the port can be bound (Windows may reserve ranges, e.g. for Hyper-V). */
function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** A running tracker's port, else the first usable port: { running, port }. */
async function findPort() {
  const states = await Promise.all(PORTS.map((p) => probe(p)));
  const running = PORTS.find((p, i) => states[i] === 'tracker');
  if (running) return { running: true, port: running };
  for (const [i, p] of PORTS.entries()) if (states[i] === 'free' && await canListen(p)) return { running: false, port: p };
  return { running: false, port: null };
}

// Where the tracker keeps its files: asked on the first start, moved when the answer changes

// The launcher's own pop-ups (desktop/popup.ps1): the question of where the files go, the wait while they are moved,
// and messages. They are needed before the program's files are unpacked, so the script and the title's font are in
// the exe beside those files, and are written to the temporary folder to be run.
const LAUNCHER_TEMP = path.join(os.tmpdir(), 'RumbleTracker-launcher');
// Why a new version could not start, left for the previous version that is started again (see fatal).
const RESTORED = path.join(LAUNCHER_TEMP, 'restored.txt');
let popupFiles = null;
function popupSources() {
  if (popupFiles) return popupFiles;
  popupFiles = { script: path.join(LAUNCHER_TEMP, 'popup.ps1'), font: path.join(LAUNCHER_TEMP, 'LilitaOne-Regular.ttf') };
  for (const f of Object.values(popupFiles)) {
    try {
      fs.mkdirSync(LAUNCHER_TEMP, { recursive: true });
      fs.writeFileSync(f, Buffer.from(sea.getAsset(path.basename(f))));
    } catch {
      // in use by a pop-up that is open, so it is there already
    }
  }
  return popupFiles;
}

/** What starts a pop-up of a kind (ask, wait or message): PowerShell's arguments and environment. */
function popupStart(kind, head, text, more = {}) {
  const { script, font } = popupSources();
  return [psArgs(PS_RUN_FILE), { windowsHide: true, env: { ...process.env, RT_SCRIPT: script, RT_FONT: font, RT_KIND: kind,
    RT_TITLE: TITLE, RT_HEAD: head, RT_TEXT: text, RT_EXE: process.execPath, ...more } }];
}

// When the tracker's own pop-up can't be shown (its script can't be written or run), Windows' own are: a message box,
// and for the question of where the files go, the same words in a message box and then Windows' folder picker. A
// message with three buttons has them as Yes, No and Cancel, each named in the text.
const PLAIN_POPUP = `Add-Type -AssemblyName System.Windows.Forms
$text = $env:RT_HEAD + [Environment]::NewLine + [Environment]::NewLine + $env:RT_TEXT
$box = [System.Windows.Forms.MessageBox]
if ($env:RT_KIND -eq 'ask') {
  if ($env:RT_PROBLEM) { $text = $env:RT_PROBLEM + [Environment]::NewLine + [Environment]::NewLine + $text }
  if ($box::Show($text, $env:RT_TITLE, 'OKCancel', 'Question') -ne 'OK') { [Console]::Out.Write('cancel'); exit }
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = 'The tracker makes a folder named RumbleTracker in the folder you pick.'
  $d.SelectedPath = $env:RT_FOLDER
  [Console]::Out.Write($(if ($d.ShowDialog() -eq 'OK') { 'ok ' + $d.SelectedPath } else { 'cancel' }))
} elseif ($env:RT_BUTTONS) {
  $names = $env:RT_BUTTONS.Split('|')
  $text += [Environment]::NewLine
  $text += [Environment]::NewLine + 'Yes: ' + $names[0] + [Environment]::NewLine + 'No: ' + $names[1]
  $text += [Environment]::NewLine + 'Cancel: ' + $names[2]
  $answer = $box::Show($text, $env:RT_TITLE, 'YesNoCancel', 'Warning')
  [Console]::Out.Write($(if ($answer -eq 'Yes') { 'ok 0' } elseif ($answer -eq 'No') { 'ok 1' } else { 'ok 2' }))
} else {
  [void]$box::Show($text, $env:RT_TITLE, 'OK', 'Warning')
  [Console]::Out.Write('ok')
}`;

/**
 * Shows a pop-up and resolves to what was pressed once it is closed: "ok" (with the folder for ask, with the
 * button's number for a message with RT_BUTTONS) or "cancel". If the tracker's own pop-up says neither, it was not
 * shown, and Windows' own is.
 */
function popup(kind, head, text, more = {}) {
  const [args, options] = popupStart(kind, head, text, more);
  const said = (run) => new Promise((resolve) => {
    execFile(POWERSHELL, run, options, (err, out) => resolve(String(out || '').trim()));
  });
  return said(args).then((out) => {
    if (/^(ok|cancel)\b/.test(out)) return out;
    console.log('The tracker\'s own pop-up could not be shown; Windows\' own is');
    return said(psArgs(PLAIN_POPUP));
  });
}

// One start at a time: a second one, begun while the first still asks where the files go or moves them, would ask and
// move too. The first leaves its process id in a file until its server answers; a file left by a start that ended
// otherwise names a process that is gone, or one that is not the tracker.
const START_LOCK = path.join(LAUNCHER_TEMP, 'starting.lock');
let startingPid = 0; // the start that is under way, when it is not this one
// An empty file a second one leaves for the start that is under way, which has no server to ask yet: once it runs, it
// shows its window, also when it was started in the background.
const SHOW_REQUEST = path.join(LAUNCHER_TEMP, 'show');
const SHOW_REQUEST_LATE = 3000; // ms after the start, when it is looked for once more
function askStartToShow() {
  try {
    fs.writeFileSync(SHOW_REQUEST, '');
  } catch {
    // nowhere to leave it
  }
}
/** Whether the window was asked for that way; the request is taken. */
function showAsked() {
  try {
    fs.rmSync(SHOW_REQUEST);
    return true;
  } catch {
    return false;
  }
}
function trackerRuns(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const out = execFileSync(path.join(SYSTEM32, 'tasklist.exe'),
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    return out.toLowerCase().includes(path.basename(process.execPath).toLowerCase());
  } catch {
    return true; // not told: taken as the tracker
  }
}
function dropStartLock() {
  try {
    if (Number(fs.readFileSync(START_LOCK, 'utf8')) === process.pid) fs.rmSync(START_LOCK);
  } catch {
    // not there
  }
}
/** Whether this start may go on: false when another one is under way. */
function takeStartLock() {
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(LAUNCHER_TEMP, { recursive: true });
      fs.writeFileSync(START_LOCK, String(process.pid), { flag: 'wx' });
      process.on('exit', dropStartLock);
      showAsked(); // (one left for a start that ended is not for this one)
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // nowhere to leave it: this start goes on without
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(START_LOCK, 'utf8'));
      } catch {
        // gone again
      }
      if (pid && pid !== process.pid && trackerRuns(pid)) {
        startingPid = pid;
        return false;
      }
      fs.rmSync(START_LOCK, { force: true });
    }
  }
  return true;
}
/**
 * Brings the pop-up of the start that is under way to the front: the window of a PowerShell that start runs, so no
 * other window with the tracker's name is taken for it.
 */
const SHOW_START_QUESTION = `$shell = New-Object -ComObject WScript.Shell
$own = Get-CimInstance Win32_Process -Filter "ParentProcessId = $([int]$env:RT_STARTING) AND Name = 'powershell.exe'"
foreach ($p in $own) { if ($shell.AppActivate([int]$p.ProcessId)) { break } }`;
function showStartQuestion() {
  try {
    execFileSync(POWERSHELL, psArgs(SHOW_START_QUESTION),
      { windowsHide: true, timeout: 15000, stdio: 'ignore', env: { ...process.env, RT_STARTING: String(startingPid) } });
  } catch {
    // it stays where it is
  }
}

/**
 * Asks where the tracker should keep its files, until the answer is a folder it can use. Resolves to the tracker's
 * own folder there, or null when the user pressed Cancel. `made` is given the folders that were made for it: the
 * tracker's own, and those above it that were not there.
 */
async function askFolder(existing, made = []) {
  let folder = LOCAL;
  let problem = '';
  for (;;) {
    const text = `The tracker makes a folder of its own named ${FOLDER_NAME} `
      + 'in the folder you pick, and keeps everything in it: your data, what it reads from the game and its own program '
      + `files.${existing ? ' The files it has now are moved there.' : ''} You can change this later in Settings.`;
    const out = await popup('ask', 'Where should the tracker keep its files?', text,
      { RT_FOLDER: folder, RT_PROBLEM: problem });
    if (!out.startsWith('ok')) return null;
    folder = out.slice(2).trim();
    const home = folder && path.isAbsolute(folder) ? homeIn(folder) : folder;
    const missing = folder && path.isAbsolute(folder) ? notThere(home) : [];
    problem = folder ? homeProblem(home, NOTE_DIR) : 'Pick a folder.';
    if (!problem) {
      made.push(...missing);
      return home;
    }
  }
}

/**
 * Moves the tracker's files as the note says, behind a window that asks to wait: everything is copied first, then the
 * note names the new folder, and only then do the files go from where they were. So a move that fails or is cut off
 * leaves them whole in one place: where they were while copying, and in the new folder from then on (what is left of
 * the old ones is in the note's `clear`, and goes at a later start). Returns the note that holds now, and why the
 * move failed, if it did.
 */
function relocate(note) {
  const { moving } = note;
  const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
  const before = stillToClear(note.clear, moving.to);
  const back = moving.legacy ? {} : { folder: note.folder, ...(before.length && { clear: before }) };
  let list = [];
  // What a move that is not done leaves no trace of: the copies (also those of an earlier try that was cut off) and
  // the folders made for it. A folder in use there that is not made ready yet holds another tracker's files, not
  // copies, so nothing in it goes.
  const undo = () => {
    if (!moving.legacy || moving.prepared) dropCopies(list);
    dropEmpty(madeFor(moving));
  };
  try {
    list = moveList(movePairs(moving, NOTE_DIR));
    const { needed, free } = roomFor(list);
    // (the room is looked at before a folder in use there is touched)
    if (free != null && needed > free) {
      undo();
      return { note: back, failed: `It needs ${gb(needed)} GB there, and ${gb(free)} GB is free.` };
    }
    // a folder that is in use where the files go is made ready once, before anything of ours is in it
    if (moving.legacy && !moving.prepared) {
      if (inUse(moving.to)) {
        const kept = takeOver(moving.to, true, { keepHome: samePath(moving.to, moving.from) });
        if (kept) console.log(`The data found in ${moving.to} was set aside as ${kept}`);
      }
      moving.prepared = true;
    }
    writeNote(NOTE, note); // (a move cut off while copying is done again at the next start)
  } catch (e) {
    // (a file that can't be read, or a folder there that can't be made ready: the move is not begun)
    console.log(`The move to ${moving.to} could not begin: ${e.message}`);
    undo();
    return { note: back, failed: e.message };
  }
  const [args, options] = popupStart('wait', 'Moving the tracker\'s files', 'This can take a few minutes.');
  const wait = spawn(POWERSHELL, args, { ...options, stdio: 'ignore' });
  try {
    let old;
    try {
      old = copyAll(list);
    } catch (e) {
      console.log(`Copying the files to ${moving.to} failed: ${e.message}`);
      undo();
      return { note: back, failed: e.message };
    }
    // (an earlier version kept its window's helpers in the usual place: they go, wherever the files went)
    const moved = { folder: moving.to, clear: [...before, ...old, ...(moving.legacy ? [path.join(DEFAULT_HOME, 'window')] : [])] };
    writeNote(NOTE, moved);
    return { note: cleared(moved, moving.from) };
  } finally {
    wait.kill();
  }
}

/**
 * Removes what a move left behind (the note's `clear`), and the folders it was in once they are empty. Returns the
 * note without what is gone.
 */
function cleared(note, from) {
  const all = note.clear || [];
  const left = clearOld(all);
  if (from) tidyOld(from, note.folder);
  dropShells(all.filter((p) => !left.includes(p)), note.folder);
  const { clear, ...rest } = note;
  const next = left.length ? { ...rest, clear: left } : rest;
  if (left.length) console.log(`Still to remove, as they are in use: ${left.join(', ')}`);
  return next;
}

/**
 * The tracker's folder is not there (its disk is not connected, or it was moved, renamed or deleted): tries again, has
 * a folder picked (the same one again starts empty in it), or gives up (null).
 */
async function unreachable(folder) {
  for (;;) {
    const said = await popup('message', 'The tracker\'s folder can\'t be reached',
      `The tracker keeps its files in ${folder}, and that folder is not there now. If its disk is not connected, `
      + 'connect it and try again. If the folder was moved or renamed, put it back and try again.\n\n'
      + 'In a folder you pick, the tracker starts empty, or with the tracker\'s files it finds there. Files in another '
      + 'place stay as they are.',
      { RT_BUTTONS: 'Try again|Pick a folder|Quit' });
    if (said === 'ok 0') {
      if (reachable(folder)) return folder;
    } else if (said === 'ok 1') {
      const to = await askFolder(false);
      if (to) return to;
    } else return null;
  }
}

/**
 * Finds the tracker's folder: as noted, or asked for on the first start (and on the first start since there is a
 * choice, when the files it has are moved). A move asked for in Settings is done here, before anything uses the
 * files. Returns false when the tracker should not start.
 */
async function locate() {
  if (FIXED_DATA) {
    useHome(DEFAULT_HOME, FIXED_DATA);
    return true;
  }
  let note = soundNote(readNote(NOTE));
  // (a first move that was cut off goes on without the question, and has the same log)
  if (note.moving?.legacy) oldLog = path.join(NOTE_DIR, 'tracker.log');
  if (!note.folder && !note.moving) {
    // files from before there was a choice: the data folder was the note's own folder
    const legacy = fs.existsSync(NOTE_DIR) && fs.readdirSync(NOTE_DIR).some((n) => !n.startsWith('location.json'));
    if (legacy) oldLog = path.join(NOTE_DIR, 'tracker.log');
    const made = [];
    const to = await askFolder(legacy, made);
    if (!to) return false;
    // (`made`: the folders made for the pick, which go again if the move can't be done)
    if (legacy) note = { moving: { legacy: true, from: DEFAULT_HOME, to, ...(made.length && { made }) } };
    else {
      // a tracker's folder found there is used, with what the tracker makes again by itself made fresh
      if (inUse(to)) takeOver(to, false);
      note = { folder: to };
    }
  } else if (note.folder && !reachable(note.folder)) {
    const to = await unreachable(note.folder);
    if (!to) return false;
    if (!samePath(to, note.folder)) {
      if (inUse(to)) takeOver(to, false);
      note = { folder: to };
    }
  }
  if (note.moveTo) {
    const { moveTo, made, ...rest } = note;
    note = samePath(moveTo, note.folder) ? rest : { ...rest, moving: { from: note.folder, to: moveTo, ...(made && { made }) } };
  }
  let failed = null;
  if (note.moving) {
    const { moving } = note;
    ({ note, failed } = relocate(note));
    if (failed && moving.legacy) {
      // as before the question: it is asked again at the next start
      fs.rmSync(NOTE, { force: true });
      fatal(`The tracker's files could not be moved to ${moving.to}: ${failed}\n\nThey are where they were. Start the `
        + 'tracker again to pick a folder.');
      return false;
    }
  } else if (note.clear) note = cleared(note);
  writeNote(NOTE, note);
  useHome(note.folder);
  if (failed) {
    console.log(`The files stay in ${note.folder}`);
    await popup('message', 'The files were not moved', `${failed}\n\nThey are where they were, in ${note.folder}.`);
  }
  return true;
}

/** Waits up to 20 s for the server to answer, checking often, as the window opens only once it does. */
async function waitForServer() {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await probe() === 'tracker') return true;
    await sleep(25);
  }
  return false;
}

/** Asks the running instance to show its window (unless started in the background), and exits. */
async function handOver() {
  console.log(`Already running${NO_WINDOW ? '' : ': showing its window'}`);
  if (!NO_WINDOW) await askToShow();
  process.exit(0);
}

/** POST /api/show-window to the running tracker. */
function askToShow() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/show-window', method: 'POST', timeout: 5000,
      headers: { host: `localhost:${PORT}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      if (res.statusCode !== 200) console.log(`The running tracker didn't show its window (HTTP ${res.statusCode})`);
      res.on('end', resolve);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      console.log(`The running tracker didn't answer: ${e.message}`);
      resolve();
    });
    req.end('{}');
  });
}

/** Unpacks the embedded app (once per version) and returns its folder. */
function unpack() {
  const blob = Buffer.from(sea.getAsset('app.bin'));
  const indexLen = blob.readUInt32LE(0);
  const index = JSON.parse(blob.subarray(4, 4 + indexLen).toString('utf8'));
  const base = path.join(HOME, 'app');
  const dir = path.join(base, `${index.version}-${index.hash.slice(0, 12)}`);
  if (fs.existsSync(path.join(dir, '.complete'))) return { dir, index };
  // (the files are stored deflated together)
  const data = index.deflated ? zlib.inflateSync(blob.subarray(4 + indexLen)) : blob.subarray(4 + indexLen);

  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, offset, size, sha] of index.files) {
    const buf = data.subarray(offset, offset + size);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== sha) {
      throw new Error(`The program file is damaged (${rel}). Please download it again.`);
    }
    const target = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
  fs.writeFileSync(path.join(tmp, '.complete'), `${index.version} ${index.hash}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  // Remove older versions. One may still be running, so this is best effort.
  for (const name of fs.readdirSync(base)) {
    if (name !== path.basename(dir)) {
      try {
        fs.rmSync(path.join(base, name), { recursive: true, force: true });
      } catch {
        // in use
      }
    }
  }
  return { dir, index };
}

/** Waits up to 30 s for a process to stop. */
async function waitForExit(pid) {
  for (let i = 0; i < 150; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(200);
  }
}

// App updates
// The server downloads and verifies the new exe (server/update/appupdate.mjs), and it is swapped in here. A running exe
// can be renamed but not overwritten, so this one becomes RumbleTracker.exe.old, which the next start removes. The new
// one is copied to its place and started, and it waits for this instance to stop.
const OLD_EXE = `${process.execPath}.old`;
const FAILED_EXE = `${process.execPath}.failed`; // a new version that failed to start, rolled back (see fatal)
function applyUpdate({ exe, version }) {
  const target = process.execPath;
  try {
    fs.rmSync(OLD_EXE, { force: true });
    fs.renameSync(target, OLD_EXE);
    try {
      fs.copyFileSync(exe, target);
    } catch (e) {
      fs.renameSync(OLD_EXE, target);
      throw e;
    }
  } catch (e) {
    console.log(`App update: could not replace ${target}: ${e.message}`);
    return Promise.reject(new Error(`The program file could not be replaced (${e.code
      || e.message}). Download version ${version} from GitHub Releases instead.`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(target, [`--after-update=${process.pid}:${PORT}`], { detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      console.log(`App update: started ${version}`);
      resolve();
    });
    child.once('error', (e) => {
      console.log(`App update: could not start the new version: ${e.message}`);
      try {
        fs.rmSync(target, { force: true });
        fs.renameSync(OLD_EXE, target);
      } catch {
        // keep what is there
      }
      reject(new Error(`The new version could not be started (${e.message}). Download it from GitHub Releases instead.`));
    });
  });
}

/** Quit from the tray, or Windows shutting down. As with Quit on the page, the scan and writes finish first. */
let quitting = false;
function quitFromTray(reason) {
  quitting = true;
  if (!host?.quit(reason)) {
    console.log(reason);
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 20000).unref(); // in case the server can't finish
}

/**
 * Uninstall in Settings: desktop/uninstall.ps1 waits for the tracker to stop, then removes it from this PC. It's
 * started through cmd's start, so it outlives the tracker even when a job ends the tracker's child processes with it
 * (a plain detached child didn't survive that). cmd itself is not started detached: it would have no console then,
 * and Windows would open one, in view, for PowerShell.
 */
function uninstall() {
  console.log('Uninstalling');
  spawn(path.join(SYSTEM32, 'cmd.exe'), ['/d', '/c', 'start', '""', '/b', POWERSHELL, ...psArgs(PS_RUN_FILE)], {
    stdio: 'ignore', windowsHide: true,
    env: { ...process.env, RT_SCRIPT: path.join(APP_DIR, 'desktop', 'uninstall.ps1'), RT_PARENT: String(process.pid),
      RT_EXE: process.execPath, RT_HOME: HOME, RT_NOTE: FIXED_DATA ? '' : NOTE_DIR,
      RT_LOCAL: FIXED_DATA ? '' : DEFAULT_HOME, RT_TITLE: TITLE },
  }).unref();
  quitFromTray('Uninstall from Settings');
}

/** Stops the tracker and starts it again, which waits for this instance to stop (to move its files, see locate). */
function restart() {
  console.log('Restarting');
  spawn(process.execPath, [`--restart=${process.pid}`], { detached: true, stdio: 'ignore' }).unref();
  quitFromTray('Restart to move the files');
}

/**
 * Picks the port: hands over to a tracker that already runs, or stops when every port is taken. Returns whether this
 * instance goes on starting.
 */
async function claimPort() {
  const found = await findPort();
  if (found.running) {
    usePort(found.port);
    await handOver();
    return false;
  }
  if (!found.port) {
    fatal(PORTS.length === 1
      ? `Port ${PORTS[0]} (set with PORT) is already in use, so the tracker can't start.`
      : `Ports ${PORTS[0]}-${PORTS[PORTS.length - 1]} are all in use by other programs, so the tracker can't start.`);
    return false;
  }
  usePort(found.port);
  return true;
}

/** Another instance can start at the same time and win the port; this one then hands over to it. */
function handOverOnPortRace() {
  process.on('uncaughtException', async (e) => {
    if (e?.code !== 'EADDRINUSE') {
      console.log(`Unexpected error: ${e?.stack || e}`);
      return;
    }
    const again = await findPort();
    if (!again.running) return fatal(`Port ${PORT} is already in use, so the tracker can't start.`);
    usePort(again.port);
    await handOver();
  });
}

/**
 * Loads the server from the unpacked files, connected through server/host.mjs. The first start reads the game data
 * from the game install before the server finishes loading and serves a progress page meanwhile, so this returns as
 * soon as the port answers. Returns whether it started.
 */
async function startServer(app) {
  const load = createRequire(path.join(app.dir, 'launcher-helper.cjs'))(path.join(app.dir, 'import.cjs'));
  const failedToStart = (e) => fatal(`The tracker could not start: ${e?.message || e}`, { rollback: true });
  try {
    host = (await load(pathToFileURL(path.join(app.dir, 'server', 'host.mjs')).href)).host;
  } catch (e) {
    failedToStart(e);
    return false;
  }
  host.attach({
    // (storage: the tracker's folder and the note that names it; null when RUMBLE_DATA_DIR fixes the data folder)
    options: { port: PORT, dataDir: DATA, storage: FIXED_DATA ? null : { folder: HOME, note: NOTE } },
    applyUpdate,
    restart,
    takeScreenshot: () => shellOpen('ms-screenclip:'),
    showWindow,
    uninstall,
  });
  let failed = false;
  load(pathToFileURL(path.join(app.dir, 'server', 'main.mjs')).href).catch((e) => {
    failed = true;
    failedToStart(e);
  });
  const answered = await waitForServer();
  if (failed) return false;
  if (!answered) fatal(`The tracker started but its page at ${PAGE} doesn't answer. See ${LOG}.`, { rollback: true });
  return answered;
}

/** Once this version runs: removes the previous exe (kept since an update) and a rolled-back one. */
function removeLeftovers() {
  for (const f of [OLD_EXE, FAILED_EXE]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // still in use, so it is removed next time
    }
  }
}

async function main() {
  if (process.platform !== 'win32') return fatal(`${TITLE} runs on Windows only.`);
  if (afterUpdate || restartOf) await waitForExit(afterUpdate?.pid || restartOf);
  if (!await claimPort()) return;
  if (!takeStartLock()) {
    // (nothing is written to the log: the other start may be moving the folder it is in)
    early = [];
    oldLog = null;
    LOG = null;
    if (!NO_WINDOW) askStartToShow();
    showStartQuestion();
    return;
  }
  if (!await locate()) return;
  rotateLog();
  let app;
  try {
    app = unpack();
  } catch (e) {
    return fatal(`Could not unpack the tracker's files: ${e.message}`, { rollback: true });
  }
  APP_DIR = app.dir;
  console.log(`${TITLE} ${app.index.version}, unpacked in ${app.dir}`);
  handOverOnPortRace();
  if (!await startServer(app)) return;
  dropStartLock();
  // after the server, not alongside it: starting both at once slows each of them down
  startWindowHost(quitFromTray, !NO_WINDOW || showAsked());
  // (a second start that saw the lock just before it went may leave its request a moment later)
  setTimeout(() => { if (showAsked()) showWindow(); }, SHOW_REQUEST_LATE);
  if (args.has('--restored')) showRestored();
  removeLeftovers();
  // not needed right away, so it doesn't slow down the window opening
  setTimeout(integrate, INTEGRATE_DELAY);
}

// Windows integration
// The Start menu shortcut gives notifications the tracker's name and icon (app ID AUMID). Clicking one opens a
// rumble-tracker: link, which starts this exe with --open, and a running tracker then shows its window.
const AUMID = 'razingo.RumbleCollectionTracker';
const INTEGRATE_DELAY = 5000; // ms after the start
function integrate() {
  const env = { ...process.env, RT_EXE: process.execPath, RT_AUMID: AUMID, RT_TITLE: TITLE, RT_REFRESH: afterUpdate ? '1' : '',
    RT_CACHE: path.join(APP_DIR, 'desktop', 'integration-helpers.dll') };
  execFile(POWERSHELL, psArgs(fs.readFileSync(path.join(APP_DIR, 'desktop', 'integration.ps1'), 'utf8')),
    { windowsHide: true, timeout: 60000, env }, (err, out, stderr) => {
    const done = new Set(String(out || '').split(/\r?\n/).map((l) => l.trim()));
    if (done.has('shortcut')) host.setNotificationIdentity({ appId: AUMID });
    if (done.has('protocol')) host.setNotificationIdentity({ launch: 'rumble-tracker:open' });
    const problems = String(stderr || '').replace(/^#< CLIXML\s*/, '').trim();
    if (err || problems) console.log(`Windows integration: ${problems || err.message}`.slice(0, 1000));
  });
}

main().catch((e) => fatal(`The tracker could not start: ${e && e.stack || e}`));
