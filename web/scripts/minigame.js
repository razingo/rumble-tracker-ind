// A hidden key sequence, ↑ ↑ ↓ ↓ ← → ← → W R, opens Rumble Dash, a small game, in a window of its own
// (desktop/window.ps1). Only in the exe's window, where the page runs in WebView2.
const SEQUENCE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'w', 'r'];
const IGNORED = ['Shift', 'CapsLock'];

export function bindMinigame() {
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
      webview.postMessage('minigame');
    }
  });
}
