# A tracker that builds its game data from your own game install

This folder holds the tracker's source and the tools that read its game data (tables and images) from the Warcraft
Rumble installed on a PC. The exe built here carries no game art or text and never downloads the tracker's published
data pack: at its start it reads what it needs from the game's own files, which are only read, never changed.

## Build the exe

You need Windows 10 or 11 (64-bit), [Node.js](https://nodejs.org) 25.5 or newer, any
[Python](https://www.python.org/downloads/) 3 (only its pip is used) and an internet connection.

```
npm run fetch-webview2
npm run fetch-python
npm run build-selfbuilt
```

The first two commands run once. `fetch-webview2` downloads the window's WebView2 libraries from Microsoft.
`fetch-python` prepares the private Python the exe carries, in `tools\gamedata\python` (about 28 MB): Python's
embeddable package from python.org and the image packages from PyPI, all in pinned versions. The third builds
`dist\release\RumbleTracker.exe` (about 125 MB) and its zip. It takes under a minute and does not need the game.

## What the exe does on a PC

It needs Warcraft Rumble for PC installed, and nothing else: no Python, no internet connection.

- **First start:** the window shows a loading bar while the game data is read from the game install. The bar fills
  with each of the 19 steps and names the ones running (independent steps run side by side). This takes about a
  minute.
- **After a game patch:** the next start sees that the game's files changed and reads the data again, with the same bar.
- **Otherwise:** it starts straight away.

If the game is not installed, the window says so and tries again every 15 seconds, so installing it is enough.

The data is kept in `%APPDATA%\RumbleTracker\gamedata`, with the working files in
`%APPDATA%\RumbleTracker\gamedata-build`. This exe does not update itself: for a new tracker version, build again.

## What is read from the game

About 670 small files, 4.5 MB. Only what the tracker shows is extracted: the minis' portraits, talent and trait icons,
reward and store art, PvP and currency icons. The image folders are built anew each time, so nothing unused stays
behind.

`tools\gamedata\seed\` holds the few tables kept by hand, which are not in the game files: the minis' save IDs and
keys, level and upgrade rules, army code numbers, and which family a two-family mini is filed under. A mini added by a
game patch needs its save ID and key added to `seed\unit_ids.json`, then a new exe.

## What the exe carries from others

Python (PSF license) and the packages UnityPy, Pillow, lz4, Brotli, texture2ddecoder, etcpak, astc-encoder-py,
archspec, fsspec, attrs and tpk_ar, each with its own license file inside `tools\gamedata\python`. UnityPy's audio
package (fmod_toolkit, which holds FMOD's libraries) is left out; an empty stand-in takes its place, as the tracker
reads no audio.

## From source

```
npm run build-gamedata
npm start
```

`build-gamedata` runs the same steps into `gamedata\`, with the private Python if `fetch-python` was run and
otherwise with a Python 3.11 to 3.14 on the PC (its packages are then downloaded on first use). `-- --force` builds
even when the game is unchanged, and a game folder can be given: `npm run build-gamedata -- "D:\Games\Warcraft Rumble"`.
Then open the address `npm start` prints.
