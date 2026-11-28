// What the tracker asks of Windows. platform/index.mjs says what each of these is to do.
import { execFile } from 'node:child_process';
import { EXPLORER } from './system.mjs';
import { readRumblePrefs } from './prefs.mjs';
import { watchGame, watchGameFromTray, gameRunningOnce } from './watch.mjs';
import { showToast } from './toast.mjs';
import { readAutostart, setAutostart, refreshAutostart, autostartCommand } from './autostart.mjs';

export const name = 'windows';
export const readSave = readRumblePrefs;
export { watchGame, watchGameFromTray, gameRunningOnce };
export const showNotification = showToast;
export const autostart = { command: autostartCommand, read: readAutostart, set: setAutostart, refresh: refreshAutostart };
/** Shows a folder in Explorer. */
export const openFolder = (folder) => { execFile(EXPLORER, [folder], () => {}); };
