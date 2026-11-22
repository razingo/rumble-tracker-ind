# Rumble Collection Tracker

An unofficial collection, army and event tracker for **Warcraft Rumble on PC**. It reads your progress from the
game's saved data on your own PC (read-only) and shows it in a window of its own: your minis and their levels, talents
and upgrade costs, armies, the G.R.I.D. and what's on cooldown, events and reward trees, shop offers, your progress
over time, and optional Windows notifications.

**Not affiliated with or endorsed by Blizzard Entertainment.** Game art and data © Blizzard Entertainment; see
[NOTICE.md](NOTICE.md).

## Download and run

You need Windows 10 or 11 (64-bit) and Warcraft Rumble for PC installed, played at least once on this PC. Nothing
else: no Node.js, no Python, no installer, no internet connection.

1. Open [Releases](https://github.com/razingo/rumble-tracker-ind/releases/latest) and download
   `RumbleTracker-<version>-win-x64.zip`, or build the exe yourself ([SELF-BUILD.md](SELF-BUILD.md)).
2. Extract the zip anywhere (for example to `Documents\RumbleTracker`) and double-click **RumbleTracker.exe**.
3. The tracker opens in its own window. The first time, it reads its game data from your game install, with a
   loading bar (about a minute), then shows the tracker.

**This tracker is independent of any download for its game data.** Names, stats, events, shop offers and all images
are read from the Warcraft Rumble installed on your PC; the exe carries none of them and fetches none.

The tracker reads the game's save every few seconds, so the window updates on its own while you play. The
**[player guide](https://github.com/razingo/rumble-tracker-ind/blob/main/docs/INSTRUCTIONS.md)** walks through every tab.

### Its own window

The tracker is one program with its own window and tray icon. The window shows the tracker's page with Microsoft Edge
WebView2, which comes with Windows 10 and 11. It doesn't use your browser, so your bookmarks, extensions and logins
aren't touched; links to other sites open in your default browser. On the rare PC without WebView2, the tracker
only explains how to install it from Microsoft; start it again once WebView2 is installed.

It uses the same data as the tracker with a browser window (version 0.9 and earlier), so it replaces that one: if the
browser-window tracker is running when you start this one, it's asked to quit first.

### The tray icon

The first time you close the window, the tracker asks whether to keep running in the tray or quit, and remembers your
answer (you can change it in **⚙ Settings**). In the tray it runs as an icon in the taskbar's notification area (click
**^** if it's hidden), so notifications still arrive. Click the icon to bring the window back, or right-click it for
*Open data folder* and *Quit the tracker*. **⏻ Quit** at the top of the page stops it too, and starting the exe again
while it runs just shows the window. To start it whenever you sign in to Windows, tick *Start with Windows* in
**⚙ Settings**.

### "Windows protected your PC"

The exe isn't code-signed (that costs money every year), so Windows SmartScreen may warn you the first time. Click
**More info → Run anyway**. You can check that your download is the published one: each release lists the SHA-256
checksums of the zip and the exe; in PowerShell, `Get-FileHash .\RumbleTracker.exe` should show the same value.
Releases are built by GitHub Actions from this repository's source; with the GitHub CLI you can confirm that too:
`gh attestation verify RumbleTracker.exe --repo razingo/rumble-tracker-ind`.

## Your data

| What | Where |
|---|---|
| Your own data: names you gave, armies, talents, G.R.I.D. and PvP history, progress, notification settings, downloaded game data and app updates | `%APPDATA%\RumbleTracker` |
| Automatic backups (one a day, kept for 7 days) | `%APPDATA%\RumbleTracker\backups` |
| The tracker's log (`tracker.log`, attach it to a bug report if asked) | `%APPDATA%\RumbleTracker` |
| The program's files, unpacked from the exe on first start, and the window's WebView2 data | `%LOCALAPPDATA%\RumbleTracker` |

Paste either path into the Explorer address bar to open it. *Backup → Export backup* in the tracker saves everything
to one JSON file, which *Import backup…* restores, also on another PC.

### Updating

When a new version is out, the tracker offers to install it. *Download now* fetches the release from GitHub, checks it
against the checksums in the signed data pack, replaces `RumbleTracker.exe` and restarts; if the new version fails to
start, the previous one is put back. You can also download the release yourself and replace the exe. Either way your
data stays where it is. The [changelog](CHANGELOG.md) lists what changed.

### Uninstalling

**⚙ Settings → Uninstall the tracker…** removes the exe, the two `RumbleTracker` folders above, the Start menu shortcut
and Start with Windows. Export a backup first if you might come back.
[How the tracker works](docs/HOW-IT-WORKS.md#uninstalling) has the details, including how to do it by hand, along with
everything the tracker does in the background and every place it stores something.

## Game data updates

After a game patch, the next start of the tracker sees that the game's files changed and reads its game data again
from your game install, with the same loading bar as on the first start. Nothing is downloaded. A mini that a patch
adds only shows once a new version of the tracker knows its save ID; this tracker doesn't update itself, so download
or build the new version (your data is kept).

## Privacy

- The tracker only **reads** the game's saved data (from the Windows registry). It never changes it, and it ignores
  the login tokens stored next to it.
- It sends nothing about you anywhere and downloads nothing. *Report a problem* and the other links open in your own
  browser.
- The local page is only reachable from this PC, and only by the tracker's own page.

## Found a problem?

Click **Report a problem** in the tracker. It shows a short report with technical details (versions and recent
errors, with user names, account IDs and other personal details removed) and opens it as a pre-filled
[issue](https://github.com/razingo/rumble-tracker-ind/issues), which you can edit before you press Submit. This needs a
free GitHub account. You can also open an issue yourself with the *Bug report* template.

## Support

The tracker is free, with nothing to buy or unlock, and it stays that way. If you'd like to say thanks,
**☕ Buy me a coffee** at the top of the page is a voluntary way to support its development.

## Options

Start `RumbleTracker.exe` from a Command Prompt or a shortcut to use these:

- **No window at start** (just the tray icon): `RumbleTracker.exe --background` (what *Start with Windows* uses).
- **Port:** the tracker uses <http://localhost:8765>, or the next free port up to 8784 if another program has it. To
  use one specific port: `set PORT=8800` before starting the exe.
- **Data pack address:** `"dataPackUrl": "https://…/"` in `%APPDATA%\RumbleTracker\config.json` (https only).

## License

The tracker's code is MIT-licensed ([LICENSE](LICENSE)). That license doesn't cover the game art and data, which belong
to Blizzard Entertainment ([NOTICE.md](NOTICE.md)). The exe contains the Node.js runtime, Microsoft's WebView2
libraries and two open-licensed fonts, whose licenses are in `THIRD-PARTY-NOTICES` in the zip.

## For developers

The tracker is plain Node.js (no npm packages): a local server that reads the game's save and a page it serves on this
PC only. Run it from source with Node.js 22 or newer on Windows:

```
npm run build-gamedata
npm start
```

`build-gamedata` reads the game data and art from your game install into `gamedata/` (once, and again after a game
patch); they aren't in this repository. [SELF-BUILD.md](SELF-BUILD.md) describes it, and how the exe is built with
the builder and its own Python inside. From source there's no window or tray icon: `npm start` runs the server, and
you open http://localhost:8765 in your browser. Your data goes to `data/` in the project folder, or to the folder in
`RUMBLE_DATA_DIR`.

`npm run fetch-webview2` downloads the window's WebView2 libraries into `desktop/webview2/` (a pinned version, checked
against its checksum and Microsoft's signature); the window's tests and `npm run build-release` need them.

`npm test` runs the tests, which need neither game data nor a save. `npm run check-style` checks the files against
`.editorconfig` (lines up to 140 characters and comments up to 120, LF, no tabs or trailing spaces); CI runs both.

Environment variables for development and testing:

| Variable | What it does |
|---|---|
| `RUMBLE_DATA_DIR` | The data folder, instead of `data/` (from source) or `%APPDATA%\RumbleTracker` (exe) |
| `PORT` | One fixed port; `RUMBLE_FIRST_PORT` moves the range of 20 ports the exe tries instead |
| `RUMBLE_DATA_PACK_URL` | The data pack address for `fetch-gamedata` and the update checks. From source the tracker only checks for game data updates when this or `dataPackUrl` is set |
| `RUMBLE_GAME_DIR` | The game's folder, when Windows has no install entry for it |
| `RUMBLE_SELF_BUILD` | From source, read the game data from the game install at start, as the exe does |
| `RUMBLE_PYTHON` | The Python the image steps use, instead of the private one or one found on this PC |
| `RUMBLE_ISSUES_REPO` | The repository *Report a problem* opens issues in, as `owner/name` |
| `RUMBLE_RELEASE_OUT` | Where `npm run build-release` writes, instead of `dist/release` |
| `GIT` | The Git the tools run, when it isn't in Git for Windows' usual place |

| Folder | What |
|---|---|
| `server/` | The local server. `main.mjs` starts the parts and runs the timers. `host.mjs` connects it to the exe's launcher when there is one. Also the shared state (`context.mjs`), game tables (`tables.mjs`), the user's files (`userdata.mjs`, `store.mjs`), the page's state (`state.mjs`), backups, request filtering (`guard.mjs`), Start with Windows (`autostart.mjs`), the problem report's details (`report.mjs`), downloads with a size limit (`download.mjs`) and the Windows programs it runs (`system.mjs`) |
| `server/scan/` | Reading the save on a timer (`scanner.mjs`) and the history kept from it (`history.mjs`) |
| `server/http/` | The HTTP server and static files (`server.mjs`), the API routes (`routes.mjs`) and the handlers that change the user's data (`handlers.mjs`) |
| `server/update/` | In-app updates: the download and its checks (`appupdate.mjs`), and *Download now* (`updater.mjs`) |
| `server/game/` | The save: reading it from the registry (`prefs.mjs`), decoding it (`model.mjs`, with `web/scripts/lib/protobuf.js`), currency names, PvP match results and whether the game runs (`watch.mjs`) |
| `server/notifications/` | What's due (`notify.mjs`), sending it (`runner.mjs`) and the Windows notification itself (`toast.mjs`) |
| `server/datapack/` | Reading the game data from the game install at start, with its progress page (`selfbuild.mjs`). Also the signed data packs of the tracker this one comes from, unused here unless a pack address is set (`datapack.mjs`, `checker.mjs`, `firstrun.mjs`, the accepted public keys) |
| `web/` | The page. `scripts/app.js` starts it and switches tabs, `core.js` holds what the modules share, and each tab, dialog and menu has its own module; the Army tab also has `army-code.js` (army codes) and `army-pools.js`. `scripts/lib/` has the code the server and build tools use too: shared names and units, formatting, the protobuf reader and writer, schedules, PvP seasons, input limits and the reward-tree planner. `styles/style.css` is the page's look; `styles/art.css` adds the textures and frames from the game files |
| `gamedata/` | Game data and art (© Blizzard, see NOTICE), served as `/static/…`. Not in the repository; `npm run build-gamedata` fills it from the game install |
| `desktop/` | The exe's launcher (`launcher.cjs`), the window and tray icon (`window.ps1`, with the WebView2 libraries in `webview2/`), Windows integration (`integration.ps1`), Uninstall in Settings (`uninstall.ps1`) and the script that draws the icon (`make-icon.ps1`, into `web/favicon.ico`) |
| `tools/` | The game-data builder (`gamedata/`: `build.mjs` runs the steps, the table builders, the image extractors, and `seed/` with the few tables kept by hand), the private Python for the exe (`fetch-python.mjs`) and the WebView2 libraries (`fetch-webview2.ps1`), building the release (`build-release.mjs`, Node.js 25.5+) and the style check (`check-style.mjs`); `git.mjs` finds Git for the ones that need it |
| `test/` | Node's built-in test runner. `helpers.mjs` builds save values and a tracker in a temporary folder; the tests of the window, tray and Windows integration (`desktop.test.mjs`) run on Windows only |
| `.github/workflows/` | `test.yml` runs the tests and the style check on every push; `release.yml` builds and attests a release when a `v<version>` tag is pushed, once the tests of that commit passed |
| `docs/` | The player guide with its screenshots, and how the tracker works in the background |

**Security.** The server listens on 127.0.0.1 only and answers only the tracker's own page: requests for another host
name, from another website, or API writes that aren't JSON are refused. The page runs under a strict content security
policy (only its own scripts, no inline script, network requests only to the local server), so keep page code free of
inline event handlers.

Bug reports and pull requests are welcome: [issues](https://github.com/razingo/rumble-tracker-ind/issues).
