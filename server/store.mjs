// The player's JSON files. Writes to one file are queued and go through a unique temporary file, so saves can't
// collide. A damaged file is moved aside instead of stopping the tracker.
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const queues = new Map(); // path -> promise of the last queued write

/** The current time for a file name, as in 2026-11-20T01-30-00-000Z. */
export const fileTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
let tmpCounter = 0;

/**
 * Reads a JSON file. A missing file gives `fallback`, or throws without one. A file that isn't valid JSON throws,
 * unless `onCorrupt` is given. Then the file is renamed to <name>.corrupt-<time>, onCorrupt(file, movedTo) is called
 * and `fallback` is returned.
 */
export async function readJson(p, fallback, { onCorrupt } = {}) {
  let text;
  try {
    text = await readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
  try {
    // JSON.parse rejects a byte-order mark
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    if (!onCorrupt || fallback === undefined) throw Object.assign(new Error(`${path.basename(p)} is not valid JSON: ${e.message}`),
      { code: 'BAD_JSON' });
    const moved = `${p}.corrupt-${fileTimestamp()}`;
    await rename(p, moved);
    onCorrupt(p, moved);
    return fallback;
  }
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

/** Resolves once every queued write has finished (successfully or not). */
export async function flushWrites() {
  while (queues.size) await Promise.allSettled([...queues.values()]);
}
