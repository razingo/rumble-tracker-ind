// The Backup menu: exporting, importing a file, and the automatic backups the tracker writes.
import { poll } from './app.js';
import { forgetDraft } from './army.js';
import { $, getJson, post, setState } from './core.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { esc, dateTime, shortDay, localDay } from './lib/format.js';

// What each part of a backup is called after a restore (the keys of BACKUP_KEYS in server/userdata.mjs)
const LABELS = {
  names: 'names', talents: 'talents', army: 'army slots', armies: 'saved armies', drafts: 'the army being edited',
  grid_history: 'G.R.I.D. history', pvp_history: 'PvP history',
  notifications: 'notification settings', plans: 'reward goals', progress: 'progress history',
  settings: 'the close-window and new-version settings',
};

/** Asks first, then restores a backup by calling restore(). `what` names it, as in "the backup from …". */
async function restoreBackup(what, restore) {
  const message = 'This replaces what you entered (names, talents, army slots, armies, goals and settings) and the '
    + `G.R.I.D., PvP and progress history with ${what}.`;
  if (!(await confirmDialog(message, { title: 'Restore this backup?', ok: 'Restore' }))) return;
  try {
    const r = await restore();
    forgetDraft(); // the draft comes from the restored data
    setState(null);
    await poll();
    const named = (keys) => keys.map((k) => LABELS[k] || k).join(', ');
    const notes = [
      r.leftOut?.length ? `Left out, as they did not hold what the tracker keeps: ${named(r.leftOut)}.` : '',
      r.incomplete?.length ? `Restored only in part, as some of what they held was not what the tracker keeps: ${
        named(r.incomplete)}. Report a problem lists what was left out.` : '',
    ].filter(Boolean).map((n) => `\n\n${n}`).join('');
    if (!r.restored.length) alertDialog(`Nothing in this backup could be restored.${notes}`, { title: 'Not restored' });
    else alertDialog(`Restored ${named(r.restored)}.${notes}`, { title: 'Backup restored' });
  } catch (err) {
    alertDialog(err.message, { title: 'Not restored' });
  }
}

/** The automatic backups in the Backup menu. */
async function renderBackupList() {
  const el = $('#backupList');
  try {
    const { backups } = await getJson('/api/backups', 'the automatic backups');
    const today = localDay();
    const label = (day) => (day === today ? 'today' : shortDay(`${day}T12:00:00`));
    el.innerHTML = backups.length
      ? backups.map((b) => `<button role="menuitem" data-backup-day="${esc(b.day)}" data-backup-label="${esc(label(b.day))}"
        title="Saved ${esc(dateTime(b.created))}">Restore ${esc(label(b.day))}</button>`).join('')
      : '<p class="small muted">None yet. The tracker saves one when it starts, every 24 hours and when it stops.</p>';
  } catch (err) {
    el.innerHTML = `<p class="small muted">${esc(err.message)}</p>`;
  }
}

export function bindBackupMenu() {
  const menu = $('#backupMenu');
  const setMenu = (open) => {
    menu.hidden = !open;
    $('#backupButton').setAttribute('aria-expanded', String(open));
    if (open) renderBackupList();
  };
  $('#backupButton').addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(menu.hidden);
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.backup')) setMenu(false); });
  menu.querySelector('a').addEventListener('click', () => setTimeout(() => setMenu(false), 0));
  $('#backupImport').addEventListener('click', () => $('#backupFile').click());
  $('#backupList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-backup-day]');
    if (!b) return;
    setMenu(false);
    await restoreBackup(`the automatic backup from ${b.dataset.backupLabel}`,
      () => post('/api/backups/restore', { day: b.dataset.backupDay }));
  });
  $('#backupFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    setMenu(false);
    if (!file) return;
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch (err) {
      alertDialog(`The file could not be read (${err.message}).`, { title: 'Not restored' });
      return;
    }
    // (a file that holds no backup, `null` included, is refused by the server like any other)
    await restoreBackup(`the backup from ${backup?.created ? dateTime(backup.created) : 'an unknown date'}`,
      () => post('/api/restore', { backup }));
  });
}
