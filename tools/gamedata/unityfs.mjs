// Minimal read-only UnityFS bundle reader (LZ4/LZ4HC or uncompressed blocks), and how the save spells a game
// object's ID. What the table builders share for reading the game's data out of the bundles is in game_objects.mjs.
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
