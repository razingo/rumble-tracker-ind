// Looks for a newer version of the tracker: the latest release of its repository on GitHub, asked for at start and
// once a day, unless that is turned off in Settings. The only thing sent is the request itself. A newer version shows
// the update pop-up (and one notification); what it found is kept in ctx.appUpdate as newVersion and latestApp.
import { latestRelease } from './appupdate.mjs';
import { compareVersions } from '../game/model.mjs';

/** onNews() runs when a newer version is first seen. Returns check(): it runs one check, or joins the one running. */
export function createUpdateChecker(ctx, { onNews = () => {}, latest = latestRelease } = {}) {
  const u = ctx.appUpdate;
  let running = null;

  async function run() {
    if (!ctx.user.appSettings.checkUpdates) {
      if (u.newVersion) {
        Object.assign(u, { newVersion: null, latestApp: null });
        ctx.bump();
      }
      return;
    }
    u.lastCheck = new Date().toISOString();
    try {
      const release = await latest();
      const newer = ctx.appVersion && compareVersions(release.version, ctx.appVersion) > 0;
      const newVersion = newer ? release.version : null;
      const latestApp = newer ? release.app : null;
      u.checkError = null;
      if (newVersion === u.newVersion && JSON.stringify(latestApp) === JSON.stringify(u.latestApp)) return;
      const first = newVersion && newVersion !== u.newVersion;
      Object.assign(u, { newVersion, latestApp });
      ctx.bump();
      if (first) onNews();
    } catch (e) {
      // (offline, or GitHub not answering: nothing to tell the player, the next check tries again)
      u.checkError = e.message;
      console.log(`Update check failed: ${e.message}`);
    }
  }

  return function check() {
    running ??= run().finally(() => { running = null; });
    return running;
  };
}
