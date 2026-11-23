// Entry point of RumbleTracker.exe (Node.js single executable application), built by tools/build-release.mjs.
//
// The app's files are embedded as one asset and unpacked per version to %LOCALAPPDATA%\RumbleTracker\app; a CommonJS
// helper imports the server from there (a single executable cannot import ES modules from disk). User data is in
// %APPDATA%\RumbleTracker.
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
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA = path.resolve(process.env.RUMBLE_DATA_DIR || path.join(ROAMING, 'RumbleTracker'));
const HOME = path.join(LOCAL, 'RumbleTracker'); // unpacked app and the window's WebView2 data
let APP_DIR = null; // this version's unpacked files (set by main)
let host = null; // server/host.mjs, loaded by main before the server starts

process.title = TITLE;

// Logging
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'tracker.log');
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
// and the name elsewhere as <user>.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOME_FOLDER = os.homedir();
const USER_NAME = (() => { try { return os.userInfo().username; } catch { return ''; } })();
function withoutUserName(line, home = HOME_FOLDER, user = USER_NAME) {
  let s = line;
  for (const h of home ? [home, home.replace(/\\/g, '/')] : []) s = s.replace(new RegExp(escapeRe(h), 'gi'), '~');
  if (user.length >= 3) s = s.replace(new RegExp(`\\b${escapeRe(user)}\\b`, 'gi'), '<user>');
  return s;
}
let logBytes = null; // bytes in the current log; read from disk on the first write
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...a) => {
    let line = withoutUserName(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' '));
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}… (${line.length - MAX_LINE} more characters)`;
    const text = `${new Date().toISOString()} ${line}\n`;
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
 * Shows a start-up error in a message box, then exits. With `rollback`, the new version failed to start right after an
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
  const script = 'Add-Type -AssemblyName System.Windows.Forms; '
    + "[void][System.Windows.Forms.MessageBox]::Show($env:RT_MSG, $env:RT_TITLE, 'OK', 'Warning')";
  execFile(POWERSHELL, psArgs(script), { windowsHide: true, env: { ...process.env, RT_MSG: message,
    RT_TITLE: TITLE } }, () => process.exit(1));
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
      RT_PROFILE: path.join(HOME, 'webview2'), RT_CACHE: path.join(APP_DIR, 'desktop', 'window-helpers.dll'),
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

// Starting up
// This tracker's repository, as its server names it; the browser-window tracker names its own.
const OWN_REPO = process.env.RUMBLE_ISSUES_REPO || 'razingo/rumble-tracker-ind';

/**
 * Port state: 'tracker' (this tracker already runs), 'edition' (the browser-window tracker runs, with the same data),
 * 'free' or 'other'.
 */
function probe(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/report', headers: { host: `localhost:${port}` }, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => {
        try {
          const { repo } = JSON.parse(body);
          resolve(!repo ? 'other' : repo === OWN_REPO ? 'tracker' : 'edition');
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

/**
 * A running tracker's port, else the first usable port: { running, port }. A running browser-window tracker is asked
 * to quit first, as two trackers on the same data would overwrite each other's changes.
 */
let stoppedEdition = false; // logged once this instance has its own log
async function findPort() {
  let states = await Promise.all(PORTS.map((p) => probe(p)));
  const running = PORTS.find((p, i) => states[i] === 'tracker');
  if (running) return { running: true, port: running };
  const editions = PORTS.filter((p, i) => states[i] === 'edition');
  if (editions.length) {
    await Promise.all(editions.map(stopEdition));
    stoppedEdition = true;
    states = await Promise.all(PORTS.map((p) => probe(p)));
  }
  for (const [i, p] of PORTS.entries()) if (states[i] === 'free' && await canListen(p)) return { running: false, port: p };
  return { running: false, port: null };
}

/**
 * Asks the browser-window tracker on `port` to quit and, if it agreed, waits up to 30 s until it has (it saves and
 * backs up first). Run from source, it can't be quit this way, so it's left running.
 */
async function stopEdition(port) {
  const agreed = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/quit', method: 'POST', timeout: 5000,
      headers: { host: `localhost:${port}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end('{}');
  });
  const until = Date.now() + 30000;
  while (agreed && Date.now() < until && await probe(port) === 'edition') await sleep(200);
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
 * (a plain detached child didn't survive that).
 */
function uninstall() {
  console.log('Uninstalling');
  spawn(path.join(SYSTEM32, 'cmd.exe'), ['/d', '/c', 'start', '""', '/b', POWERSHELL, ...psArgs(PS_RUN_FILE)], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, RT_SCRIPT: path.join(APP_DIR, 'desktop', 'uninstall.ps1'), RT_PARENT: String(process.pid),
      RT_EXE: process.execPath, RT_DATA: DATA, RT_HOME: HOME, RT_TITLE: TITLE },
  }).unref();
  quitFromTray('Uninstall from Settings');
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
    options: { port: PORT, dataDir: DATA },
    applyUpdate,
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
  if (afterUpdate) await waitForExit(afterUpdate.pid);
  if (!await claimPort()) return;
  rotateLog();
  if (stoppedEdition) console.log('The browser-window tracker was running; it was asked to quit, as both use the same data');
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
