// Index every GUID -> { name, type, bundle } found in the game's JSON data objects (used by army_boards.mjs and
// build_pvp.mjs). usage: node build_guid_index.mjs [out.json]   (default: guid_index.json in the working folder)
import { writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle, bundleFiles } from './unityfs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = process.env.RUMBLE_WORK || HERE; // working files passed between the steps
const OUT = process.argv[2] || join(WORK, 'guid_index.json');
const DIR = process.env.RUMBLE_BUNDLES;
const all = bundleFiles(DIR);
const idx = {};
for (const p of all) {
  let b; try { b = readBundle(p); } catch { continue; }
  for (const f of b.files) {
    if (f.data.length > 0x10000000 || f.data.indexOf('"guid"') < 0) continue;
    const text = f.data.toString('latin1');
    for (const m of text.matchAll(/"\$type":\s*"([^"]+)"[^{}]{0,400}?"guid":\s*"([0-9a-f]{32})",\s*"name":\s*"([^"]+)"/g)) {
      idx[m[2]] ||= { name: m[3], type: m[1].replace(/^Gryphon\.Data\./, ''), bundle: basename(p) };
    }
    for (const m of text.matchAll(/"guid":\s*"([0-9a-f]{32})",\s*"name":\s*"([^"]+)"/g)) idx[m[1]] ||= { name: m[2],
      type: '?', bundle: basename(p) };
  }
}
writeFileSync(OUT, JSON.stringify(idx));
console.log(all.length, 'bundles,', Object.keys(idx).length, 'guids ->', OUT);
