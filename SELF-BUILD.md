# Building the tracker

The exe built from this repository carries no game art or text. It reads what it needs from the Warcraft Rumble
installed on the PC it runs on; the game's files are only read, never changed.

## Build the exe

You need Windows 10 or 11 (64-bit), [Node.js](https://nodejs.org) 25.5 or newer, any
[Python](https://www.python.org/downloads/) 3 (only its pip is used) and an internet connection.

```
npm run fetch-webview2
npm run fetch-python
npm run fetch-rdmodule-tools
npm run build-release
```

The three `fetch` commands run once. Everything they download is pinned to a version and a SHA-256 checksum.

| Command | What it gets | Where |
|---|---|---|
| `fetch-webview2` | The window's WebView2 libraries, from Microsoft's NuGet package | `desktop\webview2` |
| `fetch-python` | The private Python the exe carries: Python's embeddable package from python.org and the image packages from PyPI (about 28 MB) | `tools\gamedata\python` |
| `fetch-rdmodule-tools` | three.js and vgmstream, for the rdmodule | `tools\rdmodule\vendor` |

`build-release` then writes `RumbleTracker.exe` (about 133 MB), its zip and `SHA256SUMS.txt` to `dist\release`. It
takes under a minute and does not need the game.

An exe built this way works like a released one, with one difference: when a newer version is out it tells you, and
leaves replacing the exe to you. Only exes built by this repository's release workflow replace themselves.

## What the exe does on a PC

It needs Warcraft Rumble for PC installed, and nothing else: no Python, and no internet connection for its game data.

- **First start:** the window shows a loading bar while the game data is read from the game install. The bar fills as
  each of the 21 steps finishes and names the ones running. This takes about a minute.
- **After a game patch:** the tracker sees that the installed game is a newer version than its data and reads the data
  again in the background, while it stays usable. It looks at start, when the game closes and every half hour.
- **Otherwise:** it starts straight away.

Reading goes easy on the PC: the programs it starts run at low priority, and only a few steps run at a time.

The data is kept in `%APPDATA%\RumbleTracker\gamedata`, with working files in `gamedata-build` beside it. New data
replaces the old only once it is complete.

### When the game is not found

The tracker finds the game through the entry Windows keeps for installed programs. A game folder that was copied or
moved by hand has no such entry, or a wrong one. Then:

1. The loading window says the game was not found and shows a field. Type or paste the game's folder there, the one
   that holds `WarcraftRumble.exe` (for example `D:\Games\Warcraft Rumble`), and press **Use this folder**. The
   tracker checks that the game's files are in it and starts reading right away.
2. Later, the folder can be changed in **⚙ Settings** under *Warcraft Rumble's folder*. Emptying the field makes the
   tracker look for the game again. A change applies from the tracker's next start.

The folder is kept as `gameFolder` in `%APPDATA%\RumbleTracker\config.json`. From source, the `RUMBLE_GAME_DIR`
environment variable does the same.

If the game is not installed at all, installing it is enough: the loading window looks again every 15 seconds.

## What is read from the game

About 690 small files, 5 MB: the minis' portraits, talent and trait icons, reward and store art, PvP and currency
icons, the page's own card frames, army boards and backgrounds, and the tables behind them. Only what the tracker shows is extracted, and the image folders are built anew each
time, so nothing unused stays behind.

`tools\gamedata\seed\` holds the few tables kept by hand, which are not in the game files: the minis' save IDs and
keys, level and upgrade rules, army code numbers, and which family a two-family mini is filed under. A mini added by a
game patch needs its save ID and key added to `seed\unit_ids.json`, then a new exe.

When a new version of the tracker reads something more or differently, `BUILDER` in `tools\gamedata\build.mjs` is
raised, and every tracker with data from the older builder reads it again.

## From source

```
npm start
```

Without game data yet, the tracker reads it on this first start, as the exe does; then open the address it prints.
`npm run build-gamedata` does the same reading by hand, into `gamedata\`: `-- --force` reads even when the game's
version is unchanged, and a game folder can be given, as in `npm run build-gamedata -- "D:\Games\Warcraft Rumble"`.
Both use the private Python if `fetch-python` was run, and otherwise a Python 3.11 to 3.14 on the PC, whose packages
are then downloaded on first use.

## Software from others in the exe

| What | License | Where its license file is |
|---|---|---|
| Node.js | MIT and others | `THIRD-PARTY-NOTICES` in the zip |
| WebView2 libraries | Microsoft's, BSD-style | `THIRD-PARTY-NOTICES` in the zip |
| Python | PSF | `tools\gamedata\python` |
| UnityPy, Pillow, lz4, Brotli, texture2ddecoder, etcpak, astc-encoder-py, archspec, fsspec, attrs, tpk_ar | each its own | `tools\gamedata\python\Lib\site-packages` |
| three.js | MIT | `tools\rdmodule\vendor\three` |
| vgmstream, with the codec libraries it ships | ISC and others | `tools\rdmodule\vendor\vgmstream` |

UnityPy's audio package (fmod_toolkit, which holds FMOD's libraries) is left out. An empty stand-in takes its place,
as nothing here reads audio through it.
