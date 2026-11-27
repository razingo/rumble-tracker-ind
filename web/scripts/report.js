// Report a problem. Script errors on the page go to the server's error log, and the dialog builds a report the player
// can open as a GitHub issue or copy. Nothing is sent until the player submits it. The page loads this module first,
// so it also catches start-up errors.
import { $, getJson, post, showMessage, copyText, openExternal, state, ui } from './core.js';
import { esc, plural } from './lib/format.js';

(() => {
  let sent = 0;
  const report = (message, stack) => {
    if (++sent > 30) return; // cap error loops
    fetch('/api/client-error', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ where: location.hash.slice(1), message: String(message || '').slice(0, 500),
        stack: String(stack || '').slice(0, 1500) }),
    }).catch(() => { /* server not reachable: nothing to do */ });
  };
  // A bubbling listener sees script errors but not failed image loads.
  window.addEventListener('error', (e) => report(e.message, e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || e.reason, e.reason?.stack));
})();

const REPORT = { data: null, title: '', what: '', steps: '', include: true, screenshot: false };
const MAX_URL = 7500; // GitHub rejects longer URLs

export function renderReportBadge() {
  const b = document.getElementById('reportButton');
  if (!b) return;
  const n = state?.problems || 0;
  b.classList.toggle('has-problems', n > 0);
  b.title = n ? `${plural(n, 'error')} noted since the tracker started` : '';
}

function reportText() {
  const d = REPORT.data;
  const body = [
    '### What happened', REPORT.what.trim() || '_(not described)_', '',
    ...(REPORT.steps.trim() ? ['### How to make it happen', REPORT.steps.trim(), ''] : []),
    ...(REPORT.screenshot ? ['### Screenshot', '_(paste it here with Ctrl+V)_', ''] : []),
    ...(REPORT.include && d ? ['### Details (added by the tracker)', '```', d.diagnostics, '```'] : []),
  ].join('\n');
  return { title: REPORT.title.trim() || 'Problem report', body };
}

/** The GitHub new-issue URL, leaving out the oldest errors when it would be longer than MAX_URL. */
function issueUrl() {
  const repo = REPORT.data?.repo;
  const make = (title, body) =>
    `https://github.com/${repo}/issues/new?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  let { title, body } = reportText();
  let url = make(title, body);
  while (url.length > MAX_URL) {
    const lines = body.split('\n');
    const firstError = lines.findIndex((l) => l.startsWith('- ['));
    if (firstError >= 0) {
      lines.splice(firstError, 1, ...(lines.includes('- (older errors left out)') ? [] : ['- (older errors left out)']));
      body = lines.join('\n');
    } else body = `${body.slice(0, Math.floor(body.length * 0.8))}\n…(shortened)`;
    url = make(title, body);
  }
  return url;
}

function renderReportDialog(msg = '') {
  const dlg = $('#reportDialog');
  const d = REPORT.data;
  dlg.innerHTML = `<form method="dialog" class="report-form">
    <div class="dialog-head"><h2>Report a problem</h2><button class="chip" value="close" aria-label="Close">✕</button></div>
    <div class="dialog-card">
    <p class="muted small">Opens a GitHub issue (free account needed). Nothing is sent until you press <b>Submit</b> there.</p>
    <label class="report-field">Short title <input data-report-field="title" maxlength="120" value="${esc(REPORT.title)}"
      placeholder="e.g. Calendar shows the wrong end date for Darkmoon Faire"></label>
    <label class="report-field">What happened? What did you expect?
      <textarea data-report-field="what" rows="4"
        placeholder="Please don't include account names or other personal details.">${esc(REPORT.what)}</textarea></label>
    <label class="report-field">How can it be repeated? <span class="muted small">(optional)</span>
      <textarea data-report-field="steps" rows="2">${esc(REPORT.steps)}</textarea></label>
    <label class="report-include"><input type="checkbox" data-report-field="include" ${REPORT.include ? 'checked' : ''}>
      Add the details below (helps a lot)</label>
    <details class="report-details"${d?.errors ? ' open' : ''}><summary>Details that would be added${d
      ? ` · ${d.errors ? `${plural(d.errors, 'recent error')}` : 'no errors noted'}` : ''}</summary>
      <pre>${d ? esc(d.diagnostics) : 'Loading…'}</pre>
      <p class="muted small">Versions, game-data status and recent errors, with names, account IDs and other personal details
        removed. Your collection is never included.</p>
    </details>
    <p class="small">${state?.standalone
    ? '<button type="button" class="chip" data-report-screenshot>Take a screenshot</button> Select an area; it is copied, so '
      + 'paste it into the issue on GitHub with <b>Ctrl+V</b>.'
    : 'For a screenshot, press <b>Win+Shift+S</b>, select an area, then paste it into the issue on GitHub with <b>Ctrl+V</b>.'}</p>
    </div>
    <div class="report-actions">
      <button type="button" class="button" data-report-open ${d ? '' : 'disabled'}>Open on GitHub</button>
      <button type="button" class="chip" data-report-copy ${d ? '' : 'disabled'}>Copy report</button>
      ${d?.errors ? '<button type="button" class="chip" data-report-clear title="Forget the errors noted so '
        + 'far">Clear errors</button>' : ''}
      <span class="dialog-message small">${esc(msg)}</span>
    </div>
  </form>`;
}

/** The details a report can carry, with the tab that is open. */
const reportDetails = () => getJson(`/api/report?page=${encodeURIComponent(ui.tab || '')}`, 'the report details');

async function openReportDialog() {
  const dlg = $('#reportDialog');
  REPORT.data = null;
  REPORT.screenshot = false; // (one taken for an earlier report is not part of this one)
  renderReportDialog();
  dlg.showModal();
  try {
    REPORT.data = await reportDetails();
    renderReportDialog();
  } catch (err) {
    renderReportDialog(err.message);
  }
}

export function bindReport() {
  const dlg = $('#reportDialog');
  $('#reportButton').addEventListener('click', openReportDialog);
  dlg.addEventListener('input', (e) => {
    const k = e.target.dataset.reportField;
    if (k) REPORT[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  });
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) {
      dlg.close();
      return;
    }
    const msg = (text, ok) => showMessage(dlg.querySelector('.dialog-message'), text, ok ? 'good' : 'warn');
    if (e.target.closest('[data-report-open]')) {
      if (!REPORT.what.trim()) {
        msg('Please describe what happened first.', false);
        dlg.querySelector('[data-report-field="what"]').focus();
        return;
      }
      openExternal(issueUrl());
      msg('The issue opened in your browser. Check it and press Submit there.', true);
    } else if (e.target.closest('[data-report-screenshot]')) {
      // The dialog closes for Windows' snipping overlay and comes back once the window has the focus again.
      dlg.close();
      try {
        await post('/api/screenshot', {});
      } catch (err) {
        dlg.showModal();
        msg(err.message, false);
        return;
      }
      REPORT.screenshot = true;
      const back = () => { if (!dlg.open) {
        dlg.showModal();
        msg('Screenshot copied. Paste it into the issue with Ctrl+V.', true);
      } };
      setTimeout(() => window.addEventListener('focus', back, { once: true }), 500);
    } else if (e.target.closest('[data-report-copy]')) {
      const { title, body } = reportText();
      if (await copyText(`${title}\n\n${body}`)) msg('Copied.', true);
      else msg('Copying was blocked by the browser.', false);
    } else if (e.target.closest('[data-report-clear]')) {
      try {
        await post('/api/report/clear', {});
        REPORT.data = await reportDetails();
      } catch (err) {
        msg(err.message, false);
        return;
      }
      if (state) state.problems = 0;
      renderReportBadge();
      renderReportDialog('Cleared.');
    }
  });
}
