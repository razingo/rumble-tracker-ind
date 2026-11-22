// Data packs: signature and checksum checks, versions and the first-start install, against a local test pack
// signed with a throwaway key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { updateDataPack, allowedUrl, swapIn } from '../server/datapack/datapack.mjs';
import { APP_KEY } from '../web/scripts/lib/constants.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeys = [publicKey.export({ type: 'spki', format: 'pem' })];
const other = generateKeyPairSync('ed25519').privateKey;

const files = { 'units.json': '{"a":1}', 'img/unit one.webp': 'webp-bytes', 'events.json': '{"events":[]}' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const pack = {}; // what the test server serves: manifest fields, signing key, file overrides
const listing = (f) => Object.fromEntries(Object.entries(f).map(([p, s]) => [p, { sha256: sha(s), size: s.length }]));
const manifestBody = () => Buffer.from(JSON.stringify({
  format: 1, gameBuild: '16.1.2.119766', dataVersion: '2026-01-01T00:00:00.000Z', files: listing(files), ...pack.manifest,
}));

let server, base, tmp;
const requests = [];
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'rumble-test-'));
  server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    requests.push(p);
    const body = manifestBody();
    if (p === 'manifest.json') return res.end(body);
    if (p === 'manifest.sig') return res.end(sign(null, body, pack.key || privateKey).toString('base64'));
    const content = pack.files?.[p] ?? files[p];
    if (content === undefined) {
      res.statusCode = 404;
      return res.end();
    }
    res.end(content);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}/`;
});
after(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

const fresh = async (name) => {
  const dir = path.join(tmp, name);
  await rm(dir, { recursive: true, force: true });
  return dir;
};
const reset = (p = {}) => {
  Object.keys(pack).forEach((k) => delete pack[k]);
  Object.assign(pack, p);
  requests.length = 0;
};

test('the first start installs every file into an empty folder and reports progress', async () => {
  reset();
  const dir = await fresh('first');
  const progress = [];
  const r = await updateDataPack({ base, current: null, dir, staticDir: path.join(tmp, 'none'), publicKeys,
    onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(r.updated, true);
  assert.equal(r.downloaded, 3);
  assert.equal(await readFile(path.join(dir, 'img', 'unit one.webp'), 'utf8'), 'webp-bytes');
  assert.equal(JSON.parse(await readFile(path.join(dir, 'gamedata.json'), 'utf8')).gameBuild, '16.1.2.119766');
  assert.deepEqual(progress.at(-1), [3, 3]);
  assert.equal(progress.length, 3);
});

test('nothing is downloaded when the data is up to date', async () => {
  reset();
  const r = await updateDataPack({ base, current: { dataVersion: '2026-01-01T00:00:00.000Z' },
    dir: await fresh('same'), staticDir: tmp, publicKeys });
  assert.equal(r.updated, false);
  assert.equal(r.reason, 'up to date');
  assert.deepEqual(requests, ['manifest.json', 'manifest.sig']);
});

test('older data is refused', async () => {
  reset();
  const r = await updateDataPack({ base, current: { dataVersion: '2027-01-01T00:00:00.000Z' },
    dir: await fresh('older'), staticDir: tmp, publicKeys });
  assert.equal(r.updated, false);
});

test('unchanged files are reused from the installed data', async () => {
  reset();
  const staticDir = await fresh('static');
  await mkdir(staticDir, { recursive: true });
  await writeFile(path.join(staticDir, 'units.json'), files['units.json']);
  const r = await updateDataPack({ base, current: null, dir: await fresh('reuse'), staticDir, publicKeys });
  assert.equal(r.downloaded, 2);
  assert.ok(!requests.includes('units.json'));
});

test('a pack signed with another key is rejected', async () => {
  reset({ key: other });
  await assert.rejects(updateDataPack({ base, current: null, dir: await fresh('badsig'), staticDir: tmp,
    publicKeys }), { code: 'BAD_SIGNATURE' });
});

test('a corrupted file is rejected and the installed data is kept', async () => {
  reset();
  const dir = await fresh('corrupt');
  await updateDataPack({ base, current: null, dir, staticDir: path.join(tmp, 'none'), publicKeys });
  // The signed manifest lists a new file, but the server sends different bytes.
  reset({ manifest: { dataVersion: '2026-06-01T00:00:00.000Z', files: listing({ ...files, 'new.json': '{"ok":1}' }) },
    files: { 'new.json': '{"tampered":1}' } });
  await assert.rejects(updateDataPack({ base, current: { dataVersion: '2026-01-01T00:00:00.000Z' }, dir,
    staticDir: path.join(tmp, 'none'), publicKeys }), /does not match its checksum/);
  assert.equal(await readFile(path.join(dir, 'events.json'), 'utf8'), files['events.json']);
  await assert.rejects(readFile(path.join(dir, 'new.json')));
});

test('unsafe file paths in the manifest are rejected', async () => {
  reset({ manifest: { files: { '../evil.json': { sha256: sha('x'), size: 1 } } } });
  await assert.rejects(updateDataPack({ base, current: null, dir: await fresh('unsafe'), staticDir: tmp, publicKeys }), /invalid entry/);
});

test('offline, the download fails without touching the folder', async () => {
  reset();
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  closed.close();
  await assert.rejects(updateDataPack({ base: `http://localhost:${port}/`, current: null, dir: await fresh('offline'),
    staticDir: tmp, publicKeys }));
});

test('pack addresses must be https, or http on localhost', async () => {
  assert.ok(allowedUrl('https://example.org/pack/'));
  assert.ok(allowedUrl('http://127.0.0.1:9000/'));
  assert.ok(!allowedUrl('http://example.org/'));
  assert.ok(!allowedUrl('file:///C:/pack/'));
  assert.ok(!allowedUrl('not a url'));
  const r = await updateDataPack({ base: 'http://example.org/', current: null, dir: tmp, staticDir: tmp, publicKeys });
  assert.equal(r.updated, false);
});

test('a new pack replaces the installed one, and the installed one stays if it cannot', async () => {
  const dir = await fresh('swap');
  const staging = `${dir}.new`;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'units.json'), 'old');
  await assert.rejects(swapIn(staging, dir)); // nothing staged, so it can't be moved in
  assert.equal(await readFile(path.join(dir, 'units.json'), 'utf8'), 'old');
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'units.json'), 'new');
  await swapIn(staging, dir);
  assert.equal(await readFile(path.join(dir, 'units.json'), 'utf8'), 'new');
  await assert.rejects(readFile(path.join(`${dir}.old`, 'units.json')));
});

test("this app's latest version comes from the signed manifest's apps", async () => {
  const check = async (manifest) => {
    reset({ manifest });
    return updateDataPack({ base, current: { dataVersion: '2026-01-01T00:00:00.000Z' }, dir: tmp, staticDir: tmp, publicKeys });
  };
  const zip = { version: '0.2.0', zip: 'https://example.org/a.zip', zipSha256: 'a'.repeat(64), exeSha256: 'b'.repeat(64) };
  let r = await check({ apps: { [APP_KEY]: zip } });
  assert.equal(r.latestAppVersion, '0.2.0');
  assert.deepEqual(r.latestApp, zip);
  r = await check({ apps: { 'another-app': zip } });
  assert.equal(r.latestAppVersion, null);
  r = await check({ apps: { [APP_KEY]: { version: '<script>' } } });
  assert.equal(r.latestAppVersion, null);
  r = await check({ apps: { [APP_KEY]: { version: '0.3.0' } } }); // announced, but without a download
  assert.deepEqual([r.latestAppVersion, r.latestApp], ['0.3.0', null]);
});
