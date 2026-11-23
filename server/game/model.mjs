// Decodes save records into units, currencies and shop data, and detects changes between scans.
import { parseMessage, fieldsOf, findField, numberOf, readId, textOf } from '../../web/scripts/lib/protobuf.js';

/**
 * Unit record fields:
 * 2 level shown, 3 XP, 5 hidden XP-pick weight, 6 XP needed, 7 XP level,
 * 8 talents + rarity steps, 9 {1 talents, 2 rarity, 3 ?}, 10 stars collected.
 */
export function parseUnits(buf) {
  if (!buf || !buf.length) return [];
  return parseMessage(buf)
    .filter((f) => f.fn === 1 && f.wt === 2)
    .map((f) => {
      const p = fieldsOf(buf, f);
      const u = { id: readId(buf, findField(p, 1)), level: 0, xp: 0, xpNeeded: 0, xpLevel: 0, bonus: 0, talents: 0,
        rarity: 0, stars: 0, xpWeight: 0 };
      for (const x of p) {
        switch (x.fn) {
          case 2: u.level = numberOf(x); break;
          case 3: u.xp = numberOf(x); break;
          case 5: u.xpWeight = x.wt === 1 ? Math.round(x.f64 * 1000) / 1000 : 0; break;
          case 6: u.xpNeeded = numberOf(x); break;
          case 7: u.xpLevel = numberOf(x); break;
          case 8: u.bonus = numberOf(x); break;
          case 9: {
            const q = fieldsOf(buf, x);
            u.talents = numberOf(findField(q, 1));
            u.rarity = numberOf(findField(q, 2));
            break;
          }
          case 10: u.stars = numberOf(x); break;
        }
      }
      return u;
    })
    .filter((u) => u.id);
}

/** Field 1 = current balances, field 4 = lifetime earned. */
export function parseCurrencies(buf) {
  if (!buf || !buf.length) return [];
  const map = new Map();
  for (const f of parseMessage(buf)) {
    if (f.wt !== 2 || (f.fn !== 1 && f.fn !== 4)) continue;
    const p = fieldsOf(buf, f);
    const id = readId(buf, findField(p, 1));
    if (!id) continue;
    const c = map.get(id) || { id, balance: 0, lifetime: 0 };
    if (f.fn === 1) c.balance = numberOf(findField(p, 2));
    else c.lifetime = numberOf(findField(p, 2));
    map.set(id, c);
  }
  return [...map.values()];
}

/**
 * Events the game currently runs. In StoreState, the store's dynamic offers carry a list
 * f16 = { 1: ?, 2: event definition id }. Returns unique definition ids.
 */
export function parseActiveEvents(buf) {
  if (!buf || !buf.length) return [];
  const ids = new Set();
  for (const slot of parseMessage(buf)) {
    if (slot.fn !== 5 || slot.wt !== 2) continue; // store slots
    for (const offer of fieldsOf(buf, slot)) {
      if (offer.fn !== 7 || offer.wt !== 2) continue;
      for (const ev of fieldsOf(buf, offer)) {
        if (ev.fn !== 16 || ev.wt !== 2) continue;
        const id = readId(buf, findField(fieldsOf(buf, ev), 2));
        if (id) ids.add(id);
      }
    }
  }
  return [...ids];
}

/** Owned income bonuses (e.g. Basic Booster), from StoreState f23 = { 1: offer, 3: bonus id }. */
export function parseIncomeBonuses(buf) {
  if (!buf || !buf.length) return [];
  const ids = new Set();
  for (const f of parseMessage(buf)) {
    if (f.fn !== 23 || f.wt !== 2) continue;
    const id = readId(buf, findField(fieldsOf(buf, f), 3));
    if (id) ids.add(id);
  }
  return [...ids];
}

const timeOf = (buf, f) => {
  // a time is { 1: fixed64 milliseconds }
  if (!f || f.wt !== 2) return null;
  const t = findField(fieldsOf(buf, f), 1);
  const ms = t && t.wt === 1 ? Number(t.u64) : 0;
  return ms > 1.3e12 && ms < 2.2e12 ? new Date(ms).toISOString() : null;
};

/**
 * The shop, from StoreState:
 *  f2 x3 = G.R.I.D. rows, bottom row first; slot = { 1: mini, 2: XP boost item, 13: rarity } or empty once bought
 *  f3 = next G.R.I.D. refresh
 *  f5 = store slots { 1: offer, 2: expires, 7: { 11: { 2: mini }, 12: { 2: tome }, 13: family }, 8: slot }
 *  f12 = limited offers { 1: offer, 2: expires }
 */
export function parseStore(buf) {
  if (!buf || !buf.length) return null;
  const top = parseMessage(buf);
  const rows = top.filter((f) => f.fn === 2 && f.wt === 2).map((row) =>
    fieldsOf(buf, row).filter((s) => s.fn === 1 && s.wt === 2).map((s) => {
      const p = fieldsOf(buf, s);
      const mini = readId(buf, findField(p, 1)) || null;
      const xpBoost = readId(buf, findField(p, 2)) || null;
      const rarity = readId(buf, findField(p, 13)) || null;
      return mini || xpBoost ? { mini, xpBoost, rarity } : { bought: true };
    })).reverse(); // top row first
  const offers = top.filter((f) => f.fn === 5 && f.wt === 2).map((f) => {
    const p = fieldsOf(buf, f);
    const inner = findField(p, 7) && fieldsOf(buf, findField(p, 7));
    const minis = (inner || []).filter((x) => x.fn === 11 && x.wt === 2).map((x) =>
      readId(buf, findField(fieldsOf(buf, x), 2))).filter(Boolean);
    const tomeF = (inner || []).find((x) => x.fn === 12 && x.wt === 2);
    return {
      offer: readId(buf, findField(p, 1)),
      slot: readId(buf, findField(p, 8)) || null,
      expires: timeOf(buf, findField(p, 2)),
      minis,
      tome: tomeF ? readId(buf, findField(fieldsOf(buf, tomeF), 2)) || null : null,
      family: inner ? readId(buf, findField(inner, 13)) || null : null,
    };
  }).filter((o) => o.offer);
  const limited = top.filter((f) => f.fn === 12 && f.wt === 2).map((f) => {
    const p = fieldsOf(buf, f);
    return { offer: readId(buf, findField(p, 1)), expires: timeOf(buf, findField(p, 2)) };
  }).filter((o) => o.offer);
  return { grid: { rows, refresh: timeOf(buf, findField(top, 3)) }, offers, limited };
}

/** Game build that wrote the save, from CommerceState f1.f3 ("16.1.2.119766.dp-…" -> "16.1.2.119766"). */
export function parseGameBuild(buf) {
  if (!buf || !buf.length) return null;
  const f1 = findField(parseMessage(buf), 1);
  if (!f1 || f1.wt !== 2) return null;
  const f3 = findField(fieldsOf(buf, f1), 3);
  if (!f3 || f3.wt !== 2) return null;
  const m = /^(\d+\.\d+\.\d+\.\d+)/.exec(textOf(buf, f3));
  return m ? m[1] : null;
}

/** Compares dotted versions or game builds: < 0 if a is older than b, > 0 if newer. */
export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** Owned avatars, from ProfileManagerState f1 = { 1: avatar id, 2: 2 owned | 3 selected }. */
export function parseOwnedAvatars(buf) {
  if (!buf || !buf.length) return [];
  const ids = new Set();
  for (const f of parseMessage(buf)) {
    if (f.fn !== 1 || f.wt !== 2) continue;
    const id = readId(buf, findField(fieldsOf(buf, f), 1));
    if (id) ids.add(id);
  }
  return [...ids];
}

function xpTotal(rules, xpLevel, xp) {
  let total = 0;
  for (let l = 1; l < xpLevel; l++) total += rules.xpToNext[l] || 0;
  return total + xp;
}

export function diffSnapshots(prev, cur, rules, t) {
  const events = [];
  const before = new Map(prev.units.map((u) => [u.id, u]));
  for (const u of cur.units) {
    const o = before.get(u.id);
    if (!o) {
      events.push({ t, type: 'unit_new', id: u.id, level: u.xpLevel, xp: u.xp, xpNeeded: u.xpNeeded, rarity: u.rarity });
      continue;
    }
    if (o.xpLevel !== u.xpLevel || o.xp !== u.xp) {
      events.push({
        t, type: 'unit_xp', id: u.id,
        from: { level: o.xpLevel, xp: o.xp }, to: { level: u.xpLevel, xp: u.xp, xpNeeded: u.xpNeeded },
        gained: xpTotal(rules, u.xpLevel, u.xp) - xpTotal(rules, o.xpLevel, o.xp),
      });
    }
    if (o.rarity !== u.rarity) events.push({ t, type: 'unit_rarity', id: u.id, from: o.rarity, to: u.rarity });
    if (o.talents !== u.talents) events.push({ t, type: 'unit_talent', id: u.id, from: o.talents, to: u.talents });
    if (o.stars !== u.stars) events.push({ t, type: 'unit_stars', id: u.id, from: o.stars, to: u.stars });
  }
  const prevCur = new Map(prev.currencies.map((c) => [c.id, c]));
  for (const c of cur.currencies) {
    const from = prevCur.get(c.id)?.balance ?? 0;
    if (from !== c.balance) events.push({ t, type: 'currency', id: c.id, from, to: c.balance, delta: c.balance - from });
  }
  return events;
}

