// Builds the tracker's game data from the Warcraft Rumble installed on this PC. Nothing is downloaded from the
// tracker's data pack; the tables and images are read from the game's own files, which are only read, never changed.
//
// From source:   npm run build-gamedata [-- --force] [-- <game folder>]      (into gamedata/)
// In a self-building exe (npm run build-selfbuilt) the tracker runs buildGameData itself at its start, with a
// progress page (server/datapack/selfbuild.mjs).
//
// The images are read with Python. A self-built exe carries its own (npm run fetch-python prepares it in python/);
// without that one, a Python 3.11 to 3.14 on this PC is used, its packages going into a virtual environment in the
// working folder on first use.
//
//  1. Find the game (the folder given, RUMBLE_GAME_DIR, or where Windows says it is installed).
//  2. Unchanged game files since the last build: nothing to do.
//  3. Start from the tables kept by hand (seed/: save IDs and keys of the minis, level rules, army code numbers).
//  4. Build the tables (minis, army boards, events, store, PvP), then extract the images they name and no others
//     (portraits, talent and trait icons, reward and store art, currency icons: about 670 small files, 4.5 MB).
//  5. Write gamedata.json: the game build and every file's checksum.
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, 'seed');
const OWN_PYTHON = join(HERE, 'python', 'python.exe');
const PACKAGES = ['UnityPy==1.25.4', 'Pillow'];
const AT_ONCE = Math.max(2, Math.min(6, availableParallelism() - 1)); // steps running side by side
const PYTHONS = ['3.14', '3.13', '3.12', '3.11']; // the versions the packages are known to install on

/** A problem the player can fix (no game, no Python); its message is shown as it is. */
export class BuildError extends Error {}

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

/** The game's version, from the Version column of .build.info. */
function gameBuild(game) {
  const lines = readFileSync(join(game, '.build.info'), 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split('|').map((h) => h.split('!')[0]);
  const active = lines.slice(1).map((l) => l.split('|')).find((c) => c[head.indexOf('Active')] === '1') || lines[1].split('|');
  return active[head.indexOf('Version')];
}
/** Changes when any bundle's name, size or date does. */
function fingerprint(game) {
  const h = createHash('sha1');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); h.update(`${e.name}|${s.size}|${s.mtimeMs}\n`); }
    }
  };
  walk(bundlesOf(game));
  return h.digest('hex');
}

/**
 * Whether `out` needs building: no finished build there, or the game's files changed since it. False when the game
 * isn't installed here (what is there stays in use).
 */
export function needsBuild({ game = findGame(), out, work }) {
  if (!existsSync(join(out, 'gamedata.json'))) return true;
  if (!game || !existsSync(bundlesOf(game))) return false;
  const last = existsSync(join(work, 'last_build.json')) ? JSON.parse(readFileSync(join(work, 'last_build.json'), 'utf8')) : {};
  return last.fingerprint !== fingerprint(game);
}

const lastLines = (out) => out.trim().split(/\r?\n/).slice(-6).join('\n');
/** Runs a program to its end; resolves with its output's lines, rejects when it fails. */
function runProgram(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: HERE, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim().split(/\r?\n/))
      : reject(new Error(`${basename(args.find((a) => /\.py$/.test(a)) || cmd)} failed:\n${lastLines(out)}`))));
  });
}
/** Runs one of the table builders here, in a thread of its own (inside the exe there is no node to start). */
function runScript(file, args, env) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(join(HERE, file)), { argv: args, env, stdout: true, stderr: true });
    let out = '';
    worker.stdout.on('data', (d) => { out += d; });
    worker.stderr.on('data', (d) => { out += d; });
    worker.on('error', (e) => reject(new Error(`${file} failed: ${e.message}`)));
    worker.on('exit', (code) => (code === 0 ? resolve(out.trim().split(/\r?\n/))
      : reject(new Error(`${file} failed:\n${lastLines(out)}`))));
  });
}

/**
 * Python with the packages the image steps need: RUMBLE_PYTHON, the private one beside these scripts (npm run
 * fetch-python; a self-built exe carries it), or a virtual environment in `work`, made on first use.
 */
async function python(work, log) {
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
 * Builds the game data into `out`, with its working files (and Python's environment) in `work`.
 * onStep(done, total, label) is called whenever a step starts or finishes (label: the ones running) and once more
 * when all are done.
 * Resolves with { gameBuild, files, missing }; rejects with a BuildError for what the player can fix.
 */
export async function buildGameData({ game = findGame(), out, work, onStep = () => {}, log = () => {} }) {
  if (!game) throw new BuildError('Warcraft Rumble was not found on this PC. Install the game, or set RUMBLE_GAME_DIR to its folder.');
  const bundles = bundlesOf(game);
  if (!existsSync(bundles)) throw new BuildError(`${game} has no Data\\StreamingAssets\\Bundles: is this the game's folder?`);
  const build = gameBuild(game), fp = fingerprint(game);
  log(`Warcraft Rumble ${build} in ${game}`);
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const env = { ...process.env, RUMBLE_BUNDLES: bundles, RUMBLE_GAMEDATA: out, RUMBLE_WORK: work };
  let py = null;
  const table = (file, ...a) => () => runScript(file, a, env);
  // a list kept by hand is beside the scripts; one a table builder wrote is in the working folder
  const images = (dir, list, size, prefer) => () => runProgram(py, ['-I', join(HERE, 'extract_reward_icons.py'),
    join(out, dir), join(existsSync(join(HERE, list)) ? HERE : work, list), size, ...(prefer ? [prefer] : [])], env);
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
      () => runProgram(py, ['-I', join(HERE, 'extract_event_icons.py'), join(out, 'events')], env)],
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
  const missing = [], done = new Set(), running = new Map();
  const report = () => onStep(done.size, steps.length, [...running.keys()].join(', '));
  let failed = null;
  while (done.size < steps.length && !failed) {
    for (const [label, needs, step] of steps) {
      if (done.has(label) || running.has(label) || running.size >= AT_ONCE || !needs.every((n) => done.has(n))) continue;
      log(`start  ${label}`);
      running.set(label, step().then((lines) => {
        missing.push(...lines.filter((l) => /NOT FOUND/.test(l)).map((l) => l.trim()));
        done.add(label);
        log(`done   ${label} (${done.size}/${steps.length})`);
      }, (e) => { failed ??= e; }).finally(() => running.delete(label)));
    }
    report();
    await Promise.race(running.values());
  }
  // one failed: the ones still running finish first, so nothing writes into the next try
  await Promise.all(running.values());
  if (failed) throw failed;

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
  writeFileSync(join(out, 'gamedata.json'), JSON.stringify({ format: 1, gameBuild: build, dataVersion, files }, null, 1) + '\n');
  writeFileSync(join(work, 'last_build.json'), JSON.stringify({ fingerprint: fp, build, built: dataVersion }, null, 1) + '\n');
  onStep(steps.length, steps.length, 'Done');
  return { gameBuild: build, files, missing };
}

// from the command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const o = { game: findGame(args.find((a) => !a.startsWith('--'))), out: join(HERE, '..', '..', 'gamedata'), work: join(HERE, 'work') };
  if (!args.includes('--force') && !needsBuild(o)) {
    console.log('The game files are unchanged since the last build: nothing to do (--force builds anyway).');
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
