# Changelog

What changed in each release of Rumble Collection Tracker. The release workflow copies a version's section into its
GitHub release notes.

## 0.0.2

- Fixed: cards showed a plain pale border instead of their faction frames, and the army boards and wood backgrounds
  were missing. The tracker now reads this art from your game install with the rest of its game data. After updating,
  it reads the game data once more in the background, and the frames appear when that is done.

## 0.0.1

The first version of the tracker that reads its game data from your own game install.

- Names, stats, events, shop offers and all images come from the Warcraft Rumble installed on your PC. The first start
  reads them behind a loading bar, which takes about a minute.
- After a game patch the tracker reads the new game data by itself, in the background, while you keep using it.
- If the game isn't found, the loading window asks for its folder. It can be changed later in Settings.
- Once a day the tracker asks GitHub whether a newer version is out and offers it in a pop-up. This can be turned off
  in Settings.
