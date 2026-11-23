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
window's own WebView2 data (cache, zoom) is kept apart from your browser's, in `%LOCALAPPDATA%\RumbleTracker\webview2`.

This tracker replaces the one with a browser window and uses the same data. If that one is running when this one
starts, it's asked to quit first (it saves and writes its backup as usual), so the two never change your data at the
same time.

## The tray icon

What closing the window does is your choice in **⚙ Settings**: keep running in the tray, so notifications still
arrive, or quit. Until you choose, closing the window asks in the window (*Cancel* keeps it open), and your answer is
saved there. Left-click the icon to bring the window back (an open one comes to the front, as it does when you start
the exe again); right-click for *Open data folder* and *Quit the tracker*. *Quit the tracker*, **⏻ Quit** on the page
and Windows signing out or shutting down all stop it the same way: it finishes a read in progress, writes the day's
backup and saves everything first.

## Backups

**Automatic backups** are written to `%APPDATA%\RumbleTracker\backups`:

- when the tracker starts, every 24 hours while it runs, and when it stops;
- one file per day (a later backup on the same day replaces it);
- files older than 7 days are deleted.

They hold everything you entered (names, talents, army slots, armies, reward goals, settings) and the history the
save can't give back (G.R.I.D., PvP and progress). Restore one from **Backup → Automatic backups** on the page.
*Export backup* saves the same content to a file of your choice; *Import backup…* restores such a file.

If a data file is damaged when the tracker starts, it is moved aside (`<name>.corrupt-<date>`) and the tracker starts
without it. Automatic backups pause until the next start, so the damage doesn't replace a good backup: restore the
last good one.

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

## App updates

At start and once a day the tracker asks GitHub for the latest release of its repository. The request carries nothing
about you, and the check can be turned off in **⚙ Settings**. When there's a newer version, a pop-up offers:

- **Download now**: the tracker downloads the release from GitHub, checks the zip and the exe against the checksums
  published with that release, and has the exe replaced and restarted. If the new version fails to start, the previous
  one is put back. The checksums show the download arrived whole; who published it is taken on trust from GitHub, as
  when you download the zip there yourself.
- **Later**: hides the pop-up until the tracker restarts.

An exe you built yourself gets the pop-up without *Download now*: it opens GitHub Releases instead, and the exe is
never replaced by a released one.

## Notifications

Notifications are checked every 30 seconds while the tracker runs (in the tray is enough); each is sent once. The
first time the tracker runs, what is already due is only recorded, so you don't get a burst of old notifications.
Choose them in **⚙ Settings**. Clicking one opens the tracker.

## Windows integration (RumbleTracker.exe)

A few seconds after each start, the exe makes sure of these, for your Windows account only:

| What | Why |
|---|---|
| A Start menu shortcut *Rumble Collection Tracker* | Notifications and the window's taskbar button show the tracker's name and icon, and you can start it from the Start menu |
| The `rumble-tracker:` link type (`HKEY_CURRENT_USER\Software\Classes\rumble-tracker`) | Clicking a notification starts the exe, which opens the running tracker's window |
| *Start with Windows*, only if you tick it in **⚙ Settings** (`…\CurrentVersion\Run`, value `RumbleCollectionTracker`) | Starts the tracker in the tray when you sign in |

## Files and folders

| Where | What |
|---|---|
| `%APPDATA%\RumbleTracker` | Your data: what you entered, the history, settings, the installed game data (`gamedata`), automatic backups (`backups`), a downloaded update (`update`, removed once installed) and the log (`tracker.log`, `tracker.previous.log`) |
| `%APPDATA%\RumbleTracker\state` | The last read of each account's save (rebuilt by the next read; not in backups) |
| `%LOCALAPPDATA%\RumbleTracker\app` | The program's files, unpacked from the exe once per version |
| `%LOCALAPPDATA%\RumbleTracker\webview2` | The window's WebView2 data (Microsoft Edge WebView2 shows the page). The files there are WebView2's own (cache, settings); the tracker stores nothing of yours in it, and deleting the folder only resets the window |

## Uninstalling

**⚙ Settings → Uninstall the tracker…** does it all. The tracker stops (writing its last backup, as always), and a
moment later the exe, `%APPDATA%\RumbleTracker`, `%LOCALAPPDATA%\RumbleTracker`, the Start menu shortcut, the
`rumble-tracker:` link (`HKEY_CURRENT_USER\Software\Classes\rumble-tracker`), Start with Windows and the notification
settings Windows keeps for the tracker are removed. Next to the exe, only the files from the release zip go; the folder
goes too if nothing else is left in it. A data folder you set yourself with `RUMBLE_DATA_DIR` is left as it is.

By hand:

1. In **⚙ Settings**, untick *Start with Windows* if you ticked it.
2. Quit the tracker.
3. Delete `RumbleTracker.exe`, `%APPDATA%\RumbleTracker` and `%LOCALAPPDATA%\RumbleTracker`.
4. Delete the Start menu shortcut *Rumble Collection Tracker* (in the Start menu, right-click it → *Open file
   location*) and, if you like, the registry keys `HKEY_CURRENT_USER\Software\Classes\rumble-tracker` and
   `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\razingo.RumbleCollectionTracker`
   (Windows adds that one once the tracker has sent a notification).
