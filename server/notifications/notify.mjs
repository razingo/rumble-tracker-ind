// Determines which notifications are due, from the scanned save and the event schedules. Each has a unique key so
// it is sent once; the server tracks sent keys, applies quiet hours and delivers them (toast.mjs).
import { occurrences, rotationAt, rotationName } from '../../web/scripts/lib/schedule.js';
import { APP_NAME, DAY, HOUR } from '../../web/scripts/lib/constants.js';
import { fmt, when, spanWords } from '../../web/scripts/lib/format.js';
import { seasonAt, setAt, rankOf } from '../../web/scripts/lib/pvp-season.js';

const GRACE = 3 * HOUR; // older occurrences (tracker not running) are not announced

/**
 * Notification types: id, label, default state, whether sent while the game is running, and `several`, the title of
 * one notification that stands for several of the type ("12 minis are ready to upgrade").
 */
export const NOTIFY_TYPES = [
  { id: 'freeGift', label: 'Free gift ready', on: true, whenPlaying: false, several: 'free gifts are ready' },
  { id: 'dailyReset', label: 'Daily shop offers reset', on: false, whenPlaying: false, several: 'daily shop resets' },
  { id: 'gridRefresh', label: 'New G.R.I.D.', on: true, whenPlaying: false, several: 'new G.R.I.D.s' },
  { id: 'eventStart', label: 'An event starts', on: true, whenPlaying: true, several: 'events have started' },
  { id: 'eventEnding', label: 'An event ends soon', on: true, whenPlaying: true, hoursBefore: 3, several: 'events end soon' },
  { id: 'rotation', label: 'Dungeon faction, dungeon or raid/siege changes', on: false, whenPlaying: false,
    several: 'dungeon and raid changes' },
  { id: 'upgradeReady', label: 'A mini is ready to upgrade', on: true, whenPlaying: false, several: 'minis are ready to upgrade' },
  { id: 'planAffordable', label: 'Enough tickets for a reward goal', on: true, whenPlaying: true,
    several: 'reward goals have enough tickets' },
  { id: 'pvpSeasonEnd', label: 'The PvP season ends soon', on: true, whenPlaying: true, hoursBefore: 48,
    several: 'PvP seasons end soon' },
  { id: 'pvpModifiers', label: 'PvP modifiers change', on: false, whenPlaying: false, several: 'PvP modifier changes' },
  { id: 'appUpdate', label: 'A new tracker version is available', on: true, whenPlaying: true, several: 'tracker updates' },
];

const NAMED = 3; // a combined notification names this many, then says how many more

/** One notification for several of a type: their count in the title, and what they are about in the body. */
export function combined(type, items) {
  const several = NOTIFY_TYPES.find((t) => t.id === type)?.several || 'notifications';
  const names = items.slice(0, NAMED).map((n) => n.about || n.title).join(', ');
  const more = items.length - NAMED;
  return { type, title: `${items.length} ${several}`, body: more > 0 ? `${names} and ${more} more.` : `${names}.` };
}

export function defaultSettings() {
  return {
    enabled: true,
    account: null, // null for all accounts
    types: Object.fromEntries(NOTIFY_TYPES.map((t) => [t.id,
      { on: t.on, whenPlaying: t.whenPlaying, ...(t.hoursBefore ? { hoursBefore: t.hoursBefore } : {}) }])),
    quiet: { on: false, from: '23:00', to: '08:00' },
  };
}

/** Validated settings merged over the defaults. */
export function cleanSettings(s) {
  const d = defaultSettings();
  const time = (v, fb) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fb);
  const out = {
    enabled: typeof s?.enabled === 'boolean' ? s.enabled : d.enabled,
    account: typeof s?.account === 'string' && /^[0-9a-f]{32}$/.test(s.account) ? s.account : null,
    types: {},
    quiet: { on: !!s?.quiet?.on, from: time(s?.quiet?.from, d.quiet.from), to: time(s?.quiet?.to, d.quiet.to) },
  };
  for (const t of NOTIFY_TYPES) {
    const v = s?.types?.[t.id] || {};
    out.types[t.id] = { on: typeof v.on === 'boolean' ? v.on : d.types[t.id].on,
      whenPlaying: typeof v.whenPlaying === 'boolean' ? v.whenPlaying : d.types[t.id].whenPlaying };
    if (t.hoursBefore) out.types[t.id].hoursBefore = Math.min(72,
      Math.max(1, Number.isFinite(+v.hoursBefore) ? Math.round(+v.hoursBefore) : t.hoursBefore));
  }
  return out;
}

/** Whether `now` falls within quiet hours (which may span midnight). */
export function inQuietHours(quiet, now = new Date()) {
  if (!quiet?.on) return false;
  const mins = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const n = now.getHours() * 60 + now.getMinutes(), a = mins(quiet.from), b = mins(quiet.to);
  return a <= b ? n >= a && n < b : n >= a || n < b;
}

const balanceOf = (a, id) => a.currencies?.find((c) => c.id === id)?.balance ?? 0;
const isNew = (c, t) => c.now >= t && c.now - t < GRACE;

// Each check below takes the context and an add(type, key, title, body, about) function; `about` names what the
// notification is about (a mini, an event, an account) when several are combined into one.

function appUpdate(c, add) {
  if (c.newVersion) {
    add('appUpdate', `app-version-${c.newVersion}`, 'Tracker update available',
      `${APP_NAME} ${c.newVersion} is available. Open the tracker to get it.`);
  }
}

function freeGift(c, add) {
  for (const a of c.accounts) {
    for (const o of a.shop?.offers || []) {
      if (!o.expires || !/^FreeGift_/.test(c.store?.offers?.[o.offer]?.name || '')) continue;
      if (isNew(c, Date.parse(o.expires))) add('freeGift', `freeGift:${a.id}:${o.expires}`,
        `Free gift ready${c.who(a)}`, 'A new free gift is waiting in the shop.', a.label);
    }
  }
}

function gridRefresh(c, add) {
  for (const a of c.accounts) {
    const refresh = a.shop?.grid?.refresh;
    if (refresh && isNew(c, Date.parse(refresh))) add('gridRefresh', `grid:${a.id}:${refresh}`,
      `New G.R.I.D.${c.who(a)}`, 'The G.R.I.D. has new minis.', a.label);
  }
}

/** The shop's daily offers reset at 18:00 UTC. */
function dailyReset(c, add) {
  const d = new Date(c.now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18);
  if (t > c.now) t -= DAY;
  if (c.now - t < GRACE) add('dailyReset', `daily:${new Date(t).toISOString().slice(0, 10)}`, 'Daily offers reset',
    'New daily offers are in the shop.');
}

/** Events starting, and ending within the chosen number of hours. Runs of one event announce it once. */
function events(c, add) {
  const { now, events: table } = c;
  const runs = (table?.events || []).flatMap((ev) => occurrences(ev, now - 2 * DAY, now + 4 * DAY).map((o) => ({ ev, ...o })));
  const lead = (c.settings.types.eventEnding?.hoursBefore || 3) * HOUR;
  const told = new Set();
  for (const r of runs.sort((x, y) => x.start - y.start)) {
    const name = r.ev.name || r.ev.id;
    if (c.on('eventStart') && isNew(c, r.start) && !told.has(`start:${name}`)) {
      told.add(`start:${name}`);
      add('eventStart', `evStart:${r.ev.id}:${r.start}`, `${name} has started`, `It runs until ${when(r.end)}.`,
        name);
    }
    if (c.on('eventEnding') && now < r.end && r.end - now <= lead && !told.has(`end:${name}`)) {
      told.add(`end:${name}`);
      const currency = r.ev.currency && table.currencies?.[r.ev.currency];
      const tickets = currency ? Math.max(0, ...c.accounts.map((a) => balanceOf(a, currency))) : 0;
      add('eventEnding', `evEnd:${r.ev.id}:${r.end}`, `${name} ends in ${spanWords(r.end - now)}`,
        tickets > 0 ? `You still have ${fmt(tickets)} tickets to spend.` : `It ends ${when(r.end)}.`, name);
    }
  }
}

/** The dungeon faction, dungeon and raid or siege of the week. */
function rotation(c, add) {
  for (const rot of c.events?.rotations || []) {
    const cur = rotationAt(rot, c.now);
    if (c.now - cur.start < GRACE) add('rotation', `rot:${rot.id}:${cur.start}`,
      `${rot.label}: ${rotationName(cur.item)}`, `Until ${when(cur.end)}.`);
  }
}

/** The PvP season ends soon: Victory Road resets, and season-end rewards go by rank. */
function pvpSeasonEnd(c, add) {
  const season = c.pvp?.seasons && seasonAt(c.pvp, c.now);
  if (!season) return;
  const end = Date.parse(season.end);
  if (end - c.now > (c.settings.types.pvpSeasonEnd?.hoursBefore || 48) * HOUR) return;
  const ranks = c.accounts.filter((a) => a.pvp?.season === season.saveId).map((a) => `${rankOf(c.pvp, a.pvp.honor).name}${c.who(a)}`);
  add('pvpSeasonEnd', `pvpEnd:${season.id}`, `${season.name} ends in ${spanWords(end - c.now)}`,
    `Claim your Victory Road rewards before it resets.${ranks.length
      ? ` Your rank for the season-end rewards: ${ranks.join(', ')}.` : ''}`);
}

function pvpModifiers(c, add) {
  const set = c.pvp?.seasons && setAt(c.pvp, c.now);
  if (!set || c.now - set.start >= GRACE) return;
  add('pvpModifiers', `pvpMods:${set.start}`, 'New PvP modifiers',
    `${set.mods.map((id) => c.pvp.modifiers?.[id]?.name || id).join(', ')}, until ${when(set.end)}.`);
}

/** Minis whose next rarity is affordable: enough stars, Arc Energy and, where needed, a core. */
function upgradeReady(c, add) {
  const { rules } = c;
  if (!rules) return;
  for (const a of c.accounts) {
    for (const u of a.units || []) {
      const step = rules.rarityUpgrade?.[u.rarity];
      if (!step || !u.slug) continue;
      const ready = u.stars >= step.stars && balanceOf(a, rules.currencyIds.arcEnergy) >= step.arcEnergy
        && (!step.core || balanceOf(a, rules.currencyIds[step.core]) >= 1);
      if (ready) add('upgradeReady', `up:${a.id}:${u.id}:${u.rarity}`, `Ready to upgrade${c.who(a)}`,
        `${u.name || u.slug} can be upgraded to ${rules.rarities[u.rarity + 1]?.name || 'the next rarity'}.`,
        `${u.name || u.slug}${c.who(a)}`);
    }
  }
}

/** Reward goals: enough tickets for the chosen rewards while the event runs. */
function planAffordable(c, add) {
  for (const a of c.accounts) {
    for (const [evId, plan] of Object.entries(c.plans?.[a.id] || {})) {
      const ev = (c.events?.events || []).find((e) => e.id === evId);
      if (!ev?.currency || !plan.cost || !occurrences(ev, c.now, c.now + 1).length) continue;
      const have = balanceOf(a, c.events.currencies[ev.currency]);
      if (have >= plan.cost) add('planAffordable', `plan:${a.id}:${evId}:${plan.cost}`, `Enough tickets${c.who(a)}`,
        `You have ${fmt(have)} tickets, enough for ${plan.label} (${fmt(plan.cost)}).`, `${plan.label}${c.who(a)}`);
    }
  }
}

const CHECKS = { appUpdate, freeGift, gridRefresh, dailyReset, events, rotation, pvpSeasonEnd,
  pvpModifiers, upgradeReady, planAffordable };

/**
 * Notifications due now: [{ type, key, title, body, about? }]. The keys make each one go out once.
 * ctx = { now, accounts: [{ id, label, shop, currencies, units, pvp }], events, store, rules, pvp, plans, settings,
 *   multi, newVersion }.
 */
export function dueNotifications(ctx) {
  const { settings } = ctx;
  const on = (id) => settings.enabled && !!settings.types[id]?.on;
  const c = { ...ctx, on, who: (a) => (ctx.multi ? ` (${a.label})` : '') };
  const out = [];
  const add = (type, key, title, body, about) => out.push({ type, key, title, body, ...(about ? { about } : {}) });
  for (const [id, check] of Object.entries(CHECKS)) {
    // The event check covers two types, each tested inside.
    if (id === 'events' ? on('eventStart') || on('eventEnding') : on(id)) check(c, add);
  }
  return out;
}
