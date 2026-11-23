// Extracts the additional data: what the rdmodule, the page behind the tracker's hidden key sequence, draws and plays,
// from the Warcraft Rumble installed on this PC: the units' sprites (rendered from their 3D models and animations),
// effect sprites, backdrops and sounds. (Its menu art is part of the tracker's own game data.) The tracker runs it in
// the background when asked in Settings (server/rdmodule.mjs). The game's files are only read.
//
// The steps, of which those that do not wait for each other run side by side:
//   exports (Python, as for the game data): the towers' models, the units' rigged models with their animations, the
//     map the backdrops are drawn from, and the indexes of the effects and sounds; then one catalog of what each unit's
//     attack plays, after which only the effects that are drawn and the sounds that are played are extracted (Wwise
//     audio is decoded by vgmstream);
//   pictures: the render pages (render/) draw the sprites with three.js in a WebView2 window nobody sees
//     (desktop/render.ps1) and post each picture back to a small server here;
//   sounds: only the ones the rdmodule uses are decoded, then picked.
// Only what render/sprites.json names is exported.
//
// A run does only what is due. Each step has a version, made of its own script and inputs (SOURCES): steps that
// changed since the last extraction run again, with the steps that use what they make. The bulky exports (models,
// animations, textures, decoded sounds: about 1 GB) are deleted once the pictures are drawn, and only their small
// indexes are kept; a step that reads a bulky export (BULK) has it made again. Another version of the game runs
// everything.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, copyFile, cp, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, normalize, extname, sep } from 'node:path';
import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BuildError, findGame, gameVersion, python, pythonVersions, runProgram, runScript, runSteps, versionsOf,
  withDependents, withTools } from '../gamedata/build.mjs';
import { POWERSHELL } from '../../server/system.mjs';
import { replaceFolder } from '../../server/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PAGES = join(HERE, 'render');
const VENDOR = join(HERE, 'vendor');
const RENDER_MINUTES = 30; // a render page that hasn't finished by then has failed
const READY = 'ready.json';
// The animations and the effects are each split over a few processes (RUMBLE_SHARD in the scripts). A process holds
// only the game files it reads (export_models.load_lazy): about 0.6 GB for the animations and 2 GB for the effects,
// measured. Their number follows the PC's memory all the same, to stay within a quarter of it.
const CORES = availableParallelism(), GB = totalmem() / 2 ** 30;
const SHARDS = Math.max(1, Math.min(4, Math.floor(CORES / 4), Math.floor(GB / 8)));
const INDEX_SHARDS = Math.max(2, Math.min(4, Math.floor(CORES / 3)));
const AT_ONCE = Math.max(3, Math.min(12, CORES - 2));
// Units whose skeletons have no animations of their own take them from these, which are exported for that.
const DONORS = ['thaurissan', 'whelpeggs'];
const SOUND_LANGUAGES = 'sfx,en-US'; // the sounds indexed and decoded: effects, and voice lines in English

/** Whether the extraction's own tools are here (npm run fetch-rdmodule-tools; the exe carries them). */
export const canExtract = () => existsSync(join(VENDOR, 'three', 'build', 'three.module.js'))
  && existsSync(join(VENDOR, 'vgmstream', 'vgmstream-cli.exe')) && existsSync(join(ROOT, 'desktop', 'webview2'));
// What each step is made of (files in this folder), for its version. Shared by a split step's parts.
const LIST = 'render/sprites.json', MODELS = 'export_models.py'; // (what is wanted; what the other exports import)
const SOURCES = {
  'List of minis': ['all_minis.mjs', '../gamedata/unityfs.mjs'],
  'Index of the sounds': ['export_sounds.py'],
  'Index of the game files': ['build_indexes.py'],
  'Index of the effects': ['export_effects.py', 'export_animations.py', MODELS, LIST],
  'Tower models': [MODELS, LIST],
  Map: ['export_maps.py', LIST],
  Animations: ['export_animations.py', MODELS, LIST],
  'Catalog of attacks': ['build_unit_catalog.py', MODELS, LIST],
  'Attack clips': ['apply_catalog.mjs', LIST],
  'Effects wanted': [LIST],
  Effects: ['export_effects.py', 'export_animations.py', MODELS],
  'Sounds wanted': ['pick_sounds.mjs', 'apply_catalog.mjs'],
  Sounds: ['export_sounds.py'],
  'Sounds picked': ['pick_sounds.mjs', 'apply_catalog.mjs'],
  Sprites: ['render/render.html', LIST],
  Backdrops: ['render/render.html', LIST],
  'Effect sprites': ['render/effects.html', 'render/effects_capture.js'],
};
// The steps' settings, which are part of their versions like their files.
const SETTINGS = { Animations: DONORS, 'Index of the sounds': SOUND_LANGUAGES, Sounds: SOUND_LANGUAGES };
const PYTHON_STEPS = ['Index of the sounds', 'Index of the game files', 'Index of the effects', 'Tower models', 'Map', 'Animations',
  'Catalog of attacks', 'Effects', 'Sounds']; // the steps Python runs
// The steps whose bulky export a step reads. Those exports are gone after an extraction, so when the step runs again
// they are made again first.
const BULK = { Sprites: ['Animations', 'Tower models'], Backdrops: ['Map'], 'Effect sprites': ['Effects'], 'Sounds picked': ['Sounds'] };
const base = (step) => step.replace(/ \d+\/\d+$/, ''); // "Animations 2/4" is a part of "Animations"

/** Whether the extraction in `out` has steps due: the game or the tracker changed since. False when there is none. */
export const outOfDate = (out, gameFolder = '') => !!stampOf(out) && stepsDue(findGame(gameFolder), stampOf(out)).length > 0;
/** The stamp of the extraction in `out` (its ready.json), or null when there is none. */
const stampOf = (out) => (existsSync(join(out, READY)) ? JSON.parse(readFileSync(join(out, READY), 'utf8')) : null);
/**
 * The steps that are due for an extraction with this stamp: 'all' without one or for another version of the game
 * than the one in `game`, else the names of the steps whose version is another now ([] when nothing is due).
 */
export function stepsDue(game, stamp) {
  if (!stamp?.steps) return 'all';
  if (game && existsSync(join(game, '.build.info')) && stamp.gameBuild !== gameVersion(game)) return 'all';
  const now = stepVersions();
  return Object.keys(now).filter((name) => stamp.steps[name] !== now[name]);
}
/** { step: version } for every step here, as they are in this version of the tracker. */
export function stepVersions() {
  // the tools a step uses count too: Python and its packages, vgmstream for the sounds, three.js for the pictures
  const fetched = existsSync(join(VENDOR, 'versions.json')) ? JSON.parse(readFileSync(join(VENDOR, 'versions.json'), 'utf8')) : {};
  const py = pythonVersions();
  let settings = withTools(SETTINGS, PYTHON_STEPS.filter((s) => s !== 'Sounds'), py);
  settings = withTools(settings, ['Sounds'], (py || fetched.vgmstream) && { python: py, vgmstream: fetched.vgmstream });
  settings = withTools(settings, ['Sprites', 'Backdrops', 'Effect sprites'], fetched.three && { three: fetched.three });
  return versionsOf(SOURCES, HERE, settings);
}
/**
 * The names of the steps to run when `due` are (see stepsDue): those and what depends on them; then, as the bulky
 * exports are gone after an extraction, the steps that make the ones a running step reads (a split step with all its
 * parts). `steps` are [name, the names of the steps it waits for] as for runSteps.
 */
export function stepsToRun(steps, due) {
  const names = steps.map((x) => x[0]);
  const run = withDependents(steps, names.filter((n) => due.includes(base(n))));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of [...run]) {
      for (const b of BULK[base(n)] || []) {
        for (const maker of names.filter((x) => base(x) === b)) if (!run.has(maker)) { run.add(maker); grew = true; }
      }
    }
  }
  return run.add('Python');
}

const alt = (names) => `^(${[...new Set(names)].filter(Boolean).join('|')})$`;
/** What to export, from the list of sprites (render/sprites.json): regular expressions for each export. */
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
  .replaceAll('https://cdn.jsdelivr.net/npm/three@0.187.0/', '/three/')
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
/**
 * Serves the render pages and the exports to them, and saves the pictures they post. Resolves with the server.
 * Only this machine's own pages may use it, and only its own pages may save.
 */
export function renderServer(work, sprites) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { host = '', origin } = req.headers;
    // (a page of another site, open in a browser, names itself as the origin of what it sends)
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || (origin && origin !== `http://${host}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
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
 * Extracts into `out` (sprites/, sounds/), with the exports in `work`. `gamedata` is the tracker's game data folder
 * (its minis table is read), `gameFolder` the game's folder when it was given by hand. Only what is due is done (see
 * stepsDue), on top of the extraction `out` already holds; `all` does everything.
 * onStep(done, total, label) as in runSteps. Resolves with the names of the steps that ran ([] when nothing was due).
 * Rejects with a BuildError for what the player can fix.
 */
export async function extractRdmodule({ gameFolder = '', gamedata, out, work, all = false, onStep = () => {}, log = () => {} }) {
  const game = findGame(gameFolder);
  if (!game) throw new BuildError('Warcraft Rumble was not found on this PC.');
  if (!canExtract()) throw new BuildError('This tracker was built without the tools the extraction needs.');
  // what is due: everything, unless the small files the last extraction kept are still there to go by
  let due = all ? 'all' : stepsDue(game, stampOf(out));
  if (due !== 'all' && !existsSync(join(work, 'asset_index.json'))) due = 'all';
  if (!due.length) return [];
  // built beside the last extraction, which it replaces only when it is whole
  const stage = `${out}-new`;
  const sprites = join(stage, 'sprites'), sounds = join(stage, 'sounds');
  await rm(stage, { recursive: true, force: true });
  if (due === 'all') await rm(work, { recursive: true, force: true });
  else await cp(out, stage, { recursive: true });
  // (parts of split steps that an interrupted run left would be put together with this run's)
  for (const d of ['index_parts', 'animations/parts', 'effects/parts']) await rm(join(work, d), { recursive: true, force: true });
  for (const d of [sprites, sounds, join(work, 'gamedata')]) await mkdir(d, { recursive: true });
  await copyFile(join(gamedata, 'minis.json'), join(work, 'gamedata', 'minis.json'));
  const want = wanted(JSON.parse(readFileSync(join(PAGES, 'sprites.json'), 'utf8')));
  const env = { ...process.env, RUMBLE_WORK: work, RUMBLE_GAMEDATA: gamedata,
    RUMBLE_BUNDLES: join(game, 'Data', 'StreamingAssets', 'Bundles'),
    RUMBLE_AUDIO: join(game, 'Data', 'StreamingAssets', 'Audio', 'GeneratedSoundBanks', 'Windows'),
    RUMBLE_VGMSTREAM: join(VENDOR, 'vgmstream', 'vgmstream-cli.exe'), RUMBLE_SOUND_LANGUAGES: SOUND_LANGUAGES,
    RDMODULE_SPRITES: sprites, RDMODULE_SOUNDS: sounds };
  // Python is set up once, by whichever step asks first (when only some steps run, none comes surely before the rest)
  let ready = null;
  const py = () => (ready ??= python(work, log));
  const quiet = { background: true }; // everything here runs at low priority
  const exportWith = (script, ...a) => async () => runProgram(await py(), ['-I', join(HERE, script), ...a], env, quiet);
  const script = (file, ...a) => () => runScript(join(HERE, file), a, env);
  // Sounds: the index of all of them comes first (the effects and the catalog name sounds by it); only the files the
  // picker then asks for are decoded.
  const soundList = join(work, 'sound_files.json'), prefabList = join(work, 'effect_prefabs.json');
  const decode = (files) => async () => runProgram(await py(), ['-I', join(HERE, 'export_sounds.py'), join(work, 'sounds')],
    { ...env, RUMBLE_SOUND_FILES: files }, quiet);
  const server = await renderServer(work, sprites);
  // (each page in a window of its own, with its own WebView2 data folder; the pictures it drew last time go first)
  const page = (path, name, old) => async () => {
    for (const f of await readdir(sprites)) if (old.test(f)) await rm(join(sprites, f));
    return renderPage(`http://127.0.0.1:${server.address().port}/${path}`, join(work, `webview2-${name}`));
  };
  // A slow export split over n processes, then its parts put together: the steps for it.
  // (build_indexes.py takes its share as an argument, the others from RUMBLE_SHARD)
  const split = (name, needs, n, script2, a = [], more = {}) => {
    const part = (shard) => async () => runProgram(await py(), ['-I', join(HERE, script2), ...(a.length ? a : [shard])],
      { ...env, ...more, RUMBLE_SHARD: shard }, quiet);
    const parts = Array.from({ length: n }, (_, k) => [`${name} ${k + 1}/${n}`, needs, part(`${k}/${n}`)]);
    return [...parts, [name, parts.map((p) => p[0]), part('merge')]];
  };
  const steps = [
    ['Python', [], async () => { await py(); return []; }],
    ['List of minis', [], script('all_minis.mjs', join(work, 'all_mini_definitions.json'))],
    ['Index of the sounds', ['Python', 'List of minis'], decode('none')],
    // the indexes of the game's files that all the other exports read, built once
    ...split('Index of the game files', ['Python', 'List of minis'], INDEX_SHARDS, 'build_indexes.py'),
    // which unit shows which effect: all the catalog needs of them
    ['Index of the effects', ['Index of the game files', 'Index of the sounds'],
      async () => runProgram(await py(), ['-I', join(HERE, 'export_effects.py'), join(work, 'effects'), want.effects],
        { ...env, RUMBLE_PREFABS: 'none' }, quiet)],
    ['Tower models', ['Index of the game files'], exportWith('export_models.py', join(work, 'models'), want.models)],
    ['Map', ['Index of the game files'], exportWith('export_maps.py', join(work, 'maps'), want.maps)],
    ...split('Animations', ['Tower models', 'Map'], SHARDS, 'export_animations.py', [join(work, 'animations'), want.animations]),
    ['Catalog of attacks', ['Animations', 'Index of the effects'], exportWith('build_unit_catalog.py', want.units)],
    ['Attack clips', ['Catalog of attacks'], async () => {
      await copyFile(join(PAGES, 'sprites.json'), join(work, 'sprites.json')); // its working copy, which this step fills in
      return script('apply_catalog.mjs')();
    }],
    // only the effects that are drawn are extracted, with their textures and meshes
    ['Effects wanted', ['Attack clips'], async () => {
      const drawn = Object.values(JSON.parse(await readFile(join(work, 'sprites.json'), 'utf8')).effects).map((e) => e.prefab);
      await writeFile(prefabList, JSON.stringify([...new Set(drawn)]));
      return [];
    }],
    ...split('Effects', ['Effects wanted'], SHARDS, 'export_effects.py', [join(work, 'effects'), want.effects],
      { RUMBLE_PREFABS: prefabList }),
    ['Sounds wanted', ['Attack clips'], () => runScript(join(HERE, 'pick_sounds.mjs'), [], { ...env, RDMODULE_SOUNDS_LIST: soundList })],
    ['Sounds', ['Sounds wanted'], decode(soundList)],
    ['Sounds picked', ['Sounds'], script('pick_sounds.mjs')],
    ['Sprites', ['Attack clips', 'Animations', 'Tower models'], page('render.html', 'sprites', /^(?!fx-|bg-).*\.png$|^index\.json$/)],
    ['Backdrops', ['Attack clips', 'Map'], page('render.html?backdrops', 'backdrops', /^bg-.*\.png$/)],
    ['Effect sprites', ['Effects'], page('fx/effects.html?capture', 'effects', /^fx-.*\.png$|^fx\.json$/)],
  ];
  let only = null;
  if (due !== 'all') {
    only = stepsToRun(steps, due);
    log(`Due: ${[...new Set([...only].map(base))].filter((n) => n !== 'Python').join(', ')}`);
  }
  try {
    const lines = await runSteps(steps, { onStep, log, atOnce: AT_ONCE, only });
    for (const l of lines.filter((x) => /nothing for|missing|no sound banks/.test(x))) log(`  ${l}`);
    // what the pages could not draw
    for (const f of readdirSync(work).filter((x) => /^log-.*\.json$/.test(x))) {
      const text = JSON.parse(readFileSync(join(work, f), 'utf8'));
      for (const l of String(text).split('\n').filter((x) => x.includes('FAILED'))) log(`  not drawn: ${l}`);
    }
    if (!existsSync(join(sprites, 'index.json'))) throw new Error('The sprites were not drawn.');
  } catch (e) {
    await rm(stage, { recursive: true, force: true }).catch(() => {}); // nothing half-made stays
    throw e;
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  await writeFile(join(stage, READY), JSON.stringify({ extracted: new Date().toISOString(), gameBuild: gameVersion(game),
    steps: stepVersions() }, null, 1) + '\n');
  await replaceFolder(stage, out);
  await prune(work).catch((e) => log(`  the working folder was not cleared: ${e.message}`));
  return steps.map((x) => x[0]).filter((n) => !only || only.has(n));
}

/**
 * Clears the working folder of everything bulky: the windows' data folders and every export that is not a small
 * index (.json), which the next extraction goes by. (A file a closing window still holds is given a moment.)
 */
async function prune(dir, top = true) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'parts' || (top && /^(webview2-|index_parts$|gamedata$)/.test(e.name))) {
        await rm(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
      } else {
        await prune(p, false);
        if (!(await readdir(p)).length) await rm(p, { recursive: true, force: true });
      }
    } else if (!e.name.endsWith('.json') || /^log-/.test(e.name)) await rm(p, { force: true });
  }
}
