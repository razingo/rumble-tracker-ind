// Fetches what the rdmodule's extraction needs besides Python, into tools/rdmodule/vendor/ (a self-built exe carries
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'tools', 'rdmodule', 'vendor');
const THREE = '0.160.0';
const THREE_FILES = {
  'build/three.module.js': '76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495',
  'examples/jsm/loaders/OBJLoader.js': '022e0334f837c60506276e136faf3e54b21b20aea672eed4a0c50651d4fc0a5d',
  'examples/jsm/loaders/GLTFLoader.js': 'd073b438e6a07e1359741dd5d6c76c953420cc0d4fd84eb1bdde94315540e6a3',
  'examples/jsm/utils/BufferGeometryUtils.js': '9be041e96308775d00e2695cc607645b9a9b64fd7c0e759dd8f7c00a8d92becb',
  'examples/jsm/controls/OrbitControls.js': '5a44a9e86a2a0fb11933eed69bc2cd33c76a496854c1aed6ed776efa87d7b064',
  LICENSE: '852e0e8699169bf9f6fdc6bda3e682d078dcbc738b5d33e74df594721bff271d',
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
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
if (spawnSync(tar, ['-xf', zip, '-C', dir], { stdio: 'inherit' }).status !== 0) fail('could not unpack vgmstream.');
if (!existsSync(path.join(dir, 'vgmstream-cli.exe'))) fail('the vgmstream package has no vgmstream-cli.exe.');
console.log('Ready in tools/rdmodule/vendor.');
