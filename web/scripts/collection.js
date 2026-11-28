// Collection tab: currencies, summary, what's needed next, the upgrade planner, filters, the mini grid and recent
// changes.
import { $, store, RULES, MINIS, TAG_ICONS, FAMILIES, state, focusKey, refocus } from './core.js';
import { iconImage } from './drawer.js';
import { esc, fmt, ago } from './lib/format.js';
import { traitPicker, bindTraitPicker } from './trait-picker.js';
import { rarityName, rarityColor, miniOf, unitName, balance, currencyName, coreName, nextUpgrade,
  talentSlots, effectivePicks, isLeader, armyOf, hasBoost, totalLevel, armyTotals, remainingToLegendary, familiesOf } from './units.js';

// The earlier tracker, whose data this one uses, saved these without the tab's name.
for (const key of ['filters', 'show', 'sort', 'planExpanded']) {
  store.rename(key, `collection${key[0].toUpperCase()}${key.slice(1)}`);
}

// What the Collection shows, kept between visits.
const view = {
  show: store.get('collectionShow', 'owned'),
  sort: store.get('collectionSort', 'level'),
  planExpanded: store.get('collectionPlanExpanded', false),
  filters: { types: [], families: [], traits: [], traitMode: 'all', ...store.get('collectionFilters', {}) },
  traitPickerOpen: false,
  traitSearch: '',
};

/** A currency chip with its icon, name and balance; the tooltip has the total earned. */
export function currencyChip(c) {
  const icon = RULES.currencyIcons?.[c.id];
  return `<div class="currency" title="${esc(c.name)} · earned all time: ${fmt(c.lifetime)}">${icon
    ? `<img class="currency-icon" src="/static/${icon}" alt="">` : ''}<span>${esc(c.name)}</span><b>${fmt(c.balance)}</b></div>`;
}

export function renderCurrencies() {
  // Event tickets, the Ankh (the Calendar's Dungeon card) and the G.R.I.D. currencies are on other tabs.
  // (game data read by an earlier version of the tracker doesn't say which those are)
  const elsewhere = [...(RULES.gridCurrencyIds || []), RULES.ankhId];
  const named = state.currencies.filter((c) => c.name && !c.slot && !elsewhere.includes(c.id));
  const order = ['coins', 'arcEnergy', 'rareCore', 'epicCore', 'legendaryCore', 'valor'].map((r) => RULES.currencyIds[r]);
  named.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  $('#currencies').innerHTML = named.map(currencyChip).join('');
}

export function renderSummary() {
  const units = state.units;
  const identified = units.filter((u) => u.slug).length;
  const ready = units.filter((u) => nextUpgrade(u)?.ready).length;
  const openSlots = units.reduce((n, u) => n + Math.max(0, talentSlots(u) - u.talents), 0);
  const picksMissing = units.filter((u) => u.talents > effectivePicks(u).length).length;
  const toLeg = { arcEnergy: 0, cores: {} };
  for (const u of units) {
    const r = remainingToLegendary(u);
    toLeg.arcEnergy += r.arcEnergy;
    for (const [k, v] of Object.entries(r.cores)) toLeg.cores[k] = (toLeg.cores[k] || 0) + v;
  }
  const coresText = Object.entries(toLeg.cores).map(([k, v]) => `${v} ${coreName(k).replace(/ Upgrade Core$/, '')}`).join(', ') || 'none';
  $('#summary').innerHTML = [
    ['Minis owned', `${units.length} / ${MINIS.length}`, `${identified} identified`],
    ['Upgrades ready now', ready, `enough stars, ${currencyName('arcEnergy')} and cores`],
    ['Open talent slots', openSlots, 'buy in the G.R.I.D.'],
    ['Talents to tick', picksMissing, 'minis with unrecorded talents'],
    [`${currencyName('arcEnergy')} to all legendary`, fmt(toLeg.arcEnergy), `upgrade cores: ${coresText}`],
    ...(() => {
      const a = armyTotals(units);
      if (!a.leaders) return [];
      return [[`${currencyName('valor')} for Diamond slots`, fmt(a.goldReady * a.cost),
        `${a.goldReady} Gold slot${a.goldReady === 1
          ? '' : 's'} ready · ${fmt(a.notDiamond * a.cost)} for all ${a.slots} · have ${fmt(balance('valor'))}`]];
    })(),
  ].map(([k, v, s]) => `<div class="stat-card"><div class="stat-label">${esc(k)}</div><div class="stat-value">${esc(v)}</div><div
    class="small">${esc(s)}</div></div>`).join('');
}

function lastEventFor(id) {
  for (let i = state.events.length - 1; i >= 0; i--) if (state.events[i].id === id) return state.events[i];
  return null;
}

/** The select and Save button that say which mini an unknown one is (also in its side panel). */
export const unitNameForm = (u) => `<select data-unit-name="${u.id}">${miniOptions()}</select>
  <button class="button" data-unit-save="${u.id}">Save</button>`;

/** Draws `root` anew with `draw`, and puts back what was chosen in each of its unitNameForm lists, not saved yet. */
export function keepUnitChoices(root, draw) {
  const chosen = [...root.querySelectorAll('select[data-unit-name]')].map((s) => [s.dataset.unitName, s.value]);
  draw();
  for (const [id, value] of chosen) {
    const select = root.querySelector(`select[data-unit-name="${CSS.escape(id)}"]`);
    if (!select || !value) continue;
    select.value = value;
    if (select.selectedIndex < 0) select.value = ''; // (that mini has been named meanwhile)
  }
}

function miniOptions() {
  const taken = new Set(state.units.map((u) => u.slug).filter(Boolean));
  const groups = { Unit: [], Leader: [], Spell: [] };
  for (const m of MINIS) if (!taken.has(m.slug)) groups[m.category].push(m);
  return '<option value="">Choose a mini…</option>' + Object.entries(groups)
    .map(([g, list]) => `<optgroup label="${g}s">${list.map((m) =>
      `<option value="${m.slug}">${esc(m.name)}</option>`).join('')}</optgroup>`)
    .join('');
}

export function renderNeeds() {
  const unknownUnits = state.units.filter((u) => !u.slug)
    .sort((a, b) => (lastEventFor(b.id)?.t || '').localeCompare(lastEventFor(a.id)?.t || ''));
  const rows = [];
  for (const u of unknownUnits.slice(0, 12)) {
    const ev = lastEventFor(u.id);
    rows.push(`<div class="row">
      <div class="what"><b>New mini (not in the tracker's data yet)</b> <span class="mono muted">${u.id.slice(0, 8)}</span><br>
        <span class="small">${rarityName(u.rarity)} · level ${totalLevel(u)} · XP level
          ${u.xpLevel}${u.xpLevel < RULES.maxXpLevel ? ` (${u.xp}/${u.xpNeeded})` : ' (max)'} · ${u.stars}
          stars${ev ? ` · last change: ${esc(eventText(ev))} ${ago(ev.t)}` : ''}</span></div>
      ${unitNameForm(u)}</div>`);
  }
  if (unknownUnits.length > 12) rows.push(`<div class="row small">…and ${unknownUnits.length - 12} more. Level up or
    upgrade a mini in the game and it moves to the top, ready to name.</div>`);
  // Shown only when something needs naming.
  const needs = $('#needs'), focused = focusKey(needs);
  needs.hidden = rows.length === 0;
  keepUnitChoices(needs, () => {
    needs.innerHTML = rows.length ? `<h2>Needs your input (${unknownUnits.length})</h2>${rows.join('')}` : '';
  });
  refocus(needs, focused);
}

const PLAN_SIZE = 8;

function planArt(u) {
  const m = miniOf(u);
  return m ? `<img src="/static/${m.art}" alt="" loading="lazy">` : '<div class="art unknown">?</div>';
}

function planRow(u, pct, label, togo, togoUnit, extra = '') {
  return `<button class="plan-row" style="--rarity-color:${rarityColor(u.rarity)}" data-unit-open="${u.id}">
    ${planArt(u)}
    <div><b>${esc(unitName(u))}</b> <span class="small">${esc(label)}</span>
      <div class="bar${togoUnit === 'stars' ? ' stars' : ''}"><span style="width:${pct}%"></span></div>${extra}</div>
    <div class="to-go">${fmt(togo)}<small>${togoUnit} to go</small></div>
  </button>`;
}

export function renderPlanner() {
  // The type and faction filters apply here; the trait filters only affect the grid.
  const pool = state.units.filter((u) => !u.synthetic && passes(miniOf(u), 'traits'));
  const narrowed = view.filters.types.length + shownFamilies().length > 0;

  const byXp = pool
    .filter((u) => u.xpLevel < RULES.maxXpLevel && u.xpNeeded > 0)
    .map((u) => ({ u, pct: u.xp / u.xpNeeded, togo: u.xpNeeded - u.xp }))
    .sort((a, b) => b.pct - a.pct || a.togo - b.togo)
    .slice(0, PLAN_SIZE);
  // One row per list until "Show more" opens up to PLAN_SIZE.
  const expanded = !!view.planExpanded;

  const byStars = pool
    .map((u) => ({ u, up: nextUpgrade(u) }))
    .filter(({ up }) => up)
    .map(({ u, up }) => ({ u, up, pct: Math.min(1, u.stars / up.stars), togo: Math.max(0, up.stars - u.stars) }))
    .sort((a, b) => b.pct - a.pct || a.togo - b.togo || a.up.arcEnergy - b.up.arcEnergy)
    .slice(0, PLAN_SIZE);

  const moreAvailable = byXp.length > 1 || byStars.length > 1;
  const shownXp = expanded ? byXp : byXp.slice(0, 1);
  const shownStars = expanded ? byStars : byStars.slice(0, 1);

  const xpHtml = shownXp.map(({ u, pct, togo }) =>
    planRow(u, Math.round(pct * 100), `XP level ${u.xpLevel} → ${u.xpLevel + 1} · ${fmt(u.xp)}/${fmt(u.xpNeeded)}`, togo, 'XP')).join('');

  const starsHtml = shownStars.map(({ u, up, pct, togo }) => {
    const costs = [`${fmt(up.arcEnergy)} ${currencyName('arcEnergy')}`,
      up.core ? `1 ${coreName(up.core)}` : null].filter(Boolean).join(' + ');
    const status = up.ready
      ? '<span class="flag good">Ready - upgrade now</span>'
      : togo === 0
        ? `<span class="flag warn">Stars done · need ${[!up.arcOk ? currencyName('arcEnergy') : '',
          !up.coreOk ? coreName(up.core) : ''].filter(Boolean).join(' + ')}</span>`
        : '';
    return planRow(u, Math.round(pct * 100), `${rarityName(u.rarity)} → ${rarityName(up.to)} · ${u.stars}/${up.stars} stars · ${costs}`,
      togo, 'stars',
      status ? `<div class="flags">${status}</div>` : '');
  }).join('');

  const empty = (txt) => `<div class="small">${pool.length ? txt : 'No owned minis match the filters.'}</div>`;
  const planner = $('#planner'), focused = focusKey(planner);
  planner.innerHTML = `<div class="planner-head"><h2>Closest to next step</h2>
      <span class="small">${narrowed ? `Filtered: ${pool.length} of ${state.units.length} minis`
        : `All ${state.units.length} minis`}</span></div>
    <div class="planner-cols">
      <div><h3>Next level (XP)</h3>${xpHtml || empty(`Every mini here is at XP level ${RULES.maxXpLevel}.`)}</div>
      <div><h3>Next rarity (stars)</h3>${starsHtml || empty('Every mini here is Legendary.')}</div>
    </div>
    ${moreAvailable ? `<div class="planner-more"><button class="chip" data-planner-toggle
      aria-expanded="${expanded}">${expanded ? 'Show less ▴' : `Show more (top ${PLAN_SIZE}) ▾`}</button></div>` : ''}`;
  refocus(planner, focused);
}

const TYPES = [['Unit', 'Units'], ['Leader', 'Leaders'], ['Spell', 'Spells'], ['unknown', 'New / unknown']];

export function allTraits() {
  const map = new Map();
  for (const m of MINIS) for (const t of m.traits) if (!map.has(t.name)) map.set(t.name, t);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The factions the Collection is filtered by: the chosen ones that have a filter button. */
const shownFamilies = () => view.filters.families.filter((x) => FAMILIES.includes(x));
/** Whether a mini (null when unidentified) passes the filters. `skip` leaves out one group, for the filter counts. */
function passes(m, skip) {
  const f = view.filters;
  if (skip !== 'types' && f.types.length && !f.types.includes(m ? m.category : 'unknown')) return false;
  // dual-faction leaders match either faction (a faction without a filter button, as on game data read by an
  // earlier version of the tracker, filters nothing)
  const fams = shownFamilies();
  if (skip !== 'families' && fams.length && !(m && familiesOf(m).some((x) => fams.includes(x)))) return false;
  if (skip !== 'traits' && f.traits.length) {
    if (!m) return false;
    const has = new Set(m.traits.map((t) => t.name));
    const ok = f.traitMode === 'any' ? f.traits.some((t) => has.has(t)) : f.traits.every((t) => has.has(t));
    if (!ok) return false;
  }
  return true;
}

/** The grid: owned units, plus the minis not owned when "Owned + not owned" is chosen. */
function gridPool() {
  const pool = state.units.map((u) => ({ unit: u, mini: miniOf(u) }));
  if (view.show === 'all') {
    const owned = new Set(state.units.map((u) => u.slug));
    for (const m of MINIS) if (!owned.has(m.slug)) pool.push({ unit: null, mini: m });
  }
  return pool;
}

const filtersActive = () => view.filters.types.length + shownFamilies().length + view.filters.traits.length > 0;

function saveFilters() { store.set('collectionFilters', view.filters); }

export function toggleIn(list, value) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1); else list.push(value);
}

export function renderFilters() {
  const f = view.filters;
  const pool = gridPool();
  const count = (group, test) => pool.filter(({ mini }) => passes(mini, group) && test(mini)).length;

  const typeChips = TYPES
    .filter(([k]) => k !== 'unknown' || state.units.some((u) => !u.slug))
    .map(([k, label]) => `<button class="chip" aria-pressed="${f.types.includes(k)}"
      data-filter-type="${k}">${label}<small>${count('types', (m) => (m ? m.category : 'unknown') === k)}</small></button>`)
    .join('');

  const famChips = FAMILIES
    .map((fam) => `<button class="chip" aria-pressed="${f.families.includes(fam)}"
      data-filter-family="${fam}">${iconImage(TAG_ICONS[fam], fam)}${fam}<small>${count('families',
      (m) => !!m && familiesOf(m).includes(fam))}</small></button>`)
    .join('');

  const traits = allTraits();
  const traitCount = (name) => count('traits', (m) => !!m && m.traits.some((t) => t.name === name));
  const picker = traitPicker({
    scope: 'collection', traits, filter: f, open: view.traitPickerOpen, query: view.traitSearch, count: traitCount,
    label: f.traits.length ? `${f.traits.length} selected` : 'Choose traits',
  });

  const filters = $('#filters'), focused = focusKey(filters);
  filters.innerHTML = `
    <div class="filter-row"><span class="filter-label">Type</span><div class="chips">${typeChips}</div></div>
    <div class="filter-row"><span class="filter-label">Faction</span><div class="chips">${famChips}</div></div>
    <div class="filter-row"><span class="filter-label">Traits</span>
      <div class="chips">
        ${picker}
      </div>
      <button class="chip clear-filters" data-filter-clear ${filtersActive() ? '' : 'disabled'}>✕ Clear filters</button>
    </div>`;
  refocus(filters, focused);
}

/** Card frame class for the mini's family (art.css). */
const frameCls = (m) => `frame-${String(m?.family || 'neutral').toLowerCase()}`;

/** A card without levels, for a mini that is always owned or one not owned. `open` is its data attribute. */
const plainCard = (m, open, note, cls = '') => `<button class="card${cls} ${frameCls(m)}" ${open}>
    <img class="art" src="/static/${m.art}" alt="" loading="lazy">
    <div class="name">${esc(m.name)}</div>
    <div class="meta">${esc(m.category)} · ${esc(familiesOf(m).join(' + '))}</div>
    <div class="small">${note}</div>
  </button>`;

function cardForUnit(u) {
  const m = miniOf(u);
  if (u.synthetic) return plainCard(m, `data-unit-open="${u.id}"`, 'Always owned · no levels or upgrades');
  const up = nextUpgrade(u);
  const slots = talentSlots(u);
  const flags = [];
  if (up?.ready) flags.push('<span class="flag good upgrade" title="Upgrade ready">UPG</span>');
  if (u.talents < slots) flags.push('<span class="flag good">Talent slot open</span>');
  if (effectivePicks(u).length < u.talents) flags.push('<span class="flag warn">Tick talents</span>');
  if (isLeader(u) && armyOf(u).some((s) => s.type === 'Wildcard')) flags.push(`<span
    class="flag wild">${iconImage(TAG_ICONS.Wildcard, 'Wildcard')}Wildcard</span>`);
  if (hasBoost(u)) flags.push('<span class="flag boost" title="Its army has a Boost slot, so that mini plays at XP '
    + `level ${RULES.maxXpLevel}"><svg class="boost-bolt" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 0 2 9h5l-1.5 7L14 `
    + '6.5H8.8z"/></svg>Boost</span>');
  const xpPct = u.xpLevel >= RULES.maxXpLevel ? 100 : Math.round((u.xp / Math.max(1, u.xpNeeded)) * 100);
  const starsTxt = up ? `${u.stars}/${up.stars} stars` : 'Max rarity';
  const starsPct = up ? Math.min(100, Math.round((u.stars / up.stars) * 100)) : 100;
  return `<button class="card ${frameCls(m)}${isLeader(u) ? ' leader' : ''}"
    style="--rarity-color:${rarityColor(u.rarity)}" data-unit-open="${u.id}">
    ${m ? `<img class="art" src="/static/${m.art}" alt="" loading="lazy">` : '<div class="art unknown">?</div>'}
    <div class="level">${totalLevel(u)}<small>level</small></div>
    <div class="name">${esc(unitName(u))}</div>
    <div class="meta">${rarityName(u.rarity)}${m ? ` · ${m.category}` : ''}</div>
    <div class="bar"><span style="width:${xpPct}%"></span></div>
    <div class="small">${u.xpLevel >= RULES.maxXpLevel ? `XP level ${RULES.maxXpLevel} (max)`
      : `XP level ${u.xpLevel} · ${fmt(u.xp)}/${fmt(u.xpNeeded)}`}</div>
    <div class="bar stars"><span style="width:${starsPct}%"></span></div>
    <div class="small">${starsTxt} · talents ${u.talents}/${slots}</div>
    ${isLeader(u) ? armyStrip(u) : ''}
    <div class="flags">${flags.join('')}</div>
  </button>`;
}

function armyStrip(u) {
  const tiers = RULES.armySlots.tiers;
  const cells = armyOf(u).map((s) => {
    const t = tiers[s.tier];
    return `<span class="army-cell${s.type === 'Wildcard' ? ' wild' : ''}${s.boost ? ' boost' : ''}"
      style="--type-color:${t.color}" title="${esc(s.type || 'Type not set')}: ${t.name}${t.bonus
      ? ` (+${t.bonus})` : ''}${s.boost ? ' · Boost' : ''}"></span>`;
  }).join('');
  return `<div class="army-strip" aria-label="Army slots">${cells}</div>`;
}

function cardForMissing(m) {
  const note = `Not owned${state.units.some((u) => !u.slug) ? ' or not identified yet' : ''}`;
  return plainCard(m, `data-mini-open="${m.slug}"`, note, ' missing');
}

function sortUnits(list) {
  const by = {
    level: (a, b) => totalLevel(b) - totalLevel(a) || unitName(a).localeCompare(unitName(b)),
    name: (a, b) => unitName(a).localeCompare(unitName(b)),
    rarity: (a, b) => b.rarity - a.rarity || totalLevel(b) - totalLevel(a),
    ready: (a, b) => (nextUpgrade(b)?.ready ? 1 : 0) - (nextUpgrade(a)?.ready ? 1 : 0) || totalLevel(b) - totalLevel(a),
  }[view.sort];
  return [...list].sort(by);
}

export function renderGrid() {
  const pool = gridPool().filter(({ mini }) => passes(mini));
  const units = sortUnits(pool.filter((p) => p.unit).map((p) => p.unit));
  const missing = pool.filter((p) => !p.unit).map((p) => p.mini).sort((a, b) => a.name.localeCompare(b.name));
  const html = units.map(cardForUnit).join('') + missing.map(cardForMissing).join('');
  const total = state.units.length + (view.show === 'all' ? MINIS.length - new Set(state.units.map((u) =>
    u.slug).filter(Boolean)).size : 0);
  $('#gridCount').textContent = filtersActive() ? `Showing ${units.length + missing.length} of ${total}` : `${total} minis`;
  const grid = $('#grid'), focused = focusKey(grid);
  grid.innerHTML = html || '<p class="muted">No minis match these filters.</p>';
  refocus(grid, focused);
}

function eventText(e) {
  const u = state.units.find((x) => x.id === e.id);
  const who = u ? unitName(u) : null;
  const cur = state.currencies.find((x) => x.id === e.id);
  switch (e.type) {
    case 'unit_new': return `${who} joined your collection`;
    case 'unit_xp': return `${who} +${fmt(e.gained)} XP${e.to.level !== e.from.level ? ` → XP level ${e.to.level}` : ''}`;
    case 'unit_rarity': return `${who} upgraded to ${rarityName(e.to)}`;
    case 'unit_talent': return `${who} unlocked a talent (${e.to} total)`;
    case 'unit_stars': return `${who} stars ${e.from} → ${e.to}`;
    case 'currency': return `${cur?.name || `Currency ${e.id.slice(0, 8)}`} ${e.delta > 0 ? '+' : ''}${fmt(e.delta)} (now ${fmt(e.to)})`;
    default: return e.type;
  }
}

export function renderEvents() {
  const list = state.events.slice(-25).reverse(); // latest 25
  $('#eventsCount').textContent = list.length ? `· latest ${list.length}` : '';
  const events = $('#events'), scrolled = events.scrollTop; // (the list stays where it was scrolled to)
  events.innerHTML = list.length
    ? list.map((e) => `<li><time>${ago(e.t)}</time>${esc(eventText(e))}</li>`).join('')
    : '<li class="muted">No changes yet. Play a battle or upgrade a mini and it shows up here.</li>';
  events.scrollTop = scrolled;
}

// What a click on the Collection tab can act on: the filters and the planner (the trait picker has its own handlers).
const CLICKABLE = [
  'data-filter-type', 'data-filter-family', 'data-filter-clear', 'data-planner-toggle',
].map((a) => `[${a}]`).join(',');

/** Saves the filters and redraws what they affect. */
function refilter() {
  saveFilters();
  renderFilters();
  renderPlanner();
  renderGrid();
}

/** Clicks on the filter chips, Clear filters and the planner's Show more. */
function filterClick(e) {
  const t = e.target.closest(CLICKABLE);
  if (!t) return;
  if (t.hasAttribute('data-planner-toggle')) {
    view.planExpanded = !view.planExpanded;
    store.set('collectionPlanExpanded', view.planExpanded);
    return renderPlanner();
  }
  const group = t.dataset.filterType ? ['types', t.dataset.filterType] : t.dataset.filterFamily
    ? ['families', t.dataset.filterFamily] : null;
  if (group) toggleIn(view.filters[group[0]], group[1]);
  else if (t.hasAttribute('data-filter-clear')) {
    view.filters = { types: [], families: [], traits: [], traitMode: view.filters.traitMode };
    view.traitPickerOpen = false;
  } else return;
  refilter();
}

/** The Show and Sort selects above the grid. */
function bindGridSelects() {
  $('#show').value = view.show;
  $('#sort').value = view.sort;
  $('#show').addEventListener('change', (e) => {
    view.show = e.target.value;
    store.set('collectionShow', view.show);
    renderFilters();
    renderGrid();
  });
  $('#sort').addEventListener('change', (e) => {
    view.sort = e.target.value;
    store.set('collectionSort', view.sort);
    renderGrid();
  });
}

function bindTraitFilter() {
  const show = (open) => {
    view.traitPickerOpen = open;
    view.traitSearch = '';
    renderFilters();
  };
  bindTraitPicker($('#filters'), 'collection', {
    isOpen: () => view.traitPickerOpen,
    toggle: () => show(!view.traitPickerOpen),
    close: () => show(false),
    mode: (mode) => {
      view.filters.traitMode = mode;
      refilter();
    },
    clear: () => {
      view.filters.traits = [];
      refilter();
    },
    tick: (name) => {
      toggleIn(view.filters.traits, name);
      refilter();
    },
    search: (text) => { view.traitSearch = text; },
  });
}

export function bindCollection() {
  bindGridSelects();
  document.addEventListener('click', filterClick);
  bindTraitFilter();
}
