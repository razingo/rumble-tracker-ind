// Extracts the additional data: what the rdmodule, the page behind the tracker's hidden key sequence, draws and plays,
// from the Warcraft Rumble installed on this PC: the units' sprites (rendered from their 3D models and animations),
// effect sprites, backdrops and sounds. (Its menu art is part of the tracker's own game data.) The tracker runs it in
// the background when asked in Settings (server/rdmodule.mjs). The game's files are only read.
//
// The steps, of which those that do not wait for each other run side by side:
//   exports (Python, as for the game data): the towers' models, the units' rigged models with their animations, the
//     effects, the sounds (Wwise, decoded by vgmstream), the map the backdrops are drawn from; then one catalog of what
//     each unit's attack plays;
//   pictures: the render pages (render/) draw the sprites with three.js in a WebView2 window nobody sees
//     (desktop/render.ps1) and post each picture back to a small server here;
//   sounds: only the ones the rdmodule uses are decoded, then picked.
// Only what render/sprites.json names is exported. The exports (about 1 GB) are deleted once the pictures are drawn.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, copyFile, rename } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, normalize, extname, sep } from 'node:path';
import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BuildError, findGame, python, runProgram, runScript, runSteps } from '../gamedata/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PAGES = join(HERE, 'render');
const VENDOR = join(HERE, 'vendor');
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const RENDER_MINUTES = 30; // a render page that hasn't finished by then has failed
const READY = 'ready.json';
// The slow exports are each split over a few processes (RUMBLE_SHARD in the scripts). Each of those holds dozens of
// the game's files in memory at a time, so there are few of them, by the PC's memory, and one kind of export runs
// after the other: more at once fills the memory and keeps the disk busy to no gain. Reading the indexes is light
// and takes more processes.
const CORES = availableParallelism();
const SHARDS = Math.max(1, Math.min(4, Math.floor(CORES / 4), Math.floor(totalmem() / 2 ** 30 / 12)));
const INDEX_SHARDS = Math.max(2, Math.min(4, Math.floor(CORES / 3)));
const AT_ONCE = Math.max(3, Math.min(12, CORES - 2));
// Units whose skeletons have no animations of their own take them from these, which are exported for that.
const DONORS = ['thaurissan', 'whelpeggs'];

/** Whether the extraction's own tools are here (npm run fetch-rdmodule-tools; a self-built exe carries them). */
export const canExtract = () => existsSync(join(VENDOR, 'three', 'build', 'three.module.js'))
  && existsSync(join(VENDOR, 'vgmstream', 'vgmstream-cli.exe')) && existsSync(join(ROOT, 'desktop', 'webview2'));
/** Whether `out` holds a finished extraction. */
export const extracted = (out) => existsSync(join(out, READY));

const alt = (names) => `^(${[...new Set(names)].filter(Boolean).join('|')})$`;
/** What to export, from the sprites the game has (render/sprites.json): regular expressions for each export. */
function wanted(config) {
  const sprites = Object.values(config.sprites);
  const units = sprites.flatMap((s) => [s.unit, s.file?.split('__')[0]]);
  return {
    models: alt(sprites.flatMap((s) => [s.structure, s.model])),
    units: alt(units),
    animations: alt([...units, ...DONORS]),
    effects: alt([...units, ...Object.values(config.effects).map((e) => e.unit)]),
    maps: alt(Object.values(config.backdrops).map((b) => b.scene)),
  };
}

// ---- the render pages --------------------------------------------------------------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.obj': 'text/plain', '.mtl': 'text/plain', '.glb': 'model/gltf-binary' };
const inside = (root, p) => { const f = normalize(join(root, p)); return f.startsWith(normalize(root) + sep) ? f : null; };
// three.js from here instead of the web; a page says in its title when it is done, or that it failed
const local = (page) => page
  .replaceAll('https://cdn.jsdelivr.net/npm/three@0.160.0/', '/three/')
  .replaceAll('window.__done = true;', `window.__done = true;
  await fetch('/save/log-' + (location.pathname + location.search).replace(/\\W+/g, '-') + '.json', { method: 'POST',
    body: JSON.stringify(window.__log || document.getElementById('log')?.textContent || '') }).catch(() => {});
  document.title = 'DONE';`)
  .replace('<script type="module">', `<script>
addEventListener('error', (e) => { document.title = 'FAILED ' + (e.message || 'script error'); });
addEventListener('unhandledrejection', (e) => { if (!window.__done) document.title = 'FAILED ' + (e.reason?.message || e.reason); });
</script>
<script type="module">`);
/** The effects viewer with the capture added, a black background and no grid. */
async function capturePage() {
  let page = await readFile(join(PAGES, 'effects.html'), 'utf8');
  const swap = (a, b) => { if (!page.includes(a)) throw new Error(`effects.html has no "${a}"`); page = page.replace(a, () => b); };
  swap('scene.background = new THREE.Color(0x202228);', 'scene.background = new THREE.Color(0x000000);');
  swap('scene.add(new THREE.GridHelper(20, 20, 0x4a4f5a, 0x30343c));', '');
  swap('window.__ready = true;', `${await readFile(join(PAGES, 'effects_capture.js'), 'utf8')}\nwindow.__ready = true;`);
  return local(page);
}
/** Serves the render pages and the exports to them, and saves the pictures they post. Resolves with the server. */
function renderServer(work, sprites) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // only this machine's own pages may use it
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); res.end(); return; }
    try {
      if (req.method === 'POST' && url.pathname.startsWith('/save/')) {
        const name = url.pathname.slice(6);
        if (!/^[\w-]+\.(png|json)$/.test(name)) { res.writeHead(400); res.end(); return; }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        await writeFile(join(name.startsWith('log-') ? work : sprites, name), Buffer.concat(chunks));
        res.writeHead(204); res.end(); return;
      }
      const p = decodeURIComponent(url.pathname).slice(1);
      let body = null, file = null;
      if (p === 'render.html') body = local(await readFile(join(PAGES, 'render.html'), 'utf8'));
      else if (p === 'fx/effects.html') body = await capturePage();
      else if (p === 'sprites.json') file = join(work, 'sprites.json');
      else if (/^(models|animations|maps)\//.test(p)) file = inside(work, p);
      else if (p.startsWith('sprites/')) file = inside(sprites, p.slice(8));
      else if (p.startsWith('three/')) file = inside(join(VENDOR, 'three'), p.slice(6));
      else if (p.startsWith('fx/')) file = inside(join(work, 'effects'), p.slice(3));
      if (body === null && !file) { res.writeHead(404); res.end(); return; }
      body ??= await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file || p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
/** Loads a page in the unseen window and waits for it to finish. */
function renderPage(url, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command',
      '. ([ScriptBlock]::Create([IO.File]::ReadAllText($env:RT_SCRIPT)))'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RT_SCRIPT: join(ROOT, 'desktop', 'render.ps1'), RT_URL: url, RT_LIB: join(ROOT, 'desktop', 'webview2'),
        RT_PROFILE: profile, RT_PARENT: String(process.pid) },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\nfailed it did not finish in time'; child.kill(); }, RENDER_MINUTES * 60000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const failed = /^(?:failed|title FAILED) (.*)$/m.exec(out);
      if (code === 0 && !failed) resolve([]);
      else reject(new Error(`The pictures could not be drawn (${failed?.[1] || out.trim().split(/\r?\n/).pop() || `exit ${code}`}).`));
    });
  });
}

/**
 * Extracts into `out` (sprites/, sounds/), with the exports in `work`, which is emptied afterwards. `gamedata` is
 * the tracker's game data folder (its minis table is read), `gameFolder` the game's folder when it was given by hand.
 * onStep(done, total, label) as in runSteps.
 * Rejects with a BuildError for what the player can fix.
 */
export async function extractRdmodule({ gameFolder = '', gamedata, out, work, onStep = () => {}, log = () => {} }) {
  const game = findGame(gameFolder);
  if (!game) throw new BuildError('Warcraft Rumble was not found on this PC.');
  if (!canExtract()) throw new BuildError('This tracker was built without the tools the extraction needs.');
  // built beside the last extraction, which it replaces only when it is whole
  const stage = `${out}-new`;
  const sprites = join(stage, 'sprites'), sounds = join(stage, 'sounds');
  await rm(stage, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  for (const d of [sprites, sounds, join(work, 'gamedata')]) await mkdir(d, { recursive: true });
  await copyFile(join(gamedata, 'minis.json'), join(work, 'gamedata', 'minis.json'));
  await copyFile(join(PAGES, 'sprites.json'), join(work, 'sprites.json'));
  const want = wanted(JSON.parse(readFileSync(join(work, 'sprites.json'), 'utf8')));
  const env = { ...process.env, RUMBLE_WORK: work, RUMBLE_GAMEDATA: gamedata,
    RUMBLE_BUNDLES: join(game, 'Data', 'StreamingAssets', 'Bundles'),
    RUMBLE_AUDIO: join(game, 'Data', 'StreamingAssets', 'Audio', 'GeneratedSoundBanks', 'Windows'),
    RUMBLE_VGMSTREAM: join(VENDOR, 'vgmstream', 'vgmstream-cli.exe'), RUMBLE_SOUND_LANGUAGES: 'sfx,en-US',
    RDMODULE_SPRITES: sprites, RDMODULE_SOUNDS: sounds };
  let py = null;
  const quiet = { background: true }; // everything here runs at low priority
  const exportWith = (script, ...a) => () => runProgram(py, ['-I', join(HERE, script), ...a], env, quiet);
  const script = (file, ...a) => () => runScript(join(HERE, file), a, env);
  // Sounds: the index of all of them comes first (the effects and the catalog name sounds by it); only the files the
  // picker then asks for are decoded.
  const soundList = join(work, 'sound_files.json');
  const decode = (files) => () => runProgram(py, ['-I', join(HERE, 'export_sounds.py'), join(work, 'sounds')],
    { ...env, RUMBLE_SOUND_FILES: files }, quiet);
  const server = await renderServer(work, sprites);
  const page = (path, name) => () => renderPage(`http://127.0.0.1:${server.address().port}/${path}`, join(work, `webview2-${name}`));
  try {
    // A slow export split over SHARDS processes, then its parts put together: the steps for it.
    // (build_indexes.py takes its share as an argument, the others from RUMBLE_SHARD)
    const split = (name, needs, n, script, ...a) => {
      const part = (shard) => () => runProgram(py, ['-I', join(HERE, script), ...(a.length ? a : [shard])],
        { ...env, RUMBLE_SHARD: shard }, quiet);
      const parts = Array.from({ length: n }, (_, k) => [`${name} ${k + 1}/${n}`, needs, part(`${k}/${n}`)]);
      return [...parts, [name, parts.map((p) => p[0]), part('merge')]];
    };
    const lines = await runSteps([
      ['Python', [], async () => { py = await python(work, log); return []; }],
      ['List of minis', [], script('all_minis.mjs', join(work, 'all_mini_definitions.json'))],
      ['Index of the sounds', ['Python', 'List of minis'], decode('none')],
      // the indexes of the game's files that all the other exports read, built once
      ...split('Index of the game files', ['Python', 'List of minis'], INDEX_SHARDS, 'build_indexes.py'),
      ['Tower models', ['Index of the game files'], exportWith('export_models.py', join(work, 'models'), want.models)],
      ['Map', ['Index of the game files'], exportWith('export_maps.py', join(work, 'maps'), want.maps)],
      // (one kind after the other: see SHARDS)
      ...split('Animations', ['Tower models', 'Map'], SHARDS, 'export_animations.py', join(work, 'animations'), want.animations),
      ...split('Effects', ['Tower models', 'Map', 'Index of the sounds'], SHARDS, 'export_effects.py', join(work, 'effects'), want.effects),
      ...split('Catalog of attacks', ['Animations', 'Effects'], SHARDS, 'build_unit_catalog.py', want.units),
      ['Attack clips', ['Catalog of attacks'], script('apply_catalog.mjs')],
      ['Sounds wanted', ['Attack clips'], () => runScript(join(HERE, 'pick_sounds.mjs'), [], { ...env, RDMODULE_SOUNDS_LIST: soundList })],
      ['Sounds', ['Sounds wanted'], decode(soundList)],
      ['Sounds picked', ['Sounds'], script('pick_sounds.mjs')],
      // (each page in a window of its own, with its own WebView2 data folder)
      ['Sprites', ['Attack clips'], page('render.html', 'sprites')],
      ['Backdrops', ['Attack clips'], page('render.html?backdrops', 'backdrops')],
      ['Effect sprites', ['Attack clips'], page('fx/effects.html?capture', 'effects')],
    ], { onStep, log, atOnce: AT_ONCE });
    for (const l of lines.filter((x) => /nothing for|missing|no sound banks/.test(x))) log(`  ${l}`);
    // what the pages could not draw
    for (const f of readdirSync(work).filter((x) => /^log-.*.json$/.test(x))) {
      const text = JSON.parse(readFileSync(join(work, f), 'utf8'));
      for (const l of String(text).split('\n').filter((x) => x.includes('FAILED'))) log(`  not drawn: ${l}`);
    }
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  if (!existsSync(join(sprites, 'index.json'))) throw new Error('The sprites were not drawn.');
  await writeFile(join(stage, READY), JSON.stringify({ extracted: new Date().toISOString() }) + '\n');
  await rm(out, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  await rename(stage, out);
  // (a file a closing window still holds is given a moment; what is left never fails the extraction)
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
    .catch((e) => log(`  the working folder stays: ${e.message}`));
}
