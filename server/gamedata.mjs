// The tracker reads its game data from the Warcraft Rumble installed on this PC (tools/gamedata/build.mjs).
//   The first time, there is nothing to show yet: a page on the tracker's port has a bar that fills with each finished
//   step, and the tracker starts when it is done. What the player can fix is shown there and tried again every 15
//   seconds; when the game is not found, the page asks for its folder (game/folder.mjs).
//   Later, it is read again when the installed game is another version than the one it was read from. After a new
//   version of the tracker, only the steps that changed are run again, and the ones after them whose input came out
//   different. Either happens in the background, at low priority, while the tracker shows what it has; the new data
//   takes the old one's place once it is whole, and the open page loads it.
// A build goes into a folder beside the data and replaces it at the end, so a failed one leaves the data as it was.
import http from 'node:http';
import path from 'node:path';
import { rm, cp, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ISSUES_REPO, briefError } from './report.mjs';
import { replaceFolder } from './store.mjs';
import { createGuard } from './guard.mjs';
import { givenGameFolder, setGameFolder } from './game/folder.mjs';
import { esc } from '../web/scripts/lib/format.js';
import { APP_NAME, SECOND, HOUR } from '../web/scripts/lib/constants.js';

const RETRY_MS = 15 * SECOND;
const AFTER_FAILURE_MS = HOUR; // a background read that failed is not tried again sooner
// What a failed read tells the player, where the reason is not one they can fix themselves: after a game patch, the
// game's files may be in a form this version of the tracker does not know yet.
const unread = (e) => `The game data could not be read (${briefError(e)}). If this started with a game patch, a newer `
  + 'version of the tracker may be able to read it.'; // (the first start's page; the banner has its own words)

/**
 * The game data's part of the tracker: firstRead() before the tables are loaded, check() whenever a newer game may be
 * there. `builder` is tools/gamedata/build.mjs (given by tests; an app folder without it, as in tests, builds nothing).
 * ctx.gameData tells the page what is going on: { canBuild, reading, forTracker, error }.
 */
export async function createGameData(ctx, { builder } = {}) {
  const { paths, errorLog } = ctx;
  builder ??= await import(pathToFileURL(path.join(paths.ROOT, 'tools', 'gamedata', 'build.mjs')).href).catch(() => null);
  const out = paths.GAMEDATA, stage = `${out}-new`, work = path.join(paths.DATA, 'gamedata-build');
  const status = ctx.gameData;
  status.canBuild = !!builder;
  const findGame = async () => builder.findGame(await givenGameFolder(ctx));
  let failedAt = 0;

  /**
   * Reads the game data from `game` and puts it in place. `due` is 'all', or the steps to run again (stepsDue): those
   * are run on a copy of the data there is.
   */
  async function build(game, due = 'all', onStep) {
    await rm(stage, { recursive: true, force: true });
    if (due !== 'all' && await stat(path.join(out, 'gamedata.json')).catch(() => null)) await cp(out, stage, { recursive: true });
    else due = 'all';
    const r = await builder.buildGameData({ game, out: stage, work, due, log: console.log, onStep });
    await replaceFolder(stage, out);
    console.log(`Game data read for ${r.gameBuild} (${r.steps.length} steps)`);
    return r;
  }

  /** The first read, behind the loading page. Returns at once when there is game data, or nothing to build it with. */
  async function firstRead() {
    if (!builder || await ctx.tables.hasGameData()) return;
    // noGame: the game was not found, so the page asks for its folder; folderError: what was wrong with the one given
    const page = { done: 0, total: 0, label: '', error: null, noGame: false, folderError: '' };
    let game = await findGame();
    let retryNow = () => {}; // cuts the wait before the next try short
    const steps = () => (page.total
      ? `${page.done} of ${page.total} steps done${page.label ? ` · now: ${esc(page.label)}` : ''}` : 'Starting');
    const html = () => {
      const pct = page.total ? Math.round(page.done / page.total * 100) : 0;
      // (the page with the folder's field does not reload by itself, or what is being typed would be lost)
      const ask = page.noGame ? `<form method="post" action="/game-folder" style="margin-top:20px">
<p style="margin:0 0 8px">If it is installed, give its folder (the one that holds WarcraftRumble.exe):</p>
<input name="dir" required autofocus placeholder="D:\\Games\\Warcraft Rumble" style="width:100%;box-sizing:border-box;padding:8px;
  border-radius:6px;border:1px solid #4a5280;background:#0f1224;color:#f3ead6;font:inherit">
${page.folderError ? `<p style="color:#ff9c8a">${esc(page.folderError)}</p>` : ''}
<p><button style="padding:8px 20px;border:0;border-radius:6px;background:#f2c14e;color:#3a2208;font:inherit;font-weight:600">Use this
folder</button> &nbsp; <a href="/" style="color:#f3ead6">Look again</a></p></form>` : '';
      return `<!doctype html><html lang="en"><head><meta charset="utf-8">${page.noGame ? '' : '<meta http-equiv="refresh" content="1">'}
<title>${APP_NAME}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#161a2e;color:#f3ead6;
  font:16px/1.5 system-ui,'Segoe UI',sans-serif">
<main style="width:min(560px,90vw);padding:24px;text-align:center"><h1 style="color:#ffe08a;font-size:24px">${APP_NAME}</h1>
${page.error ? `<p>${esc(page.error)}</p>${ask || '<p style="opacity:.7">Trying again every 15 seconds.</p>'}`
    : `<p>Reading the game data from your Warcraft Rumble install…</p>
<div style="height:16px;border-radius:8px;background:#2a3050;overflow:hidden">
<div style="height:100%;width:${pct}%;border-radius:8px;background:#f2c14e"></div></div>
<p style="opacity:.8">${steps()}</p>
<p style="opacity:.6;font-size:13px">This is only needed the first time and takes about a minute.</p>`}</main></body></html>`;
    };
    const refusal = createGuard(ctx.port);
    const boot = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://localhost').pathname;
      // (only this page's own address, and a form of this page only: another site's form carries another Origin)
      if (refusal(req, p)) {
        res.writeHead(403);
        res.end();
        return;
      }
      // the folder given on this page
      if (req.method === 'POST' && p === '/game-folder') {
        let body = '';
        req.on('data', (d) => { if (body.length < 4096) body += d; });
        req.on('end', async () => {
          try {
            game = await setGameFolder(ctx, new URLSearchParams(body).get('dir')) || await findGame();
            page.folderError = '';
            retryNow();
          } catch (e) {
            page.folderError = e.message;
          }
          res.writeHead(303, { location: '/' });
          res.end();
        });
        return;
      }
      if (p === '/api/report') { // answers the launcher's "is it running" check
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ repo: ISSUES_REPO, starting: true }));
        return;
      }
      res.writeHead(p === '/' ? 200 : 503, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      });
      res.end(html());
    });
    await new Promise((resolve, reject) => {
      boot.once('error', reject);
      boot.listen(ctx.port, '127.0.0.1', resolve);
    });
    console.log('First start: reading the game data from the game install');
    for (;;) {
      try {
        await build(game, 'all', (done, total, label) => Object.assign(page, { done, total, label }));
        break;
      } catch (e) {
        console.log(`Reading the game data failed: ${e.message}`);
        errorLog.add('game data', e.message);
        page.error = e instanceof builder.BuildError ? e.message : unread(e);
        page.noGame = !!e.needsFolder;
        const wait = new AbortController();
        retryNow = () => wait.abort();
        await sleep(RETRY_MS, null, { signal: wait.signal }).catch(() => {});
        if (page.noGame) game = await findGame();
        Object.assign(page, { done: 0, total: 0, label: '', error: null, noGame: false });
      }
    }
    await new Promise((resolve) => {
      boot.close(resolve);
      boot.closeAllConnections();
    });
  }

  /**
   * Reads the game data again in the background when the installed game is another version than the data's, or the
   * steps a new version of the tracker changed. One at a time: a check asked for while one runs joins it. Resolves
   * once the check, and the read it started, are over.
   */
  let checking = null, again = false;
  function check({ retry = false } = {}) {
    if (retry) {
      failedAt = 0; // something changed that a failed read may have wanted (the game's folder)
      again = !!checking; // (a check that runs now looked before the change: another follows it)
    }
    checking ??= run().finally(() => {
      checking = null;
      if (again) {
        again = false;
        check();
      }
    });
    return checking;
  }
  async function run() {
    if (!builder || Date.now() - failedAt < AFTER_FAILURE_MS) return;
    const game = await findGame();
    let due;
    try {
      due = builder.stepsDue(game, ctx.tables.gameData);
    } catch (e) {
      // (the game's version file can't be read while a patch rewrites it: the next check looks again)
      console.log(`Game data: the game's version could not be read (${e.message})`);
      return;
    }
    if (!due.length) return;
    // (the same game as the data's: it is the tracker that changed, whether it reads some steps anew or all of them.
    // Where the game is not found, there is no version to read: the build below says what is wrong.)
    let version = null;
    try {
      version = builder.gameVersion(game);
    } catch {
      // no game here
    }
    const sameGame = version !== null && ctx.tables.gameData?.gameBuild === version;
    Object.assign(status, { reading: true, forTracker: sameGame, error: null });
    ctx.bump();
    console.log(!sameGame ? `Game data: reading it for the game's version ${version ?? '(not found)'}`
      : `Game data: this version of the tracker reads ${due === 'all' ? 'all of it' : due.join(', ')} anew`);
    try {
      await build(game, due);
      await ctx.tables.load();
    } catch (e) {
      failedAt = Date.now();
      status.error = e instanceof builder.BuildError ? e.message : briefError(e);
      console.log(`Reading the game data failed: ${e.message}`);
      errorLog.add('game data', e.message);
    }
    Object.assign(status, { reading: false, forTracker: false });
    ctx.bump();
  }

  /** Forgets data that could not be loaded, so firstRead() reads it anew. */
  const discard = () => rm(out, { recursive: true, force: true });

  /** The game's folder in use, or '' when the game is not found. */
  const gameFolder = async () => (builder ? await findGame() || '' : '');

  return { firstRead, check, discard, gameFolder };
}
