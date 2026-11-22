// Downloads the game data into gamedata/: npm run fetch-gamedata [-- --force] [-- <pack address>]
//
// The game data is published as a signed data pack in razingo/rumble-tracker-data. It is installed with the app's own
// installer (server/datapack/datapack.mjs), which checks the Ed25519 signature and then each file's SHA-256. Matching
// local files are reused. Run before `npm start` or `npm run build-release`. An older pack never replaces newer local
// data; --force reinstalls the published pack.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateDataPack } from '../server/datapack/datapack.mjs';
import { PACK_URL } from '../server/datapack/pack-keys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'gamedata');

const args = process.argv.slice(2);
const force = args.includes('--force');
const base = args.find((a) => !a.startsWith('--')) || process.env.RUMBLE_DATA_PACK_URL || PACK_URL;

const current = force ? null : await readFile(path.join(DIR, 'gamedata.json'), 'utf8').then(JSON.parse, () => null);
console.log(`Game data from ${base}`);
try {
  const r = await updateDataPack({ base, current, dir: DIR, staticDir: DIR });
  if (r.updated) {
    console.log(`Installed in gamedata/: game build ${r.manifest.gameBuild}, data version ${r.manifest.dataVersion}`
      + ` (${Object.keys(r.manifest.files).length} files, ${r.downloaded} downloaded).`);
  } else if (r.reason === 'up to date') {
    console.log(`gamedata/ is up to date (game build ${current.gameBuild}, data version ${current.dataVersion}).`);
  } else {
    console.error(`Not installed: ${r.reason}.`);
    process.exit(1);
  }
} catch (e) {
  console.error(`Could not fetch the game data: ${e.message}`);
  process.exit(1);
}
