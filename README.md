# Rumble Collection Tracker

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/razingo)

An unofficial collection, army and event tracker for **Warcraft Rumble on PC**. It reads your progress from the
game's saved data on your own PC (read-only) and shows it in a window of its own: your minis and their levels, talents
and upgrade costs, armies, the G.R.I.D. and what's on cooldown, events and reward trees, shop offers, PvP seasons,
your progress over time, and optional Windows notifications.

**Not affiliated with or endorsed by Blizzard Entertainment.** Game art and data © Blizzard Entertainment; see
[NOTICE.md](NOTICE.md).

## Download and run

You need Windows 10 or 11 (64-bit) and Warcraft Rumble for PC installed, played at least once on this PC. Nothing
else: no Node.js, no Python, no installer.

1. Open [Releases](https://github.com/razingo/rumble-tracker-ind/releases/latest) and download
   `RumbleTracker-<version>-win-x64.zip`, or build the exe yourself ([SELF-BUILD.md](SELF-BUILD.md)).
2. Extract the zip anywhere (for example to your Desktop) and double-click **RumbleTracker.exe**.
3. The first time, the tracker asks where to keep its files. It makes a folder named `RumbleTracker` in the folder
   you pick and keeps everything there; you can move it later in **⚙ Settings**.
4. The tracker opens in its own window. The first time, it reads its game data from your game install, with a
   loading bar (about a minute), then shows the tracker.

**The tracker needs no download for its game data.** Names, stats, events, shop offers and all images are read from
the Warcraft Rumble installed on your PC; the exe carries none of them and fetches none.

The tracker reads the game's save every few seconds, so the window updates on its own while you play. The
**[player guide](https://github.com/razingo/rumble-tracker-ind/blob/main/docs/INSTRUCTIONS.md)** walks through every tab.

### Its own window

The tracker is one program with its own window and tray icon. The window has a title bar in the tracker's look, with
its own buttons to minimize, maximize and close; it is resized by its edges and snaps as any window. The window shows
the tracker's page with Microsoft Edge WebView2, which comes with Windows 10 and 11. It doesn't use your browser, so
your bookmarks, extensions and logins aren't touched; links to other sites open in your default browser. On the rare
PC without WebView2, the tracker only explains how to install it from Microsoft; start it again once WebView2 is
installed.

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
| Your own data: names you gave, armies, talents, G.R.I.D. and PvP history, progress, notification settings, and the game data read from your game install | `data` |
| Automatic backups (one a day, kept for 7 days) | `data\backups` |
| The tracker's log (`tracker.log`, attach it to a bug report if asked) | `data` |
| The program's files, unpacked from the exe on first start | `app` |
| The window's WebView2 data | `webview2` |

All of it is in one folder named `RumbleTracker`. The first start asks where to put it, with `%LOCALAPPDATA%` filled
in; the tracker makes the `RumbleTracker` folder there. **⚙ Settings → The tracker's folder** shows where it is, opens
it, and moves it: type another folder and the tracker moves its files there and restarts. A small note of where the
folder is stays in `%APPDATA%\RumbleTracker`.

*Backup → Export backup* in the tracker saves everything to one JSON file, which *Import backup…* restores, also on
another PC.

### Updating

When its window opens, and once a day, the tracker asks GitHub whether a newer version is out, and offers it in a
pop-up. *Download now* fetches the release, checks it against the checksums published with it, replaces
`RumbleTracker.exe` and restarts; if the new version fails to start, the previous one is put back. An exe you built
yourself is only told about the new version, and is left as it is. You can also download the release and replace the
exe by hand. Either way your data stays where it is. The check can be turned off in **⚙ Settings**. The
[changelog](CHANGELOG.md) lists what changed.

### Uninstalling

**⚙ Settings → Uninstall the tracker…** removes the exe, the tracker's folder, the Start menu shortcut and Start with
Windows. It offers to keep a backup of your data first, in a file where you choose, for if you come back.
[How the tracker works](docs/HOW-IT-WORKS.md#uninstalling) has the details, including how to do it by hand, along with
everything the tracker does in the background and every place it stores something.

## Game data updates

After a game patch the tracker notices that the installed game is a newer version than its game data, and reads the
data again from your game install. It does that in the background, at low priority, while you keep using the tracker;
a banner says so, and the window picks the new data up when it is ready. It looks at start, when the game closes and
every half hour. Nothing is downloaded.

A mini that a patch adds is read with the rest, once the game's files name it.

## Privacy

- The tracker only **reads** the game's saved data (from the Windows registry). It never changes it, and it ignores
  the login tokens stored next to it.
- It sends nothing about you anywhere. Its only request to the internet asks GitHub for the tracker's latest version,
  when its window opens and once a day, and can be turned off in **⚙ Settings**; a new version is downloaded only when
  you click *Download now*. *Report a problem* and the other links open in your own browser.
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
- **The game's folder**, if the tracker doesn't find the game: `set RUMBLE_GAME_DIR=D:\Games\Warcraft Rumble` before
  starting the exe, or the field in **⚙ Settings**.

## License

The tracker's code is MIT-licensed ([LICENSE](LICENSE)). That license doesn't cover the game art and data, which belong
to Blizzard Entertainment ([NOTICE.md](NOTICE.md)). The exe contains the Node.js runtime, Microsoft's WebView2
libraries, two open-licensed fonts, and Python with the packages that read the game's images; their licenses are in
`THIRD-PARTY-NOTICES` in the zip.

## For developers

The tracker is plain Node.js (no npm packages): a local server that reads the game's save and a page it serves on this
PC only. Run it from source with Node.js 22 or newer on Windows:

```
npm run build-gamedata
npm start
```

`build-gamedata` reads the game data and art from your game install into `gamedata/`; they aren't in this repository.
(Without it, `npm start` reads them itself on its first start, as the exe does.) [SELF-BUILD.md](SELF-BUILD.md)
describes it, and how the exe is built with the builder and its own Python inside. From source there's no window or
tray icon: `npm start` runs the server, and you open http://localhost:8765 in your browser. Your data goes to `data/`
in the project folder, or to the folder in `RUMBLE_DATA_DIR`.

`npm run fetch-webview2` downloads the window's WebView2 libraries into `desktop/webview2/` (a pinned version, checked
against its checksum and Microsoft's signature); the window's tests and `npm run build-release` need them.

`npm test` runs the tests, which need neither game data nor a save. `npm run check-style` checks the files against
`.editorconfig` (lines up to 140 characters and comments up to 120, LF, no tabs or trailing spaces); CI runs both.

Environment variables for development and testing:

| Variable | What it does |
|---|---|
| `RUMBLE_DATA_DIR` | The data folder, instead of `data/` (from source) or `data` in the tracker's folder (exe) |
| `PORT` | One fixed port; `RUMBLE_FIRST_PORT` moves the range of 20 ports the exe tries instead |
| `RUMBLE_GAME_DIR` | The game's folder, when Windows has no install entry for it |
| `RUMBLE_PYTHON` | The Python the image steps use, instead of the private one or one found on this PC |
| `RUMBLE_ISSUES_REPO` | The repository *Report a problem* opens issues in, as `owner/name` |
| `RUMBLE_RELEASE_OUT` | Where `npm run build-release` writes, instead of `dist/release` |
| `GIT` | The Git the tools run, when it isn't in Git for Windows' usual place |

| Folder | What |
|---|---|
| `server/` | The local server. `main.mjs` starts the parts and runs the timers. `host.mjs` connects it to the exe's launcher when there is one. Also the shared state (`context.mjs`), game tables (`tables.mjs`), the user's files (`userdata.mjs`, `store.mjs`), the page's state (`state.mjs`), backups, request filtering (`guard.mjs`), Start with Windows (`autostart.mjs`), the problem report's details (`report.mjs`), moving the tracker's folder (`storage.mjs`), downloads with a size limit (`download.mjs`) and the Windows programs it runs (`system.mjs`) |
| `server/scan/` | Reading the save on a timer (`scanner.mjs`) and the history kept from it (`history.mjs`) |
| `server/http/` | The HTTP server and static files (`server.mjs`), the API routes (`routes.mjs`) and the handlers that change the user's data (`handlers.mjs`) |
| `server/update/` | New versions: asking GitHub for the latest release (`checker.mjs`), the download and its checks (`appupdate.mjs`), and *Download now* (`updater.mjs`) |
| `server/game/` | The save: reading it from the registry (`prefs.mjs`), decoding it (`model.mjs`, with `web/scripts/lib/protobuf.js`), currency names, PvP match results, whether the game runs (`watch.mjs`) and the game's folder when it is given by hand (`folder.mjs`) |
| `server/notifications/` | What's due (`notify.mjs`), sending it (`runner.mjs`) and the Windows notification itself (`toast.mjs`) |
| `server/gamedata.mjs` | Reading the game data from the game install: the first time behind a loading page, after a game patch in the background |
| `web/` | The page. `scripts/app.js` starts it and switches tabs, `core.js` holds what the modules share, and each tab, dialog and menu has its own module; the Army tab also has `army-code.js` (army codes) and `army-pools.js`. `scripts/lib/` has the code the server and build tools use too: shared names and units, formatting, the protobuf reader and writer, schedules, PvP seasons, input limits and the reward-tree planner. `styles/style.css` is the page's look; `styles/art.css` adds the textures and frames from the game files |
| `gamedata/` | Game data and art (© Blizzard, see NOTICE), served as `/static/…`. Not in the repository; read from the game install |
| `desktop/` | The exe's launcher (`launcher.cjs`), the window and tray icon (`window.ps1`, with the WebView2 libraries in `webview2/`), the pop-ups shown before the window can open (`popup.ps1`, with the title font `LilitaOne-Regular.ttf`), Windows integration (`integration.ps1`), Uninstall in Settings (`uninstall.ps1`) and the script that draws the icon (`make-icon.ps1`, into `web/favicon.ico`) |
| `tools/gamedata/` | The game-data builder: `build.mjs` runs the steps, with the table builders, the image extractors and `seed/`, the tracker's own few tables |
| `tools/` | What the exe carries (`fetch-python.mjs`, `fetch-webview2.ps1`), building the release (`build-release.mjs`, Node.js 25.5+) and the checks: style (`check-style.mjs`), that two reads of the game data give the same files (`check-gamedata.mjs`) and pinned software with a newer version out (`check-pins.mjs`). `git.mjs` finds Git for the ones that need it |
| `test/` | Node's built-in test runner. `helpers.mjs` builds save values and a tracker in a temporary folder; the tests of the window, tray and Windows integration (`desktop.test.mjs`) run on Windows only |
| `.github/workflows/` | `test.yml` runs the tests and the style check on every push, compiles the Python scripts, and builds the exe on pushes to `main`; `pins.yml` runs `check-pins` once a month; `release.yml` builds and attests a release when a `v<version>` tag is pushed, once the tests of that commit passed |
| `docs/` | The player guide with its screenshots, and how the tracker works in the background |

**Security.** The server listens on 127.0.0.1 only and answers only the tracker's own page: requests for another host
name, from another website, or API writes that aren't JSON are refused. The page runs under a strict content security
policy (only its own scripts, no inline script, network requests only to the local server), so keep page code free of
inline event handlers.

Bug reports and pull requests are welcome: [issues](https://github.com/razingo/rumble-tracker-ind/issues).
