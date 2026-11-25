// The rdmodule, the page behind the tracker's hidden key sequence (web/scripts/rdmodule.js). Its code is in
// rdmodule/; its pictures and sounds are not: Settings can have them extracted from the game install, in the
// background (tools/rdmodule/extract.mjs), into <data>/rdmodule. Its window only opens once that is done.
import path from 'node:path';
import { stat, statfs, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { totalmem } from 'node:os';
import { givenGameFolder } from './game/folder.mjs';
import { briefError } from './report.mjs';

const DUE_MS = 30000;
const gb = (bytes) => (bytes / 2 ** 30).toFixed(1).replace(/\.0$/, '');
// What an extraction takes on the disk while it runs: about 1 GB of exports and two copies of the 0.3 GB result.
const SPACE_NEEDED = 2 * 2 ** 30;
const SMALL_PC = 9 * 2 ** 30; // a PC sold with 8 GB reports a little less; one with 12 or 16 is not small

/** The rdmodule in the tracker: status() for the page, start() for Settings, and the folders it is served from. */
export function createRdmodule(ctx) {
  const { ROOT, DATA, GAMEDATA, STATIC } = ctx.paths;
  const out = path.join(DATA, 'rdmodule');
  const work = path.join(DATA, 'rdmodule-build');
  // state: idle, running, failed. waiting: it runs, but has not begun, as the game data is being read first
  const run = { state: 'idle', waiting: false, done: 0, total: 0, label: '', error: null };
  let tool; // tools/rdmodule/extract.mjs, or null where the tracker doesn't carry it
  const load = async () => {
    if (tool === undefined) tool = await import(pathToFileURL(path.join(ROOT, 'tools', 'rdmodule', 'extract.mjs')).href).catch(() => null);
    return tool;
  };
  const exists = (file) => stat(file).then(() => true, () => false);
  const freeSpace = () => statfs(DATA).then((s) => s.bavail * s.bsize, () => null);
  const due = { at: 0, is: false }; // whether the extraction is out of date, and when that was last looked at

  return {
    /** Where its code and what was extracted for it are served from. */
    folders: { code: path.join(ROOT, 'rdmodule'), extracted: out },
    /**
     * { available, state: none | running | ready | failed, waiting, extracted, outOfDate, done, total, label, error },
     * where `waiting` says a running extraction has not begun yet (the game data is being read first),
     * `extracted` is when the data that is there was extracted (it stays while a new extraction runs, or after one
     * failed), `outOfDate` whether the game or the tracker changed since, so that extracting again has work to do,
     * `smallPc` whether this PC has so little memory that the extraction may trouble it, and `freeSpace` and
     * `neededSpace` the bytes free on the data folder's disk (null when Windows does not say) and the bytes needed.
     */
    async status() {
      const t = await load();
      // (a stamp that is not there, or damaged, is no extraction)
      const extracted = await readFile(path.join(out, 'ready.json'), 'utf8').then((s) => JSON.parse(s).extracted || true)
        .catch(() => null);
      // (finding the game asks Windows where it is: the answer is kept for half a minute, as the page asks often)
      if (extracted && Date.now() - due.at > DUE_MS) {
        Object.assign(due, { at: Date.now(), is: !!t?.outOfDate(out, await givenGameFolder(ctx)) });
      }
      return { available: !!t?.canExtract(), state: run.state !== 'idle' ? run.state : extracted ? 'ready' : 'none',
        waiting: run.waiting, extracted, outOfDate: !!extracted && due.is, smallPc: totalmem() < SMALL_PC,
        freeSpace: await freeSpace(), neededSpace: SPACE_NEEDED,
        done: run.done, total: run.total, label: run.label, error: run.error };
    },
    /**
     * Starts the extraction unless it runs already. It goes on in the background; status() tells how far it is.
     * False where this tracker cannot extract; throws, with a message for the player, when the disk is too full.
     */
    async start() {
      const t = await load();
      if (!t?.canExtract()) return false;
      if (run.state === 'running') return true;
      // (it counts as running from here on, so a second request that comes meanwhile starts nothing)
      Object.assign(run, { state: 'running', waiting: true, done: 0, total: 0, label: '', error: null });
      const free = await freeSpace();
      if (free !== null && free < SPACE_NEEDED) {
        Object.assign(run, { state: 'idle', waiting: false });
        throw new Error(`The disk is too full: this needs about ${gb(SPACE_NEEDED)} GB free, and ${gb(free)} GB is.`);
      }
      const gameFolder = await givenGameFolder(ctx);
      // (after a read of the game data that runs now: the PC never carries both)
      ctx.oneAtATime(async () => {
        run.waiting = false;
        console.log('Rdmodule: extracting from the game install');
        return t.extractRdmodule({
          gameFolder,
          gamedata: await exists(path.join(GAMEDATA, 'minis.json')) ? GAMEDATA : STATIC, out, work, log: console.log,
          onStep: (done, total, label) => Object.assign(run, { done, total, label }),
        });
      }).then((ran) => {
        due.at = 0;
        Object.assign(run, { state: 'idle', done: 0, total: 0, label: '' });
        console.log(ran.length ? `Rdmodule: extracted (${ran.length} steps)` : 'Rdmodule: nothing was due');
      }, (e) => {
        Object.assign(run, { state: 'failed', waiting: false, error: briefError(e) });
        console.log(`Rdmodule: extraction failed: ${e.message}`);
        ctx.errorLog.add('rdmodule', e.message);
      });
      return true;
    },
  };
}
