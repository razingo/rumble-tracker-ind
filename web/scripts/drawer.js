// The side panel for one mini: its stats and talents, which mini a new unit is, and a leader's army slots.
import { poll } from './app.js';
import { unitNameForm } from './collection.js';
import { $, post, RULES, BY_SLUG, TAG_ICONS, state } from './core.js';
import { alertDialog } from './dialogs.js';
import { esc, fmt, plural } from './lib/format.js';
import { rarityName, rarityColor, miniOf, unitName, balance, currencyName, coreName, nextUpgrade, talentSlots,
  allTalentsOwned, effectivePicks, xpToMax, isLeader, fixedSlot, slotLocked, bottomSlotOptions, armyOf,
  leaderSlotBonus, totalLevel, armyTotals } from './units.js';

// The item shown in the side panel ({ kind: 'unit', id } or { kind: 'mini', slug }) and the level its stats preview.
export const panel = { open: null, previewLevel: null };
export const iconImage = (path, title = '') => (path ? `<img class="icon" src="/static/${path}" alt="" title="${esc(title)}">` : '');
const tag = (name) => `<span class="tag-pill">${iconImage(TAG_ICONS[name], name)}${esc(name)}</span>`;
function statRows(m, level) {
  return Object.entries(m.stats).map(([k, v]) => {
    const val = Array.isArray(v) ? v[Math.min(v.length, level) - 1] : v;
    return `<tr><td>${esc(k)}</td><td>${esc(typeof val === 'number' ? fmt(val) : val)}</td></tr>`;
  }).join('');
}

function armyEditor(u, m) {
  const A = RULES.armySlots;
  const slots = armyOf(u);
  const bottom = bottomSlotOptions(u);
  const cells = slots.map((s, i) => {
    const t = A.tiers[s.tier];
    const isLeaderSlot = i === A.leaderSlot;
    const fixed3 = i === 3 ? fixedSlot(u, 3) : null;
    // Slot 3 takes the fixed type or Wildcard; slots 4-6 take the board's types, each once at most.
    const takenElsewhere = new Set(slots.filter((x, k) => k >= 4 && k !== i && x.type).map((x) => x.type));
    const opts = fixed3 ? [fixed3, 'Wildcard']
      : i === 3 ? ['Wildcard', ...bottom]
        : bottom.filter((o) => !takenElsewhere.has(o) || o === s.type);
    const typeCtl = isLeaderSlot
      ? `<div class="slot-type">${iconImage(TAG_ICONS.Leader, 'Leader')}Leader</div>`
      : slotLocked(u, i)
        ? `<div class="slot-type" title="Set by this leader">${iconImage(TAG_ICONS[s.type], s.type)}${esc(s.type)} <span
          class="lock" aria-label="Set by this leader">🔒</span></div>`
        : `<label class="slot-type">${s.type ? iconImage(TAG_ICONS[s.type], s.type) : ''}
          <select data-army-type="${i}" aria-label="Slot ${i} type">${fixed3
            ? '' : '<option value="">Type…</option>'}${opts.map((o) =>
            `<option ${o === s.type ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    const tierBtns = A.tiers.map((tt, k) => `<button class="tier-button" style="--type-color:${tt.color}"
      aria-pressed="${k === s.tier}" data-army-tier-slot="${i}" data-army-tier="${k}"
      title="${tt.name}${tt.bonus ? ` +${tt.bonus}` : ''}">${tt.name[0]}</button>`).join('');
    const boostCtl = i === A.boostSlot
      ? `<button class="boost-button" aria-pressed="${s.boost}" data-army-boost="${i}"
        title="The mini here plays at XP level 20">${s.boost ? '⚡ Boost' : '+ Boost'}</button>`
      : '';
    return `<div class="slot${isLeaderSlot ? ' leader-slot' : ''}${s.boost ? ' boosted' : ''}" style="--type-color:${t.color}">
      ${typeCtl}
      <div class="slot-tier">${t.name}${t.bonus ? ` · +${plural(t.bonus, 'level')}` : ''}${s.boost
        ? ' · XP level 20' : ''}</div>
      <div class="tier-btns">${tierBtns}</div>
      ${boostCtl}
    </div>`;
  }).join('');
  const a = armyTotals([u]);
  return `<h3>Army slots</h3>
    <div class="army-grid">${cells}</div>
    <div class="small">${m.fixedArmySlots ? 'Top row fixed for this leader (the third can become Wildcard). '
      : 'This leader\'s top row isn\'t known yet, so every slot is editable. '}Copy the tiers from the game's Army
      screen. Bronze to Gold come from Dungeons, Sieges and Raids; Gold to Diamond costs ${a.cost} ${currencyName('valor')}.</div>
    <div class="note">${a.notDiamond === 0
      ? `All ${a.slots} slots are Diamond.`
      : `${a.diamonds}/${a.slots} Diamond · ${plural(a.goldReady, 'Gold slot')} ready ·
        ${fmt(a.notDiamond * a.cost)} ${currencyName('valor')} to make this army all Diamond`}</div>`;
}

async function saveArmy(u, slots) {
  try {
    await post('/api/army', { account: state.account, unitId: u.id, slots });
    u.army = slots;
    await poll();
    renderDrawer();
  } catch (err) {
    alertDialog(err.message, { title: 'Not saved' });
  }
}

function drawerHead(u, m) {
  return `<button class="close" data-close aria-label="Close">×</button>
  <div class="drawer-head" style="--rarity-color:${u ? rarityColor(u.rarity) : 'var(--line)'}">
    ${m ? `<img src="/static/${m.art}" alt="">` : '<div class="art unknown">?</div>'}
    <div><h2 id="drawerTitle">${esc(m ? m.name : unitName(u))}</h2>
    <div class="muted">${m ? `${m.category} · ${m.cost} gold` : 'Not identified yet'}</div>
    ${m ? `<div class="tags">${[m.family, ...String(m.role).split(',')].map(tag).join('')}</div>` : ''}
    ${u && !u.synthetic ? `<div class="muted">${rarityName(u.rarity)} · level ${totalLevel(u)}</div>` : ''}</div></div>`;
}

/** Level, XP, stars and talent slots of an owned unit. */
function progressSection(u) {
  const slots = talentSlots(u);
  const up = nextUpgrade(u);
  const leaderSlot = isLeader(u) ? ` + ${leaderSlotBonus(u)} Leader slot
    (${RULES.armySlots.tiers[armyOf(u)[RULES.armySlots.leaderSlot].tier].name})` : '';
  const nextTalent = u.talents < slots
    ? ` · next costs ${RULES.talentCostCoins} ${currencyName('coins')} (have ${fmt(balance('coins'))})` : '';
  return `<h3>Progress</h3><dl class="key-values">
    <dt>Level</dt><dd>${totalLevel(u)} = XP level ${u.xpLevel} + ${u.rarity} rarity + ${plural(u.talents, 'talent')}${leaderSlot}</dd>
    <dt>XP</dt><dd>${u.xpLevel >= RULES.maxXpLevel ? 'Max XP level'
      : `${fmt(u.xp)} / ${fmt(u.xpNeeded)} · ${fmt(xpToMax(u))} XP to level 20`}</dd>
    <dt>Stars</dt><dd>${up ? `${u.stars} / ${up.stars}` : `${u.stars} (max rarity)`}</dd>
    <dt>Talent slots</dt><dd>${u.talents} bought of ${slots} unlocked${nextTalent}</dd>
  </dl>`;
}

/** What the next rarity costs and whether the account has it. */
function upgradeSection(u, up) {
  const have = (ok, text) => `<span class="${ok ? 'text-good' : 'text-warn'}">${text}</span>`;
  const slotsNow = RULES.talentSlotsByRarity[u.rarity] ?? 0;
  const slotsNext = RULES.talentSlotsByRarity[up.to] ?? 0;
  return `<h3>Next upgrade: ${rarityName(up.to)}</h3><div class="note">
    ${have(up.starsOk, `${up.stars} stars (have ${u.stars})`)} ·
    ${have(up.arcOk, `${fmt(up.arcEnergy)} ${currencyName('arcEnergy')} (have ${fmt(balance('arcEnergy'))})`)}
    ${up.core ? ` · ${have(up.coreOk, `1 ${coreName(up.core)} (have ${fmt(balance(up.core))})`)}` : ''}
    <br><b>${up.ready ? 'Ready to upgrade' : 'Not ready yet'}</b> · +1
    level${slotsNext > slotsNow ? ` and talent slot ${slotsNext}` : ' (no new talent slot)'}</div>`;
}

/** The mini's talents, with the ones the player picked ticked. */
function talentsSection(u, m) {
  const picks = new Set(u ? effectivePicks(u) : []);
  const owned = u ? u.talents : 0;
  const auto = u && allTalentsOwned(u);
  let note = '';
  if (!u) note = '<div class="note">You don\'t own this mini (or it isn\'t identified yet).</div>';
  else if (auto) note = '<div class="note">You own every talent for this mini, so they\'re all ticked automatically.</div>';
  else if (owned === 0) {
    note = `<div class="note">No talents bought yet.
      ${talentSlots(u) ? 'A slot is open, and talents appear in the G.R.I.D.' : 'Upgrade to Uncommon to unlock the first slot.'}</div>`;
  } else if (picks.size !== owned) {
    note = `<div class="note warn">The game says you bought ${plural(owned, 'talent')} for this mini.
      Tick which ${owned === 1 ? 'one' : 'ones'}.</div>`;
  }
  return `<h3>Talents</h3>${note}` + m.talents.map((t, i) => {
    const checked = picks.has(i);
    const disabled = !u || auto || owned === 0 || (!checked && picks.size >= owned);
    return `<label class="talent ${checked ? 'picked' : ''}">
      <input type="checkbox" data-drawer-talent="${i}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <img src="/static/${t.icon}" alt="">
      <div><b>${esc(t.name)}</b><div class="description small">${esc(t.description)}</div></div></label>`;
  }).join('');
}

/** A name and description, as used for traits (small text, with an icon) and the leader ability. */
const traitRow = (name, description, icon = '') => `<div class="trait">${icon}<div><b>${esc(name)}</b>
  <span class="description${icon ? ' small' : ''}">${esc(description)}</span></div></div>`;

function statsSection(m, level) {
  return `<h3>Stats at level <span id="levelOutput">${level}</span></h3>
    <input type="range" min="1" max="${RULES.maxLevel}" value="${level}" data-preview-level>
    <table class="stats-table">${statRows(m, level)}</table>
    ${m.weakAgainst ? `<div class="small">Weak against: ${esc(m.weakAgainst)}.</div>` : ''}`;
}

/** The side panel's sections for a unit (u) or a mini (m), in order. */
function drawerSections(u, m, level) {
  const parts = [drawerHead(u, m)];
  if (u && !m) {
    parts.push(`<h3>Which mini is this?</h3><div class="row">${unitNameForm(u)}</div>`);
  }
  if (m) parts.push(`<p class="description">${esc(m.description)}</p>`);
  if (u?.synthetic) {
    parts.push('<div class="note">Every player has this mini. It isn\'t stored in your save and has no levels, stars or '
      + 'talents to track.</div>');
  }
  if (u && !u.synthetic) {
    parts.push(progressSection(u));
    const up = nextUpgrade(u);
    if (up) parts.push(upgradeSection(u, up));
  }
  if (m?.talents.length) parts.push(talentsSection(u, m));
  if (m?.leaderAbility) parts.push(`<h3>Leader ability</h3>${traitRow(m.leaderAbility.name, m.leaderAbility.description)}`);
  if (u && isLeader(u)) parts.push(armyEditor(u, m));
  else if (m?.armySlotUpgrades?.length) {
    parts.push(`<h3>Army slot types</h3><div class="tags">${m.armySlotUpgrades.map(tag).join('')}</div>`);
  }
  if (m?.traits.length) parts.push('<h3>Traits</h3>' + m.traits.map((t) =>
    traitRow(t.name, t.description, iconImage(t.icon, t.name))).join(''));
  if (m) parts.push(statsSection(m, level));
  return parts.join('');
}

export function renderDrawer() {
  const drawer = $('#drawer');
  const body = $('.drawer-body', drawer);
  const u = panel.open.kind === 'unit' ? state.units.find((x) => x.id === panel.open.id) : null;
  if (panel.open.kind === 'unit' && !u) return closeDrawer();
  const m = u ? miniOf(u) : BY_SLUG.get(panel.open.slug);
  const level = panel.previewLevel ?? (u && !u.synthetic ? Math.max(1, Math.min(totalLevel(u), RULES.maxLevel)) : 1);
  // Keep the scroll position when redrawing the same mini.
  const key = JSON.stringify(panel.open);
  const keepScroll = body.dataset.key === key ? body.scrollTop : 0;
  body.innerHTML = drawerSections(u, m, level);
  body.dataset.key = key;
  body.scrollTop = keepScroll;
  body.style.setProperty('--rarity-color', u ? rarityColor(u.rarity) : 'var(--line)');
  drawer.hidden = false;
}

export function openDrawer(open) {
  panel.open = open;
  panel.previewLevel = null;
  renderDrawer();
}
function closeDrawer() {
  panel.open = null;
  delete $('.drawer-body').dataset.key;
  $('#drawer').hidden = true;
}

async function saveUnitName(id, select) {
  if (!select.value) return;
  try {
    await post('/api/name', { kind: 'unit', id, value: select.value });
    await poll();
  } catch (e) { alertDialog(e.message, { title: 'Not saved' }); }
}

export function bindDrawer() {
  const body = $('.drawer-body');
  const unit = () => state.units.find((x) => x.id === panel.open.id);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-unit-open],[data-mini-open],[data-unit-save],[data-close]');
    if (!t) return;
    if (t.dataset.unitOpen) openDrawer({ kind: 'unit', id: t.dataset.unitOpen });
    else if (t.dataset.miniOpen) openDrawer({ kind: 'mini', slug: t.dataset.miniOpen });
    else if (t.dataset.unitSave) saveUnitName(t.dataset.unitSave, $(`[data-unit-name="${t.dataset.unitSave}"]`, t.parentElement));
    else closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panel.open) return;
    e.preventDefault();
    closeDrawer();
  });
  // The level slider previews the stats at another level.
  body.addEventListener('input', (e) => {
    if (!e.target.matches('[data-preview-level]')) return;
    panel.previewLevel = Number(e.target.value);
    $('#levelOutput').textContent = panel.previewLevel;
    const m = panel.open.kind === 'unit' ? miniOf(unit()) : BY_SLUG.get(panel.open.slug);
    $('.stats-table').innerHTML = statRows(m, panel.previewLevel);
  });
  // A leader's army slots: tier and Boost buttons, type selects.
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-army-tier-slot],[data-army-boost]');
    if (!b || panel.open?.kind !== 'unit') return;
    const slots = armyOf(unit());
    if (b.dataset.armyBoost) slots[Number(b.dataset.armyBoost)].boost = !slots[Number(b.dataset.armyBoost)].boost;
    else slots[Number(b.dataset.armyTierSlot)].tier = Number(b.dataset.armyTier);
    saveArmy(unit(), slots);
  });
  body.addEventListener('change', async (e) => {
    if (panel.open?.kind !== 'unit') return;
    if (e.target.matches('[data-army-type]')) {
      const slots = armyOf(unit());
      slots[Number(e.target.dataset.armyType)].type = e.target.value;
      saveArmy(unit(), slots);
    } else if (e.target.matches('[data-drawer-talent]')) {
      const u = unit();
      const picks = [...body.querySelectorAll('[data-drawer-talent]:checked')].map((x) => Number(x.dataset.drawerTalent));
      try {
        await post('/api/talents', { account: state.account, unitId: u.id, picks });
        u.talentPicks = picks;
        await poll();
        renderDrawer();
      } catch (err) { alertDialog(err.message, { title: 'Not saved' }); }
    }
  });
}
