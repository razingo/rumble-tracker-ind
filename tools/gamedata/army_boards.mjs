// Read every leader's army board (Player_*_ArmyBoard) from the game files: fixed family slots, fixed trait slot,
// and the slot types the player can pick. Compares with gamedata/minis.json and, with --write, updates its
// fixedArmySlots / armySlotUpgrades.  usage: node army_boards.mjs <guid_index.json> [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle, bundleFiles, jsonObjectAt } from './unityfs.mjs';
import { FACTIONS } from './factions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RUMBLE_GAMEDATA || join(HERE, '..', '..', 'gamedata'); // the game data being built
const IDX = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const WRITE = process.argv.includes('--write');
const MINIS = join(DATA, 'minis.json');
const DIR = process.env.RUMBLE_BUNDLES;
const files = bundleFiles(DIR, (n) => /^unitdata_unit_/.test(n));

function balanced(text, i) { return jsonObjectAt(text, i, 1e6); } // (no object here is longer)

// game-internal names -> the tracker's slot type names
const RENAME = { AOE: 'AoE' };
function label(guid) {
  const n = IDX[guid]?.name || `?${guid.slice(0, 8)}`;
  const base = n.replace(/_(Trait|BalanceRole|BalanceType|Family|MiniFamily|AspectTrait)$/i, '').replace(/^(Trait|Family)[_ ]/, '');
  const pretty = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^Family /, '');
  return FACTIONS[pretty] || RENAME[pretty] || pretty;
}

const boards = {};
for (const p of files) {
  let b; try { b = readBundle(p); } catch { continue; }
  for (const f of b.files) {
    const t = f.data.toString('utf8');
    for (const m of t.matchAll(/\{\s*"\$type": "Gryphon\.Data\.ArmyBoard,/g)) {
      const js = balanced(t, m.index);
      let o; try { o = JSON.parse(js); } catch { continue; }
      if (!o || !/^Player_/.test(o.name)) continue; // (one that does not close is read as nothing)
      boards[o.m_leaderMini] = {
        board: o.name,
        leader: IDX[o.m_leaderMini]?.name,
        families: (o.m_autoAcquiredFamilySlots || []).map((s) => label(s.m_family)),
        fixedTraits: (o.m_autoAcquiredTraitSlots || []).map((s) => label(s.m_trait)),
        options: [...(o.m_possibleSlotTraits || []), ...(o.m_possibleSlotBalanceRoles || []),
          ...(o.m_possibleSlotBalanceTypes || [])].map(label),
      };
    }
  }
}
const list = Object.values(boards).sort((a, b) => a.board.localeCompare(b.board));
for (const x of list) console.log(x.board.padEnd(30), '| fixed', [...x.families, ...x.fixedTraits].join(','),
  '| options', x.options.join(', '));

// compare with minis.json (a leader's board is found by its name: the mini's key and the board's name share it)
const minis = JSON.parse(readFileSync(MINIS, 'utf8'));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
let changed = 0;
for (const m of minis.minis.filter((x) => x.category === 'Leader')) {
  const key = norm(m.slug || m.name);
  const x = list.find((b) => { const k = norm(b.board.replace(/^Player_|_ArmyBoard$/g, ''));
    return key.includes(k) || k.includes(key.slice(0, 5)); });
  if (!x) { console.log('no board for', m.name); continue; }
  // some boards only fix the two family slots; keep the third top slot we already had for those
  const fixed = [...x.families, ...x.fixedTraits];
  if (fixed.length === 2 && m.fixedArmySlots?.[2]) fixed.push(m.fixedArmySlots[2]);
  // bottom slots can also take the leader's own factions: every family slot on the board (Sylvanas: Undead + Horde)
  x.options = [...new Set([...x.families, ...x.options])];
  const diffFixed = JSON.stringify(fixed) !== JSON.stringify(m.fixedArmySlots || []);
  const diffOpts = JSON.stringify([...x.options].sort()) !== JSON.stringify([...(m.armySlotUpgrades || [])].sort());
  if (diffFixed || diffOpts) {
    console.log(`DIFF ${m.name}: fixed ${JSON.stringify(m.fixedArmySlots)} -> ${JSON.stringify(fixed)}; `
      + `options ${JSON.stringify(m.armySlotUpgrades)} -> ${JSON.stringify(x.options)}`);
    if (WRITE) { m.fixedArmySlots = fixed; m.armySlotUpgrades = x.options; changed++; }
  }
}
if (WRITE && changed) { writeFileSync(MINIS, JSON.stringify(minis, null, 2) + '\n');
  console.log(`updated ${changed} leaders in minis.json`); }
