// Minimal read-only UnityFS bundle reader (LZ4/LZ4HC or uncompressed blocks), and what the table builders share for
// reading the game's data out of the bundles.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function lz4(src, outSize) {
  const dst = Buffer.alloc(outSize);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(dst, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let ml = token & 15;
    if (ml === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let i = 0; i < ml; i++, d++) dst[d] = dst[d - off];
  }
  return dst;
}

function decompress(buf, type, outSize) {
  if (type === 0) return buf;
  if (type === 2 || type === 3) return lz4(buf, outSize);
  throw new Error(`unsupported compression ${type}`);
}

/** Returns { files: [{ path, data: Buffer }] } */
export function readBundle(file) {
  const b = readFileSync(file);
  let p = 0;
  const cstr = () => { const e = b.indexOf(0, p); const s = b.toString('latin1', p, e); p = e + 1; return s; };
  if (cstr() !== 'UnityFS') throw new Error('not UnityFS');
  const version = b.readUInt32BE(p); p += 4;
  cstr(); cstr();
  p += 8; // total size
  const cInfo = b.readUInt32BE(p); p += 4;
  const uInfo = b.readUInt32BE(p); p += 4;
  const flags = b.readUInt32BE(p); p += 4;
  if (version >= 7) p = (p + 15) & ~15;
  let infoStart = p;
  if (flags & 0x80) infoStart = b.length - cInfo;
  const info = decompress(b.subarray(infoStart, infoStart + cInfo), flags & 0x3f, uInfo);
  if (!(flags & 0x80)) p += cInfo;
  if (flags & 0x200) p = (p + 15) & ~15;
  let q = 16;
  const blockCount = info.readInt32BE(q); q += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) { blocks.push({ u: info.readUInt32BE(q), c: info.readUInt32BE(q + 4),
    f: info.readUInt16BE(q + 8) }); q += 10; }
  const nodeCount = info.readInt32BE(q); q += 4;
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const off = Number(info.readBigInt64BE(q)); const size = Number(info.readBigInt64BE(q + 8)); q += 20;
    const e = info.indexOf(0, q); const path = info.toString('latin1', q, e); q = e + 1;
    nodes.push({ off, size, path });
  }
  const parts = [];
  for (const bl of blocks) { parts.push(decompress(b.subarray(p, p + bl.c), bl.f & 0x3f, bl.u)); p += bl.c; }
  const stream = Buffer.concat(parts);
  return { files: nodes.map((n) => ({ path: n.path, data: stream.subarray(n.off, n.off + n.size) })) };
}

/** Every .bundle file under `dir` whose name passes `wanted` (all of them without one), folder by folder. */
export function bundleFiles(dir, wanted = () => true) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.bundle') && wanted(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

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

// The save stores an ID as the GUID's 32 hex digits in another order: guid[i] = saveId[PERM[i]].
const PERM = [8, 9, 10, 11, 12, 13, 14, 15, 4, 5, 6, 7, 0, 1, 2, 3, 30, 31, 28, 29, 26, 27, 24, 25, 22, 23, 20, 21, 18, 19, 16, 17];
/** The ID the save uses for a game object's GUID. */
export const saveIdOf = (guid) => {
  const id = [];
  PERM.forEach((p, i) => { id[p] = guid[i]; });
  return id.join('');
};
/** The GUID of the game object the save calls `id`. */
export const guidOfSaveId = (id) => PERM.map((p) => id[p]).join('');

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
