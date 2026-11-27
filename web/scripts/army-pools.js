// The Army tab's two pools, Leaders and Units & Spells: their filters, sorting and cards.
import { builder, draftLeader, addFromPool } from './army.js';
import { allTraits, toggleIn } from './collection.js';
import { $, store, TAG_ICONS, FAMILIES, state } from './core.js';
import { iconImage } from './drawer.js';
import { esc } from './lib/format.js';
import { traitPicker } from './trait-picker.js';
import { rarityColor, miniOf, armyOf, totalLevel, slotMatches, familiesOf } from './units.js';

const POOL_DEFAULT = { leaders: { q: '', fam: [], traits: [], traitMode: 'all', sort: 'level' },
  units: { q: '', fam: [], type: [], traits: [], traitMode: 'all', sort: 'level' } };

export function pools() {
  if (!builder.pools) {
    const s = store.get('armyPools', {});
    builder.pools = { leaders: { ...POOL_DEFAULT.leaders, ...s.leaders, q: '' }, units: { ...POOL_DEFAULT.units, ...s.units, q: '' } };
  }
  return builder.pools;
}

export const savePools = () => store.set('armyPools', builder.pools);

/** The current leader's slots (1-6) this mini matches, Wildcard slots only when asked for. */
export function matchingSlots(m, includeWildcard = false) {
  const L = draftLeader();
  if (!L || !m) return [];
  return armyOf(L).map((s, i) => (i > 0 && (includeWildcard || s.type !== 'Wildcard') && slotMatches(s.type, m)
    ? i : null)).filter((x) => x != null);
}

const inPool = (kind) => (m) => (kind === 'leaders' ? m.category === 'Leader' : m.category !== 'Leader');
/** The factions of a pool's minis, which get a filter button (the minis every player has are not in the pools). */
function poolFactions(kind) {
  const here = new Set(state.units.filter((u) => !u.synthetic).map(miniOf).filter((m) => m && inPool(kind)(m)).flatMap(familiesOf));
  return FAMILIES.filter((f) => here.has(f));
}
/** The factions a pool is filtered by: the chosen ones that have a button. */
const chosenFactions = (kind) => pools()[kind].fam.filter((f) => poolFactions(kind).includes(f));
function poolItems(kind) {
  const p = pools()[kind];
  const d = builder.draft;
  const used = new Set([d.leader, ...d.minis].filter(Boolean));
  const q = p.q.trim().toLowerCase();
  const fams = chosenFactions(kind);
  const items = state.units
    .map((u) => ({ u, m: miniOf(u) }))
    .filter(({ u, m }) => m && !u.synthetic && inPool(kind)(m))
    .filter(({ m }) => !q || m.name.toLowerCase().includes(q))
    .filter(({ m }) => !fams.length || familiesOf(m).some((f) => fams.includes(f)))
    .filter(({ m }) => kind === 'leaders' || !p.type.length || p.type.includes(m.category))
    .filter(({ m }) => !p.traits.length || p.traits[p.traitMode === 'any' ? 'some' : 'every']((t) => m.traits.some((x) => x.name === t)))
    .map((x) => ({ ...x, used: used.has(x.u.slug), level: kind === 'leaders' ? totalLevel(x.u) : x.u.level,
      slots: kind === 'units' ? matchingSlots(x.m) : [] }));
  const by = {
    level: (a, b) => b.level - a.level || a.m.name.localeCompare(b.m.name),
    name: (a, b) => a.m.name.localeCompare(b.m.name),
    cost: (a, b) => a.m.cost - b.m.cost || a.m.name.localeCompare(b.m.name),
    match: (a, b) => b.slots.length - a.slots.length || b.level - a.level,
  }[p.sort] || ((a, b) => b.level - a.level);
  return items.sort(by);
}

function poolCard(x, kind) {
  const { u, m } = x;
  const L = draftLeader();
  const tip = kind === 'units' && L ? (x.slots.length ? `Matches slot ${x.slots.join(', ')}` : 'No matching slot') : '';
  return `<button class="pool-card${x.used ? ' used' : ''}${x.slots.length ? ' fits' : ''}" draggable="true"
    data-pool-slug="${u.slug}" data-pool-kind="${kind}" style="--rarity-color:${rarityColor(u.rarity)}"
    title="${esc(m.name)}${tip ? ` · ${tip}` : ''}${x.used ? ' · in this army' : ''}">
    <img src="/static/${m.art}" alt="" draggable="false">
    <span class="pool-cost">${m.cost}</span>
    <span class="pool-name">${esc(m.name)}</span>
    <span class="pool-level">${x.level}</span>
  </button>`;
}

/** Whether a pool is searched or filtered, for its Clear filters button. */
export function poolFiltered(kind) {
  const p = pools()[kind];
  return !!(p.q || chosenFactions(kind).length || p.type?.length || p.traits.length);
}
/** Draws a pool; `scrollTop` is where its list was scrolled to before the tab was drawn anew. */
export function renderPool(kind, scrollTop = 0) {
  const el = $(`#pool-${kind}`);
  if (!el) return;
  const p = pools()[kind];
  const inKind = inPool(kind);
  const famChips = poolFactions(kind).map((f) => `<button class="chip small-chip" aria-pressed="${p.fam.includes(f)}"
    data-pool-family="${f}" data-pool="${kind}" title="${f}">${iconImage(TAG_ICONS[f], f)}</button>`);
  const typeChips = kind === 'units' ? [['Unit', 'Units'], ['Spell', 'Spells']].map(([k, l]) =>
    `<button class="chip small-chip" aria-pressed="${p.type.includes(k)}" data-pool-type="${k}"
    data-pool="${kind}">${l}</button>`).join('') : '';
  const sorts = [['level', 'Level'], ['name', 'Name'], ['cost', 'Cost'], ...(kind === 'units' ? [['match', 'Fits slots']] : [])];
  // traits present in this pool
  const inPane = new Set(state.units.map(miniOf).filter((m) => m && inKind(m)).flatMap((m) => m.traits.map((t) => t.name)));
  const traits = allTraits().filter((t) => inPane.has(t.name));
  const picker = traitPicker({
    scope: kind, traits, filter: p, open: builder.poolTraitOpen === kind, query: builder.poolTraitQ[kind] || '',
    label: `Traits${p.traits.length ? ` (${p.traits.length})` : ''}`, buttonClass: 'chip small-chip',
  });
  el.innerHTML = `<div class="pool-head">
      <h2>${kind === 'leaders' ? 'Leaders' : 'Units & Spells'}</h2>
      <input class="pool-search" type="search" data-pool-search="${kind}" placeholder="Search…" value="${esc(p.q)}">
    </div>
    ${(() => {
      const sortSel = `<select data-pool-sort="${kind}" aria-label="Sort">${sorts.map(([k, l]) =>
        `<option value="${k}" ${p.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      const active = poolFiltered(kind);
      const clearBtn = `<button class="chip small-chip clear-filters" data-pool-clear="${kind}"
        ${active ? '' : 'disabled'}>✕ Clear filters</button>`;
      if (kind !== 'leaders') return `<div class="pool-filters">${typeChips}${famChips.join('')}${picker}${clearBtn}${sortSel}</div>`;
      // The Leaders pool shows the factions in two rows of three.
      return `<div class="pool-filters pool-filters-rows">
        <div class="pool-filter-row">${famChips.slice(0, 3).join('')}${picker}</div>
        <div class="pool-filter-row">${famChips.slice(3).join('')}${clearBtn}${sortSel}</div>
      </div>`;
    })()}
    <div class="pool-well"><div class="pool-grid" id="pool-grid-${kind}"></div></div>`;
  renderPoolGrid(kind, scrollTop);
}

export function renderPoolGrid(kind, scrollTop = 0) {
  const grid = $(`#pool-grid-${kind}`);
  if (!grid) return;
  const items = poolItems(kind);
  grid.innerHTML = items.map((x) => poolCard(x, kind)).join('') || '<p class="muted small">Nothing matches.</p>';
  if (!grid.dataset.fadeBound) {
    grid.dataset.fadeBound = '1';
    grid.addEventListener('scroll', () => poolFade(grid), { passive: true });
    // Also on first display and on resize.
    if (window.ResizeObserver) new ResizeObserver(() => poolFade(grid)).observe(grid);
  }
  if (scrollTop) grid.scrollTop = scrollTop;
  poolFade(grid);
}

/** Marks the pool edges that have more beyond them, which CSS fades. */
function poolFade(grid) {
  const up = grid.scrollTop > 2;
  const down = grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2;
  const more = up && down ? 'both' : up ? 'top' : down ? 'bottom' : '';
  if (grid.dataset.more !== more) grid.dataset.more = more;
}

/** Changes a pool's filters, remembers them and redraws the pool. */
export function updatePool(kind, change) {
  change(pools()[kind]);
  savePools();
  renderPool(kind);
}

/** Clicks on a pool's filters and tiles. Returns false when the click wasn't one of them. */
export function poolClick(t) {
  const kind = t.dataset.pool;
  if (t.dataset.poolSlug) addFromPool(t.dataset.poolSlug, t.dataset.poolKind);
  else if (t.dataset.poolFamily) updatePool(kind, (p) => toggleIn(p.fam, t.dataset.poolFamily));
  else if (t.dataset.poolType) updatePool(kind, (p) => toggleIn(p.type, t.dataset.poolType));
  // Clear filters keeps the sort and the trait match mode.
  else if (t.dataset.poolClear) updatePool(t.dataset.poolClear,
    (p) => Object.assign(p, { q: '', fam: [], traits: [], ...(p.type ? { type: [] } : {}) }));
  else return false;
  return true;
}
