import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import { latestAppOf, zipUrl, zipEntry, downloadUpdate } from '../server/update/appupdate.mjs';
import { readLimited } from '../server/download.mjs';
import { sha256 as sha } from '../server/datapack/datapack.mjs';


/** A zip like tools/build-release.mjs writes (deflate; `stored` names are kept uncompressed). */
function zip(entries, stored = []) {
  const local = [], central = [];
  let pos = 0;
  for (const [name, buf] of entries) {
    const n = Buffer.from(name);
    const method = stored.includes(name) ? 0 : 8;
    const comp = method ? deflateRawSync(buf) : buf;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(buf), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(buf.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(buf), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(buf.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(pos, 42);
    local.push(lh, n, comp);
    central.push(ch, n);
    pos += 30 + n.length + comp.length;
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

const exe = Buffer.from('MZ fake program '.repeat(500));
const zipBuf = zip([['RumbleTracker-0.4.0-win-x64/README.md', Buffer.from('readme')],
  ['RumbleTracker-0.4.0-win-x64/RumbleTracker.exe', exe]]);
const app = { version: '0.4.0', zip: 'RumbleTracker-0.4.0-win-x64.zip', zipSha256: sha(zipBuf), exeSha256: sha(exe) };
const serve = (buf, status = 200) => async () => new Response(buf, { status });

test('release info must be complete and consistent', () => {
  assert.deepEqual(latestAppOf(app), app);
  assert.equal(latestAppOf(null), null);
  assert.equal(latestAppOf({ ...app, version: '0.4' }), null);
  assert.equal(latestAppOf({ ...app, zip: '../evil.zip' }), null);
  assert.equal(latestAppOf({ ...app, zip: 'RumbleTracker-0.5.0-win-x64.zip' }), null);
  assert.equal(latestAppOf({ ...app, exeSha256: 'abc' }), null);
  assert.equal(zipUrl(app), 'https://github.com/razingo/rumble-tracker-ind/releases/download/v0.4.0/RumbleTracker-0.4.0-win-x64.zip');
});

test('reads both deflated and stored zip entries', () => {
  assert.deepEqual(zipEntry(zipBuf, 'RumbleTracker.exe'), exe);
  assert.deepEqual(zipEntry(zip([['a/RumbleTracker.exe', exe]], ['a/RumbleTracker.exe']), 'RumbleTracker.exe'), exe);
  assert.throws(() => zipEntry(zipBuf, 'other.exe'), /not in the downloaded zip/);
  assert.throws(() => zipEntry(Buffer.from('not a zip at all, just some text here'), 'x'), /not a zip/);
});

test('writes the download only when both checksums match', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-update-'));
  const target = path.join(dir, 'update');
  const file = await downloadUpdate(app, target, { fetchImpl: serve(zipBuf) });
  assert.equal(path.basename(file), 'RumbleTracker-0.4.0.exe');
  assert.deepEqual(await readFile(file), exe);
  await assert.rejects(downloadUpdate({ ...app, zipSha256: sha(Buffer.from('x')) }, target,
    { fetchImpl: serve(zipBuf) }), /does not match its checksum/);
  await assert.rejects(downloadUpdate({ ...app, exeSha256: sha(Buffer.from('x')) }, target,
    { fetchImpl: serve(zipBuf) }), /program in the download/);
  await assert.rejects(downloadUpdate(app, target, { fetchImpl: serve(zipBuf, 404) }), /download failed \(HTTP 404\)/);
  // A failed download leaves the earlier one alone.
  assert.deepEqual(await readdir(target), ['RumbleTracker-0.4.0.exe']);
  await rm(dir, { recursive: true });
});

test('a download stops once it passes its limit', async () => {
  await assert.rejects(readLimited(new Response(Buffer.alloc(10)), 5, 'Too large.'), /Too large/);
  // announced as too large: refused before reading
  await assert.rejects(readLimited(new Response(Buffer.alloc(10), { headers: { 'content-length': '10' } }), 5, 'Too large.'),
    /Too large/);
  assert.equal((await readLimited(new Response(Buffer.alloc(5)), 5, 'Too large.')).length, 5);
});

test('download progress is reported while the zip streams in', async () => {
  const chunks = [Buffer.alloc(100), Buffer.alloc(150)];
  const body = new ReadableStream({ start(c) {
    for (const x of chunks) c.enqueue(x);
    c.close();
  } });
  const seen = [];
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '250' }), body });
  // The bytes aren't a valid zip, so progress comes first and then the checksum check fails.
  await assert.rejects(downloadUpdate(app, 'unused', { fetchImpl, onProgress: (d, t) => seen.push([d, t]) }), /checksum/);
  assert.deepEqual(seen, [[100, 250], [250, 250]]);
});
