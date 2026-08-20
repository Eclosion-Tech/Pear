import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_READ_BYTES,
  createWorkspaceFileReader,
  extractWorkspaceFileText,
  type FetchedObject,
} from "./workspace-files.js";
import { renderAttachedFile, ATTACHED_FILE_INLINE_CHARS } from "./attachments.js";

const enc = (s: string) => new TextEncoder().encode(s);
const obj = (bytes: Uint8Array, contentType?: string): FetchedObject => ({
  bytes,
  contentType,
  byteSize: bytes.byteLength,
});

// ── extraction ────────────────────────────────────────────────────────────────

test("utf8 text-like files decode to text", async () => {
  const f = await extractWorkspaceFileText(obj(enc("a,b\n1,2\n"), "text/csv"), "k");
  assert.equal(f.extractor, "utf8");
  assert.equal(f.text, "a,b\n1,2\n");
  assert.equal(f.byteSize, 8);
});

test("extension decides when the MIME type is generic", async () => {
  const f = await extractWorkspaceFileText(
    obj(enc("{\"ok\":true}"), "application/octet-stream"),
    "k",
    "config.json",
  );
  assert.equal(f.extractor, "utf8");
  assert.equal(f.text, "{\"ok\":true}");
});

test("declared-text files with binary bytes are not decoded", async () => {
  const f = await extractWorkspaceFileText(obj(new Uint8Array([0x50, 0x4b, 0, 0, 1, 2]), "text/plain"), "k");
  assert.equal(f.text, undefined);
  assert.match(f.note ?? "", /not UTF-8/);
});

test("untyped uploads are sniffed; declared binary types are not", async () => {
  const sniffed = await extractWorkspaceFileText(obj(enc("plain words"), "application/octet-stream"), "k", "notes.weird");
  assert.equal(sniffed.text, "plain words");
  const image = await extractWorkspaceFileText(obj(enc("not really png"), "image/png"), "k", "x.png");
  assert.equal(image.text, undefined);
  assert.equal(image.extractor, undefined);
});

test("objects over the read cap return metadata only", async () => {
  const f = await extractWorkspaceFileText(
    { bytes: new Uint8Array(0), contentType: "text/plain", byteSize: MAX_READ_BYTES + 1 },
    "k",
  );
  assert.equal(f.text, undefined);
  assert.match(f.note ?? "", /capped/);
});

test("pdf extraction runs through unpdf", async () => {
  // Minimal single-page PDF with one text object. pdf.js tolerates the
  // hand-rolled xref offsets because it rebuilds the table on mismatch.
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    "4 0 obj << /Length 44 >> stream",
    "BT /F1 24 Tf 20 100 Td (Hello Pear) Tj ET",
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "0000000260 00000 n ",
    "0000000350 00000 n ",
    "trailer << /Size 6 /Root 1 0 R >>",
    "startxref",
    "420",
    "%%EOF",
  ].join("\n");
  const f = await extractWorkspaceFileText(obj(enc(pdf), "application/pdf"), "k", "hello.pdf");
  assert.equal(f.extractor, "pdf", f.note);
  assert.match(f.text ?? "", /Hello Pear/);
});

// ── key resolution ────────────────────────────────────────────────────────────

test("bare object ids resolve inside the workspace prefix; foreign full keys are not found", async () => {
  const fetched: string[] = [];
  const reader = createWorkspaceFileReader({
    dbName: "acme",
    resolveWorkspaceId: async () => "ws-123",
    fetchObject: async (key) => {
      fetched.push(key);
      return obj(enc("hi"), "text/plain");
    },
  })!;
  await reader.read("11111111-2222-3333-4444-555555555555");
  assert.ok(await reader.read("workspaces/ws-123/deadbeef"));
  assert.equal(await reader.read("workspaces/ws-other/deadbeef"), null);
  assert.equal(await reader.read("../../etc/passwd"), null);
  assert.deepEqual(fetched, [
    "workspaces/ws-123/11111111-2222-3333-4444-555555555555",
    "workspaces/ws-123/deadbeef",
  ]);
});

test("without a workspace id (standalone) keys pass through unchanged", async () => {
  const fetched: string[] = [];
  const reader = createWorkspaceFileReader({
    dbName: "local",
    resolveWorkspaceId: async () => null,
    fetchObject: async (key) => {
      fetched.push(key);
      return obj(enc("hi"), "text/plain");
    },
  })!;
  await reader.read("bare-id");
  await reader.read("some/full/key");
  assert.deepEqual(fetched, ["bare-id", "some/full/key"]);
});

test("missing objects resolve to null; the storage key is echoed as supplied", async () => {
  const reader = createWorkspaceFileReader({
    dbName: "acme",
    resolveWorkspaceId: async () => null,
    fetchObject: async (key) => (key === "present" ? obj(enc("x"), "text/plain") : null),
  })!;
  assert.equal(await reader.read("absent"), null);
  const f = await reader.read("present");
  assert.equal(f?.storageKey, "present");
});

test("no S3 and no override → no reader", () => {
  const prev = { e: process.env.S3_ENDPOINT, a: process.env.S3_ACCESS_KEY, s: process.env.S3_SECRET_KEY };
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
  try {
    // `isS3Configured` reads env at module load, so this only asserts the
    // contract when the test process itself has no S3 config.
    if (!prev.e) assert.equal(createWorkspaceFileReader({ dbName: "x" }), null);
  } finally {
    if (prev.e) process.env.S3_ENDPOINT = prev.e;
    if (prev.a) process.env.S3_ACCESS_KEY = prev.a;
    if (prev.s) process.env.S3_SECRET_KEY = prev.s;
  }
});

// ── chat attachment rendering ─────────────────────────────────────────────────

test("File attachments render as attached_file context with the storage key", async () => {
  const reader = createWorkspaceFileReader({
    dbName: "acme",
    resolveWorkspaceId: async () => "ws",
    fetchObject: async () => obj(enc("col1,col2\n1,2"), "text/csv"),
  })!;
  const out = await renderAttachedFile(reader, "workspaces/ws/abc", "data.csv", "text/csv", "[t]");
  assert.match(out, /^<attached_file name="data.csv" type="text\/csv" size_bytes="13" storage_key="workspaces\/ws\/abc">/);
  assert.match(out, /col1,col2/);
  assert.match(out, /<\/attached_file>$/);
});

test("long File attachments are capped with a read_file pointer", async () => {
  const big = "y".repeat(ATTACHED_FILE_INLINE_CHARS + 500);
  const reader = createWorkspaceFileReader({
    dbName: "acme",
    resolveWorkspaceId: async () => "ws",
    fetchObject: async () => obj(enc(big), "text/plain"),
  })!;
  const out = await renderAttachedFile(reader, "workspaces/ws/abc", "big.txt", "text/plain", "[t]");
  assert.match(out, /500 more characters/);
  assert.match(out, /read_file\(storage_key="workspaces\/ws\/abc", offset=40000\)/);
});

test("binary, missing, and reader-less File attachments degrade to notes", async () => {
  const binReader = createWorkspaceFileReader({
    dbName: "acme",
    resolveWorkspaceId: async () => "ws",
    fetchObject: async () => obj(new Uint8Array([0x50, 0x4b, 3, 4]), "application/zip"),
  })!;
  assert.match(
    await renderAttachedFile(binReader, "workspaces/ws/z", "a.zip", "application/zip", "[t]"),
    /no text extractor/,
  );
  const missing = createWorkspaceFileReader({
    dbName: "acme",
    resolveWorkspaceId: async () => "ws",
    fetchObject: async () => null,
  })!;
  assert.match(await renderAttachedFile(missing, "workspaces/ws/z", "a.txt", undefined, "[t]"), /object missing/);
  assert.match(
    await renderAttachedFile(undefined, "workspaces/ws/z", "a.txt", undefined, "[t]"),
    /no blob storage configured/,
  );
});
