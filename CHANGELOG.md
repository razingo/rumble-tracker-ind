# Changelog

What changed in each release of Rumble Collection Tracker. The release workflow copies a version's section into its
GitHub release notes.

## 0.4.1

- Fixed: after updating to 0.4.0 the tracker did not open. It was waiting for an answer to the question of where
  to keep its files, in a window that could not be seen. If you have 0.4.0, the tracker can't update itself:
  download this version and put its `RumbleTracker.exe` in place of yours. Nothing was moved, so your data is as
  it was.
- The window has a title bar of its own, in the tracker's look, with its own buttons to minimize, maximize and
  close. Resizing by the edges and snapping work as before.
- The pop-ups the tracker shows before its window opens (where to keep the files, moving them, a message that it
  can't start) have the tracker's look too.

## 0.4.0

- You choose where the tracker keeps its files. Everything is now in one folder named RumbleTracker: your data,
  what is read from the game and the program's own files. The first start asks where to put it, and the tracker
  makes its RumbleTracker folder in the folder you pick.
- After this update the tracker asks that question once, then moves the files it has from `%APPDATA%` and
  `%LOCALAPPDATA%` into the one folder.
- Settings: "The tracker's folder" shows where the files are and moves them. Type another folder, and the tracker
  closes, moves its files there and starts again.
- Settings: a button beside each folder opens it in Explorer.
- Uninstall removes only the tracker's own RumbleTracker folder, never what else is in the folder you picked.
- Pop-ups: the title and the close button stay on top while the rest scrolls, and every pop-up has the look of
  Settings.
- The tracker no longer shares its data with the earlier tracker that had a browser window, and no longer asks
  that one to quit.

## 0.3.8

- Settings: each section is in a box of its own under a gold title, so they are easier to tell apart. Uninstall
  stands out in orange.
- Settings: the additional data has a section of its own, above Uninstall. It says how much free disk space
  extracting needs and how much is free.

## 0.3.7

- After an update the tracker reads again only the parts of its game data that the update changed, and the parts
  that depend on them only when they came out different. Most updates now take a few seconds instead of a minute.
- The same goes for the rdmodule's data: an update that changes one part no longer draws everything again.
- A read of the game data that was cut off, such as by the PC turning off, is noticed and done again in full.
- After this update the tracker reads its game data again once, in the background; it takes about a minute. The
  rdmodule's data shows as out of date once.

## 0.3.6

- The rdmodule: back on the menu after a run, the leader's card shows the talent picked now, not the last run's.
- The rdmodule: with Arthas, poison and fire eating at an enemy no longer count as hits for Soulshatter.
- The rdmodule: a dragon tower's fire no longer shows the witch doctor's curse on the mini it hits.

## 0.3.5

- The rdmodule: with Arthas's Necrotic Plague, Soulshatter works on poisoned enemies only, no longer on burning ones.
- The rdmodule: an enemy stops showing as poisoned once the poison has worn off.
- After this update the tracker reads its game data again once, in the background; it takes about a minute.

## 0.3.4

- The rdmodule: enemies that are poisoned are tinted green and show the poison effect; burning ones stay orange. The
  Fire Elemental sets enemies on fire instead of poisoning them.
- In a narrow browser window the page keeps its layout and scrolls sideways, instead of rearranging some tabs.
- The rdmodule's data shows as out of date once after this update.

## 0.3.3

- Army: a Cenarion leader's army has a green board of its own.
- Army: an army with a leader you don't own, from an imported code or armory, keeps its board: the slots have their
  types and minis can be added.
- Calendar: Anniversary, Cenarion Festival, the PC launch and Winds of Change have their own colors.
- Calendar: shop offer titles no longer keep part of their name in capitals.
- Collection: a not-owned mini of two factions shows both.
- Fixed: on the Army tab, a faction filter chosen earlier could hide every mini once its button was gone.
- After this update the tracker reads most of its game data again once, in the background; it takes about a minute.

## 0.3.2

- Calendar: shop offers for cores and the Modest Star Tome show their pictures.
- Army: the lists show a faction filter only for factions that have a mini in them.
- Fixed: on a PC where Warcraft Rumble was never played, no notification was ever sent.
- Fixed: a faction filter chosen earlier could stay on, without its button, while the game data was read again.
- After this update the tracker reads the shop's part of its game data again once, in the background.

## 0.3.1

- Calendar: shop offers for cores, the Modest Star Tome and Arc Energy show their names instead of "{cores}" and
  "{energy}", and Arc Energy and discounted mini offers show their price.
- Calendar: events show their own ticket icons, also Anniversary, Cenarion Festival, the PC launch and Winds of Change.
- Collection and Army have a Neutral faction filter, for minis of no faction (the Kobold Miner) and of a faction the
  tracker doesn't know yet.
- Army: a mini you don't own, from an imported code or armory, can be taken off the board.
- A mini's details show both factions of a two-faction mini.
- Fixed: on a new install, the first notification could be lost.
- Fixed: the rdmodule did not open when its last data update had failed.
- Fixed: an Armory edit that could not be saved still changed the army on the Army tab.
- After this update the tracker reads its game data again once, in the background; it takes about a minute.

## 0.3.0

- The rdmodule's effects are drawn with their own random numbers, so each effect comes out the same whichever
  effects are drawn before it. The effects look a little different from before, and the rdmodule's data shows as out
  of date once after this update.
- Fixed: the progress line in Settings stopped moving when you closed Settings and opened it again.
- The player guide now says that a new mini gets its name once the new game data is read.

## 0.2.0

- A mini that a game patch adds now shows up by itself, with its name, art and stats, once the game's files have it.
  It no longer waits for a new version of the tracker. Army codes with the new mini work too.
- The level and upgrade rules (XP per level, what each rarity costs, talent slots and prices) are now read from your
  game install like the rest of the game data, so they follow a patch.
- After this update the tracker reads its game data again once, in the background; it takes about a minute.
- Fixed: the G.R.I.D. tab could show "Refreshes in NaNm".
- Fixed: restoring a backup with damaged notification settings could stop notifications until the next start.
- Fixed: the Modest tome had no picture in shop offers and PvP rewards.
- The PvP tab names its modifier change by the current season, and no longer guesses a rank when the game data has
  no season-end rewards.

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
