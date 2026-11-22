// App updates. The signed data-pack manifest names the latest release and the SHA-256 of its zip and exe
// (latestApp). The zip is downloaded from the GitHub release, both checksums are checked, and the exe is written to
// <data>/update/ for the launcher to swap in.
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { sha256 } from '../datapack/datapack.mjs';
import { readLimited } from '../download.mjs';
import { REPO, EXE_NAME, MB, MINUTE } from '../../web/scripts/lib/constants.js';

const MAX_ZIP = 300 * MB;

/** The release the manifest announces, if it is well-formed: { version, zip, zipSha256, exeSha256 }, else null. */
export function latestAppOf(a) {
  if (!a || !/^\d+\.\d+\.\d+$/.test(a.version || '')) return null;
  if (a.zip !== `RumbleTracker-${a.version}-win-x64.zip`) return null;
  if (!/^[0-9a-f]{64}$/.test(a.zipSha256 || '') || !/^[0-9a-f]{64}$/.test(a.exeSha256 || '')) return null;
  return { version: a.version, zip: a.zip, zipSha256: a.zipSha256, exeSha256: a.exeSha256 };
}

export const zipUrl = (app) => `https://github.com/${REPO}/releases/download/v${app.version}/${app.zip}`;

/** Returns the bytes of the zip entry whose name ends with `/${name}` (or equals it). Deflate and stored only. */
export function zipEntry(zip, name) {
  // The end-of-central-directory record is in the last 22 bytes, or a little earlier when the zip has a comment.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (zip.readUInt32LE(i) === 0x06054b50) {
    end = i;
    break;
  }
  if (end < 0) throw new Error('The download is not a zip file.');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let k = 0; k < count; k++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('The downloaded zip is damaged.');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (entry !== name && !entry.endsWith(`/${name}`)) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('The downloaded zip is damaged.');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`The downloaded zip uses an unsupported compression (${method}).`);
  }
  throw new Error(`${name} is not in the downloaded zip.`);
}

/**
 * Downloads and verifies the release named by `app` (from latestAppOf); writes the exe into `dir`. Earlier downloads
 * there are removed. Returns the exe's path. `fetchImpl` and `url` are for tests.
 */
export async function downloadUpdate(app, dir, { fetchImpl = fetch, url = zipUrl(app), onProgress } = {}) {
  const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * MINUTE) });
  if (!r.ok) throw new Error(`The download failed (HTTP ${r.status}).`);
  const zip = await readLimited(r, MAX_ZIP, 'The download is larger than a tracker release can be, so it was stopped.',
    onProgress);
  if (sha256(zip) !== app.zipSha256) throw new Error('The download does not match its checksum, so it was not installed.');
  const exe = zipEntry(zip, EXE_NAME);
  if (sha256(exe) !== app.exeSha256) throw new Error('The program in the download does not match its checksum, so it was not installed.');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `RumbleTracker-${app.version}.exe`);
  await writeFile(file, exe);
  return file;
}

/** Removes downloaded updates (after they were applied). */
export async function cleanUpdates(dir) {
  try {
    if ((await readdir(dir)).length) await rm(dir, { recursive: true, force: true });
  } catch {
    // none
  }
}
