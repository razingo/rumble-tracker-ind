// Build gamedata/events.json: every seasonal event from the game's bundles with its schedule rule and English name.
// usage: node build_events.mjs [out.json]
// Schedules:
//   DatumSchedule  date rule repeating every year (or every month with m_runMonthly), from m_year/m_month onwards
//                  - m_dateTypeSetting "DayOfWeekInstance": the n-th (m_weekdayIndex, 1-based) m_dayOfWeek of the month
//                  - otherwise: m_dayOfMonth of the month
//                  lasts m_duration days; time of day from m_referenceDateTime (18:00 UTC)
//   RotatingSchedule  one window from m_referenceDateTime to m_expirationDateTime (all of these are past one-offs)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFiles, dataObjects, saveIdOf, englishStrings, COINS, CURRENCY_NAMES } from './unityfs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RUMBLE_GAMEDATA || join(HERE, '..', '..', 'gamedata'); // the game data being built
const WORK = process.env.RUMBLE_WORK || HERE; // working files passed between the steps
const OUT = process.argv[2] || join(DATA, 'events.json');
const DIR = process.env.RUMBLE_BUNDLES;
const all = bundleFiles(DIR);
// the event families with a ticket icon of their own (extract_event_icons.py makes them)
const ICONS = JSON.parse(readFileSync(join(HERE, 'event_icon_sprites.json'), 'utf8'));

// every JSON data object from the event bundles, plus schedules/strings that live elsewhere
const objs = {};
const WANT = new RegExp([
  'SeasonalEvent', 'Schedule', 'UserFacingString', 'CurrencyType', '^Reward$', '^RewardSet$', 'SharedInt', '^Skin$', '^Avatar$',
  'DungeonData', 'RaidSettings', 'RaidSequence', 'DungeonSequence', 'EventTheme', '^IncomeBonus$', 'RandomDeckChallenges',
  'RandomDeckSet',
].join('|'));
const BUNDLES = new RegExp('^(' + [
  'seasonalevent_', 'strtable_', 'data_currencytype', 'feature_seasonalevents', 'feature_dungeons', 'feature_raids',
  'support_progression', 'support_commerce', 'store\\.bundle', 'ui_avatars', 'ui_(moltencore|stormwind|ironforge|onyxia)',
  'zonedata_dungeon_', 'cosmetics_skins_', 'gryphongame_embedded',
].join('|') + ')');
// (no object here is longer than 2e6 characters)
dataObjects(all.filter((p) => BUNDLES.test(p.split(/[\\/]/).pop())),
  { wanted: (type) => WANT.test(type), limit: 2e6, maxFile: 2e8, into: objs, bundle: true });

const str = englishStrings(objs);
const clean = (s) => s?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;

// event currencies (data_currencytype.bundle): A, B, C share one balance each across events
const CUR = { '0c6d981755f2d43f28921e60e9555871': 'A', '0d9e33ea4c36c4bb79ef30d6d82203d3': 'B', '0152633a93ba94c2bab0dae8daa8745a': 'C' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function schedule(sc) {
  if (!sc) return null;
  const hour = Number((sc.m_referenceDateTime || '').slice(11, 13)) || 18;
  if (sc.type === 'RotatingSchedule') {
    const iso = (s) => s.replace(' ', 'T');
    return { kind: 'once', start: iso(sc.m_referenceDateTime), end: iso(sc.m_expirationDateTime) };
  }
  if (sc.type !== 'DatumSchedule') return null;
  const s = sc.m_eventStartDate || {};
  const base = {
    every: sc.m_runMonthly ? 'month' : 'year',
    month: MONTHS.indexOf(s.m_month) + 1,   // annual: the month; monthly: first month it ran
    fromYear: s.m_year,
    days: sc.m_duration,
    hourUtc: hour,
    until: (sc.m_expirationDateTime || '').slice(0, 10) || null,
  };
  if (s.m_dateTypeSetting === 'DayOfWeekInstance') return { kind: 'nthWeekday', nth: s.m_weekdayIndex,
    weekday: WEEKDAYS.indexOf(s.m_dayOfWeek), ...base };
  return { kind: 'dayOfMonth', day: s.m_dayOfMonth || 1, ...base };
}

// family key from the definition name, used for colors and grouping
function family(n) {
  const k = n.replace(/SeasonalEventDefinition_?|_SeasonalEventDefinition/, '');
  if (/^DMF/.test(k)) return 'darkmoon';
  if (/^Love/.test(k)) return 'love';
  if (/^NewYear/.test(k)) return 'newyear';
  if (/Login/.test(k)) return 'login';
  if (/^Solo/.test(k)) return 'solo';
  if (/GadgetBonanza/.test(k)) return 'gadget';
  if (/Winterveil/.test(k)) return 'winterveil';
  if (/PilgrimsBounty/.test(k)) return 'pilgrim';
  if (/HallowsEnd/.test(k)) return 'hallow';
  if (/FamilyEvents/.test(k)) return 'family';
  if (/MiniHighlight/.test(k)) return 'highlight';
  return k.replace(/[_\d].*$/, '').toLowerCase();
}

const events = [];
for (const d of Object.values(objs)) {
  if (d.type !== 'SeasonalEventDefinition' || /DEPRECATED|^Test|Template/i.test(d.name)) continue;
  const timing = objs[d.m_scheduleTiming];
  const sc = schedule(timing && objs[timing.m_schedule]);
  if (!sc) { console.warn('no schedule:', d.name); continue; }
  events.push({
    id: d.name.replace(/_?SeasonalEventDefinition_?/, '') || d.name,
    saveId: saveIdOf(d.guid),   // how the registry refers to this event (StoreState active-event list)
    name: clean(str[d.m_eventName]) || null,
    family: family(d.name),
    icon: ICONS[family(d.name)] ? family(d.name) : undefined, // (the page shows the generic ticket without one)
    currency: CUR[d.m_currencyType] || null,
    schedule: sc,
  });
}
events.sort((a, b) => a.id.localeCompare(b.id));

// reward trees
// Each SeasonalEventReward is named <Event>_Row<A..>_Col<n>: rows top to bottom, columns staggered (odd/even per row)
// like the in-game prize tree. Cost = SharedInt (event tickets), reward = Reward object. Only for recurring events.
const sprites = new Set();
const UNIT_SLUGS = JSON.parse(readFileSync(join(DATA, 'unit_ids.json'), 'utf8')).units || {};
const spriteOf = (ref) => (ref ? String(ref).split(',')[1] || null : null);
function rewardOf(r) {
  const g = objs[r?.m_grantedReward];
  const pos = /Row([A-Z])_Col(\d+)/.exec(r?.name || '');
  if (!g || !pos) return null;
  const out = { row: pos[1].charCodeAt(0) - 65, col: Number(pos[2]), cost: objs[r.m_currencyCost]?.m_value ?? null };
  out.label = clean(str[g.m_rewardName]) || g.name.replace(/^EventReward_/, '');
  let icon = spriteOf(g.m_sprite);
  const tome = /^EventReward_(Modest|Major|Mega|Mythic)(\w*?)Tome/.exec(g.name || '');
  // a reward's own sprite wins; tomes without one get the matching tome icon (a tome of no faction is the game's
  // "Generic" one, but for the Modest size, whose picture it calls "Star")
  if (tome && !icon) {
    icon = `Shared_Tex_Tome${tome[1]}_${tome[2].replace(/^_/, '') || (tome[1] === 'Modest' ? 'Star' : 'Generic')}`;
  }
  else if (g.m_grantType === 'Mini' && g.m_mini) {
    // the page shows the mini's own art (minis.json) instead of a game sprite
    out.mini = UNIT_SLUGS[saveIdOf(g.m_mini)] || null;
    out.amount = g.m_miniCount || 1;
    out.unit = true;
  }
  else if (g.m_grantType === 'Avatar') {
    // the avatar's portrait sprite reference ("<guid>,Indicator_..."), wherever it sits in the object
    const a = objs[g.m_avatar];
    // (its m_icon first; some are spelled "indicator_X", lower case)
    icon = spriteOf(a?.m_icon) || (JSON.stringify(a || {}).match(/[0-9a-f]{32},(Indicator_[^"]+)/i) || [])[1]
      || (a ? `Indicator_${a.name.replace(/_Avatar$/, '')}_Pose` : null);
  }
  else if (g.m_grantType === 'Skin') icon = spriteOf(objs[g.m_skin]?.m_portraitImage || objs[g.m_skin]?.m_storeOfferIcon);
  // cosmetic's save id, so the page can tell whether the player already owns it
  if (g.m_grantType === 'Avatar' && g.m_avatar) out.cosmetic = saveIdOf(g.m_avatar);
  if (g.m_grantType === 'Skin' && g.m_skin) out.cosmetic = saveIdOf(g.m_skin);
  else if (g.m_grantType === 'ItemChoice') out.choices = g.m_numberOfSelections || null;
  // RewardSet = a choice the server generates (e.g. a Star Tome): one option per config
  if (g.type === 'RewardSet') {
    // StarPointTome_ServerGeneration: the game hands out one Star Point Tome (shown as x1), not a choice
    const STAR_POINT_TOME = '615b1b1247b78f04bb580b056fd54a21';
    if ((g.m_rewardConfigs || []).every((c) => c.m_rewardGenerationFunction === STAR_POINT_TOME)) {
      out.label = 'Star Point Tome'; out.kind = 'tome'; }
    else out.choices = (g.m_rewardConfigs || []).length || null;
  }
  if (!tome && !out.unit && g.m_currencyType && g.m_currencyAmount && g.m_grantType !== 'ItemChoice') {
    out.amount = g.m_currencyAmount;
    // the reward's own text is sometimes a generic string (a Rare Core read "Arc Energy"): name it by its currency
    if (CURRENCY_NAMES[g.m_currencyType]) out.label = CURRENCY_NAMES[g.m_currencyType];
    if (g.m_currencyType === COINS) out.coins = true; // raised by coin income bonuses
  }
  delete out.unit;
  if (g.m_grantType === 'Tome' || tome || out.kind === 'tome') out.kind = 'tome';
  else if (g.m_grantType) out.kind = g.m_grantType.toLowerCase();
  else if (g.m_currencyType) out.kind = 'currency';
  if (icon) { out.icon = icon; sprites.add(icon); }
  return out;
}
// Tickets an event's challenges can pay out.
// Each challenge option has a deck and a number of active challenges:
//  - fixed decks (m_alwaysNonRandom, or no more challenges than active slots): every challenge's whole chain
//    (m_nextChallenges), each step paying m_challengeRewardAmount (SharedInt)
//  - random decks: <active> challenges drawn per day (daily decks) or once (weekly decks), each paying its chain value;
//    RandomDeckSet = sigil-gated variants of one deck, same values, so the first is used
// Not included: tickets from guild mates (Darkmoon Faire), which aren't in the game files.
function challengeTickets(d, days) {
  let total = 0, steps = 0, missing = 0;
  const groups = []; // for the Calendar's challenge list: { kind: fixed|daily|weekly, active, perDay?, challenges }
  // a challenge chain: each step's title (its {0} is the target), target and tickets
  const chainOf = (g) => {
    const out = [];
    const seen = new Set();
    for (let c = objs[g]; c && !seen.has(c.guid); c = objs[(c.m_nextChallenges || [])[0]]) {
      seen.add(c.guid);
      const v = objs[c.m_challengeRewardAmount]?.m_value;
      if (v == null) missing++; else steps++;
      const target = c.m_challengeScoreTarget || 1;
      const title = (str[c.m_challengeTitle] || c.name || '').replace(/<[^>]+>/g, '').replace(/\{0\}/g,
        String(target)).replace(/\s+/g, ' ').trim();
      out.push({ title, target, tickets: v || 0 });
    }
    if (!objs[g]) missing++;
    return out;
  };
  for (const opt of d?.m_challengeOptions || []) {
    let deck = objs[opt.m_challengesDeck];
    if (deck?.type === 'RandomDeckSet') deck = objs[deck.m_decks?.[0]?.m_deck];
    const chains = (deck?.m_challenges || []).map((e) => ({ steps: chainOf(e.m_challenge), cards: e.m_cardCount || 1 }));
    const values = chains.map((c) => c.steps.reduce((s, x) => s + x.tickets, 0) * c.cards);
    if (!values.length) continue;
    const active = opt.m_activeChallengeCount || 1;
    // one entry per chain: the first step's title names it; later steps list their own target and tickets
    const list = chains.map((c) => ({ title: c.steps[0]?.title || '?',
      steps: c.steps.map((x) => ({ title: x.title, target: x.target, tickets: x.tickets })),
      total: c.steps.reduce((s, x) => s + x.tickets, 0) }));
    if (deck.m_alwaysNonRandom || values.length <= active) {
      total += values.reduce((s, v) => s + v, 0);
      groups.push({ kind: /Weekly/i.test(deck.name) ? 'weekly' : 'fixed', active, challenges: list });
    } else {
      const perPick = values.reduce((s, v) => s + v, 0) / values.length;
      const weekly = /Weekly/i.test(deck.name);
      total += Math.round(active * perPick * (weekly ? 1 : days || 1));
      groups.push({ kind: weekly ? 'weekly' : 'daily', active,
        perDay: weekly ? undefined : Math.round(active * perPick), poolSize: list.length, challenges: list });
    }
  }
  return { total, steps, missing, groups };
}
for (const ev of events) {
  if (ev.schedule.kind === 'once') continue;
  const d = Object.values(objs).find((o) => o.type === 'SeasonalEventDefinition' && o.guid && saveIdOf(o.guid) === ev.saveId);
  const ct = challengeTickets(d, ev.schedule.days);
  if (ct.steps) { ev.challengeTickets = ct.total; ev.challenges = ct.groups; }
  if (ct.missing) console.warn(`${ev.id}: ${ct.missing} challenge steps without data`);
  const all = (d?.m_rewards || []).map((g) => ({ g, r: rewardOf(objs[g]) }));
  // say so instead of silently dropping a reward the build can't read
  for (const x of all) if (!x.r) console.warn(`${ev.id}: skipped reward ${objs[x.g]?.name
    || x.g} (granted ${objs[objs[x.g]?.m_grantedReward]?.type || 'unknown type'})`);
  // The tree's real links: m_requiredRewards (any one of them unlocks the reward, or all of them with
  // m_requirementType "All", e.g. the Completion Bonus). Stored as "row-col" keys of the same tree.
  const posOf = new Map(all.filter((x) => x.r).map((x) => [x.g, `${x.r.row}-${x.r.col}`]));
  for (const x of all) {
    if (!x.r) continue;
    const req = objs[x.g].m_requiredRewards || [];
    x.r.requires = req.map((g) => posOf.get(g)).filter(Boolean);
    if (req.length !== x.r.requires.length) console.warn(`${ev.id}: ${objs[x.g].name} requires a reward outside the tree`);
    if (objs[x.g].m_requirementType === 'All' && x.r.requires.length) x.r.requireAll = true;
    // what you get instead if you already own it (cosmetics): m_rewardFallback
    const fb = objs[objs[x.g].m_rewardFallback];
    if (fb) {
      const icon = spriteOf(fb.m_sprite);
      if (icon) sprites.add(icon);
      x.r.fallback = { label: CURRENCY_NAMES[fb.m_currencyType] || clean(str[fb.m_rewardName]) || fb.name,
        amount: fb.m_currencyAmount || null, coins: fb.m_currencyType === COINS || undefined, icon: icon || undefined };
    }
  }
  const tree = all.map((x) => x.r).filter(Boolean).sort((a, b) => a.row - b.row || a.col - b.col);
  if (tree.length) ev.rewards = tree;
}

// dungeon / raid rotations
// RotatingSchedule without m_periodType counts in weeks (Cenarion Festival: period 3, 21-day window).
function rotation(rot, nameOf) {
  const sc = objs[rot?.m_schedule];
  if (!sc) return null;
  const unitDays = sc.m_periodType === 'Days' ? 1 : 7;
  return { start: sc.m_referenceDateTime.replace(' ', 'T'), periodDays: (sc.m_rotationPeriod || 1) * unitDays,
    list: rot.m_list.map((g) => nameOf(objs[g], g)) };
}
const DUNGEON_NAMES = { Blackfathom: 'Blackfathom Deeps', DireMaul: 'Dire Maul', Deadmines: 'Deadmines',
  Scholomance: 'Scholomance', Gnomeregan: 'Gnomeregan' };
const dungeonData = Object.values(objs).find((o) => o.type === 'DungeonData');
const raidSettings = Object.values(objs).find((o) => o.type === 'RaidSettings');
const rotations = [];
const fam = rotation(dungeonData?.m_familyRotation, (o) => (o?.name || '').replace(/_EventTheme$/, ''));
if (fam) rotations.push({ id: 'dungeonFamily', label: 'Dungeon faction', ...fam });
const dun = rotation(dungeonData?.m_dungeonRotation, (o) => {
  const k = (o?.name || '').replace(/_DungeonSequence$/, ''); return clean(str[o?.m_name]) || DUNGEON_NAMES[k] || k; });
if (dun) rotations.push({ id: 'dungeon', label: 'Dungeon', ...dun });
const raid = rotation(raidSettings?.m_raidRotation, (o) => {
  const k = (o?.name || '').replace(/_RaidSequence$/, '');
  const type = clean(str[o?.m_raidType?.m_name]) || (k === 'MoltenCore' || k === 'Onyxia' ? 'Raid' : 'Siege');
  return { name: clean(str[o?.m_name]) || k.replace(/([a-z])([A-Z])/g, '$1 $2'), type };
});
if (raid) rotations.push({ id: 'raid', label: 'Raid / Siege', ...raid });
// income bonuses (e.g. the Basic Booster's PremiumBundleIncomeBonus: +50% coins), keyed by save id.
// The save lists the ones a player owns in StoreState f23.f3.
const incomeBonuses = Object.fromEntries(Object.values(objs).filter((o) => o.type === 'IncomeBonus').map((o) => [saveIdOf(o.guid), {
  coinsPercent: o.m_bonusStoreCurrencyPercent || 0,
}]));
writeFileSync(join(WORK, 'event_reward_sprites.json'), JSON.stringify([...sprites].sort(), null, 1) + '\n');
// currency letter -> save-data id, to show the player's ticket balance
const currencies = Object.fromEntries(Object.entries(CUR).map(([guid, k]) => [k, saveIdOf(guid)]));
// save-data id -> in-game English name of every other currency (the A/B/C slots are named after the event using them)
const currencyNames = Object.fromEntries(Object.values(objs)
  .filter((o) => /CurrencyType$/.test(o.type) && !CUR[o.guid] && clean(str[o.m_displayName]))
  .map((o) => [saveIdOf(o.guid), clean(str[o.m_displayName])])
  .sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT, JSON.stringify({
  note: 'Built from the game files. Times in UTC.', currencies, currencyNames, incomeBonuses, rotations, events }, null, 2) + '\n');
console.log(events.length, 'events ->', OUT);
for (const e of events) console.log(e.schedule.kind.padEnd(10), e.id.padEnd(42), '|', e.name, '|', e.currency);
