import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVarint, parseMessage } from '../web/scripts/lib/protobuf.js';
import { parseUnits, parseCurrencies, parseGameBuild, parseOwnedAvatars, compareVersions, diffSnapshots } from '../server/game/model.mjs';
import { varint, int, embedded, string, fixed64, double } from '../web/scripts/lib/protobuf.js';
import { id, hexId } from './helpers.mjs';

test('varints', () => {
  assert.deepEqual(readVarint(Buffer.from([0x96, 0x01]), 0), [150n, 2]);
  assert.deepEqual(readVarint(varint(2n ** 40n), 0), [2n ** 40n, 6]);
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), /runs past the end/);
});

test('reads every wire type and rejects malformed input', () => {
  const buf = Buffer.concat([int(1, 7), string(2, 'hi'), fixed64(3, 9)]);
  const f = parseMessage(buf);
  assert.deepEqual(f.map((x) => [x.fn, x.wt]), [[1, 0], [2, 2], [3, 1]]);
  assert.equal(f[0].value, 7n);
  assert.equal(buf.subarray(f[1].start, f[1].end).toString(), 'hi');
  assert.equal(f[2].u64, 9n);
  assert.throws(() => parseMessage(Buffer.from([0x00])), /invalid field number/);
  assert.throws(() => parseMessage(Buffer.from([0x0b])), /unsupported wire type/);
  assert.throws(() => parseMessage(Buffer.from([0x12, 0x05, 0x00])), /runs past its own length/);
});

test('units', () => {
  const buf = Buffer.concat([
    embedded(1, id(1, 0xabc, 0xdef), int(2, 12), int(3, 450), double(5, 0.12345), int(6, 900), int(7, 3), int(8, 5),
      embedded(9, int(1, 2), int(2, 3)), int(10, 40)),
    embedded(1, int(2, 1)), // no id: dropped
  ]);
  assert.deepEqual(parseUnits(buf), [{
    id: hexId(0xabc, 0xdef), level: 12, xp: 450, xpNeeded: 900, xpLevel: 3, bonus: 5, talents: 2, rarity: 3, stars: 40, xpWeight: 0.123,
  }]);
  assert.deepEqual(parseUnits(Buffer.alloc(0)), []);
});

test('merges currency balances and lifetime totals by ID', () => {
  const buf = Buffer.concat([
    embedded(1, id(1, 1, 2), int(2, 250)),
    embedded(4, id(1, 1, 2), int(2, 9000)),
    embedded(1, id(1, 3, 4), int(2, 5)),
  ]);
  assert.deepEqual(parseCurrencies(buf), [
    { id: hexId(1, 2), balance: 250, lifetime: 9000 },
    { id: hexId(3, 4), balance: 5, lifetime: 0 },
  ]);
});

test('owned avatars are unique', () => {
  const buf = Buffer.concat([embedded(1, id(1, 5, 6), int(2, 2)), embedded(1, id(1, 5, 6), int(2, 3)),
    embedded(1, id(1, 7, 8), int(2, 2))]);
  assert.deepEqual(parseOwnedAvatars(buf), [hexId(5, 6), hexId(7, 8)]);
});

test('game build, and comparing builds and versions', () => {
  assert.equal(parseGameBuild(embedded(1, string(3, '16.1.2.119766.dp-live'))), '16.1.2.119766');
  assert.equal(parseGameBuild(embedded(1, string(3, 'unknown'))), null);
  assert.equal(parseGameBuild(null), null);
  assert.ok(compareVersions('16.1.2.119766', '16.1.10.1') < 0);
  assert.ok(compareVersions('16.2.0.1', '16.1.9.9') > 0);
  assert.equal(compareVersions('16.1.2', '16.1.2.0'), 0);
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.3.6', '0.3.6'), 0);
});

test('changes between two scans', () => {
  const rules = { xpToNext: { 1: 10, 2: 20 } };
  const u = (id, o = {}) => ({ id, xpLevel: 1, xp: 0, xpNeeded: 10, rarity: 0, talents: 0, stars: 0, ...o });
  const prev = { units: [u('a'), u('b')], currencies: [{ id: 'gold', balance: 100 }] };
  const cur = {
    units: [u('a', { xpLevel: 2, xp: 5, xpNeeded: 20 }), u('b', { rarity: 1, talents: 1, stars: 2 }), u('c')],
    currencies: [{ id: 'gold', balance: 40 }, { id: 'gems', balance: 5 }],
  };
  const ev = diffSnapshots(prev, cur, rules, 't');
  const of = (type, id) => ev.find((e) => e.type === type && e.id === id);
  assert.equal(of('unit_xp', 'a').gained, 15);
  assert.deepEqual([of('unit_rarity', 'b').to, of('unit_talent', 'b').to, of('unit_stars', 'b').to], [1, 1, 2]);
  assert.ok(of('unit_new', 'c'));
  assert.equal(of('currency', 'gold').delta, -60);
  assert.deepEqual([of('currency', 'gems').from, of('currency', 'gems').to], [0, 5]);
  assert.equal(diffSnapshots(prev, prev, rules, 't').length, 0);
});
