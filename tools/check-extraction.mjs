// Checks that the additional data comes out the same on every run: extracts it twice, each time from nothing, and
// compares every file. A file that differs means a script draws or picks by chance, or by which step finished first.
// Pictures the graphics card drew may differ in a few pixels by its rounding; those are told apart from real
// differences and do not fail the check.
// It needs the game and the game data (npm run build-gamedata), so it is run by hand, not in CI:
//   npm run check-extraction [-- <game folder>]      (about four minutes)
import { mkdtemp, readdir, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRdmodule } from './rdmodule/extract.mjs';
import { python, runProgram } from './gamedata/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gamedata = join(ROOT, 'gamedata');
if (!existsSync(join(gamedata, 'minis.json'))) {
  console.error('check-extraction: no game data in gamedata/. Run  npm run build-gamedata  first.');
  process.exit(1);
}
// Rounding: at most this share of a picture's pixels differ, none by more than this much (of 255) in a channel.
const ROUNDING = { pixels: 0.001, by: 32 };
// Prints "same", "rounding" or "differs" for each pair of pictures named on its command line.
const COMPARE = `import sys
from PIL import Image, ImageChops
for a, b in zip(sys.argv[3::2], sys.argv[4::2]):
    x, y = Image.open(a).convert("RGBA"), Image.open(b).convert("RGBA")
    if x.size != y.size: print("differs"); continue
    r, g, bl, al = ImageChops.difference(x, y).split()
    worst = ImageChops.lighter(ImageChops.lighter(r, g), ImageChops.lighter(bl, al)).histogram()  # per pixel
    pixels, most = sum(worst[1:]), max(i for i, n in enumerate(worst) if n)
    few = pixels <= float(sys.argv[1]) * x.size[0] * x.size[1] and most <= int(sys.argv[2])
    print("same" if not pixels else "rounding" if few else "differs")
`;

/** { path: SHA-1 } for every file under `dir`, but the stamp, which holds the time. */
async function hashes(dir, base = dir, out = {}) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await hashes(p, base, out);
    else if (e.name !== 'ready.json') {
      out[relative(base, p).split(sep).join('/')] = createHash('sha1').update(await readFile(p)).digest('hex');
    }
  }
  return out;
}

const dir = await mkdtemp(join(tmpdir(), 'rumble-check-'));
let code = 0;
try {
  const runs = [];
  for (const n of [1, 2]) {
    const out = join(dir, `out-${n}`), started = Date.now();
    console.log(`Extraction ${n} of 2`);
    await extractRdmodule({ gameFolder: process.argv[2] || '', gamedata, out, work: join(dir, `work-${n}`), all: true,
      log: (line) => { if (/not drawn|nothing for|missing|no sound banks/.test(line)) console.log(line); } });
    runs.push(await hashes(out));
    console.log(`  ${Object.keys(runs.at(-1)).length} files in ${Math.round((Date.now() - started) / 1000)} s`);
  }
  const [a, b] = runs;
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  let differ = names.filter((f) => a[f] !== b[f]);
  // the pictures among them: by how much?
  const pictures = differ.filter((f) => f.endsWith('.png') && f in a && f in b);
  let rounded = [];
  if (pictures.length) {
    const script = join(dir, 'compare.py');
    await writeFile(script, COMPARE);
    const verdicts = await runProgram(await python(join(dir, 'work-1'), console.log), ['-I', script, String(ROUNDING.pixels),
      String(ROUNDING.by), ...pictures.flatMap((f) => [join(dir, 'out-1', f), join(dir, 'out-2', f)])], process.env);
    rounded = pictures.filter((f, i) => verdicts[i] === 'rounding');
    differ = differ.filter((f) => !rounded.includes(f));
  }
  if (rounded.length) console.log(`${rounded.length} pictures differ only by the graphics card's rounding, in a few pixels.`);
  if (differ.length) {
    console.error(`${differ.length} of ${names.length} files differ between the two extractions:`);
    for (const f of differ) console.error(`  ${f}${f in a ? '' : ' (only in the second)'}${f in b ? '' : ' (only in the first)'}`);
    // both versions of each are kept, to look at
    const kept = join(tmpdir(), 'rumble-check-differences');
    await rm(kept, { recursive: true, force: true });
    for (const f of differ) {
      for (const n of [1, 2]) {
        await cp(join(dir, `out-${n}`, f), join(kept, `${n}`, f), { recursive: true }).catch(() => {});
      }
    }
    console.error(`Both versions are in ${kept}`);
    code = 1;
  } else console.log(`Both extractions gave the same ${names.length} files${rounded.length ? ', apart from those' : ''}.`);
} catch (e) {
  console.error(`check-extraction: ${e.message}`);
  code = 1;
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => {});
}
process.exit(code);
