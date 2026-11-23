// What every page module shares: the game tables, the server's state, the selected account and tab, and request
// helpers. It imports nothing, so any module can use it.
export const $ = (s, el = document) => el.querySelector(s);
// The page's settings in local storage, reached through window, which tests don't have.
export const store = {
  get(k, d) {
    try {
      const v = globalThis.window?.localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      globalThis.window?.localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // storage unavailable
    }
  },
  /** Moves a value saved under an older key to its current one, once. */
  rename(from, to) {
    try {
      const ls = globalThis.window?.localStorage;
      const v = ls?.getItem(from);
      if (v == null) return;
      if (ls.getItem(to) == null) ls.setItem(to, v);
      ls.removeItem(from);
    } catch {
      // storage unavailable
    }
  },
};

/** The URL of a game image, as in imageUrl('rewards', 'Tome_Epic'). */
export const imageUrl = (folder, name) => `/static/${folder}/${encodeURIComponent(name)}.webp`;

const NOT_RESPONDING = 'The tracker isn\'t responding. Is it still running?';

/** Sends a request and returns its JSON answer. Errors are sentences the page can show as they are. */
async function request(url, options, what) {
  let r;
  try {
    r = await fetch(url, options);
  } catch {
    throw new Error(NOT_RESPONDING);
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const message = data?.error || `Could not ${what} (HTTP ${r.status}). Please try again.`;
    throw Object.assign(new Error(message), { status: r.status });
  }
  if (data === null) throw new Error(`Could not ${what}, because the tracker's answer isn't valid JSON.`);
  return data;
}

/** Loads JSON. `what` names it for error messages, as in "the event schedule". */
export const getJson = (url, what) => request(url, undefined, `load ${what}`);

/** Sends JSON. With `keepalive`, the request still finishes when the page closes. */
export const post = (url, body, { keepalive = false } = {}) => request(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive,
}, 'do that');

/**
 * Shows a short status message in `el`. `kind` is 'good', 'warn', 'code' (shown as code, for copying by hand) or
 * nothing; the element keeps its other classes.
 */
export function showMessage(el, text, kind = '') {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('text-good', 'text-warn', 'mono');
  if (kind) el.classList.add({ good: 'text-good', warn: 'text-warn', code: 'mono' }[kind]);
}

/** Copies text to the clipboard. Returns false when the browser blocks it. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Opens an outside link in a new browser tab. The exe's window opens it in the default browser instead. */
export function openExternal(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Only this module assigns these (setTables, setState, setDirty); the other modules see the current values.
export let RULES, MINIS, BY_SLUG, TAG_ICONS;
export let FAMILIES = []; // the factions minis are filed under, in the order their filters are shown
export let FAMILY_PAIRS = []; // faction pairs with a combined icon (icons/fam), such as 'AllianceHorde'
export let ALWAYS_OWNED = []; // minis every player owns, which the save doesn't list
export let state = null; // the server's state for the selected account (/api/state)
export let dirty = false; // a redraw waits until the user leaves a field

/** rules.json and minis.json. */
export function setTables(rules, minisFile) {
  RULES = rules;
  MINIS = minisFile.minis;
  // Wildcard and Leader icons are not in minis.json.
  TAG_ICONS = { Wildcard: 'icons/Wildcard.png', Leader: 'icons/Leader.png', ...(minisFile.tagIcons || {}) };
  FAMILIES = minisFile.families || [];
  FAMILY_PAIRS = minisFile.familyPairs || [];
  ALWAYS_OWNED = MINIS.filter((m) => m.alwaysOwned);
  BY_SLUG = new Map(MINIS.map((m) => [m.slug, m]));
}
export const setState = (s) => { state = s; };
export const setDirty = (d) => { dirty = d; };

// Tabs keep the game tables they load. After the game data was read again, those are dropped and loaded when needed.
const tableResets = [];
export const onTablesReload = (fn) => { tableResets.push(fn); };
export const resetTableCaches = () => { for (const fn of tableResets) fn(); };
// The selected account and tab, kept between visits; each tab keeps its own state.
export const ui = {
  account: store.get('account', null),
  // The address's #tab when the page has such a tab, else the last one (tests have no page or location).
  tab: ((h) => (h && globalThis.document?.querySelector(`[data-tab="${CSS.escape(h)}"]`)
    ? h : store.get('tab', 'collection')))(globalThis.location?.hash.slice(1)),
};

