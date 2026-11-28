// The tracker's server reads the game's save, keeps its history and serves the page on 127.0.0.1. From source, run
// npm start and open http://localhost:8765. This file starts the parts and runs their timers.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createContext } from './context.mjs';
import { host } from './host.mjs';
import { createTables } from './tables.mjs';
import { loadUserData } from './userdata.mjs';
import { readJson, flushWrites } from './store.mjs';
import { platform } from './platform/index.mjs';
import { createScanner } from './scan/scanner.mjs';
import { createGameData } from './gamedata.mjs';
import { createUpdateChecker } from './update/checker.mjs';
import { createUpdater } from './update/updater.mjs';
import { cleanUpdates } from './update/appupdate.mjs';
import { createNotifier } from './notifications/runner.mjs';
import { writeDailyBackup } from './backup.mjs';
import { createHttpServer } from './http/server.mjs';
import { DEFAULT_PORT, SECOND, MINUTE, DAY, SCAN_MS } from '../web/scripts/lib/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANS_AFTER_EXIT = 6; // the game may still write its save while closing
const NOTIFY_MS = 30 * SECOND;
const GAME_DATA_CHECK_MS = 30 * MINUTE; // whether the installed game is a newer version than the game data
const UPDATE_CHECK_MS = DAY;
const BACKUP_MS = DAY;
// In RumbleTracker.exe the launcher has already attached to host.mjs with its options. From source, environment
// variables and defaults apply.
const STANDALONE = host.attached;

const PACKAGE = await readJson(path.join(ROOT, 'package.json'), {}).catch(() => ({}));
const ctx = createContext({
  root: ROOT,
  data: path.resolve(host.options.dataDir || process.env.RUMBLE_DATA_DIR || path.join(ROOT, 'data')),
  port: Number(host.options.port || process.env.PORT || DEFAULT_PORT),
  standalone: STANDALONE,
  appVersion: PACKAGE.version || null,
});
// a released exe (tools/build-release.mjs marks the ones GitHub builds) may replace itself with a newer release
ctx.official = STANDALONE && PACKAGE.official === true;
process.on('unhandledRejection', (e) => {
  console.log(`Unexpected error: ${e?.message || e}`);
  ctx.errorLog.add('server', e?.stack || String(e));
});
await mkdir(ctx.paths.STATE, { recursive: true });

// Game data, read from the game install: the first time behind a loading page, later in the background (gamedata.mjs)
ctx.tables = createTables(ctx.paths);
const gameData = await createGameData(ctx);
await gameData.firstRead();
if (!(await ctx.tables.hasGameData())) {
  console.error(`No game data in ${ctx.paths.GAMEDATA}, and nothing here to read it from the game with.`);
  process.exit(1);
}
try {
  await ctx.tables.load();
} catch (e) {
  // What was read is damaged: it is read anew.
  console.log(`The game data could not be loaded (${e.message}); reading it again`);
  ctx.errorLog.add('game data', e.message);
  await gameData.discard();
  await gameData.firstRead();
  await ctx.tables.load();
}

// The user's data
ctx.user = await loadUserData(ctx);

// Reading the save
// The save only changes while Warcraft Rumble runs, so it is read every SCAN_MS then, a few more times after the
// game closes, and not at all otherwise. While it isn't known whether the game runs, it is read all the time.
const { scan } = createScanner(ctx, { readPrefs: platform.readSave });
let scansLeft = 0;
let stopping = false;
const onGame = (running) => {
  console.log(running ? 'Warcraft Rumble started: reading the save' : 'Warcraft Rumble closed: reading paused');
  if (running) scan();
  else {
    scansLeft = SCANS_AFTER_EXIT;
    gameData.check(); // the game may have been patched before this session
  }
  ctx.bump();
};
const onGameWatchFailed = (message) => {
  console.log(`Game check: ${message}; reading the save all the time`);
  ctx.errorLog.add('game check', message);
};
// In the exe the tray icon's process reports whether the game runs.
ctx.game = STANDALONE ? platform.watchGameFromTray(onGame, onGameWatchFailed) : platform.watchGame(onGame, onGameWatchFailed);
const gameRunning = async () => ctx.game.running() ?? platform.gameRunningOnce();

// Automatic backups, at start, every 24 hours and when the tracker stops. They pause when a data file was damaged at
// start, so the damage can't replace the last good backup of the day.
const backupsPaused = ctx.errorLog.list().some((e) => e.source === 'data file');
if (backupsPaused) console.log('Automatic backups paused: a data file was damaged at start');
async function autoBackup() {
  if (backupsPaused) return null;
  try {
    const file = await writeDailyBackup(ctx.paths.BACKUPS, ctx.user.backupFiles());
    console.log(`Backup: ${path.basename(file)}`);
    return file;
  } catch (e) {
    console.log(`Backup failed: ${e.message}`);
    ctx.errorLog.add('backup', e.message);
    return null;
  }
}

// Stopping, for Quit on the page or in the tray, Windows shutting down, or an app update.
/** Stops once a running scan and every queued write are done, after writing today's backup (at most 15 s). */
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(reason);
  const deadline = Date.now() + 15 * SECOND;
  const left = () => sleep(Math.max(0, deadline - Date.now()));
  while (ctx.scan.scanning && Date.now() < deadline) await sleep(100);
  await Promise.race([autoBackup(), left()]);
  await Promise.race([flushWrites(), left()]);
  process.exit(code);
}
host.onQuit((reason) => shutdown(reason));
if (!STANDALONE) for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(`Stopped (${sig})`));

// Notifications, app updates
const notifier = createNotifier(ctx, { gameRunning });
const notify = () => notifier.tick().catch((e) => {
  console.log(`Notifications: ${e.message}`);
  ctx.errorLog.add('notifications', e.message);
});
const checkForUpdate = createUpdateChecker(ctx, { onNews: notify });
const startUpdate = createUpdater(ctx, { shutdown });
cleanUpdates(ctx.paths.UPDATE); // a download the launcher already copied into place

// Start with Windows, in the exe only. The Run key always names the exe that is running.
const autostart = STANDALONE && platform.autostart ? {
  get: async () => (await platform.autostart.read()) === platform.autostart.command(process.execPath),
  set: (on) => platform.autostart.set(on, process.execPath),
} : null;
if (autostart) {
  platform.autostart.refresh(process.execPath).catch((e) => {
    console.log(`Start with Windows: ${e.message}`);
    ctx.errorLog.add('start with Windows', e.message);
  });
}

// Start
await scan();
autoBackup();
setInterval(autoBackup, BACKUP_MS);
setInterval(() => {
  if (stopping) return;
  if (ctx.game.running() === false) {
    if (scansLeft <= 0) return;
    scansLeft--;
  }
  scan();
}, SCAN_MS);
setInterval(notify, NOTIFY_MS);
notify();
checkForUpdate();
setInterval(checkForUpdate, UPDATE_CHECK_MS);
gameData.check();
setInterval(() => gameData.check(), GAME_DATA_CHECK_MS);

// Closing the window keeps the tracker running in the tray, or quits it when that's the setting. With "Ask me" the page
// asked and saved the answer before the window closed (web/scripts/closing.js); without an answer it stays in the tray.
if (STANDALONE) host.onWindowClosed(() => { if (ctx.user.appSettings.closeWindow === 'quit') shutdown('Window closed'); });

const server = createHttpServer(ctx, { shutdown, startUpdate, checkForUpdate, notifier, gameRunning, autostart, gameData });
server.listen(ctx.port, '127.0.0.1', () => {
  console.log(`Rumble Collection Tracker running at http://localhost:${ctx.port}`);
  console.log(`Data folder: ${ctx.paths.DATA}`);
  // Only the count, as account names are chosen by the player and the log may be attached to bug reports.
  console.log(`Accounts found: ${ctx.accounts.size}${ctx.scan.lastErrorLog ? ` (error: ${ctx.scan.lastErrorLog})` : ''}`);
});
