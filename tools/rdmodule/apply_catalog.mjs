// Takes each sprite unit's attack from the unit catalog (unit_catalog.json, see build_unit_catalog.py): the
// clip its main ability plays, the effects that ability shows and the sounds it makes, so the rdmodule uses what the
// game itself ties to that attack instead of hand-picked ones.
//   sprites.json: sets each mini's and enemy's "attack" clip (leaders keep the clip chosen for their card), a healer's
//   "cast" clip, and adds the abilities' effects to "effects" (keys "u-<prefab>")
//   <sprites folder>/unitfx.json: sprite id -> { cast, impact }, the effect keys the game plays on the attacker as it
//   swings and on the target as the hit lands
// pick_sounds.mjs uses the same choice (mainAbility) for the sounds.
// Run by extract.mjs, which gives the folders in RUMBLE_WORK and RDMODULE_SPRITES.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORK = process.env.RUMBLE_WORK; // the working folder with the exports
const OUT = process.env.RDMODULE_SPRITES;
export const catalog = JSON.parse(readFileSync(join(WORK, 'unit_catalog.json'), 'utf8')).units;

const NOT_AN_ATTACK = /Charge|Hook|Cannibal|Heal|Renew|Raise|Teleport|Phase|Burrow|Deploy|Stealth|Bloodlust|Poison$|Taunt|Dismount/i;
const MOVING = /^(Walk|Ready|Stand|Run|Fly|Move)/;

// The body of a unit that a sprite shows: the one named by spec.size or by the unit's first size entry, else the
// first with abilities.
function body(spec) {
  const u = catalog[spec.unit];
  if (!u) return null;
  const name = spec.size || u.size?.[0]?.unit;
  return u.bodies.find((b) => b.unit === name && b.abilities.length) || u.bodies.find((b) => b.abilities.some((a) => !a.talent)) || null;
}
// Its main attack: the first ability that is its own (not a talent's), plays a clip and is not a charge, heal or the like.
export function mainAbility(spec) {
  const own = (body(spec)?.abilities || []).filter((a) => !a.talent);
  return own.find((a) => a.clips.length && !NOT_AN_ATTACK.test(a.name)) || own.find((a) => a.clips.length) || null;
}
const healAbility = (spec) => (body(spec)?.abilities || []).find((a) => !a.talent && /Heal/i.test(a.name) && a.clips.length) || null;
const clipOf = (ability) => (ability.clips.find((c) => !MOVING.test(c.clip)) || ability.clips[0]).clip;
// colors the effects viewer gets wrong, by what the effect is (see effects_capture.js)
const tintOf = (prefab) => (/Poison/i.test(prefab) ? '#62e86a' : /Ice|Frost/i.test(prefab) ? '#8fd0ff' : /BlastWave/i.test(prefab) ? '#ff8a2b' : null);
const fxKey = (prefab) => `u-${prefab.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = join(WORK, 'sprites.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const leaders = new Set(Object.values(catalog).filter((u) => u.bodies.some((b) => /Leader/.test(b.unit))).map((u) => u.slug));
  const unitFx = {}, lines = [];
  // effects added by an earlier run go; they are rebuilt
  for (const k of Object.keys(config.effects)) if (k.startsWith('u-')) delete config.effects[k];
  for (const [id, spec] of Object.entries(config.sprites)) {
    if (!spec.unit || id.startsWith('shot-')) continue;
    const ability = mainAbility(spec);
    if (!ability) { lines.push(`${id}: no ability in the catalog`); continue; }
    const leader = leaders.has(id);
    if (!leader) spec.attack = clipOf(ability);
    const heal = healAbility(spec);
    if (heal) spec.cast = clipOf(heal);
    // on the target: the impact; on the attacker: what it swings or casts with (not what it carries all the time)
    const hurts = (e) => !/Heal/i.test(e.prefab); // (a Raptor's bite also carries its talent's heal)
    const impact = ability.effects.find((e) => e.role === 'impact' && hurts(e)) || ability.effects.find((e) => e.role === 'model' && hurts(e));
    // (a drake's breath splash fills the whole capture and comes out as one bright slab, so it is left out)
    const cast = ability.effects.find((e) => e.role === 'attachment' && !/Status|Buff|Debuff|Ping|Fury|Trail|Enemy_Deploy|Aura|Splash_Attack/i.test(e.prefab));
    const fx = {};
    for (const [what, e] of [['impact', impact], ['cast', cast]]) {
      if (!e || leader) continue; // (a leader's attack shows the effect of its card, not these)
      fx[what] = fxKey(e.prefab);
      config.effects[fx[what]] = { unit: spec.unit, prefab: e.prefab, ...(tintOf(e.prefab) ? { tint: tintOf(e.prefab) } : {}) };
    }
    if (!leader && Object.keys(fx).length) unitFx[id] = fx;
    lines.push(`${id}: ${ability.name} -> ${clipOf(ability)}${leader ? ' (leader: card clip kept)' : ''}${heal ? `, heal ${clipOf(heal)}` : ''}; ${Object.entries(fx).map(([k, v]) => `${k} ${v}`).join(', ') || 'no effects'}`);
  }
  // one sprite, one line, as the file is kept
  const block = (o) => Object.entries(o).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v).replace(/":/g, '": ').replace(/,"/g, ', "').replace(/^\{/, '{ ').replace(/\}$/, ' }')}`).join(',\n');
  writeFileSync(file, `{\n${Object.entries(config).map(([k, v]) => `  "${k}": {\n${block(v)}\n  }`).join(',\n')}\n}\n`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'unitfx.json'), JSON.stringify(unitFx));
  console.log(lines.join('\n'));
  console.log(`${Object.keys(unitFx).length} units with their own attack effects -> ${join(OUT, 'unitfx.json')}`);
}
