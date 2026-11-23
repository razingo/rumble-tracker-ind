// App updates. The repository's latest release on GitHub names its version, and its SHA256SUMS.txt the SHA-256 of
// its zip and exe (latestApp). For Download now, the zip is downloaded from that release, both checksums are checked,
// and the exe is written to <data>/update/ for the launcher to swap in.
// The checksums come from the same release as the zip, so they show the download arrived whole; who published it is
// taken on trust from GitHub, as it is when the zip is downloaded there by hand.
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readLimited } from '../download.mjs';
import { REPO, EXE_NAME, MB, MINUTE, SECOND } from '../../web/scripts/lib/constants.js';

const MAX_ZIP = 300 * MB;
const RELEASE_FILES = `https://github.com/${REPO}/releases/download/`;
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The latest release: { version, app }, where app ({ version, zip, zipSha256, exeSha256 }) is what Download now needs,
 * or null when the release has no checksum file to go by. Rejects when GitHub can't be asked or has no release.
 */
export async function latestRelease({ fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`,
    { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20 * SECOND) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const release = await r.json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The latest release has no version number.');
  const zip = `RumbleTracker-${version}-win-x64.zip`;
  const sums = (release.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
  // only this repository's own release files
  if (!sums || !String(sums.browser_download_url).startsWith(RELEASE_FILES)) return { version, app: null };
  const s = await fetchImpl(sums.browser_download_url, { redirect: 'follow', signal: AbortSignal.timeout(20 * SECOND) });
  if (!s.ok) return { version, app: null };
  const text = (await s.text()).slice(0, 4096);
  const sumOf = (name) => text.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, '') === name)?.[0];
  return { version, app: latestAppOf({ version, zip, zipSha256: sumOf(zip), exeSha256: sumOf(EXE_NAME) }) };
}

/** A release's download details, if they are well-formed: { version, zip, zipSha256, exeSha256 }, else null. */
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
