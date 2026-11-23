// Names and units the page, the server and the build tools share. desktop/launcher.cjs keeps its own copies, as it
// runs before the app's files are unpacked.
export const APP_NAME = 'Rumble Collection Tracker';
export const EXE_NAME = 'RumbleTracker.exe';
export const REPO = 'razingo/rumble-tracker-ind';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
export const DEFAULT_PORT = 8765;

// What closing the exe's window can do (web/scripts/closing.js, server/main.mjs), with the Settings dialog's labels
export const CLOSE_CHOICES = { ask: 'Ask me', tray: 'Keep running in the tray', quit: 'Quit the tracker' };

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// How often the server reads the save while the game runs (server/main.mjs); the page asks right after each read.
export const SCAN_MS = 5 * SECOND;

export const MB = 1024 * 1024;
