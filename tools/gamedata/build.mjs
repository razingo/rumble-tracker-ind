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
//  2. Start from the tracker's own tables (seed/: the minis' keys, colors and slot names, the talent order), which
//     the steps that build on them put in place.
//  3. Build the tables (rules, minis, army boards, events, store, PvP), then extract the images they name and no others
//     (portraits, talent and trait icons, reward and store art, currency icons, the page's frames and boards: about
//     700 small files, 5 MB).
//  4. Write gamedata.json: the game's version, and each step's version and what it made.
// A build runs only what is due. Each step has a version, made of its own script and inputs (SOURCES): after a new
// version of the tracker, the steps that changed run again. A step that uses what one of them makes runs only when
// that came out different from last time (each step's output is hashed into gamedata.json). Another version of the
// game runs them all.
// It goes easy on the PC: the programs it starts run at low priority, and only a few steps at a time.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { availableParallelism, setPriority, constants as osConstants } from 'node:os';
import { REG } from '../../server/system.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, 'seed');
const OWN_PYTHON = join(HERE, 'python', 'python.exe');
const PACKAGES = ['UnityPy==1.25.4', 'Pillow==13.0.0']; // (the versions the exe's own Python has: tools/fetch-python.mjs)
const { priority } = osConstants;
const AT_ONCE = Math.max(2, Math.min(4, availableParallelism() - 1)); // steps running side by side
const PROGRAM_MINUTES = 10; // a program still running by then hangs: it is stopped and its step fails
// What each step is made of: its script and the files it reads besides the game's (in this folder), and its settings
// below. A step's version is the contents of these, so a step changes exactly when one of them does.
// (READER: the bundle reader every table step uses; TABLES: with what the steps that read data objects share)
const READER = ['unityfs.mjs'], TABLES = [...READER, 'game_objects.mjs'], IMAGES = ['extract_reward_icons.py'];
// The tracker's own tables (seed/) a step starts from: they are put in place each time it runs.
const SEEDS = { Rules: ['rules.json'], Minis: ['minis.json', 'unit_ids.json', 'army_code_minis.json'] };
// What the table steps make, in the game data or (work:) the working folder: what a later step may read. The image
// steps' files are listed as they are made.
export const TABLE_FILES = {
  'Index of the game files': ['work:guid_index.json'],
  Rules: ['rules.json'],
  Minis: ['minis.json', 'unit_ids.json', 'army_code_minis.json', 'work:mini_art_sprites.json', 'work:mini_icons_sprites.json',
    'work:mini_talents_sprites.json'],
  'Army boards': ['minis.json'],
  Events: ['events.json', 'work:event_reward_sprites.json'],
  Store: ['store.json', 'work:store_sprites.json'],
  PvP: ['pvp.json', 'work:pvp_sprites.json', 'work:pvp_reward_sprites.json'],
};
// A step that writes into a file another step made runs whenever that one did, whatever came out of it.
const FOLLOWS = { Minis: ['Army boards'] };
// And it starts from what that one made: when it runs, that one runs first, so it never builds on its own last result.
const STARTS_FROM = { 'Army boards': ['Minis'] };
const SOURCES = {
  'Index of the game files': ['build_guid_index.mjs', ...READER],
  Rules: ['build_rules.mjs', ...TABLES, 'seed/rules.json'],
  Minis: ['build_minis.mjs', 'factions.mjs', 'family_pair_sprites.json', ...TABLES,
    ...SEEDS.Minis.map((f) => `seed/${f}`)],
  'Army boards': ['army_boards.mjs', 'factions.mjs', ...TABLES],
  Events: ['build_events.mjs', 'event_icon_sprites.json', ...TABLES],
  Store: ['build_store.mjs', ...TABLES],
  PvP: ['build_pvp.mjs', ...TABLES],
  'Event icons': ['extract_event_icons.py', 'event_icon_sprites.json'],
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
    const r = spawnSync(REG, ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
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
 * a stamp, with one from before the steps' output was hashed, or for another version of the game than the one
 * installed in `game`; else the names of the steps whose version is another now ([] when nothing is due). Without
 * the game here, data that exists stays as it is.
 */
export function stepsDue(game, stamp) {
  if (!stamp?.steps || !stamp.hashes) return 'all';
  if (!game || !existsSync(join(game, '.build.info'))) return [];
  if (stamp.gameBuild !== gameVersion(game)) return 'all';
  const now = stepVersions();
  return Object.keys(now).filter((name) => stamp.steps[name] !== now[name]);
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
 * With `ran`, `only` is where the run starts: ran(name) is called after each step that ran and tells whether what
 * the step made is different from last time. If so, the steps that wait for it run too, and so do the steps
 * `follows` names for it ({ step: [steps] }) in any case. A step nothing woke is passed over once the steps it
 * waits for are settled; the total then counts the steps not passed over so far.
 * `remade(name)` gives the steps whose output a step reads that does not last until the next run: before the step
 * runs, those that were passed over run after all.
 */
export async function runSteps(steps, { onStep = () => {}, log = () => {}, atOnce = AT_ONCE, only = null, ran = null,
  follows = {}, remade = () => [] } = {}) {
  const lines = [], running = new Map(), over = new Set(); // (over: passed over)
  const done = new Set(only && !ran ? steps.map((x) => x[0]).filter((name) => !only.has(name)) : []);
  const woken = new Set(only || []);
  let skipped = done.size, failed = null;
  while (done.size < steps.length && !failed) {
    for (let moved = true; moved;) {
      moved = false;
      for (const [label, needs, step] of steps) {
        if (done.has(label) || running.has(label) || !needs.every((n) => done.has(n))) continue;
        if (only && ran && !woken.has(label)) { // nothing it reads changed
          done.add(label);
          over.add(label);
          skipped++;
          moved = true;
          continue;
        }
        const gone = remade(label).filter((name) => over.has(name));
        if (gone.length) { // what it reads has to be made again first
          for (const name of gone) {
            done.delete(name);
            over.delete(name);
            woken.add(name);
            skipped--;
          }
          moved = true;
          continue;
        }
        if (!remade(label).every((name) => done.has(name)) || running.size >= atOnce) continue;
        log(`start  ${label}`);
        running.set(label, Promise.resolve().then(step).then(async (out) => {
          lines.push(...(out || []));
          if (ran) {
            const wakes = await ran(label) ? steps.filter((x) => x[1].includes(label)).map((x) => x[0]) : [];
            for (const name of [...wakes, ...(follows[label] || [])]) woken.add(name);
          }
          done.add(label);
          log(`done   ${label} (${done.size - skipped}/${steps.length - skipped})`);
        }).catch((e) => { failed ??= e; }).finally(() => running.delete(label)));
      }
    }
    if (!running.size) break; // all that was left was passed over
    onStep(done.size - skipped, steps.length - skipped, [...running.keys()].join(', '));
    await Promise.race(running.values());
  }
  await Promise.all(running.values());
  if (failed) throw failed;
  return lines;
}

// What a build writes down in its working folder about the folder itself, for the next build: a marker while
// everything is being built, and the sizes of the files that stay once a build is done.
const STARTED = 'started.json', SIZES = 'sizes.json';
/** The .json files under `dir` as { path from `work`: size }, without folders whose name starts with a dot (.venv). */
function sizesIn(work, dir = work, at = '') {
  const sizes = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name), name = at + e.name;
    if (e.isDirectory()) { if (!e.name.startsWith('.')) Object.assign(sizes, sizesIn(work, p, `${name}/`)); }
    else if (e.name.endsWith('.json') && name !== STARTED && name !== SIZES) sizes[name] = statSync(p).size;
  }
  return sizes;
}
/**
 * Whether a build of only some steps can go by the working folder: not when a build of everything was started there
 * and never finished, nor when a file the last build left is gone or of another size. A folder with neither marker nor
 * sizes (from an older version of the tracker, or after a build of some steps that did not finish, whose steps are
 * still due) is taken as it is.
 */
export function workWhole(work) {
  if (existsSync(join(work, STARTED))) return false;
  if (!existsSync(join(work, SIZES))) return true;
  try {
    const sizes = JSON.parse(readFileSync(join(work, SIZES), 'utf8'));
    return Object.entries(sizes).every(([f, size]) => statSync(join(work, f), { throwIfNoEntry: false })?.size === size);
  } catch {
    return false; // the sizes themselves were cut off
  }
}
/**
 * The hash of what a step made: the files and folders given (a folder with everything under it, but the parts of a
 * split step), by name and contents. A file that is not there counts as such.
 */
export async function outputHash(paths) {
  const h = createHash('sha1');
  const add = async (p, name) => {
    const s = await stat(p).catch(() => null);
    if (!s) h.update(name).update('none');
    else if (!s.isDirectory()) h.update(name).update(await readFile(p));
    else for (const f of (await readdir(p)).sort()) if (f !== 'parts') await add(join(p, f), `${name}/${f}`);
  };
  for (const p of paths) await add(p, basename(p));
  return h.digest('hex').slice(0, 12);
}

/**
 * The files an image step clears before it runs again: what it made last time (`made`: { step: [files] }), but a file
 * it no longer lists (`now`) that another step made too. Two steps may share a picture, and that one is still shown.
 */
export function leftBy(made, step, now) {
  const others = new Set(Object.entries(made).filter(([name]) => name !== step).flatMap(([, files]) => files));
  return (made[step] || []).filter((f) => now.includes(f) || !others.has(f));
}

/** A build begins in `work`: the sizes no longer hold, and a build of everything (`all`) leaves its marker. */
export function openWork(work, all) {
  mkdirSync(work, { recursive: true });
  rmSync(join(work, SIZES), { force: true });
  if (all) writeFileSync(join(work, STARTED), '{}\n');
}
/** A build is done in `work`: the sizes of what it leaves are written down, then the marker goes. */
export function closeWork(work) {
  writeFileSync(join(work, SIZES), JSON.stringify(sizesIn(work), null, 1) + '\n');
  rmSync(join(work, STARTED), { force: true });
}

/**
 * Throws when the tables in `dir` are plainly broken: a game patch may change the game's files so that a builder
 * finds nothing and still ends well. Then the read fails, and the data the tracker had stays. Only what no patch
 * does is refused: far fewer minis than the tracker knows IDs for (a few may be missing: the tracker can know a
 * mini before the installed game has it), a mini without a name or portrait, an empty table, no level rules.
 */
const MINIS_FOUND = 0.9; // the share of the known minis a read must find
export function checkTables(dir) {
  const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const size = (x) => (Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0);
  const problems = [];
  try {
    const minis = read('minis.json').minis || [];
    const known = new Set(Object.values(read('unit_ids.json').units || {})).size;
    if (!minis.length || minis.length < MINIS_FOUND * known) problems.push(`${minis.length} minis, where ${known} are known`);
    const bare = minis.filter((m) => !m.name || !m.art);
    if (bare.length) problems.push(`${bare.length} minis without a name or portrait (${bare.slice(0, 3).map((m) => m.slug).join(', ')})`);
    const rules = read('rules.json');
    if (!size(rules.xpToNext) || !size(rules.rarityUpgrade)) problems.push('no level or upgrade rules');
    if (!size(read('army_code_minis.json').shortIds)) problems.push('no army code numbers');
    if (!size(read('events.json').events)) problems.push('no events');
    if (!size(read('store.json').offers)) problems.push('no shop offers');
    if (!size(read('pvp.json').ranks)) problems.push('no PvP ranks');
  } catch (e) {
    problems.push(e.message);
  }
  if (problems.length) throw new Error(`The tables read from the game are not usable: ${problems.join('; ')}.`);
}

/**
 * Builds the game data into `out`, with its working files (and Python's environment) in `work`. `due` is what to
 * build: 'all', or the names of steps (from stepsDue), which then run on top of the data `out` already holds; a step
 * that waits for one of them runs when what that one made came out different from last time.
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
  // some steps need what earlier ones left in the working folder: without it, or with it half made, everything is built
  if (due !== 'all' && !(before?.made && before.hashes && existsSync(join(work, 'guid_index.json')) && workWhole(work))) due = 'all';
  openWork(work, due === 'all');
  const made = due === 'all' ? {} : { ...before.made }; // step -> the image files it wrote, to clear before it runs again
  const hashes = due === 'all' ? {} : { ...before.hashes }; // step -> the hash of what it made
  if (due === 'all') { // everything is built anew: the image folders go, so nothing unused stays
    rmSync(stampFile, { force: true });
    for (const e of readdirSync(out, { withFileTypes: true })) if (e.isDirectory()) rmSync(join(out, e.name), { recursive: true });
  }
  const env = { ...process.env, RUMBLE_BUNDLES: bundles, RUMBLE_GAMEDATA: out, RUMBLE_WORK: work };
  // Python is set up once, by whichever step asks first
  let ready = null;
  const py = () => (ready ??= python(work, log));
  const QUIET = { background: true };
  // (a table step starts from the tracker's own tables each time, so it makes the same whatever was there before)
  const table = (file, ...a) => () => runScript(join(HERE, file), a, env);
  const seeded = (step, file) => () => {
    for (const f of SEEDS[step]) copyFileSync(join(SEED, f), join(out, f));
    return table(file)();
  };
  const listed = (dir, own = /./) => readdirSync(join(out, dir)).filter((f) => own.test(f)).sort().map((f) => `${dir}/${f}`);
  // An image step: the sprites a list names, into a folder. The list is beside the scripts when kept by hand, in the
  // working folder when a table builder wrote it. What the step wrote last time goes first, so nothing unused stays
  // and nothing old is taken for new.
  const images = (step) => async () => {
    const [dir, list, size, prefer] = IMAGE_STEPS[step];
    const listFile = join(existsSync(join(HERE, list)) ? HERE : work, list);
    const names = JSON.parse(readFileSync(listFile, 'utf8'));
    const now = (Array.isArray(names) ? names : Object.keys(names))
      .map((n) => `${dir}/${n.endsWith('.png') ? n : `${n}.webp`}`);
    for (const f of leftBy(made, step, now)) rmSync(join(out, f), { force: true });
    made[step] = now;
    return runProgram(await py(), ['-I', join(HERE, 'extract_reward_icons.py'), join(out, dir), listFile, size,
      ...(prefer ? [prefer] : [])], env, QUIET);
  };
  // [name, the steps it waits for, what it does]. Steps that do not wait for each other run side by side: the tables
  // are built while Python is set up, and each kind of image is extracted as soon as its table has named them.
  const steps = [
    ['Python', [], async () => { await py(); return []; }],
    ['Index of the game files', [], table('build_guid_index.mjs')],
    ['Rules', [], seeded('Rules', 'build_rules.mjs')],
    ['Minis', [], seeded('Minis', 'build_minis.mjs')],
    ['Army boards', ['Index of the game files', 'Minis'], table('army_boards.mjs', join(work, 'guid_index.json'), '--write')],
    ['Events', ['Minis'], table('build_events.mjs')], // (it names reward minis by the keys Minis may add)
    ['Store', [], table('build_store.mjs')],
    ['PvP', ['Index of the game files'], table('build_pvp.mjs')],
    ['Event icons', ['Python'], async () => {
      rmSync(join(out, 'events'), { recursive: true, force: true });
      const lines = await runProgram(await py(), ['-I', join(HERE, 'extract_event_icons.py'), join(out, 'events')], env, QUIET);
      made['Event icons'] = listed('events');
      return lines;
    }],
    ['Event rewards', ['Python', 'Events'], images('Event rewards')],
    ['Store art', ['Python', 'Store'], images('Store art')],
    ['Portraits', ['Python', 'Minis'], images('Portraits')],
    ['Talent icons', ['Python', 'Minis'], images('Talent icons')],
    ['Trait icons', ['Python', 'Minis'], images('Trait icons')],
    ['Leader and Wildcard icons', ['Python'], images('Leader and Wildcard icons')],
    ['Family pair icons', ['Python'], images('Family pair icons')],
    ['Currency icons', ['Python'], images('Currency icons')],
    ['PvP icons', ['Python', 'PvP'], images('PvP icons')],
    ['PvP rewards', ['Python', 'PvP'], images('PvP rewards')],
    // the page's own art: wood, key art and army boards as they are; the card frames are cut out of the game's slot
    // backgrounds (make_card_frames.py)
    ['Interface art', ['Python'], images('Interface art')],
    // (the Cenarion army board is made from the interface art's Alliance one)
    ['Card frames', ['Python', 'Interface art'], async () => {
      const slots = join(work, 'frames');
      rmSync(slots, { recursive: true, force: true });
      const own = /^(frame-|fill-mask|board-cenarion)/; // what this step makes
      for (const f of readdirSync(join(out, 'ui'), { withFileTypes: true }).filter((e) => own.test(e.name))) {
        rmSync(join(out, 'ui', f.name));
      }
      await runProgram(await py(), ['-I', join(HERE, 'extract_reward_icons.py'), slots, join(HERE, 'frame_sprites.json'), FRAME_SIZE],
        env, QUIET);
      const lines = await runProgram(await py(), ['-I', join(HERE, 'make_card_frames.py'), slots, join(out, 'ui')], env, QUIET);
      rmSync(slots, { recursive: true, force: true }); // (only needed to cut the frames from)
      made['Card frames'] = listed('ui', own);
      return lines;
    }],
  ];
  const only = due === 'all' ? null : new Set(due);
  if (only) log(`Due: ${due.join(', ')}`);
  // (two image steps may share a folder that neither has made yet)
  for (const dir of ['ui', 'icons', 'rewards']) mkdirSync(join(out, dir), { recursive: true });
  // After a step: the hash of what it made, and whether that is another than last time's.
  const ran = [];
  const hashed = async (step) => {
    ran.push(step);
    const last = hashes[step];
    hashes[step] = await outputHash(TABLE_FILES[step]?.map((f) => (f.startsWith('work:') ? join(work, f.slice(5)) : join(out, f)))
      ?? (made[step] || []).map((f) => join(out, f)));
    return hashes[step] !== last;
  };
  const missing = (await runSteps(steps, { onStep, log, only, ran: hashed, follows: FOLLOWS,
    remade: (step) => STARTS_FROM[step] || [] }))
    .filter((l) => /NOT FOUND/.test(l)).map((l) => l.trim());

  checkTables(out);
  // the stamp: what the tracker reads to know the data is whole, and what a later build goes by
  const dataVersion = new Date().toISOString();
  writeFileSync(stampFile, JSON.stringify({ format: 3, gameBuild: build, dataVersion, steps: stepVersions(), made, hashes }, null, 1)
    + '\n');
  closeWork(work);
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
    // (without the game, stepsDue keeps the data there is: that is not the same as having nothing to do)
    if (!o.game || !existsSync(join(o.game, '.build.info'))) {
      const where = o.game ? `in ${o.game}` : 'on this PC';
      console.error(`build-gamedata: Warcraft Rumble was not found ${where}. The game data there is (${stamp.gameBuild}) was kept.`);
      process.exit(1);
    }
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
