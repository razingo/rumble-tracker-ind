// The API: one handler per "METHOD /path", each returning [status, body] and optionally extra headers. The routes
// that act on the exe (quitting, updates, screenshots, showing the window, uninstalling) exist only when the server
// runs inside it.
import { buildBackup, listDailyBackups, readDailyBackup, backupFileName } from '../backup.mjs';
import { NOTIFY_TYPES } from '../notifications/notify.mjs';
import { ISSUES_REPO, diagnostics } from '../report.mjs';
import { buildState, liveState, resolveAccount, dataStale } from '../state.mjs';
import { createHandlers, armoryFile } from './handlers.mjs';
import { host } from '../host.mjs';
import { givenGameFolder, setGameFolder } from '../game/folder.mjs';
import { noteMove } from '../storage.mjs';
import { isRecord } from '../store.mjs';
import { EXPLORER } from '../system.mjs';
import { execFile } from 'node:child_process';
import { MINUTE, MB, CLOSE_CHOICES } from '../../web/scripts/lib/constants.js';
import { localDay } from '../../web/scripts/lib/format.js';

const CHECK_AGAIN_MS = 5 * MINUTE; // a check for a new version asked for by the page, at the soonest

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('The request is too large for the tracker to accept.'), { status: 413 });
    chunks.push(c);
  }
  const invalid = () => Object.assign(new Error('The request is not valid JSON.'), { status: 400 });
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw invalid();
  }
  // (every handler reads named parts: a list, a number or null is not a request)
  if (!isRecord(body)) throw invalid();
  return body;
}

/** Allows `n` calls per `ms` milliseconds; allow() is false for the rest of that time. */
const rateLimit = (n, ms) => ({
  n: 0,
  since: Date.now(),
  allow() {
    if (Date.now() - this.since > ms) {
      this.n = 0;
      this.since = Date.now();
    }
    return ++this.n <= n;
  },
});

/**
 * deps: { shutdown(reason), startUpdate(), checkForUpdate(), notifier: { test }, gameRunning(),
 *   autostart: { get(), set(on) } | null, gameData: { check(), gameFolder() } }.
 * The ones a test leaves out are not used by what it tests.
 * Returns a Map of "METHOD /path" to handler(req, url).
 */
export function createRoutes(ctx, deps) {
  const h = createHandlers(ctx);
  // at most 20 page error reports a minute
  const clientErrors = rateLimit(20, MINUTE);
  const json = (handler, limit) => async (req) => handler(await readBody(req, limit));
  // Start with Windows and what closing the window does; null where they don't apply (running from source)
  const settings = async () => ({
    startWithWindows: deps.autostart ? await deps.autostart.get() : null,
    closeWindow: ctx.standalone ? ctx.user.appSettings.closeWindow : null,
    checkUpdates: ctx.user.appSettings.checkUpdates,
    // when a newer version was last looked for, and why that failed if it did
    lastUpdateCheck: ctx.appUpdate.lastCheck, updateCheckError: ctx.appUpdate.checkError,
    // the game's folder given by hand ('' when none), and the one in use ('' when the game is not found)
    gameFolder: await givenGameFolder(ctx),
    gameFolderUsed: await deps.gameData?.gameFolder() || '',
    // the folder the tracker keeps its files in (null where there is no choice: from source)
    storageFolder: host.options.storage?.folder || null,
  });

  // "METHOD /path" to a handler(req, url) that returns [status, body]
  const routes = new Map(Object.entries({
    // The page sends the revision it has. If nothing changed, only the values that change on their own are sent.
    'GET /api/state': async (req, url) => {
      const account = resolveAccount(ctx, url.searchParams.get('account'));
      if (url.searchParams.get('rev') === String(ctx.rev) && url.searchParams.get('for') === String(account)) {
        return [200, { unchanged: true, rev: ctx.rev, ...liveState(ctx) }];
      }
      return [200, buildState(ctx, account)];
    },
    'GET /api/backup': async () => [200, JSON.stringify(buildBackup(ctx.user.backupFiles()), null, 2),
      { 'content-disposition': `attachment; filename="${backupFileName(localDay())}"` }],
    'POST /api/name': json(h.name),
    'POST /api/talents': json(h.talents),
    'POST /api/army': json(h.army),
    'POST /api/plans': json(h.plan),
    'POST /api/draft': json(h.draft),
    'POST /api/armies': json(h.armies),
    'POST /api/pvp/result': json(h.pvpResult),
    'POST /api/restore': json(h.restore, 20 * MB),
    // One account's saved armies as a file, and adding the armies of such a file.
    'GET /api/armory': async (req, url) => {
      const account = resolveAccount(ctx, url.searchParams.get('account'));
      return [200, JSON.stringify(armoryFile((account && ctx.user.armies[account]) || []), null, 2),
        { 'content-disposition': `attachment; filename="rumble-armory-${localDay()}.json"` }];
    },
    'POST /api/armory/import': json(h.importArmory, MB),
    // The automatic backups, and restoring one of them.
    'GET /api/backups': async () => [200, { backups: await listDailyBackups(ctx.paths.BACKUPS) }],
    'POST /api/backups/restore': async (req) => {
      const backup = await readDailyBackup(ctx.paths.BACKUPS, (await readBody(req)).day);
      if (!backup) return [404, { error: 'That backup is not there any more.' }];
      return h.restore({ backup });
    },
    'GET /api/notifications': async () => {
      const { notifySettings, sentLog } = ctx.user;
      return [200, { settings: notifySettings, types: NOTIFY_TYPES, log: sentLog.log.slice(-20).reverse(),
        pending: sentLog.pending.length, playing: await deps.gameRunning() }];
    },
    'POST /api/notifications': async (req) => {
      const { settings } = await readBody(req);
      // (without them, every setting would go back to what it is at first)
      if (!isRecord(settings)) return [400, { error: 'The notification settings were not sent. Reload the page and try again.' }];
      await ctx.user.setNotifySettings(settings);
      return [200, { ok: true, settings: ctx.user.notifySettings }];
    },
    'POST /api/notifications/test': async () => {
      const ok = await deps.notifier.test();
      return ok ? [200, { ok: true }] : [500, { error: 'Windows did not accept the notification.' }];
    },
    // Start with Windows and what closing the window does, null where they don't apply.
    'GET /api/settings': async () => [200, await settings()],
    'POST /api/settings': async (req) => {
      const b = await readBody(req);
      if (typeof b.startWithWindows === 'boolean') {
        if (!deps.autostart) return [400, { error: 'Only the RumbleTracker.exe version can start with Windows.' }];
        if (!(await deps.autostart.set(b.startWithWindows))) return [500, { error: 'Windows did not accept the change.' }];
      }
      if (typeof b.checkUpdates === 'boolean') {
        await ctx.user.setAppSetting('checkUpdates', b.checkUpdates);
        deps.checkForUpdate?.();
      }
      if (b.gameFolder !== undefined) {
        try {
          await setGameFolder(ctx, b.gameFolder);
        } catch (e) {
          return [400, { error: e.message }];
        }
        deps.gameData?.check({ retry: true }); // the game there may be another version than the data's
      }
      if (b.closeWindow !== undefined) {
        if (!ctx.standalone) return [400, { error: 'Closing the window only matters in the RumbleTracker.exe version.' }];
        if (!Object.hasOwn(CLOSE_CHOICES, b.closeWindow)) return [400, { error: 'That is not a choice for closing the window.' }];
        await ctx.user.setAppSetting('closeWindow', b.closeWindow);
      }
      return [200, { ok: true, ...(await settings()) }];
    },
    // The open-folder buttons in Settings: shows the tracker's own folder or the game's in Explorer.
    'POST /api/open-folder': async (req) => {
      const { which } = await readBody(req);
      const folder = which === 'storage' ? host.options.storage?.folder : which === 'game' ? await deps.gameData?.gameFolder() : null;
      if (!folder) return [400, { error: 'There is no such folder to open.' }];
      execFile(EXPLORER, [folder], () => {});
      return [200, { ok: true }];
    },
    // Script errors reported by the page, for "Report a problem".
    'POST /api/client-error': async (req) => {
      const b = await readBody(req, 8 * 1024);
      if (clientErrors.allow()) ctx.errorLog.add(`page${b.where ? ` ${String(b.where).slice(0, 20)}` : ''}`,
        `${b.message || ''}${b.stack ? `\n${b.stack}` : ''}`);
      return [200, { ok: true }];
    },
    // Diagnostics shown before opening an issue (already cleaned).
    'GET /api/report': async (req, url) => {
      const t = ctx.tables;
      const text = diagnostics({
        appVersion: ctx.appVersion, gameBuild: ctx.scan.gameBuild, accounts: ctx.accounts.size, errors: ctx.errorLog.list(),
        data: {
          dataBuild: t.gameData?.gameBuild, dataVersion: t.gameData?.dataVersion, stale: dataStale(ctx),
          readError: ctx.gameData.error,
        },
        page: url.searchParams.get('page'),
      });
      return [200, { repo: ISSUES_REPO, appVersion: ctx.appVersion, diagnostics: text, errors: ctx.errorLog.list().length }];
    },
    'POST /api/report/clear': async () => {
      ctx.errorLog.clear();
      ctx.bump();
      return [200, { ok: true }];
    },
    // The page asks for this when its window comes into view, so a tracker that sat in the tray for hours learns of
    // a new version when someone looks at it. Not more often than every few minutes.
    'POST /api/update/check': async () => {
      const last = Date.parse(ctx.appUpdate.lastCheck || '') || 0;
      if (Date.now() - last > CHECK_AGAIN_MS) await deps.checkForUpdate?.();
      return [200, { ok: true }];
    },
    // Later in the update pop-up hides it until the tracker restarts.
    'POST /api/update/later': async () => {
      ctx.appUpdate.later = ctx.appUpdate.newVersion;
      ctx.bump();
      return [200, { ok: true }];
    },
  }));
  if (ctx.standalone) {
    // Take a screenshot in Report a problem opens Windows' snipping overlay, which copies the capture.
    routes.set('POST /api/screenshot', async () => {
      host.takeScreenshot();
      return [200, { ok: true }];
    });
    routes.set('POST /api/quit', async () => {
      setTimeout(() => deps.shutdown('Quit from the page'), 200);
      return [200, { ok: true }];
    });
    routes.set('POST /api/update', async () => deps.startUpdate());
    // The tracker's folder in Settings: the move is noted, then the tracker restarts and moves its files
    routes.set('POST /api/storage', async (req) => {
      const { folder } = await readBody(req);
      if (!host.options.storage) return [400, { error: 'This tracker\'s folder is set where it was started.' }];
      if (ctx.gameData.reading) return [400, { error: 'The game data is being read. Move the files once that is done.' }];
      let home;
      try {
        home = await noteMove(host.options.storage, folder);
      } catch (e) {
        return [400, { error: e.message }];
      }
      setTimeout(() => host.restart(), 200);
      return [200, { ok: true, folder: home }];
    });
    // Uninstall in Settings: after the answer reaches the page, the tracker stops and removes itself
    routes.set('POST /api/uninstall', async () => {
      setTimeout(() => host.uninstall(), 200);
      return [200, { ok: true }];
    });
    // the exe started again, or a notification was clicked: the running tracker shows its window
    routes.set('POST /api/show-window', async () => {
      host.showWindow();
      return [200, { ok: true }];
    });
  }
  return routes;
}
