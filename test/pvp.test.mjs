import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePvp, inferMatches, vpValues, pvpReading, manualResult } from '../server/game/pvp.mjs';
import { int, embedded, fixed64 } from '../web/scripts/lib/protobuf.js';


const RULES = { base: 80, win: 2, loss: 1, streak: [{ upTo: 3, x: 1 }, { upTo: 5, x: 1.25 }] };
const at = (honor, vp, season = 's27') => ({ season, honor, vp });
const match = (from, to) => inferMatches(from, to, RULES);

test('reads season, honor and Victory Points', () => {
  const buf = Buffer.concat([embedded(2, fixed64(1, 0x33b4f294d8d12b57n), fixed64(2, 0xccdf8287c654e6c9n)),
    embedded(3, int(1, 9002), int(2, 9002)), embedded(4, int(1, 160))]);
  assert.deepEqual(parsePvp(buf), { season: '33b4f294d8d12b57ccdf8287c654e6c9', honor: 9002, honor2: 9002, vp: 160 });
  assert.equal(parsePvp(Buffer.alloc(0)), null);
});

test('Victory Points per match from the rules', () => {
  assert.deepEqual(vpValues(RULES), { loss: 80, wins: [160, 200] });
});

test('one match between scans', () => {
  assert.deepEqual(match(at(5000, 0), at(5090, 160)), { wins: 1, losses: 0, estimated: false, honorOnly: false });
  assert.deepEqual(match(at(5000, 0), at(4940, 80)), { wins: 0, losses: 1, estimated: false, honorOnly: false });
  assert.deepEqual(match(at(5000, 0), at(5100, 200)), { wins: 1, losses: 0, estimated: false, honorOnly: false }); // streak win
});

test('a loss at a rank floor (no honor change) is still a loss', () => {
  assert.deepEqual(match(at(9000, 0), at(9000, 80)), { wins: 0, losses: 1, estimated: false, honorOnly: false });
});

test('honor tells one win from two losses', () => {
  assert.equal(match(at(5000, 0), at(5080, 160)).wins, 1);
  assert.deepEqual(match(at(5000, 0), at(4880, 160)), { wins: 0, losses: 2, estimated: false, honorOnly: false });
  assert.equal(match(at(5000, 0), at(5000, 160)).estimated, true);
});

test('several matches between scans', () => {
  assert.deepEqual(match(at(5000, 0), at(5020, 240)), { wins: 1, losses: 1, estimated: false, honorOnly: false });
});

test('with Victory Points unchanged, honor alone tells one match', () => {
  assert.deepEqual(match(at(5000, 6000), at(5090, 6000)), { wins: 1, losses: 0, estimated: true, honorOnly: true });
  assert.deepEqual(match(at(5000, 6000), at(4930, 6000)), { wins: 0, losses: 1, estimated: true, honorOnly: true });
  assert.equal(match(at(5000, 6000), at(5000, 6000)), null);
});

test('no matches across seasons, or for impossible changes', () => {
  assert.equal(match(at(9500, 3000, 's26'), at(9000, 0, 's27')), null);
  assert.equal(match(at(5000, 500), at(5000, 400)), null);
  assert.equal(match(at(5000, 0), at(5000, 120)), null);
});

test('readings log a season start, matches and changes no combination explains', () => {
  const t = '2026-11-19T10:00:00.000Z';
  assert.equal(pvpReading(at(100, 0), at(100, 0), t, RULES), null);
  assert.deepEqual(pvpReading(null, at(100, 0), t, RULES), { t, season: 's27', honor: 100, vp: 0, start: true });
  assert.equal(pvpReading(at(100, 0, 's26'), at(100, 0), t, RULES).start, true);
  const win = pvpReading(at(100, 0), at(130, 160), t, RULES);
  assert.equal(win.wins, 1);
  assert.equal(win.unexplained, undefined);
  // 50 VP fits no match; VP going down neither
  assert.equal(pvpReading(at(100, 160), at(120, 210), t, RULES).unexplained, true);
  assert.equal(pvpReading(at(100, 160), at(100, 80), t, RULES).unexplained, true);
  // Only the second honor value moved, which is logged but isn't a match.
  const other = pvpReading({ ...at(100, 0), honor2: 1 }, { ...at(100, 0), honor2: 2 }, t, RULES);
  assert.equal(other.unexplained, undefined);
  assert.equal(other.wins, undefined);
});

test('manual results only for unexplained changes, and can be undone', () => {
  const e = { t: 'x', unexplained: true, dh: 20, dv: 50 };
  assert.equal(manualResult(e, 'win'), true);
  assert.deepEqual([e.manual, e.wins, e.losses], ['win', 1, 0]);
  assert.equal(manualResult(e, 'loss'), true);
  assert.deepEqual([e.manual, e.wins, e.losses], ['loss', 0, 1]);
  assert.equal(manualResult(e, null), true);
  assert.deepEqual([e.manual, e.wins, e.losses], [undefined, undefined, undefined]);
  assert.equal(manualResult(e, 'draw'), false);
  assert.equal(manualResult({ t: 'y', wins: 1, losses: 0 }, 'loss'), false);
  assert.equal(manualResult(undefined, 'win'), false);
});
