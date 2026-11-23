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
//     (portraits, talent and trait icons, reward and store art, currency icons, the page's frames and boards: about
//     690 small files, 4.8 MB).
//  4. Write gamedata.json: the game's version and each step's.
// A build runs only what is due. Each step has a version, made of its own script and inputs (SOURCES): after a new
// version of the tracker, the steps that changed run again, with the steps that use what they make. Another version
// of the game runs them all.
// It goes easy on the PC: the programs it starts run at low priority, and only a few steps at a time.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
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
const PROGRAM_MINUTES = 10; // a program still running by then hangs: it is stopped and its step fails
// What each step is made of: its script and the files it reads besides the game's (in this folder), and its settings
// below. A step's version is the contents of these, so a step changes exactly when one of them does.
const TABLES = ['unityfs.mjs'], IMAGES = ['extract_reward_icons.py'];
const SOURCES = {
  'Starting tables': readdirSync(SEED).map((f) => `seed/${f}`),
  'Index of the game files': ['build_guid_index.mjs', ...TABLES],
  Minis: ['build_minis.mjs', ...TABLES],
  'Army boards': ['army_boards.mjs', ...TABLES],
  Events: ['build_events.mjs', ...TABLES],
  Store: ['build_store.mjs', ...TABLES],
  PvP: ['build_pvp.mjs', ...TABLES],
  'Event icons': ['extract_event_icons.py'],
  'Event rewards': IMAGES, 'Store art': IMAGES, Portraits: IMAGES, 'Talent icons': IMAGES, 'Trait icons': IMAGES,
  'PvP icons': IMAGES, 'PvP rewards': IMAGES,
  'Leader and Wildcard icons': [...IMAGES, 'tag_sprites.json'],
  'Family pair icons': [...IMAGES, 'family_pair_sprites.json'],
  'Currency icons': [...IMAGES, 'currency_sprites.json'],
  'Interface art': [...IMAGES, 'interface_sprites.json'],
  'Card frames': [...IMAGES, 'frame_sprites.json', 'make_card_frames.py'],
};
// The image steps' settings: [folder, list of sprites, size in pixels, the bundles to look in first].
const IMAGE_STEPS = {
  'Event rewards': ['rewards', 'event_reward_sprites.json', '96'],
  'Store art': ['store', 'store_sprites.json', '160'],
  Portraits: ['art', 'mini_art_sprites.json', '256', '^unitui_'],
  'Talent icons': ['talents', 'mini_talents_sprites.json', '96', '^talentui_'],
  'Trait icons': ['icons', 'mini_icons_sprites.json', '64', '^iconsglobal'],
  'Leader and Wildcard icons': ['icons', 'tag_sprites.json', '64', '^iconsglobal'],
  'Family pair icons': ['icons/fam', 'family_pair_sprites.json', '64', '^iconsglobal'],
  'Currency icons': ['currency', 'currency_sprites.json', '96', '^iconsglobal'],
  'PvP icons': ['pvp', 'pvp_sprites.json', '128', 'pvp'],
  'PvP rewards': ['rewards', 'pvp_reward_sprites.json', '96'],
  'Interface art': ['ui', 'interface_sprites.json', '1800'],
};
const FRAME_SIZE = '1024'; // the slot backgrounds the card frames are cut from
const SETTINGS = { ...IMAGE_STEPS, 'Card frames': [FRAME_SIZE] };
const PYTHON_STEPS = ['Event icons', ...Object.keys(IMAGE_STEPS), 'Card frames']; // the steps Python runs
/**
 * The private Python's version and its packages' (npm run fetch-python writes them down), or null without it: a
 * Python found on the PC is taken as it is. They count in the versions of the steps Python runs, as another UnityPy
 * or Pillow may read an image differently.
 */
export function pythonVersions() {
  const file = join(HERE, 'python', 'versions.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
/** `settings` with the tools' versions added for the steps that use them: { step: [its own settings, the tools] }. */
export function withTools(settings, steps, tools) {
  if (!tools) return settings;
  return { ...settings, ...Object.fromEntries(steps.map((name) => [name, [settings[name] ?? null, tools]])) };
}
/**
 * { step: version } for steps given as { step: [files in `dir`] }: a version is the contents of the step's files and
 * of its settings ({ step: anything JSON can hold }), where it has some.
 */
export function versionsOf(sources, dir, settings = {}) {
  const version = (name, files) => {
    const h = createHash('sha1');
    for (const f of files) h.update(f).update(readFileSync(join(dir, f)));
    if (name in settings) h.update(JSON.stringify(settings[name]));
    return h.digest('hex').slice(0, 12);
  };
  return Object.fromEntries(Object.entries(sources).map(([name, files]) => [name, version(name, files)]));
}
/** { step: version } for every step here, as they are in this version of the tracker. */
export const stepVersions = () => versionsOf(SOURCES, HERE, withTools(SETTINGS, PYTHON_STEPS, pythonVersions()));
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
 * The steps that are due for game data with this stamp (its gamedata.json, or null when there is none): 'all' without
 * a stamp, for another version of the game than the one installed in `game`, or when the tables kept by hand
 * changed; else the names of the steps whose version is another now ([] when nothing is due). Without the game here,
 * data that exists stays as it is.
 */
export function stepsDue(game, stamp) {
  if (!stamp?.steps) return 'all';
  if (!game || !existsSync(join(game, '.build.info'))) return [];
  if (stamp.gameBuild !== gameVersion(game)) return 'all';
  const now = stepVersions();
  const changed = Object.keys(now).filter((name) => stamp.steps[name] !== now[name]);
  return changed.includes('Starting tables') ? 'all' : changed;
}

const lastLines = (out) => out.trim().split(/\r?\n/).slice(-6).join('\n');
// The programs running now. They end with the tracker: one left behind would go on reading for nobody.
const programs = new Set();
process.once('exit', () => { for (const child of programs) child.kill(); });
/**
 * Runs a program to its end; resolves with its output's lines, rejects when it fails or is not done after `minutes`
 * (it is stopped then). `background`: low priority.
 */
export function runProgram(cmd, args, env, { background = false, minutes = PROGRAM_MINUTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: HERE, env, windowsHide: true });
    programs.add(child);
    let late = false;
    const limit = setTimeout(() => { late = true; child.kill(); }, minutes * 60000);
    child.on('close', () => { programs.delete(child); clearTimeout(limit); });
    // background work gives way to everything else on the PC (Windows also lowers its disk priority with this)
    if (background && child.pid) try { setPriority(child.pid, priority.PRIORITY_LOW); } catch { /* it has ended already */ }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    const name = basename(args.find((a) => /\.py$/.test(a)) || cmd);
    child.on('close', (code) => {
      if (code === 0 && !late) resolve(out.trim().split(/\r?\n/));
      else if (late) reject(new Error(`${name} was not done after ${minutes} minutes and was stopped.`));
      else reject(new Error(`${name} failed:\n${lastLines(out)}`));
    });
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
 * fetch-python; the exe carries it), or a virtual environment in `work`, made on first use.
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
      await runProgram(exe, ['-m', 'pip', 'install', '--disable-pip-version-check', ...PACKAGES], process.env, { minutes: 20 });
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
 * `only` (a set of names) runs just those steps, the others counting as done already.
 */
export async function runSteps(steps, { onStep = () => {}, log = () => {}, atOnce = AT_ONCE, only = null } = {}) {
  const lines = [], running = new Map();
  const done = new Set(only ? steps.map((x) => x[0]).filter((name) => !only.has(name)) : []);
  const skipped = done.size, total = steps.length - skipped;
  let failed = null;
  while (done.size < steps.length && !failed) {
    for (const [label, needs, step] of steps) {
      if (done.has(label) || running.has(label) || running.size >= atOnce || !needs.every((n) => done.has(n))) continue;
      log(`start  ${label}`);
      running.set(label, Promise.resolve().then(step).then((out) => {
        lines.push(...(out || []));
        done.add(label);
        log(`done   ${label} (${done.size - skipped}/${total})`);
      }, (e) => { failed ??= e; }).finally(() => running.delete(label)));
    }
    onStep(done.size - skipped, total, [...running.keys()].join(', '));
    await Promise.race(running.values());
  }
  await Promise.all(running.values());
  if (failed) throw failed;
  return lines;
}

/** Every step that waits, directly or not, for one of `names`, with those themselves. */
export function withDependents(steps, names) {
  const due = new Set(names);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, needs] of steps) if (!due.has(name) && needs.some((n) => due.has(n))) { due.add(name); grew = true; }
  }
  return due;
}

/**
 * Builds the game data into `out`, with its working files (and Python's environment) in `work`. `due` is what to
 * build: 'all', or the names of steps (from stepsDue), which then run with everything that depends on them, on top
 * of the data `out` already holds.
 * onStep(done, total, label) is called whenever a step starts or finishes (label: the ones running) and once more
 * when all are done.
 * Resolves with { gameBuild, steps: the names that ran, missing }; rejects with a BuildError for what the player can
 * fix (its needsFolder says the game's folder is what is wanted).
 */
export async function buildGameData({ game = findGame(), out, work, due = 'all', onStep = () => {}, log = () => {} }) {
  if (!game) throw noGame('Warcraft Rumble was not found on this PC.');
  const bundles = bundlesOf(game);
  if (!existsSync(bundles)) throw noGame(`The game's files were not found in ${game}.`);
  const build = gameVersion(game);
  log(`Warcraft Rumble ${build} in ${game}`);
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const stampFile = join(out, 'gamedata.json');
  const before = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')) : null;
  // some steps need what earlier ones left in the working folder: without it, everything is built
  if (due !== 'all' && !(before?.made && existsSync(join(work, 'guid_index.json')))) due = 'all';
  const made = due === 'all' ? {} : { ...before.made }; // step -> the image files it wrote, to clear before it runs again
  const env = { ...process.env, RUMBLE_BUNDLES: bundles, RUMBLE_GAMEDATA: out, RUMBLE_WORK: work };
  // Python is set up once, by whichever step asks first
  let ready = null;
  const py = () => (ready ??= python(work, log));
  const QUIET = { background: true };
  const table = (file, ...a) => () => runScript(join(HERE, file), a, env);
  // An image step: the sprites a list names, into a folder. The list is beside the scripts when kept by hand, in the
  // working folder when a table builder wrote it. What the step wrote last time goes first, so nothing unused stays
  // and nothing old is taken for new.
  const images = (step) => async () => {
    const [dir, list, size, prefer] = IMAGE_STEPS[step];
    const listFile = join(existsSync(join(HERE, list)) ? HERE : work, list);
    for (const f of made[step] || []) rmSync(join(out, f), { force: true });
    const names = JSON.parse(readFileSync(listFile, 'utf8'));
    made[step] = (Array.isArray(names) ? names : Object.keys(names))
      .map((n) => `${dir}/${n.endsWith('.png') ? n : `${n}.webp`}`);
    return runProgram(await py(), ['-I', join(HERE, 'extract_reward_icons.py'), join(out, dir), listFile, size,
      ...(prefer ? [prefer] : [])], env, QUIET);
  };
  // [name, the steps it waits for, what it does]. Steps that do not wait for each other run side by side: the tables
  // are built while Python is set up, and each kind of image is extracted as soon as its table has named them.
  const steps = [
    ['Python', [], async () => { await py(); return []; }],
    ['Starting tables', [], async () => {
      // everything is built anew: the image folders go, so nothing unused stays
      rmSync(stampFile, { force: true });
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
    ['Event icons', ['Python', 'Starting tables'], async () => {
      rmSync(join(out, 'events'), { recursive: true, force: true });
      return runProgram(await py(), ['-I', join(HERE, 'extract_event_icons.py'), join(out, 'events')], env, QUIET);
    }],
    ['Event rewards', ['Python', 'Events'], images('Event rewards')],
    ['Store art', ['Python', 'Store'], images('Store art')],
    ['Portraits', ['Python', 'Minis'], images('Portraits')],
    ['Talent icons', ['Python', 'Minis'], images('Talent icons')],
    ['Trait icons', ['Python', 'Minis'], images('Trait icons')],
    ['Leader and Wildcard icons', ['Python', 'Starting tables'], images('Leader and Wildcard icons')],
    ['Family pair icons', ['Python', 'Starting tables'], images('Family pair icons')],
    ['Currency icons', ['Python', 'Starting tables'], images('Currency icons')],
    ['PvP icons', ['Python', 'PvP'], images('PvP icons')],
    ['PvP rewards', ['Python', 'PvP'], images('PvP rewards')],
    // the page's own art: wood, key art and army boards as they are; the card frames are cut out of the game's slot
    // backgrounds (make_card_frames.py)
    ['Interface art', ['Python', 'Starting tables'], images('Interface art')],
    ['Card frames', ['Python', 'Starting tables'], async () => {
      const slots = join(work, 'frames');
      rmSync(slots, { recursive: true, force: true });
      for (const f of readdirSync(join(out, 'ui'), { withFileTypes: true }).filter((e) => /^(frame-|fill-mask)/.test(e.name))) {
        rmSync(join(out, 'ui', f.name));
      }
      await runProgram(await py(), ['-I', join(HERE, 'extract_reward_icons.py'), slots, join(HERE, 'frame_sprites.json'), FRAME_SIZE],
        env, QUIET);
      const lines = await runProgram(await py(), ['-I', join(HERE, 'make_card_frames.py'), slots, join(out, 'ui')], env, QUIET);
      rmSync(slots, { recursive: true, force: true }); // (only needed to cut the frames from)
      return lines;
    }],
  ];
  const only = due === 'all' ? null : new Set(['Python', ...withDependents(steps, due)]);
  if (only) log(`Due: ${[...only].filter((n) => n !== 'Python').join(', ')}`);
  // (two image steps may share a folder that neither has made yet)
  for (const dir of ['ui', 'icons', 'rewards']) mkdirSync(join(out, dir), { recursive: true });
  const missing = (await runSteps(steps, { onStep, log, only })).filter((l) => /NOT FOUND/.test(l)).map((l) => l.trim());

  // the stamp: what the tracker reads to know the data is whole, and what a later build goes by
  const dataVersion = new Date().toISOString();
  writeFileSync(stampFile, JSON.stringify({ format: 2, gameBuild: build, dataVersion, steps: stepVersions(), made }, null, 1) + '\n');
  const ran = steps.map((x) => x[0]).filter((name) => !only || only.has(name));
  onStep(ran.length, ran.length, 'Done');
  return { gameBuild: build, steps: ran, missing };
}

// from the command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const o = { game: findGame(args.find((a) => !a.startsWith('--'))), out: join(HERE, '..', '..', 'gamedata'), work: join(HERE, 'work') };
  const stampFile = join(o.out, 'gamedata.json');
  const stamp = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')) : null;
  const due = args.includes('--force') ? 'all' : stepsDue(o.game, stamp);
  if (!due.length) {
    console.log(`The game data is already read from this version of the game (${stamp.gameBuild}): nothing to do (--force reads anyway).`);
    process.exit(0);
  }
  try {
    const r = await buildGameData({ ...o, due, log: console.log });
    console.log(`\nGame data for ${r.gameBuild} in gamedata/ (${r.steps.length} steps run).`);
    if (r.missing.length) console.log(`Images the game files did not have:\n${r.missing.map((l) => `  ${l}`).join('\n')}`);
  } catch (e) {
    console.error(`build-gamedata: ${e.message}`);
    process.exit(1);
  }
}
