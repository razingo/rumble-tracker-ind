// Report a problem keeps a log of recent errors and builds the diagnostics a player can add to an issue. Nothing is
// sent automatically. All report text goes through clean(), which removes user names in paths, account and save IDs,
// login tokens, e-mail addresses and long encoded values.
import os from 'node:os';
import { host } from './host.mjs';
import { REPO } from '../web/scripts/lib/constants.js';

// Repository where issues are filed. RUMBLE_ISSUES_REPO points tests of the report flow at another repository.
export const ISSUES_REPO = process.env.RUMBLE_ISSUES_REPO || REPO;

const MAX_ERRORS = 30;
const MAX_MESSAGE = 500;

const home = os.homedir();
const userName = (() => {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
})();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes personal details from text. */
export function clean(text) {
  let s = String(text ?? '');
  if (home) s = s.replace(new RegExp(escapeRe(home), 'gi'), '~').replace(new RegExp(escapeRe(home.replace(/\\/g, '/')), 'gi'), '~');
  if (userName && userName.length >= 3) s = s.replace(new RegExp(`\\b${escapeRe(userName)}\\b`, 'gi'), '<user>');
  return s
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '<token>')                 // JWTs (login / state tokens)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b[0-9a-f]{32}\b/gi, '<id>')                                  // account, save and unit IDs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/[A-Za-z0-9+/=_-]{60,}/g, '<data>')                              // base64 save values
    .slice(0, MAX_MESSAGE * 4);
}

/** Recent distinct errors, newest last; repeats increment a counter. */
export function createErrorLog() {
  const list = [];
  return {
    add(source, message) {
      const msg = clean(message).slice(0, MAX_MESSAGE).trim();
      if (!msg) return;
      const src = clean(source).slice(0, 40);
      const t = new Date().toISOString();
      const same = list.find((e) => e.source === src && e.message === msg);
      if (same) {
        same.count++;
        same.last = t;
        return;
      }
      list.push({ source: src, message: msg, first: t, last: t, count: 1 });
      if (list.length > MAX_ERRORS) list.shift();
    },
    list: () => list.map((e) => ({ ...e })),
    clear: () => { list.length = 0; },
  };
}

/** The report's diagnostics block (plain text, cleaned). */
export function diagnostics({ appVersion, gameBuild, data, accounts, errors, page }) {
  const lines = [
    `App version: ${appVersion || 'unknown'}`,
    `Game build (from the save): ${gameBuild || 'unknown'}`,
    `Game data: build ${data?.dataBuild || 'unknown'}, version ${data?.dataVersion || 'unknown'}${data?.pack
      ? ' (downloaded pack)' : ' (from gamedata/)'}${data?.stale ? ', older than the game' : ''}`,
    `Data pack check: ${data?.packResult || data?.packError || 'not configured'}`,
    `Accounts found: ${accounts ?? 'unknown'}`,
    `System: ${os.type()} ${os.release()} ${os.arch()}, Node ${process.versions.node}${host.attached ? ' (standalone exe)' : ''}`,
    ...(page ? [`Page: ${clean(page).slice(0, 200)}`] : []),
    '',
    errors.length ? `Recent errors (${errors.length}):` : 'Recent errors: none',
    ...errors.map((e) => `- [${e.source}] ${e.message}${e.count > 1 ? ` (x${e.count}, last ${e.last})` : ''} (${e.first})`),
  ];
  return lines.map(clean).join('\n');
}
