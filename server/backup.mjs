import { mkdir, writeFile, rename, readdir, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { localDay } from '../web/scripts/lib/format.js';

// A backup is one JSON file with everything the player entered and the history the save can't give back.
export const BACKUP_FORMAT = 'rumble-tracker-backup';

/** `files` maps each data file's name (without .json) to its contents. */
export function buildBackup(files, now = new Date()) {
  return { format: BACKUP_FORMAT, version: 1, created: now.toISOString(), data: files };
}

/** Replaces an object's contents in place (other code holds references to it). */
export function replaceContents(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

/**
 * Restores a backup into `files` in place. Keys missing from the backup (older or partial backups) are left as they
 * are. Returns the restored keys, or null if this isn't a backup.
 */
export function restoreBackup(files, backup) {
  if (!backup || backup.format !== BACKUP_FORMAT || !backup.data || typeof backup.data !== 'object') return null;
  const restored = [];
  for (const [key, obj] of Object.entries(files)) {
    const incoming = backup.data[key];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    replaceContents(obj, incoming);
    restored.push(key);
  }
  return restored;
}

// Automatic backups keep one file per local day, replaced by later backups that day, and are deleted after KEEP_DAYS.
const KEEP_DAYS = 7;
const DAILY = /^rumble-tracker-backup-(\d{4}-\d{2}-\d{2})\.json$/;
/** A backup's file name, for automatic backups and exports alike. `day` is a local YYYY-MM-DD. */
export const backupFileName = (day) => `rumble-tracker-backup-${day}.json`;

/** Writes today's backup into `dir` and deletes those older than KEEP_DAYS. Returns the file's path. */
export async function writeDailyBackup(dir, files, { now = new Date(), keepDays = KEEP_DAYS } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, backupFileName(localDay(now)));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(buildBackup(files, now)));
  await rename(tmp, file);
  const oldest = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keepDays - 1)));
  for (const n of await readdir(dir)) {
    const m = DAILY.exec(n);
    if (m && m[1] < oldest) await rm(path.join(dir, n), { force: true });
  }
  return file;
}

/** The automatic backups, newest first: [{ day, created, size }]. */
export async function listDailyBackups(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = DAILY.exec(n);
    if (!m) continue;
    const st = await stat(path.join(dir, n)).catch(() => null);
    if (st) out.push({ day: m[1], created: st.mtime.toISOString(), size: st.size });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}

/** Reads the automatic backup of a day (YYYY-MM-DD), or null. */
export async function readDailyBackup(dir, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
  try {
    return JSON.parse(await readFile(path.join(dir, backupFileName(day)), 'utf8'));
  } catch {
    return null;
  }
}
