// Mini and army rules for the selected account: rarity upgrades, XP, talents and leader army slots, from rules.json and
// minis.json. Without the DOM, so the tests can run them.
import { RULES, BY_SLUG, state } from './core.js';

export const rarityName = (r) => RULES.rarities[r]?.name ?? `Rarity ${r}`;
export const rarityColor = (r) => `var(--rarity-${r})`;
/**
 * The account's unit of a mini, or null. Minis every player owns have no levels in the save; they count only with
 * `alwaysOwned`.
 */
export const ownedUnit = (slug, { alwaysOwned = true } = {}) =>
  state.units.find((u) => u.slug === slug && (alwaysOwned || !u.synthetic)) || null;
/**
 * A G.R.I.D. slot's rarity from its store name, such as "EpicRarity_Leader": its index in rules.json (or -1) and a
 * label such as "Epic leader".
 */
export function gridRarityOf(name) {
  const m = /^(\w+?)Rarity_(Troop|Leader)$/.exec(name || '');
  if (!m) return { index: -1, label: '' };
  return { index: RULES.rarities.findIndex((r) => r.name === m[1]), label: `${m[1]}${m[2] === 'Leader' ? ' leader' : ''}` };
}
export const FAMILIES = ['Alliance', 'Horde', 'Undead', 'Beast', 'Blackrock', 'Cenarion'];
export const miniOf = (u) => (u && u.slug ? BY_SLUG.get(u.slug) : null);
// A mini the game data doesn't have yet, usually one added by a patch.
export const unitName = (u) => miniOf(u)?.name ?? `New mini ${u.id.slice(0, 8)}`;
// Currencies are found by their ID, which is the same for every player; names are only shown.
const currencyOf = (role) => state.currencies.find((c) => c.id === RULES.currencyIds[role]);
export const balance = (role) => currencyOf(role)?.balance ?? 0;
export const currencyName = (role) => currencyOf(role)?.name || state.currencyNames?.[RULES.currencyIds[role]] || role;
export const coreName = (role) => currencyName(role).replace(/s$/, '');

export function nextUpgrade(u) {
  if (u.synthetic || u.rarity >= RULES.rarityUpgrade.length) return null;
  const step = RULES.rarityUpgrade[u.rarity];
  const starsOk = u.stars >= step.stars;
  const arcOk = balance('arcEnergy') >= step.arcEnergy;
  const coreOk = !step.core || balance(step.core) >= 1;
  return { ...step, starsOk, arcOk, coreOk, ready: starsOk && arcOk && coreOk };
}
export const talentSlots = (u) => (u.synthetic ? 0 : RULES.talentSlotsByRarity[u.rarity] ?? 0);
const talentTotal = (u) => miniOf(u)?.talents.length ?? 3;
// A mini with every talent unlocked has all of them ticked.
export const allTalentsOwned = (u) => talentTotal(u) > 0 && u.talents >= talentTotal(u);
export const effectivePicks = (u) => (allTalentsOwned(u) ? [...Array(talentTotal(u)).keys()] : u.talentPicks);
export function xpToMax(u) {
  if (u.xpLevel >= RULES.maxXpLevel) return 0;
  let total = Math.max(0, u.xpNeeded - u.xp);
  for (let l = u.xpLevel + 1; l < RULES.maxXpLevel; l++) total += RULES.xpToNext[l] || 0;
  return total;
}
export const isLeader = (u) => !u.synthetic && miniOf(u)?.category === 'Leader';
// Slots 1-3 are the top row. When a leader's fixed slots are known, slots 1 and 2 are locked and slot 3 is the fixed
// type or Wildcard. Slots 4-6 are free.
export function fixedSlot(u, i) {
  const f = miniOf(u)?.fixedArmySlots;
  return f && i >= 1 && i <= 3 ? f[i - 1] || null : null;
}
export const slotLocked = (u, i) => i >= 1 && i <= 2 && !!fixedSlot(u, i);
// Legacy names for the Siege slot type.
const SLOT_ALIASES = { 'Siege Damage': 'Siege', 'Siege Specialist': 'Siege' };
/** The slot types a leader's bottom slots (4-6) allow, from its army board. Never Wildcard. */
export const bottomSlotOptions = (u) => miniOf(u)?.armySlotUpgrades || [];
export function armyOf(u) {
  const A = RULES.armySlots;
  const saved = u.army || [];
  const used = new Set();
  return Array.from({ length: A.count }, (_, i) => {
    let type = i === A.leaderSlot ? 'Leader' : SLOT_ALIASES[saved[i]?.type] || saved[i]?.type || fixedSlot(u, i) || '';
    if (slotLocked(u, i)) type = fixedSlot(u, i);
    else if (i === 3 && fixedSlot(u, 3) && type !== 'Wildcard') type = fixedSlot(u, 3);
    else if (i >= 4) {
      // The bottom row takes the board's types, no Wildcard and no repeats; anything else reads as empty.
      const opts = bottomSlotOptions(u);
      if (type === 'Wildcard' || (opts.length && !opts.includes(type)) || used.has(type)) type = '';
      if (type) used.add(type);
    }
    return { type, tier: saved[i]?.tier || 0, boost: i === A.boostSlot && saved[i]?.boost === true };
  });
}
export const hasBoost = (u) => isLeader(u) && armyOf(u)[RULES.armySlots.boostSlot].boost;
// A leader occupies its Leader slot, so that slot's bonus is part of its level.
export const leaderSlotBonus = (u) => (isLeader(u) ? RULES.armySlots.tiers[armyOf(u)[RULES.armySlots.leaderSlot].tier]?.bonus || 0 : 0);
export const totalLevel = (u) => u.level + leaderSlotBonus(u);

export function armyTotals(units) {
  const A = RULES.armySlots;
  const diamond = A.tiers.length - 1;
  const t = { leaders: 0, slots: 0, diamonds: 0, goldReady: 0, notDiamond: 0, cost: A.diamondValorCost };
  for (const u of units) {
    if (!isLeader(u)) continue;
    t.leaders++;
    for (const s of armyOf(u)) {
      t.slots++;
      if (s.tier === diamond) t.diamonds++;
      else {
        t.notDiamond++;
        if (s.tier === diamond - 1) t.goldReady++;
      }
    }
  }
  return t;
}

export function remainingToLegendary(u) {
  const out = { arcEnergy: 0, stars: 0, cores: {} };
  if (u.synthetic) return out;
  for (let r = u.rarity; r < RULES.rarityUpgrade.length; r++) {
    const s = RULES.rarityUpgrade[r];
    out.arcEnergy += s.arcEnergy;
    out.stars += r === u.rarity ? Math.max(0, s.stars - u.stars) : s.stars;
    if (s.core) out.cores[s.core] = (out.cores[s.core] || 0) + 1;
  }
  return out;
}

// Which minis fit a slot type

const DMG_TAG = { AOE: 'AoE', Squad: 'Squad', OneTarget: 'One-Target' };

/** What a slot type can match: the mini's families, roles, traits, damage type and category. */
function miniTags(m) {
  const tags = new Set([...familiesOf(m), ...String(m.role).split(','), ...m.traits.map((t) => t.name)]);
  if (m.category === 'Spell') tags.add('Spell');
  if (DMG_TAG[m.damageType]) tags.add(DMG_TAG[m.damageType]);
  if (tags.has('Siege Damage') || tags.has('Siege Specialist')) tags.add('Siege');
  return tags;
}

export function slotMatches(type, m) {
  if (!type || !m) return false;
  if (type === 'Wildcard') return true;
  return miniTags(m).has(type);
}

/** A mini's families: both of a dual-faction mini's (from the game data), else its one family. */
export const familiesOf = (m) => (m.families?.length > 1 ? m.families : [m.family]);

/** The level unit u plays at in slot i of leader L's army. */
export function levelInSlot(u, L, i) {
  const A = RULES.armySlots;
  const slot = armyOf(L)[i];
  const tier = A.tiers[slot.tier];
  if (!u || u.synthetic) return { level: null, match: false, bonus: 0, boosted: false, xpMax: false };
  const m = miniOf(u);
  const match = i === A.leaderSlot ? u.id === L.id : slotMatches(slot.type, m);
  const xp = slot.boost ? Math.max(u.xpLevel, RULES.maxXpLevel) : u.xpLevel;
  const bonus = match ? tier.bonus : 0;
  return {
    level: Math.min(RULES.maxLevel, xp + u.rarity + u.talents + bonus),
    match, bonus,
    boosted: slot.boost && u.xpLevel < RULES.maxXpLevel,
    xpMax: xp >= RULES.maxXpLevel,
  };
}

/** The talent a mini uses in an army: the army's choice, else the first one the player has unlocked, else the first. */
export function talentIndex(army, m, u) {
  if (!m?.talents.length) return null;
  const chosen = army.talents?.[m.slug];
  if (Number.isInteger(chosen) && chosen >= 0 && chosen < m.talents.length) return chosen;
  return (u ? effectivePicks(u)[0] : null) ?? 0;
}
