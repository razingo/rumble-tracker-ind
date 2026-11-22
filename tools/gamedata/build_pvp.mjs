// Build gamedata/pvp.json: PvP seasons (dates, maps, modifier rotation, Victory Road, season-end rewards), ranks,
// modifiers and the honor / Victory Point rules, from the game's bundles. Writes the sprites it needs to
// pvp_sprites.json (rank frames, modifier icons -> gamedata/pvp) and pvp_reward_sprites.json (-> gamedata/rewards).
// usage: node build_pvp.mjs [out.json]
// Seasons: PvpSettingsData.m_seasons = RotatingSchedule (one season per period, 6 weeks) over m_list in order; each
// PvpSeason's m_compositions = its own RotatingSchedule (3 days) over sets of modifiers, starting with the season.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './unityfs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RUMBLE_GAMEDATA || join(HERE, '..', '..', 'gamedata'); // the game data being built
const WORK = process.env.RUMBLE_WORK || HERE; // working files passed between the steps
const OUT = process.argv[2] || join(DATA, 'pvp.json');
const DIR = process.env.RUMBLE_BUNDLES;
const all = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name);
  if (e.isDirectory()) walk(p); else if (p.endsWith('.bundle')) all.push(p); } };
walk(DIR);
const base = (p) => p.split(/[\\/]/).pop();

/** The JSON object starting at text[i] ('{'), up to its matching brace (string-aware), or null. */
function balanced(text, i) {
  let depth = 0, inStr = false;
  for (let j = i; j < text.length && j < i + 2e6; j++) {
    const c = text[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return null;
}

const objs = {};
const loaded = new Set();
function load(test) {
  for (const p of all) {
    if (loaded.has(p) || !test(base(p))) continue;
    loaded.add(p);
    let b; try { b = readBundle(p); } catch { continue; }
    for (const f of b.files) {
      if (f.data.length > 2e8) continue;
      const t = f.data.toString('utf8');
      for (const m of t.matchAll(/\{\s*"\$type": "Gryphon\.Data\.([\w.]+)/g)) {
        const json = balanced(t, m.index);
        if (!json) continue;
        try { const o = JSON.parse(json); if (o.guid) objs[o.guid] = { type: m[1], ...o }; } catch { /* not plain JSON */ }
      }
    }
  }
}
// PvP data, its strings (mutator_pvp*, earlyloadgamedata: patch notes and season names), schedules, currencies
load((b) => /^(feature_pvp|mutator_pvp|strtable_|earlyloadgamedata\.bundle|data_currencytype|gryphongame\.bundle|store\.bundle)/.test(b));
// rewards defined elsewhere (troop choices, cores, tomes): their bundles from the GUID index
const index = JSON.parse(readFileSync(join(WORK, 'guid_index.json'), 'utf8'));
const settings = Object.values(objs).find((o) => o.type === 'PvpSettingsData');
if (!settings) throw new Error('PvpSettingsData not found');
const seasonObjs = settings.m_seasons.m_list.map((g) => objs[g]);
const rewardRefs = new Set(seasonObjs.filter(Boolean).flatMap((s) => [
  ...(s.m_participationRewards || []).flatMap((p) => (p.m_rewardMilestones || []).map((m) => m.m_reward)),
  ...(s.m_placementRewards || []).flatMap((p) => p.m_rewards || []),
]));
const extra = new Set([...rewardRefs].filter((g) => !objs[g] && index[g]).map((g) => index[g].bundle));
load((b) => extra.has(b));

// English strings: tables say which container holds each locale
const enUS = new Set();
for (const o of Object.values(objs)) if (o.type === 'L10N.UserFacingStringTable') for (const l of o.Locales
  || []) if (l.LocaleId === 'enUS') enUS.add(l.LocalizedTable);
const str = {};
for (const o of Object.values(objs)) if (o.type === 'L10N.UserFacingStringContainer'
  && (enUS.has(o.guid) || /enUS$/.test(o.name))) for (const d of o.Data || []) str[d.Id] ??= d.Value;
const clean = (s) => s?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;
const PERM = [8, 9, 10, 11, 12, 13, 14, 15, 4, 5, 6, 7, 0, 1, 2, 3, 30, 31, 28, 29, 26, 27, 24, 25, 22, 23, 20, 21, 18, 19, 16, 17];
const saveIdOf = (guid) => { const id = []; PERM.forEach((p, i) => { id[p] = guid[i]; }); return id.join(''); };
const spriteOf = (ref) => (ref ? String(ref).split(',')[1] || null : null);
const pretty = (n) => String(n || '').replace(/^(PVP_Ranked_|PVP_|PvpModifier_|PvpMap_)/, '').replace(/_Reward$/,
  '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
const iso = (s) => new Date(`${String(s).replace(' ', 'T').replace(/Z?$/, 'Z')}`).toISOString();

// rewards
const rewardSprites = new Set();
function reward(g) {
  const r = objs[g];
  if (!r) return { label: pretty(index[g]?.name || g) };
  const out = { label: (clean(str[r.m_rewardName]) || pretty(r.name)).replace(/!?\s*\+\d+$/, '').replace(/!$/, '') };
  const tome = /(Modest|Major|Mega|Mythic)(?:StarPoint)?Tome(?:_(?!x\d)([A-Za-z]+))?/.exec(r.name || '');
  // "_x5" in the name = how many (the amount fields are the number of options for choices)
  const count = /_x(\d+)(?:_|$)/.exec(r.name || '');
  let icon = spriteOf(r.m_sprite);
  if (r.type === 'RewardSet' || /StarPointTome/.test(r.name)) { out.kind = 'tome'; }
  else if (r.m_grantType === 'Tome' || tome) {
    out.kind = 'tome';
    if (!icon && tome) icon = `Shared_Tex_Tome${tome[1]}_${tome[2] && !/^Generic$/.test(tome[2]) ? tome[2] : 'Generic'}`;
    if (count) out.amount = Number(count[1]);
  } else if (r.m_grantType === 'ItemChoice' || /Choice/.test(r.name)) {
    out.kind = 'choice';
    out.amount = count ? Number(count[1]) : 1;
    if (r.m_numberOfSelections) out.options = r.m_numberOfSelections;
  } else if (r.m_currencyType && r.m_currencyAmount) {
    out.kind = 'currency';
    out.amount = r.m_currencyAmount;
    out.currency = saveIdOf(r.m_currencyType);
  } else if (r.m_grantType) out.kind = r.m_grantType.toLowerCase();
  if (icon) { out.icon = icon; rewardSprites.add(icon); }
  return out;
}

// ranks
const frameSprites = new Set();
const ranks = settings.m_ranks.map((g) => objs[g]).filter(Boolean).map((r) => {
  const frame = spriteOf(r.m_portraitFrame);
  if (frame) frameSprites.add(frame);
  return {
    id: r.name,
    name: clean(str[r.m_name]) || pretty(r.name),
    from: r.m_honorBandBegin ?? 0,
    to: r.m_honorBandEnd ?? null,
    frame: frame || undefined,
  };
}).sort((a, b) => a.from - b.from);
const rankName = (g) => ranks.find((r) => r.id === objs[g]?.name)?.name || clean(str[objs[g]?.m_name]) || pretty(objs[g]?.name);
// Victory Road sections are labeled with each rank's "participation level" name
const sectionName = (g) => clean(str[objs[g]?.m_participationLevel?.m_name]) || rankName(g);

// modifiers and maps
const modifiers = {};
const modifierSprites = new Set();
for (const o of Object.values(objs)) {
  if (o.type !== 'PvpModifier') continue;
  const icon = spriteOf(o.m_icon);
  if (icon) modifierSprites.add(icon);
  modifiers[o.name] = { name: clean(str[o.m_name]) || pretty(o.name),
    description: clean(str[o.m_description]) || undefined, icon: icon || undefined };
}
const mapName = (g) => clean(str[objs[g]?.m_name]) || pretty(objs[g]?.name);

// seasons
const sched = objs[settings.m_seasons.m_schedule];
// m_rotationPeriod in weeks unless m_periodType says otherwise (checked: Season_27's own schedule starts on its slot)
const unitDays = (s) => ({ Days: 1, Weeks: 7 }[s.m_periodType || 'Weeks']);
const seasonStart0 = Date.parse(iso(sched.m_referenceDateTime));
const seasonDays = sched.m_rotationPeriod * unitDays(sched);
const DAY = 86400000;
const now = Date.now();
const seasons = [];
settings.m_seasons.m_list.forEach((g, i) => {
  const s = objs[g];
  if (!s) return;
  const start = seasonStart0 + i * seasonDays * DAY;
  const end = start + seasonDays * DAY;
  if (end < now - seasonDays * DAY) return; // the previous season and later
  const rot = objs[s.m_compositions?.m_schedule];
  const rotStart = rot ? Date.parse(iso(rot.m_referenceDateTime)) : start;
  const at = (t) => new Date(t).toISOString();
  if (rot && rotStart !== start) console.warn(`${s.name}: rotation starts ${at(rotStart)}, season slot ${at(start)}`);
  seasons.push({
    id: s.name,
    saveId: saveIdOf(s.guid),
    number: s.m_seasonNumber ?? null,
    name: (clean(str[s.m_name]) || 'PvP Season {0}').replace('{0}', s.m_seasonNumber ?? ''),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    maps: (s.m_maps || []).map(mapName),
    rotation: rot ? {
      start: new Date(rotStart).toISOString(),
      periodDays: rot.m_rotationPeriod * unitDays(rot),
      sets: (s.m_compositions.m_list || []).map((c) => (c.m_modifiers || []).map((m) => objs[m]?.name).filter(Boolean)),
    } : null,
    victoryRoad: (s.m_participationRewards || []).flatMap((p) => (p.m_rewardMilestones || []).map((m) => ({
      vp: m.m_honor, section: sectionName(p.m_rank), reward: reward(m.m_reward),
    }))).sort((a, b) => a.vp - b.vp),
    endRewards: (s.m_placementRewards || []).map((p) => ({
      rank: (p.m_ranks || []).map((r) => objs[r]?.name).filter(Boolean)[0] || null,
      top: p.m_ranking > 0 ? p.m_ranking : undefined,
      rewards: (p.m_rewards || []).map(reward),
    })),
  });
});

const num = (v) => (v == null ? undefined : Number(v));
const out = {
  generated: new Date().toISOString().slice(0, 10),
  note: 'Built from the game files. Times in UTC.',
  seasonDays,
  ranks,
  modifiers,
  // Victory Points per finished match: base x win/loss multiplier, x streak multiplier for the win streak's band
  victoryPoints: {
    base: settings.m_pvpBaseParticipationPoints,
    win: num(settings.m_pvpWinParticipationMultiplier),
    loss: num(settings.m_pvpLossParticipationMultiplier),
    streak: (settings.m_pvpWinStreakParticipationMultipliers
      || []).map((b) => ({ upTo: b.m_maxWinStreak, x: num(b.m_winStreakMultiplier) ?? 1 })),
  },
  honor: {
    maxGain: settings.m_maxHonorGain, maxLoss: settings.m_maxHonorLoss, floors: settings.m_honorFloors,
    seasonReset: { ceiling: settings.m_seasonalHonorResetData?.m_honorCeiling,
      floor: settings.m_seasonalHonorResetData?.m_playerHonorFloor },
  },
  seasons,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
writeFileSync(join(WORK, 'pvp_sprites.json'), JSON.stringify([...frameSprites, ...modifierSprites].sort(), null, 1) + '\n');
writeFileSync(join(WORK, 'pvp_reward_sprites.json'), JSON.stringify([...rewardSprites].sort(), null, 1) + '\n');
console.log(`${seasons.length} seasons, ${ranks.length} ranks, ${Object.keys(modifiers).length} modifiers -> ${OUT}`);
for (const s of seasons) console.log(s.id, s.start.slice(0, 10), s.end.slice(0, 10), s.rotation?.sets.length ?? 0,
  'sets', s.victoryRoad.length, 'milestones', s.endRewards.length, 'end rewards');
