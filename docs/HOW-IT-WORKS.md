# How the tracker works

What Rumble Collection Tracker does in the background, and what it stores where. For using it, see the
[player guide](INSTRUCTIONS.md); for installing it, the [README](../README.md).

## Reading the game

Warcraft Rumble keeps its save in the Windows registry. The tracker only **reads** it; it never changes it.

- While the game runs, the tracker reads the save every 5 seconds.
- When the game closes, it reads it a few more times over the next 30 seconds (the game may still be saving), then
  stops until the game starts again. The status at the top says *Game closed* meanwhile.
- In `RumbleTracker.exe`, the tray icon checks every 2 seconds whether the game runs. From source, a small background
  PowerShell process does the same.

Each read is compared with the previous one: changes (XP, upgrades, currencies, shop, PvP honor and Victory Points)
are added to the history. Nothing is sent anywhere.

## The window

The window shows the tracker's page with Microsoft Edge WebView2, which comes with Windows 10 and 11. It shows only
the tracker's own page; links to other sites open in your default browser. If WebView2 isn't installed or can't run,
a small window explains how to install it from Microsoft. The tracker doesn't install it, open the page in your
browser or stay in the tray: closing that window stops it, and once WebView2 is installed you start it again. The
window's own WebView2 data (cache, zoom) is kept apart from your browser's, in `webview2` in the tracker's folder.

## The tray icon

What closing the window does is your choice in **⚙ Settings**: keep running in the tray, so notifications still
arrive, or quit. Until you choose, closing the window asks in the window (*Cancel* keeps it open), and your answer is
saved there. Left-click the icon to bring the window back (an open one comes to the front, as it does when you start
the exe again); right-click for *Open data folder* and *Quit the tracker*. *Quit the tracker*, **⏻ Quit** on the page
and Windows signing out or shutting down all stop it the same way: it finishes a read in progress, writes the day's
backup and saves everything first.

## Backups

**Automatic backups** are written to `data\backups` in the tracker's folder:

- when the tracker starts, every 24 hours while it runs, and when it stops;
- one file per day (a later backup on the same day replaces it);
- files older than 7 days are deleted.

They hold everything you entered (names, talents, army slots, armies, reward goals, settings) and the history the
save can't give back (G.R.I.D., PvP and progress). Restore one from **Backup → Automatic backups** on the page.
*Export backup* saves the same content to a file of your choice; *Import backup…* restores such a file.

If a data file is damaged when the tracker starts, it is moved aside (`<name>.corrupt-<date>`) and the tracker starts
without it. A file that is whole but holds something else in places (one changed by hand) keeps all but those places,
and a copy of it as it was stays beside it under the same kind of name. Automatic backups pause until the next start,
so the damage doesn't replace a good backup: restore the last good one.

## Game data updates

The tracker reads its game data from the Warcraft Rumble installed on this PC. The game's files are only read, and
nothing is downloaded.

- **The first time it starts**, there is nothing to show yet, so the window has a loading bar until the data is read
  (about a minute). If the game isn't found, the window asks for its folder.
- **After a game patch**, the tracker sees that the installed game is another version than the one its data was read
  from, and reads the data again in the background, at low priority. It looks at start, when the game closes and
  every half hour. The tracker stays usable on the old data meanwhile; the new data replaces it only once it is
  complete, and an open window loads it by itself. If the read fails, the old data stays and the tracker tries again
  within the hour.
- **After a tracker update** that reads something more or differently, only the parts that changed are read again,
  the same way; all of them when the tracker's own starting tables changed. A banner says *The tracker was updated*
  meanwhile.
- A read that hangs is stopped after 10 minutes, and quitting the tracker stops one in progress. Either way the
  data the tracker had stays as it was.

## App updates

At start, when its window comes into view and once a day the tracker asks GitHub for the latest release of its
repository. The request carries nothing about you, and the check can be turned off in **⚙ Settings**. When there's a
newer version, a pop-up offers:

- **Download now**: the tracker downloads the release from GitHub, checks the zip and the exe against the checksums
  published with that release, and has the exe replaced and restarted. If the new version fails to start, the previous
  one is put back and started, and says why. The checksums show the download arrived whole; who published it is
  taken on trust from GitHub, as when you download the zip there yourself.
- **Later**: hides the pop-up until the tracker restarts.

An exe you built yourself gets the pop-up without *Download now*: it opens GitHub Releases instead, and the exe is
never replaced by a released one.

## Notifications

Notifications are checked every 30 seconds while the tracker runs (in the tray is enough); each is sent once. The
first time the tracker has read your save, what is already due is only recorded, so you don't get a burst of old
notifications. Choose them in **⚙ Settings**. Clicking one opens the tracker.

## Windows integration (RumbleTracker.exe)

A few seconds after each start, the exe makes sure of these, for your Windows account only:

| What | Why |
|---|---|
| A Start menu shortcut *Rumble Collection Tracker* | Notifications and the window's taskbar button show the tracker's name and icon, and you can start it from the Start menu |
| The `rumble-tracker:` link type (`HKEY_CURRENT_USER\Software\Classes\rumble-tracker`) | Clicking a notification starts the exe, which opens the running tracker's window |
| *Start with Windows*, only if you tick it in **⚙ Settings** (`…\CurrentVersion\Run`, value `RumbleCollectionTracker`) | Starts the tracker in the tray when you sign in |

## Files and folders

Everything the tracker keeps is in one folder named `RumbleTracker`. The first start asks where to put it, with
`%LOCALAPPDATA%` filled in, and the tracker makes the `RumbleTracker` folder in the folder you pick. **⚙ Settings →
The tracker's folder** shows where it is and opens it. To move it, type another folder there: the tracker closes,
moves its files into a `RumbleTracker` folder in it, and starts again.

A move copies everything first, then notes the new folder, and only then removes the files from where they were. So
a move that fails, or is cut off by the PC going off, leaves the files whole in one place: where they were while
they are copied, and in the new folder from then on. A move that can't be done says why, and needs the room for a
second copy until the old files go. Old files that are still in use are removed at a later start.

A tracker from before there was a choice kept your data in `%APPDATA%\RumbleTracker` and the rest in
`%LOCALAPPDATA%\RumbleTracker`. Its first start after the update asks the same question and moves both into the one
folder.

If the folder you pick on the first start already holds a `RumbleTracker` folder, the tracker uses it. Its program
files, game data and window data are made fresh, and the backups in it stay. A new tracker takes over the data it
finds there. A tracker that brings data of its own keeps its own. The backups it found go into
`data\backups\pre_existing`, so none of them has the name of one of its own, and the data it found is saved there
too as one more file (`found-<date>.json`). *Backup → Import backup…* reads all of them.

If the folder is not there when the tracker starts (its disk is not connected, or the folder was moved, renamed or
deleted), the tracker does not make a new one by itself. It asks: try again, pick a folder, or quit. In a folder you
pick it starts empty, also when you pick the same one again, or with a tracker's files if it finds them there; files
in another place are left as they are.

The question, and a message that the tracker can't start, are shown before the tracker's own window can open. They
have the tracker's look; if that can't be shown, Windows' own message box and folder picker are.

| Where | What |
|---|---|
| `%APPDATA%\RumbleTracker\location.json` | The note of where the tracker's folder is. It stays here wherever the folder is |
| `data` | Your data: what you entered, the history, settings, the game data read from your game install (`gamedata`, with the reading's working files in `gamedata-build`), the game's folder if you gave one (`config.json`), automatic backups (`backups`), a downloaded update (`update`, removed once installed) and the log (`tracker.log`, `tracker.previous.log`) |
| `data\state` | The last read of each account's save (rebuilt by the next read; not in backups) |
| `%TEMP%\RumbleTracker-launcher` | The script and the title font of the pop-ups the tracker shows before its window can open (the folder question, a message that it can't start), written again at each use. While the tracker starts, also `starting.lock`, so that a second start does not ask or move files too; it brings the first one's question to the front and leaves an empty file, `show`, so the first one opens its window once it runs. After a new version that could not start, `restored.txt` holds the reason until the previous version has shown it. Removed by Uninstall |
| `app` | The program's files, unpacked from the exe once per version |
| `webview2` | The window's WebView2 data (Microsoft Edge WebView2 shows the page). The files there are WebView2's own (cache, settings); the tracker stores nothing of yours in it, and deleting the folder only resets the window |

## Uninstalling

**⚙ Settings → Uninstall the tracker…** does it all. It asks first whether to keep a backup: **Uninstall, keep a
backup** saves the same file as *Backup → Export backup* where you choose, and nothing is uninstalled if that file
isn't saved. The tracker then stops (writing its last backup, as always), and a moment later the exe, the tracker's
folder, `%APPDATA%\RumbleTracker` and `%LOCALAPPDATA%\RumbleTracker` (whichever of them are there), the Start menu
shortcut, the `rumble-tracker:` link (`HKEY_CURRENT_USER\Software\Classes\rumble-tracker`), Start with Windows and the
notification settings Windows keeps for the tracker are removed. Next to the exe, only the files from the release zip
go; the folder goes too if nothing else is left in it. Of the folder you picked, only the `RumbleTracker` folder in it
is removed. A data folder you set yourself with `RUMBLE_DATA_DIR` is left as it is.

By hand:

1. In **⚙ Settings**, untick *Start with Windows* if you ticked it.
2. Quit the tracker.
3. Delete `RumbleTracker.exe`, the tracker's folder (**⚙ Settings** shows where it is; look before you quit),
   `%APPDATA%\RumbleTracker` and `%LOCALAPPDATA%\RumbleTracker`.
4. Delete the Start menu shortcut *Rumble Collection Tracker* (in the Start menu, right-click it → *Open file
   location*) and, if you like, the registry keys `HKEY_CURRENT_USER\Software\Classes\rumble-tracker` and
   `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\razingo.RumbleCollectionTracker`
   (Windows adds that one once the tracker has sent a notification).
