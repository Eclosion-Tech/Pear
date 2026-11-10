import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJson, safeUrl } from './fixture-http.mjs';

// SpacetimeDB 2.0.3 retains numeric view pointers in cached dependency sets
// across module updates. Inserting a view before an existing registration can
// refresh that old backing table with a different view's result. Keep existing
// dispatch slots stable; use a late internal accessor plus an explicit public
// name when introducing a new caller-scoped view.
export function assertStableViewDispatch(schema, baseline) {
  const views = new Map((schema.misc_exports ?? []).flatMap(entry => entry.View ? [[entry.View.name, entry.View]] : []));
  for (const expected of baseline.views) {
    const actual = views.get(expected.name);
    assert.ok(actual, `Missing existing view ${expected.name}`);
    assert.equal(actual.is_anonymous, expected.is_anonymous, `View context changed for ${expected.name}`);
    assert.equal(actual.index, expected.index, `View dispatch changed for ${expected.name}`);
  }
  return baseline.views.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, wasm] = process.argv.slice(2);
  assert.ok(base && wasm && process.argv.length === 4, 'Expected a disposable loopback host and module artifact.');
  const origin = safeUrl(base, 'view-dispatch test host');
  assert.equal(origin.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
  assert.ok(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash);
  const { token } = await requestJson(new URL('/v1/identity', origin), { method: 'POST' });
  const database = new URL(`/v1/database/view-dispatch-${randomUUID()}`, origin);
  const headers = { Authorization: `Bearer ${token}` };
  await requestJson(database, { method: 'PUT', headers, body: await readFile(wasm) });
  const schema = await requestJson(`${database}/schema?version=9`, { headers });
  const baseline = JSON.parse(await readFile(new URL('./view-dispatch-baseline.json', import.meta.url), 'utf8'));
  const checked = assertStableViewDispatch(schema, baseline);
  // The wrapper owns and destroys this whole server. Retain this empty fixture
  // database until then to avoid 2.0.3's DELETE/disconnect durability race.
  console.log(`PASS stable_view_dispatch existing_views=${checked}`);
}
