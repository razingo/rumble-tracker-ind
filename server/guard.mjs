// Only the tracker's own page may use the server. Other websites open in the same browser can reach localhost too, so
// requests are checked with headers that browsers set and pages can't forge. The Host must be this server's address,
// which stops DNS rebinding. An Origin, when sent, must be ours, and API calls must come from the same site. API
// writes must be JSON, which a form on another site can't send.

/** Returns refusal(req, pathname): the reason a request is refused, or null if it is allowed. */
export function createGuard(port) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return function refusal(req, p) {
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) return 'The tracker only answers requests for its own address.';
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return 'The tracker only answers its own page, not other websites.';
    if (p.startsWith('/api/')) {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return 'The tracker only answers its own page, not other websites.';
      const json = /^application\/json\b/i.test(req.headers['content-type'] || '');
      if (req.method !== 'GET' && !json) return 'The tracker only accepts JSON here.';
    }
    return null;
  };
}

/** The decoded path of a request URL, or null if it is malformed (a bad % escape). */
export function requestPath(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
}
