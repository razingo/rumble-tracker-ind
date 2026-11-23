import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, createErrorLog, briefError } from '../server/report.mjs';

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

test('a failed program\'s error is told with its reason, in one line', () => {
  const failed = new Error('extract_reward_icons.py failed:\nTraceback (most recent call last):\n  File "x.py", line 3\n'
    + 'ValueError: no such bundle\n');
  assert.equal(briefError(failed), 'extract_reward_icons.py failed: ValueError: no such bundle');
  assert.equal(briefError(new Error('The game is being updated.')), 'The game is being updated.');
  assert.equal(briefError(new Error('')), 'unknown error');
});
