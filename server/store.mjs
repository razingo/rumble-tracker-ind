// The player's JSON files. Writes to one file are queued and go through a unique temporary file, so saves can't
// collide. A damaged file, or one that holds something else than the tracker keeps in it, is moved aside instead of
// stopping the tracker.
import { readFile, writeFile, rename, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';

const queues = new Map(); // path -> promise of the last queued write

/** The current time for a file name, as in 2026-11-20T01-30-00-000Z. */
const fileTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
let tmpCounter = 0;

/** Whether a value read from a file is an object with named parts: not null, a list, a number or text. */
export const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Reads a JSON file. A missing file gives `fallback`, or throws without one. A file that isn't valid JSON, or that
 * holds something `shape(value)` does not pass, throws, unless `onCorrupt` is given. Then the file is renamed to
 * <name>.corrupt-<time>, onCorrupt(file, movedTo) is called and `fallback` is returned.
 */
export async function readJson(p, fallback, { onCorrupt, shape } = {}) {
  let text;
  try {
    text = await readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
  let why;
  try {
    // JSON.parse rejects a byte-order mark
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!shape || shape(value)) return value;
    why = 'does not hold what the tracker keeps in it';
  } catch (e) {
    why = `is not valid JSON: ${e.message}`;
  }
  if (!onCorrupt || fallback === undefined) throw Object.assign(new Error(`${path.basename(p)} ${why}`), { code: 'BAD_JSON' });
  const moved = `${p}.corrupt-${fileTimestamp()}`;
  await rename(p, moved);
  onCorrupt(p, moved);
  return fallback;
}

/**
 * Keeps a copy of a file as it is now, beside it, as <name>.corrupt-<time>: for a file that is about to be written
 * without a part of it. Resolves with the copy's path.
 */
export async function keepCopy(p) {
  const copy = `${p}.corrupt-${fileTimestamp()}`;
  await copyFile(p, copy);
  return copy;
}

/** Writes a JSON file atomically. Writes to the same file run one at a time, in call order. */
export function writeJson(p, value) {
  const body = JSON.stringify(value, null, 2) + '\n'; // the value as it is now, even if the write waits
  const run = async () => {
    const tmp = `${p}.${process.pid}-${++tmpCounter}.tmp`;
    try {
      await writeFile(tmp, body);
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  };
  const prev = queues.get(p) || Promise.resolve();
  const next = prev.then(run, run);
  queues.set(p, next);
  next.finally(() => { if (queues.get(p) === next) queues.delete(p); }).catch(() => {});
  return next;
}

/**
 * Puts the folder `from` in the place of `to`. The old one is moved aside first and only deleted once the new one is
 * there, so a failure leaves the old one where it was. A scanner or a closing window may hold a file for a moment:
 * a move that is refused for that is tried again for a few seconds.
 */
export async function replaceFolder(from, to) {
  const move = async (a, b) => {
    for (let tries = 0; ; tries++) {
      try {
        return await rename(a, b);
      } catch (e) {
        if (tries >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  const old = `${to}-old`;
  await rm(old, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  const had = await move(to, old).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });
  try {
    await move(from, to);
  } catch (e) {
    if (had) await move(old, to).catch(() => {});
    throw e;
  }
  await rm(old, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
}

/** Resolves once every queued write has finished (successfully or not). */
export async function flushWrites() {
  while (queues.size) await Promise.allSettled([...queues.values()]);
}
