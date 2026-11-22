import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { readJson, writeJson, flushWrites } from '../server/store.mjs';

test('overlapping writes to one file all succeed, in order, without temp files left', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-store-'));
  const p = path.join(dir, 'army.json');
  await Promise.all(Array.from({ length: 25 }, (_, i) => writeJson(p, { n: i })));
  assert.deepEqual(JSON.parse(await readFile(p, 'utf8')), { n: 24 });
  assert.deepEqual(await readdir(dir), ['army.json']);
  // The value is taken when writeJson is called, not when the queued write runs.
  const v = { n: 1 };
  const w = writeJson(p, v);
  v.n = 2;
  await w;
  assert.deepEqual(await readJson(p), { n: 1 });
  writeJson(p, { n: 3 });
  await flushWrites();
  assert.deepEqual(await readJson(p), { n: 3 });
  await rm(dir, { recursive: true });
});

test('missing files give the fallback; damaged files are moved aside when allowed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rumble-store-'));
  const p = path.join(dir, 'names.json');
  assert.deepEqual(await readJson(p, { a: 1 }), { a: 1 });
  await assert.rejects(readJson(p), { code: 'ENOENT' });
  await writeFile(p, '\uFEFF{"ok":true}');
  assert.deepEqual(await readJson(p, {}), { ok: true }); // byte-order mark
  await writeFile(p, '{"broken":');
  await assert.rejects(readJson(p, {}), { code: 'BAD_JSON' });
  const seen = [];
  assert.deepEqual(await readJson(p, { fresh: true }, { onCorrupt: (f, moved) => seen.push(path.basename(moved)) }), { fresh: true });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^names\.json\.corrupt-/);
  assert.deepEqual(await readdir(dir), seen);
  await rm(dir, { recursive: true });
});
