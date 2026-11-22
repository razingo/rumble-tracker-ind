// Data-pack checks run at start, every 6 hours, and 15 minutes after a signature failure, one at a time since they
// share the staging folder. Two signature failures in a row mean the packs are signed with a key this version doesn't
// know, so the page asks for the current version. A verified pack clears that.
import { updateDataPack } from './datapack.mjs';
import { compareVersions } from '../game/model.mjs';
import { latestAppOf } from '../update/appupdate.mjs';
import { MINUTE } from '../../web/scripts/lib/constants.js';

const RECHECK_MS = 15 * MINUTE;

/** onNews() runs when there is something to tell the player. */
export function createPackChecker(ctx, { onNews = () => {}, update = updateDataPack } = {}) {
  const dp = ctx.dataPack;
  let running = null;

  async function run() {
    if (!dp.url) return;
    dp.lastCheck = new Date().toISOString();
    try {
      const r = await update({ base: dp.url, current: ctx.tables.gameData, dir: ctx.paths.GAMEDATA, staticDir: ctx.paths.STATIC });
      Object.assign(dp, { result: r.reason, error: null, badSignatures: 0 });
      if (dp.needsAppUpdate) {
        dp.needsAppUpdate = false;
        ctx.bump();
      }
      const newVersion = r.latestAppVersion && ctx.appVersion && compareVersions(r.latestAppVersion, ctx.appVersion) > 0
        ? r.latestAppVersion : null;
      if (newVersion !== dp.newVersion) {
        dp.newVersion = newVersion;
        ctx.bump();
        if (newVersion) onNews();
      }
      const latestApp = newVersion ? latestAppOf(r.latestApp) : null;
      if (JSON.stringify(latestApp) !== JSON.stringify(dp.latestApp)) {
        dp.latestApp = latestApp;
        ctx.bump();
      }
      if (r.updated) {
        await ctx.tables.load();
        ctx.bump();
        console.log(`Data pack: ${r.reason} (${r.downloaded} files downloaded)`);
      }
    } catch (e) {
      dp.error = e.message;
      console.log(`Data pack check failed: ${e.message}`);
      ctx.errorLog.add('data pack', e.message);
      if (e.code === 'BAD_SIGNATURE') {
        dp.badSignatures++;
        if (dp.badSignatures === 1) setTimeout(check, RECHECK_MS).unref?.();
        else if (!dp.needsAppUpdate) {
          dp.needsAppUpdate = true;
          ctx.bump();
          onNews();
        }
      }
    }
  }

  /** Runs a check, or joins the one running. */
  function check() {
    running ??= run().finally(() => { running = null; });
    return running;
  }
  return check;
}
