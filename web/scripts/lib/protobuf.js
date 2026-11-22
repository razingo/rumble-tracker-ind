// A small schema-less protobuf reader and writer on Uint8Array, so the page (army codes), the server (the save) and the
// tests share one implementation.

export function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    if (pos >= buf.length) throw new Error('A number runs past the end of the data.');
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return [result, pos];
}

const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

/** Parses one message level into a flat list of fields. */
export function parseMessage(buf, start = 0, end = buf.length) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const fn = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (fn === 0) throw new Error(`The data has an invalid field number at byte ${pos}.`);
    if (wt === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      fields.push({ fn, wt, value });
    } else if (wt === 1) {
      if (pos + 8 > end) throw new Error('A message runs past its own length.');
      fields.push({ fn, wt, u64: view(buf).getBigUint64(pos, true), f64: view(buf).getFloat64(pos, true) });
      pos += 8;
    } else if (wt === 5) {
      if (pos + 4 > end) throw new Error('A message runs past its own length.');
      fields.push({ fn, wt, u32: view(buf).getUint32(pos, true) });
      pos += 4;
    } else if (wt === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      const n = Number(length);
      fields.push({ fn, wt, start: pos, end: pos + n });
      pos += n;
    } else {
      throw new Error(`The data has an unsupported wire type ${wt} at byte ${pos}.`);
    }
  }
  if (pos !== end) throw new Error('A message runs past its own length.');
  return fields;
}

export const fieldsOf = (buf, field) => parseMessage(buf, field.start, field.end);
export const findField = (fields, fn) => fields.find((f) => f.fn === fn);
export const numberOf = (field) => (field && field.value !== undefined ? Number(field.value) : 0);
/** A length-delimited field read as UTF-8 text. */
export const textOf = (buf, field) => new TextDecoder().decode(buf.subarray(field.start, field.end));

/** IDs are a message of two fixed64s, sometimes wrapped in another message. */
export function readId(buf, field) {
  let cur = field;
  for (let depth = 0; cur && cur.wt === 2 && depth < 4; depth++) {
    const fields = fieldsOf(buf, cur);
    const a = fields.find((f) => f.fn === 1 && f.wt === 1);
    const b = fields.find((f) => f.fn === 2 && f.wt === 1);
    if (a && b) return a.u64.toString(16).padStart(16, '0') + b.u64.toString(16).padStart(16, '0');
    cur = fields.find((f) => f.wt === 2);
  }
  return '';
}

// Writing

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function varint(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Uint8Array.from(out);
}

const tag = (fn, wt) => varint((fn << 3) | wt);
/** A varint field. */
export const int = (fn, n) => concat(tag(fn, 0), varint(n));
/** An embedded message field holding `parts`. */
export const embedded = (fn, ...parts) => {
  const body = concat(...parts);
  return concat(tag(fn, 2), varint(body.length), body);
};
export const fixed64 = (fn, n) => {
  const b = new Uint8Array(8);
  view(b).setBigUint64(0, BigInt(n), true);
  return concat(tag(fn, 1), b);
};
export const double = (fn, n) => {
  const b = new Uint8Array(8);
  view(b).setFloat64(0, n, true);
  return concat(tag(fn, 1), b);
};
export const string = (fn, s) => embedded(fn, new TextEncoder().encode(s));
