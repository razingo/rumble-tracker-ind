// In-app message and confirmation dialogs, in place of the browser's alert() and confirm().
import { $ } from './core.js';
import { esc } from './lib/format.js';

let queue = Promise.resolve(); // one dialog at a time

/**
 * Shows a dialog and resolves to the value of the button pressed (the first button's when closed with Esc, so Cancel
 * goes first). `message` is plain text, where a blank line starts a new paragraph. `buttons` are
 * [{ label, value, primary, danger }].
 */
export function showDialog({ title, message, buttons }) {
  const run = () => new Promise((resolve) => {
    const dlg = $('#messageDialog');
    const paragraphs = String(message || '').split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    dlg.innerHTML = `<form method="dialog" class="dialog-form message-form">
      ${title ? `<div class="dialog-head"><h2>${esc(title)}</h2></div>` : ''}
      <div class="message-body">${paragraphs}</div>
      <div class="message-actions">${buttons.map((b, i) => `<button value="${i}"
        class="${b.primary ? `button${b.danger ? ' danger' : ''}` : 'chip'}">${esc(b.label)}</button>`).join('')}</div>
    </form>`;
    dlg.addEventListener('close', () => {
      const i = Number(dlg.returnValue);
      resolve(Number.isInteger(i) && buttons[i] ? buttons[i].value : null);
    }, { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    (dlg.querySelector('.button') || dlg.querySelector('button'))?.focus();
  });
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

/** Resolves to true when confirmed. */
export async function confirmDialog(message, { title, ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return (await showDialog({ title, message, buttons: [{ label: cancel, value: false },
    { label: ok, value: true, primary: true, danger }] })) === true;
}

/** A message with an OK button. */
export async function alertDialog(message, { title } = {}) {
  await showDialog({ title, message, buttons: [{ label: 'OK', value: true, primary: true }] });
}
