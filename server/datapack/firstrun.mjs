// The exe's first start. Game data isn't bundled, so the signed data pack is installed before the tracker starts. A
// progress page on the tracker's port refreshes itself meanwhile, and a failed download is retried every 30 seconds.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { updateDataPack } from './datapack.mjs';
import { ISSUES_REPO } from '../report.mjs';
import { esc } from '../../web/scripts/lib/format.js';
import { APP_NAME, RELEASES_URL, SECOND } from '../../web/scripts/lib/constants.js';

export async function firstRunDownload(ctx) {
  const { port, paths, dataPack, errorLog } = ctx;
  const status = { done: 0, total: 0, error: null };
  const page = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>${APP_NAME}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#161a2e;color:#f3ead6;
  font:16px/1.5 system-ui,'Segoe UI',sans-serif">
<main style="max-width:560px;padding:24px;text-align:center"><h1 style="color:#ffe08a;font-size:24px">${APP_NAME}</h1>
<p>${status.error ? esc(status.error)
    : `Downloading the game data (first start only)… ${status.total
      ? `${status.done} of ${status.total} files` : 'connecting'}`}</p></main></body></html>`;
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
  console.log(`First start: downloading game data from ${dataPack.url}`);
  for (;;) {
    try {
      const r = await updateDataPack({ base: dataPack.url, current: null, dir: paths.GAMEDATA, staticDir: paths.STATIC,
        onProgress: (done, total) => Object.assign(status, { done, total }) });
      if (!r.updated) throw new Error(r.reason);
      console.log(`Game data installed: ${r.reason} (${r.downloaded} files downloaded)`);
      break;
    } catch (e) {
      console.log(`Game data download failed: ${e.message}`);
      errorLog.add('data pack', e.message);
      status.error = e.code === 'BAD_SIGNATURE'
        ? `This version of the tracker cannot verify the current game data. Download the latest version from ${RELEASES_URL}`
        : `Could not download the game data (${e.message}). Check your internet connection; retrying in 30 seconds.`;
      await sleep(30 * SECOND);
      Object.assign(status, { done: 0, total: 0, error: null });
    }
  }
  await new Promise((resolve) => {
    boot.close(resolve);
    boot.closeAllConnections();
  });
}
