// Army tab: the army builder, a leader and six minis, with the level each mini plays at in its slot.
import { poll } from './app.js';
import { encodeArmyCode, decodeArmyCode } from './army-code.js';
import { pools, savePools, matchingSlots, renderPool, renderPoolGrid, updatePool, poolClick, poolFiltered } from './army-pools.js';
import { toggleIn } from './collection.js';
import { $, post, copyText, RULES, BY_SLUG, TAG_ICONS, FAMILY_PAIRS, state, focusKey, refocus } from './core.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { iconImage, openDrawer } from './drawer.js';
import { SECOND } from './lib/constants.js';
import { esc } from './lib/format.js';
import { newId } from './lib/ids.js';
import { LIMITS, withTag, tagKey } from './lib/limits.js';
import { bindTraitPicker } from './trait-picker.js';
import { rarityColor, ownedUnit, miniOf, effectivePicks, armyOf, familiesOf, levelInSlot, talentIndex } from './units.js';

// The army builder: the draft being edited and the state of its pickers and pop-ups.
export const builder = { draft: null, draftAccount: null, nameText: '', codeMsg: null, codeText: '', talentPop: null,
  poolTraitOpen: null, poolTraitQ: {}, pools: null };

// Faction pennant
function familyFlag(m) {
  const fams = familiesOf(m);
  if (fams.length === 1) {
    return `<span class="family-flag family-${fams[0].toLowerCase()}"
      title="${esc(fams[0])}">${iconImage(TAG_ICONS[fams[0]], fams[0])}</span>`;
  }
  // (a pair with a combined icon, in static/icons/fam)
  const combo = FAMILY_PAIRS.find((c) => c === fams[0] + fams[1] || c === fams[1] + fams[0]);
  const icon = combo ? `<img class="icon" src="/static/icons/fam/${combo}.png" alt="">` : iconImage(TAG_ICONS[fams[0]], fams[0]);
  return `<span class="family-flag family-split"
    style="--family-a:var(--family-${fams[0].toLowerCase()});--family-b:var(--family-${fams[1].toLowerCase()})"
    title="${esc(fams.join(' + '))}">${icon}</span>`;
}

// Draft
const emptyDraft = () => ({ id: null, name: 'New army', leader: null, minis: [null, null, null, null, null, null],
  talents: {}, description: '', tags: [] });

// The name, description and tag fields of an army, the same on the Army and Armory tabs. `attrs` are the field's own
// attributes (id, cls for its classes, data-*).
const attributes = ({ cls, ...rest }) => [cls ? `class="${cls}"` : '',
  ...Object.entries(rest).map(([k, v]) => `${k}="${esc(v)}"`)].filter(Boolean).join(' ');

export const nameField = (attrs, value, placeholder = 'Name this army') =>
  `<input ${attributes(attrs)} value="${esc(value || '')}" maxlength="${LIMITS.armyName}"
    placeholder="${esc(placeholder)}" aria-label="Army name">`;

export const descriptionField = (attrs, description) =>
  `<textarea ${attributes(attrs)} rows="2" maxlength="${LIMITS.description}"
    placeholder="Description (optional). When to use it, what it counters."
    aria-label="Army description">${esc(description || '')}</textarea>`;

/**
 * Tag chips with remove buttons (`removeAttr` is the buttons' data attribute) and an input for new tags. With
 * `suggestions` it brings its own suggestion list; without, `listId` names one already on the page.
 */
export function tagEditor(tags, { attrs, removeAttr, listId, suggestions }) {
  const chips = tags.map((t) => `<span class="tag-chip">${esc(t)}<button ${removeAttr}="${esc(t)}"
    aria-label="Remove tag ${esc(t)}">×</button></span>`).join('');
  const list = suggestions
    ? `<datalist id="${listId}">${suggestions.filter((t) => !tags.some((x) =>
      x.toLowerCase() === t.toLowerCase())).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`
    : '';
  return `<div class="tag-editor" aria-label="Tags">${chips}
    <input ${attributes(attrs)} list="${listId}" maxlength="${LIMITS.tag}"
      placeholder="${tags.length ? 'Add a tag' : 'Tags (optional). Press Enter after each.'}">
    ${list}
  </div>`;
}

/** Tags in use, most used first: the saved armies' (from the server) and the draft's. */
function tagsInUse() {
  const used = (state.armyTags || []).map((t) => t.tag);
  return [...used, ...(builder.draft?.tags || []).filter((t) => !used.some((x) => x.toLowerCase() === t.toLowerCase()))];
}

// The server keeps the draft (drafts.json, one per account). Saves wait a moment, so typing makes one save.
function loadDraft() {
  const d = state.draft;
  builder.draft = d && Array.isArray(d.minis) ? { ...emptyDraft(), ...d } : emptyDraft();
}

let draftTimer = null;
let draftPending = null;
function saveDraftLocal() {
  draftPending = { account: state.account, draft: JSON.parse(JSON.stringify(builder.draft)) };
  state.draft = draftPending.draft; // keep the local copy current
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}
/** Saves the army being edited now, without the short wait (also before the window closes, web/scripts/closing.js). */
export async function flushDraft() {
  clearTimeout(draftTimer);
  const job = draftPending;
  draftPending = null;
  if (!job) return;
  try {
    await post('/api/draft', job);
  } catch {
    draftPending = draftPending || job;
    draftTimer = setTimeout(flushDraft, 3 * SECOND);
  }
}
// Save the last edit when the page closes.
window.addEventListener('pagehide', () => {
  if (!draftPending) return;
  navigator.sendBeacon?.('/api/draft', new Blob([JSON.stringify(draftPending)], { type: 'application/json' }));
});

/** The mini in slot i of the draft, by its key; slot 0 is the leader. */
const draftSlug = (i) => (i === 0 ? builder.draft.leader : builder.draft.minis[i - 1]);
/** The player's unit in slot i of the draft, or nothing for an empty slot or a mini the account doesn't own. */
function draftUnit(i) {
  return ownedUnit(draftSlug(i));
}

/**
 * An army's leader for its board: the player's unit, or for a leader the account doesn't own (an imported army) a
 * stand-in with the slots every such leader has. Nothing for an empty leader slot.
 */
const boardLeader = (slug) => ownedUnit(slug)
  || (BY_SLUG.get(slug)?.category === 'Leader' ? { id: null, slug, army: null, unowned: true } : null);
/** The draft's leader, as boardLeader gives it. */
export const draftLeader = () => boardLeader(builder.draft.leader);
const equippedTalent = (u) => talentIndex(builder.draft, miniOf(u), u);

/**
 * An army's slots (the leader first), each with its mini, the player's unit, the level it plays at there and its
 * talent; and the average level and cost, and the minis the account doesn't own.
 */
export function armyStats(army) {
  const leader = boardLeader(army.leader);
  const slots = [army.leader, ...army.minis].map((slug, i) => {
    const m = slug ? BY_SLUG.get(slug) : null;
    const u = slug ? ownedUnit(slug) : null;
    const lv = leader ? levelInSlot(u, leader, i) : { level: u && !u.synthetic ? u.level : null, match: false, bonus: 0 };
    const ti = talentIndex(army, m, u);
    return { slug, m, u, lv, level: lv.level, bonus: lv.bonus || 0, ti, talent: m && ti != null ? m.talents[ti] : null };
  });
  const filled = slots.filter((s) => s.m);
  const levels = filled.map((s) => s.level).filter((x) => x != null);
  return {
    slots,
    avgLevel: levels.length ? (levels.reduce((x, y) => x + y, 0) / levels.length).toFixed(1) : '–',
    avgCost: filled.length ? (filled.reduce((x, s) => x + s.m.cost, 0) / filled.length).toFixed(1) : '–',
    missing: filled.filter((s) => !s.u).map((s) => s.m.name),
  };
}

// Rendering
function armyToolbar(d) {
  const saved = state.savedArmies || [];
  const options = saved.map((a) => `<option value="${esc(a.id)}"
    ${a.id === d.id ? 'selected' : ''}>${esc(a.name)}${a.tags?.length ? ` · ${esc(a.tags.join(', '))}` : ''}</option>`).join('');
  return `<div class="army-toolbar panel">
    <label>Saved armies <select id="armySaved"><option value="">(unsaved)</option>${options}</select></label>
    ${nameField({ id: 'armyName' }, builder.nameText, d.id ? `Rename "${d.name}"` : 'Name this army')}
    <button class="button" data-army-action="save">${d.id ? 'Save' : 'Save as new'}</button>
    ${d.id ? '<button class="chip" data-army-action="saveas">Save as copy</button>' : ''}
    <button class="chip" data-army-action="new">New</button>
    ${d.id ? '<button class="chip danger" data-army-action="delete">Delete</button>' : ''}
    <div class="army-meta">
      ${descriptionField({ id: 'armyDesc' }, d.description)}
      ${tagEditor(d.tags || [], { attrs: { id: 'armyTagInput' }, removeAttr: 'data-army-tag-remove', listId: 'armyTagList',
        suggestions: tagsInUse() })}
    </div>
    <span class="code-box">
      <input id="armyCode" class="mono" placeholder="Paste an army code" aria-label="Army code"
        value="${esc(builder.codeText || '')}">
      <button class="chip" data-army-action="import">Import code</button>
      <button class="chip" data-army-action="export">Copy code</button>
    </span>
    ${builder.codeMsg ? `<span class="small ${builder.codeMsg.ok ? 'text-good' : 'text-warn'}">${esc(builder.codeMsg.text)}</span>` : ''}
  </div>`;
}

/** One board slot, with its type and tier from the leader's army board and the mini in it. */
function armySlot(i, s, leader) {
  // Without a leader the slots have no type yet.
  const slot = leader ? armyOf(leader)[i] : { type: i === 0 ? 'Leader' : '', tier: 0, boost: false };
  const tier = RULES.armySlots.tiers[slot.tier];
  const { m, u, lv, ti, talent } = s;
  const typeLabel = i === 0 ? 'Leader' : slot.type || (leader ? 'Type not set' : '–');
  const typeIcon = TAG_ICONS[typeLabel];
  const noSynergy = u && i > 0 && leader && !lv.match;
  const cls = `army-slot tier-${slot.tier}${i === 0 ? ' army-slot-leader' : ''}${u ? '' : ' empty'}${noSynergy ? ' no-synergy' : ''}`;
  const empty = i === 0 ? 'Drop or pick a leader' : leader ? 'Drop or pick a mini' : 'Pick a leader first';
  const level = u && lv.level != null
    ? `<b>${lv.level}</b>${lv.xpMax ? '<span class="max">MAX</span>' : ''}${lv.boosted ? '<span class="max boost">BOOST</span>' : ''}`
    : u ? '<span class="muted">–</span>' : '';
  const talentButton = u && talent
    ? `<button class="army-talent${effectivePicks(u).includes(ti) ? '' : ' locked'}" data-army-talent="${i}"
      title="Talent: ${esc(talent.name)}. Click to choose another.">${iconImage(talent.icon,
      talent.name).replace('class="icon"', 'class="icon talent-icon"')}</button>`
    : '';
  return `<div class="${cls}" data-army-drop-slot="${i}" style="--rarity-color:${u ? rarityColor(u.rarity) : 'var(--line)'}">
    <div class="army-slot-head${typeIcon ? ' has-icon' : ''}" title="${esc(typeLabel)} · ${tier.name}${tier.bonus
      ? ` +${tier.bonus}` : ''}${slot.boost ? ' · Boost' : ''}">
      ${typeIcon ? `<span class="medal">${iconImage(typeIcon, typeLabel)}</span>` : ''}<span
        class="army-slot-label">${esc(typeLabel)}</span>${slot.boost ? '<span class="boost-mark">⚡</span>' : ''}
    </div>
    <button class="army-slot-body" data-army-slot="${i}" ${m && i > 0 ? 'draggable="true"' : ''}
      aria-label="${m ? `Remove ${esc(m.name)}` : 'Empty slot'}" title="${m
      ? `Click to remove it${u ? ', right-click for details' : ''}` : ''}">
      ${m ? familyFlag(m) : ''}
      ${m ? `<img class="portrait" src="/static/${m.art}" alt="" draggable="false">` : '<span class="add">+</span>'}
      ${m ? `<span class="cost">${m.cost}</span>` : ''}
      ${lv.match && lv.bonus ? `<span class="slot-bonus" title="Slot bonus +${lv.bonus}">▲${lv.bonus}</span>` : ''}
      ${m ? `<span class="army-slot-name">${esc(m.name)}</span>` : `<span class="army-slot-name muted">${empty}</span>`}
    </button>
    <div class="army-slot-foot">${level}${talentButton}</div>
    ${builder.talentPop === i && u && talent ? talentPopup(i, u) : ''}
  </div>`;
}

/** Hints under the board about missing slot setup, minis that miss a slot's bonus and minis the account doesn't own. */
function armyNotes(stats, leader) {
  const notes = [];
  if (leader && !leader.army && !leader.unowned) {
    notes.push(`${esc(miniOf(leader).name)}'s army slots aren't set yet. Set their types and tiers in the leader's panel.`);
  }
  if (leader) {
    stats.slots.forEach((s, i) => {
      if (i === 0 || !s.u || s.u.synthetic) return;
      const slot = armyOf(leader)[i];
      if (!s.lv.match && slot.tier > 0) {
        const bonus = RULES.armySlots.tiers[slot.tier].bonus;
        notes.push(`${esc(s.m.name)} isn't a ${esc(slot.type || 'matching')} mini, so it doesn't get this slot's +${bonus} bonus.`);
      }
    });
  }
  if (stats.missing.length) notes.push(`Not owned on this account: ${stats.missing.map(esc).join(', ')}.`);
  return notes.length ? `<ul class="army-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '';
}

export function renderArmy() {
  if (!state) return;
  if (!builder.draft || builder.draftAccount !== state.account) {
    if (draftPending && draftPending.account !== state.account) flushDraft(); // save the previous account's draft first
    loadDraft();
    builder.draftAccount = state.account;
  }
  const d = builder.draft;
  const leader = draftLeader();
  const stats = armyStats(d);
  const page = $('#tab-army');
  // the tab is drawn anew: the lists stay where they were scrolled to, and the focus on the button it was on
  const scrolled = POOLS.map((kind) => $(`#pool-grid-${kind}`)?.scrollTop || 0);
  const focused = focusKey(page);
  page.innerHTML = `${armyToolbar(d)}
    <div class="army-wrap panel board-${leader ? String(familiesOf(miniOf(leader))[0]).toLowerCase() : 'neutral'}">
      <div class="army-head">
        <div class="army-stat" title="Average level"><span class="hex">⬢</span>${stats.avgLevel}</div>
        <h2 class="army-title">${leader ? `${esc(miniOf(leader).name)}'s Army` : 'New army'}</h2>
        <div class="army-head-right">
          <div class="army-stat" title="Average gold cost"><span class="gold">●</span>${stats.avgCost}</div>
          <button class="chip danger" data-army-action="clear" title="Remove the leader and all minis">Clear army</button>
        </div>
      </div>
      <div class="army-board">${stats.slots.map((s, i) => armySlot(i, s, leader)).join('')}</div>
      ${armyNotes(stats, leader)}
      <div class="small muted">Drag or click cards to add them, drag between slots to swap, or drag back down to remove.
        A mini's level in a slot is its XP level + rarity + talents, plus the slot's tier bonus if it matches the slot
        type (Wildcard matches all). A Boost slot counts as XP level ${RULES.maxXpLevel}.</div>
    </div>
    <div class="army-pools" data-army-drop-remove>
      <section class="panel pool" id="pool-leaders"></section>
      <section class="panel pool" id="pool-units"></section>
    </div>`;
  POOLS.forEach((kind, i) => renderPool(kind, scrolled[i]));
  refocus(page, focused);
}

const POOLS = ['leaders', 'units'];

// Placing minis
function placeLeader(slug) {
  builder.draft.leader = slug;
  saveDraftLocal();
  renderArmy();
}

/** Places a mini in slot i (1-6), swapping if it is already on the board. */
function placeMini(slug, i) {
  const d = builder.draft;
  const prev = d.minis[i - 1];
  const at = d.minis.indexOf(slug);
  if (at >= 0) d.minis[at] = prev;
  d.minis[i - 1] = slug;
  saveDraftLocal();
  renderArmy();
}

/** Adds a pool card. A leader replaces the leader; a mini takes the best empty slot. */
export function addFromPool(slug, kind) {
  const d = builder.draft;
  if (kind === 'leaders') return placeLeader(slug);
  if (d.minis.includes(slug)) {
    d.minis[d.minis.indexOf(slug)] = null;
    saveDraftLocal();
    return renderArmy();
  }
  const empty = d.minis.map((s, k) => (s ? null : k + 1)).filter((x) => x != null);
  if (!empty.length) {
    builder.codeMsg = { ok: false, text: 'The army is full. Drag a mini onto a slot to replace it.' };
    return renderArmy();
  }
  // Matching slot first, then Wildcard, then any empty slot.
  const m = miniOf(ownedUnit(slug));
  const fits = matchingSlots(m).filter((i) => empty.includes(i));
  const wild = matchingSlots(m, true).filter((i) => empty.includes(i));
  placeMini(slug, fits[0] ?? wild[0] ?? empty[0]);
}

function swapSlots(a, b) {
  const d = builder.draft;
  [d.minis[a - 1], d.minis[b - 1]] = [d.minis[b - 1], d.minis[a - 1]];
  saveDraftLocal();
  renderArmy();
}

function removeSlot(i) {
  builder.draft.minis[i - 1] = null;
  saveDraftLocal();
  renderArmy();
}

// Talent pop-up
function talentPopup(i, u) {
  const m = miniOf(u);
  const owned = new Set(effectivePicks(u));
  const current = equippedTalent(u);
  return `<div class="talent-popup" role="dialog" aria-label="Choose a talent for ${esc(m.name)}">
    <div class="talent-popup-title">${esc(m.name)}: talent</div>
    ${m.talents.map((t, k) => `<button class="talent-option${k === current ? ' on' : ''}${owned.has(k) ? '' : ' locked'}"
      data-army-talent-pick="${k}">
      <img src="/static/${t.icon}" alt="">
      <span><b>${esc(t.name)}</b>${owned.has(k) ? '' : ' <small class="muted">(not unlocked)</small>'}<span
        class="small description">${esc(t.description)}</span></span>
    </button>`).join('')}
  </div>`;
}

// Saving
/** Saves one army: a new one, or over the saved army with its ID. */
export async function persistArmy(army) {
  await post('/api/armies/save', { account: state.account, army });
  await poll();
}

/** Replaces the draft, saves it and redraws the board. */
function setDraft(draft) {
  builder.draft = draft;
  saveDraftLocal();
  renderArmy();
}

/** Empties the board but keeps the name and the saved army. */
function clearBoard() {
  builder.talentPop = null;
  setDraft({ ...builder.draft, leader: null, minis: [null, null, null, null, null, null], talents: {} });
}

async function importCode() {
  const text = ($('#armyCode')?.value || '').trim();
  builder.codeText = text;
  try {
    const army = await decodeArmyCode(text);
    builder.codeMsg = { ok: true, text: 'Army imported.' };
    // a failed import keeps the text for correction
    builder.codeText = '';
    setDraft({ ...emptyDraft(), name: 'Imported army', ...army });
  } catch (err) {
    builder.codeMsg = { ok: false, text: err.message || 'Could not read that code.' };
    renderArmy();
  }
}

async function exportCode() {
  try {
    const code = await encodeArmyCode(builder.draft);
    builder.codeText = code;
    builder.codeMsg = { ok: true, text: (await copyText(code)) ? 'Code copied.' : 'Code ready. Copy it from the box.' };
  } catch (err) {
    builder.codeMsg = { ok: false, text: err.message };
  }
  renderArmy();
}

async function deleteSaved() {
  if (builder.draft.id && await deleteSavedArmy(builder.draft)) renderArmy();
}

/** Saves the draft, over its saved army or (`asNew`, or when it has none) as a new one. */
async function saveArmy(asNew) {
  const d = builder.draft;
  const list = [...(state.savedArmies || [])];
  const replace = !asNew && d.id;
  const id = replace ? d.id : newId();
  // the typed name, else the saved name, else a generated one
  const leaderName = d.leader ? BY_SLUG.get(d.leader)?.name : null;
  const fallback = replace ? d.name : `${leaderName ? `${leaderName} army` : 'Army'} ${list.length + 1}`;
  const name = ($('#armyName')?.value || '').trim() || fallback;
  // a tag typed but not confirmed with Enter is kept too
  const tags = withTag(d.tags || [], $('#armyTagInput')?.value || '', tagsInUse()) || d.tags || [];
  await persistArmy({ id, name, leader: d.leader, minis: d.minis, talents: d.talents, description: d.description || '', tags });
  builder.nameText = '';
  builder.codeMsg = { ok: true, text: `Saved "${name}".` };
  setDraft({ ...d, id, name, tags });
}

async function runArmyAction(name) {
  try {
    await ARMY_ACTIONS[name]?.();
  } catch (err) {
    alertDialog(err.message, { title: 'Something went wrong' });
  }
}

// what the toolbar's buttons do (data-army-action)
const ARMY_ACTIONS = {
  new: () => {
    builder.nameText = '';
    setDraft(emptyDraft());
  },
  clear: clearBoard,
  import: importCode,
  export: exportCode,
  delete: deleteSaved,
  save: () => saveArmy(false),
  saveas: () => saveArmy(true),
};

function closePopups() {
  if (builder.talentPop == null) return;
  builder.talentPop = null;
  renderArmy();
}

/** Clicks on the board: slots, talents, tags and the action buttons. */
function boardClick(t) {
  if (t.dataset.armyTagRemove != null) {
    builder.draft.tags = (builder.draft.tags || []).filter((x) => x !== t.dataset.armyTagRemove);
    saveDraftLocal();
    renderArmy();
  } else if (t.dataset.armyTalentPick != null) {
    builder.draft.talents[draftUnit(builder.talentPop).slug] = Number(t.dataset.armyTalentPick);
    builder.talentPop = null;
    saveDraftLocal();
    renderArmy();
  } else if (t.dataset.armyTalent != null) {
    const i = Number(t.dataset.armyTalent);
    builder.talentPop = builder.talentPop === i ? null : i;
    renderArmy();
  } else if (t.dataset.armySlot != null) {
    // Clicking a filled slot empties it.
    const i = Number(t.dataset.armySlot);
    if (!draftSlug(i)) return;
    if (i > 0) return removeSlot(i);
    builder.draft.leader = null;
    saveDraftLocal();
    renderArmy();
  } else if (t.dataset.armyAction) {
    runArmyAction(t.dataset.armyAction);
  }
}

/** Typing in the tag box (tagKey in lib/limits.js), the description and the pool searches. */
function bindTyping(page) {
  page.addEventListener('keydown', (e) => {
    if (e.target.id !== 'armyTagInput') return;
    const next = tagKey(e, builder.draft.tags || [], tagsInUse());
    if (!next) return;
    builder.draft.tags = next;
    saveDraftLocal();
    renderArmy(); // (the tag box keeps the focus)
  });
  page.addEventListener('input', (e) => {
    if (e.target.id === 'armyDesc') {
      builder.draft.description = e.target.value;
      saveDraftLocal(); // saved without a redraw, so typing isn't interrupted
      return;
    }
    const kind = e.target.dataset?.poolSearch;
    if (!kind) return;
    const p = pools()[kind];
    p.q = e.target.value;
    // Only the tiles are redrawn while typing, so Clear filters is updated here.
    renderPoolGrid(kind);
    const clear = $(`#pool-${kind} [data-pool-clear]`);
    if (clear) clear.disabled = !poolFiltered(kind);
  });
}

/** Dragging minis from the pools onto the board, between slots, or off the board. */
function bindDragAndDrop(page) {
  let drag = null; // { slug, kind: 'leaders'|'units' } or { fromSlot }
  const canDrop = (i) => {
    if (!drag) return false;
    if (drag.fromSlot != null) return i > 0 && i !== drag.fromSlot;
    if (drag.kind === 'leaders') return i === 0;
    return i > 0 && !!draftLeader();
  };
  page.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-pool-slug]');
    const fromBoard = e.target.closest('[data-army-slot][draggable="true"]'); // (a slot with a mini in it)
    if (card) drag = { slug: card.dataset.poolSlug, kind: card.dataset.poolKind };
    else if (fromBoard) drag = { fromSlot: Number(fromBoard.dataset.armySlot) };
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.slug || `slot:${drag.fromSlot}`);
    page.classList.add('dragging');
    for (const s of page.querySelectorAll('[data-army-drop-slot]')) s.classList.toggle('drop-ok', canDrop(Number(s.dataset.armyDropSlot)));
  });
  page.addEventListener('dragend', () => {
    drag = null;
    page.classList.remove('dragging');
    for (const s of page.querySelectorAll('.drop-ok,.drop-hover')) s.classList.remove('drop-ok', 'drop-hover');
  });
  page.addEventListener('dragover', (e) => {
    const slot = e.target.closest('[data-army-drop-slot]');
    const remove = !slot && drag?.fromSlot != null && e.target.closest('[data-army-drop-remove]');
    if (!(slot && canDrop(Number(slot.dataset.armyDropSlot))) && !remove) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    for (const s of page.querySelectorAll('.drop-hover')) if (s !== slot) s.classList.remove('drop-hover');
    slot?.classList.add('drop-hover');
  });
  page.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const slot = e.target.closest('[data-army-drop-slot]');
    const d = drag;
    drag = null;
    if (slot) {
      const i = Number(slot.dataset.armyDropSlot);
      if (d.fromSlot != null) swapSlots(d.fromSlot, i);
      else if (d.kind === 'leaders') placeLeader(d.slug);
      else placeMini(d.slug, i);
    } else if (d.fromSlot != null) removeSlot(d.fromSlot);
  });
}

// What a click on the Army tab can act on: the board, the talent pop-up, the pools and the tags.
const CLICKABLE = [
  'data-army-slot', 'data-army-talent', 'data-army-talent-pick', 'data-army-action', 'data-pool-slug', 'data-pool-family', 'data-pool-type',
  'data-pool-clear', 'data-army-tag-remove',
].map((a) => `[${a}]`).join(',');

export function bindArmy() {
  const page = $('#tab-army');
  bindTyping(page);
  bindDragAndDrop(page);
  for (const kind of ['leaders', 'units']) {
    // Opening one pool's picker closes the other's.
    const show = (open) => {
      builder.poolTraitOpen = open ? kind : null;
      builder.poolTraitQ[kind] = '';
      renderPool('leaders');
      renderPool('units');
    };
    bindTraitPicker(page, kind, {
      isOpen: () => builder.poolTraitOpen === kind,
      toggle: () => show(builder.poolTraitOpen !== kind),
      close: () => show(false),
      mode: (mode) => updatePool(kind, (p) => { p.traitMode = mode; }),
      clear: () => updatePool(kind, (p) => { p.traits = []; }),
      tick: (name) => updatePool(kind, (p) => toggleIn(p.traits, name)),
      search: (text) => { builder.poolTraitQ[kind] = text; },
    });
  }
  // right-click opens the mini's details
  page.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-pool-slug]');
    const slot = e.target.closest('[data-army-slot]');
    const u = card ? ownedUnit(card.dataset.poolSlug) : slot ? draftUnit(Number(slot.dataset.armySlot)) : null;
    if (!u) return;
    e.preventDefault();
    openDrawer({ kind: 'unit', id: u.id });
  });
  page.addEventListener('click', (e) => {
    // A click outside an open pop-up closes it.
    if (!e.target.closest('.talent-popup,[data-army-talent]')) closePopups();
    const t = e.target.closest(CLICKABLE);
    if (t && !poolClick(t)) boardClick(t);
  });
  page.addEventListener('change', (e) => {
    const d = e.target.dataset || {};
    if (d.poolSort) {
      pools()[d.poolSort].sort = e.target.value;
      savePools();
      renderPoolGrid(d.poolSort);
    } else if (e.target.id === 'armySaved') {
      const saved = (state.savedArmies || []).find((x) => x.id === e.target.value);
      builder.draft = saved ? { ...emptyDraft(), ...structuredClone(saved) } : { ...builder.draft, id: null };
      builder.nameText = '';
      saveDraftLocal();
      renderArmy();
    } else if (e.target.id === 'armyName') {
      builder.nameText = e.target.value; // cleared on save
    }
  });
  // (not an Esc the side panel took: that one closes the panel alone)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) closePopups(); });
}

/** Opens a saved army in the builder (the Armory's Edit). */
export function editArmy(saved) {
  builder.draft = { ...emptyDraft(), ...structuredClone(saved) };
  builder.draftAccount = state.account;
  builder.nameText = '';
  builder.codeMsg = { ok: true, text: `Editing "${saved.name}". Save it to update the Armory.` };
  saveDraftLocal();
}

/** The Armory changed a saved army: the builder's copy follows. */
export function syncDraft(id, change) {
  if (builder.draft?.id !== id) return;
  Object.assign(builder.draft, change);
  saveDraftLocal();
}

/** Asks, then deletes a saved army; a draft editing it becomes a new army. Returns whether it was deleted. */
export async function deleteSavedArmy(army) {
  const ok = await confirmDialog(`"${army.name}" is removed from your saved armies.`,
    { title: 'Delete this army?', ok: 'Delete', danger: true });
  if (!ok) return false;
  await post('/api/armies/delete', { account: state.account, id: army.id });
  await poll();
  if (builder.draft?.id === army.id) {
    builder.draft = { ...builder.draft, id: null };
    saveDraftLocal();
  }
  return true;
}

/** After a restore the draft is loaded again from the restored data. */
export function forgetDraft() { builder.draft = null; }
