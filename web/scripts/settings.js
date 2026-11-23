// The Settings dialog: Start with Windows, what closing the window does, the notifications, uninstalling and, at the
// bottom, extracting the additional data (for the rdmodule, web/scripts/rdmodule.js). The
// server keeps the settings and sends the notifications, also while the page is closed.
import { $, getJson, post, showMessage, state } from './core.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { CLOSE_CHOICES } from './lib/constants.js';
import { esc, dateTime } from './lib/format.js';

let notify = null; // { settings, types, log, pending, playing }
let general = null; // { startWithWindows, closeWindow, checkUpdates, gameFolder }, each null where it doesn't apply
let extra = null; // the additional data: { available, state, done, total, label, error } (server/rdmodule.mjs)
let extraTimer = null;

async function loadSettings() {
  [notify, general, extra] = await Promise.all([
    getJson('/api/notifications', 'the notification settings'),
    getJson('/api/settings', 'the settings'),
    getJson('/api/rdmodule', 'the additional data').catch(() => null),
  ]);
}

const dialogHead = '<div class="dialog-head"><h2>Settings</h2><button class="chip" value="close" aria-label="Close">✕</button></div>';

/** The game's folder, where the tracker reads its game data from the game: the one found, or one given by hand. */
function gameFolderSection() {
  if (general?.gameFolder == null) return '';
  return `<label class="game-folder">Warcraft Rumble's folder
      <input type="text" data-setting="gameFolder" value="${esc(general.gameFolder)}" spellcheck="false"
        placeholder="${esc(general.gameFolderUsed || 'D:\\Games\\Warcraft Rumble')}"></label>
    <p class="muted small">${general.gameFolderUsed ? `The game data is read from ${esc(general.gameFolderUsed)}.`
      : 'The game was not found on this PC.'} Fill this in only if that is wrong: the folder that holds
      WarcraftRumble.exe. Empty means it is looked for. It applies from the tracker's next start.</p>`;
}

/** Start with Windows and what closing the window does, which only the exe has, and the check for new versions. */
function generalSection() {
  const autostart = general?.startWithWindows == null
    ? '<p class="muted small">Start with Windows is available in RumbleTracker.exe.</p>'
    : `<label class="dialog-toggle"><input type="checkbox" data-setting="startWithWindows"
      ${general.startWithWindows ? 'checked' : ''}> Start with Windows</label>
      <p class="muted small">Starts in the tray when you sign in to Windows (no window), so notifications arrive
        without opening the tracker.</p>`;
  const close = general?.closeWindow == null ? '' : `<label class="close-window">When I close the window
      <select data-setting="closeWindow">${Object.entries(CLOSE_CHOICES).map(([value, label]) =>
        `<option value="${value}" ${general.closeWindow === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <p class="muted small">In the tray, notifications still arrive. "Ask me" asks once, and your answer is kept here.</p>`;
  const updates = general?.checkUpdates == null ? '' : `<label class="dialog-toggle"><input type="checkbox"
      data-setting="checkUpdates" ${general.checkUpdates ? 'checked' : ''}> Check for new versions</label>
      <p class="muted small">Asks GitHub once a day for the tracker's latest version. Nothing about you is sent.</p>`;
  return `<h3>General</h3>${autostart}${close}${updates}<span class="dialog-message small" data-setting-message></span>`;
}

/** One notification type: on or off, its warning time if it has one, and whether it is sent while playing. */
function notificationRow(t) {
  const v = notify.settings.types[t.id];
  const hours = t.hoursBefore ? `<span class="notify-hours">· warn <input type="number" min="1" max="72"
    value="${v.hoursBefore}" data-notify-type="${t.id}" data-notify-field="hoursBefore"> hours before the end</span>` : '';
  return `<tr>
    <td><label class="notify-on"><input type="checkbox" data-notify-type="${t.id}" data-notify-field="on"
      ${v.on ? 'checked' : ''}> ${esc(t.label)}</label>
      ${hours}</td>
    <td class="notify-play"><input type="checkbox" data-notify-type="${t.id}" data-notify-field="whenPlaying"
      ${v.whenPlaying ? 'checked' : ''} ${v.on ? '' : 'disabled'} aria-label="Also while the game is running: ${esc(t.label)}"></td>
  </tr>`;
}

function notificationsSection() {
  const s = notify.settings;
  const accounts = state?.accounts || [];
  return `<h3>Notifications</h3>
    <p class="muted small">They keep coming while the tracker runs, even with this window closed.</p>
    <label class="dialog-toggle"><input type="checkbox" data-notify-field="enabled"
      ${s.enabled ? 'checked' : ''}> Send notifications</label>
    <label class="notify-account">For <select data-notify-field="account">
      <option value="">all accounts</option>
      ${accounts.map((a) => `<option value="${a.id}" ${s.account === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
    </select></label>
    <table class="notify-table${s.enabled ? '' : ' off'}">
      <thead><tr><th></th><th title="When unticked, this isn't sent while the game is running">Also while<br>playing</th></tr></thead>
      <tbody>${notify.types.map(notificationRow).join('')}</tbody>
    </table>
    <p class="muted small">Types left unticked under "Also while playing" are skipped while the game is
      running${notify.playing ? ' (it is running now)' : ''}. Reward goals are set in an event's reward tree on the Calendar.</p>
    <div class="notify-quiet">
      <label><input type="checkbox" data-notify-field="quiet.on" ${s.quiet.on ? 'checked' : ''}> Quiet hours</label>
      <input type="time" data-notify-field="quiet.from" value="${esc(s.quiet.from)}"> – <input type="time"
        data-notify-field="quiet.to" value="${esc(s.quiet.to)}">
      <span class="muted small">held until they end${notify.pending ? ` · ${notify.pending} waiting` : ''}</span>
    </div>
    <div class="dialog-actions"><button type="button" class="button" data-notify-test>Send a test notification</button><span
      class="dialog-message small"></span></div>`;
}

/** The latest notifications sent, and whether Windows took them. */
function recentSection() {
  const item = (n) => `<li><span class="muted small">${esc(dateTime(n.t))}</span> <b>${esc(n.title)}</b> <span
    class="small">${esc(n.body)}</span>${n.delivered ? '' : ' <span class="text-warn small">(not delivered)</span>'}</li>`;
  return `<h3>Recent</h3>${notify.log.length
    ? `<ul class="notify-log">${notify.log.map(item).join('')}</ul>` : '<p class="muted small">Nothing sent yet.</p>'}`;
}

/** Uninstall, only in the exe. */
function uninstallSection() {
  if (!state?.standalone) return '';
  return `<h3>Uninstall</h3>
    <p class="muted small">Removes the tracker and everything it stored from this PC.</p>
    <div class="dialog-actions"><button type="button" class="chip danger" data-uninstall>Uninstall the tracker…</button></div>`;
}

/** The additional data, where this tracker can extract it: whether it is extracted, how far a run is, the button. */
function extraSection() {
  if (!extra?.available) return '';
  const when = typeof extra.extracted === 'string' ? ` on ${esc(dateTime(extra.extracted))}` : '';
  const have = extra.extracted ? `<span class="extra-state good">✔ Extracted${when}</span>`
    : '<span class="extra-state">Not extracted</span>';
  const line = extra.state === 'running'
    ? `<p class="muted small">Extracting in the background: ${extra.total
      ? `${extra.done} of ${extra.total} steps done${extra.label ? ` · now: ${esc(extra.label)}` : ''}` : 'starting'}</p>`
    : extra.state === 'failed' ? `<p class="muted small">The last extraction failed: ${esc(extra.error || 'unknown reason')}</p>` : '';
  const button = extra.state === 'running' ? '<span class="extra-state">Extracting…</span>'
    : `<button type="button" class="chip" data-extract>${extra.extracted ? 'Extract again?' : 'Extract additional data?'}</button>`;
  return `<div data-extra><div class="dialog-actions extra-row">${button}${have}</div>${line}</div>`;
}

/** While the extraction runs and Settings is open, its progress is asked for every two seconds. */
function watchExtra(dlg) {
  clearTimeout(extraTimer);
  if (extra?.state !== 'running' || !dlg.open) return;
  extraTimer = setTimeout(async () => {
    extra = await getJson('/api/rdmodule', 'the additional data').catch(() => extra);
    const box = dlg.querySelector('[data-extra]');
    if (box) box.outerHTML = extraSection();
    watchExtra(dlg);
  }, 2000);
}

async function extractExtra(dlg) {
  if (!(await confirmDialog('', { title: 'But why?', ok: 'Extract' }))) return;
  try {
    extra = await post('/api/rdmodule/extract', {});
  } catch (err) {
    return alertDialog(err.message, { title: 'Not started' });
  }
  const box = dlg.querySelector('[data-extra]');
  if (box) box.outerHTML = extraSection();
  watchExtra(dlg);
}

const UNINSTALL_MESSAGE = 'This removes RumbleTracker.exe and everything the tracker keeps on this PC: your names, '
  + 'armies, goals, history and settings, the automatic backups, the game data, the Start menu shortcut and Start '
  + 'with Windows. It can\'t be undone.\n\nIf you might come back, first save a backup with Backup → Export backup.';

async function uninstall(dlg) {
  if (!(await confirmDialog(UNINSTALL_MESSAGE, { title: 'Uninstall the tracker?', ok: 'Uninstall', danger: true }))) return;
  try {
    await post('/api/uninstall', {});
  } catch (err) {
    return alertDialog(err.message, { title: 'Not uninstalled' });
  }
  dlg.close();
  document.body.innerHTML = '<main class="quit-page"><h1>The tracker is being removed</h1>'
    + '<p>This window closes in a moment.</p></main>';
}

function renderSettings() {
  const dlg = $('#settingsDialog');
  if (!notify) {
    dlg.innerHTML = '<p>Loading…</p>';
    return;
  }
  dlg.innerHTML = `<form method="dialog" class="dialog-form">${dialogHead}${generalSection()}${gameFolderSection()}${notificationsSection()}
    ${recentSection()}${uninstallSection()}${extraSection()}</form>`;
}

const notifyMessage = (dlg) => dlg.querySelector('.dialog-message:not([data-setting-message])');

async function openSettings(dlg) {
  dlg.showModal();
  renderSettings();
  try {
    await loadSettings();
    renderSettings();
  } catch (err) {
    dlg.innerHTML = `<form method="dialog" class="dialog-form">${dialogHead}
      <p class="dialog-message small text-warn">${esc(err.message)}</p></form>`;
  }
}

/** Saves Start with Windows or the close choice; on failure the field goes back to what is saved. */
async function saveGeneral(dlg, el) {
  const msg = dlg.querySelector('[data-setting-message]');
  try {
    general = await post('/api/settings', { [el.dataset.setting]: el.type === 'checkbox' ? el.checked : el.value });
    showMessage(msg, 'Saved.', 'good');
  } catch (err) {
    if (el.type === 'checkbox') el.checked = !el.checked;
    else el.value = general[el.dataset.setting];
    showMessage(msg, `Not saved. ${err.message}`, 'warn');
  }
}

/** Saves a notification setting; on failure the dialog goes back to what is saved. */
async function changeNotification(dlg, el) {
  const field = el.dataset.notifyField;
  const saved = structuredClone(notify.settings);
  const s = notify.settings;
  const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  if (el.dataset.notifyType) s.types[el.dataset.notifyType][field] = value;
  else if (field.startsWith('quiet.')) s.quiet[field.slice('quiet.'.length)] = value;
  else if (field === 'account') s.account = value || null;
  else s[field] = value;
  let result = ['Saved.', 'good'];
  try {
    notify.settings = (await post('/api/notifications', { settings: s })).settings;
  } catch (err) {
    notify.settings = saved;
    result = [`Not saved. ${err.message}`, 'warn'];
  }
  // redraw first, so the message isn't replaced
  renderSettings();
  showMessage(notifyMessage(dlg), ...result);
}

async function sendTest(dlg) {
  showMessage(notifyMessage(dlg), 'Sending…');
  let result = ['Sent. Check the corner of your screen.', 'good'];
  try {
    await post('/api/notifications/test', {});
  } catch (err) {
    result = [err.message, 'warn'];
  }
  await loadSettings();
  renderSettings();
  showMessage(notifyMessage(dlg), ...result);
}

export function bindSettings() {
  const dlg = $('#settingsDialog');
  $('#settingsButton').addEventListener('click', () => openSettings(dlg));
  dlg.addEventListener('change', (e) => {
    if (e.target.dataset.setting) saveGeneral(dlg, e.target);
    else if (e.target.dataset.notifyField && notify) changeNotification(dlg, e.target);
  });
  dlg.addEventListener('click', (e) => {
    // a click on the backdrop closes the dialog
    if (e.target === dlg) dlg.close();
    else if (e.target.closest('[data-notify-test]')) sendTest(dlg);
    else if (e.target.closest('[data-uninstall]')) uninstall(dlg);
    else if (e.target.closest('[data-extract]')) extractExtra(dlg);
  });
}
