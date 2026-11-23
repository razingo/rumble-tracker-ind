// List every Gryphon.Data.Mini (guid + internal name) from the unitdata_* bundles with its save-data ID, and the
// tracker slug for the ones already in unit_ids.json. Run by extract.mjs: node all_minis.mjs <out.json>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBundle } from '../gamedata/unityfs.mjs';

const PERM = [8, 9, 10, 11, 12, 13, 14, 15, 4, 5, 6, 7, 0, 1, 2, 3, 30, 31, 28, 29, 26, 27, 24, 25, 22, 23, 20, 21, 18, 19, 16, 17];
const INV = []; PERM.forEach((j, i) => { INV[j] = i; });
const toId = (guid) => INV.map((i) => guid[i]).join('');

const dir = process.env.RUMBLE_BUNDLES;
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name);
  if (e.isDirectory()) walk(p); else if (/unitdata_.*\.bundle$/.test(e.name)) files.push(p); } };
walk(dir);

const minis = new Map();
for (const file of files) {
  let b; try { b = readBundle(file); } catch { continue; }
  for (const f of b.files) {
    const text = f.data.toString('latin1');
    for (const m of text.matchAll(/"guid":\s*"([0-9a-f]{32})",\s*"name":\s*"([^"]+_Mini)"/g)) {
      const before = text.lastIndexOf('"$type"', m.index);
      const type = before >= 0 ? /"\$type":\s*"([^",]+)/.exec(text.slice(before, before + 200))?.[1] : '';
      if (type && !/Gryphon\.Data\.Mini\b/.test(type)) continue;
      minis.set(m[1], { guid: m[1], id: toId(m[1]), internal: m[2].replace(/_Mini$/, ''), bundle: file.split(/[\\/]/).pop() });
    }
  }
}
const known = JSON.parse(readFileSync(join(process.env.RUMBLE_GAMEDATA, 'unit_ids.json'), 'utf8')).units;
const results = [...minis.values()].map((m) => ({ ...m, slug: known[m.id] || null }));
console.log(`unitdata bundles: ${files.length}, mini definitions: ${results.length}, in the tracker: ${results.filter((r) =>
  r.slug).length}`);
writeFileSync(process.argv[2], JSON.stringify(results.sort((a, b) => a.internal.localeCompare(b.internal)), null, 2));
