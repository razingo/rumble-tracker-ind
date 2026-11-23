// The rdmodule, the page behind the tracker's hidden key sequence (web/scripts/rdmodule.js). Its code is in
// rdmodule/; its pictures and sounds are not: Settings can have them extracted from the game install, in the
// background (tools/rdmodule/extract.mjs), into <data>/rdmodule. The game window only opens once that is done.
import path from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { givenGameFolder } from './game/folder.mjs';

/** The rdmodule in the tracker: status() for the page, start() for Settings, and the folders it is served from. */
export function createRdmodule(ctx) {
  const { ROOT, DATA, GAMEDATA, STATIC } = ctx.paths;
  const out = path.join(DATA, 'rdmodule');
  const work = path.join(DATA, 'rdmodule-build');
  const run = { state: 'idle', done: 0, total: 0, label: '', error: null }; // state: idle, running, failed
  let tool; // tools/rdmodule/extract.mjs, or null where the tracker doesn't carry it
  const load = async () => {
    if (tool === undefined) tool = await import(pathToFileURL(path.join(ROOT, 'tools', 'rdmodule', 'extract.mjs')).href).catch(() => null);
    return tool;
  };
  const exists = (file) => stat(file).then(() => true, () => false);

  return {
    /** Where the game's code and what was extracted for it are served from. */
    folders: { game: path.join(ROOT, 'rdmodule'), extracted: out },
    /**
     * { available, state: none | running | ready | failed, extracted, done, total, label, error }, where `extracted`
     * is when the data that is there was extracted (it stays while a new extraction runs, or after one failed).
     */
    async status() {
      const t = await load();
      const extracted = await readFile(path.join(out, 'ready.json'), 'utf8').then((s) => JSON.parse(s).extracted || true, () => null);
      return { available: !!t?.canExtract(), state: run.state !== 'idle' ? run.state : extracted ? 'ready' : 'none', extracted,
        done: run.done, total: run.total, label: run.label, error: run.error };
    },
    /** Starts the extraction unless it runs already. It goes on in the background; status() tells how far it is. */
    async start() {
      const t = await load();
      if (!t?.canExtract()) return false;
      if (run.state === 'running') return true;
      Object.assign(run, { state: 'running', done: 0, total: 0, label: '', error: null });
      console.log('Rdmodule: extracting from the game install');
      t.extractRdmodule({
        gameFolder: await givenGameFolder(ctx),
        gamedata: await exists(path.join(GAMEDATA, 'minis.json')) ? GAMEDATA : STATIC, out, work, log: console.log,
        onStep: (done, total, label) => Object.assign(run, { done, total, label }),
      }).then(() => {
        Object.assign(run, { state: 'idle', done: 0, total: 0, label: '' });
        console.log('Rdmodule: extracted');
      }, (e) => {
        Object.assign(run, { state: 'failed', error: e.message.split('\n')[0] });
        console.log(`Rdmodule: extraction failed: ${e.message}`);
        ctx.errorLog.add('rdmodule', e.message);
      });
      return true;
    },
  };
}
