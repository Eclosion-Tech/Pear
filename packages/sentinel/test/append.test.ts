import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalAppendPayload, canonicalOperation, fingerprintOperation, prepareMailAppend, prepareOperation } from "../src/index.js";
import type { FrozenAppendPayloadV1, MailAppendBinding, SourceRef } from "../src/index.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ref = (id = "stage", revision = "1", digest = "a".repeat(64)): SourceRef => ({ id, revision, digest });
function payload(): FrozenAppendPayloadV1 {
  const stage = ref();
  return { body: "hi\n\"quote\"\\\t\r", contractVersion: 1, kind: "mail.summary", parents: [stage], sanitizationVersion: "v1", stage };
}
function binding(): MailAppendBinding {
  return { scope: { workspaceId: "module", principalId: "owner", runtimeId: "runtime", runId: "run", parentRunId: "parent" },
    connectionId: "123", epoch: 7, destination: { workspaceId: "module", rootId: "456", ownerId: "owner" } };
}

test("escaped golden envelope binds recursive key order and the entire UTF-8 byte cost", async () => {
  const canonical = canonicalAppendPayload(payload());
  const expected = `{"body":"hi\\n\\\"quote\\\"\\\\\\t\\r","contractVersion":1,"kind":"mail.summary","parents":[{"digest":"${"a".repeat(64)}","id":"stage","revision":"1"}],"sanitizationVersion":"v1","stage":{"digest":"${"a".repeat(64)}","id":"stage","revision":"1"}}`;
  assert.equal(canonical, expected);
  assert.equal(Buffer.byteLength(canonical!), 331);
  assert.equal(hash(canonical!), "79915b3cb20545cffcf823d15da29aaa3b4acf794bcc9613883ffc9e0e2c2677");
  const result = await prepareMailAppend(binding(), payload());
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") return;
  assert.equal(result.request.operation.kind, "mail.append");
  assert.equal(result.request.operation.bytes, 331);
  assert.equal(result.request.operation.payloadDigest, hash(expected));
  assert.notEqual(result.request.operation.payloadDigest, payload().stage.digest);
  assert.equal(new TextDecoder().decode(result.request.copyPayload()), expected);
  assert.equal(result.request.canonical, canonicalOperation(result.request.operation));
  assert.equal(result.request.fingerprint, await fingerprintOperation(result.request.operation));
  assert.equal((await prepareOperation(result.request.operation, result.request.copyPayload())).status, "prepared");
  assert.equal("permit" in result.request, false);
  assert.equal("admission" in result.request, false);
});

test("Unicode golden vector sorts UTF-8 ids and exact numeric u64 revisions without precision loss", async () => {
  const stage = ref("same", "2", "b".repeat(64));
  const parents = [ref("🍐", "1", "d".repeat(64)), ref("same", "18446744073709551615", "b".repeat(64)),
    ref("same", "10", "b".repeat(64)), ref("\ue000", "1", "c".repeat(64)), stage,
    ref("same", "9007199254740993", "b".repeat(64))];
  const value = { ...payload(), body: " 🍐\u2028e\u0301日本語 ", parents, stage };
  const canonical = canonicalAppendPayload(value)!;
  assert.equal(Buffer.byteLength(canonical), 890);
  assert.equal(hash(canonical), "fca432a86a3a27395da40197acc724f8290a281b39ef97a6bbe626f0c8a0d074");
  assert.deepEqual(JSON.parse(canonical).parents.map((p: SourceRef) => [p.id, p.revision]),
    [["same", "2"], ["same", "10"], ["same", "9007199254740993"], ["same", "18446744073709551615"], ["\ue000", "1"], ["🍐", "1"]]);
  assert.equal(canonical.includes("\u2028"), true);
  assert.equal(canonical.includes("\\u2028"), false);
  const result = await prepareMailAppend(binding(), value);
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") return;
  assert.equal(result.request.operation.bytes, 890);
  assert.equal(result.request.operation.payloadDigest, hash(canonical));
});

test("input property/parent order is canonical, while exact body, ancestry, stage and sanitizer bytes matter", async () => {
  const original = payload();
  const extra = ref("ancestor", "10", "b".repeat(64));
  const value = { stage: original.stage, sanitizationVersion: "v1", parents: [original.stage, extra], kind: "mail.summary", contractVersion: 1, body: original.body };
  const canonical = canonicalAppendPayload(value)!;
  assert.equal(canonicalAppendPayload({ ...original, parents: [extra, original.stage] }), canonical);
  for (const changed of [
    { ...value, body: ` ${value.body}` }, { ...value, body: value.body.replace("\r", "\n") },
    { ...value, sanitizationVersion: "v2" }, { ...value, parents: [original.stage] },
    { ...value, stage: extra },
  ]) assert.notEqual(hash(canonicalAppendPayload(changed)!), hash(canonical));
  assert.notEqual(canonicalAppendPayload({ ...original, body: "é" }), canonicalAppendPayload({ ...original, body: "e\u0301" }));
  assert.equal(JSON.parse(canonicalAppendPayload({ ...original, body: "  \r\n\t  " })!).body, "  \r\n\t  ");
  assert.notEqual(JSON.parse(canonical).stage.digest, hash(canonical));
});

test("preparation copies binding and envelope before the first await and holds no mutable payload alias", async () => {
  const source = structuredClone(payload());
  const host = binding();
  const expected = canonicalAppendPayload(source)!;
  const hostCopy = structuredClone(host);
  const pending = prepareMailAppend(host, source);
  Object.assign(source, { body: "SYNTHETIC_REPLACEMENT", sanitizationVersion: "changed" });
  Object.assign(source.stage, { digest: "f".repeat(64) });
  Object.assign(host.scope, { runId: "changed" });
  Object.assign(host.destination, { rootId: "changed" });
  const result = await pending;
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") return;
  assert.deepEqual(result.request.operation.scope, hostCopy.scope);
  assert.deepEqual(result.request.operation.destination, hostCopy.destination);
  assert.equal(new TextDecoder().decode(result.request.copyPayload()), expected);
  result.request.copyPayload()!.fill(0);
  assert.equal(new TextDecoder().decode(result.request.copyPayload()), expected);
  assert.throws(() => Object.assign(result.request.operation.scope, { runId: "replacement" }), TypeError);
});

test("append binding rejects declared cost/digest, unknown fields and invalid S0 operation bindings", async () => {
  for (const host of [null, { ...binding(), bytes: 1 }, { ...binding(), payloadDigest: "a".repeat(64) },
    { ...binding(), kind: "mail.append" }, { ...binding(), epoch: -1 },
    { ...binding(), scope: { ...binding().scope, runId: "\ud800" } },
    { ...binding(), scope: { ...binding().scope, unknown: true } },
    { ...binding(), destination: { ...binding().destination, rootId: "" } }]) {
    assert.deepEqual(await prepareMailAppend(host, payload()), { status: "denied", reason: "invalid_append_binding" });
  }
});

test("envelope schema is closed and stage must occur exactly in the supplied closure", async () => {
  const value = payload();
  const invalid = [null, [], { ...value, extra: true }, { ...value, contractVersion: 2 }, { ...value, kind: "mail.send" },
    { ...value, body: new String("body") }, { ...value, stage: { ...value.stage, extra: true } },
    { ...value, parents: [] }, { ...value, parents: [ref("other")] },
    { ...value, stage: { ...value.stage, digest: "b".repeat(64) } }, { ...value, sanitizationVersion: " v1 " }];
  for (const item of invalid) {
    assert.equal(canonicalAppendPayload(item), undefined);
    assert.deepEqual(await prepareMailAppend(binding(), item), { status: "denied", reason: "invalid_append_payload" });
  }
});

test("repeated identities are rejected instead of silently deduplicating or accepting conflicting digests", () => {
  const value = payload();
  for (const duplicate of [{ ...value.stage }, { ...value.stage, digest: "b".repeat(64) }]) {
    assert.equal(canonicalAppendPayload({ ...value, parents: [value.stage, duplicate] }), undefined);
  }
  assert.notEqual(canonicalAppendPayload({ ...value, parents: [value.stage, ref("stage", "2")] }), undefined);
});

test("revisions are positive canonical decimal u64 strings, not rounded JS numbers", () => {
  for (const revision of ["0", "01", "+1", "1.0", "1e2", " 1", "1 ", "-1", "18446744073709551616", "999999999999999999999", 1, 9007199254740993]) {
    const stage = { ...ref(), revision };
    assert.equal(canonicalAppendPayload({ ...payload(), stage, parents: [stage] }), undefined);
  }
  for (const revision of ["1", "9007199254740993", "18446744073709551615"]) {
    const stage = ref("stage", revision);
    assert.notEqual(canonicalAppendPayload({ ...payload(), stage, parents: [stage] }), undefined);
  }
});

test("UTF-8 scalar text is preserved and lone surrogates or unsupported controls never get replacement bytes", () => {
  for (const body of ["\ud800", "\udfff", "ok\ud800x", "\udc00\ud800", "\u0000", "\b", "\f", "\u007f", "\u0085"]) {
    assert.equal(canonicalAppendPayload({ ...payload(), body }), undefined);
  }
  for (const id of ["\ud800", "\udfff", "a\u0085b", " stage", "stage\u2028", "" ]) {
    const stage = ref(id);
    assert.equal(canonicalAppendPayload({ ...payload(), stage, parents: [stage] }), undefined);
  }
  // Rust does not trim BOM; preserve it rather than applying JS trim.
  const stage = ref("\ufeffstage");
  assert.equal(JSON.parse(canonicalAppendPayload({ ...payload(), stage, parents: [stage] })!).stage.id, "\ufeffstage");
  for (const body of ["", "\t\r\n", "🍐\u2028\u2029", "a\ufeffb"]) {
    assert.equal(JSON.parse(canonicalAppendPayload({ ...payload(), body })!).body, body);
  }
});

test("body, parent count, identifiers and sanitizer bounds use exact UTF-8 bytes", () => {
  for (const body of ["a".repeat(160_000), "🍐".repeat(40_000)]) {
    assert.notEqual(canonicalAppendPayload({ ...payload(), body }), undefined);
    assert.equal(canonicalAppendPayload({ ...payload(), body: `${body}a` }), undefined);
  }
  const parents = Array.from({ length: 256 }, (_, i) => ref(`source-${i}`));
  assert.notEqual(canonicalAppendPayload({ ...payload(), stage: parents[0], parents }), undefined);
  assert.equal(canonicalAppendPayload({ ...payload(), stage: parents[0], parents: [...parents, ref("extra")] }), undefined);
  for (const id of ["a".repeat(256), "🍐".repeat(64)]) {
    const stage = ref(id);
    assert.notEqual(canonicalAppendPayload({ ...payload(), stage, parents: [stage] }), undefined);
    const longer = { ...stage, id: `${id}a` };
    assert.equal(canonicalAppendPayload({ ...payload(), stage: longer, parents: [longer] }), undefined);
  }
  assert.notEqual(canonicalAppendPayload({ ...payload(), sanitizationVersion: "v".repeat(64) }), undefined);
  for (const sanitizationVersion of ["", "v".repeat(65), "v/1", "é", "v\n1"]) {
    assert.equal(canonicalAppendPayload({ ...payload(), sanitizationVersion }), undefined);
  }
});

test("accessors, custom array channels and hostile objects produce fixed denials without input diagnostics", async () => {
  let reads = 0;
  const source = payload();
  Object.defineProperty(source, "body", { get() { reads++; throw new Error("SYNTHETIC_PRIVATE_ERROR\ncontrol"); }, enumerable: true });
  const parents = [ref()];
  Object.defineProperty(parents, "0", { get() { reads++; throw new Error("SYNTHETIC_PRIVATE_ERROR"); }, enumerable: true });
  const sparse = new Array(1);
  const extra = Object.assign([ref()], { hidden: "SYNTHETIC_PRIVATE" });
  const symbol = [ref()];
  Object.defineProperty(symbol, Symbol.iterator, { value() { reads++; throw new Error("SYNTHETIC_PRIVATE_ERROR"); } });
  const hostile = new Proxy(payload(), { ownKeys() { throw new Error("SYNTHETIC_PRIVATE_ERROR"); } });
  for (const value of [source, hostile, { ...payload(), parents }, { ...payload(), parents: sparse },
    { ...payload(), parents: extra }, { ...payload(), parents: symbol }]) {
    assert.equal(canonicalAppendPayload(value), undefined);
    assert.deepEqual(await prepareMailAppend(binding(), value), { status: "denied", reason: "invalid_append_payload" });
  }
  const host = binding();
  Object.defineProperty(host, "scope", { get() { reads++; throw new Error("SYNTHETIC_PRIVATE_ERROR"); }, enumerable: true });
  assert.deepEqual(await prepareMailAppend(host, payload()), { status: "denied", reason: "invalid_append_binding" });
  const proxy = new Proxy(binding(), { ownKeys() { throw new Error("SYNTHETIC_PRIVATE_ERROR"); } });
  assert.deepEqual(await prepareMailAppend(proxy, payload()), { status: "denied", reason: "preparation_unavailable" });
  assert.equal(reads, 0);
});
