import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalOperation, fingerprintOperation, prepareOperation } from '../src/index.js';
import type { MailAppend, MailRead, ModelInfer } from '../src/index.js';

const scope = { workspaceId: 'test-workspace', principalId: 'test-owner', runtimeId: 'test-runtime', runId: 'test-run' };
const processor = { profileId: 'test-provider', revision: 'r1', endpoint: 'https://provider.example.test/v1/messages', model: 'test-model' };
const base = { scope, connectionId: 'test-connection', epoch: 1, contractVersion: 1 as const };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function infer(bytes: Uint8Array): ModelInfer {
  return { ...structuredClone(base), kind: 'model.infer', purpose: 'mail.summary', processor: { ...processor },
    inputBytes: bytes.byteLength, outputTokens: 100, payloadDigest: hash(bytes) };
}
const read: MailRead = { ...base, kind: 'mail.read', mailbox: { host: 'imap.example.test', port: 993, folders: ['INBOX'] }, messages: 1, bytes: 1000 };

test('preparation binds the exact serialized UTF-8 request, including JSON escapes and metadata', async () => {
  const text = JSON.stringify({ messages: [{ role: 'user', content: '日本語 🍐\n"quoted"' }], metadata: 'synthetic-private-value' });
  const bytes = new TextEncoder().encode(text);
  assert.notEqual(bytes.byteLength, text.length);
  const operation = infer(bytes);
  const result = await prepareOperation(operation, bytes);
  assert.equal(result.status, 'prepared');
  if (result.status !== 'prepared') return;
  assert.deepEqual(result.request.copyPayload(), bytes);
  assert.equal(new TextDecoder().decode(result.request.copyPayload()), text);
  assert.equal(result.request.canonical, canonicalOperation(operation));
  assert.equal(result.request.fingerprint, await fingerprintOperation(operation));
  assert.equal('permit' in result.request, false);
  assert.equal('admission' in result.request, false);
});

test('the operation and payload are copied before awaiting crypto and cannot be replaced afterwards', async () => {
  const bytes = new TextEncoder().encode('SYNTHETIC_HELD_BYTES');
  const original = bytes.slice();
  const operation = infer(bytes);
  const expected = structuredClone(operation);
  const pending = prepareOperation(operation, bytes);
  Object.assign(operation.processor, { endpoint: 'https://attacker.example.test/collect' });
  bytes.fill(0);
  const result = await pending;
  assert.equal(result.status, 'prepared');
  if (result.status !== 'prepared') return;
  assert.deepEqual(result.request.operation, expected);
  assert.deepEqual(result.request.copyPayload(), original);
  assert.throws(() => Object.assign(result.request.operation.scope, { runId: 'replacement' }), TypeError);
  assert.throws(() => Object.assign(result.request, { operation }), TypeError);
  result.request.copyPayload()!.fill(42);
  assert.deepEqual(result.request.copyPayload(), original);
});

test('a subarray binds its exact view, with no bytes from the surrounding allocation', async () => {
  const allocation = new TextEncoder().encode('DO_NOT_SEND_prefix_approved_suffix_DO_NOT_SEND');
  const view = allocation.subarray(19, 27);
  const expected = view.slice();
  const result = await prepareOperation(infer(view), view);
  assert.equal(result.status, 'prepared');
  if (result.status !== 'prepared') return;
  allocation.fill(0);
  assert.deepEqual(result.request.copyPayload(), expected);
  assert.equal(result.request.copyPayload()!.byteLength, 8);
});

test('a shadowed byteLength cannot pad outgoing bytes or invoke an accessor', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const padded = new Uint8Array([1, 2, 3, 0, 0]);
  const paddedOperation = infer(padded);
  Object.defineProperty(bytes, 'byteLength', { value: 5, configurable: true });
  assert.deepEqual(await prepareOperation(paddedOperation, bytes), { status: 'denied', reason: 'payload_size_mismatch' });
  Object.defineProperty(bytes, 'byteLength', { get() { throw new Error('SYNTHETIC_PRIVATE_EXCEPTION'); } });
  const operation = { ...paddedOperation, inputBytes: 3, payloadDigest: hash(new Uint8Array([1, 2, 3])) };
  const result = await prepareOperation(operation, bytes);
  assert.equal(result.status, 'prepared');
  if (result.status !== 'prepared') return;
  assert.deepEqual(result.request.copyPayload(), new Uint8Array([1, 2, 3]));
});

test('declared digest and size cannot approve different outgoing bytes', async () => {
  const bytes = new TextEncoder().encode('SYNTHETIC_PRIVATE');
  const operation = infer(bytes);
  assert.deepEqual(await prepareOperation({ ...operation, inputBytes: bytes.length - 1 }, bytes),
    { status: 'denied', reason: 'payload_size_mismatch' });
  assert.deepEqual(await prepareOperation({ ...operation, payloadDigest: 'a'.repeat(64) }, bytes),
    { status: 'denied', reason: 'payload_digest_mismatch' });
  const changed = bytes.slice(); changed[0] ^= 1;
  assert.deepEqual(await prepareOperation(operation, changed), { status: 'denied', reason: 'payload_digest_mismatch' });
});

test('screening and private append use actual bytes too, without conflating their size fields', async () => {
  const bytes = new TextEncoder().encode('private payload');
  const operation = infer(bytes);
  const screen = { ...base, kind: 'content.screen', processor, inputBytes: bytes.length, payloadDigest: hash(bytes) };
  const append: MailAppend = { ...base, kind: 'mail.append', destination: { workspaceId: scope.workspaceId, rootId: 'private-root', ownerId: scope.principalId },
    bytes: bytes.length, payloadDigest: hash(bytes) };
  for (const op of [screen, append]) {
    assert.equal((await prepareOperation(op, bytes)).status, 'prepared');
    assert.deepEqual(await prepareOperation(op, bytes.subarray(1)), { status: 'denied', reason: 'payload_size_mismatch' });
  }
  assert.deepEqual(await prepareOperation(operation), { status: 'denied', reason: 'payload_required' });
});

test('read contracts have no extra outgoing payload channel', async () => {
  const result = await prepareOperation(read);
  assert.equal(result.status, 'prepared');
  if (result.status !== 'prepared') return;
  assert.equal(result.request.copyPayload(), undefined);
  assert.deepEqual(await prepareOperation(read, new Uint8Array()), { status: 'denied', reason: 'payload_unexpected' });
});

test('invalid proposals and payload objects produce fixed reasons without reading custom iterators', async () => {
  const bytes = new TextEncoder().encode('SYNTHETIC_PRIVATE');
  const operation = infer(bytes);
  assert.deepEqual(await prepareOperation({ ...operation, approved: 'SYNTHETIC_PRIVATE' }, bytes),
    { status: 'denied', reason: 'invalid_operation' });
  assert.deepEqual(await prepareOperation(operation, 'SYNTHETIC_PRIVATE' as unknown as Uint8Array),
    { status: 'denied', reason: 'invalid_payload' });
  bytes[Symbol.iterator] = () => { throw new Error('iterator must not execute'); };
  assert.equal((await prepareOperation(operation, bytes)).status, 'prepared');
  assert.deepEqual(await prepareOperation(operation, new Proxy(bytes, {})), { status: 'denied', reason: 'invalid_payload' });
});

test('unexpected canonicalization exceptions stay behind a fixed preparation denial', async () => {
  const bytes = new TextEncoder().encode('SYNTHETIC_PRIVATE');
  let keys = 0;
  const proxy = new Proxy(infer(bytes), {
    ownKeys(target) {
      if (++keys === 3) throw new Error('SYNTHETIC_PRIVATE_EXCEPTION');
      return Reflect.ownKeys(target);
    },
  });
  // Parsed JSON, rather than live proxies, is the supported proposal boundary.
  // Unexpected host-side objects must still not expose a raw preparation error.
  await assert.doesNotReject(async () => {
    assert.deepEqual(await prepareOperation(proxy, bytes), { status: 'denied', reason: 'preparation_unavailable' });
  });
});
