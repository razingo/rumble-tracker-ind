// Prepares the private Python the exe carries (tools/gamedata/python/), so the PC that runs the exe needs
// neither Python nor an internet connection:   npm run fetch-python
//
// 1. Python's "embeddable package" from python.org (version and SHA-256 pinned).
// 2. The packages the image steps use, in pinned versions, from PyPI into its Lib\site-packages. They are fetched with
//    a Python on this PC (any 3.x; only its pip is used), as ready-made builds for the pinned Python.
// 3. An empty stand-in for fmod_toolkit: UnityPy imports it for audio, which the tracker never reads, and the real
//    package carries FMOD's own libraries, which are not ours to pass on.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TAR } from '../server/system.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'gamedata', 'python');
const VERSION = '3.14.10';
const SHA256 = '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159';
const URL_ZIP = `https://www.python.org/ftp/python/${VERSION}/python-${VERSION}-embed-amd64.zip`;
const TAG = `cp${VERSION.split('.').slice(0, 2).join('')}`; // cp314
// ready-made builds exist for all of these
const PACKAGES = ['UnityPy==1.25.4', 'pillow==13.0.0', 'lz4==4.4.5', 'brotli==1.2.1', 'texture2ddecoder==1.0.6', 'etcpak==0.9.15',
  'astc-encoder-py==0.1.12', 'archspec==0.2.8', 'fsspec==2026.9.0', 'attrs==26.1.0'];
// published as source only (plain Python, so any Python can build it)
const FROM_SOURCE = ['tpk_ar==0.2.4'];

const fail = (msg) => { console.error(`fetch-python: ${msg}`); process.exit(1); };
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// 1. the embeddable package
const zip = path.join(os.tmpdir(), `python-${VERSION}-embed-amd64.zip`);
if (!existsSync(zip) || sha256(zip) !== SHA256) {
  console.log(`Downloading Python ${VERSION} (embeddable package)`);
  const r = await fetch(URL_ZIP);
  if (!r.ok) fail(`python.org answered ${r.status} for ${URL_ZIP}`);
  writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
}
if (sha256(zip) !== SHA256) {
  rmSync(zip);
  fail('the downloaded package does not have the pinned SHA-256.');
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
if (spawnSync(TAR, ['-xf', zip, '-C', OUT], { stdio: 'inherit' }).status !== 0) fail('could not unpack the package.');
// the embeddable Python only looks where its ._pth file says
const site = path.join(OUT, 'Lib', 'site-packages');
mkdirSync(site, { recursive: true });
const pth = readdirSync(OUT).find((f) => f.endsWith('._pth'));
writeFileSync(path.join(OUT, pth), `${readFileSync(path.join(OUT, pth), 'utf8').trim()}\nLib\\site-packages\n`);

// 2. the packages
const pip = [['py', ['-3']], ['python', []]].find(([cmd, a]) => spawnSync(cmd, [...a, '-m', 'pip', '--version']).status === 0);
if (!pip) fail('needs a Python 3 with pip on this PC to fetch the packages (the exe built afterwards needs none).');
const install = (...a) => {
  const r = spawnSync(pip[0], [...pip[1], '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--target', site, ...a],
    { stdio: 'inherit' });
  if (r.status !== 0) fail('pip could not fetch the packages (see above).');
};
install('--only-binary=:all:', '--python-version', VERSION.split('.').slice(0, 2).join('.'), '--platform', 'win_amd64',
  '--implementation', 'cp', '--abi', TAG, '--abi', 'abi3', '--abi', 'none', ...PACKAGES);
install(...FROM_SOURCE);

// 3. the stand-in
mkdirSync(path.join(site, 'fmod_toolkit'));
writeFileSync(path.join(site, 'fmod_toolkit', '__init__.py'),
  '"""Stand-in for fmod_toolkit: UnityPy imports it for audio, which the tracker never reads."""\n');

// What is not needed to read images goes, to keep the exe small: caches and pip's launchers, the compiler's
// leftovers in astc_encoder, Pillow's AVIF codec, and Python's own network and database libraries.
const UNUSED = /^(_avif\..*|.*\.iobj|.*\.ipdb|_ssl\.pyd|libssl-.*\.dll|libcrypto-.*\.dll|_sqlite3\.pyd|sqlite3\.dll|pythonw\.exe)$/;
const prune = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name === '__pycache__' || e.name === 'bin') rmSync(p, { recursive: true }); else prune(p); }
    else if (UNUSED.test(e.name)) rmSync(p);
  }
};
prune(OUT);

// What was installed, for the versions of the steps that use it (tools/gamedata/build.mjs, pythonVersions)
writeFileSync(path.join(OUT, 'versions.json'), JSON.stringify({ python: VERSION,
  packages: Object.fromEntries([...PACKAGES, ...FROM_SOURCE].map((p) => p.split('=='))) }, null, 1) + '\n');

// it must be able to do its job
const exe = path.join(OUT, 'python.exe');
const check = spawnSync(exe, ['-I', '-c',
  'import UnityPy, PIL; from UnityPy.export import Texture2DConverter; print(UnityPy.__version__)'], { encoding: 'utf8' });
if (check.status !== 0) fail(`the prepared Python cannot load its packages:\n${check.stderr}`);
let size = 0, count = 0;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { size += statSync(p).size; count++; }
  }
};
walk(OUT);
console.log(`\nPython ${VERSION} with UnityPy ${check.stdout.trim()} in tools/gamedata/python`
  + ` (${count} files, ${(size / 1048576).toFixed(0)} MB).`);
