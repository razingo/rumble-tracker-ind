// PvP seasons, ranks, modifier rotations, records and win rates, from gamedata/pvp.json and the server's PvP log.
// The page's PvP tab and the server's notifications both use them.
import { DAY } from './constants.js';

/** The season running at time t, or null. */
export const seasonAt = (pvp, t) => pvp.seasons.find((s) => Date.parse(s.start) <= t && t < Date.parse(s.end)) || null;

/** The rank for an honor value. */
export const rankOf = (pvp, honor) => pvp.ranks.reduce((r, x) => (honor >= x.from ? x : r), pvp.ranks[0]);
export const nextRank = (pvp, rank) => pvp.ranks[pvp.ranks.indexOf(rank) + 1] || null;

/** The modifier set in play at time t: { mods: [id], start, end }, or null (each season runs its own rotation). */
export function setAt(pvp, t) {
  const rot = seasonAt(pvp, t)?.rotation;
  if (!rot?.sets.length) return null;
  const p = rot.periodDays * DAY, t0 = Date.parse(rot.start);
  const k = Math.floor((t - t0) / p);
  const n = rot.sets.length;
  return { mods: rot.sets[((k % n) + n) % n], start: t0 + k * p, end: t0 + (k + 1) * p };
}

const isMatch = (e) => !!(e.wins || e.losses);

/** Wins and losses in log entries from time `from`: { wins, losses, estimated, honorOnly }. */
export function record(log, from = 0) {
  let wins = 0, losses = 0, estimated = false, honorOnly = false;
  for (const e of log) {
    if (Date.parse(e.t) < from || !isMatch(e)) continue;
    wins += e.wins || 0;
    losses += e.losses || 0;
    if (e.estimated) estimated = true;
    if (e.honorOnly) honorOnly = true;
  }
  return { wins, losses, estimated, honorOnly };
}

/** The current streak from the newest entries: { kind: 'win'|'loss', n }, or null. Mixed entries end it. */
export function streak(log) {
  let kind = null, n = 0;
  for (const e of [...log].reverse()) {
    if (!isMatch(e)) continue;
    const k = e.wins && !e.losses ? 'win' : e.losses && !e.wins ? 'loss' : null;
    if (!k || (kind && k !== kind)) {
      if (!kind && !k) return null;
      break;
    }
    kind = k;
    n += e.wins || e.losses;
  }
  return kind ? { kind, n } : null;
}

/** Log entries with matches, each with the modifiers in play then: [{ t, wins, losses, mods }]. */
export function matchesWithMods(pvp, log) {
  return log.filter(isMatch).map((e) => {
    const t = Date.parse(e.t);
    return { t, wins: e.wins || 0, losses: e.losses || 0, mods: setAt(pvp, t)?.mods || [] };
  });
}

/** Wins and losses while each modifier was in play: { [id]: { wins, losses } }. */
export function modifierStats(matches) {
  const out = {};
  for (const m of matches) for (const id of m.mods) {
    const s = (out[id] ??= { wins: 0, losses: 0 });
    s.wins += m.wins;
    s.losses += m.losses;
  }
  return out;
}

/** Matches played while every selected modifier was in play (all of them when none is selected). */
export const withModifiers = (matches, selected) => matches.filter((m) => selected.every((id) => m.mods.includes(id)));

/** The win rate after each match: [{ t, wins, losses, rate }] (rate 0..1). */
export function winRateSeries(matches) {
  let wins = 0, losses = 0;
  return matches.map((m) => {
    wins += m.wins;
    losses += m.losses;
    return { t: m.t, wins, losses, rate: wins / (wins + losses) };
  });
}
