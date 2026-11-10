import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assessScope, isPresentationChange } from './protected-mail-scope.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (root, path, content = 'fixture\n') => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
function init(root) {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'CI test');
  git(root, 'config', 'user.email', 'ci@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
}
function commit(root) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD'); }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pear-mail-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  init(root);
  put(root, 'web/src/components/DocPage.tsx');
  put(root, 'server/spacetimedb/src/lib.rs');
  const base = commit(root);
  return { root, pear: root, base, pin: () => commit(root),
    assess: head => assessScope({ root, base, head, fetchMissing: false }) };
}

test('only audited UI files and docs are exempt; unknown and shared code run', () => {
  const classify = path => isPresentationChange({ path, oldMode: '100644', newMode: '100644' });
  for (const path of ['web/src/components/DocPage.tsx', 'web/src/lib/pageScrollRestoration.ts', 'docs/PROTECTED_MAIL_READ_SURFACE.md', 'ROADMAP.md']) assert.equal(classify(path), true, path);
  for (const path of ['server/spacetimedb/src/lib.rs', 'worker/src/mail/read.ts', 'packages/sentinel/src/index.ts', 'packages/trellis-ui/src/index.ts', 'web/src/lib/mcp/tools.ts', 'web/src/lib/api-endpoint/dispatcher.ts', 'web/src/hooks/useAuth.ts', 'web/src/components/NewComponent.tsx', 'web/package.json', 'pnpm-lock.yaml', 'scripts/ci/test-protected-mail.sh', '.forgejo/workflows/pear-ci.yml', 'ci/runner/config.yml']) assert.equal(classify(path), false, path);
  assert.equal(isPresentationChange({ path: 'README.md', oldMode: '100644', newMode: '120000' }), false);
});
test('navigation-only PR skips the expensive suite', t => {
  const f = fixture(t);
  put(f.pear, 'web/src/components/DocPage.tsx', 'new UI\n');
  put(f.pear, 'web/src/hooks/useOpenWorkspaceRecord.ts');
  assert.equal(f.assess(f.pin()).run, false);
});
test('documentation-only PR skips, including the protected-mail design', t => {
  const f = fixture(t); put(f.pear, 'docs/PROTECTED_MAIL_READ_SURFACE.md');
  assert.equal(f.assess(f.pin()).run, false);
});
test('UI plus a server change runs the complete suite', t => {
  const f = fixture(t);
  put(f.pear, 'web/src/components/DocPage.tsx', 'new UI\n');
  put(f.pear, 'server/spacetimedb/src/lib.rs', 'new schema\n');
  assert.equal(f.assess(f.pin()).run, true);
});
test('an audited UI file that acquires protected-mail behavior runs', t => {
  const f = fixture(t);
  put(f.pear, 'web/src/components/DocPage.tsx', 'useProtectedMail();');
  assert.equal(f.assess(f.pin()).run, true);
});
test('renaming a sensitive file into docs cannot hide its removal', t => {
  const f = fixture(t); mkdirSync(join(f.pear, 'docs'));
  renameSync(join(f.pear, 'server/spacetimedb/src/lib.rs'), join(f.pear, 'docs/old.md'));
  assert.equal(f.assess(f.pin()).run, true);
});
test('workflow and harness changes run', t => {
  const f = fixture(t);
  put(f.root, '.forgejo/workflows/release-check.yml');
  assert.equal(f.assess(commit(f.root)).run, true);
});
test('root documentation alone skips', t => {
  const f = fixture(t); put(f.root, 'docs/guide.md');
  assert.equal(f.assess(commit(f.root)).run, false);
});
test('missing history, event revisions and unexpected checkout all run', t => {
  const f = fixture(t); put(f.pear, 'web/src/components/DocPage.tsx', 'new UI');
  const head = f.pin();
  assert.equal(assessScope({ root: f.root, base: 'f'.repeat(40), head, fetchMissing: false }).run, true);
  assert.equal(assessScope({ root: f.root }).run, true);
  assert.equal(f.assess(f.base).run, true);
  git(f.root, 'checkout', '--detach', 'HEAD^');
  assert.equal(f.assess(head).run, true);
});
