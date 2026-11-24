// The window's close button, in RumbleTracker.exe. The window (desktop/window.ps1) asks the page before it closes, and
// the page answers "close", or "stay" when the question below was canceled. With "Ask me", it first asks whether to
// keep running in the tray or quit, and saves the answer, which the server then follows (server/main.mjs). An army
// edit not saved yet is saved before the window closes.
import { flushDraft } from './army.js';
import { getJson, post } from './core.js';
import { showDialog } from './dialogs.js';
import { CLOSE_CHOICES } from './lib/constants.js';

let asking = false;

async function answerClose(reply) {
  const close = async () => {
    await flushDraft();
    reply('close');
  };
  if (asking) return reply('asking');
  let choice;
  try {
    choice = (await getJson('/api/settings', 'the settings')).closeWindow;
  } catch {
    return close(); // the tracker isn't answering, so it stays in the tray
  }
  if (choice !== 'ask') return close();
  reply('asking');
  asking = true;
  try {
    const pick = await showDialog({
      title: 'Close the tracker?',
      message: 'The tracker can keep running in the tray, so notifications still arrive, or it can quit.\n\n'
        + 'Your answer is kept. You can change it in ⚙ Settings.',
      buttons: [{ label: 'Cancel', value: null }, { label: CLOSE_CHOICES.quit, value: 'quit' },
        { label: CLOSE_CHOICES.tray, value: 'tray', primary: true }],
    });
    if (!pick) return reply('stay');
    await post('/api/settings', { closeWindow: pick });
    await close();
  } catch {
    await close();
  } finally {
    asking = false;
  }
}

/** Answers the window's "close?" (only in the exe's window, where the page runs in WebView2). */
export function bindClosing() {
  const webview = window.chrome?.webview;
  if (!webview) return;
  webview.addEventListener('message', (e) => {
    if (e.data === 'close?') answerClose((m) => webview.postMessage(m));
  });
}
