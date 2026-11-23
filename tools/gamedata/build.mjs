// Builds the tracker's game data from the Warcraft Rumble installed on this PC: the tables and images are read from the
// game's own files, which are only read, never changed.
//
// The tracker runs buildGameData itself, at its first start and after each game patch (server/gamedata.mjs).
// By hand:   npm run build-gamedata [-- --force] [-- <game folder>]      (into gamedata/)
//
// The images are read with Python. The exe carries its own (npm run fetch-python prepares it in python/); without that
// one, a Python 3.11 to 3.14 on this PC is used, its packages going into a virtual environment in the working folder
// on first use.
//
//  1. Find the game (the folder given, RUMBLE_GAME_DIR, or where Windows says it is installed).
//  2. Start from the tables kept by hand (seed/: save IDs and keys of the minis, level rules, army code numbers).
//  3. Build the tables (minis, army boards, events, store, PvP), then extract the images they name and no others
//     (portraits, talent and trait icons, reward and store art, currency icons: about 670 small files, 4.5 MB).
//  4. Write gamedata.json: the game's version, this builder's, and every file's checksum.
// It goes easy on the PC: the programs it starts run at low priority, and only a few steps at a time.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { availableParallelism, setPriority, constants as osConstants } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, 'seed');
const OWN_PYTHON = join(HERE, 'python', 'python.exe');
const PACKAGES = ['UnityPy==1.25.4', 'Pillow'];
const { priority } = osConstants;
const AT_ONCE = Math.max(2, Math.min(4, availableParallelism() - 1)); // steps running side by side
// Raised whenever a new version of the tracker reads something more or differently, so data built before is read again.
export const BUILDER = 1;
const PYTHONS = ['3.14', '3.13', '3.12', '3.11']; // the versions the packages are known to install on

/** A problem the player can fix; its message is shown as it is. needsFolder: the game's folder is what is wanted. */
export class BuildError extends Error {}
const noGame = (message) => Object.assign(new BuildError(message), { needsFolder: true });

/** The game's folder: the one given, RUMBLE_GAME_DIR, or the install location Windows has for it. Null if none. */
export function findGame(given) {
  const dir = given || process.env.RUMBLE_GAME_DIR;
  if (dir) return dir;
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Warcraft Rumble',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Warcraft Rumble']) {
    const r = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
    const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(r.stdout || '');
    if (m) return m[1].trim();
  }
  return null;
}
const bundlesOf = (game) => join(game, 'Data', 'StreamingAssets', 'Bundles');

/** The installed game's version, from the Version column of .build.info. */
export function gameVersion(game) {
  const lines = readFileSync(join(game, '.build.info'), 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split('|').map((h) => h.split('!')[0]);
  const active = lines.slice(1).map((l) => l.split('|')).find((c) => c[head.indexOf('Active')] === '1') || lines[1].split('|');
  return active[head.indexOf('Version')];
}

/**
 * Whether game data with this stamp (its gamedata.json, or null when there is none) is due for a build: it was read
 * from another version of the game than the one installed in `game`, or by another version of this builder. Without
 * the game here, data that exists stays in use.
 */
export function buildDue(game, stamp) {
  if (!stamp) return true;
  if (!game || !existsSync(join(game, '.build.info'))) return false;
  return stamp.gameBuild !== gameVersion(game) || stamp.builder !== BUILDER;
}

const lastLines = (out) => out.trim().split(/\r?\n/).slice(-6).join('\n');
/** Runs a program to its end; resolves with its output's lines, rejects when it fails. `background`: low priority. */
export function runProgram(cmd, args, env, { background = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: HERE, env, windowsHide: true });
    // background work gives way to everything else on the PC (Windows also lowers its disk priority with this)
    if (background && child.pid) try { setPriority(child.pid, priority.PRIORITY_LOW); } catch { /* it has ended already */ }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim().split(/\r?\n/))
      : reject(new Error(`${basename(args.find((a) => /\.py$/.test(a)) || cmd)} failed:\n${lastLines(out)}`))));
  });
}
/** Runs a script (a file path) in a thread of its own (inside the exe there is no node to start). */
export function runScript(file, args, env) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(file), { argv: args, env, stdout: true, stderr: true });
    let out = '';
    worker.stdout.on('data', (d) => { out += d; });
    worker.stderr.on('data', (d) => { out += d; });
    worker.on('error', (e) => reject(new Error(`${basename(file)} failed: ${e.message}`)));
    worker.on('exit', (code) => (code === 0 ? resolve(out.trim().split(/\r?\n/))
      : reject(new Error(`${basename(file)} failed:\n${lastLines(out)}`))));
  });
}

/**
 * Python with the packages the image steps need: RUMBLE_PYTHON, the private one beside these scripts (npm run
 * fetch-python; a self-built exe carries it), or a virtual environment in `work`, made on first use.
 */
export async function python(work, log) {
  if (process.env.RUMBLE_PYTHON) return process.env.RUMBLE_PYTHON;
  if (existsSync(OWN_PYTHON)) return OWN_PYTHON;
  const venv = join(work, '.venv'), exe = join(venv, 'Scripts', 'python.exe');
  const ready = () => existsSync(exe) && spawnSync(exe, ['-c', 'import UnityPy, PIL'], { windowsHide: true }).status === 0;
  if (ready()) return exe;
  log('Setting up Python (once)');
  // The packages come ready-made only for released Python versions, so those are tried first, newest first; a
  // version too new for them is passed over for the next one.
  let found = false, why = '';
  for (const [cmd, a] of [...PYTHONS.map((v) => ['py', [`-${v}`]]), ['py', ['-3']], ['python', []]]) {
    rmSync(venv, { recursive: true, force: true });
    if (spawnSync(cmd, [...a, '-m', 'venv', venv], { windowsHide: true }).status !== 0 || !existsSync(exe)) continue;
    found = true;
    log(`Installing ${PACKAGES.join(', ')} (${cmd} ${a.join(' ')})`);
    try {
      await runProgram(exe, ['-m', 'pip', 'install', '--disable-pip-version-check', ...PACKAGES], process.env);
    } catch (e) {
      why = e.message.split('\n').pop();
      continue;
    }
    if (ready()) return exe;
  }
  rmSync(venv, { recursive: true, force: true });
  throw new BuildError(found
    ? `Python's packages could not be installed. This needs an internet connection once, and Python ${PYTHONS.at(-1)} to `
      + `${PYTHONS[0]}. (${why})`
    : 'Python 3 was not found. Install it from https://www.python.org/downloads/ (the images are read with it).');
}

/**
 * Runs steps, each [name, the names of the steps it waits for, what it does (resolving with its output's lines)].
 * Steps that do not wait for each other run side by side, up to atOnce of them. onStep(done, total, label) is called
 * whenever a step starts or finishes, label naming the ones running. Resolves with all the output lines; when a step
 * fails, the ones still running finish first (so nothing writes into the next try), then it rejects with that error.
 */
export async function runSteps(steps, { onStep = () => {}, log = () => {}, atOnce = AT_ONCE } = {}) {
  const lines = [], done = new Set(), running = new Map();
  let failed = null;
  while (done.size < steps.length && !failed) {
    for (const [label, needs, step] of steps) {
      if (done.has(label) || running.has(label) || running.size >= atOnce || !needs.every((n) => done.has(n))) continue;
      log(`start  ${label}`);
      running.set(label, Promise.resolve().then(step).then((out) => {
        lines.push(...(out || []));
        done.add(label);
        log(`done   ${label} (${done.size}/${steps.length})`);
      }, (e) => { failed ??= e; }).finally(() => running.delete(label)));
    }
    onStep(done.size, steps.length, [...running.keys()].join(', '));
    await Promise.race(running.values());
  }
  await Promise.all(running.values());
  if (failed) throw failed;
  return lines;
}

/**
 * Builds the game data into `out`, with its working files (and Python's environment) in `work`.
 * onStep(done, total, label) is called whenever a step starts or finishes (label: the ones running) and once more
 * when all are done.
 * Resolves with { gameBuild, files, missing }; rejects with a BuildError for what the player can fix (its needsFolder
 * says the game's folder is what is wanted).
 */
export async function buildGameData({ game = findGame(), out, work, onStep = () => {}, log = () => {} }) {
  if (!game) throw noGame('Warcraft Rumble was not found on this PC.');
  const bundles = bundlesOf(game);
  if (!existsSync(bundles)) throw noGame(`The game's files were not found in ${game}.`);
  const build = gameVersion(game);
  log(`Warcraft Rumble ${build} in ${game}`);
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const env = { ...process.env, RUMBLE_BUNDLES: bundles, RUMBLE_GAMEDATA: out, RUMBLE_WORK: work };
  let py = null;
  const QUIET = { background: true };
  const table = (file, ...a) => () => runScript(join(HERE, file), a, env);
  // a list kept by hand is beside the scripts; one a table builder wrote is in the working folder
  const images = (dir, list, size, prefer) => () => runProgram(py, ['-I', join(HERE, 'extract_reward_icons.py'),
    join(out, dir), join(existsSync(join(HERE, list)) ? HERE : work, list), size, ...(prefer ? [prefer] : [])], env, QUIET);
  // [name, the steps it waits for, what it does]. Steps that do not wait for each other run side by side: the tables
  // are built while Python is set up, and each kind of image is extracted as soon as its table has named them.
  const steps = [
    ['Python', [], async () => { py = await python(work, log); return []; }],
    ['Starting tables', [], async () => {
      // a build is whole only once its stamp is written; the image folders are built anew, so nothing unused stays
      rmSync(join(out, 'gamedata.json'), { force: true });
      for (const e of readdirSync(out, { withFileTypes: true })) if (e.isDirectory()) rmSync(join(out, e.name), { recursive: true });
      // a minis table already built stays, so its changes are reported against it
      for (const f of readdirSync(SEED)) if (f !== 'minis.json' || !existsSync(join(out, f))) copyFileSync(join(SEED, f), join(out, f));
      return [];
    }],
    ['Index of the game files', ['Starting tables'], table('build_guid_index.mjs')],
    ['Minis', ['Starting tables'], table('build_minis.mjs')],
    ['Army boards', ['Index of the game files', 'Minis'], table('army_boards.mjs', join(work, 'guid_index.json'), '--write')],
    ['Events', ['Starting tables'], table('build_events.mjs')],
    ['Store', ['Starting tables'], table('build_store.mjs')],
    ['PvP', ['Index of the game files'], table('build_pvp.mjs')],
    ['Event icons', ['Python', 'Starting tables'],
      () => runProgram(py, ['-I', join(HERE, 'extract_event_icons.py'), join(out, 'events')], env, QUIET)],
    ['Event rewards', ['Python', 'Events'], images('rewards', 'event_reward_sprites.json', '96')],
    ['Store art', ['Python', 'Store'], images('store', 'store_sprites.json', '160')],
    ['Portraits', ['Python', 'Minis'], images('art', 'mini_art_sprites.json', '256', '^unitui_')],
    ['Talent icons', ['Python', 'Minis'], images('talents', 'mini_talents_sprites.json', '96', '^talentui_')],
    ['Trait icons', ['Python', 'Minis'], images('icons', 'mini_icons_sprites.json', '64', '^iconsglobal')],
    ['Leader and Wildcard icons', ['Python', 'Starting tables'], images('icons', 'tag_sprites.json', '64', '^iconsglobal')],
    ['Family pair icons', ['Python', 'Starting tables'], images(join('icons', 'fam'), 'family_pair_sprites.json', '64', '^iconsglobal')],
    ['Currency icons', ['Python', 'Starting tables'], images('currency', 'currency_sprites.json', '96', '^iconsglobal')],
    ['PvP icons', ['Python', 'PvP'], images('pvp', 'pvp_sprites.json', '128', 'pvp')],
    ['PvP rewards', ['Python', 'PvP'], images('rewards', 'pvp_reward_sprites.json', '96')],
  ];
  const missing = (await runSteps(steps, { onStep, log })).filter((l) => /NOT FOUND/.test(l)).map((l) => l.trim());

  // the stamp: what the tracker reads to know the data is whole
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|webp|png)$/i.test(e.name) && e.name !== 'gamedata.json') {
        const buf = readFileSync(p);
        files[relative(out, p).split(sep).join('/')] = { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
      }
    }
  };
  walk(out);
  const dataVersion = new Date().toISOString();
  writeFileSync(join(out, 'gamedata.json'),
    JSON.stringify({ format: 1, gameBuild: build, builder: BUILDER, dataVersion, files }, null, 1) + '\n');
  onStep(steps.length, steps.length, 'Done');
  return { gameBuild: build, files, missing };
}

// from the command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const o = { game: findGame(args.find((a) => !a.startsWith('--'))), out: join(HERE, '..', '..', 'gamedata'), work: join(HERE, 'work') };
  const stampFile = join(o.out, 'gamedata.json');
  const stamp = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')) : null;
  if (!args.includes('--force') && !buildDue(o.game, stamp)) {
    console.log(`The game data is already read from this version of the game (${stamp.gameBuild}): nothing to do (--force builds anyway).`);
    process.exit(0);
  }
  try {
    const r = await buildGameData({ ...o, log: console.log });
    const size = Object.values(r.files).reduce((s, f) => s + f.size, 0);
    console.log(`\nGame data for ${r.gameBuild}: ${Object.keys(r.files).length} files, ${(size / 1048576).toFixed(1)} MB, in gamedata/.`);
    if (r.missing.length) console.log(`Images the game files did not have:\n${r.missing.map((l) => `  ${l}`).join('\n')}`);
  } catch (e) {
    console.error(`build-gamedata: ${e.message}`);
    process.exit(1);
  }
}
