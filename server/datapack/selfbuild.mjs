// A self-building tracker (an exe made with npm run build-selfbuilt) has no data pack: at its start it reads the game
// data from the Warcraft Rumble installed on this PC (tools/gamedata/build.mjs), the first time and again after each
// game patch. Meanwhile a page on the tracker's port shows a bar that fills with each finished step. What the player
// can fix (no game, no Python) is shown there and tried again every 15 seconds.
import http from 'node:http';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ISSUES_REPO } from '../report.mjs';
import { esc } from '../../web/scripts/lib/format.js';
import { APP_NAME, SECOND } from '../../web/scripts/lib/constants.js';

const RETRY_MS = 15 * SECOND;
const builderFile = (root) => path.join(root, 'tools', 'gamedata', 'build.mjs');

/** Whether this tracker reads its own game data: the self-built exe, or from source with RUMBLE_SELF_BUILD set. */
export async function selfBuilding(ctx) {
  if (!ctx.standalone && !process.env.RUMBLE_SELF_BUILD) return false;
  return !!(await stat(builderFile(ctx.paths.ROOT)).catch(() => null));
}

/** Builds the game data into the data folder if there is none or the game changed, behind the progress page. */
export async function selfBuild(ctx) {
  const { port, paths, errorLog } = ctx;
  const builder = await import(pathToFileURL(builderFile(paths.ROOT)).href);
  const where = { out: paths.GAMEDATA, work: path.join(paths.DATA, 'gamedata-build') };
  if (!builder.needsBuild(where)) return;

  const status = { done: 0, total: 0, label: '', error: null };
  const steps = () => (status.total
    ? `${status.done} of ${status.total} steps done${status.label ? ` · now: ${esc(status.label)}` : ''}` : 'Starting');
  const page = () => {
    const pct = status.total ? Math.round(status.done / status.total * 100) : 0;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="1">
<title>${APP_NAME}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#161a2e;color:#f3ead6;
  font:16px/1.5 system-ui,'Segoe UI',sans-serif">
<main style="width:min(560px,90vw);padding:24px;text-align:center"><h1 style="color:#ffe08a;font-size:24px">${APP_NAME}</h1>
${status.error ? `<p>${esc(status.error)}</p><p style="opacity:.7">Trying again every 15 seconds.</p>`
    : `<p>Reading the game data from your Warcraft Rumble install…</p>
<div style="height:16px;border-radius:8px;background:#2a3050;overflow:hidden">
<div style="height:100%;width:${pct}%;border-radius:8px;background:#f2c14e"></div></div>
<p style="opacity:.8">${steps()}</p>
<p style="opacity:.6;font-size:13px">This takes a minute or two, the first time and after a game patch.</p>`}</main></body></html>`;
  };
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const boot = http.createServer((req, res) => {
    if (!hosts.has(req.headers.host)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/api/report') { // answers the launcher's "is it running" check
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ repo: ISSUES_REPO, starting: true }));
      return;
    }
    res.writeHead(p === '/' ? 200 : 503, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(page());
  });
  await new Promise((resolve, reject) => {
    boot.once('error', reject);
    boot.listen(port, '127.0.0.1', resolve);
  });
  console.log('Building the game data from the game install');
  for (;;) {
    try {
      const r = await builder.buildGameData({ ...where, log: console.log,
        onStep: (done, total, label) => Object.assign(status, { done, total, label }) });
      console.log(`Game data built for ${r.gameBuild}: ${Object.keys(r.files).length} files`);
      break;
    } catch (e) {
      console.log(`Game data build failed: ${e.message}`);
      errorLog.add('game data build', e.message);
      status.error = e instanceof builder.BuildError ? e.message : `The game data could not be read (${e.message.split('\n')[0]}).`;
      await sleep(RETRY_MS);
      Object.assign(status, { done: 0, total: 0, label: '', error: null });
    }
  }
  await new Promise((resolve) => {
    boot.close(resolve);
    boot.closeAllConnections();
  });
}
