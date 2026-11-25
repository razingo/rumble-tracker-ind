// Build gamedata/minis.json from the game's files only: names, descriptions, cost, faction, role, damage type,
// traits, talents, leader abilities, stats per level and portrait/icon sprite names (extracted by
// extract_reward_icons.py). usage: node build_minis.mjs
//
// Which minis: every entry of gamedata/unit_ids.json (save id -> slug; the slug is the tracker's key), and the minis
// the game lists for army codes that are not in it yet: those get their key from their name, and are written back
// to unit_ids.json. The code numbers and the code's prefix go to army_code_minis.json.
// Kept from the current minis.json: fixedArmySlots / armySlotUpgrades (army_boards.mjs), alwaysOwned and, for a mini
// of two factions, which of them it is filed under (family).
// Talent order: the order the tracker has always stored picks in (army_code_minis.json talentOrder maps the game's
// order onto it), so saved talent picks and armies stay valid.
// Stats: each StatData with a growth type grows x1.1001 per level, rounded (the game's displayed values); level 1..31.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFiles, saveIdOf, guidOfSaveId } from './unityfs.mjs';
import { dataObjects, englishStrings, slugOf } from './game_objects.mjs';
import { FACTIONS } from './factions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RUMBLE_GAMEDATA || join(HERE, '..', '..', 'gamedata'); // the game data being built
const WORK = process.env.RUMBLE_WORK || HERE; // working files passed between the steps
const OUT = join(DATA, 'minis.json');
const DIR = process.env.RUMBLE_BUNDLES;
const BUNDLES = /^(unitdata_|talentdata_|shared_|gryphongame_embedded|support_progression\.bundle|strtable_)/;
const GROWTH = 1.1001, LEVELS = 31;
// Leader portraits are tall banners (Portrait_Leader_X): the card art is a square starting this far down (fraction of
// the height; 0.10 unless listed), 1.3x the banner's width so the face isn't cropped too tight. Checked by eye on a
// contact sheet of all 24; a new leader may need an entry.
const LEADER_FACE = { Onu: 0.20, Ysera: 0.21, Anubarak: 0.17, OldMurkEye: 0.23, Hogger: 0.14, Charlga: 0.15, Drakkisath: 0.13 };

const files = bundleFiles(DIR, (n) => BUNDLES.test(n));
const objs = dataObjects(files);
const str = englishStrings(objs);
log(`${files.length} bundles, ${Object.keys(objs).length} objects, ${Object.keys(str).length} English strings`);

function log(...a) { console.log(...a); }
const sprite = (ref) => (ref ? String(ref).split(',')[1] || null : null);
// game rich text -> plain text: <sprite ... name="Stun"> becomes nothing (the word follows), tags dropped
const text = (id) => {
  const s = str[id];
  if (s == null) return null;
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<sprite[^>]*>/gi, '').replace(/<[^>]+>/g, '').replace(/[ \t]+/g,
    ' ').replace(/ *\n */g, '\n').trim();
};
const shortName = (o, suffix) => (o?.name || '').replace(new RegExp(`_?${suffix}$`), '');
// a Family object's faction as the tracker names it (the object is named Family<faction>), or nothing
const factionOf = (f) => FACTIONS[(f?.name || '').replace(/^Family/, '')];
const DMG = { Squad: 'Squad', AOE: 'AOE', AoE: 'AOE', OneTarget: 'OneTarget', Single: 'OneTarget' };
const num = (v) => (v == null ? null : typeof v === 'number' ? v : typeof v === 'string'
  ? parseFloat(v) : typeof v === 'object' && 'm_value' in v ? num(v.m_value) : null);

/** Value of a numeric stat source at level 1. */
const unknownSources = new Set();
function evalSource(g, depth = 0) {
  const s = objs[g];
  if (!s || depth > 6) return null;
  switch (s.type) {
    case 'NumericDataSourceAssetField': {
      const a = objs[s.m_assetFieldReference?.m_asset];
      return a ? num(a[s.m_assetFieldReference.m_field]) : null;
    }
    case 'NumericDataSourceCombine': {
      const vals = (s.m_combineData?.m_dataToCombine || []).map((x) => evalSource(x, depth + 1));
      if (vals.some((v) => v == null)) return null;
      const op = s.m_combineData?.m_operation || 'Add';
      return vals.reduce((x, y) => (op === 'Div' ? x / y : op === 'Mul' ? x * y : op === 'Sub' ? x - y : op === 'Max'
        ? Math.max(x, y) : op === 'Min' ? Math.min(x, y) : x + y));
    }
    case 'NumericDataSourceCombineAssetFields': {
      const vals = (s.m_combineData?.m_dataToCombine || []).map((r) => { const a = objs[r.m_asset]; return a ? num(a[r.m_field]) : null; });
      if (!vals.length || vals.some((v) => v == null)) return null;
      const op = s.m_combineData?.m_operation || 'Add';
      return vals.reduce((x, y) => (op === 'Div' ? x / y : op === 'Mul' ? x * y : op === 'Sub' ? x - y : op === 'Max'
        ? Math.max(x, y) : op === 'Min' ? Math.min(x, y) : x + y));
    }
    case 'NumericDataSourceConstant': case 'NumericDataSource': return num(s.m_value ?? s.m_data);
    default:
      if ('m_value' in s) return num(s.m_value);
      unknownSources.add(s.type);
      return null;
  }
}

function statsOf(collection) {
  const out = {};
  for (const src of collection?.m_numericStatSources || []) {
    const sd = objs[src.m_stat];
    const v = evalSource(src.m_dataSource);
    if (!sd || v == null) continue;
    const label = text(sd.m_displayNameRef) || sd.m_type;
    const round = (x) => (sd.m_displayAsInt ? Math.round(x) : Math.round(x * 100) / 100);
    out[label] = sd.m_statGrowthType ? Array.from({ length: LEVELS }, (_, i) => round(v * GROWTH ** i)) : round(v);
  }
  for (const src of collection?.m_userFacingStringStatSources || []) {
    const sd = objs[src.m_stat];
    const ds = objs[src.m_dataSource];
    const value = text(ds?.m_data?.m_value);
    if (!sd || !value) continue;
    out[text(sd.m_displayNameRef) || sd.m_type] = value;
  }
  return out;
}

// build
const idsFile = join(DATA, 'unit_ids.json'), codesFile = join(DATA, 'army_code_minis.json');
const ids = JSON.parse(readFileSync(idsFile, 'utf8'));
const unitIds = ids.units; // save id -> slug
// The game's list of the minis an army code can name (their code numbers). A mini on it that the tracker has no key
// for yet is new: it gets one from its name. Entries without a definition (not released yet) and second forms of a
// mini that is known already (they carry its name) are passed over.
const army = Object.values(objs).find((o) => o.type === 'ArmyManagerSettings');
if (!army?.m_shortIds?.length) throw new Error("The game's list of minis for army codes was not found");
const nameOf = (guid) => (objs[guid]?.type === 'Mini' ? text(objs[guid].m_collectionNameRef) : null);
const names = new Set(Object.keys(unitIds).map((id) => nameOf(guidOfSaveId(id))).filter(Boolean));
const slugs = new Set(Object.values(unitIds));
const added = [];
for (const { m_miniGuid: guid } of army.m_shortIds) {
  const id = saveIdOf(guid), name = nameOf(guid), slug = slugOf(name);
  if (unitIds[id] || !slug || names.has(name) || slugs.has(slug)) continue;
  unitIds[id] = slug;
  names.add(name);
  slugs.add(slug);
  added.push(slug);
}
if (added.length) {
  writeFileSync(idsFile, JSON.stringify(ids, null, 1) + '\n');
  log(`new in the game: ${added.join(', ')}`);
}
const codes = JSON.parse(readFileSync(codesFile, 'utf8'));
writeFileSync(codesFile, JSON.stringify({ ...codes, prefix: army.m_loadoutCodePrefix || 'rumblo:',
  shortIds: Object.fromEntries(army.m_shortIds.filter((x) => unitIds[saveIdOf(x.m_miniGuid)])
    .map((x) => [x.m_shortId, unitIds[saveIdOf(x.m_miniGuid)]])) }, null, 1) + '\n');
const old = JSON.parse(readFileSync(OUT, 'utf8'));
const oldBySlug = new Map(old.minis.map((m) => [m.slug, m]));
const talentOrder = codes.talentOrder || {};
const sprites = { art: new Map(), icons: new Map(), talents: new Map() }; // file name -> sprite name
const tagIcons = {};
const iconPath = (spriteName, file) => { if (!spriteName) return null; sprites.icons.set(file, spriteName); return `icons/${file}.webp`; };

const minis = [];
for (const [saveId, slug] of Object.entries(unitIds)) {
  const m = objs[guidOfSaveId(saveId)];
  if (!m || m.type !== 'Mini') { log(`no game definition for ${slug}`); continue; }
  const prev = oldBySlug.get(slug) || {};
  const category = m.m_isLeader ? 'Leader' : /Spell/.test(m.m_flags || '') ? 'Spell' : 'Unit';
  // split families (Arthas: Alliance + Undead) list their parts in m_subFamilies; the primary stays the tracker's
  // earlier choice when it is one of them (frame color), else the first part
  const famObj = objs[m.m_family];
  // (no faction is Neutral, and so is one the tracker doesn't know yet: it has no color or board for it)
  const famName = (f) => factionOf(f) || 'Neutral';
  const parts = (famObj?.m_subFamilies || []).map((g) => objs[typeof g === 'string' ? g : g?.m_family || g?.guid]).filter(Boolean);
  const families = parts.length ? parts.map(famName) : [famName(famObj)];
  const family = families.includes(prev.family) ? prev.family : families[0];
  for (const f of parts.length ? parts : [famObj]) if (factionOf(f)) tagIcons[famName(f)] ??= iconPath(sprite(f.m_icon),
    famName(f).replace(/\W/g, ''));
  const roles = (m.m_balanceRoles || []).map((g) => objs[g]).filter(Boolean);
  const role = roles.map((r) => text(r.m_displayNameRef) || text(r.m_infoNameRef) || shortName(r, 'BalanceRole')).join(',');
  for (const r of roles) { const n = text(r.m_displayNameRef) || text(r.m_infoNameRef) || shortName(r, 'BalanceRole');
    tagIcons[n] ??= iconPath(sprite(r.m_icon), n.replace(/\W/g, '')); }
  const bt = objs[m.m_balanceType];
  const damageType = DMG[shortName(bt, 'BalanceType')] || shortName(bt, 'BalanceType') || '';
  if (bt) { const n = damageType === 'AOE' ? 'AoE' : damageType; tagIcons[n] ??= iconPath(sprite(bt.m_icon), n.replace(/\W/g, '')); }
  const traits = (m.m_traits || []).map((g) => objs[g]).filter(Boolean).map((t) => {
    const name = text(t.m_displayNameRef) || shortName(t, 'Trait');
    const icon = iconPath(sprite(t.m_icon), name.replace(/\W/g, ''));
    tagIcons[name] ??= icon;
    return { name, description: text(t.m_descriptionRef) || '', icon };
  });
  const talentObjs = (m.m_availableTalents || []).map((g) => objs[g]).filter(Boolean);
  const order = talentOrder[slug];
  const talents = [];
  talentObjs.forEach((t, gi) => {
    const icon = sprite(t.m_equipStatueIcon);
    const file = icon ? icon.toLowerCase() : null;
    if (file) sprites.talents.set(file, icon);
    talents[order && Number.isInteger(order[gi]) ? order[gi] : gi] = { name: text(t.m_name) || t.name,
      description: text(t.m_description) || '', icon: file ? `talents/${file}.webp` : null };
  });
  // units/spells: the square Indicator_X_Pose; leaders: the face square of their tall Portrait_Leader_X banner (their
  // Indicator is cropped round)
  const portrait = sprite(m.m_portraitImage);
  if (portrait) {
    const who = /^Portrait_Leader_(\w+)/.exec(portrait)?.[1];
    sprites.art.set(slug, m.m_isLeader && who ? { sprite: portrait, squareTop: LEADER_FACE[who] ?? 0.10, zoomOut: 1.3 } : portrait);
  }
  // leader ability: "<b>Name</b><br>description"
  let leaderAbility;
  if (m.m_abilityDescriptionRef && str[m.m_abilityDescriptionRef]) {
    const raw = str[m.m_abilityDescriptionRef];
    const mm = /<b>(.*?)<\/b>/i.exec(raw);
    const full = text(m.m_abilityDescriptionRef);
    leaderAbility = mm ? { name: mm[1].replace(/<[^>]+>/g, '').trim(),
      description: full.replace(mm[1].replace(/<[^>]+>/g, '').trim(), '').trim() }
      : /\n/.test(full)
      ? { name: full.split('\n')[0].trim(), description: full.slice(full.indexOf('\n')).trim() }
      : { name: 'Leader ability', description: full };
  }
  const entry = {
    slug,
    name: text(m.m_collectionNameRef) || prev.name || slug,
    category,
    family,
    ...(families.length > 1 ? { families } : {}),
    role,
    cost: Number(m.m_gold) || 0,
    damageType,
    description: text(m.m_descriptionRef) || '',
    traits,
    talents: talents.filter(Boolean),
    ...(leaderAbility ? { leaderAbility } : {}),
    art: portrait ? `art/${slug}.webp` : prev.art,
    stats: statsOf(objs[m.m_stats]),
    ...(prev.fixedArmySlots ? { fixedArmySlots: prev.fixedArmySlots } : {}),
    ...(prev.armySlotUpgrades ? { armySlotUpgrades: prev.armySlotUpgrades } : {}),
    ...(prev.alwaysOwned ? { alwaysOwned: true } : {}),
  };
  minis.push(entry);
}
minis.sort((a, b) => a.name.localeCompare(b.name));

// what changed since the table that was there before
const diffs = [];
for (const m of minis) {
  const o = oldBySlug.get(m.slug);
  if (!o) { diffs.push(`${m.slug}: new`); continue; }
  for (const k of ['name', 'category', 'family', 'cost', 'damageType']) {
    if (String(o[k] ?? '') !== String(m[k] ?? '')) diffs.push(`${m.slug}.${k}: "${o[k]}" -> "${m[k]}"`);
  }
  const on = (o.talents || []).map((t) => t.name).join(' | '), nn = m.talents.map((t) => t.name).join(' | ');
  if (on !== nn) diffs.push(`${m.slug}.talents: ${on} -> ${nn}`);
  const ot = (o.traits || []).map((t) => t.name).sort().join(','), nt = m.traits.map((t) => t.name).sort().join(',');
  if (ot !== nt) diffs.push(`${m.slug}.traits: ${ot} -> ${nt}`);
}
const missing = old.minis.filter((o) => !minis.some((m) => m.slug === o.slug)).map((o) => o.slug);

writeFileSync(OUT, JSON.stringify({
  source: 'Warcraft Rumble game files. Game data © Blizzard Entertainment.',
  stats: { format: 'single value = same at all levels; array = levels 1..31 (index 0 = level 1)',
    scaling: `stats with a growth type: round(level 1 value x ${GROWTH}^(level-1))` },
  // the factions the game's minis are of, in the order the page shows their filters; Neutral comes last
  families: [...new Set(Object.values(FACTIONS)), 'Neutral']
    .filter((f) => minis.some((m) => (m.families || [m.family]).includes(f))),
  // the faction pairs that have a combined icon (icons/fam/<pair>.png), from the list those icons are read by
  familyPairs: Object.keys(JSON.parse(readFileSync(join(HERE, 'family_pair_sprites.json'), 'utf8'))).map((f) => f.replace(/\.png$/, '')),
  tagIcons: { Wildcard: 'icons/Wildcard.png', Leader: 'icons/Leader.png',
    ...Object.fromEntries(Object.entries(tagIcons).filter(([, v]) => v)),
    'Siege Damage': tagIcons.Siege || tagIcons['Siege Damage'], 'Siege Specialist': tagIcons.Siege || tagIcons['Siege Specialist'],
    Neutral: tagIcons.Miner }, // (the game has no icon for no faction: the Kobold Miner's pickaxe stands for it)
  minis,
}, null, 2) + '\n');
// sprite lists for extract_reward_icons.py (one list per output folder: file name -> sprite)
for (const [k, map] of Object.entries(sprites)) writeFileSync(join(WORK, `mini_${k}_sprites.json`),
  JSON.stringify(Object.fromEntries(map), null, 1) + '\n');
log(`${minis.length} minis -> ${OUT}`);
if (missing.length) log(`not rebuilt (kept out): ${missing.join(', ')}`);
if (unknownSources.size) log(`unknown stat sources: ${[...unknownSources].join(', ')}`);
log(`\n${diffs.length} differences from the previous minis.json:\n${diffs.map((d) => `  ${d}`).join('\n')}`);
