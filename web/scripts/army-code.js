// Game army codes, as the game copies and pastes them.
import { getJson, BY_SLUG, onTablesReload } from './core.js';
import { parseMessage, fieldsOf, findField, numberOf, concat, int, embedded } from './lib/protobuf.js';
import { ownedUnit, talentIndex } from './units.js';

// A code is "rumblo:" and base64 protobuf { 1: leader index, 2: leader talent, 3: [{ 1: mini index, 2: talent }] x6 },
// with the game's short IDs as indices (static/army_code_minis.json).
let CODE_TABLE = null;
onTablesReload(() => { CODE_TABLE = null; });

async function codeTable() {
  if (!CODE_TABLE) {
    const t = await getJson('/static/army_code_minis.json', 'the army code table');
    const toSlug = new Map(Object.entries(t.shortIds).map(([id, slug]) => [Number(id), slug]));
    const toId = new Map([...toSlug].map(([id, slug]) => [slug, id]));
    // Codes list talents in the game's order; talentOrder[slug][gameIndex] gives the tracker's index.
    const order = t.talentOrder || {};
    const toApp = (slug, gameIdx) => order[slug]?.[gameIdx] ?? gameIdx;
    const toGame = (slug, appIdx) => {
      const k = order[slug]?.indexOf(appIdx) ?? -1;
      return k >= 0 ? k : appIdx;
    };
    CODE_TABLE = { prefix: t.prefix || 'rumblo:', toSlug, toId, toApp, toGame };
  }
  return CODE_TABLE;
}

export async function encodeArmyCode(d) {
  const table = await codeTable();
  const idx = (slug) => table.toId.get(slug) ?? -1;
  const talentOf = (slug) => table.toGame(slug, talentIndex(d, BY_SLUG.get(slug), ownedUnit(slug)) ?? 0);
  if (idx(d.leader) < 0) throw new Error('Choose a leader first.');
  const minis = d.minis.filter((slug) => slug && idx(slug) >= 0)
    .map((slug) => embedded(3, int(1, idx(slug)), int(2, talentOf(slug))));
  const bytes = concat(int(1, idx(d.leader)), int(2, talentOf(d.leader)), ...minis);
  return `${table.prefix}${btoa(String.fromCharCode(...bytes))}`;
}

export async function decodeArmyCode(code) {
  const table = await codeTable();
  let bytes, top;
  try {
    bytes = Uint8Array.from(atob(code.trim().replace(/^rumblo:/i, '')), (c) => c.charCodeAt(0));
    top = parseMessage(bytes);
  } catch {
    throw new Error('Not a Warcraft Rumble army code.');
  }
  const slugAt = (i) => {
    const slug = table.toSlug.get(i);
    if (!slug) throw new Error(`Unknown mini number ${i} in code.`);
    return slug;
  };
  const leader = slugAt(findField(top, 1) ? numberOf(findField(top, 1)) : -1);
  const talents = { [leader]: table.toApp(leader, numberOf(findField(top, 2))) };
  const minis = top.filter((f) => f.fn === 3 && f.wt === 2).map((f) => {
    const fields = fieldsOf(bytes, f);
    const slug = slugAt(numberOf(findField(fields, 1)));
    talents[slug] = table.toApp(slug, numberOf(findField(fields, 2)));
    return slug;
  });
  while (minis.length < 6) minis.push(null);
  return { leader, minis: minis.slice(0, 6), talents };
}
