// PvP from the save (PvpPlayerRankState) and the matches the tracker infers from changes between reads.
// The save has no match history or win/loss counts. Each finished match adds Victory Points (VP), base x loss for a
// loss and base x win for a win, more on a win streak. Wins add honor and losses usually take some. So a VP change
// tells how many wins and losses happened since the previous read, and honor breaks ties, as two losses can equal
// one win in VP.
import { parseMessage, fieldsOf, findField, numberOf, readId } from '../../web/scripts/lib/protobuf.js';

/** { season: save id, honor, honor2, vp } from PvpPlayerRankState, or null. honor2 is a second honor value
 *  (equal to honor so far; maybe the season's best). */
export function parsePvp(buf) {
  if (!buf || !buf.length) return null;
  const f = parseMessage(buf);
  const seasonField = findField(f, 2);
  const rank = findField(f, 3);
  const vp = findField(f, 4);
  const r = rank && rank.wt === 2 ? fieldsOf(buf, rank) : [];
  return {
    season: seasonField ? readId(buf, seasonField) || null : null,
    honor: numberOf(findField(r, 1)),
    honor2: numberOf(findField(r, 2)),
    vp: vp && vp.wt === 2 ? numberOf(findField(fieldsOf(buf, vp), 1)) : 0,
  };
}

/** VP for a loss and for wins (one value per win-streak band), from pvp.json victoryPoints. */
export function vpValues(rules) {
  const base = rules?.base ?? 80;
  const loss = Math.round(base * (rules?.loss ?? 1));
  const wins = [...new Set((rules?.streak?.length ? rules.streak
    : [{ x: 1 }]).map((b) => Math.round(base * (rules?.win ?? 2) * (b.x ?? 1))))];
  return { loss, wins };
}

/**
 * The matches between two readings of the same season: { wins, losses, estimated, honorOnly }, or null when nothing
 * happened or it can't be told. estimated means more than one combination fits and honor picked one. honorOnly means
 * the Victory Points didn't move (Victory Road may stop counting once finished), so honor alone counts one match.
 */
export function inferMatches(prev, cur, rules, maxMatches = 12) {
  if (!prev || !cur || prev.season !== cur.season) return null;
  const dv = cur.vp - prev.vp;
  const dh = cur.honor - prev.honor;
  if (dv < 0) return null; // VP never drop within a season
  if (dv === 0) {
    if (dh > 0) return { wins: 1, losses: 0, estimated: true, honorOnly: true };
    if (dh < 0) return { wins: 0, losses: 1, estimated: true, honorOnly: true };
    return null;
  }
  const { loss, wins } = vpValues(rules);
  // Every (losses, wins per band) with total VP = dv, fewest matches first.
  const found = [];
  const search = (left, i, counts) => {
    if (counts.reduce((a, b) => a + b, 0) > maxMatches) return;
    if (i === wins.length) {
      if (left % loss === 0) found.push({ losses: left / loss, wins: counts.reduce((a, b) => a + b, 0) });
      return;
    }
    for (let n = 0; n * wins[i] <= left; n++) search(left - n * wins[i], i + 1, [...counts, n]);
  };
  search(dv, 0, []);
  if (!found.length) return null;
  const options = [...new Map(found.map((o) => [`${o.wins}/${o.losses}`, o])).values()];
  // Honor that rises means more wins than losses, and falling honor the opposite. Unchanged honor, at a floor or a
  // cap, tells nothing.
  const fits = options.filter((o) => (dh > 0 ? o.wins > 0 : dh < 0 ? o.losses > 0 : true));
  const pool = fits.length ? fits : options;
  const fewest = Math.min(...pool.map((o) => o.wins + o.losses));
  const best = pool.filter((o) => o.wins + o.losses === fewest);
  const pick = best.sort((a, b) => (dh >= 0 ? b.wins - a.wins : b.losses - a.losses))[0];
  // Certain only when honor leaves one combination.
  return { wins: pick.wins, losses: pick.losses, estimated: pool.length > 1 || !fits.length, honorOnly: false };
}

/**
 * The log entry for a new PvP reading, or null when nothing changed. The first reading of a season (or of an account)
 * is a starting point without matches. A change no win/loss combination explains (a VP step that fits no match, or
 * VP going down) is kept as unexplained; the player can mark it as a win or a loss (manualResult).
 */
export function pvpReading(prev, cur, now, rules) {
  if (!cur || !cur.season) return null;
  if (prev && prev.season === cur.season && prev.honor === cur.honor && prev.vp === cur.vp && prev.honor2 === cur.honor2) return null;
  const entry = { t: now, season: cur.season, honor: cur.honor, vp: cur.vp };
  if (!prev || prev.season !== cur.season) return { ...entry, start: true };
  entry.dh = cur.honor - prev.honor;
  entry.dv = cur.vp - prev.vp;
  const m = inferMatches(prev, cur, rules);
  if (m) return { ...entry, ...m };
  // Only the second honor value moved, which isn't a match.
  if (!entry.dh && !entry.dv) return entry;
  return { ...entry, unexplained: true };
}

/** Sets the player's own result ('win' or 'loss', null to clear) for an unexplained entry. False when not allowed. */
export function manualResult(entry, result) {
  if (!entry || !entry.unexplained || ![null, 'win', 'loss'].includes(result)) return false;
  delete entry.wins;
  delete entry.losses;
  delete entry.manual;
  if (result) Object.assign(entry, { manual: result, wins: result === 'win' ? 1 : 0, losses: result === 'loss' ? 1 : 0 });
  return true;
}
