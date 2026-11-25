// What the table builders share for reading the game's data out of the bundles (unityfs.mjs): the data objects, the
// English strings, the currencies' names and the key a new mini gets.
import { readBundle } from './unityfs.mjs';

/**
 * The JSON object that starts at text[i], as text, or null when it does not close within `limit` characters: the
 * game's data objects sit as JSON inside its files, one after another.
 */
export function jsonObjectAt(text, i, limit) {
  let depth = 0, inString = false;
  for (let j = i; j < text.length && j < i + limit; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return null;
}

/**
 * The game's data objects in the bundle files given, as { guid: { type, ...the object } } (type: its name without
 * "Gryphon.Data."). A bundle or an object that can't be read is passed over. `wanted(type)` picks the types,
 * `limit` is the longest an object's text may be and `maxFile` the largest file looked into; `into` adds to objects
 * read earlier, and `bundle` puts the name of the bundle each came from on it.
 */
export function dataObjects(files, { wanted = () => true, limit = 3e6, maxFile = 3e8, into = {}, bundle = false } = {}) {
  for (const p of files) {
    let b;
    try {
      b = readBundle(p);
    } catch {
      continue;
    }
    const from = bundle ? { bundle: p.split(/[\\/]/).pop() } : null;
    for (const f of b.files) {
      if (f.data.length > maxFile) continue;
      const t = f.data.toString('utf8');
      for (const m of t.matchAll(/\{\s*"\$type": "Gryphon\.Data\.([\w.]+)/g)) {
        if (!wanted(m[1])) continue;
        const json = jsonObjectAt(t, m.index, limit);
        if (!json) continue;
        try {
          const o = JSON.parse(json);
          if (o.guid) into[o.guid] = { type: m[1], ...from, ...o };
        } catch {
          // not plain JSON
        }
      }
    }
  }
  return into;
}

/**
 * The English strings among the data objects `objs` ({ guid: object }), as { string ID: text }. The string tables
 * say which container holds each language.
 */
export function englishStrings(objs) {
  const english = new Set();
  for (const o of Object.values(objs)) {
    if (o.type === 'L10N.UserFacingStringTable') for (const l of o.Locales || []) if (l.LocaleId === 'enUS') english.add(l.LocalizedTable);
  }
  const strings = {};
  for (const o of Object.values(objs)) {
    if (o.type === 'L10N.UserFacingStringContainer' && (english.has(o.guid) || /enUS$/.test(o.name))) {
      for (const d of o.Data || []) strings[d.Id] ??= d.Value;
    }
  }
  return strings;
}

// The currencies' names by their GUID (data_currencytype.bundle), as the game shows them.
export const COINS = 'e9c433015c337934c9890eb4e13ff3d3';
export const CURRENCY_NAMES = {
  [COINS]: 'Coins', '85f8dc579c792453abcc2f9c900eb9d5': 'Arc Energy',
  '9b00c3378c339bc47bd442ddfd0d1a56': 'Valor', '3949594ec662246408f94474a345a7ab': 'Rare Upgrade Core',
  a93da5dcbe6bd4c2aa18ca4a485c182f: 'Epic Upgrade Core', deb04929d9e074a7a91475b8b6202e7b: 'Legendary Upgrade Core',
  dfaa4aaedad744b7b86869bf8d9bb68e: 'Big Red Button', cf836abedd57e1f4e887bb330b5b87d7: 'Rare-O-Matic',
  a0830bd678683854a8830944c4ff60fa: "Modest Tinker's Gem", '80588d65595e74c4c9791b6938bcb52a': "Major Tinker's Gem",
  '5c0740da103c97b42b0cc30178d68884': "Mega Tinker's Gem",
};

/** The tracker's key for a mini the game names: "Old Murk-Eye" gives "old-murk-eye". */
export const slugOf = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
