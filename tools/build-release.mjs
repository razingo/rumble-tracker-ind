// Builds the Windows release: npm run build-release (Windows, Node.js 25.5+ for --build-sea).
//
// Output in dist/release/:
//   RumbleTracker.exe                     Node.js runtime, launcher and app files
//   RumbleTracker-<version>-win-x64.zip   exe, README, LICENSE, NOTICE, and in THIRD-PARTY-NOTICES the licenses of
//                                         everything the exe carries: Node.js, WebView2, the fonts, Python and its
//                                         packages
//   SHA256SUMS.txt                        checksums of the zip and the exe
//
// Only what APP_FILES lists is bundled. No game data is: the exe reads it from the game install, with the builder in
// tools/gamedata and its own Python (npm run fetch-python).
import { readFile, writeFile, mkdir, rm, readdir, stat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../server/update/appupdate.mjs';
import { POWERSHELL } from '../server/platform/windows/system.mjs';
import { APP_NAME, EXE_NAME, REPO } from '../web/scripts/lib/constants.js';
import { megabytes } from '../web/scripts/lib/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const OUT = path.resolve(ROOT, process.env.RUMBLE_RELEASE_OUT || path.join('dist', 'release'));
const BUILD = path.join(OUT, 'build');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const fail = (msg) => {
  console.error(`build-release: ${msg}`);
  process.exit(1);
};

// Checks before building
if (process.platform !== 'win32') fail('build on Windows (the exe is made from this Node.js binary).');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) fail(`needs Node.js 25.5 or newer for --build-sea (this is ${process.versions.node}).`);
// In GitHub Actions, players' issues and updates must point at the repository that builds the release.
if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== REPO) {
  fail(`REPO in web/scripts/lib/constants.js is ${REPO}, but this build runs in ${process.env.GITHUB_REPOSITORY}.`);
}
const nodeLicense = path.join(DESKTOP, 'node-LICENSE.txt');
try {
  await stat(nodeLicense);
} catch {
  fail('desktop/node-LICENSE.txt is missing (Node.js license, must ship with the exe).');
}
// The window's WebView2 libraries, bundled, and their license, which goes into the zip (npm run fetch-webview2)
const WEBVIEW2 = path.join(DESKTOP, 'webview2');
const WEBVIEW2_LIBS = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
for (const file of [...WEBVIEW2_LIBS, 'LICENSE.txt', 'NOTICE.txt']) {
  try {
    await stat(path.join(WEBVIEW2, file));
  } catch {
    fail(`desktop/webview2/${file} is missing: run  npm run fetch-webview2  first.`);
  }
}

// The app's files
// [folder, allowed extensions (null: every file)]
const APP_FILES = [
  ['server', ['.mjs']],
  ['web', ['.html', '.js', '.css', '.ico', '.woff2', '.txt']],
  // PowerShell scripts the launcher runs: the window and tray icon, Windows integration and uninstalling
  ['desktop/window.ps1', []],
  ['desktop/LilitaOne-Regular.ttf', []], // the title bar's font
  ['desktop/integration.ps1', []],
  ['desktop/uninstall.ps1', []],
  ...WEBVIEW2_LIBS.map((lib) => [`desktop/webview2/${lib}`, []]),
];
// The game-data builder (its working folder, tools/gamedata/work, and what Python leaves behind when the scripts are
// run from source have no place in the exe; of its Python every file goes in)
{
  try {
    await stat(path.join(ROOT, 'tools', 'gamedata', 'python', 'python.exe'));
  } catch {
    fail('tools/gamedata/python is missing: run  npm run fetch-python  first.');
  }
  for (const e of await readdir(path.join(ROOT, 'tools', 'gamedata'), { withFileTypes: true })) {
    if (e.name === 'python') APP_FILES.push(['tools/gamedata/python', null]);
    else if (e.name !== 'work' && e.name !== '__pycache__') APP_FILES.push([`tools/gamedata/${e.name}`, ['.mjs', '.py', '.json']]);
  }
}
async function walk(rel, exts) {
  const abs = path.join(ROOT, rel);
  if (!(await stat(abs)).isDirectory()) return [rel];
  const out = [];
  for (const e of await readdir(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.name === '__pycache__') continue; // Python's own leftovers
    if (e.isDirectory()) out.push(...await walk(r, exts));
    else if (!exts || exts.includes(path.extname(e.name).toLowerCase())) out.push(r);
    else console.log(`  left out: ${r}`);
  }
  return out;
}
const files = [];
for (const [rel, exts] of APP_FILES) for (const r of await walk(rel, exts)) files.push([r, await readFile(path.join(ROOT, r))]);
files.sort((a, b) => a[0].localeCompare(b[0]));
// Minimal package.json (version) and the launcher's import helper.
// (official: built by this repository's release workflow. Only such an exe replaces itself with a newer release; one
// built by hand is told about it and left as it is.)
const official = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === REPO;
files.push(['package.json', Buffer.from(JSON.stringify({ name: pkg.name, version, private: true, type: 'module',
  ...(official ? { official: true } : {}) }, null, 2) + '\n')]);
files.push(['import.cjs', Buffer.from("// Loaded by the exe's launcher: a single executable can only import ES "
  + "modules through a file on disk.\nmodule.exports = (url) => import(url);\n")]);

// One blob: [u32 index length][index JSON][file bytes, deflated together]
let offset = 0;
const index = { version, hash: '', deflated: true, files: [] };
for (const [rel, buf] of files) {
  index.files.push([rel, offset, buf.length, sha256(buf)]);
  offset += buf.length;
}
const data = Buffer.concat(files.map((f) => f[1]));
index.hash = sha256(Buffer.concat([Buffer.from(JSON.stringify(index.files)), data]));
const indexBuf = Buffer.from(JSON.stringify(index));
const head = Buffer.alloc(4);
head.writeUInt32LE(indexBuf.length);

try {
  await rm(OUT, { recursive: true, force: true });
} catch (e) {
  fail(e.code === 'EBUSY' || e.code === 'EPERM' ? 'dist/release is in use: quit RumbleTracker.exe (tray icon → '
    + 'Quit the tracker) and build again.' : e.message);
}
await mkdir(BUILD, { recursive: true });
await writeFile(path.join(BUILD, 'app.bin'), Buffer.concat([head, indexBuf, deflateSync(data)]));
console.log(`App files: ${files.length} (${megabytes(data.length)} MB), version ${version}`);

// The exe
/**
 * The exe's version information (Properties > Details), as a VS_VERSIONINFO resource. Each block is
 * [wLength, wValueLength, wType, key (UTF-16, NUL), padding, value, padding, children], 32-bit aligned.
 */
function versionInfo(version, strings) {
  const [major, minor, patch] = version.split('.').map(Number);
  const utf16 = (s) => Buffer.from(`${s}\0`, 'utf16le');
  const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const block = (key, type, value = Buffer.alloc(0), valueLength = 0, children = []) => {
    const head = pad4(Buffer.concat([Buffer.alloc(6), utf16(key)]));
    const parts = children.length ? [pad4(Buffer.concat([head, value])),
      ...children.map((c, i) => (i < children.length - 1 ? pad4(c) : c))] : [head, value];
    const b = Buffer.concat(parts);
    b.writeUInt16LE(b.length, 0);
    b.writeUInt16LE(valueLength, 2);
    b.writeUInt16LE(type, 4);
    return b;
  };
  const fixed = Buffer.alloc(52);
  [0xFEEF04BD, 0x00010000, (major << 16) | minor, patch << 16, (major << 16) | minor, patch << 16, 0x3F, 0, 0x40004, 1, 0, 0, 0]
    // Signature, struct version, file/product version, flags, VOS_NT_WINDOWS32, VFT_APP.
    .forEach((v, i) => fixed.writeUInt32LE(v >>> 0, i * 4));
  const string = (k, v) => block(k, 1, utf16(v), v.length + 1);
  // en-US, Unicode
  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(0x0409, 0);
  translation.writeUInt16LE(0x04B0, 2);
  return block('VS_VERSION_INFO', 0, fixed, fixed.length, [
    block('StringFileInfo', 1, undefined, 0, [block('040904B0', 1, undefined, 0, Object.entries(strings).map(([k, v]) => string(k, v)))]),
    block('VarFileInfo', 1, undefined, 0, [block('Translation', 0, translation, translation.length)]),
  ]);
}

/** Writes web/favicon.ico and versionInfo() over Node's icon and version information, with Windows' resource API. */
function setExeResources(exePath, icoPath, versionPath) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.IO; using System.Runtime.InteropServices;
public static class ExeResources {
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr h);
  delegate bool EnumName(IntPtr m, IntPtr type, IntPtr name, IntPtr p);
  delegate bool EnumLang(IntPtr m, IntPtr type, IntPtr name, ushort lang, IntPtr p);
  [DllImport("kernel32")] static extern bool EnumResourceNames(IntPtr m, IntPtr type, EnumName cb, IntPtr p);
  [DllImport("kernel32")] static extern bool EnumResourceLanguages(IntPtr m, IntPtr type, IntPtr name, EnumLang cb, IntPtr p);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string f, bool del);
  [DllImport("kernel32", SetLastError=true)]
  static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool EndUpdateResource(IntPtr h, bool discard);
  static bool IsId(IntPtr p) { return ((long)p >> 16) == 0; }
  public static void Set(string exe, string ico, string ver) {
    // Enumerate existing icon and version resources for deletion.
    var old = new List<Tuple<int,int,ushort>>();
    IntPtr m = LoadLibraryEx(exe, IntPtr.Zero, 0x2 | 0x20);
    if (m == IntPtr.Zero) throw new Exception("cannot read " + exe);
    foreach (int type in new[] { 14, 3, 16 }) {
      EnumResourceNames(m, (IntPtr)type, (mm, t, n, p) => {
        if (IsId(n)) EnumResourceLanguages(mm, t, n, (m2, t2, n2, lang, p2) => {
          old.Add(Tuple.Create(type, (int)n2, lang)); return true; }, IntPtr.Zero);
        return true; }, IntPtr.Zero);
    }
    FreeLibrary(m);
    byte[] f = File.ReadAllBytes(ico);
    int count = BitConverter.ToUInt16(f, 4);
    IntPtr h = BeginUpdateResource(exe, false);
    if (h == IntPtr.Zero) throw new Exception("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());
    foreach (var o in old) UpdateResource(h, (IntPtr)o.Item1, (IntPtr)o.Item2, o.Item3, null, 0);
    var group = new MemoryStream(); var w = new BinaryWriter(group);
    w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)count);
    Action<IntPtr, IntPtr, byte[], string> put = (type, name, data, what) => {
      if (!UpdateResource(h, type, name, 1033, data, (uint)data.Length)) throw new Exception(what + ": " + Marshal.GetLastWin32Error());
    };
    for (int i = 0; i < count; i++) {
      int e = 6 + 16 * i; int len = BitConverter.ToInt32(f, e + 8); int off = BitConverter.ToInt32(f, e + 12);
      byte[] img = new byte[len]; Array.Copy(f, off, img, 0, len);
      put((IntPtr)3, (IntPtr)(i + 1), img, "icon " + i);
      w.Write(f, e, 12); w.Write((ushort)(i + 1)); // GRPICONDIRENTRY: first 12 bytes of ICONDIRENTRY + resource id
    }
    byte[] g = group.ToArray();
    put((IntPtr)14, (IntPtr)1, g, "icon group");
    byte[] v = File.ReadAllBytes(ver);
    put((IntPtr)16, (IntPtr)1, v, "version info");
    if (!EndUpdateResource(h, false)) throw new Exception("EndUpdateResource failed: " + Marshal.GetLastWin32Error());
  }
}
'@
[ExeResources]::Set($env:RT_EXE, $env:RT_ICO, $env:RT_VER)
`;
  execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')],
    // stdin isn't inherited, as a nested PowerShell can block on it.
    { env: { ...process.env, RT_EXE: exePath, RT_ICO: icoPath, RT_VER: versionPath }, stdio: ['ignore', 'pipe', 'pipe'] });
}

await copyFile(path.join(DESKTOP, 'launcher.cjs'), path.join(BUILD, 'launcher.cjs'));
await writeFile(path.join(BUILD, 'sea-config.json'), JSON.stringify({
  main: 'launcher.cjs',
  output: path.join(OUT, EXE_NAME),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  // (the launcher's pop-ups are shown before the app's files are unpacked, so they are in the exe on their own)
  assets: { 'app.bin': 'app.bin', 'popup.ps1': path.join(DESKTOP, 'popup.ps1'),
    'LilitaOne-Regular.ttf': path.join(DESKTOP, 'LilitaOne-Regular.ttf') },
}, null, 2));
execFileSync(process.execPath, ['--build-sea', 'sea-config.json'], { cwd: BUILD, stdio: 'inherit' });
// The file details Windows shows, which code signing needs too, name the product and its version instead of Node's.
await writeFile(path.join(BUILD, 'version.bin'), versionInfo(version, {
  CompanyName: 'razingo',
  FileDescription: APP_NAME,
  FileVersion: version,
  InternalName: 'RumbleTracker',
  LegalCopyright: '© razingo. MIT License. Not affiliated with Blizzard Entertainment.',
  OriginalFilename: EXE_NAME,
  ProductName: APP_NAME,
  ProductVersion: version,
}));
setExeResources(path.join(OUT, EXE_NAME), path.join(ROOT, 'web', 'favicon.ico'), path.join(BUILD, 'version.bin'));
const exe = await readFile(path.join(OUT, EXE_NAME));
// Mark the exe as a GUI program (no console window). Subsystem is at e_lfanew + 4 + 20 + 68.
const pe = exe.readUInt32LE(0x3c);
if (exe.readUInt32LE(pe) !== 0x4550 || exe.readUInt16LE(pe + 24) !== 0x20b) fail('unexpected exe header: cannot set the GUI subsystem.');
exe.writeUInt16LE(2, pe + 24 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
await writeFile(path.join(OUT, EXE_NAME), exe);
console.log(`Built ${EXE_NAME} (${megabytes(exe.length)} MB, Node.js ${process.versions.node})`);

// The zip players download
/** Minimal zip writer (deflate, no zip64). */
function zip(entries) {
  const local = [], central = [];
  let pos = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const now = new Date();
  for (const [name, buf] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(buf, { level: 9 });
    const crc = crc32(buf);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime(now), 10);
    lh.writeUInt16LE(dosDate(now), 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(buf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime(now), 12);
    ch.writeUInt16LE(dosDate(now), 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(buf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(pos, 42);
    local.push(lh, nameBuf, comp);
    central.push(ch, nameBuf);
    pos += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(pos, 16);
  return Buffer.concat([...local, cd, end]);
}
// The licenses of the software the exe carries, which go with every copy of it.
const PYTHON = path.join(ROOT, 'tools', 'gamedata', 'python');
const notice = (file) => readFile(file)
  .catch(() => fail(`${path.relative(ROOT, file)} is missing: a license that must ship with the exe.`));
/** A license file of one of Python's packages, from the folder pip keeps about it (<name>-<version>.dist-info). */
async function packageNotice(name, file) {
  const packages = path.join(PYTHON, 'Lib', 'site-packages');
  const info = (await readdir(packages)).find((d) => d.startsWith(`${name}-`) && d.endsWith('.dist-info'));
  if (!info) fail(`Python's package ${name} is missing from tools/gamedata/python.`);
  const inLicenses = path.join(packages, info, 'licenses', file);
  return notice(await stat(inLicenses).then(() => inLicenses, () => path.join(packages, info, file)));
}
const folder = `RumbleTracker-${version}-win-x64`;
const zipName = `${folder}.zip`;
const zipBuf = zip([
  [`${folder}/${EXE_NAME}`, exe],
  [`${folder}/README.md`, await readFile(path.join(ROOT, 'README.md'))],
  [`${folder}/LICENSE.txt`, await readFile(path.join(ROOT, 'LICENSE'))],
  [`${folder}/NOTICE.md`, await readFile(path.join(ROOT, 'NOTICE.md'))],
  [`${folder}/THIRD-PARTY-NOTICES/Node.js-LICENSE.txt`, await readFile(nodeLicense)],
  [`${folder}/THIRD-PARTY-NOTICES/WebView2-LICENSE.txt`, await readFile(path.join(WEBVIEW2, 'LICENSE.txt'))],
  [`${folder}/THIRD-PARTY-NOTICES/WebView2-NOTICE.txt`, await readFile(path.join(WEBVIEW2, 'NOTICE.txt'))],
  [`${folder}/THIRD-PARTY-NOTICES/Font-LilitaOne-OFL.txt`, await readFile(path.join(ROOT, 'web', 'fonts', 'OFL-LilitaOne.txt'))],
  [`${folder}/THIRD-PARTY-NOTICES/Font-Nunito-OFL.txt`, await readFile(path.join(ROOT, 'web', 'fonts', 'OFL-Nunito.txt'))],
  [`${folder}/THIRD-PARTY-NOTICES/Python-LICENSE.txt`, await notice(path.join(PYTHON, 'LICENSE.txt'))],
  [`${folder}/THIRD-PARTY-NOTICES/UnityPy-LICENSE.txt`, await packageNotice('unitypy', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/Pillow-LICENSE.txt`, await packageNotice('pillow', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/lz4-LICENSE.txt`, await packageNotice('lz4', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/Brotli-LICENSE.txt`, await packageNotice('brotli', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/texture2ddecoder-LICENSE.txt`, await packageNotice('texture2ddecoder', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/etcpak-LICENSE.txt`, await packageNotice('etcpak', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/astc-encoder-py-LICENSE.txt`, await packageNotice('astc_encoder_py', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/archspec-LICENSE-APACHE.txt`, await packageNotice('archspec', 'LICENSE-APACHE')],
  [`${folder}/THIRD-PARTY-NOTICES/archspec-LICENSE-MIT.txt`, await packageNotice('archspec', 'LICENSE-MIT')],
  [`${folder}/THIRD-PARTY-NOTICES/archspec-NOTICE.txt`, await packageNotice('archspec', 'NOTICE')],
  [`${folder}/THIRD-PARTY-NOTICES/fsspec-LICENSE.txt`, await packageNotice('fsspec', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/attrs-LICENSE.txt`, await packageNotice('attrs', 'LICENSE')],
  [`${folder}/THIRD-PARTY-NOTICES/tpk_ar-LICENSE.txt`, await packageNotice('tpk_ar', 'LICENSE')],
]);
await writeFile(path.join(OUT, zipName), zipBuf);
await writeFile(path.join(OUT, 'SHA256SUMS.txt'), `${sha256(zipBuf)}  ${zipName}\n${sha256(exe)}  ${EXE_NAME}\n`);
console.log(`Built ${zipName} (${megabytes(zipBuf.length)} MB)`);

await rm(BUILD, { recursive: true, force: true });
console.log(`\nDone: ${path.relative(ROOT, OUT)}\\`);
