// Checks what skipping steps of the game-data build relies on (tools/gamedata/build.mjs): builds the game data twice,
// each time from nothing, and compares every file. A file that differs means a step does not make the same from the
// same input, so its hash would wake the steps after it for nothing. Then every file of a build must belong to a
// step: a file no step is known to make could change without the steps that read it running again.
// It needs the game, so it is run by hand, not in CI:
//   npm run check-gamedata [-- <game folder>]      (about two minutes)
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { buildGameData, findGame, TABLE_FILES } from './gamedata/build.mjs';

const STAMP = 'gamedata.json';
/** { path: SHA-1 } for every file under `dir`, but Python's own folder. */
async function hashes(dir, base = dir, out = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) await hashes(p, base, out); }
    else out[relative(base, p).split(sep).join('/')] = createHash('sha1').update(await readFile(p)).digest('hex');
  }
  return out;
}

const dir = await mkdtemp(join(tmpdir(), 'rumble-check-'));
let code = 0;
try {
  const runs = [];
  for (const n of [1, 2]) {
    const out = join(dir, `out-${n}`), work = join(dir, `work-${n}`), started = Date.now();
    console.log(`Build ${n} of 2`);
    await buildGameData({ game: findGame(process.argv[2]), out, work });
    const stamp = JSON.parse(await readFile(join(out, STAMP), 'utf8'));
    runs.push({ out: await hashes(out), work: await hashes(work), stamp });
    console.log(`  ${Object.keys(runs.at(-1).out).length} files in ${Math.round((Date.now() - started) / 1000)} s`);
  }
  const [a, b] = runs;
  // the same twice (the stamp holds the time: its steps' hashes are compared instead)
  const differ = [];
  for (const kind of ['out', 'work']) {
    for (const f of new Set([...Object.keys(a[kind]), ...Object.keys(b[kind])])) {
      if (a[kind][f] !== b[kind][f] && f !== STAMP) differ.push(kind === 'out' ? f : `(working folder) ${f}`);
    }
  }
  for (const step of Object.keys(a.stamp.hashes)) if (a.stamp.hashes[step] !== b.stamp.hashes[step]) differ.push(`(the hash of) ${step}`);
  if (differ.length) {
    console.error(`${differ.length} differ between the two builds:\n${differ.sort().map((f) => `  ${f}`).join('\n')}`);
    code = 1;
  } else console.log(`Both builds gave the same ${Object.keys(a.out).length} files.`);
  // every file is some step's
  const tables = Object.values(TABLE_FILES).flat();
  const known = new Set([STAMP, ...tables.filter((f) => !f.startsWith('work:')), ...Object.values(a.stamp.made).flat()]);
  const working = new Set(['sizes.json', ...tables.filter((f) => f.startsWith('work:')).map((f) => f.slice(5))]);
  const nobodys = [...Object.keys(a.out).filter((f) => !known.has(f)),
    ...Object.keys(a.work).filter((f) => !working.has(f)).map((f) => `(working folder) ${f}`)];
  if (nobodys.length) {
    console.error(`${nobodys.length} files that no step is known to make:\n${nobodys.sort().map((f) => `  ${f}`).join('\n')}`);
    code = 1;
  } else console.log('Every file belongs to a step.');
} catch (e) {
  console.error(`check-gamedata: ${e.message}`);
  code = 1;
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => {});
}
process.exit(code);
