import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalInferenceResultPayload, parseInferenceResultDeclaration, prepareInferenceResult } from "../src/index.js";
import type { InferenceResultBinding, InferenceResultDeclarationV1, InferenceResultPayloadV1, SourceRef } from "../src/index.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function declaration(): InferenceResultDeclarationV1 {
  return { formatVersion: 1, adapter: "anthropic.messages.v1", model: "fixture-model", stopReason: "end_turn", outputTokens: 128, body: '\tquoted "body"\\\r\n' };
}
function binding(): InferenceResultBinding {
  return { admissionId: "a".repeat(64), model: "fixture-model", reservedOutputTokens: 128,
    parents: [{ id: 'mail-source:escaped"\\', revision: "10", digest: "b".repeat(64) }, { id: 'mail-source:escaped"\\', revision: "2", digest: "c".repeat(64) }] };
}
function payload(): InferenceResultPayloadV1 {
  const bound = binding();
  return { ...declaration(), admissionId: bound.admissionId, parents: bound.parents, kind: "mail.inference.result", sanitizationVersion: "sentinel-result-v1" };
}
test("declaration parser returns a fresh frozen structural declaration without accepting authority fields", () => {
  const input = declaration(), parsed = parseInferenceResultDeclaration(input)!;
  assert.notEqual(parsed, input); assert.deepEqual(parsed, input); assert.ok(Object.isFrozen(parsed));
  assert.equal(parseInferenceResultDeclaration({ ...input, approved: true }), undefined);
  assert.equal(parseInferenceResultDeclaration(new Proxy({}, { getPrototypeOf() { throw Error("PRIVATE_RESULT_ERROR"); } })), undefined);
});

test("escaped golden binds the exact declaration, admission and complete numeric-sorted ancestry", async () => {
  const canonical = canonicalInferenceResultPayload(payload())!;
  // Independently computed with Python's UTF-8 canonical JSON encoder.
  assert.equal(Buffer.byteLength(canonical), 569);
  assert.equal(digest(canonical), "73a46f6ec32879172ca1c2cdd2087a21c476fa069177e8752063734cbfc5b90a");
  assert.deepEqual(Object.keys(JSON.parse(canonical)), ["adapter", "admissionId", "body", "formatVersion", "kind", "model", "outputTokens", "parents", "sanitizationVersion", "stopReason"]);
  assert.deepEqual(JSON.parse(canonical).parents.map((ref: SourceRef) => ref.revision), ["2", "10"]);
  const prepared = await prepareInferenceResult(binding(), declaration());
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.result.canonical, canonical);
  assert.equal(prepared.result.envelopeBytes, 569);
  assert.equal(prepared.result.envelopeDigest, digest(canonical));
  assert.equal(Buffer.from(prepared.result.copyPayload()).toString("utf8"), canonical);
  assert.ok(!("operation" in prepared.result) && !("permit" in prepared.result));
});

test("Unicode golden preserves exact scalars/line bytes and u64 precision with UTF-8 id ordering", () => {
  const value = { ...payload(), model: "unicode-model", outputTokens: 4096,
    body: '\t🍐\u2028e\u0301\u2029日本語 \ufeff\r\n"\\', parents: [
      { id: "🍐", revision: "18446744073709551615", digest: "d".repeat(64) },
      { id: "\ue000", revision: "9007199254740993", digest: "e".repeat(64) },
      { id: "𝄞", revision: "2", digest: "f".repeat(64) },
      { id: "e\u0301", revision: "10", digest: "a".repeat(64) },
    ] };
  const canonical = canonicalInferenceResultPayload(value)!;
  assert.equal(Buffer.byteLength(canonical), 787);
  assert.equal(digest(canonical), "d5cc334229eb2cecdffbe453b5e7cc216bae0e7c7f1551db45ed4fca7adb7196");
  assert.deepEqual(JSON.parse(canonical).parents.map((ref: SourceRef) => ref.id), ["e\u0301", "\ue000", "𝄞", "🍐"]);
  assert.ok(canonical.includes("9007199254740993") && canonical.includes("18446744073709551615"));
  assert.equal(JSON.parse(canonical).body, value.body);
});

test("property/parent order is canonical while every literal field and parent is binding", () => {
  const original = payload(), canonical = canonicalInferenceResultPayload(original)!;
  assert.equal(canonicalInferenceResultPayload({ ...Object.fromEntries(Object.entries(original).reverse()), parents: [...original.parents].reverse() }), canonical);
  for (const change of [{ body: `${original.body} ` }, { admissionId: "b".repeat(64) }, { model: "other-model" }, { outputTokens: 127 },
    { parents: original.parents.slice(1) }, { parents: original.parents.map((ref, index) => index ? ref : { ...ref, digest: "d".repeat(64) }) }]) {
    assert.notEqual(canonicalInferenceResultPayload({ ...original, ...change }), canonical);
  }
  assert.notEqual(canonicalInferenceResultPayload({ ...original, body: "é" }), canonicalInferenceResultPayload({ ...original, body: "e\u0301" }));
  assert.notEqual(canonicalInferenceResultPayload({ ...original, body: "\r\n" }), canonicalInferenceResultPayload({ ...original, body: "\n" }));
});

test("closed declaration/envelope reject tools, citations, parents, approvals and all authority fields", async () => {
  const original = payload();
  for (const key of Object.keys(original)) { const value = { ...original } as Record<string, unknown>; delete value[key]; assert.equal(canonicalInferenceResultPayload(value), undefined); }
  for (const extra of [{ tools: [] }, { citations: [] }, { approved: true }, { grantId: "forged" }, { owner: "forged" }, { processor: {} }, { sourceDigest: "a".repeat(64) }]) {
    assert.equal(canonicalInferenceResultPayload({ ...original, ...extra }), undefined);
    assert.deepEqual(await prepareInferenceResult(binding(), { ...declaration(), ...extra }), { status: "denied", reason: "invalid_result_payload" });
  }
  assert.equal((await prepareInferenceResult(binding(), { ...declaration(), parents: binding().parents })).status, "denied");
  for (const change of [{ formatVersion: 2 }, { adapter: "openai.chat-completions.v1" }, { kind: "mail.summary.result" }, { sanitizationVersion: "safe" },
    { stopReason: "tool_use" }, { stopReason: "max_tokens" }, { stopReason: null }, { admissionId: `0x${"a".repeat(64)}` }]) {
    assert.equal(canonicalInferenceResultPayload({ ...original, ...change }), undefined);
  }
});

test("preparation binds exact model/reserved cap and cannot substitute permission-like metadata", async () => {
  for (const change of [{ model: "different" }, { reservedOutputTokens: 127 }, { reservedOutputTokens: 0 }, { reservedOutputTokens: 4097 }, { reservedOutputTokens: NaN },
    { admissionId: "missing" }, { parents: [] }, { approved: true }]) {
    assert.equal((await prepareInferenceResult({ ...binding(), ...change }, declaration())).status, "denied");
  }
  for (const count of [0, -1, 4097, 1.5, NaN, Infinity, "128", null]) assert.equal(canonicalInferenceResultPayload({ ...payload(), outputTokens: count }), undefined);
  assert.equal((await prepareInferenceResult({ ...binding(), reservedOutputTokens: 1 }, { ...declaration(), outputTokens: 1 })).status, "prepared");
  assert.equal((await prepareInferenceResult({ ...binding(), reservedOutputTokens: 4096 }, { ...declaration(), outputTokens: 4096 })).status, "prepared");
});

test("copying precedes the first await and no returned alias can alter frozen evidence bytes", async () => {
  const bound = structuredClone(binding()), proposed = structuredClone(declaration());
  const pending = prepareInferenceResult(bound, proposed);
  (bound.parents[0] as { digest: string }).digest = "e".repeat(64);
  (proposed as { body: string }).body = "changed";
  const prepared = await pending;
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.result.canonical, canonicalInferenceResultPayload(payload()));
  assert.ok(Object.isFrozen(prepared.result) && Object.isFrozen(prepared.result.envelope) && Object.isFrozen(prepared.result.envelope.parents) && Object.isFrozen(prepared.result.envelope.parents[0]));
  const bytes = prepared.result.copyPayload(); bytes.fill(0);
  assert.equal(digest(prepared.result.copyPayload()), prepared.result.envelopeDigest);
});

test("nonempty body and model rules preserve whitespace/BOM in literal data without normalization", () => {
  assert.equal(canonicalInferenceResultPayload({ ...payload(), body: "" }), undefined);
  for (const body of [" ", "\t\r\n", "\ufeff", "e\u0301\u2028\u2029🍐"]) assert.equal(JSON.parse(canonicalInferenceResultPayload({ ...payload(), body })!).body, body);
  for (const body of ["\ud800", "\udfff", "\u0000", "\u000b", "\u001f", "\u007f", "\u0085", "\u009f"]) assert.equal(canonicalInferenceResultPayload({ ...payload(), body }), undefined);
  for (const model of ["", " model", "model ", "\ufeffmodel", "model\ufeff", "\u0085model", "model\u0085", "\ud800", "model\n"]) assert.equal(canonicalInferenceResultPayload({ ...payload(), model }), undefined);
});

test("body and full-envelope limits charge all escaped ancestry bytes, not text length alone", () => {
  assert.ok(canonicalInferenceResultPayload({ ...payload(), body: "🍐".repeat(16384) }));
  assert.equal(canonicalInferenceResultPayload({ ...payload(), body: `${"🍐".repeat(16384)}x` }), undefined);
  const parents = Array.from({ length: 255 }, (_, index) => ({ id: `id${String(index).padStart(4, "0")}${'"\\'.repeat(125)}`, revision: "1", digest: "b".repeat(64) }));
  const overhead = Buffer.byteLength(canonicalInferenceResultPayload({ ...payload(), parents, body: "x" })!) - 1;
  const bodyBytes = 262144 - overhead;
  const body = '"'.repeat(Math.floor(bodyBytes / 2)) + (bodyBytes % 2 ? "x" : "");
  assert.ok(body.length <= 65536 && body.length > 0);
  assert.equal(Buffer.byteLength(canonicalInferenceResultPayload({ ...payload(), parents, body })!), 262144);
  assert.equal(canonicalInferenceResultPayload({ ...payload(), parents, body: `${body} ` }), undefined);
  assert.equal(canonicalInferenceResultPayload({ ...payload(), parents: [...parents, { id: "extra", revision: "1", digest: "a".repeat(64) }] }), undefined);
});

test("parent identities are strict canonical u64 triples and cannot be duplicated or silently dropped", () => {
  const first = payload().parents[0];
  for (const revision of ["0", "01", "-1", "+1", "1.0", "1e1", "18446744073709551616", 1, 9007199254740993]) {
    assert.equal(canonicalInferenceResultPayload({ ...payload(), parents: [{ ...first, revision }] }), undefined);
  }
  for (const parents of [[], [first, first], [first, { ...first, digest: "d".repeat(64) }], [{ ...first, id: " " }], [{ ...first, id: "x".repeat(257) }],
    [{ ...first, id: "\udfff" }], [{ ...first, digest: "B".repeat(64) }], [{ ...first, extra: true }]]) assert.equal(canonicalInferenceResultPayload({ ...payload(), parents }), undefined);
});

test("hostile objects and nested getters yield fixed failures without data getters or raw error details", async () => {
  let invoked = false;
  const hostile = { ...payload() }; Object.defineProperty(hostile, "body", { enumerable: true, get() { invoked = true; throw Error("PRIVATE_RESULT_ERROR"); } });
  assert.equal(canonicalInferenceResultPayload(hostile), undefined);
  assert.equal(invoked, false);
  const parents = [...payload().parents]; Object.defineProperty(parents, "0", { enumerable: true, get() { invoked = true; return payload().parents[0]; } });
  assert.equal(canonicalInferenceResultPayload({ ...payload(), parents }), undefined); assert.equal(invoked, false);
  const custom = { ...payload(), [Symbol("hidden")]: "PRIVATE_RESULT_ERROR" };
  assert.equal(canonicalInferenceResultPayload(custom), undefined);
  const inherited = Object.create(payload()); assert.equal(canonicalInferenceResultPayload(inherited), undefined);
  assert.equal(canonicalInferenceResultPayload(new Proxy({}, { ownKeys() { throw Error("PRIVATE_RESULT_ERROR"); } })), undefined);
  assert.deepEqual(await prepareInferenceResult(new Proxy({}, { getPrototypeOf() { throw Error("PRIVATE_RESULT_ERROR"); } }), declaration()), { status: "denied", reason: "result_preparation_unavailable" });
});
