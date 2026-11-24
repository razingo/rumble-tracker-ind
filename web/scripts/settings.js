// The Settings dialog, a card for each section: Start with Windows, what closing the window does, the game's folder
// and the tracker's own, the notifications, extracting the additional data (for the rdmodule,
// web/scripts/rdmodule.js) and uninstalling. The server keeps the settings and sends the notifications, also while
// the page is closed.
import { $, getJson, post, showMessage, state } from './core.js';
import { showDialog, confirmDialog, alertDialog } from './dialogs.js';
import { CLOSE_CHOICES } from './lib/constants.js';
import { esc, dateTime, ago } from './lib/format.js';

let notify = null; // { settings, types, log, pending, playing }
// { startWithWindows, closeWindow (both null from source), checkUpdates, lastUpdateCheck, updateCheckError, gameFolder,
// gameFolderUsed, storageFolder (null from source) }
let general = null;
let extra = null; // the additional data: { available, state, done, total, label, error } (server/rdmodule.mjs)
let extraTimer = null;

async function loadSettings() {
  [notify, general, extra] = await Promise.all([
    getJson('/api/notifications', 'the notification settings'),
    getJson('/api/settings', 'the settings'),
    getJson('/api/rdmodule', 'the additional data').catch(() => null),
  ]);
}

/** One section of the dialog, in a card of its own; nothing when it has nothing to show. */
const section = (title, body, kind = '') => (body ? `<section class="dialog-card ${kind}"><h3>${title}</h3>${body}</section>` : '');
const gb = (bytes) => (bytes / 2 ** 30).toFixed(1).replace(/\.0$/, '');

const dialogHead = '<div class="dialog-head"><h2>Settings</h2><button class="chip" value="close" aria-label="Close">✕</button></div>';

/** A folder field with a button beside it that opens the folder in Explorer (`which`: game or storage). */
const folderField = (id, label, input, which, there) => `<label class="folder-label" for="${id}">${label}</label>
    <div class="folder-row"><input type="text" id="${id}" spellcheck="false" ${input}>
      <button type="button" class="chip folder-open" data-open-folder="${which}" title="Open this folder"
        aria-label="Open this folder" ${there ? '' : 'disabled'}><svg viewBox="0 0 20 20" aria-hidden="true"><path
        d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4l2 2h7A1.5 1.5 0 0 1 18 7.5V8H5.2a2 2 0 0 0-1.9 1.4L2 13.6Zm3.2 4h13.3a1 1 0 0 1 1 1.3l-1.3
        4.2a1.5 1.5 0 0 1-1.4 1H3.1a1 1 0 0 1-1-1.3l1.7-4.5a1.5 1.5 0 0 1 1.4-.7Z"/></svg></button></div>`;

/** The game's folder, where the tracker reads its game data from the game: the one found, or one given by hand. */
function gameFolderSection() {
  if (!general) return '';
  return `${folderField('gameFolder', 'Warcraft Rumble\'s folder', `data-setting="gameFolder" value="${esc(general.gameFolder)}"
      placeholder="${esc(general.gameFolderUsed || 'D:\\Games\\Warcraft Rumble')}"`, 'game', general.gameFolderUsed)}
    <p class="muted small">${general.gameFolderUsed ? `The game data is read from ${esc(general.gameFolderUsed)}.`
      : 'The game was not found on this PC.'} Fill this in only if that is wrong: the folder that holds
      WarcraftRumble.exe. Leave it empty to have the tracker look for the game.</p>`;
}

/** The folder the tracker keeps its files in (only the exe has a choice), and moving it. */
function storageSection() {
  if (!general?.storageFolder) return '';
  return `${folderField('storageFolder', 'The tracker\'s folder', `data-storage value="${esc(general.storageFolder)}"`, 'storage', true)}
    <p class="muted small">Everything the tracker keeps is here: your data, what it reads from the game and its own
      program files. To move it, type another folder, such as D:\\Games. The tracker makes a folder of its own named
      RumbleTracker in it, moves its files there and restarts.</p>`;
}

/** Moves the tracker's files to the folder typed, once confirmed; the tracker restarts for it. */
async function moveStorage(dlg, el) {
  const folder = el.value.trim();
  const back = () => { el.value = general.storageFolder; };
  if (!folder || folder === general.storageFolder) return back();
  if (!(await confirmDialog(`The tracker makes a folder of its own named RumbleTracker in ${folder} and moves all its `
    + 'files there. It closes, moves them, and starts again; that can take a few minutes.',
  { title: 'Move the tracker\'s files?', ok: 'Move' }))) return back();
  try {
    await post('/api/storage', { folder });
  } catch (err) {
    back();
    return alertDialog(err.message, { title: 'Not moved' });
  }
  dlg.close();
  document.body.innerHTML = '<main class="quit-page"><h1>The tracker\'s files are being moved</h1>'
    + '<p>This window closes in a moment, and the tracker starts again once they are moved.</p></main>';
}

/** When a newer version was last looked for, or why that did not work. */
function lastCheck() {
  if (general.updateCheckError) return ` The last check did not work (${esc(general.updateCheckError)}).`;
  return general.lastUpdateCheck ? ` Last checked ${esc(ago(general.lastUpdateCheck))}.` : '';
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
      <p class="muted small">Asks GitHub for the tracker's latest version when this window opens and once a day. Nothing
        about you is sent.${general.checkUpdates ? lastCheck() : ''}</p>`;
  return `${autostart}${close}${updates}${gameFolderSection()}${storageSection()}<span class="dialog-message small"
    data-setting-message></span>`;
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
  return `<p class="muted small">They keep coming while the tracker runs, even with this window closed.</p>
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
  return `${notify.log.length
    ? `<ul class="notify-log">${notify.log.map(item).join('')}</ul>` : '<p class="muted small">Nothing sent yet.</p>'}`;
}

/** Uninstall, only in the exe. */
function uninstallSection() {
  if (!state?.standalone) return '';
  return `<p class="muted small">Removes the tracker and everything it stored from this PC.</p>
    <div class="dialog-actions"><button type="button" class="chip danger" data-uninstall>Uninstall the tracker…</button></div>`;
}

/** The additional data, where this tracker can extract it: whether it is extracted, how far a run is, the button,
 * and what extracting takes. */
function extraSection() {
  if (!extra?.available) return '';
  const when = typeof extra.extracted === 'string' ? ` on ${esc(dateTime(extra.extracted))}` : '';
  const have = !extra.extracted ? '<span class="extra-state">Not extracted</span>'
    : extra.outOfDate ? `<span class="extra-state">Extracted${when} · the game or the tracker changed since</span>`
      : `<span class="extra-state good">✔ Extracted${when}</span>`;
  const line = extra.state === 'running'
    ? `<p class="muted small">${extra.waiting ? 'Waiting for the game data to be read first' : `Extracting in the background: ${
      extra.total ? `${extra.done} of ${extra.total} steps done${extra.label ? ` · now: ${esc(extra.label)}` : ''}` : 'starting'}`}</p>`
    : extra.state === 'failed' ? `<p class="muted small">The last extraction failed: ${esc(extra.error || 'unknown reason')}</p>` : '';
  const button = extra.state === 'running' ? '<span class="extra-state">Extracting…</span>'
    : `<button type="button" class="chip" data-extract>${extra.extracted ? 'Extract again?' : 'Extract additional data?'}</button>`;
  const space = extra.freeSpace == null ? '' : `It needs about ${gb(extra.neededSpace)} GB of free disk space, and ${
    gb(extra.freeSpace)} GB is free. `;
  return `<div data-extra class="extra-box"><div class="dialog-actions extra-row">${button}${have}</div>${line}
    <p class="muted small">${space}Extracting runs in the background and takes a few minutes.</p></div>`;
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
  // how things are right now: the disk may have filled, or been cleared, since Settings was opened
  extra = await getJson('/api/rdmodule', 'the additional data').catch(() => extra);
  if (extra?.freeSpace != null && extra.freeSpace < extra.neededSpace) {
    // too little room: nothing to press but Cancel, until some is freed
    await showDialog({ title: 'But why?', buttons: [{ label: 'Cancel', value: false, primary: true }],
      message: `This needs about ${gb(extra.neededSpace)} GB of free disk space, and ${gb(extra.freeSpace)} GB is free. `
        + 'Free some space, then come back.' });
    return;
  }
  // (a note only for a PC it applies to)
  const note = extra?.smallPc ? 'A PC with 8 GB of memory or less may have trouble with this.' : '';
  if (!(await confirmDialog(note, { title: 'But why?', ok: 'Extract' }))) return;
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
  + 'with Windows. It can\'t be undone.\n\nIf you might come back, keep a backup: your names, armies, goals, history '
  + 'and settings are saved to a file where you choose, and Backup → Import backup in a new tracker brings them back.';

/**
 * Saves the backup (what Backup → Export backup gives) to a file the user picks. Returns whether it was saved; when
 * the user cancels the choice of a file, nothing is said.
 */
async function saveBackupAs() {
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) throw new Error(`The tracker answered ${res.status}.`);
    const text = await res.text();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'rumble-tracker-backup.json';
    const file = await window.showSaveFilePicker({ suggestedName: name,
      types: [{ description: 'Tracker backup', accept: { 'application/json': ['.json'] } }] });
    const out = await file.createWritable();
    await out.write(text);
    await out.close();
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') {
      await alertDialog(`The backup was not saved (${err.message}), so nothing was uninstalled. Save one with Backup → `
        + 'Export backup, then uninstall.', { title: 'Not uninstalled' });
    }
    return false;
  }
}

async function uninstall(dlg) {
  const choice = await showDialog({ title: 'Uninstall the tracker?', message: UNINSTALL_MESSAGE, buttons: [
    { label: 'Cancel', value: null }, { label: 'Uninstall everything', value: 'all', danger: true },
    { label: 'Uninstall, keep a backup', value: 'keep', primary: true }] });
  if (!choice || (choice === 'keep' && !(await saveBackupAs()))) return;
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
  dlg.innerHTML = `<form method="dialog" class="dialog-form">${dialogHead}${section('General', generalSection())}
    ${section('Notifications', notificationsSection())}${section('Recent', recentSection())}
    ${section('Additional data', extraSection())}${section('Uninstall', uninstallSection(), 'danger')}</form>`;
}

const notifyMessage = (dlg) => dlg.querySelector('.dialog-message:not([data-setting-message])');

async function openSettings(dlg) {
  dlg.showModal();
  renderSettings();
  try {
    await loadSettings();
    renderSettings();
    watchExtra(dlg); // (an extraction started earlier may still run)
  } catch (err) {
    dlg.innerHTML = `<form method="dialog" class="dialog-form">${dialogHead}
      <p class="dialog-message small text-warn">${esc(err.message)}</p></form>`;
  }
}

/** Saves one of the general settings or the game's folder; on failure the field goes back to what is saved. */
async function saveGeneral(dlg, el) {
  const msg = dlg.querySelector('[data-setting-message]');
  try {
    general = await post('/api/settings', { [el.dataset.setting]: el.type === 'checkbox' ? el.checked : el.value });
    // redraw first, so the lines under the fields say what holds now (the folder in use, the last check)
    renderSettings();
    showMessage(dlg.querySelector('[data-setting-message]'), 'Saved.', 'good');
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
    else if ('storage' in e.target.dataset) moveStorage(dlg, e.target);
    else if (e.target.dataset.notifyField && notify) changeNotification(dlg, e.target);
  });
  dlg.addEventListener('click', (e) => {
    // a click on the backdrop closes the dialog
    if (e.target === dlg) dlg.close();
    else if (e.target.closest('[data-notify-test]')) sendTest(dlg);
    else if (e.target.closest('[data-uninstall]')) uninstall(dlg);
    else if (e.target.closest('[data-open-folder]')) {
      post('/api/open-folder', { which: e.target.closest('[data-open-folder]').dataset.openFolder }).catch(() => {});
    }
    else if (e.target.closest('[data-extract]')) extractExtra(dlg);
  });
}
