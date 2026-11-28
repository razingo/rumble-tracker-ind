# The tracker's data files

What the tracker keeps in its `data` folder, file by file. This is for people who work on the tracker (or on anything
else that reads its data); for where the folder is and what else is in it, see
[How the tracker works](HOW-IT-WORKS.md#files-and-folders).

All files are JSON, UTF-8, written whole through a temporary file. Account IDs and unit IDs are the game's own: 32
lowercase hex characters. Times are ISO 8601 in UTC (`2026-11-28T03:39:32.000Z`) unless a field says otherwise. Minis
are named by their slug from the game data (`kobold-miner`).

## The data version

`schema.json` holds `{ "schema": 1 }`: one version number for all the files below together. A folder without the file
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

## The files

Every file below is in backups except `notified.json`. `server/userdata.mjs` reads and writes them, and nothing else
in the tracker changes what they hold.

| File | What it holds |
|---|---|
| `names.json` | `{ accounts: { accountId: name }, units: { unitId: slug } }`. The names the player gave their accounts, and the mini a unit ID stands for where the game data does not say |
| `talents.json` | `{ accountId: { unitId: [talent index] } }`. The talents the player ticked as owned, each 0 to 2, sorted |
| `army.json` | `{ accountId: { unitId: [slot x7] } }`, a slot being `{ type, tier, boost? }`. A leader's army slots |
| `armies.json` | `{ accountId: [army] }`. The saved armies (the Armory), in the order the player sees them |
| `plans.json` | `{ accountId: { eventId: { cost, label, set } } }`. Reward goals; `set` is when the goal was set |
| `pvp_history.json` | `{ accountId: [reading] }`, oldest first, at most 2000 per account |
| `grid_history.json` | `{ accountId: [grid] }`, oldest first, at most 400 per account |
| `progress.json` | `{ accountId: { first: sample, days: [sample] } }`, at most 400 days per account |
| `drafts.json` | `{ accountId: army }`. The army being edited on the Army tab, with `updated` |
| `settings.json` | `{ closeWindow: "ask" \| "tray" \| "quit", checkUpdates: boolean }` |
| `notifications.json` | `{ enabled, account, types: { typeId: { on, whenPlaying, hoursBefore? } }, quiet: { on, from, to } }` |
| `notified.json` | `{ sent: { key: time }, log: [...], pending: [...] }`. Which notifications were already sent |

### A saved army

```json
{
  "id": "amh2k1x9",
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
{ "t": "2026-11-20T18:02:11.000Z", "season": "…", "honor": 5120, "vp": 960, "dh": 25, "dv": 160,
  "wins": 1, "losses": 0, "estimated": false, "honorOnly": false }
```

- The first reading of a season has `start: true` and no matches.
- `estimated`: more than one mix of wins and losses fits the change, and honor picked one.
- `unexplained: true`: no mix fits. The player can then set `manual` to `"win"` or `"loss"`, which sets `wins` and
  `losses` too.

### A G.R.I.D.

`{ seen, refresh, items }`: when the tracker first saw it, the refresh time the game gives it, and its unbought
offers, each `{ mini: unitId, rarity }` or `{ xpBoost }`.

### A progress sample

`{ day, t, cur: { currencyId: [balance, lifetime] }, lv, xp, stars, rar: [count per rarity], n }`. `day` is the
player's local day (`2026-11-20`) and `t` a time in milliseconds. `first` is the first sample ever taken; `days` has
the latest sample of each day.

## What is not player data

- `state\<accountId>.json`: the last read of an account's save (`snapshot`), the changes seen between reads
  (`events`) and what the shop and PvP looked like. The next read rebuilds it, so it is not in backups.
- `config.json`: the game's folder, if the player gave one.
- `backups`, `gamedata`, `gamedata-build`, `update`, the logs: see
  [How the tracker works](HOW-IT-WORKS.md#files-and-folders).

The page keeps a few choices of its own in the window's local storage (the tab and account last shown, filters and
sorting). They belong to the window, not to the player's data, and are not in backups.
