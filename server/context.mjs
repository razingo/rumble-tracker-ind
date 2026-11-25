// The server's shared state. Every module gets this one object, so the tests can build one from temporary folders.
import path from 'node:path';
import { createErrorLog } from './report.mjs';
import { readJson, isRecord } from './store.mjs';
import { DEFAULT_PORT } from '../web/scripts/lib/constants.js';

/**
 * `root` is the app folder (server/, web/, gamedata/) and `data` the user's data folder. Returns the context, to which
 * tables.mjs and userdata.mjs attach the tables and the user's data.
 */
export function createContext({ root, data, port = DEFAULT_PORT, standalone = false, appVersion = null }) {
  const errorLog = createErrorLog();
  let lastJob = Promise.resolve();
  const ctx = {
    paths: {
      ROOT: root,
      DATA: data,
      STATE: path.join(data, 'state'),         // scan snapshots per account
      PUBLIC: path.join(root, 'web'),
      GAMEDATA: path.join(data, 'gamedata'),   // game data read from the game install, served as /static/
      STATIC: path.join(root, 'gamedata'),     // the same from npm run build-gamedata, used where GAMEDATA has none
      UPDATE: path.join(data, 'update'),       // a downloaded app update
      BACKUPS: path.join(data, 'backups'),     // automatic backups
    },
    port, standalone, appVersion,
    // Recent errors for Report a problem, without personal details and kept in memory only.
    errorLog,
    // The revision of what the page shows. It starts from the clock, so a restarted server never repeats one.
    rev: Date.now(),
    bump() { ctx.rev++; },
    /**
     * Runs a heavy background job (reading the game data, the rdmodule's extraction) once the one before it is over,
     * so the PC never carries two of them. Resolves or rejects as the job does.
     */
    oneAtATime(job) {
      const run = lastJob.then(job);
      lastJob = run.catch(() => {});
      return run;
    },
    tables: null,
    user: null,
    accounts: new Map(), // account id -> { snapshot, events, lastChange, activeEvents, shop, pvp, … } (state/<id>.json)
    scan: { lastScan: null, lastError: null, lastErrorLog: null, gameBuild: null, scanning: false },
    // Reading the game data from the game install (gamedata.mjs): whether this tracker can, whether a read runs in
    // the background now (forTracker: because the tracker changed, not the game), and why the last one failed.
    gameData: { canBuild: false, reading: false, forTracker: false, error: null },
    // A newer version of the tracker (update/checker.mjs): newVersion, and latestApp with the checksums for
    // downloading it. An update in progress has a state: null, 'downloading', 'restarting' or 'failed'.
    appUpdate: { newVersion: null, latestApp: null, lastCheck: null, checkError: null,
      state: null, error: null, later: null, done: 0, total: 0 },
    official: false, // a released exe, which may replace itself with a newer release
    // Whether Warcraft Rumble runs, or null while that isn't known.
    game: { running: () => null },
    /**
     * Reads one of the player's files. A damaged file is moved aside and reported instead of stopping the tracker, and
     * so is one that holds something else than `shape(value)` passes (an object with named parts, unless given).
     */
    readUserJson: (p, fallback, shape = isRecord) => readJson(p, fallback, {
      shape,
      onCorrupt: (file, moved) => {
        const msg = `${path.basename(file)} was damaged and could not be read. It was moved to ${path.basename(moved)} `
          + 'and the tracker started without it. Restore a backup to get the data back.';
        console.log(msg);
        errorLog.add('data file', msg);
      },
    }),
  };
  return ctx;
}
