// The connection between RumbleTracker.exe's launcher (desktop/launcher.cjs) and the server, which run in the same
// process. The launcher loads this module and calls attach() before it starts the server; when the tracker runs from
// source nothing attaches, and the server works on its own.
//
// The launcher passes in its start-up options, the window program's reports (the window was closed, whether the
// game runs, Quit from the tray or Windows shutting down) and the app ID notifications are sent under. It shows the
// window, installs downloaded updates, opens Windows' snipping overlay, restarts and uninstalls the tracker for the
// server.

let launcher = null;
let quitHandler = null;
const game = { running: null, failed: false, listeners: [] };
let identity = { appId: null, launch: null };
let windowClosedListener = null;

export const host = {
  /**
   * Called by the launcher with { options: { port, dataDir, storage: { folder, note } | null }, applyUpdate,
   * takeScreenshot, showWindow, restart, uninstall }.
   */
  attach(hooks) { launcher = hooks; },

  /** Whether the server runs inside RumbleTracker.exe. */
  get attached() { return !!launcher; },
  get options() { return launcher?.options || {}; },

  // Quit, from the tray or because Windows is signing out or shutting down.
  onQuit(fn) { quitHandler = fn; },
  /** Returns false when the server isn't running yet, so there is nothing to save. */
  quit(reason) {
    if (!quitHandler) return false;
    quitHandler(reason);
    return true;
  },

  // Whether Warcraft Rumble runs, as reported by the tray icon's process.
  reportGame(running) {
    if (running === game.running) return;
    game.running = running;
    for (const fn of game.listeners) fn.change(running);
  },
  /** The tray icon stopped or couldn't start, so it can't report any more. */
  gameWatchFailed() {
    game.failed = true;
    for (const fn of game.listeners) fn.failed();
  },
  /** change(running) on each new report, failed() if the reports stop. A report made earlier is passed on at once. */
  onGame(change, failed) {
    game.listeners.push({ change, failed });
    if (game.failed) failed();
    else if (game.running !== null) change(game.running);
  },

  // The user closed the window (desktop/window.ps1), once the page agreed (web/scripts/closing.js).
  windowClosed() { windowClosedListener?.(); },
  onWindowClosed(fn) { windowClosedListener = fn; },

  // The app ID notifications are sent under and the link a click opens, once the launcher has registered them.
  setNotificationIdentity(next) { identity = { ...identity, ...next }; },
  notificationIdentity() { return identity; },

  // What only the launcher can do.
  /** Installs the exe at `exe` and restarts the tracker; rejects with a message for the player. */
  async applyUpdate(update) {
    if (!launcher) throw new Error('This copy of the tracker can\'t install updates by itself.');
    return launcher.applyUpdate(update);
  },
  takeScreenshot() { launcher?.takeScreenshot(); },
  /** Opens the window or brings it to the front. */
  showWindow() { launcher?.showWindow(); },
  /** Stops the tracker and starts it again (to move its files, server/storage.mjs). */
  restart() { launcher?.restart(); },
  /** Stops the tracker and removes it from this PC (desktop/uninstall.ps1). */
  uninstall() { launcher?.uninstall(); },
};
