import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalInferencePayload, canonicalOperation, fingerprintOperation, inferenceGrantId, MAIL_INFERENCE_TRANSPORT_V1, prepareMailInference, prepareOperation } from "../src/index.js";
import type { FixedMailInferenceInputV1, MailInferenceBinding } from "../src/index.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
test("grant identity is exact owner/collection/nonce scoped with canonical u64 text", async () => {
  const owner = "a".repeat(64), nonce = "b".repeat(64);
  const fields = ["pear-mail-inference-grant-id-v1", owner, "18446744073709551615", nonce];
  const independent = createHash("sha256");
  for (const field of fields) { const bytes = Buffer.from(field), size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(bytes.length)); independent.update(size).update(bytes); }
  const id = await inferenceGrantId(owner, "18446744073709551615", nonce);
  assert.equal(id, independent.digest("hex"));
  assert.equal(await inferenceGrantId(owner, "18446744073709551615", nonce), id);
  assert.notEqual(await inferenceGrantId("c".repeat(64), "18446744073709551615", nonce), id);
  assert.notEqual(await inferenceGrantId(owner, "18446744073709551614", nonce), id);
  assert.notEqual(await inferenceGrantId(owner, "18446744073709551615", "c".repeat(64)), id);
  for (const collection of ["", "0", "01", "+1", "-1", "1.0", "1e2", "18446744073709551616", " 1", "1\n"]) assert.equal(await inferenceGrantId(owner, collection, nonce), undefined);
  for (const invalid of ["", `0x${owner}`, owner.toUpperCase(), "g".repeat(64), `${owner}\n`]) {
    assert.equal(await inferenceGrantId(invalid, "1", nonce), undefined);
    assert.equal(await inferenceGrantId(owner, "1", invalid), undefined);
  }
});
function input(): FixedMailInferenceInputV1 {
  return { adapter: "anthropic.messages.v1", contractVersion: 1, instruction: "\tApproved \"instruction\"\\\r\n", model: "fixture-model", outputTokens: 128,
    mail: { body: "hi\n\"quote\"\\\t\r", cc: "", direction: "received", from: "sender@example.test", messageDate: "2026-10-20T12:00:00Z", sanitizationVersion: "v1", subject: "Subject", to: "owner@example.test" } };
}
function binding(model = "fixture-model"): MailInferenceBinding {
  return { scope: { workspaceId: "module", principalId: "owner", runtimeId: "runtime", runId: "run", parentRunId: "parent" }, connectionId: "123", epoch: 7,
    processor: { profileId: "fixture-profile", revision: `mail-processor-revision:${"a".repeat(64)}`, endpoint: "https://processor.example.test/v1/messages", model } };
}

test("escaped golden provider request binds all actual prompt bytes including both JSON layers", async () => {
  const canonical = canonicalInferencePayload(input())!;
  assert.equal(Buffer.byteLength(canonical), 369);
  assert.equal(hash(canonical), "f4a1165b4fe330907b0b797bad7fcee7a52d85de830f6d6e37f48ba9b9ce910c");
  const wire = JSON.parse(canonical);
  assert.deepEqual(Object.keys(wire), ["max_tokens", "messages", "model", "system"]);
  assert.equal(wire.system, input().instruction);
  assert.deepEqual(wire.messages, [{ content: String.raw`{"body":"hi\n\"quote\"\\\t\r","cc":"","direction":"received","from":"sender@example.test","messageDate":"2026-10-20T12:00:00Z","sanitizationVersion":"v1","subject":"Subject","to":"owner@example.test"}`, role: "user" }]);
  assert.deepEqual(JSON.parse(wire.messages[0].content), input().mail);
  const result = await prepareMailInference(binding(), input());
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") return;
  assert.equal(result.request.operation.kind, "model.infer");
  assert.equal(result.request.operation.purpose, "mail.summary");
  assert.equal(result.request.operation.inputBytes, 369);
  assert.equal(result.request.operation.outputTokens, 128);
  assert.equal(result.request.operation.payloadDigest, hash(canonical));
  assert.equal(new TextDecoder().decode(result.request.copyPayload()), canonical);
  assert.equal(result.request.canonical, canonicalOperation(result.request.operation));
  assert.equal(result.request.fingerprint, await fingerprintOperation(result.request.operation));
  assert.equal((await prepareOperation(result.request.operation, result.request.copyPayload())).status, "prepared");
  assert.equal("permit" in result.request, false);
  assert.equal("admission" in result.request, false);
});

test("Unicode golden preserves scalar text, U2028/U2029, BOM, combining marks and exact whitespace", async () => {
  const value: FixedMailInferenceInputV1 = { ...input(), model: "unicode-model", outputTokens: 4096, instruction: " 🍐\u2028e\u0301日本語 \r\n",
    mail: { body: "body 🍐\u2028e\u0301\u2029\ufeff", cc: "cc@example.test", direction: "sent", from: "o\"wner@example.test", messageDate: "", sanitizationVersion: "v2", subject: "𝄞\ue000\"\\", to: "recipient@example.test" } };
  const canonical = canonicalInferencePayload(value)!;
  assert.equal(Buffer.byteLength(canonical), 362);
  assert.equal(hash(canonical), "787c3f95e16fae5e51b2580d8e7191274e0989e9e5ca71d746c20df1fe2235ca");
  assert.equal(canonical.includes("\u2028"), true);
  assert.equal(canonical.includes("\\u2028"), false);
  assert.deepEqual(JSON.parse(JSON.parse(canonical).messages[0].content), value.mail);
  assert.equal(JSON.parse(canonical).system, value.instruction);
  const result = await prepareMailInference(binding(value.model), value);
  assert.equal(result.status, "prepared");
  if (result.status === "prepared") assert.equal(result.request.operation.inputBytes, 362);
});

test("transport contract has one exact adapter, method and nonsecret header set", () => {
  assert.deepEqual(MAIL_INFERENCE_TRANSPORT_V1, { adapter: "anthropic.messages.v1", method: "POST", headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" } });
  assert.equal(Object.isFrozen(MAIL_INFERENCE_TRANSPORT_V1), true);
  assert.equal(Object.isFrozen(MAIL_INFERENCE_TRANSPORT_V1.headers), true);
  assert.equal("authorization" in MAIL_INFERENCE_TRANSPORT_V1.headers, false);
  assert.equal("credential" in MAIL_INFERENCE_TRANSPORT_V1, false);
});

test("property order is canonical but every literal instruction/mail/model/output field is binding", () => {
  const original = input(), canonical = canonicalInferencePayload(original)!;
  const reverse = { outputTokens: original.outputTokens, model: original.model, mail: Object.fromEntries(Object.entries(original.mail).reverse()), instruction: original.instruction, contractVersion: 1, adapter: original.adapter };
  assert.equal(canonicalInferencePayload(reverse), canonical);
  for (const changed of [{ ...original, instruction: ` ${original.instruction}` }, { ...original, model: "other-model" }, { ...original, outputTokens: 129 },
    ...Object.keys(original.mail).map(key => ({ ...original, mail: { ...original.mail, [key]: key === "direction" ? "sent" : `${original.mail[key as keyof typeof original.mail]}x` } }))]) {
    assert.notEqual(canonicalInferencePayload(changed), canonical);
  }
  assert.notEqual(canonicalInferencePayload({ ...original, instruction: "é" }), canonicalInferencePayload({ ...original, instruction: "e\u0301" }));
  assert.notEqual(canonicalInferencePayload({ ...original, mail: { ...original.mail, body: "a\r\nb" } }), canonicalInferencePayload({ ...original, mail: { ...original.mail, body: "a\nb" } }));
});

test("fixed input schema rejects omitted fields and all options, headers, citations or hidden source metadata", async () => {
  const value = input();
  const bad: unknown[] = [null, [], { ...value, adapter: "openai.chat-completions.v1" }, { ...value, contractVersion: 2 }, { ...value, model: "" },
    { ...value, mail: { ...value.mail, direction: "Received" } }, { ...value, instruction: new String("instruction") }];
  for (const key of Object.keys(value)) { const missing = { ...value } as Record<string, unknown>; delete missing[key]; bad.push(missing); }
  for (const key of Object.keys(value.mail)) { const missing = { ...value.mail } as Record<string, unknown>; delete missing[key]; bad.push({ ...value, mail: missing }); }
  for (const key of ["tools", "stream", "messages", "system", "headers", "endpoint", "credential", "history", "cache", "session", "metadata", "parents", "clean"]) bad.push({ ...value, [key]: "SYNTHETIC_PRIVATE" });
  for (const key of ["folder", "uidValidity", "uid", "note", "sourceId", "extra"]) bad.push({ ...value, mail: { ...value.mail, [key]: "SYNTHETIC_PRIVATE" } });
  for (const item of bad) {
    assert.equal(canonicalInferencePayload(item), undefined);
    assert.deepEqual(await prepareMailInference(binding(), item), { status: "denied", reason: "invalid_inference_payload" });
  }
});

test("caller-declared costs and mismatched model/scope/processor bindings cannot replace the computed operation", async () => {
  for (const host of [null, { ...binding(), inputBytes: 1 }, { ...binding(), outputTokens: 1 }, { ...binding(), payloadDigest: "a".repeat(64) },
    { ...binding(), kind: "model.infer" }, { ...binding(), epoch: -1 }, { ...binding(), scope: { ...binding().scope, runId: "\ud800" } },
    { ...binding(), processor: { ...binding().processor, model: "another-model" } },
    { ...binding(), processor: { ...binding().processor, endpoint: "https://processor.example.test/v1/messages?data=private" } },
    { ...binding(), processor: { ...binding().processor, unknown: true } }]) {
    assert.deepEqual(await prepareMailInference(host, input()), { status: "denied", reason: "invalid_inference_binding" });
  }
});

test("inputs are copied before crypto yields and prepared byte copies cannot mutate the held request", async () => {
  const value = input(), host = binding(), canonical = canonicalInferencePayload(value)!;
  const pending = prepareMailInference(host, value);
  Object.assign(value.mail, { body: "SYNTHETIC_REPLACEMENT", subject: "changed" });
  Object.assign(value, { instruction: "changed", outputTokens: 1, model: "changed" });
  Object.assign(host.scope, { runId: "changed" });
  Object.assign(host.processor, { endpoint: "https://attacker.example.test/collect", model: "changed" });
  const result = await pending;
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") return;
  assert.equal(result.request.operation.scope.runId, "run");
  assert.equal(result.request.operation.processor.endpoint, binding().processor.endpoint);
  assert.equal(result.request.operation.outputTokens, 128);
  assert.equal(new TextDecoder().decode(result.request.copyPayload()), canonical);
  result.request.copyPayload()!.fill(0);
  assert.equal(new TextDecoder().decode(result.request.copyPayload()), canonical);
  assert.throws(() => Object.assign(result.request.operation.processor, { model: "changed" }), TypeError);
});

test("text/output limits use UTF-8 bytes and the full nested request, not mail body length", () => {
  for (const outputTokens of [0, -1, 4097, 1.5, Infinity, NaN, "128"]) assert.equal(canonicalInferencePayload({ ...input(), outputTokens }), undefined);
  for (const [key, max] of [["body", 160000], ["cc", 2048], ["from", 2048], ["to", 2048], ["messageDate", 64], ["subject", 1024]] as const) {
    const ascii = "a".repeat(max), unicode = "🍐".repeat(max / 4);
    for (const text of [ascii, unicode]) {
      assert.notEqual(canonicalInferencePayload({ ...input(), mail: { ...input().mail, [key]: text } }), undefined);
      assert.equal(canonicalInferencePayload({ ...input(), mail: { ...input().mail, [key]: `${text}a` } }), undefined);
    }
  }
  assert.notEqual(canonicalInferencePayload({ ...input(), instruction: "a".repeat(16384), model: "a".repeat(256) }), undefined);
  assert.equal(canonicalInferencePayload({ ...input(), instruction: "a".repeat(16385) }), undefined);
  assert.equal(canonicalInferencePayload({ ...input(), model: "🍐".repeat(65) }), undefined);
  const nested = canonicalInferencePayload({ ...input(), mail: { ...input().mail, body: "\\".repeat(160000) } })!;
  assert.ok(Buffer.byteLength(nested) > 512 * 1024, "nested escaping is charged instead of truncated to the local append limit");
  assert.ok(Buffer.byteLength(nested) <= 1024 * 1024);
});

test("scalar/control rules preserve exact bodies while preventing invalid UTF-8 replacement and model trim mismatches", () => {
  for (const text of ["\ud800", "\udfff", "ok\ud800x", "\u0000", "\b", "\f", "\u007f", "\u0085"]) {
    assert.equal(canonicalInferencePayload({ ...input(), instruction: text }), undefined);
    assert.equal(canonicalInferencePayload({ ...input(), mail: { ...input().mail, body: text } }), undefined);
  }
  for (const text of ["\t", "\r", "\n", "\u0085", "\ud800"]) assert.equal(canonicalInferencePayload({ ...input(), mail: { ...input().mail, from: text } }), undefined);
  for (const text of [" model", "model ", "\ufeffmodel", "model\ufeff", "\u0085model", "model\n"]) assert.equal(canonicalInferencePayload({ ...input(), model: text }), undefined);
  for (const instruction of ["", "\ufeffliteral\ufeff", " \t\r\n "]) assert.equal(JSON.parse(canonicalInferencePayload({ ...input(), instruction })!).system, instruction);
  for (const sanitizationVersion of ["", "v/1", "é", "v".repeat(65)]) assert.equal(canonicalInferencePayload({ ...input(), mail: { ...input().mail, sanitizationVersion } }), undefined);
});

test("accessors, symbols, inherited fields and hostile proxies return fixed failures without invoking data getters or leaking errors", async () => {
  let reads = 0;
  const value = input();
  Object.defineProperty(value.mail, "body", { enumerable: true, get() { reads++; throw new Error("SYNTHETIC_PRIVATE_ERROR\ncontrol"); } });
  const hidden = input(); Object.defineProperty(hidden, "instruction", { value: "private", enumerable: false });
  const symbol = input(); Object.defineProperty(symbol, Symbol("hidden"), { value: "private" });
  const hostile = new Proxy(input(), { ownKeys() { throw new Error("SYNTHETIC_PRIVATE_ERROR"); } });
  for (const candidate of [value, hidden, symbol, hostile, Object.create(input())]) {
    assert.equal(canonicalInferencePayload(candidate), undefined);
    assert.deepEqual(await prepareMailInference(binding(), candidate), { status: "denied", reason: "invalid_inference_payload" });
  }
  const host = binding(); Object.defineProperty(host, "scope", { enumerable: true, get() { reads++; throw new Error("SYNTHETIC_PRIVATE_ERROR"); } });
  assert.deepEqual(await prepareMailInference(host, input()), { status: "denied", reason: "invalid_inference_binding" });
  assert.deepEqual(await prepareMailInference(new Proxy(binding(), { ownKeys() { throw new Error("SYNTHETIC_PRIVATE_ERROR"); } }), input()), { status: "denied", reason: "preparation_unavailable" });
  assert.equal(reads, 0);
});
