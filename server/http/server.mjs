// The HTTP server on 127.0.0.1 serves the page (web/), the game data (/static/) and the API. Only the tracker's own
// page may use it (guard.mjs).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGuard, requestPath } from '../guard.mjs';
import { createRoutes } from './routes.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// The content security policy allows only the page's own scripts (no inline scripts, handlers or eval), and
// connections and images only to this server. Inline style attributes are allowed, as the page sets colors with them.
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** Answers with JSON (`body` as an object or already serialized) and any extra headers. */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function serveFile(res, base, rel) {
  const file = path.resolve(base, `.${rel}`);
  if (!file.startsWith(base + path.sep)) return send(res, 403, { error: 'That file is outside the tracker\'s folders.' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'The tracker has no such file.' });
  }
}

/** `deps` are passed to the routes (routes.mjs). Returns the http.Server, not listening yet. */
export function createHttpServer(ctx, deps) {
  const refusal = createGuard(ctx.port);
  const { PUBLIC, STATIC, GAMEDATA } = ctx.paths;

  const routes = createRoutes(ctx, deps);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = requestPath(req.url);
      if (p === null) return send(res, 400, { error: 'The address is not valid.' }); // a malformed % escape
      const refused = refusal(req, p);
      if (refused) return send(res, 403, { error: refused });
      const route = routes.get(`${req.method} ${p}`);
      if (route) {
        const [status, body, headers] = await route(req, url);
        return send(res, status, body, headers);
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'The tracker doesn\'t accept this kind of request here.' });
      if (p.startsWith('/static/')) {
        // An installed data pack takes precedence.
        const rel = p.slice('/static'.length);
        const inPack = path.resolve(GAMEDATA, `.${rel}`);
        if (inPack.startsWith(GAMEDATA + path.sep)) {
          try {
            await stat(inPack);
            return serveFile(res, GAMEDATA, rel);
          } catch {
            // not in the pack
          }
        }
        return serveFile(res, STATIC, rel);
      }
      return serveFile(res, PUBLIC, p === '/' ? '/index.html' : p);
    } catch (e) {
      if (!e.status || e.status >= 500) ctx.errorLog.add('server', `${req.method} ${req.url?.split('?')[0]}: ${e.message}`);
      send(res, e.status || 500, { error: e.message });
    }
  });
}
