// The trait picker on the Collection tab and in the Army tab's two pools. Each picker has a scope ("collection",
// "leaders" or "units") and its own choice, and its events only reach its own handlers.
import { iconImage } from './drawer.js';
import { esc } from './lib/format.js';

/**
 * The button and, while the picker is open, its pop-up. `filter` is { traits, traitMode }, `query` the search text,
 * `count(name)` an optional number shown next to each trait and `label` the button's text.
 */
export function traitPicker({ scope, traits, filter, open, query = '', count, label, buttonClass = 'chip' }) {
  const q = query.trim().toLowerCase();
  const hidden = (t) => (q && !t.name.toLowerCase().includes(q) ? ' hidden' : '');
  const option = (t) => `<label class="trait-option" data-trait-name="${esc(t.name.toLowerCase())}"${hidden(t)}>
      <input type="checkbox" data-trait-box="${esc(t.name)}" ${filter.traits.includes(t.name) ? 'checked' : ''}>
      ${iconImage(t.icon, t.name)}<span>${esc(t.name)}</span>${count ? `<small>${count(t.name)}</small>` : ''}</label>`;
  const chosen = traits.filter((t) => filter.traits.includes(t.name));
  const rest = traits.filter((t) => !filter.traits.includes(t.name));
  const any = filter.traitMode === 'any';
  // The match mode comes first, then the chosen traits, then the rest from A to Z.
  const popup = !open ? '' : `<div class="trait-popup${count ? ' with-counts' : ''}" role="dialog" aria-label="Traits"
      data-trait-scope="${scope}">
      <div class="trait-popup-head">
        <span class="segmented"><button class="chip small-chip" aria-pressed="${!any}" data-trait-mode="all"
          title="Minis with every selected trait">Match all</button><button class="chip small-chip"
          aria-pressed="${any}" data-trait-mode="any" title="Minis with any selected trait">Match any</button></span>
        ${filter.traits.length ? '<button class="chip small-chip" data-trait-clear>Clear</button>' : ''}
      </div>
      <input class="trait-search" type="search" placeholder="Search traits…" value="${esc(query)}">
      <div class="trait-list">${chosen.map(option).join('')}${chosen.length && rest.length
        ? '<hr class="trait-separator">' : ''}${rest.map(option).join('')}</div>
    </div>`;
  return `<span class="trait-anchor"><button class="${buttonClass}" aria-expanded="${open}"
    aria-pressed="${filter.traits.length > 0}" data-trait-picker="${scope}">${label} ▾</button>${popup}</span>`;
}

/**
 * Handles one picker's events inside `root`. `on` has isOpen(), toggle(), close(), mode(mode), clear(), tick(name)
 * and search(text); each changes the tab's own filter and redraws what it needs to.
 */
export function bindTraitPicker(root, scope, on) {
  const popup = () => root.querySelector(`[data-trait-scope="${scope}"]`);
  // The path is kept as dispatched, so it still holds the picker after a handler has redrawn it.
  const inPicker = (e) => e.composedPath().some((el) => el.dataset?.traitScope === scope || el.dataset?.traitPicker === scope);
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-trait-picker]')?.dataset.traitPicker === scope) {
      on.toggle();
      popup()?.querySelector('.trait-search')?.focus();
      return;
    }
    if (e.target.closest('[data-trait-scope]')?.dataset.traitScope !== scope) return;
    const mode = e.target.closest('[data-trait-mode]');
    if (mode) on.mode(mode.dataset.traitMode);
    else if (e.target.closest('[data-trait-clear]')) on.clear();
  });
  // The search filters the list in place, so typing isn't interrupted.
  root.addEventListener('input', (e) => {
    if (!e.target.matches('.trait-search') || e.target.closest('[data-trait-scope]')?.dataset.traitScope !== scope) return;
    on.search(e.target.value);
    const q = e.target.value.trim().toLowerCase();
    for (const o of popup().querySelectorAll('.trait-option')) o.hidden = !!q && !o.dataset.traitName.includes(q);
  });
  // Ticking a trait keeps the picker open and the list where it was scrolled to.
  root.addEventListener('change', (e) => {
    const name = e.target.dataset?.traitBox;
    if (!name || e.target.closest('[data-trait-scope]')?.dataset.traitScope !== scope) return;
    const scroll = popup()?.querySelector('.trait-list')?.scrollTop;
    on.tick(name);
    const list = popup()?.querySelector('.trait-list');
    if (list) list.scrollTop = scroll || 0;
  });
  // A click elsewhere or Esc closes it. The side panel handles Esc first when it is open.
  document.addEventListener('click', (e) => { if (on.isOpen() && !inPicker(e)) on.close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !on.isOpen()) return;
    // the focus goes back to the picker's button when it was in the picker, which is gone once closed
    const inside = popup()?.contains(document.activeElement);
    on.close();
    if (inside) root.querySelector(`[data-trait-picker="${scope}"]`)?.focus();
  });
}
