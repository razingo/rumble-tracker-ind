// Start with Windows adds a value to the current user's Run key, which starts the exe in the tray without a window.
// Running from source has no exe, so the option isn't offered there.
import { execFile } from 'node:child_process';
import { REG } from './system.mjs';
import { SECOND } from '../web/scripts/lib/constants.js';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'RumbleCollectionTracker';

const reg = (args) => new Promise((resolve) => {
  execFile(REG, args, { windowsHide: true, timeout: 10 * SECOND }, (err, out) => resolve({ ok: !err, out: out || '' }));
});

/** The command Windows runs at sign-in. */
export const autostartCommand = (exe) => `"${exe}" --background`;

/** The registered command, or null. */
export async function readAutostart() {
  const r = await reg(['query', KEY, '/v', NAME]);
  const m = r.ok && /REG_SZ\s+(.*)$/m.exec(r.out);
  return m ? m[1].trim() : null;
}

/** Turns it on (for this exe) or off. Resolves to true on success. */
export async function setAutostart(on, exe) {
  if (on) return (await reg(['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', autostartCommand(exe), '/f'])).ok;
  if (!(await readAutostart())) return true;
  return (await reg(['delete', KEY, '/v', NAME, '/f'])).ok;
}

/** If it is on but names another exe (the tracker was moved), points it at this one. */
export async function refreshAutostart(exe) {
  const cmd = await readAutostart();
  if (cmd && cmd !== autostartCommand(exe)) await setAutostart(true, exe);
}
