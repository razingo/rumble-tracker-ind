# The tracker's data files

What the tracker keeps in its `data` folder, file by file. This is for people who work on the tracker (or on anything
else that reads its data); for where the folder is and what else is in it, see
[How the tracker works](HOW-IT-WORKS.md#files-and-folders).

All files are JSON, UTF-8, written whole through a temporary file. Account IDs and unit IDs are the game's own: 32
lowercase hex characters. Times are ISO 8601 in UTC (`2026-11-28T03:39:32.000Z`) unless a field says otherwise. Minis
are named by their slug from the game data (`kobold-miner`).

## The data version

`schema.json` holds `{ "schema": 2 }`: one version number for all the files below together. A folder without the file
holds version 1, which is what every tracker before 0.6.10 wrote. Backups carry the same number as `schema`.

At start the tracker compares the number with the one it knows (`SCHEMA` in `server/migrations.mjs`):

- **Older data** is brought up to date by the steps in `server/migrations.mjs`, in order. If a step changed anything,
  the data as it was is first written to `backups\rumble-tracker-backup-before-data-v<new version>.json`, a normal
  backup file that *Backup → Import backup…* reads.
- **Newer data** (the folder was used by a newer tracker) is used as it is, and a line in *Report a problem* says so.
  A new version may add to the files and must not change the meaning of what is already there, so that this stays
  safe.

A restored backup goes through the same steps, from the version it names.

To change what a file holds: raise `SCHEMA`, add a step, and describe the change here. A step has to leave alone data
that already has the change.

The versions so far:

| Version | Tracker | What changed |
|---|---|---|
| 1 | up to 0.6.10 | The files as described here, without what later versions added |
| 2 | 0.6.11 | PvP readings and G.R.I.D.s have an `id` |

## IDs

What the game made has the game's ID (accounts, units, events, seasons). What the tracker makes has an ID of its own:
a random UUID from `newId()` in `web/scripts/lib/ids.js`, so that two trackers never make the same one. Saved armies,
PvP readings and G.R.I.D.s have one, as `id`. Armies saved before 0.6.11 keep the shorter IDs they got then (`a`
or `i` and a time), which stay valid: an ID is any text of up to 40 characters, and nothing reads a meaning into it.

`device.json` holds `{ id, created }` for this install: the ID of this copy of the tracker's data folder. It is made
at the first start and is not in backups, so restoring a backup on another PC does not make two installs look like
one. (Copying the whole data folder to another PC does.)

## What changed, and when

`changes.json` notes every change to what the player enters (`server/changes.mjs`):

```json
{
  "rev": 3,
  "records": {
    "talents": { "<account ID>/<unit ID>": { "rev": 1, "t": "2026-11-28T10:00:00.000Z" } },
    "armies": { "<account ID>/<army ID>": { "rev": 3, "t": "2026-11-28T10:05:00.000Z", "deleted": true } }
  }
}
```

- `rev` counts the changes made in this data folder and only goes up. Each note has the count its change got, so
  "everything after revision 40" is a question the file can answer without trusting the PC's clock. `t` is the time
  for people, and for telling which of two trackers changed an entry last.
- An entry that was removed keeps its note, with `deleted: true`.
- An entry without a note has not changed since 0.6.12, the first version that kept notes.

The files it covers, and the key of an entry in each:

| File | Key |
|---|---|
| `names.json` | player | `accounts/<account ID>` and `units/<unit ID>` |
| `talents.json`, `army.json` | `<account ID>/<unit ID>` |
| `plans.json` | player | `<account ID>/<event ID>` |
| `armies.json` | player | `<account ID>/<army ID>` (the order of the armies is not noted) |

The history files are left out: the tracker only ever adds to them, and each entry has an `id` and a time of its
own. The one thing a player changes there, the result of an unexplained PvP reading, gets `manualAt`.

The notes tell of this data folder, so the file is not in backups. Restoring a backup is noted as a change of
whatever the backup changed. Nothing reads the notes yet.

## The files

Every file below is in backups except `notified.json`. `server/userdata.mjs` reads and writes them, and nothing else
in the tracker changes what they hold.

The files are of two kinds (`PLAYER_FILES` in `server/userdata.mjs`):

- **The player's**: what tells of the player and their game accounts. It would be the same on any PC the player
  uses, so it is what a copy of the player's data elsewhere would hold. `playerData()` in `server/playerdata.mjs`
  puts it together with the collections read from the save.
- **This install's**: what tells of this PC and this window, such as what closing the window does or which
  notifications were already shown here. It has no meaning on another device.

| File | Kind | What it holds |
|---|---|---|
| `names.json` | `{ accounts: { accountId: name }, units: { unitId: slug } }`. The names the player gave their accounts, and the mini a unit ID stands for where the game data does not say |
| `talents.json` | player | `{ accountId: { unitId: [talent index] } }`. The talents the player ticked as owned, each 0 to 2, sorted |
| `army.json` | player | `{ accountId: { unitId: [slot x7] } }`, a slot being `{ type, tier, boost? }`. A leader's army slots |
| `armies.json` | `{ accountId: [army] }`. The saved armies (the Armory), in the order the player sees them |
| `plans.json` | `{ accountId: { eventId: { cost, label, set } } }`. Reward goals; `set` is when the goal was set |
| `pvp_history.json` | player | `{ accountId: [reading] }`, oldest first, at most 2000 per account |
| `grid_history.json` | player | `{ accountId: [grid] }`, oldest first, at most 400 per account |
| `progress.json` | player | `{ accountId: { first: sample, days: [sample] } }`, at most 400 days per account |
| `drafts.json` | install | `{ accountId: army }`. The army being edited on the Army tab, with `updated` |
| `settings.json` | install | `{ closeWindow: "ask" \| "tray" \| "quit", checkUpdates: boolean }` |
| `notifications.json` | install | `{ enabled, account, types: { typeId: { on, whenPlaying, hoursBefore? } }, quiet: { on, from, to } }` |
| `notified.json` | install | `{ sent: { key: time }, log: [...], pending: [...] }`. Which notifications were already sent |

### A saved army

```json
{
  "id": "6f1c2a0e-8f0b-4c58-9a59-3f6f7b1f5d11",
  "name": "Rend air",
  "leader": "rend-blackhand",
  "minis": ["drake", "harpies", null, null, null, null],
  "talents": { "drake": 1 },
  "description": "",
  "tags": ["pvp"]
}
```

`minis` always has six places, `null` for an empty one. `talents` names the talent (0 to 2) chosen for a mini of this
army. An exported Armory file holds the same armies without their `id`.

### A PvP reading

The save has no match history, so the tracker logs each change of honor or Victory Points it sees and works out the
matches from it (`server/game/pvp.mjs`).

```json
{ "id": "0b9d6c1e-4f3a-4b7e-8a53-2f1d9f0c7a44", "t": "2026-11-20T18:02:11.000Z", "season": "…", "honor": 5120,
  "vp": 960, "dh": 25, "dv": 160, "wins": 1, "losses": 0, "estimated": false, "honorOnly": false }
```

- The first reading of a season has `start: true` and no matches.
- `estimated`: more than one mix of wins and losses fits the change, and honor picked one.
- `unexplained: true`: no mix fits. The player can then set `manual` to `"win"` or `"loss"`, which sets `wins` and
  `losses` too, and `manualAt` to when they did.

`matchRecord()` in the same file turns a reading with matches into a record that needs nothing else of the log,
which is the shape meant for showing matches anywhere but in the tracker:

```json
{ "id": "0b9d6c1e-4f3a-4b7e-8a53-2f1d9f0c7a44", "account": "<account ID>", "season": "…",
  "t": "2026-11-20T18:02:11.000Z", "honor": 5120, "vp": 960, "honorChange": 25, "vpChange": 160,
  "wins": 1, "losses": 0, "basis": "exact" }
```

`basis` is `exact`, `estimated` or `manual`. A record can stand for more than one match, as the tracker sees the
sum of what happened between two reads. The army played is not in it: the tracker does not read that from the save.

### A G.R.I.D.

`{ id, seen, refresh, items }`: when the tracker first saw it, the refresh time the game gives it, and its unbought
offers, each `{ mini: unitId, rarity }` or `{ xpBoost }`.

### A progress sample

`{ day, t, cur: { currencyId: [balance, lifetime] }, lv, xp, stars, rar: [count per rarity], n }`. `day` is the
player's local day (`2026-11-20`) and `t` a time in milliseconds. `first` is the first sample ever taken; `days` has
the latest sample of each day.

## What is not in these files

- `state\<accountId>.json`: the last read of an account's save (`snapshot`), the changes seen between reads
  (`events`) and what the shop and PvP looked like. The next read rebuilds it, so it is not in backups.
  Its `snapshot` (the units and currencies) is the player's collection, which is the player's data too: the save
  is where it comes from, so no file of its own keeps it.
- `config.json`: the game's folder, if the player gave one.
- `schema.json`, `device.json` and `changes.json`: see above.
- `backups`, `gamedata`, `gamedata-build`, `update`, the logs: see
  [How the tracker works](HOW-IT-WORKS.md#files-and-folders).

The page keeps a few choices of its own in the window's local storage (the tab and account last shown, filters and
sorting). They belong to the window, not to the player's data, and are not in backups.
