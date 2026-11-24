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
const { execFile, spawn } = require('node:child_process');
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
// Lines written before the folder is known wait in `early`.
let early = [];
function useHome(home, data = path.join(home, 'data')) {
  HOME = home;
  DATA = data;
  fs.mkdirSync(DATA, { recursive: true });
  LOG = path.join(DATA, 'tracker.log');
}
// Called only by the instance that runs (not when handing over to a running one).
const rotateLog = () => {
  try {
    fs.renameSync(LOG, path.join(DATA, 'tracker.previous.log'));
  } catch {
    // first start
  }
  logBytes = 0;
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
    if (!LOG) return void early.push(text);
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
      if (logBytes + text.length > MAX_LOG) rotateLog();
      fs.appendFileSync(LOG, text);
      logBytes += Buffer.byteLength(text);
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
 * app update, so the previous exe is put back and started instead.
 */
function fatal(message, { rollback = false } = {}) {
  console.log(`Stopped: ${message}`);
  if (rollback && afterUpdate && fs.existsSync(OLD_EXE)) {
    try {
      fs.rmSync(FAILED_EXE, { force: true });
      fs.renameSync(process.execPath, FAILED_EXE); // a running exe can be renamed
      fs.renameSync(OLD_EXE, process.execPath);
      spawn(process.execPath, [`--after-update=${process.pid}:${afterUpdate.port}`], { detached: true, stdio: 'ignore' }).unref();
      console.log('App update: the new version failed to start; the previous version was restored');
      message = `The new version could not start, so the previous version was restored and started again.

${message}`;
    } catch (e) {
      console.log(`App update: could not restore the previous version: ${e.message}`);
    }
  }
  popup('message', 'The tracker stopped', message).then(() => process.exit(1));
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
      RT_SHOW: show ? '1' : '', RT_RDMODULE: `${PAGE}rdmodule/`, RT_RDMODULE_PROFILE: path.join(HOME, 'webview2-rdmodule') },
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

/**
 * Moves a file or folder. On the same disk it is renamed; to another disk it is copied, the copy is counted, and
 * only then is the original removed. Anything already at `to` is a leftover of a move that was cut off, and goes.
 */
function moveEntry(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (e) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
  }
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
  const a = measure(from);
  const b = measure(to);
  if (a.files !== b.files || a.bytes !== b.bytes) throw new Error(`The copy of ${path.basename(from)} is not complete.`);
  fs.rmSync(from, { recursive: true, force: true });
}

/** What a move of the tracker's files moves: [from, to, which names] for each folder. */
function movePairs(move, noteDir) {
  const window = (name) => name.startsWith('webview2');
  // from before there was a choice: the data in %APPDATA%, the window's data in %LOCALAPPDATA%
  if (move.legacy) {
    return [[noteDir, path.join(move.to, 'data'), (name) => !name.startsWith('location.json')],
      [move.from, move.to, window]];
  }
  return [[path.join(move.from, 'data'), path.join(move.to, 'data'), () => true], [move.from, move.to, window]];
}

/** Moves the files of each pair, entry by entry; `back` moves them the other way (after a move that failed). */
function moveFiles(pairs, back = false) {
  for (const [a, b, wanted] of pairs) {
    const [from, to] = back ? [b, a] : [a, b];
    if (samePath(from, to) || !fs.existsSync(from)) continue;
    for (const name of fs.readdirSync(from)) if (wanted(name)) moveEntry(path.join(from, name), path.join(to, name));
  }
}

/** Bytes the pairs hold that would go to another disk, and the bytes free there (null when that can't be told). */
function roomFor(pairs) {
  let needed = 0;
  let free = null;
  for (const [from, to, wanted] of pairs) {
    const disk = (p) => path.parse(path.resolve(p)).root.toLowerCase();
    if (!fs.existsSync(from) || disk(from) === disk(to)) continue;
    for (const name of fs.readdirSync(from)) if (wanted(name)) needed += measure(path.join(from, name)).bytes;
    try {
      const s = fs.statfsSync(path.parse(path.resolve(to)).root);
      free = s.bavail * s.bsize;
    } catch {
      // not told
    }
  }
  return { needed, free };
}

/** After a move: the old folder's unpacked program goes, and the folder itself once nothing is left in it. */
function tidyOld(old, kept) {
  if (samePath(old, kept)) return;
  for (const name of ['app', 'data']) {
    try {
      if (name === 'app' || !fs.readdirSync(path.join(old, name)).length) fs.rmSync(path.join(old, name), { recursive: true, force: true });
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

/** Why the tracker's folder can't be `home`, or null: it must be a folder the tracker can write to. */
function homeProblem(home, noteDir) {
  if (!path.isAbsolute(home)) return 'Give the whole path of a folder, such as D:\\Games.';
  if (samePath(home, noteDir) || inside(home, noteDir)) {
    return 'That folder holds the note of where the tracker\'s files are. Pick another.';
  }
  try {
    fs.mkdirSync(home, { recursive: true });
    const probe = path.join(home, `.write-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
  } catch (e) {
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
let popupFiles = null;
function popupSources() {
  if (popupFiles) return popupFiles;
  const dir = path.join(os.tmpdir(), 'RumbleTracker-launcher');
  popupFiles = { script: path.join(dir, 'popup.ps1'), font: path.join(dir, 'LilitaOne-Regular.ttf') };
  for (const f of Object.values(popupFiles)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
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

/** Shows a pop-up and resolves to what it printed once it is closed ("ok", with the folder for ask, or nothing). */
function popup(kind, head, text, more) {
  const [args, options] = popupStart(kind, head, text, more);
  return new Promise((resolve) => {
    execFile(POWERSHELL, args, options, (err, out) => resolve(String(out || '').trim()));
  });
}

/**
 * Asks where the tracker should keep its files, until the answer is a folder it can use. Resolves to the tracker's
 * own folder there, or null when the user pressed Cancel.
 */
async function askFolder(existing) {
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
    problem = folder ? homeProblem(home, NOTE_DIR) : 'Pick a folder.';
    if (!problem) return home;
  }
}

/** Moves the tracker's files as the note says, behind a window that asks to wait. Returns why it failed, or null. */
function moveNow(note) {
  const pairs = movePairs(note.moving, NOTE_DIR);
  const { needed, free } = roomFor(pairs);
  const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
  if (free != null && needed > free) return `It needs ${gb(needed)} GB there, and ${gb(free)} GB is free.`;
  const [args, options] = popupStart('wait', 'Moving the tracker\'s files', 'This can take a few minutes.');
  const wait = spawn(POWERSHELL, args, { ...options, stdio: 'ignore' });
  try {
    moveFiles(pairs);
    return null;
  } catch (e) {
    console.log(`Moving the files to ${note.moving.to} failed: ${e.message}`);
    try {
      moveFiles(pairs, true);
    } catch (e2) {
      console.log(`Moving them back failed: ${e2.message}`);
      return `${e.message} Some files are now in ${note.moving.to} and some in ${note.moving.legacy ? NOTE_DIR : note.moving.from}.`;
    }
    return e.message;
  } finally {
    wait.kill();
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
  let note = readNote(NOTE);
  if (!note?.folder && !note?.moving) {
    // files from before there was a choice: the data folder was the note's own folder
    const legacy = fs.existsSync(NOTE_DIR) && fs.readdirSync(NOTE_DIR).some((n) => !n.startsWith('location.json'));
    const to = await askFolder(legacy);
    if (!to) return false;
    note = legacy ? { moving: { legacy: true, from: DEFAULT_HOME, to } } : { folder: to };
  } else if (note.moveTo && note.folder && !samePath(note.moveTo, note.folder)) {
    note = { folder: note.folder, moving: { from: note.folder, to: note.moveTo } };
  } else if (note.moveTo) note = { folder: note.folder };
  let failed = null;
  if (note.moving) {
    const { moving } = note;
    writeNote(NOTE, note); // (a move cut off goes on at the next start)
    failed = moveNow(note);
    if (!failed) {
      tidyOld(moving.from, moving.to);
      note = { folder: moving.to };
    } else if (moving.legacy) {
      // as before the question: it is asked again at the next start
      fs.rmSync(NOTE, { force: true });
      fatal(`The tracker's files could not be moved to ${moving.to}: ${failed}\n\nStart the tracker again to pick a folder.`);
      return false;
    } else note = { folder: note.folder };
  }
  writeNote(NOTE, note);
  useHome(note.folder);
  if (failed) {
    console.log(`The files stay in ${note.folder}`);
    await popup('message', 'The files were not moved', `${failed}\n\nThey stay in ${note.folder}.`);
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
      RT_EXE: process.execPath, RT_DATA: DATA, RT_HOME: HOME, RT_NOTE: FIXED_DATA ? '' : NOTE_DIR,
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
  // after the server, not alongside it: starting both at once slows each of them down
  startWindowHost(quitFromTray);
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
  const env = { ...process.env, RT_EXE: process.execPath, RT_AUMID: AUMID, RT_TITLE: TITLE, RT_REFRESH: afterUpdate ? '1' : '' };
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
