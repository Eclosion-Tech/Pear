import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertStableViewDispatch } from './check-view-dispatch.mjs';

const baseline = JSON.parse(await readFile(new URL('./view-dispatch-baseline.json', import.meta.url), 'utf8'));
const fixtures = JSON.parse(await readFile(new URL('./view-dispatch-fixtures.json', import.meta.url), 'utf8'));
const schema = views => ({ misc_exports: views.map(View => ({ View })) });

test('the actual failing workspace-library WASM dispatch map is rejected', () => {
  assert.throws(() => assertStableViewDispatch(schema(fixtures.beforeFix), baseline), /View dispatch changed for my_extension_permissions/);
});

test('the rebuilt WASM retains all existing slots while appending repository views', () => {
  assert.equal(assertStableViewDispatch(schema(fixtures.afterFix), baseline), 14);
  assert.ok(fixtures.afterFix.some(view => view.name === 'my_component_repository_receipt'));
});

test('view removal and caller-context changes fail the compatibility guard', () => {
  const removed = fixtures.afterFix.filter(view => view.name !== 'my_protected_mail');
  assert.throws(() => assertStableViewDispatch(schema(removed), baseline), /Missing existing view my_protected_mail/);
  const changedContext = fixtures.afterFix.map(view => view.name === 'my_protected_mail' ? { ...view, is_anonymous: true } : view);
  assert.throws(() => assertStableViewDispatch(schema(changedContext), baseline), /View context changed for my_protected_mail/);
});
