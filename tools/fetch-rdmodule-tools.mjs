// Fetches what the rdmodule's extraction needs besides Python, into tools/rdmodule/vendor/ (the exe carries
// it):   npm run fetch-rdmodule-tools
//
// - three.js (MIT), which the render pages draw the 3D models with: the module and the few add-ons they import, from
//   the npm package through jsDelivr.
// - vgmstream (ISC, with the codec libraries it ships), which decodes the game's Wwise audio: the command-line build
//   from its GitHub release.
// Versions and SHA-256 checksums are pinned.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TAR } from '../server/system.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'tools', 'rdmodule', 'vendor');
const THREE = '0.187.0';
const THREE_FILES = {
  'build/three.module.js': '104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341',
  'build/three.core.js': '613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578',
  'examples/jsm/loaders/OBJLoader.js': '355484026ac163fdeceececaa943b0473a2e169444015cd2209cc7d27b5b894d',
  'examples/jsm/loaders/GLTFLoader.js': '532ac726e120039acbcd6cf54328c57acbf7b438176afaa6951257126d11bff1',
  'examples/jsm/utils/BufferGeometryUtils.js': '7bda2a8ba836b2bcf67cb938d4b9e1bb5d1b1bc616817103ed858c0b58296ce7',
  'examples/jsm/utils/SkeletonUtils.js': 'b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f',
  'examples/jsm/controls/OrbitControls.js': 'e7fca2fe9e7670a828af9b28084669a5909445b7f36f1f26cee9bf8f2961c32c',
  LICENSE: '8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc',
};
const VGM = 'r2168';
const VGM_SHA256 = '692d45070852a35c1fa42726aa3c9de528e44eec925d37d99b1074256b99a229';

const fail = (msg) => { console.error(`fetch-rdmodule-tools: ${msg}`); process.exit(1); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
async function get(url, sum) {
  const r = await fetch(url);
  if (!r.ok) fail(`${url} answered ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha256(buf) !== sum) fail(`${url} does not have the pinned SHA-256.`);
  return buf;
}

console.log(`three.js ${THREE}`);
for (const [file, sum] of Object.entries(THREE_FILES)) {
  const to = path.join(VENDOR, 'three', ...file.split('/'));
  if (existsSync(to) && sha256(readFileSync(to)) === sum) continue;
  mkdirSync(path.dirname(to), { recursive: true });
  writeFileSync(to, await get(`https://cdn.jsdelivr.net/npm/three@${THREE}/${file}`, sum));
}

console.log(`vgmstream ${VGM}`);
const zip = path.join(os.tmpdir(), `vgmstream-${VGM}-win64.zip`);
if (!existsSync(zip) || sha256(readFileSync(zip)) !== VGM_SHA256) {
  writeFileSync(zip, await get(`https://github.com/vgmstream/vgmstream/releases/download/${VGM}/vgmstream-win64.zip`, VGM_SHA256));
}
const dir = path.join(VENDOR, 'vgmstream');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
if (spawnSync(TAR, ['-xf', zip, '-C', dir], { stdio: 'inherit' }).status !== 0) fail('could not unpack vgmstream.');
if (!existsSync(path.join(dir, 'vgmstream-cli.exe'))) fail('the vgmstream package has no vgmstream-cli.exe.');
// what was fetched, for the versions of the steps that use it (tools/rdmodule/extract.mjs)
writeFileSync(path.join(VENDOR, 'versions.json'), JSON.stringify({ three: THREE, vgmstream: VGM }, null, 1) + '\n');
console.log('Ready in tools/rdmodule/vendor.');
