import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only audited presentation files are exempt. In particular, web/lib, shared
// packages, auth, dependencies, fixtures and newly introduced files run the gate.
// Additions to this list require checking the protected-mail fixture imports.
const presentation = new Set([
  'web/src/components/DocPage.tsx',
  'web/src/components/component-renderers/AuthoredPageComponent.tsx',
  'web/src/hooks/useOpenWorkspaceRecord.ts',
  'web/src/lib/pageScrollRestoration.ts',
  'web/src/lib/pageScrollRestoration.test.ts',
  'web/src/lib/workspace-record-navigation.test.ts',
  'web/src/lib/authored-page-records.test.ts',
]);
const sha = /^[0-9a-f]{40}$/;
const documentation = path => /^(?:docs\/.*|[^/]+)\.md$/.test(path);
const ordinaryFile = change => [change.oldMode, change.newMode].every(mode => ['000000', '100644', '100755'].includes(mode));
export const isPresentationChange = change => ordinaryFile(change) && (documentation(change.path) || presentation.has(change.path));

function isUnrelatedPearChange(root, change) {
  if (!isPresentationChange(change)) return false;
  if (documentation(change.path)) return true;
  // An audited UI file can later acquire mail functionality. Its previous and
  // new contents must both remain unrelated to the protected-mail surface.
  for (const [mode, revision] of [[change.oldMode, change.oldSha], [change.newMode, change.newSha]]) {
    if (mode !== '000000' && /protected.?mail|sentinel/i.test(git(root, ['cat-file', 'blob', revision]))) return false;
  }
  return true;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
}
function ensureCommit(root, revision, fetchMissing) {
  if (!sha.test(revision)) throw Error('Invalid revision');
  try { git(root, ['cat-file', '-e', `${revision}^{commit}`]); }
  catch {
    if (!fetchMissing) throw Error('Missing revision');
    git(root, ['fetch', '--no-tags', '--depth=1', 'origin', revision]);
    git(root, ['cat-file', '-e', `${revision}^{commit}`]);
  }
}
export function changes(root, base, head) {
  const fields = git(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head, '--']).split('\0');
  fields.pop();
  if (fields.length % 2) throw Error('Invalid diff');
  const result = [];
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDT])$/.exec(fields[i]);
    if (!match) throw Error('Unrecognized change');
    result.push({ oldMode: match[1], newMode: match[2], oldSha: match[3], newSha: match[4], path: fields[i + 1] });
  }
  return result;
}

export function assessScope({ root = process.cwd(), base, head, fetchMissing = true } = {}) {
  try {
    if (!sha.test(base ?? '') || !sha.test(head ?? '')) throw Error('Missing PR revisions');
    // A synthetic merge or an unexpected checkout is not a proven UI-only diff.
    if (git(root, ['rev-parse', 'HEAD']).trim() !== head) throw Error('Checkout differs from PR head');
    ensureCommit(root, base, fetchMissing);
    ensureCommit(root, head, fetchMissing);
    if (!changes(root, base, head).every(change => isUnrelatedPearChange(root, change))) {
      return { run: true, reason: 'Changes outside the audited presentation/documentation allowlist' };
    }
    return { run: false, reason: 'Only audited presentation files or documentation changed' };
  } catch {
    // Missing history, failed fetches, unusual modes and unknown event shapes
    // must never silently remove compatibility coverage.
    return { run: true, reason: 'Could not prove the change is presentation/documentation only' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = assessScope({ base: process.env.PR_BASE_SHA, head: process.env.PR_HEAD_SHA });
  console.log(`protected-mail: ${result.run ? 'RUN' : 'SKIP'} — ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\n`);
}
