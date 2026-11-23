# Notices

## Not affiliated with Blizzard Entertainment

Rumble Collection Tracker is an unofficial fan tool. It is not affiliated with, endorsed, sponsored or approved by
Blizzard Entertainment, Inc. Warcraft, Warcraft Rumble and Blizzard Entertainment are trademarks or registered
trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries.

## What the MIT license covers

The MIT license in `LICENSE` covers the tracker's own code only: the local server (`server/`), the page's scripts
and styles (`web/`), the Windows launcher and window (`desktop/`, apart from the WebView2 libraries) and the build
tools (`tools/`).

It does **not** cover the material below, which belongs to its owners and is included only so the tracker can show
your collection in a recognizable way.

## Game art and data © Blizzard Entertainment

Read by the tracker from the Warcraft Rumble installed on your own PC, into its data folder (and by
`npm run build-gamedata` into `gamedata/`). Apart from the app's icon (`web/favicon.ico`, drawn from the Kobold Miner's
portrait), none of it is in this repository or in the release downloads:

- images: mini portraits, talent icons, card frames, boards and textures, faction, trait and tag icons, event tickets,
  event reward icons, shop art and currency icons;
- data: mini names, descriptions, traits, talents and stats, event schedules, reward trees and ticket totals, shop
  offers and G.R.I.D. prices, army boards and unit IDs.

© Blizzard Entertainment, Inc. All rights reserved. If Blizzard asks for any of it to be removed, it will be.

## Node.js

`RumbleTracker.exe` is a Node.js single executable application: it contains the Node.js runtime, © Node.js
contributors, MIT-licensed, with third-party components under their own licenses. The full text ships in the zip as
`THIRD-PARTY-NOTICES/Node.js-LICENSE.txt`.

## Microsoft Edge WebView2

The window shows the page with Microsoft Edge WebView2. The exe contains Microsoft's WebView2 libraries
(`Microsoft.Web.WebView2`, © Microsoft Corporation, under Microsoft's BSD-style license); the WebView2 runtime itself
is part of Windows. The license ships in the zip as `THIRD-PARTY-NOTICES/WebView2-LICENSE.txt`, with
`WebView2-NOTICE.txt`.

## Fonts

The page uses two bundled fonts under the SIL Open Font License 1.1: Lilita One (© 2011 Juan Montoreano) and Nunito
(© 2014 The Nunito Project Authors). Their licenses are in `web/fonts/` and in the zip under `THIRD-PARTY-NOTICES`.

## The player's own data

The tracker reads Warcraft Rumble's saved settings from the Windows registry on the player's own PC, read-only, and
keeps everything it stores in its own data folder on that PC (`%APPDATA%\RumbleTracker`). It sends nothing
anywhere. Its game data is read from the game installed on the same PC; the only thing it asks the internet for is
its own latest version, from GitHub. "Report a problem" only opens a pre-filled GitHub issue in the player's
browser; it is sent only if the player submits it there.
