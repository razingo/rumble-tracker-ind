// Data packs are signed game-data updates, installed into <data>/gamedata/ and used before gamedata/. A pack is
// manifest.json { format, gameBuild, dataVersion, files: { path: { sha256, size } } }, manifest.sig (Ed25519 over
// manifest.json, with the keys in pack-keys.mjs) and the listed files. Packs with an invalid signature or an older
// dataVersion are rejected.
import { mkdir, readFile, writeFile, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { PACK_PUBLIC_KEYS } from './pack-keys.mjs';
import { readLimited } from '../download.mjs';
import { SECOND, MB, APP_KEY } from '../../web/scripts/lib/constants.js';

const MAX_FILE = 8 * MB; // per file
const MAX_TOTAL = 64 * MB; // per pack
const PARALLEL = 8; // concurrent downloads
const SAFE_PATH = /^[A-Za-z0-9_][\w./ '-]*\.(json|webp|png)$/;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Allowed pack addresses: https, or http on localhost. */
export function allowedUrl(base) {
  try {
    const u = new URL(base);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

async function fetchBuf(url, limit) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * SECOND) });
  if (!r.ok) throw new Error(`The game data server answered HTTP ${r.status} for ${url}.`);
  return readLimited(r, limit, `A game data file is larger than allowed: ${url}.`);
}

/** The usable public keys; a malformed one is skipped. */
function publicKeyObjects(pems) {
  return pems.map((pem) => {
    try {
      return createPublicKey(pem);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Downloads manifest.json and checks its signature over the exact bytes before anything in it is trusted. Its
 * checksums then cover every file.
 */
async function signedManifest(root, keys) {
  const body = await fetchBuf(new URL('manifest.json', root), MB);
  const sig = Buffer.from((await fetchBuf(new URL('manifest.sig', root), 4096)).toString('utf8').trim(), 'base64');
  const valid = (key) => {
    try {
      return verify(null, body, key, sig);
    } catch {
      return false;
    }
  };
  if (!keys.some(valid)) {
    throw Object.assign(new Error('The game data signature is not valid, so the update was not installed.'), { code: 'BAD_SIGNATURE' });
  }
  const manifest = JSON.parse(body.toString('utf8'));
  if (manifest.format !== 1 || !manifest.files || !manifest.dataVersion) {
    throw new Error('The game data list is not in the expected format.');
  }
  return manifest;
}

/** This app's latest release as the manifest announces it under `apps`, with its download checksums if it has them. */
function announcedApp(manifest) {
  const app = manifest.apps?.[APP_KEY];
  const latestAppVersion = /^\d+\.\d+\.\d+$/.test(app?.version || '') ? app.version : null;
  return { latestAppVersion, latestApp: latestAppVersion && app.zip ? app : null };
}

/** Throws on an entry with an unsafe path or a malformed checksum, or when the pack is too large. */
function checkEntries(entries) {
  let total = 0;
  for (const [rel, file] of entries) {
    if (!SAFE_PATH.test(rel) || rel.includes('..') || !/^[0-9a-f]{64}$/.test(file.sha256 || '')) {
      throw new Error(`The game data list has an invalid entry: ${rel}.`);
    }
    total += file.size || 0;
  }
  if (total > MAX_TOTAL) throw new Error('The game data is larger than allowed.');
}

/** An identical copy of a file in one of `dirs`, so it needn't be downloaded again, or null. */
async function localCopy(rel, sha, dirs) {
  for (const d of dirs) {
    try {
      const buf = await readFile(path.join(d, ...rel.split('/')));
      if (sha256(buf) === sha) return buf;
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * Writes every file of the pack into `staging`, from a local copy or downloaded and checked. PARALLEL workers take
 * files in turn, and the first error stops them all. Returns the number of files downloaded.
 */
async function fillStaging(entries, { root, staging, reuseFrom, onProgress }) {
  let downloaded = 0, done = 0, next = 0, failed = null;
  const installOne = async ([rel, file]) => {
    const target = path.join(staging, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    let buf = await localCopy(rel, file.sha256, reuseFrom);
    if (!buf) {
      buf = await fetchBuf(new URL(rel.split('/').map(encodeURIComponent).join('/'), root), MAX_FILE);
      if (sha256(buf) !== file.sha256) throw new Error(`A game data file does not match its checksum: ${rel}.`);
      downloaded++;
    }
    await writeFile(target, buf);
    onProgress?.(++done, entries.length);
  };
  const worker = async () => {
    while (!failed && next < entries.length) {
      try {
        await installOne(entries[next++]);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (failed) throw failed;
  return downloaded;
}

/**
 * Puts the staged pack in place of the installed one, removing the old pack only once the new one is there. If the
 * new one can't be moved in (a file held open, say), the old one is put back.
 */
export async function swapIn(staging, dir) {
  const old = `${dir}.old`;
  await rm(old, { recursive: true, force: true });
  let moved = false;
  try {
    await stat(dir);
    await rename(dir, old);
    moved = true;
  } catch {
    // no pack installed yet
  }
  try {
    await rename(staging, dir);
  } catch (e) {
    if (moved) await rename(old, dir);
    throw e;
  }
  await rm(old, { recursive: true, force: true });
}

/**
 * Installs the pack at `base` into `dir` if it is newer than `current`. Only changed files are downloaded, and every
 * file is verified before the switch. onProgress(done, total) is called after each file.
 * Returns { updated, manifest, downloaded, reason }.
 */
export async function updateDataPack({ base, current, dir, staticDir, publicKeys = PACK_PUBLIC_KEYS, onProgress }) {
  if (!base) return { updated: false, reason: 'no data pack address configured' };
  if (!allowedUrl(base)) return { updated: false, reason: 'data pack address must be https' };
  const keys = publicKeyObjects(publicKeys);
  if (!keys.length) return { updated: false, reason: 'this build has no data pack key, so packs are not accepted' };
  const root = base.endsWith('/') ? base : `${base}/`;
  const remote = await signedManifest(root, keys);
  const app = announcedApp(remote);
  if (current?.dataVersion && remote.dataVersion <= current.dataVersion) {
    return { updated: false, manifest: current, ...app, reason: 'up to date' };
  }
  const entries = Object.entries(remote.files);
  checkEntries(entries);
  const staging = `${dir}.new`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const downloaded = await fillStaging(entries, { root, staging, reuseFrom: [dir, staticDir], onProgress });
  await writeFile(path.join(staging, 'gamedata.json'), JSON.stringify(remote, null, 1));
  await swapIn(staging, dir);
  return { updated: true, manifest: remote, downloaded, ...app, reason: `installed data for game build ${remote.gameBuild}` };
}
