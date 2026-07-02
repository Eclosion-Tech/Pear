import { test } from "node:test";
import assert from "node:assert/strict";

import { reconstructSessionTail } from "./session-reconstruct.js";
import type { StoredToolCall } from "./tool-call-record.js";
import type { ToolResultBlock } from "./providers.js";
import type { ConnLike } from "./tools.js";

// ── Minimal fake conn ──────────────────────────────────────────────────────────

type Row = {
  id: bigint;
  conversationId: bigint;
  sender: { tag: string; value: unknown };
  content: string;
  toolCallsJson: string | undefined;
  status: { tag: string };
};

const ASSISTANT = "aaaaaaaa";
const HUMAN = "bbbbbbbb";

function user(value: string): Row["sender"] {
  return { tag: "User", value };
}

function makeConn(rows: Row[]): ConnLike {
  return {
    db: { conversation_message: { iter: () => rows[Symbol.iterator]() } },
  } as unknown as ConnLike;
}

let nextId = 1n;
function row(partial: Partial<Row> & { sender: Row["sender"] }): Row {
  return {
    id: nextId++,
    conversationId: 1n,
    content: "",
    toolCallsJson: undefined,
    status: { tag: "Complete" },
    ...partial,
  };
}

function storedCall(over: Partial<StoredToolCall>): StoredToolCall {
  return {
    type: "tool_use",
    id: "toolu_1",
    name: "create_page",
    input: JSON.stringify({ title: "X" }),
    status: "done",
    ...over,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("unified tool-call records rebuild paired tool_use + tool_result (assessment #1)", () => {
  const call = storedCall({
    id: "toolu_42",
    name: "create_page",
    input: JSON.stringify({ title: "Poem" }),
    output: JSON.stringify({ ok: true, page_id: 9 }),
  });
  const conn = makeConn([
    row({ sender: user(HUMAN), content: "make a page" }),
    row({
      sender: user(ASSISTANT),
      content: "On it.",
      toolCallsJson: JSON.stringify([call]),
    }),
  ]);

  const msgs = reconstructSessionTail(conn, 1n, ASSISTANT);

  // user turn, assistant(text+tool_use), user(tool_result)
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0], { role: "user", content: "make a page" });

  const asst = msgs[1];
  assert.equal(asst.role, "assistant");
  assert.deepEqual(asst.content, [
    { type: "text", text: "On it." },
    { type: "tool_use", id: "toolu_42", name: "create_page", input: { title: "Poem" } },
  ]);

  const toolRes = msgs[2];
  assert.equal(toolRes.role, "user");
  assert.deepEqual(toolRes.content, [
    { type: "tool_result", tool_use_id: "toolu_42", content: JSON.stringify({ ok: true, page_id: 9 }) },
  ]);
});

test("every tool_use is answered, even when output is missing (valid API pairing)", () => {
  const call = storedCall({ id: "toolu_x", status: "executing", output: undefined });
  const conn = makeConn([
    row({ sender: user(ASSISTANT), content: "", toolCallsJson: JSON.stringify([call]) }),
  ]);

  const msgs = reconstructSessionTail(conn, 1n, ASSISTANT);
  const toolUses = msgs
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => typeof b === "object" && b.type === "tool_use");
  const toolResults = msgs
    .filter((m) => m.role === "user")
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as ToolResultBlock[]) : []));

  assert.equal(toolUses.length, 1);
  assert.equal(toolResults.length, 1);
  assert.deepEqual(toolResults[0], {
    type: "tool_result",
    tool_use_id: "toolu_x",
    content: "(no result recorded)",
  });
});

test("legacy {name,status,result} records drop tool blocks but keep assistant text", () => {
  const legacy = [{ name: "update_page_content", status: "done", result: '{"ok":true}' }];
  const conn = makeConn([
    row({ sender: user(ASSISTANT), content: "Updated it.", toolCallsJson: JSON.stringify(legacy) }),
  ]);

  const msgs = reconstructSessionTail(conn, 1n, ASSISTANT);
  // No id to pair, so just the assistant text — and crucially no orphan tool_result.
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], { role: "assistant", content: [{ type: "text", text: "Updated it." }] });
});

test("malformed toolCallsJson falls back to text-only, no throw", () => {
  const conn = makeConn([
    row({ sender: user(ASSISTANT), content: "hi", toolCallsJson: "{not json" }),
  ]);
  const msgs = reconstructSessionTail(conn, 1n, ASSISTANT);
  assert.deepEqual(msgs, [{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
});

test("resolved attachments inject images and context text into human turns", () => {
  nextId = 1n; // deterministic ids so the attachment map keys line up
  const conn = makeConn([
    row({ sender: user(HUMAN), content: "what's in this image?" }),
    row({ sender: user(HUMAN), content: "" }), // attachment-only message
  ]);
  const img = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
  };
  const attachments = new Map([
    [1n, { images: [img], contextText: "" }],
    [2n, { images: [], contextText: "<attached_context>page snapshot</attached_context>" }],
  ]);

  const msgs = reconstructSessionTail(conn, 1n, ASSISTANT, attachments);

  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], {
    role: "user",
    content: [img, { type: "text", text: "what's in this image?" }],
  });
  // Context-only message survives despite empty content.
  assert.deepEqual(msgs[1], {
    role: "user",
    content: "<attached_context>page snapshot</attached_context>",
  });
});

test("compaction floor discards messages at or before the most recent floor", () => {
  const conn = makeConn([
    row({ sender: user(HUMAN), content: "old" }),
    row({ sender: { tag: "System", value: "compaction" }, content: "summary" }),
    row({ sender: user(HUMAN), content: "new" }),
  ]);
  const msgs = reconstructSessionTail(conn, 1n, ASSISTANT);
  assert.deepEqual(msgs, [{ role: "user", content: "new" }]);
});

// ── System triggers (job completion / routine / feedback) ───────────────────────

function system(tag: string): Row["sender"] {
  return { tag: "System", value: tag };
}

for (const tag of ["job_completion", "routine", "feedback", "access_resolution"]) {
  test(`System("${tag}") trigger reconstructs as a user-role note`, () => {
    const conn = makeConn([
      row({ sender: user(HUMAN), content: "start" }),
      row({ sender: user(ASSISTANT), content: "ok" }),
      row({ sender: system(tag), content: `trigger:${tag}` }),
    ]);
    const msgs = reconstructSessionTail(conn, 1n, ASSISTANT);
    const last = msgs[msgs.length - 1];
    assert.deepEqual(last, { role: "user", content: `trigger:${tag}` });
  });
}

test("unknown System tag is skipped in reconstruction", () => {
  const conn = makeConn([
    row({ sender: user(HUMAN), content: "hi" }),
    row({ sender: system("something_else"), content: "ignored" }),
  ]);
  const msgs = reconstructSessionTail(conn, 1n, ASSISTANT);
  assert.ok(!msgs.some((m) => m.content === "ignored"));
});
