import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertMatchingBindings } from './check-bindings.mjs';

test('binding checks reject missing, stale and empty generated bindings', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pear-bindings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const left = join(root, 'web'), right = join(root, 'worker');
  mkdirSync(left); mkdirSync(right);
  await assert.rejects(assertMatchingBindings(left, right), /No generated/);
  writeFileSync(join(left, 'table.ts'), 'current');
  await assert.rejects(assertMatchingBindings(left, right), /file sets/);
  writeFileSync(join(right, 'table.ts'), 'stale');
  await assert.rejects(assertMatchingBindings(left, right), /Binding differs/);
  writeFileSync(join(right, 'table.ts'), 'current');
  assert.equal(await assertMatchingBindings(left, right), 1);
});
