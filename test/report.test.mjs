import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, createErrorLog } from '../server/report.mjs';

test('reports leave out personal details', () => {
  const s = clean('mail me at someone@example.com, save 0123456789abcdef0123456789abcdef, token eyJhbGciOiJI.eyJzdWIiOiIx.sig');
  assert.ok(!s.includes('someone@example.com'));
  assert.ok(!s.includes('0123456789abcdef0123456789abcdef'));
  assert.ok(!s.includes('eyJhbGciOiJI'));
  assert.match(s, /<email>.*<id>.*<token>/);
});

test('the error log counts repeats and cleans messages', () => {
  const log = createErrorLog();
  log.add('scan', 'failed for a@b.co');
  log.add('scan', 'failed for a@b.co');
  const [e] = log.list();
  assert.equal(e.count, 2);
  assert.equal(e.message, 'failed for <email>');
  log.clear();
  assert.equal(log.list().length, 0);
});
