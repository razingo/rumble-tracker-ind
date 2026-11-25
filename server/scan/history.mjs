// History the tracker keeps from scans: daily progress samples, G.R.I.D.s seen and PvP readings. Pure functions over
// the user-data objects; each returns whether it changed.
import { localDay } from '../../web/scripts/lib/format.js';
import { pvpReading } from '../game/pvp.mjs';

const PROGRESS_DAYS = 400;
const GRID_HISTORY_MAX = 400;
const MAX_PVP_LOG = 2000; // PvP readings per account (about a season of play)

/**
 * Progress keeps the first sample and the latest sample of each local day,
 * { [account]: { first, days: [{ day, t, cur: { id: [balance, lifetime] }, lv, xp, stars, rar, n }] } }.
 * Income is derived from lifetime totals, so gaps in tracking don't affect it.
 */
export function recordProgress(progress, account, snap, now, rules) {
  const starsBefore = (r) => (rules.rarityUpgrade || []).slice(0, r).reduce((s, x) => s + x.stars, 0);
  const u = snap.units;
  const point = {
    day: localDay(now),
    t: now,
    cur: Object.fromEntries(snap.currencies.map((c) => [c.id, [c.balance, c.lifetime]])),
    lv: u.reduce((s, x) => s + x.level, 0),
    xp: u.reduce((s, x) => s + x.xpLevel, 0),
    stars: u.reduce((s, x) => s + starsBefore(x.rarity) + x.stars, 0), // all stars invested
    rar: [0, 1, 2, 3, 4].map((r) => u.filter((x) => x.rarity === r).length),
    n: u.length,
  };
  const p = (progress[account] ??= { first: point, days: [] });
  const last = p.days[p.days.length - 1];
  if (last && last.day === point.day) {
    if (JSON.stringify({ ...last, t: 0 }) === JSON.stringify({ ...point, t: 0 })) return false;
    p.days[p.days.length - 1] = point;
  } else p.days.push(point);
  if (p.days.length > PROGRESS_DAYS) p.days.splice(0, p.days.length - PROGRESS_DAYS);
  return true;
}

/** Records a grid when it is new: a different refresh time or a new item (a reset). */
export function logGrid(gridHistory, account, grid, now) {
  const items = grid.rows.flat().filter((s) => !s.bought).map((s) =>
    (s.mini ? { mini: s.mini, rarity: s.rarity } : { xpBoost: s.xpBoost }));
  const list = (gridHistory[account] ??= []);
  const last = list[list.length - 1];
  const idOf = (x) => x.mini || x.xpBoost;
  const known = new Set((last?.items || []).map(idOf));
  const isNew = !last || last.refresh !== grid.refresh || items.some((x) => !known.has(idOf(x)));
  if (!isNew || !items.length) return false;
  list.push({ seen: now, refresh: grid.refresh, items });
  if (list.length > GRID_HISTORY_MAX) list.splice(0, list.length - GRID_HISTORY_MAX);
  return true;
}

/** Logs a PvP reading when honor or Victory Points change (pvpReading). acc.pvp holds the last reading. */
export function recordPvp(pvpHistory, account, acc, cur, now, vpRules) {
  const entry = pvpReading(acc.pvp, cur, now, vpRules);
  if (!entry) return false;
  pvpHistory[account] = [...(pvpHistory[account] || []), entry].slice(-MAX_PVP_LOG);
  acc.pvp = cur;
  return true;
}
