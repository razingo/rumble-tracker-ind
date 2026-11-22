// "Download now" in the update pop-up, in the exe only. It downloads and checks the release the signed data pack names
// (appupdate.mjs), has the launcher install it, then stops so the new version can start.
import { downloadUpdate } from './appupdate.mjs';
import { host } from '../host.mjs';

/** shutdown(reason) stops the tracker cleanly. Returns start(), which answers [status, body]. */
export function createUpdater(ctx, { shutdown, download = downloadUpdate, applyDelay = 1500 }) {
  const u = ctx.appUpdate;
  const fail = (message) => {
    console.log(`App update failed: ${message}`);
    ctx.errorLog.add('app update', message);
    Object.assign(u, { state: 'failed', error: message });
    ctx.bump();
  };

  return async function start() {
    const app = ctx.dataPack.latestApp;
    if (!app || app.version !== ctx.dataPack.newVersion) return [409, { error: 'No update to install.' }];
    if (u.state === 'downloading' || u.state === 'restarting') return [200, { ok: true }];
    Object.assign(u, { state: 'downloading', error: null, done: 0, total: 0 });
    ctx.bump();
    (async () => {
      try {
        console.log(`App update: downloading ${app.version}`);
        const exe = await download(app, ctx.paths.UPDATE, { onProgress: (done, total) => Object.assign(u, { done, total }) });
        u.state = 'restarting';
        ctx.bump();
        // A moment for the page to show it, then the launcher swaps the exe and this instance stops cleanly.
        await new Promise((r) => setTimeout(r, applyDelay));
        await host.applyUpdate({ exe, version: app.version });
        shutdown(`App update: restarting as ${app.version}`);
      } catch (e) {
        fail(e.message);
      }
    })();
    return [200, { ok: true }];
  };
}
