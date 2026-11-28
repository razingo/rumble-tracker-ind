// Everything the server asks of the system it runs on goes through `platform`, so that a port to another system is
// one more folder here and nothing else. Each system's module exports:
//
//   name                               'windows', ...
//   readSave()                         the game's save: { account ID: { units, currencies, store, profile, commerce,
//                                      pvp } }, each a Buffer holding a protobuf message (scan/scanner.mjs). Rejects
//                                      with a message for the player when it can't be read.
//   watchGame(onChange, onFail)        watches whether the game runs: onChange(running) on the first report and on
//                                      every change, onFail(message) when it can't go on. Returns { running() }, the
//                                      last report (null while that isn't known).
//   watchGameFromTray(onChange, onFail)  the same, from the reports of the window's own process (host.mjs)
//   gameRunningOnce()                  one check, resolving with true or false
//   showNotification(title, body)      resolves with whether the system accepted it
//   autostart                          { command(exe), read(), set(on, exe), refresh(exe) } for starting with the
//                                      system, or null where the tracker can't
//   openFolder(folder)                 shows a folder in the system's file manager
//
// Not behind this yet, and Windows only as well: the window, tray icon and installer (desktop/, reached through
// host.mjs), reading the game data from the game install (gamedata.mjs, tools/gamedata) and the app update (update/).
import * as windows from './windows/index.mjs';
import * as none from './none.mjs';

export const platform = process.platform === 'win32' ? windows : none;
