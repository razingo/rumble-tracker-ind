# Changelog

What changed in each release of Rumble Collection Tracker with its own window. The release workflow copies a
version's section into its GitHub release notes.

## 0.3.7

- The window uses a newer version of Microsoft's WebView2 libraries (1.0.4370.26).
- The tracker no longer keeps `learned.json` in its data folder up to date. Nothing used it; an existing copy is left
  as it is.

## 0.3.6

- If a game data update can't be put in place, for example because another program holds one of its files, the
  tracker keeps the game data it had. Before, it was left without game data until the next start downloaded it again.

## 0.3.5

- On the PvP tab, *Undo* next to a result you set yourself now works: it marks the match as unexplained, so you can
  set it once more.

## 0.3.4

- Nothing changes on screen: the code behind the Calendar, Army, PvP and Progress tabs was tidied up.

## 0.3.3

- Event ticket icons now come with the game data, so a new event can show its own ticket without a tracker update.

## 0.3.2

- The window's taskbar button shows the tracker's icon instead of PowerShell's, and a pinned button starts the tracker.

## 0.3.1

- Uninstall also removes the notification settings Windows keeps for the tracker.
- Importing an Armory before the game has run on this PC says so, instead of asking to reload the page.
- The player guide's screenshots show this version, with Export armory, Import armory and Uninstall.

## 0.3.0

- **Export armory** and **Import armory…** on the Armory tab save all your armies to one file, with their names,
  descriptions and tags, and add them back, also on another PC or for another account.
- **⚙ Settings → Uninstall the tracker…** removes the tracker and everything it keeps on this PC.
- On a PC without Microsoft Edge WebView2, the tracker explains how to install it, instead of opening its page in
  your browser.

## 0.2.2

- "Last read" counts from "just now" to 5 seconds after each read of your save. Before, it could start at 4
  seconds and reach 8, as the page asked for news at its own times.

## 0.2.1

- An army you were editing is saved before the window closes, also when you close it right after a change.
- After **⏻ Quit**, the window closes at once instead of a moment later.
- The window only shows the tracker; any other site opens in your default browser.
- The account list in the header shows a short account name in full again; only long names are shortened.
- The player guide's screenshots show this version.

## 0.2.0

- The window opens about a quarter of a second sooner.
- Closing the window with "Ask me" asks in the window itself, right away, and *Cancel* keeps it open. Before, the
  window closed first and the question came a moment later in a window of its own.
- If the tracker with a browser window is running, it's asked to quit before this one starts, as both use the same data.
- A long account name no longer pushes the "Name this account" box out of the header.

## 0.1.0

- The first release with its own window: the tracker shows its page in a window of its own, with Microsoft Edge
  WebView2, instead of a browser window. The window and the tray icon are one program.
- Everything else works as in the browser-window tracker 0.9.4, with the same data folder, so your names, armies,
  history and settings carry over.
- On a PC without WebView2, the page opens in the default browser instead.
