// G.R.I.D. tab: the current grid, when it refreshes, and which minis are on cooldown. A mini isn't offered again until
// a number of other minis have been: 12, 16 for leaders, 20 for special leaders. The cooldowns come from the grids the
// tracker has seen (grid_history.json).
import { currencyChip } from './collection.js';
import { $, imageUrl, getJson, RULES, MINIS, BY_SLUG, state, onTablesReload, ui, focusKey, refocus } from './core.js';
import { SECOND, HOUR, DAY } from './lib/constants.js';
import { esc, fmt, plural, dateTime, dayWithYear, weekdayTime, span } from './lib/format.js';
import { rarityColor, ownedUnit, gridRarityOf } from './units.js';

export let STORE = null; // static/store.json
onTablesReload(() => { STORE = null; });
export async function loadStore() {
  if (!STORE) STORE = await getJson('/static/store.json', 'the shop data');
  return STORE;
}

let eligibleOpen = false; // whether the "Can be offered" list is open, kept across redraws

const isLeaderSlug = (slug) => BY_SLUG.get(slug)?.category === 'Leader';

/** How many other minis must be offered before one comes back, by kind. */
function cooldownLimits() {
  const rules = STORE.rules?.recentlySeen || {};
  return { mini: rules.m_mini || 12, leader: rules.m_leader || 16, special: rules.m_superSpecialAwesomeMini || 20 };
}

/** The special leaders' slugs, as far as the grids seen so far name them. */
function specialSlugs() {
  const items = (state.gridHistory || []).flatMap((g) => g.items);
  return new Set((STORE.rules?.specialMinis || []).map((id) => items.find((x) => x.mini === id)?.slug).filter(Boolean));
}

/** The minis on cooldown, by slug: { place, limit, lastSeen, leader }. */
function gridCooldowns() {
  const limits = cooldownLimits();
  const special = specialSlugs();
  // Newest grid first. Minis in one grid count as offered together; a mini's place is the number of other minis of its
  // kind offered in newer grids.
  const out = new Map();
  const seen = new Set();
  const counters = { mini: 0, leader: 0 };
  for (const g of [...(state.gridHistory || [])].reverse()) {
    const fresh = g.items.filter((x) => x.slug && !seen.has(x.slug));
    for (const x of fresh) {
      seen.add(x.slug);
      const leader = isLeaderSlug(x.slug);
      const kind = leader ? 'leader' : 'mini';
      const limit = special.has(x.slug) ? limits.special : leader ? limits.leader : limits.mini;
      const place = counters[kind];
      if (place < limit) out.set(x.slug, { place, limit, lastSeen: g.seen, leader });
    }
    for (const x of fresh) counters[isLeaderSlug(x.slug) ? 'leader' : 'mini']++;
  }
  return out;
}

function gridSlot(s) {
  if (s.bought) return '<div class="grid-slot bought"><span>Bought</span></div>';
  if (s.xpBoost) {
    const x = STORE.xpBoosts[s.xpBoost] || {};
    return `<div class="grid-slot xp"><div class="grid-art xp-art">${x.icon
      ? `<img src="${imageUrl('store', x.icon)}" alt="">` : 'XP'}</div><div
      class="grid-name">${esc((x.name || 'XP Boost').replace(/!$/, ''))}</div>
      <div class="grid-price">${x.coins != null ? `${fmt(x.coins)} <span class="gold">●</span>` : ''}</div></div>`;
  }
  const m = BY_SLUG.get(s.slug);
  const own = ownedUnit(s.slug, { alwaysOwned: false });
  const price = STORE.gridRarity[s.rarity]?.coins;
  const rarity = gridRarityOf(STORE.gridRarity[s.rarity]?.name);
  return `<div class="grid-slot${m ? '' : ' unknown'}" style="--rarity-color:${rarityColor(Math.max(0, rarity.index))}">
    <div class="grid-art">${m ? `<img src="/static/${m.art}" alt="">` : '?'}</div>
    <div class="grid-name">${esc(m?.name || 'New mini (not in the tracker\'s data yet)')}</div>
    <div class="grid-meta">${esc(rarity.label)}${own ? ` · <span class="text-good">Level ${own.level}</span>` : m
      ? ' · <span class="text-warn">not owned</span>' : ''}</div>
    <div class="grid-price">${price != null ? `${fmt(price)} <span class="gold">●</span>` : ''}</div>
  </div>`;
}

function gridHeader(shop, currencies) {
  const refresh = shop.grid.refresh;
  // (a save without a refresh time says nothing about when)
  const timer = !refresh ? '' : Date.parse(refresh) <= Date.now()
    ? 'Refreshing now. <span class="muted small">Open the shop in the game to see the new grid.</span>'
    : `Refreshes in <b>${esc(span(Date.parse(refresh) - Date.now()))}</b>`;
  return `<section class="panel grid-head">
    <h2>G.R.I.D.</h2>
    <span class="grid-timer">${timer}</span>
    <span class="muted small">${refresh ? esc(weekdayTime(refresh)) : ''} · every
      ${plural(Math.round((STORE.rules?.refreshSeconds || DAY / SECOND) * SECOND / HOUR), 'hour')}</span>
    ${currencies.length ? `<div class="currencies grid-currencies">${currencies.map(currencyChip).join('')}</div>` : ''}
  </section>`;
}

/** A mini as a small chip with its picture. `extra` follows the name. */
function miniChip(m, slug, { cls = '', title = m?.name || slug, extra = '' } = {}) {
  const art = m ? `<img src="/static/${m.art}" alt="">` : '';
  const owned = ownedUnit(slug, { alwaysOwned: false }) ? '' : ' not-owned';
  return `<span class="cooldown-chip${cls}${owned}" title="${esc(title)}">${art}<span>${esc(m?.name || slug)}</span>${extra}</span>`;
}

function cooldownPanel(cooldowns, history) {
  const limits = cooldownLimits();
  // the special leaders are named once the grids seen so far have shown all of them
  const names = [...specialSlugs()].map((slug) => BY_SLUG.get(slug)?.name).filter(Boolean);
  const specials = names.length && names.length === (STORE.rules?.specialMinis || []).length ? names : [];
  const since = history[0]?.seen;
  const cooling = [...cooldowns.entries()].sort((x, y) => x[1].place - y[1].place);
  const eligible = MINIS.filter((m) => !m.alwaysOwned && !cooldowns.has(m.slug)).sort((x, y) => x.name.localeCompare(y.name));
  const coolingChip = ([slug, c]) => miniChip(BY_SLUG.get(slug), slug, {
    title: `Last offered ${dateTime(c.lastSeen)} · back after ${c.limit - c.place} more ${c.leader ? 'leaders' : 'minis'}`,
    extra: `<b>${c.limit - c.place}</b>`,
  });
  return `<section class="panel grid-cd">
    <h2>On cooldown <span class="muted small">${plural(cooling.length, 'mini')}</span></h2>
    <p class="muted small">A mini comes back only after ${limits.mini} other minis have been offered (leaders ${limits.leader},
      ${specials.length ? esc(specials.join(', ')) : 'special leaders'} ${limits.special}). The number is how many are still
      to go, at most. Based on ${plural(history.length, 'grid')} seen${since ? ` since ${esc(dayWithYear(since))}` : ''},
      so the list may be incomplete at first.</p>
    <div class="cooldown-list">${cooling.length ? cooling.map(coolingChip).join('')
      : '<span class="muted">Nothing logged yet.</span>'}</div>
    <details class="cooldown-eligible" ${eligibleOpen ? 'open' : ''}><summary>Can be offered: ${plural(eligible.length, 'mini')}</summary>
      <div class="cooldown-list">${eligible.map((m) => miniChip(m, m.slug, { cls: ' small' })).join('')}</div>
    </details>
  </section>`;
}

/** What a grid offered, as pictures: minis, or the XP boost's icon. */
function historyItem(x) {
  const m = x.slug && BY_SLUG.get(x.slug);
  if (m) return `<img src="/static/${m.art}" alt="" title="${esc(m.name)}">`;
  const boost = STORE.xpBoosts[x.xpBoost];
  return boost?.icon
    ? `<img class="history-xp-image" src="${imageUrl('store', boost.icon)}" alt="" title="${esc(boost.name)}">`
    : `<span class="history-xp" title="${esc(boost?.name || 'XP boost')}">XP</span>`;
}

function historyPanel(history) {
  const list = [...history].reverse().slice(0, 30).map((g) => `<li><span class="muted small">${esc(dateTime(g.seen))}</span>
    <span class="history-items">${g.items.map(historyItem).join('')}</span></li>`).join('');
  return `<section class="panel grid-hist">
    <h2>Grids seen <span class="muted small">newest first</span></h2>
    ${history.length ? `<ol>${list}</ol>` : '<p class="muted">The tracker logs each new grid it sees.</p>'}
  </section>`;
}

export async function renderGridTab() {
  const page = $('#tab-grid');
  if (!page || !state) return;
  try {
    await loadStore();
  } catch (err) {
    page.innerHTML = `<div class="panel muted">${esc(err.message)}</div>`;
    return;
  }
  if (ui.tab !== 'grid') return;
  const shop = state.shop;
  if (!shop) {
    page.innerHTML = '<div class="panel muted">No G.R.I.D. in the saved data for this account yet. Open the shop in the game.</div>';
    return;
  }
  // The G.R.I.D. currencies the account has.
  const currencies = (RULES.gridCurrencyIds || []).map((id) => state.currencies.find((c) => c.id === id && c.name)).filter(Boolean);
  const history = state.gridHistory || [];
  const focused = focusKey(page); // ("Can be offered", which the keyboard opens and closes)
  page.innerHTML = `${gridHeader(shop, currencies)}
    <div class="grid-layout">
      <section class="panel"><div class="grid-board">${shop.grid.rows.map((row) => row.map(gridSlot).join('')).join('')}</div></section>
      ${cooldownPanel(gridCooldowns(), history)}
    </div>
    ${historyPanel(history)}`;
  refocus(page, focused);
}

export function bindGridTab() {
  $('#tab-grid').addEventListener('toggle', (e) => {
    if (e.target.classList?.contains('cooldown-eligible')) eligibleOpen = e.target.open;
  }, true);
  setInterval(() => { if (ui.tab === 'grid' && !document.hidden) renderGridTab(); }, 30 * SECOND);
}
