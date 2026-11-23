// The banner when the game is newer than the tracker's game data, and the pop-up for a new version of the tracker.
import { schedulePoll, poll } from './app.js';
import { $, post, openExternal, state } from './core.js';
import { alertDialog } from './dialogs.js';
import { RELEASES_URL } from './lib/constants.js';
import { esc, megabytes } from './lib/format.js';

/** The banner shown while the game is newer than the game data: it is being read again, or why it can't be. */
export function renderDataBanner() {
  const el = $('#dataBanner');
  const d = state?.dataStatus;
  if (!el) return;
  el.hidden = !(d?.stale || d?.reading);
  if (el.hidden) return;
  const now = d.reading ? 'The tracker is reading the new game data from your game install now; this page picks it up when it is done.'
    : d.readError ? `Reading the new game data did not work (${esc(d.readError)}); the tracker tries again within the hour.`
      : d.canRead ? 'The tracker reads the new game data from your game install shortly.'
        : 'Run npm run build-gamedata to read the new game data.';
  el.innerHTML = `<b>The game was updated${d.stale ? ` to ${esc(d.gameBuild)}` : ''}.</b> The tracker's game data is from
    ${esc(d.dataBuild)}, so new minis, events or shop offers may be missing or unnamed for a moment. ${now}
    Your own progress is read from the game as usual.`;
}

/**
 * The pop-up for a new tracker version. Download now has the exe download, check and install it and restart; from
 * source, or without download checksums, it opens GitHub Releases instead. Later hides it until the tracker restarts.
 */
let updateShown = null; // what the dialog shows now, so it is only redrawn when that changes
export function renderUpdate() {
  const dlg = $('#updateDialog');
  const u = state?.update;
  // Keep showing it while the tracker restarts and the server is briefly gone.
  const busy = u && (u.state === 'downloading' || u.state === 'restarting');
  const show = u && (busy || !u.later);
  if (!show && !(updateShown?.endsWith(':restarting') && state?.connError)) {
    if (dlg.open) dlg.close();
    updateShown = null;
    return;
  }
  if (!u) return;
  const pct = u.total ? Math.min(100, Math.floor((u.done / u.total) * 100)) : null;
  const key = `${u.version}:${u.state}:${u.error || ''}:${pct}:${u.state === 'downloading' && !u.total
    ? megabytes(u.done) : ''}`;
  if (key !== updateShown) {
    updateShown = key;
    const head = `<div class="dialog-head"><h2>Version ${esc(u.version)} is available</h2></div>`;
    let body;
    if (u.state === 'downloading') {
      const progress = pct != null ? `${pct}% (${megabytes(u.done)} of ${megabytes(u.total)} MB)` : `${megabytes(u.done || 0)} MB`;
      body = `<p>Downloading the new version… ${progress}</p>
        <div class="bar"><span style="width:${pct ?? 0}%"></span></div>`;
    } else if (u.state === 'restarting') body = '<p>Installing. The tracker restarts in a moment and this window reloads by itself.</p>';
    else {
      body = `${u.state === 'failed' ? `<p class="text-warn">The update didn't work: ${esc(u.error || 'unknown error')}</p>` : ''}
        <p>${u.auto ? 'The tracker can download and install it now, then restart. Your data is kept.'
          : 'Download it from GitHub Releases, or build it; your data is kept.'}</p>
        <div class="dialog-actions"><button class="button" data-update-now>${u.auto && u.state !== 'failed'
          ? 'Download now' : 'Open GitHub Releases'}</button>
          <button class="chip" data-update-later>Later</button></div>`;
    }
    dlg.innerHTML = `<div class="dialog-form">${head}${body}</div>`;
  }
  if (!dlg.open) dlg.showModal();
}

async function updateNow() {
  const u = state?.update;
  if (!u) return;
  if (!u.auto || u.state === 'failed') {
    openExternal(RELEASES_URL);
    return updateLater();
  }
  try {
    await post('/api/update', {});
  } catch (e) {
    alertDialog(e.message, { title: 'The update could not start' });
  }
  await poll();
  schedulePoll();
}
async function updateLater() {
  try {
    await post('/api/update/later', {});
  } catch {
    // the server is gone
  }
  if (state?.update) state.update.later = true;
  renderUpdate();
}

export function bindUpdate() {
  const dlg = $('#updateDialog');
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-update-now]')) updateNow();
    if (e.target.closest('[data-update-later]')) updateLater();
  });
  // Esc means Later, unless the update is already under way.
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    const st = state?.update?.state;
    if (st !== 'downloading' && st !== 'restarting') updateLater();
  });
}
