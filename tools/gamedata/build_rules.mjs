// Fills the level and upgrade rules of gamedata/rules.json in from the game's files: XP per level, what each rarity
// upgrade costs, the talent slots a rarity unlocks, a talent's price and the Valor a Diamond army slot costs. The
// rest of rules.json (colors, slot names, currency IDs) is the tracker's own, from seed/rules.json.
// usage: node build_rules.mjs
//   LevelProgressionData.m_miniExperiencePerLevel   XP to the next level, from level 1
//   ProgressionRarityTable (troops)                 the rarities in order; each Rarity has m_rarityPointsCost (stars),
//                                                   m_upgradeCost (currencies) and m_numUnlockedTalentSlots
//   StoreSettings.m_defaultTalentCost               a talent's price in Coins
//   ArmyManagerSettings.m_valorUpgradeCurrencyCost  Gold to Diamond
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFiles, saveIdOf } from './unityfs.mjs';
import { dataObjects } from './game_objects.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RUMBLE_GAMEDATA || join(HERE, '..', '..', 'gamedata'); // the game data being built
const OUT = join(DATA, 'rules.json');
const DIR = process.env.RUMBLE_BUNDLES;
const BUNDLES = /^(gryphongame_embedded|support_progression|support_commerce|store\.bundle|feature_store)/;
const WANT = /^(LevelProgressionData|Rarity|ProgressionRarityTable|StoreSettings|ArmyManagerSettings|SharedInt)$/;

const objs = dataObjects(bundleFiles(DIR, (n) => BUNDLES.test(n)), { wanted: (type) => WANT.test(type) });
const one = (type, test = () => true) => Object.values(objs).find((o) => o.type === type && test(o));
// a number given as it is, or as the GUID of a SharedInt
const int = (v) => (objs[v] ? Number(objs[v].m_value) : Number(v));
const need = (value, what) => {
  if (value == null || Number.isNaN(value) || (Array.isArray(value) && !value.length)) {
    throw new Error(`${what} not found in the game files`);
  }
  return value;
};

const rules = JSON.parse(readFileSync(OUT, 'utf8'));
const roleOf = Object.fromEntries(Object.entries(rules.currencyIds).map(([role, id]) => [id, role]));

const xp = need(one('LevelProgressionData')?.m_miniExperiencePerLevel, 'The XP table');
rules.xpToNext = Object.fromEntries(xp.map((n, i) => [i + 1, n]));
rules.maxXpLevel = xp.length + 1;

// troops and leaders upgrade alike: the troops' table is read
const table = need(one('ProgressionRarityTable', (o) => /Troop/.test(o.name))?.m_rarities, 'The rarities');
const rarities = table.map((g) => need(objs[g], 'A rarity'));
rules.rarityUpgrade = rarities.slice(1).map((r, i) => {
  const step = { to: i + 1, stars: need(r.m_rarityPointsCost, `${r.name}'s stars`), arcEnergy: 0, core: null };
  for (const c of r.m_upgradeCost || []) {
    const role = need(roleOf[saveIdOf(c.m_currencyType)], `The currency ${r.name} costs`);
    if (role === 'arcEnergy') step.arcEnergy = need(int(c.m_currencyAmount), `${r.name}'s Arc Energy`);
    else step.core = role;
  }
  return step;
});
rules.talentSlotsByRarity = rarities.map((r) => r.m_numUnlockedTalentSlots || 0);
rules.talentCostCoins = need(int(one('StoreSettings')?.m_defaultTalentCost), "A talent's price");
rules.armySlots.diamondValorCost = need(one('ArmyManagerSettings')?.m_valorUpgradeCurrencyCost, "A Diamond slot's cost");
// the highest level a mini can play at: XP level, rarity, talents and the best army slot together
rules.maxLevel = rules.maxXpLevel + (rarities.at(-1).m_numBonusLevels || 0) + Math.max(...rules.talentSlotsByRarity)
  + rules.armySlots.tiers.at(-1).bonus;

writeFileSync(OUT, JSON.stringify(rules, null, 2) + '\n');
console.log(`rules: ${xp.length} XP levels, ${rules.rarityUpgrade.length} upgrades, talent ${rules.talentCostCoins}, `
  + `Diamond ${rules.armySlots.diamondValorCost}, top level ${rules.maxLevel} -> ${OUT}`);
