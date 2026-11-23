// A hidden key sequence, ↑ ↑ ↓ ↓ ← → ← → B A, opens the rdmodule in a window of its own
// (desktop/window.ps1), once its pictures and sounds were extracted from the game install (Extract additional data?
// in Settings). Only in the exe's window, where the page runs in WebView2.
import { getJson } from './core.js';

const SEQUENCE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
const IGNORED = ['Shift', 'CapsLock'];

export function bindRdmodule() {
  const webview = window.chrome?.webview;
  if (!webview) return;
  let at = 0;
  addEventListener('keydown', (e) => {
    if (IGNORED.includes(e.key)) return;
    // not while typing in a field
    if (e.ctrlKey || e.altKey || e.metaKey || (e.target instanceof Element
      && e.target.closest('input, textarea, select, [contenteditable]'))) {
      at = 0;
      return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === SEQUENCE[at]) at++;
    else if (key === 'ArrowUp') at = at === 2 ? 2 : 1; // a third ↑ still counts as the second
    else at = 0;
    if (at === SEQUENCE.length) {
      at = 0;
      // (what was extracted stays when a later extraction fails, so it opens then too)
      getJson('/api/rdmodule', 'the rdmodule').then((status) => {
        if (status.extracted && status.state !== 'running') webview.postMessage('rdmodule');
      }, () => {});
    }
  });
}
