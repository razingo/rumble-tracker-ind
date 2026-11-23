// Picks the sounds the rdmodule uses out of the exported game audio (sounds, see export_sounds.py) and copies
// them into its sounds folder (RDMODULE_SOUNDS; local
// only, Blizzard audio). Each sound gets a key and up to a few takes: <key>-1.wav, <key>-2.wav, ...; index.json there
// lists how many takes every key has.
//   units (every sprite in sprites.json): <id>.attack and <id>.hit from the sounds the unit catalog ties to its main
//   attack (see apply_catalog.mjs), <id>.death and <id>.ready from the unit's own; where the catalog has none, from the
//   unit's sound banks by name: <id>.attack, <id>.hit, <id>.death, and <id>.ready
//   (its English ready line; without one, another of its lines or its ready or birth sound)
//   the rest: the fixed list below, and the music (whole files, named there)
// usage: node tools/rdmodule/pick_sounds.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, mainAbility } from './apply_catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESEARCH = process.env.RUMBLE_WORK; // the working folder with the exports
const SOUNDS = join(RESEARCH, 'sounds');
const OUT = process.env.RDMODULE_SOUNDS;
const index = JSON.parse(readFileSync(join(SOUNDS, 'index.json'), 'utf8'));
const sprites = JSON.parse(readFileSync(join(RESEARCH, 'sprites.json'), 'utf8')).sprites;
const rigs = JSON.parse(readFileSync(join(RESEARCH, 'animations', 'index.json'), 'utf8'));

// sprites whose sounds come from another mini
const SLUG = { 'emerald-whelp': 'whelp-eggs', 'emerald-drake': 'drake', 'skeleton-mage': 'skeletons', 'spirit-wolf': 'prowler', scarab: 'spiderlings' };
// [key, bank, event (a regular expression on its name), takes]
const FIXED = [
  ['ui.card', 'UI_Gameplay', /SFX_UI_Unit_Placement_End$/, 3],
  ['ui.nogold', 'UI_Gameplay', /SFX_UI_Unit_Placement_Fail$/, 1],
  ['ui.select', 'UI_Gameplay', /SFX_UI_Unit_Select$/, 2],
  ['ui.click', 'MX_Set_States', /UI_GenericClick_Small$/, 2],
  ['ui.start', 'UI_Gameplay', /SFX_UI_StartBattle_Button$/, 2],
  ['ui.deploy', 'UI_Gameplay', /UI_Deploy_Burst$/, 1],
  ['gold.coin', 'Alerts_Gold', /GoldCoin_Normal$/, 3],
  ['gold.max', 'Alerts_Gold', /PlayerGoldMaxedReactorArmy$/, 1],
  ['over', 'MX_Set_States', /MX_Defeat_Stinger$/, 1],
  ['death', 'Unit_Footmen', /Play_Unit_Generic_Death$/, 4],
  ['tower.guard.shot', 'Building_HumanTower_Guard', /^Play_Structure_HumanTower_Guard_AbilityAttack$|^Structure_HumanTower_Guard_AbilityAttack$/, 3],
  ['tower.plain.shot', 'Building_HumanTower_Guard', /Structure_HumanTower_Guard_AbilityAttack$/, 3],
  ['tower.hit', 'Building_HumanTower_Guard', /Structure_HumanTower_Guard_Impact$/, 3],
  ['tower.rocket.shot', 'Building_RocketTower', /Structure_RocketTower_Launch$/, 3],
  ['tower.rocket.boom', 'Building_RocketTower', /Structure_RocketTower_Impact$/, 3],
  ['tower.dragon.shot', 'Building_DragonTower', /Structure_DragonTower_Attack_Launch$/, 2],
  ['tower.fall', 'Building_HumanTower_Guard', /Structure_HumanTower_Guard_Death$/, 1],
  ['spell.arcane-blast', 'Spell_ArcaneBlast', /Spell_ArcaneBlast_1st_(Cast|Impact)$/, 2],
  ['spell.chain-lightning', 'Spell_ChainLightning', /Spell_ChainLightning_Launch$/, 3],
];
// music, by file, each one piece that loops: the game's own menu theme (its full mix), and its battle music for a run
const MUSIC = [
  ['music.menu', ['sfx/Gry_GlueScreen_FullMixv3Comped.wav']],
  ['music.alliance', ['sfx/GRY_BattleMusicAlliance_FullMixv5.wav']],
  ['music.horde', ['sfx/GRY_BattleMusicHorde_FullMixv4.wav']],
];

const out = {};
let bytes = 0;
// RDMODULE_SOUNDS_LIST: nothing is copied; the files that would be are listed in that file, to be decoded first
const LIST = process.env.RDMODULE_SOUNDS_LIST;
const wanted = new Set();
function put(key, files, takes) {
  if (LIST) {
    const some = [...new Set(files)].slice(0, takes);
    for (const f of some) wanted.add(f);
    if (some.length) out[key] = some.length;
    return some.length;
  }
  const real = [...new Set(files)].filter((f) => existsSync(join(SOUNDS, f))).slice(0, takes);
  real.forEach((f, i) => { copyFileSync(join(SOUNDS, f), join(OUT, `${key}-${i + 1}.wav`)); bytes += statSync(join(SOUNDS, f)).size; });
  if (real.length) out[key] = real.length;
  return real.length;
}
// the files of the events of a bank whose names match, spread over the events so takes differ
function eventFiles(bank, re) {
  const lists = Object.entries(index.banks[bank]?.events || {}).filter(([name]) => re.test(name)).map(([, f]) => f.sfx || []);
  const files = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) files.push(l[i]);
  return files;
}

if (!LIST) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
}
for (const [key, bank, re, takes] of FIXED) if (!put(key, eventFiles(bank, re), takes)) console.log(`nothing for ${key}`);
for (const [key, files] of MUSIC) if (put(key, files, files.length) < files.length) console.log(`music missing for ${key}`);
const missing = [];
const listed = (s) => (s.files?.sfx?.length ? s.files.sfx : s.files?.['en-US'] || []);
for (const [id, spec] of Object.entries(sprites)) {
  if (!spec.unit) continue;
  // what the catalog says the attack and the unit sound like
  const ability = mainAbility(spec), own = catalog[spec.unit]?.sounds || [];
  if (ability) {
    put(`${id}.attack`, ability.sounds.filter((s) => s.trigger === 'ReactorAbility' && s.activity !== 'Detached').flatMap(listed), 3);
    put(`${id}.hit`, [...ability.sounds, ...own].filter((s) => s.trigger === 'ImpactSound' || s.activity === 'Detached').flatMap(listed), 3);
  }
  put(`${id}.death`, own.filter((s) => s.trigger === 'ReactorLife').flatMap(listed), 2);
  put(`${id}.ready`, own.filter((s) => s.trigger === 'ReactorUnit').flatMap(listed), 3);
  const banks = index.bySlug[SLUG[id] || rigs.units[spec.unit]?.slug || id]?.banks;
  if (!banks) { missing.push(id); continue; }
  for (const bank of banks) {
    if (/^DX_/.test(bank)) { // voice: by file name, the events don't list their files
      const lines = (index.banks[bank]?.languages['en-US'] || []);
      if (!out[`${id}.ready`] && !put(`${id}.ready`, lines.filter((f) => /Ready|Deploy|Spawn/i.test(f)), 3)) put(`${id}.ready`, lines.filter((f) => /Attack/i.test(f)), 3);
    } else {
      if (!out[`${id}.attack`]) put(`${id}.attack`, eventFiles(bank, /_(Attack|Attack_Launch|Ability\w*_Launch|Throw|Shot|Cast)$/), 3);
      if (!out[`${id}.hit`]) put(`${id}.hit`, eventFiles(bank, /_(Attack_Impact|Impact)$/), 3);
      if (!out[`${id}.death`]) put(`${id}.death`, eventFiles(bank, /^(?!.*Generic).*_Death$/), 2);
      if (!out[`${id}.ready`]) put(`${id}.ready`, eventFiles(bank, /_(Ready|Birth)$/), 2);
    }
  }
}
if (LIST) {
  writeFileSync(LIST, JSON.stringify([...wanted]));
  console.log(`${wanted.size} sound files wanted`);
  process.exit(0);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(out));
console.log(`${Object.keys(out).length} sounds, ${Object.values(out).reduce((a, b) => a + b, 0)} files, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);
if (missing.length) console.log(`no sound banks: ${missing.join(', ')}`);
