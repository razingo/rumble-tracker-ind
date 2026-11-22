// Build gamedata/minis.json from the game's files only: names, descriptions, cost, faction, role, damage type,
// traits, talents, leader abilities, stats per level and portrait/icon sprite names (extracted by
// extract_reward_icons.py). usage: node build_minis.mjs [--compare old.json]
//
// Which minis: every entry of gamedata/unit_ids.json (save id -> slug); the slug stays the tracker's key.
// Kept from the current minis.json: fixedArmySlots / armySlotUpgrades (army_boards.mjs) and alwaysOwned.
// Talent order: the order the tracker has always stored picks in (army_code_minis.json talentOrder maps the game's
// order onto it), so saved talent picks and armies stay valid.
// Stats: each StatData with a growth type grows x1.1001 per level, rounded (the game's displayed values); level 1..31.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './unityfs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RUMBLE_GAMEDATA || join(HERE, '..', '..', 'gamedata'); // the game data being built
const WORK = process.env.RUMBLE_WORK || HERE; // working files passed between the steps
const STATIC = DATA;
const OUT = join(STATIC, 'minis.json');
const DIR = process.env.RUMBLE_BUNDLES;
const BUNDLES = /^(unitdata_|talentdata_|shared_|gryphongame_embedded|support_progression\.bundle|strtable_)/;
const GROWTH = 1.1001, LEVELS = 31;
// Leader portraits are tall banners (Portrait_Leader_X): the card art is a square starting this far down (fraction of
// the height; 0.10 unless listed), 1.3x the banner's width so the face isn't cropped too tight. Checked by eye on a
// contact sheet of all 24; a new leader may need an entry.
const LEADER_FACE = { Onu: 0.20, Ysera: 0.21, Anubarak: 0.17, OldMurkEye: 0.23, Hogger: 0.14, Charlga: 0.15, Drakkisath: 0.13 };

const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.name.endsWith('.bundle') && BUNDLES.test(e.name)) files.push(p); } };
walk(DIR);
function balanced(t, i) { let d = 0, s = false; for (let j = i; j < t.length && j < i + 3e6; j++) { const c = t[j];
  if (s) { if (c === '\\') j++; else if (c === '"') s = false; continue; } if (c === '"') s = true;
  else if (c === '{') d++; else if (c === '}' && --d === 0) return t.slice(i, j + 1); } return null; }
const objs = {};
const tables = [];
for (const p of files) {
  let b; try { b = readBundle(p); } catch { continue; }
  for (const f of b.files) {
    if (f.data.length > 3e8) continue;
    const t = f.data.toString('utf8');
    for (const m of t.matchAll(/\{\s*"\$type": "Gryphon\.Data\.([\w.]+)/g)) {
      const js = balanced(t, m.index);
      if (!js) continue;
      try { const o = JSON.parse(js); if (o.guid) objs[o.guid] = { type: m[1], ...o }; } catch { /* not plain JSON */ }
    }
  }
}
const enUS = new Set();
for (const o of Object.values(objs)) if (o.type === 'L10N.UserFacingStringTable') for (const l of o.Locales
  || []) if (l.LocaleId === 'enUS') enUS.add(l.LocalizedTable);
const str = {};
for (const o of Object.values(objs)) if (o.type === 'L10N.UserFacingStringContainer'
  && (enUS.has(o.guid) || /enUS$/.test(o.name))) for (const d of o.Data || []) str[d.Id] ??= d.Value;
log(`${files.length} bundles, ${Object.keys(objs).length} objects, ${Object.keys(str).length} English strings`);

function log(...a) { console.log(...a); }
const PERM = [8, 9, 10, 11, 12, 13, 14, 15, 4, 5, 6, 7, 0, 1, 2, 3, 30, 31, 28, 29, 26, 27, 24, 25, 22, 23, 20, 21, 18, 19, 16, 17];
const guidOfSaveId = (id) => PERM.map((p) => id[p]).join('');
const sprite = (ref) => (ref ? String(ref).split(',')[1] || null : null);
// game rich text -> plain text: <sprite ... name="Stun"> becomes nothing (the word follows), tags dropped
const text = (id) => {
  const s = str[id];
  if (s == null) return null;
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<sprite[^>]*>/gi, '').replace(/<[^>]+>/g, '').replace(/[ \t]+/g,
    ' ').replace(/ *\n */g, '\n').trim();
};
const shortName = (o, suffix) => (o?.name || '').replace(new RegExp(`_?${suffix}$`), '');
const FAMILY = { FamilyAlliance: 'Alliance', FamilyHorde: 'Horde', FamilyUndead: 'Undead', FamilyScourge: 'Undead',
  FamilyBeast: 'Beast', FamilyBeasts: 'Beast', FamilyBlackrock: 'Blackrock', FamilyCenarion: 'Cenarion' };
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
  const base = { health: 0, damage: 0, dps: 0 };
  let attackSpeed = null, speed = '';
  for (const src of collection?.m_numericStatSources || []) {
    const sd = objs[src.m_stat];
    const v = evalSource(src.m_dataSource);
    if (!sd || v == null) continue;
    const label = text(sd.m_displayNameRef) || sd.m_type;
    const round = (x) => (sd.m_displayAsInt ? Math.round(x) : Math.round(x * 100) / 100);
    out[label] = sd.m_statGrowthType ? Array.from({ length: LEVELS }, (_, i) => round(v * GROWTH ** i)) : round(v);
    if (sd.m_type === 'Health' && !base.health) base.health = Math.round(v);
    if (sd.m_type === 'Damage' && !base.damage) base.damage = Math.round(v);
    if (sd.m_type === 'DPS' && !base.dps) base.dps = Math.round(v * 10) / 10;
    if (sd.m_type === 'AttackSpeed' && attackSpeed == null) attackSpeed = Math.round(v * 100) / 100;
  }
  for (const src of collection?.m_userFacingStringStatSources || []) {
    const sd = objs[src.m_stat];
    const ds = objs[src.m_dataSource];
    const value = text(ds?.m_data?.m_value);
    if (!sd || !value) continue;
    out[text(sd.m_displayNameRef) || sd.m_type] = value;
    if (sd.m_type === 'Speed') speed = value;
  }
  return { stats: out, base, attackSpeed, speed };
}

// build
const unitIds = JSON.parse(readFileSync(join(STATIC, 'unit_ids.json'), 'utf8')).units; // save id -> slug
const old = JSON.parse(readFileSync(OUT, 'utf8'));
const oldBySlug = new Map(old.minis.map((m) => [m.slug, m]));
const talentOrder = JSON.parse(readFileSync(join(STATIC, 'army_code_minis.json'), 'utf8')).talentOrder || {};
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
  const famName = (f) => FAMILY[f?.name] || text(f?.m_displayNameRef) || shortName(f, 'Family').replace(/^Family/, '') || 'Neutral';
  const parts = (famObj?.m_subFamilies || []).map((g) => objs[typeof g === 'string' ? g : g?.m_family || g?.guid]).filter(Boolean);
  const families = parts.length ? parts.map(famName) : [famName(famObj)];
  const family = families.includes(prev.family) ? prev.family : families[0];
  for (const f of parts.length ? parts : [famObj]) if (f) tagIcons[famName(f)] ??= iconPath(sprite(f.m_icon),
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
  const st = statsOf(objs[m.m_stats]);
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
      description: full.replace(mm[1].replace(/<[^>]+>/g, '').trim(), '').trim() }       : /\n/.test(full)
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
    speed: st.speed,
    attackSpeed: st.attackSpeed != null ? String(st.attackSpeed) : null,
    damageType,
    description: text(m.m_descriptionRef) || '',
    summary: text(m.m_shortSummaryRef) || undefined,
    base: st.base,
    traits,
    talents: talents.filter(Boolean),
    ...(leaderAbility ? { leaderAbility } : {}),
    art: portrait ? `art/${slug}.webp` : prev.art,
    stats: st.stats,
    ...(prev.fixedArmySlots ? { fixedArmySlots: prev.fixedArmySlots } : {}),
    ...(prev.armySlotUpgrades ? { armySlotUpgrades: prev.armySlotUpgrades } : {}),
    ...(prev.alwaysOwned ? { alwaysOwned: true } : {}),
  };
  minis.push(entry);
}
minis.sort((a, b) => a.name.localeCompare(b.name));

// compare with the previous table (what changed by switching sources)
const diffs = [];
for (const m of minis) {
  const o = oldBySlug.get(m.slug);
  if (!o) { diffs.push(`${m.slug}: new`); continue; }
  for (const k of ['name', 'category', 'family', 'cost', 'damageType', 'speed']) {
    if (String(o[k] ?? '') !== String(m[k] ?? '')) diffs.push(`${m.slug}.${k}: "${o[k]}" -> "${m[k]}"`);
  }
  const was = `${o.base?.health}/${o.base?.damage}`, now = `${m.base.health}/${m.base.damage}`;
  if (was !== now) diffs.push(`${m.slug}.base: ${was} -> ${now}`);
  const on = (o.talents || []).map((t) => t.name).join(' | '), nn = m.talents.map((t) => t.name).join(' | ');
  if (on !== nn) diffs.push(`${m.slug}.talents: ${on} -> ${nn}`);
  const ot = (o.traits || []).map((t) => t.name).sort().join(','), nt = m.traits.map((t) => t.name).sort().join(',');
  if (ot !== nt) diffs.push(`${m.slug}.traits: ${ot} -> ${nt}`);
}
const missing = old.minis.filter((o) => !minis.some((m) => m.slug === o.slug)).map((o) => o.slug);

writeFileSync(OUT, JSON.stringify({
  source: 'Warcraft Rumble game files. Game data Â© Blizzard Entertainment.',
  generated: new Date().toISOString().slice(0, 10),
  stats: { format: 'single value = same at all levels; array = levels 1..31 (index 0 = level 1)',
    scaling: `stats with a growth type: round(level 1 value x ${GROWTH}^(level-1))` },
  tagIcons: { Wildcard: 'icons/Wildcard.png', Leader: 'icons/Leader.png',
    ...Object.fromEntries(Object.entries(tagIcons).filter(([, v]) => v)),
    'Siege Damage': tagIcons.Siege || tagIcons['Siege Damage'], 'Siege Specialist': tagIcons.Siege || tagIcons['Siege Specialist'] },
  minis,
}, null, 2) + '\n');
// sprite lists for extract_reward_icons.py (one list per output folder: file name -> sprite)
for (const [k, map] of Object.entries(sprites)) writeFileSync(join(WORK, `mini_${k}_sprites.json`),
  JSON.stringify(Object.fromEntries(map), null, 1) + '\n');
log(`${minis.length} minis -> ${OUT}`);
if (missing.length) log(`not rebuilt (kept out): ${missing.join(', ')}`);
if (unknownSources.size) log(`unknown stat sources: ${[...unknownSources].join(', ')}`);
log(`\n${diffs.length} differences from the previous minis.json:\n${diffs.map((d) => `  ${d}`).join('\n')}`);
