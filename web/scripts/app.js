// The page's entry module. It loads the game tables, polls the server's state, switches tabs and draws the header.
// Each tab is its own module, and core.js holds what they share.
import { renderArmory, bindArmory } from './armory.js';
import { renderArmy, bindArmy } from './army.js';
import { bindBackupMenu } from './backup.js';
import { renderCalendar, bindCalendar } from './calendar.js';
import { bindClosing } from './closing.js';
import { bindRdmodule } from './rdmodule.js';
import { renderCurrencies, renderSummary, renderNeeds, renderPlanner, renderFilters, renderGrid, renderEvents,
  bindCollection } from './collection.js';
import { $, store, getJson, post, RULES, ALWAYS_OWNED, state, dirty, setTables, setState, setDirty,
  resetTableCaches, ui } from './core.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { panel, renderDrawer, bindDrawer } from './drawer.js';
import { renderGridTab, bindGridTab } from './grid.js';
import { SECOND, MINUTE, SCAN_MS } from './lib/constants.js';
import { esc, ago } from './lib/format.js';
import { LIMITS } from './lib/limits.js';
import { renderProgress } from './progress.js';
import { renderPvp, bindPvp } from './pvp.js';
import { renderReportBadge, bindReport } from './report.js';
import { bindSettings } from './settings.js';
import { renderDataBanner, renderUpdate, bindUpdate } from './update.js';

async function quitTracker() {
  if (!(await confirmDialog('The tracker stops reading your game and sending notifications until you start '
    + 'RumbleTracker.exe again.', { title: 'Quit the tracker?', ok: 'Quit', danger: true }))) return;
  try {
    await post('/api/quit', {});
  } catch {
    // already gone
  }
  document.body.innerHTML = '<main class="quit-page"><h1>The tracker has stopped</h1>'
    + '<p>You can close this window. Start RumbleTracker.exe to open it again.</p></main>';
  setTimeout(() => window.close(), 300);
}

async function loadTables() {
  const [rules, minis] = await Promise.all([
    getJson('/static/rules.json', 'the game rules'),
    getJson('/static/minis.json', 'the list of minis'),
  ]);
  setTables(rules, minis);
}

/** After the game data was read again, loads the game tables again. The tabs reload theirs when next needed. */
async function reloadTables() {
  try {
    await loadTables();
    resetTableCaches();
  } catch {
    // Keep the old tables; tried again at the next change.
  }
}

async function boot() {
  bindClosing(); // first, so the window can close while the page loads
  bindRdmodule();
  await loadTables();
  $('#accountLabel').maxLength = LIMITS.accountName;
  bindHeader();
  bindBackupMenu();
  bindUpdate();
  bindCollection();
  bindDrawer();
  bindArmy();
  bindArmory();
  bindCalendar();
  bindGridTab();
  bindPvp();
  bindSettings();
  bindReport();
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  // Left and Right move between the tabs, Home and End go to the first and the last, as a tab list is expected to
  document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
    const all = [...e.currentTarget.querySelectorAll('[data-tab]')], at = all.indexOf(document.activeElement);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (at < 0 || to === undefined) return;
    e.preventDefault();
    const next = all[(to + all.length) % all.length];
    setTab(next.dataset.tab);
    next.focus();
  });
  setTab(ui.tab);
  // a #tab typed into the address is followed
  addEventListener('hashchange', () => {
    const tab = location.hash.slice(1);
    if (tab !== ui.tab && document.querySelector(`[data-tab="${CSS.escape(tab)}"]`)) setTab(tab);
  });
  await poll();
  schedulePoll();
  // In view: the tracker looks for a newer version now (it may have sat in the tray since its last daily look).
  const lookForUpdate = () => post('/api/update/check', {}).then(poll, () => {});
  lookForUpdate();
  // Back in view, so refresh at once instead of waiting for the slow poll.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    poll();
    schedulePoll();
    lookForUpdate();
  });
  setInterval(renderStatus, SECOND);
}

// The page asks for the state every 5 seconds, every 60 seconds while its window is minimized or hidden, and every
// second while an update downloads, so the progress bar moves. While the server reads the save (every SCAN_MS, while
// the game runs and shortly after), it asks just after each read, so "last read" counts up from "just now".
const POLL_MS = 5 * SECOND, POLL_HIDDEN_MS = MINUTE, POLL_UPDATE_MS = SECOND;
const AFTER_READ_MS = 300; // the read itself takes up to about 0.1 s
let pollTimer = null;
function nextPollMs() {
  if (state?.update?.state === 'downloading') return POLL_UPDATE_MS;
  if (document.hidden) return POLL_HIDDEN_MS;
  const wait = Date.parse(state?.lastScan || '') + SCAN_MS + AFTER_READ_MS - Date.now();
  // when the reads stop (the game closed) or are late, the usual pace
  return wait > 0 && wait <= SCAN_MS + AFTER_READ_MS ? wait : POLL_MS;
}
export function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await poll();
    schedulePoll();
  }, nextPollMs());
}

// State that changes without a new revision (the server's liveState).
const LIVE_FIELDS = ['lastScan', 'lastError', 'problems', 'gameRunning', 'update'];

// An answer that comes in after a later request was made is left out: it was asked before the account was switched
// or a backup restored, and would put the page back to what it showed then.
let asked = 0;
export async function poll() {
  const mine = ++asked;
  try {
    const q = new URLSearchParams();
    if (ui.account) q.set('account', ui.account);
    // Given the revision the page has, the server answers an unchanged state with the live fields only.
    if (state && !state.connError) {
      q.set('rev', String(state.rev));
      q.set('for', String(state.account));
    }
    const s = await getJson(`/api/state?${q}`, 'the tracker\'s state');
    if (mine !== asked) return;
    if (s.unchanged && state) {
      for (const k of LIVE_FIELDS) state[k] = s[k];
      state.connError = null;
      renderUpdate();
      renderStatus();
      renderReportBadge();
      return;
    }
    // After an update the tracker is a new version, so load its page.
    if (state?.appVersion && s.appVersion && s.appVersion !== state.appVersion) {
      location.reload();
      return;
    }
    // The game data was read again, so reload the tables before drawing.
    const dataVersion = s.dataStatus?.dataVersion || null;
    if (state && dataVersion !== state.dataStatus?.dataVersion) await reloadTables();
    for (const m of ALWAYS_OWNED) {
      if (s.account && !s.units.some((u) => u.slug === m.slug)) {
        s.units.push({ id: `always-${m.slug}`, slug: m.slug, synthetic: true, level: 0, xp: 0, xpNeeded: 0,
          xpLevel: RULES.maxXpLevel, bonus: 0, talents: 0, rarity: 0, stars: 0, talentPicks: [] });
      }
    }
    const changed = !state || s.rev !== state.rev || s.account !== state.account;
    setState(s);
    ui.account = s.account;
    state.connError = null;
    $('#quitButton').hidden = !s.standalone;
    if (s.appVersion) {
      $('#appVersion').textContent = `v${s.appVersion}`;
      $('#appVersion').hidden = false;
    }
    if (changed) requestRender();
    renderUpdate();
  } catch (e) {
    if (mine !== asked) return;
    if (state) state.connError = e.message;
  }
  renderStatus();
  renderReportBadge();
}

// Defer redraws while the user is editing a field. (Not for the lists in the header and above the grid: a redraw
// leaves them as they are, and picking an account has to show at once though its list keeps the keyboard.)
const LIVE_LISTS = ['account', 'show', 'sort'];
// Any other list or slider holds redraws only until something is picked in it: this is the one last picked in,
// until it is touched again.
let picked = null;
function requestRender() {
  const a = document.activeElement;
  if (a && a.matches('input, select, textarea') && !a.closest('.drawer-body') && !LIVE_LISTS.includes(a.id) && a !== picked) {
    setDirty(true);
    return;
  }
  setDirty(false);
  render();
}
const afterEdit = () => setTimeout(() => { if (dirty) requestRender(); }, 0);
document.addEventListener('focusout', afterEdit);
document.addEventListener('change', (e) => {
  if (!e.target.matches('select, input[type="range"]')) return;
  picked = e.target;
  afterEdit();
});
for (const touch of ['pointerdown', 'keydown']) {
  document.addEventListener(touch, (e) => { if (e.target === picked) picked = null; }, true);
}

// Each tab's page, apart from Collection, which render() always redraws
const TAB_PAGES = { army: renderArmy, armory: renderArmory, calendar: renderCalendar, pvp: renderPvp, grid: renderGridTab,
  progress: renderProgress };

export function setTab(tab) {
  ui.tab = tab;
  store.set('tab', tab);
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  for (const b of document.querySelectorAll('[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    b.tabIndex = b.dataset.tab === tab ? 0 : -1; // (Tab reaches the open one; the arrows reach the others)
  }
  for (const page of document.querySelectorAll('main[id^="tab-"]')) page.hidden = page.id !== `tab-${tab}`;
  TAB_PAGES[tab]?.();
}

function render() {
  if (!state) return;
  renderDataBanner();
  renderAccounts();
  TAB_PAGES[ui.tab]?.();
  renderCurrencies();
  renderSummary();
  renderNeeds();
  renderPlanner();
  renderFilters();
  renderGrid();
  renderEvents();
  if (panel.open) renderDrawer();
}

function renderStatus() {
  const el = $('#status');
  if (!state) return;
  const err = state.connError || state.lastError;
  const live = `${state.gameRunning === false ? 'Game closed' : 'Live'} · last read ${ago(state.lastScan)}`;
  el.className = `status${err ? ' error' : state.gameRunning === false ? ' idle' : ''}`;
  el.innerHTML = `<span class="dot"></span><span class="status-text">${err ? esc(err) : live}</span>`;
}

let accountsShown = ''; // the account list as it was last written
function renderAccounts() {
  const sel = $('#account');
  const options = state.accounts.map((a) => `<option value="${a.id}"
    ${a.id === state.account ? 'selected' : ''}>${esc(a.label)} (${a.units} minis)</option>`).join('')
    || '<option>No Rumble data found on this PC</option>';
  // (written only when it changed: writing it closes the list while it is open)
  if (options !== accountsShown) sel.innerHTML = accountsShown = options;
  const current = state.accounts.find((a) => a.id === state.account);
  const input = $('#accountLabel');
  if (document.activeElement !== input) input.value = current && !current.label.startsWith('Account …') ? current.label : '';
}

function bindHeader() {
  $('#account').addEventListener('change', (e) => {
    ui.account = e.target.value;
    store.set('account', ui.account);
    setState(null);
    poll();
  });
  $('#accountLabel').addEventListener('change', async (e) => {
    if (!state?.account) return;
    try {
      await post('/api/name', { kind: 'account', id: state.account, value: e.target.value });
    } catch (err) {
      alertDialog(err.message, { title: 'Not saved' });
    }
    poll();
  });
  $('#quitButton').addEventListener('click', quitTracker);
}

boot().catch((e) => { $('#status').textContent = `The page could not start. ${e.message}`; });
