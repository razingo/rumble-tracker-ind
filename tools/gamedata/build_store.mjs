// Build gamedata/store.json from the game's bundles: store offers (English title and price),
// G.R.I.D. prices per rarity and XP-boost items, and the G.R.I.D. rules from StoreSettings.
// usage: node build_store.mjs [out.json]
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle, bundleFiles, jsonObjectAt, saveIdOf, englishStrings, CURRENCY_NAMES } from './unityfs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RUMBLE_GAMEDATA || join(HERE, '..', '..', 'gamedata'); // the game data being built
const WORK = process.env.RUMBLE_WORK || HERE; // working files passed between the steps
const OUT = process.argv[2] || join(DATA, 'store.json');
const DIR = process.env.RUMBLE_BUNDLES;
const BUNDLES = new RegExp('^(' + [
  'store', 'support_commerce', 'gryphongame_embedded', 'ui_glue_general', 'support_progression_rarity', 'strtable_.*',
  'feature_store',
].join('|') + ')\\.bundle$');
const WANT = new RegExp('^(' + [
  'StoreOffer', 'StoreGrant', 'CommerceProduct', 'CommercePrice', 'SharedInt', 'StoreGridXpBoost', 'Rarity',
  'StoreSettings', 'TomeProgression', 'L10N\\.UserFacingString\\w*',
].join('|') + ')$');

const files = bundleFiles(DIR, (n) => BUNDLES.test(n));
function balanced(text, i) { return jsonObjectAt(text, i, 3e6); } // (no object here is longer)
const objs = {};
for (const p of files) {
  let b; try { b = readBundle(p); } catch { continue; }
  for (const f of b.files) {
    if (f.data.length > 3e8) continue;
    const t = f.data.toString('utf8');
    for (const m of t.matchAll(/\{\s*"\$type": "Gryphon\.Data\.([\w.]+)/g)) {
      if (!WANT.test(m[1])) continue;
      const js = balanced(t, m.index);
      try { const o = JSON.parse(js); if (o.guid) objs[o.guid] = { type: m[1], ...o }; } catch { /* not plain JSON */ }
    }
  }
}
// English strings (same scheme as build_events.mjs)
const str = englishStrings(objs);
const clean = (s) => s?.replace(/<[^>]+>/g, '').replace(/\{\d+\}/g, '').replace(/\s+/g, ' ').trim() || null;

const int = (g) => objs[g]?.m_value ?? null;
const COINS = 'e9c433015c337934c9890eb4e13ff3d3';

// readable fallback for offers without an English title: Daily_TomeMega_Generic_StoreOffer -> "Tome Mega Generic"
const pretty = (n) => n.replace(/_StoreOffer.*$/, '').replace(/^(Daily|Special|Persistent|FreeGift)_/,
  '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();

// An offer's title. The page fills in "{mini}" and "{tome}" from the save. Any other placeholder ("{cores}",
// "{energy}") stands for what the offer holds: the product's name, else the currency it grants ("2,000 Arc Energy").
function titleOf(o, product) {
  const title = clean(str[o.m_offerTitle]), named = clean(str[product?.m_name]);
  if (!title || !/{(?!mini}|tome})/.test(title)) return title || named || pretty(o.name);
  const grant = (o.m_grantedItems || []).map((g) => objs[g]).find((g) => CURRENCY_NAMES[g?.m_currencyType]);
  return named || (grant ? `${grant.m_currencyAmount.toLocaleString('en-US')} ${CURRENCY_NAMES[grant.m_currencyType]}`
    : pretty(o.name));
}

const offers = {};
for (const o of Object.values(objs)) {
  if (o.type !== 'StoreOffer') continue;
  const product = objs[o.m_product?.m_nonAbGroupValue];
  const price = objs[product?.m_price];
  // the price is the product's, or the offer's own where it has no product
  const vc = (price?.m_virtualCurrencyPrices || [])[0]
    || (o.m_currencyType && { m_currencyType: o.m_currencyType, m_priceAmount: o.m_currencyCost });
  const banner = String(o.m_bannerImage || '').split(',')[1] || null;
  offers[saveIdOf(o.guid)] = {
    name: o.name,
    // art: the offer's own banner; the free gift (unit XP) has none, so it gets the XP gem pile
    icon: banner || (/^FreeGift_Dynamic/.test(o.name) ? 'Store_Tex_XP_Gem_Pile' : undefined),
    title: titleOf(o, product),
    cost: vc ? { coins: vc.m_currencyType === COINS, currency: CURRENCY_NAMES[vc.m_currencyType] || vc.m_currencyType,
      amount: int(vc.m_priceAmount) } : null,
    realMoney: o.m_costType === 'RealMoney' || undefined,
  };
}

// G.R.I.D.: price per offered rarity (the save's slot field 13 is the Rarity), XP boosts, rules
const gridRarity = {};
for (const o of Object.values(objs)) if (o.type === 'Rarity') gridRarity[saveIdOf(o.guid)] = { name: o.name,
  coins: int(o.m_gridPurchaseCostRef) };
const xpBoosts = {};
// XP boost art: the game's statue sprites come in Small / Medium / Large (Modest / Major / Mega)
const XP_STATUE = { Modest: 'Small', Major: 'Medium', Mega: 'Large' };
for (const o of Object.values(objs)) if (o.type === 'StoreGridXpBoost') {
  const size = XP_STATUE[(/^(Modest|Major|Mega)/.exec(o.name) || [])[1]] || 'Small';
  xpBoosts[saveIdOf(o.guid)] = { name: clean(str[o.m_nameRef]) || o.name.replace(/_/g, ' '),
    coins: int(o.m_equivalentCost), icon: `Statue_${size}_XPBoost_Pose` };
}
// tome names, for offers titled "{tome}" (the save names the tome: TomeMega_Undead_TomeProgression -> Mega Undead Tome)
const tomes = {};
for (const o of Object.values(objs)) if (o.type === 'TomeProgression') {
  const m = /^Tome(\w+?)_(\w+?)_TomeProgression$/.exec(o.name);
  tomes[saveIdOf(o.guid)] = clean(str[o.m_nameRef]) || (m ? `${m[1]} ${m[2]} Tome` : o.name);
}
const ss = Object.values(objs).find((o) => o.type === 'StoreSettings');
const rules = ss && {
  refreshSeconds: ss.m_recycleGridItemsInterval,
  recentlySeen: ss.m_recentlySeenCounts,
  specialMinis: (ss.m_superSpecialAwesomeMinis || []).map(saveIdOf),
};

// sprites to extract (extract_reward_icons.py store_sprites.json gamedata/store): banners of offers that can
// show up on the Calendar (no deprecated or old PvP-season offers), XP boost statues, the free gift's gem pile
const shownOffer = (n) => !/^(zDeprecated|Pvp_Season|archive)/i.test(n);
const sprites = new Set([
  ...Object.values(offers).filter((o) => o.icon && shownOffer(o.name)).map((o) => o.icon),
  ...Object.values(xpBoosts).map((x) => x.icon),
]);
writeFileSync(join(WORK, 'store_sprites.json'), JSON.stringify([...sprites].sort(), null, 1) + '\n');
console.log(sprites.size, 'store sprites');
writeFileSync(OUT, JSON.stringify({ note: 'Built from the game files.', offers, gridRarity, xpBoosts, tomes, rules }, null, 1) + '\n');
console.log(Object.keys(offers).length, 'offers,', Object.keys(gridRarity).length, 'rarities,',
  Object.keys(xpBoosts).length, 'xp boosts ->', OUT);
