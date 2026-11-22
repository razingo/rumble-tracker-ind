// The page's calculations (web/scripts): schedules, mini and army rules, PvP records and win rates. These modules
// have no DOM, so they run here as they do in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, rotationAt, rotationName } from '../web/scripts/lib/schedule.js';
import { DAY, HOUR, MINUTE } from '../web/scripts/lib/constants.js';
import { fmt, esc, span, spanWords, ago, localDay, when, dayOnly, titleCase, plural, megabytes } from '../web/scripts/lib/format.js';
import { seasonAt, rankOf, nextRank, setAt, record, streak, matchesWithMods, modifierStats, withModifiers,
  winRateSeries } from '../web/scripts/lib/pvp-season.js';
import { setTables, setState, getJson, post } from '../web/scripts/core.js';
import { nextUpgrade, xpToMax, armyOf, totalLevel, armyTotals, remainingToLegendary, effectivePicks,
  unitName, gridRarityOf, familiesOf } from '../web/scripts/units.js';

test('schedules handle the n-th weekday of a month, fixed days and one-off events', () => {
  // 2nd Wednesday of every month, 18:00 UTC, 7 days
  const ev = { schedule: { kind: 'nthWeekday', every: 'month', nth: 2, weekday: 3, hourUtc: 18, days: 7, fromYear: 2026, month: 1 } };
  const runs = occurrences(ev, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31));
  assert.deepEqual(runs.map((r) => new Date(r.start).toISOString()), ['2026-11-11T18:00:00.000Z', '2026-12-09T18:00:00.000Z']);
  assert.equal(runs[0].end - runs[0].start, 7 * DAY);
  const yearly = { schedule: { kind: 'day', every: 'year', month: 12, day: 15, hourUtc: 10, days: 3, fromYear: 2025 } };
  assert.equal(occurrences(yearly, Date.UTC(2026, 11, 16), Date.UTC(2026, 11, 17)).length, 1); // still running
  const once = { schedule: { kind: 'once', start: '2026-05-01T00:00:00Z', end: '2026-05-03T00:00:00Z' } };
  assert.equal(occurrences(once, Date.UTC(2026, 4, 2), Date.UTC(2026, 4, 2, 1)).length, 1);
  assert.equal(occurrences(once, Date.UTC(2026, 4, 4), Date.UTC(2026, 4, 5)).length, 0);
  const until = { schedule: { ...ev.schedule, until: '2026-11-30' } };
  assert.equal(occurrences(until, Date.UTC(2026, 11, 1), Date.UTC(2026, 11, 31)).length, 0);
});

test('rotations wrap around and work before their start', () => {
  const rot = { start: '2026-01-01T00:00:00Z', periodDays: 7, list: ['A', { name: 'B', type: 'Siege' }, 'C'] };
  assert.equal(rotationAt(rot, Date.UTC(2026, 0, 3)).item, 'A');
  assert.equal(rotationName(rotationAt(rot, Date.UTC(2026, 0, 9)).item), 'B Siege');
  assert.equal(rotationAt(rot, Date.UTC(2026, 0, 22)).item, 'A');
  assert.equal(rotationAt(rot, Date.UTC(2025, 11, 30)).item, 'C');
});

const PVP = {
  seasons: [{ id: 's1', saveId: 'x', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z',
    rotation: { start: '2026-01-01T00:00:00Z', periodDays: 3, sets: [['m1', 'm2'], ['m2', 'm3']] } }],
  ranks: [{ id: 'r0', from: 0 }, { id: 'r1', from: 1000 }, { id: 'r2', from: 2000 }],
};
const at = (day) => new Date(Date.UTC(2026, 0, day, 12)).toISOString();

test('finds the PvP season, rank and modifiers at a given time', () => {
  assert.equal(seasonAt(PVP, Date.UTC(2026, 0, 5)).id, 's1');
  assert.equal(seasonAt(PVP, Date.UTC(2026, 1, 5)), null);
  assert.equal(rankOf(PVP, 1500).id, 'r1');
  assert.equal(nextRank(PVP, rankOf(PVP, 1500)).id, 'r2');
  assert.equal(nextRank(PVP, rankOf(PVP, 2500)), null);
  assert.deepEqual(setAt(PVP, Date.UTC(2026, 0, 2)).mods, ['m1', 'm2']);
  assert.deepEqual(setAt(PVP, Date.UTC(2026, 0, 5)).mods, ['m2', 'm3']);
  assert.deepEqual(setAt(PVP, Date.UTC(2026, 0, 8)).mods, ['m1', 'm2']);
  assert.equal(setAt(PVP, Date.UTC(2026, 1, 5)), null);
});

test('counts PvP records, streaks and win rates by modifier', () => {
  const log = [
    { t: at(1), start: true },
    { t: at(2), wins: 1, losses: 0 },               // m1 m2
    { t: at(2), wins: 0, losses: 1, estimated: true },
    { t: at(5), wins: 1, losses: 0 },               // m2 m3
    { t: at(5), unexplained: true },                 // not a match until marked
    { t: at(6), wins: 2, losses: 0 },
  ];
  assert.deepEqual(record(log), { wins: 4, losses: 1, estimated: true, honorOnly: false });
  assert.deepEqual(record(log, Date.UTC(2026, 0, 4)).wins, 3);
  assert.deepEqual(streak(log), { kind: 'win', n: 3 });
  const matches = matchesWithMods(PVP, log);
  assert.equal(matches.length, 4);
  assert.deepEqual(modifierStats(matches), { m1: { wins: 1, losses: 1 }, m2: { wins: 4, losses: 1 }, m3: { wins: 3, losses: 0 } });
  assert.equal(withModifiers(matches, ['m1']).length, 2);
  assert.equal(withModifiers(matches, ['m1', 'm3']).length, 0);
  assert.equal(withModifiers(matches, []).length, 4);
  const series = winRateSeries(withModifiers(matches, ['m2']));
  assert.deepEqual(series.map((p) => p.rate), [1, 0.5, 2 / 3, 0.8]);
});

const RULES = {
  rarities: [{ name: 'Common' }, { name: 'Rare' }, { name: 'Epic' }],
  rarityUpgrade: [{ stars: 5, arcEnergy: 100 }, { stars: 10, arcEnergy: 300, core: 'epicCore' }],
  talentSlotsByRarity: [1, 2, 3],
  xpToNext: { 1: 10, 2: 20, 3: 40 }, maxXpLevel: 4,
  currencyIds: { arcEnergy: 'arc', epicCore: 'core' },
  armySlots: { count: 7, leaderSlot: 0, boostSlot: 6, diamondValorCost: 50,
    tiers: [{ bonus: 0 }, { bonus: 1 }, { bonus: 2 }, { bonus: 3 }] },
};
const MINIS = { minis: [
  { slug: 'boss', name: 'Boss', category: 'Leader', talents: [{}, {}, {}],
    fixedArmySlots: ['Melee', 'Ranged', 'Wildcard'], armySlotUpgrades: ['Tank', 'Flying', 'Spell'] },
  { slug: 'grunt', name: 'Grunt', category: 'Unit', talents: [{}, {}, {}] },
] };
setTables(RULES, MINIS);
const unit = (o) => ({ id: 'abcdef0123456789', slug: 'grunt', level: 5, rarity: 0, stars: 0, talents: 0,
  talentPicks: [], xp: 0, xpNeeded: 10, xpLevel: 1, ...o });

test('rarity upgrades need stars, Arc Energy and cores', () => {
  setState({ currencies: [{ id: 'arc', balance: 150 }] });
  assert.equal(nextUpgrade(unit({ stars: 5 })).ready, true);
  assert.equal(nextUpgrade(unit({ stars: 4 })).starsOk, false);
  const rare = nextUpgrade(unit({ rarity: 1, stars: 10 }));
  assert.deepEqual([rare.arcOk, rare.coreOk, rare.ready], [false, false, false]);
  assert.equal(nextUpgrade(unit({ rarity: 2 })), null);
  assert.equal(nextUpgrade(unit({ synthetic: true })), null);
  assert.deepEqual(remainingToLegendary(unit({ stars: 3 })), { arcEnergy: 400, stars: 12, cores: { epicCore: 1 } });
});

test('XP to the top level, talents, names', () => {
  assert.equal(xpToMax(unit({ xpLevel: 1, xp: 4, xpNeeded: 10 })), 6 + 20 + 40);
  assert.equal(xpToMax(unit({ xpLevel: 4 })), 0);
  assert.deepEqual(effectivePicks(unit({ talents: 3, talentPicks: [1] })), [0, 1, 2]); // all unlocked: all count
  assert.deepEqual(effectivePicks(unit({ talents: 1, talentPicks: [1] })), [1]);
  assert.equal(unitName(unit({ slug: null })), 'New mini abcdef01');
});

test('leader army slots follow the fixed slots, bottom-row rules, Boost and level bonus', () => {
  const leader = unit({ slug: 'boss', level: 10, army: [
    { type: 'Leader', tier: 2 }, { type: 'Spell', tier: 3 }, { type: 'x', tier: 1 }, { type: 'Spell' },
    { type: 'Wildcard', tier: 1 }, { type: 'Tank', tier: 3 }, { type: 'Tank', tier: 3, boost: true },
  ] });
  const slots = armyOf(leader);
  assert.deepEqual(slots.map((s) => s.type), ['Leader', 'Melee', 'Ranged', 'Wildcard', '', 'Tank', '']);
  assert.equal(slots[1].tier, 3); // the tier is kept, the locked type wins
  assert.equal(slots[6].boost, true);
  assert.equal(totalLevel(leader), 12); // Leader slot at tier 2: +2
  assert.equal(totalLevel(unit({ level: 10 })), 10);
  const t = armyTotals([leader, unit()]);
  assert.deepEqual([t.leaders, t.slots, t.diamonds, t.goldReady], [1, 7, 3, 1]);
});

test('formats numbers, dates, durations and day keys in en-US', () => {
  assert.equal(fmt(1234567), '1,234,567');
  assert.equal(fmt('x'), 'x');
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(span(2 * DAY + 3 * HOUR), '2d 3h');
  assert.equal(span(4 * HOUR + 12 * MINUTE), '4h 12m');
  assert.equal(span(-5), '0m');
  assert.equal(spanWords(3 * DAY), '3 days');
  assert.equal(spanWords(5 * HOUR), '5 hours');
  assert.equal(spanWords(HOUR), '1 hour');
  assert.equal(spanWords(20 * MINUTE), '20 minutes');
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.match(when(new Date(2026, 10, 19, 19, 0)), /^Thu, Nov 19, 7:00\sPM$/);
  assert.equal(dayOnly(new Date(2026, 10, 19)), 'Nov 19');
  assert.equal(titleCase('MAJOR TOME'), 'Major Tome');
  assert.equal(titleCase('Major tome'), 'Major tome');
  assert.equal(plural(1, 'mini'), '1 mini');
  assert.equal(plural(1200, 'army', 'armies'), '1,200 armies');
  assert.equal(megabytes(3 * 1024 * 1024), '3.0');
  assert.equal(ago(Date.now() - 100), 'just now');
  assert.equal(ago(Date.now() - 5 * 1000), '5 seconds ago');
  assert.equal(ago(Date.now() - MINUTE), '1 minute ago');
  assert.equal(ago(Date.now() - 3 * HOUR), '3 hours ago');
  assert.equal(ago(null), 'never');
});

test('cleans tags, keeps them unique ignoring case and keeps the known spelling', async () => {
  const { cleanTag, cleanTags, withTag, LIMITS } = await import('../web/scripts/lib/limits.js');
  assert.equal(cleanTag('  rush   down '), 'rush down');
  assert.equal(cleanTag('x'.repeat(50)).length, LIMITS.tag);
  assert.deepEqual(cleanTags(['Rush', 'rush', ' ', 'Tank']), ['Rush', 'Tank']);
  assert.equal(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, LIMITS.tagsPerArmy);
  assert.deepEqual(withTag(['Tank'], 'rush', ['Rush']), ['Tank', 'Rush']);
  assert.equal(withTag(['Tank'], 'tank'), null);
  assert.equal(withTag(['Tank'], '  '), null);
  assert.equal(withTag(Array.from({ length: 20 }, (_, i) => `t${i}`), 'new'), null);
});

test('a tag box adds a tag on Enter or a comma and removes the last on Backspace', async () => {
  const { tagKey } = await import('../web/scripts/lib/limits.js');
  const key = (k, value) => ({ key: k, target: { value }, preventDefault() { this.prevented = true; } });
  const enter = key('Enter', ' rush ');
  assert.deepEqual(tagKey(enter, ['Tank'], ['Rush']), ['Tank', 'Rush']);
  assert.equal(enter.prevented, true);
  assert.equal(enter.target.value, '');
  assert.equal(tagKey(key(',', 'tank'), ['Tank'], []), null);
  assert.deepEqual(tagKey(key('Backspace', ''), ['Tank', 'Rush'], []), ['Tank']);
  assert.equal(tagKey(key('Backspace', 'r'), ['Tank'], []), null);
  assert.equal(tagKey(key('a', ''), ['Tank'], []), null);
});

test('the reward tree finds the cheapest path and pays shared requirements once', async () => {
  const { rewardPlanner, rewardKey } = await import('../web/scripts/lib/reward-tree.js');
  //   row 0:  A(10)        B(5)
  //   row 1:  C(20, needs A or B)   D(30, needs A and B)
  //   row 2:  E(1, needs C)
  const tree = [
    { row: 0, col: 0, cost: 10 }, { row: 0, col: 1, cost: 5 },
    { row: 1, col: 0, cost: 20, requires: ['0-0', '0-1'] }, { row: 1, col: 1, cost: 30, requires: ['0-0', '0-1'], requireAll: true },
    { row: 2, col: 0, cost: 1, requires: ['1-0'] },
  ];
  const p = rewardPlanner(tree);
  assert.deepEqual(p.order.map(rewardKey), ['0-0', '0-1', '1-0', '1-1', '2-0']);
  assert.deepEqual(p.cheapest(['2-0']), { cost: 26, take: ['2-0', '1-0', '0-1'] }); // through B, the cheaper one
  assert.equal(p.cheapest(['1-1']).cost, 45); // needs both A and B
  assert.equal(p.cheapest(['2-0', '1-1']).cost, 66); // A and B paid once
  assert.equal(p.cheapest([]).cost, 0);
});

test('a G.R.I.D. slot\'s rarity comes from its store name and the rules', () => {
  setTables(RULES, { minis: [] });
  assert.deepEqual(gridRarityOf('EpicRarity_Leader'), { index: 2, label: 'Epic leader' });
  assert.deepEqual(gridRarityOf('CommonRarity_Troop'), { index: 0, label: 'Common' });
  assert.deepEqual(gridRarityOf('MythicRarity_Troop'), { index: -1, label: 'Mythic' });
  assert.deepEqual(gridRarityOf(undefined), { index: -1, label: '' });
});

test('requests turn failures into messages the page can show', async () => {
  const realFetch = globalThis.fetch;
  const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  try {
    globalThis.fetch = answer(200, { ok: 1 });
    assert.deepEqual(await getJson('/x', 'the thing'), { ok: 1 });
    globalThis.fetch = answer(404, 'nope');
    await assert.rejects(getJson('/x', 'the thing'), (e) => e.status === 404 && /Could not load the thing \(HTTP 404\)/.test(e.message));
    globalThis.fetch = answer(400, { error: 'That name is too long.' });
    await assert.rejects(post('/x', {}), /That name is too long\./);
    globalThis.fetch = answer(200, 'not json');
    await assert.rejects(getJson('/x', 'the thing'), /isn't valid JSON/);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(post('/x', {}), /The tracker isn't responding/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an army code reads back as the army it was made from', async () => {
  const { encodeArmyCode, decodeArmyCode } = await import('../web/scripts/army-code.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ prefix: 'rumblo:', shortIds: { 5: 'lead', 300: 'a', 7: 'b' } }));
  try {
    setTables(RULES, { minis: [{ slug: 'lead', talents: [{}, {}] }, { slug: 'a', talents: [{}] }, { slug: 'b', talents: [] }] });
    setState({ units: [] });
    const army = { leader: 'lead', minis: ['a', null, 'b', null, null, null], talents: { lead: 1 } };
    const code = await encodeArmyCode(army);
    assert.match(code, /^rumblo:/);
    assert.deepEqual(await decodeArmyCode(code), { leader: 'lead', minis: ['a', 'b', null, null, null, null],
      talents: { lead: 1, a: 0, b: 0 } });
    await assert.rejects(decodeArmyCode('rumblo:!!!'), /Not a Warcraft Rumble army code/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a dual-faction mini has both families from the game data, others their one family', () => {
  assert.deepEqual(familiesOf({ family: 'Beast', families: ['Beast', 'Undead'] }), ['Beast', 'Undead']);
  // fixed army slots no longer count: the game data names a dual faction itself
  assert.deepEqual(familiesOf({ family: 'Horde', category: 'Leader', fixedArmySlots: ['Horde', 'Alliance', 'Melee'] }), ['Horde']);
  assert.deepEqual(familiesOf({ family: 'Undead', category: 'Unit' }), ['Undead']);
});
