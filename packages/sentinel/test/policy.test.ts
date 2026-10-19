import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POLICY_VERSION, canonicalOperation, evaluateEligibility, fingerprintOperation, isOperation, isSnapshot } from '../src/index.js';
import type { MailAppend, MailRead, ModelInfer, Operation, PolicySnapshot, Processor, SourceRevision } from '../src/index.js';

const scope = { workspaceId: 'workspace-a', principalId: 'owner-a', runtimeId: 'mail-service', runId: 'run-a' };
const processor: Processor = { profileId: 'model-a', revision: 'config-3', endpoint: 'https://model.example.test/v1/summary', model: 'configured-model' };
const screener: Processor = { profileId: 'screen-a', revision: 'config-1', endpoint: 'https://screen.example.test/v1/decide', model: 'pinned-screen-model' };
const destination = { workspaceId: scope.workspaceId, rootId: 'mail-root', ownerId: scope.principalId };
const source: SourceRevision = {
  ref: { id: 'message-a', revision: 'sanitized-1', digest: 'a'.repeat(64) }, workspaceId: scope.workspaceId,
  origin: 'external_mail', sanitizationVersion: 'mail-redaction-v1', parents: [], processors: [processor, screener], storage: [destination],
};
function snapshot(): PolicySnapshot {
  return structuredClone({
    policyVersion: POLICY_VERSION, scope, epoch: 2, nowMs: 1000,
    grant: { id: 'grant-a', policyVersion: POLICY_VERSION, scope, epoch: 2, notBeforeMs: 500, expiresAtMs: 2000,
      connectionId: 'connection-a', mailbox: { host: 'mail.example.test', port: 993, folders: ['INBOX', 'Sent'] },
      destination, summaryProcessor: processor, screeningProcessor: screener,
      limits: { messages: 10, readBytes: 100000, inputBytes: 40000, outputTokens: 1500, appendBytes: 100000 } },
    exposures: [source.ref], sources: [source],
    remaining: { operations: 10, messages: 10, readBytes: 100000, inputBytes: 40000, outputTokens: 1500, appendBytes: 100000 },
    screening: 'not_required',
  });
}
const base = { scope, connectionId: 'connection-a', epoch: 2, contractVersion: 1 as const };
const read: MailRead = { ...base, kind: 'mail.read', mailbox: { host: 'mail.example.test', port: 993, folders: ['INBOX'] }, messages: 10, bytes: 100000 };
const infer: ModelInfer = { ...base, kind: 'model.infer', purpose: 'mail.summary', processor, inputBytes: 40000, outputTokens: 1500, payloadDigest: 'b'.repeat(64) };
const append: MailAppend = { ...base, kind: 'mail.append', destination, bytes: 100000, payloadDigest: 'c'.repeat(64) };
const eligible = { status: 'eligible', requiresAdmission: true };

test('fixed mail operations fit the recipe at exact resource limits', () => {
  const s = snapshot();
  const operations: Operation[] = [read, infer, append, { ...base, kind: 'content.screen', processor: screener, inputBytes: 40000, payloadDigest: 'd'.repeat(64) }];
  for (const operation of operations) {
    assert.equal(isOperation(operation), true);
    assert.deepEqual(evaluateEligibility(s, operation), eligible);
  }
});

test('eligibility neither mutates nor consumes a budget or authorizes dispatch', () => {
  const s = snapshot();
  const before = structuredClone(s);
  for (let i = 0; i < 20; i++) assert.deepEqual(evaluateEligibility(s, infer), eligible);
  assert.deepEqual(s, before);
  assert.equal('permit' in evaluateEligibility(s, infer), false);
});

test('each resource budget is checked against both recipe and observed remaining budget', () => {
  const cases: Array<[Operation, string, string]> = [
    [{ ...read, messages: 11 }, 'messages', 'messages'], [{ ...read, bytes: 100001 }, 'readBytes', 'bytes'],
    [{ ...infer, inputBytes: 40001 }, 'inputBytes', 'inputBytes'], [{ ...infer, outputTokens: 1501 }, 'outputTokens', 'outputTokens'],
    [{ ...append, bytes: 100001 }, 'appendBytes', 'bytes'],
  ];
  for (const [overLimit, budget, amount] of cases) {
    assert.deepEqual(evaluateEligibility(snapshot(), overLimit), { status: 'denied', reason: 'budget_exceeded' });
    const s = snapshot();
    const legal = overLimit.kind === 'mail.read' ? read : overLimit.kind === 'mail.append' ? append : infer;
    const requested = (legal as unknown as Record<string, number>)[amount];
    const limited = { ...s, remaining: { ...s.remaining, [budget]: requested - 1 } };
    assert.deepEqual(evaluateEligibility(limited, legal), { status: 'denied', reason: 'budget_exceeded' });
  }
});

test('all malformed numeric bounds fail closed, without side effects or diagnostics', () => {
  for (const invalid of [-1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5, '1', null]) {
    assert.deepEqual(evaluateEligibility(snapshot(), { ...infer, inputBytes: invalid }), { status: 'denied', reason: 'invalid_operation' });
  }
  assert.equal(isSnapshot({ ...snapshot(), nowMs: NaN }), false);
  assert.equal(isSnapshot({ ...snapshot(), grant: { ...snapshot().grant, expiresAtMs: 500 } }), false);
});

test('required screening holds inference and append but can still run its approved screening operation', () => {
  for (const screening of ['hold', 'unavailable'] as const) {
    const s = { ...snapshot(), screening };
    for (const op of [infer, append]) {
      assert.deepEqual(evaluateEligibility(s, op), { status: 'denied', reason: `screening_${screening}` });
    }
    assert.deepEqual(evaluateEligibility(s, { ...base, kind: 'content.screen', processor: screener, inputBytes: 100, payloadDigest: 'd'.repeat(64) }), eligible);
  }
});

test('canonical operation fingerprints bind actual action fields and do not depend on object key order', async () => {
  const reverse = Object.fromEntries(Object.entries(infer).reverse()) as unknown as ModelInfer;
  assert.equal(canonicalOperation(infer), canonicalOperation(reverse));
  const digest = await fingerprintOperation(infer);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(await fingerprintOperation(reverse), digest);
  const mutations: ModelInfer[] = [
    { ...infer, payloadDigest: 'e'.repeat(64) }, { ...infer, epoch: 3 },
    { ...infer, scope: { ...scope, runId: 'run-b' } }, { ...infer, processor: { ...processor, revision: 'config-4' } },
  ];
  for (const changed of mutations) assert.notEqual(await fingerprintOperation(changed), digest);
});

test('unsupported contract versions or approval fields cannot become fingerprinted operations', async () => {
  for (const bad of [{ ...infer, contractVersion: 2 }, { ...infer, approved: true }, { ...infer, sources: [] }]) {
    assert.equal(canonicalOperation(bad), undefined);
    await assert.rejects(fingerprintOperation(bad), { message: 'invalid_operation' });
  }
});

test('plain JSON-like inputs validate while unknown authority-like fields are rejected', () => {
  const s = JSON.parse(JSON.stringify(snapshot()));
  assert.equal(isSnapshot(s), true);
  assert.deepEqual(evaluateEligibility(s, JSON.parse(JSON.stringify(infer))), eligible);
  assert.equal(isSnapshot({ ...s, approved: true }), false);
  assert.equal(isOperation({ ...infer, constructor: 'trusted' }), false);
});

test('non-enumerable fields cannot escape canonical operation fingerprints', async () => {
  const hidden = structuredClone(infer);
  Object.defineProperty(hidden, 'payloadDigest', { value: 'e'.repeat(64), enumerable: false });
  assert.equal(isOperation(hidden), false);
  assert.equal(canonicalOperation(hidden), undefined);
  await assert.rejects(fingerprintOperation(hidden), { message: 'invalid_operation' });

  const nested = structuredClone(infer);
  Object.defineProperty(nested.processor, 'endpoint', { value: processor.endpoint, enumerable: false });
  assert.equal(isOperation(nested), false);

  const s = snapshot();
  Object.defineProperty(s.exposures, '0', { value: source.ref, enumerable: false });
  assert.equal(isSnapshot(s), false);
});

test('multiple source revisions retain each revision’s restrictions without ID or cycle confusion', () => {
  const s = snapshot();
  const older: SourceRevision = { ...source, ref: { ...source.ref, revision: 'old-revision' }, processors: [] };
  const newer: SourceRevision = { ...source, parents: [older.ref] };
  const combined = { ...s, sources: [older, newer], exposures: [newer.ref] };
  assert.deepEqual(evaluateEligibility(combined, infer), { status: 'denied', reason: 'source_disclosure_denied' });
  assert.deepEqual(evaluateEligibility(combined, append), eligible);
  assert.deepEqual(evaluateEligibility({ ...combined, sources: [{ ...older, parents: [newer.ref] }, newer] }, append),
    { status: 'denied', reason: 'source_cycle' });
  assert.deepEqual(evaluateEligibility({ ...combined, exposures: [{ ...newer.ref, digest: 'f'.repeat(64) }] }, append),
    { status: 'denied', reason: 'source_missing' });
});
