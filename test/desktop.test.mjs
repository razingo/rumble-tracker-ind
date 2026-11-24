// The exe's PowerShell scripts, on Windows only. The window program loads WebView2 (npm run fetch-webview2 puts it in
// desktop/webview2/), compiles its helpers (once, when given a place to keep them), starts its tray icon and reports
// whether the game runs, uninstalling removes what it should, and the integration script compiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL } from '../server/system.mjs';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const windows = process.platform === 'win32';
const LIB = path.join(DESKTOP, 'webview2');
// As the launcher starts the window program: a short command that runs the file in RT_SCRIPT (desktop/launcher.cjs)
const windowArgs = ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
  encoded('. ([ScriptBlock]::Create([IO.File]::ReadAllText($env:RT_SCRIPT)))')];
const run = (env, script = 'window.ps1') => new Promise((resolve, reject) => {
  execFile(POWERSHELL, windowArgs, { windowsHide: true, env: { ...process.env, RT_SCRIPT: path.join(DESKTOP, script), ...env } },
    (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(stdout)));
});

test("the window builds with WebView2 and keeps its compiled helpers, and says why it can't without WebView2", {
  skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  assert.ok(existsSync(path.join(LIB, 'WebView2Loader.dll')), 'the WebView2 libraries are missing: npm run fetch-webview2');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-helpers-'));
  try {
    const env = { RT_TITLE: 'Test', RT_EXE: process.execPath, RT_PARENT: String(process.pid), RT_CHECK: '1', RT_LIB: LIB,
      RT_CACHE: path.join(dir, 'window-helpers.dll') };
    assert.equal((await run(env)).trim(), 'built');
    assert.ok(existsSync(env.RT_CACHE), 'compiled into RT_CACHE');
    // loaded from there the next time, here without the libraries
    const without = await run({ ...env, RT_LIB: path.join(LIB, 'missing') });
    assert.match(without, /^webview: /);
    assert.match(without, /help built/, 'the window saying how to install WebView2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tray icon reports ready, then the game state', { skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  const child = spawn(POWERSHELL, windowArgs, {
    windowsHide: true,
    // A game name that never runs, so the answer is known; no window is opened (RT_SHOW unset).
    env: { ...process.env, RT_SCRIPT: path.join(DESKTOP, 'window.ps1'), RT_TITLE: 'Tray test',
      RT_DATA: process.cwd(), RT_EXE: process.execPath,
      RT_PARENT: String(process.pid), RT_GAME: 'NoSuchGameForTrayTest', RT_LIB: LIB, RT_PROFILE: process.cwd() },
  });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  try {
    for (let i = 0; i < 400 && !/game [01]/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(out.split(/\r?\n/).filter(Boolean), ['ready', 'game 0'], `stderr: ${err}`);
    assert.equal(err.replace(/^#< CLIXML\s*/, '').trim(), '', 'no errors (the shutdown hook compiled)');
  } finally {
    child.kill();
  }
});

test("uninstalling removes the data, the program files and the zip's files, and nothing else", {
  skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-uninstall-'));
  const file = (rel) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), 'x');
  };
  try {
    for (const f of ['appdata/RumbleTracker/location.json', 'picked/RumbleTracker/data/names.json',
      'picked/RumbleTracker/data/backups/b.json', 'picked/RumbleTracker/app/v/x.mjs', 'picked/mine.txt',
      'zip/RumbleTracker.exe', 'zip/README.md', 'zip/THIRD-PARTY-NOTICES/Node.js-LICENSE.txt', 'other/RumbleTracker.exe',
      'other/mine.txt', 'custom/names.json']) file(f);
    // the tracker's folder in the one the player picked, and the note of where it is
    const env = { RT_FILES_ONLY: '1', RT_PARENT: '0', RT_HOME: path.join(dir, 'picked', 'RumbleTracker') };
    await run({ ...env, RT_NOTE: path.join(dir, 'appdata', 'RumbleTracker'), RT_EXE: path.join(dir, 'zip', 'RumbleTracker.exe') },
      'uninstall.ps1');
    assert.deepEqual(['appdata/RumbleTracker', 'picked/RumbleTracker', 'zip'].filter((f) => existsSync(path.join(dir, f))), [],
      'all removed');
    assert.ok(existsSync(path.join(dir, 'picked', 'mine.txt')), 'what else is in the picked folder stays');
    // next to the exe, the player's own files stay, and so does their folder; a folder under another name stays too
    await run({ ...env, RT_HOME: path.join(dir, 'custom'), RT_NOTE: '', RT_EXE: path.join(dir, 'other', 'RumbleTracker.exe') },
      'uninstall.ps1');
    assert.ok(!existsSync(path.join(dir, 'other', 'RumbleTracker.exe')) && existsSync(path.join(dir, 'other', 'mine.txt')));
    assert.ok(existsSync(path.join(dir, 'custom', 'names.json')), 'only a folder named RumbleTracker is removed whole');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstalling knows every file the release zip puts next to the exe', () => {
  const build = readFileSync(path.join(DESKTOP, '..', 'tools', 'build-release.mjs'), 'utf8');
  const uninstall = readFileSync(path.join(DESKTOP, 'uninstall.ps1'), 'utf8');
  const inZip = [...build.matchAll(/`\$\{folder\}\/([^`$]+)`/g)].map((m) => path.basename(m[1])).sort();
  const removed = [...uninstall.matchAll(/'([\w.-]+\.(?:md|txt))'/g)].map((m) => m[1]).sort();
  assert.ok(inZip.length > 3, 'found the zip entries in build-release.mjs');
  assert.deepEqual(removed, inZip);
});

test('the release zip carries a license for everything the exe carries', () => {
  const build = readFileSync(path.join(DESKTOP, '..', 'tools', 'build-release.mjs'), 'utf8');
  const notices = [...build.matchAll(/`\$\{folder\}\/THIRD-PARTY-NOTICES\/([^`$]+)`/g)].map((m) => m[1]);
  // Node.js, the window's libraries, the fonts, Python, three.js, vgmstream, and each package fetch-python installs
  const fetched = readFileSync(path.join(DESKTOP, '..', 'tools', 'fetch-python.mjs'), 'utf8');
  const packages = [...fetched.matchAll(/'([A-Za-z0-9_.-]+)==[\d.]+'/g)].map((m) => m[1].toLowerCase().replace(/[-_.]+/g, ''));
  assert.ok(packages.length > 5, 'found the pinned packages in fetch-python.mjs');
  const named = (name) => notices.some((n) => n.toLowerCase().replace(/[-_.]+/g, '').startsWith(name));
  for (const name of ['nodejs', 'webview2', 'font', 'python', 'threejs', 'vgmstream', ...packages]) {
    assert.ok(named(name), `a license for ${name}`);
  }
});

test('integration script compiles', { skip: !windows && 'Windows only', timeout: 60000 }, async () => {
  // Only the type definition, as running it would create a shortcut and register a link type.
  const script = readFileSync(path.join(DESKTOP, 'integration.ps1'), 'utf8');
  const typeOnly = script.slice(0, script.indexOf("\n'@") + 4) + "\n'compiled'";
  const out = await new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      encoded(typeOnly)], { windowsHide: true }, (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(stdout)));
  });
  assert.match(out, /compiled/);
});

test('the log\'s lines carry no Windows user name', () => {
  // (the launcher is one program with no parts to import: its cleaning is read out of it)
  const launcher = readFileSync(path.join(DESKTOP, 'launcher.cjs'), 'utf8');
  const source = /const escapeRe = .*\n/.exec(launcher)[0] + /function withoutUserName[\s\S]*?\n}\n/.exec(launcher)[0];
  const withoutUserName = new Function('HOME_FOLDER', 'USER_NAME', `${source}; return withoutUserName;`)('C:\\Users\\Jo Doe', 'Jo Doe');
  assert.equal(withoutUserName('Data folder: C:\\Users\\Jo Doe\\AppData\\Roaming\\RumbleTracker'),
    'Data folder: ~\\AppData\\Roaming\\RumbleTracker');
  assert.equal(withoutUserName('unpacked in c:/users/jo doe/AppData/Local'), 'unpacked in ~/AppData/Local');
  assert.equal(withoutUserName('D:\\Games\\Jo Doe\\Warcraft Rumble'), 'D:\\Games\\<user>\\Warcraft Rumble');
  assert.equal(withoutUserName('Warcraft Rumble started: reading the save'), 'Warcraft Rumble started: reading the save');
  // only whole folder names: a folder that starts with the name, or a word that is the name, stays
  assert.equal(withoutUserName('C:\\Users\\Jo Doe2\\x and the Jo Doe show'), 'C:\\Users\\Jo Doe2\\x and the Jo Doe show');
  const data = new Function('HOME_FOLDER', 'USER_NAME', `${source}; return withoutUserName;`)('C:\\Users\\Data', 'Data');
  assert.equal(data('Data folder: C:\\Users\\Data\\AppData, game data read'), 'Data folder: ~\\AppData, game data read');
});
