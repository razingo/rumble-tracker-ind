// Where RumbleTracker.exe keeps its files: one folder named RumbleTracker, in the folder the user picked. The launcher
// (desktop/launcher.cjs) asks for it on the first start, notes it, and passes the folder and the note's path on. A
// move asked for in Settings is checked and noted here; the launcher moves the files at the next start, before
// anything uses them, so the tracker restarts for it.
import path from 'node:path';
import { mkdir, readdir, readFile, rmdir, stat, statfs, writeFile, rename, rm } from 'node:fs/promises';

const FOLDER_NAME = 'RumbleTracker';
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (inner, outer) => (path.resolve(inner).toLowerCase() + path.sep).startsWith(path.resolve(outer).toLowerCase() + path.sep);

/** The folder the tracker makes for itself in the one picked; a folder already named so is used as it is. */
export function homeIn(picked) {
  const p = path.resolve(picked);
  return path.basename(p).toLowerCase() === FOLDER_NAME.toLowerCase() ? p : path.join(p, FOLDER_NAME);
}

/** The bytes of the files under a folder; the unpacked program at its top is left out (it is unpacked anew). */
async function bytesIn(dir, top = true) {
  let sum = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (top && e.name === 'app') continue;
    const p = path.join(dir, e.name);
    sum += e.isDirectory() ? await bytesIn(p, false) : (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return sum;
}

/**
 * Notes that the tracker's files are to move into the folder picked, and returns the tracker's folder there. Throws
 * with a message for the user when they can't go there. `storage` is { folder, note } from the launcher.
 */
export async function noteMove(storage, picked) {
  const given = String(picked || '').trim();
  if (!given || !path.isAbsolute(given)) throw new Error('Give the whole path of a folder, such as D:\\Games.');
  const home = homeIn(given);
  const noteDir = path.dirname(storage.note);
  if (same(home, storage.folder)) throw new Error('The tracker\'s files are already there.');
  if (inside(home, storage.folder) || inside(storage.folder, home)) {
    throw new Error('Pick a folder outside the one the files are in now.');
  }
  if (same(home, noteDir) || inside(home, noteDir)) {
    throw new Error('That folder holds the note of where the tracker\'s files are. Pick another.');
  }
  if ((await readdir(home).catch(() => [])).length) {
    throw new Error(`${home} already has files in it. Pick another folder, or empty that one.`);
  }
  // the folders that are made for the try: the tracker's own, and those above it that are not there
  const made = [];
  for (let d = home; !await stat(d).then(() => true, () => false); d = path.dirname(d)) {
    made.push(d);
    if (path.dirname(d) === d) break;
  }
  try {
    try {
      await mkdir(home, { recursive: true });
      const probe = path.join(home, '.write');
      await writeFile(probe, '');
      await rm(probe);
    } catch (e) {
      throw new Error(`The tracker can't write to that folder (${e.code || e.message}).`);
    }
    // the files are copied before the old ones go, so they need their room there, on the same disk too
    const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
    const needed = await bytesIn(storage.folder);
    const free = await statfs(home).then((s) => s.bavail * s.bsize, () => null);
    if (free != null && needed > free) throw new Error(`The files take ${gb(needed)} GB, and ${gb(free)} GB is free there.`);
    // (what an earlier move left to remove stays in the note)
    const clear = await readFile(storage.note, 'utf8').then((text) => JSON.parse(text).clear, () => null);
    // (`made`: the folders made here, which go again if the move can't be done)
    const note = { folder: storage.folder, moveTo: home, ...(made.length && { made }),
      ...(Array.isArray(clear) && clear.length && { clear }) };
    await writeFile(`${storage.note}.tmp`, JSON.stringify(note, null, 2));
    await rename(`${storage.note}.tmp`, storage.note);
  } catch (e) {
    for (const d of made) await rmdir(d).catch(() => {}); // they do not stay
    throw e;
  }
  return home;
}
