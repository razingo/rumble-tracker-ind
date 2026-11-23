# Changelog

What changed in each release of Rumble Collection Tracker. The release workflow copies a version's section into its
GitHub release notes.

## 0.1.4

- After this update the tracker reads its game data again once, in the background; it takes about a minute.
- Settings shows the folder in use and the last check for a new version right after you change a setting, without
  reopening it.
- Housekeeping in the scripts that read the game data; what they read is unchanged.

## 0.1.3

- The tracker now looks for a new version whenever its window opens, not only once a day, so the update pop-up shows
  up sooner.
- Settings says when the tracker last looked for a new version, or why that did not work.
- Keyboard: the Left and Right arrow keys move between the tabs, and the tag box shows when it has the focus.
- The problem report no longer replaces ordinary words that happen to match your Windows user name.

## 0.1.2

- Fixed: when reading the game data failed, the banner repeated itself. It now gives the reason once.
- Fixed: with the game not found, the tracker could log an error every half hour and show a red dot on Report a
  problem.
- If a game patch leaves the tracker with broken game data (no minis, no events), that read is refused and the data
  you had stays.
- New game data now takes the old data's place more safely: the old data is only removed once the new one is there.
- A game folder changed in Settings while the game data is being read is picked up as soon as that read ends.

## 0.1.1

- After this update the tracker reads its images again once, in the background; it takes under a minute.
- Fixed: after a tracker update, the banner said the game was updated. It now says the tracker was.
- When the game data can't be read, the tracker says why, instead of only naming the step that failed.
- A game folder changed in Settings is used right away, without restarting the tracker.
- Quitting the tracker also stops a read of the game data that is in progress, and a read that hangs is stopped after
  10 minutes.
- The log (`tracker.log`) no longer holds your Windows user name.
- The zip now carries the licenses of everything the exe contains.

## 0.1.0

- After a tracker update, only the parts of the game data that changed are read again, not all of it.
- Reading the game data and the additional data is faster and much lighter on memory and disk.
- Armory: the tag filters stay below the search bar, on the left.
- The banner now says when the tracker, not the game, was updated and is reading part of its data again.

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
