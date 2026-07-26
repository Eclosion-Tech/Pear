/**
 * Wake gating for AI-to-AI conversation (ticket 14264).
 *
 * The property under test is containment, not features. `isFromOtherUser` never
 * distinguished humans from AI users, so before mention-gating every AI
 * participant woke on every AI message — AI↔AI chatter was already possible and
 * already unbounded. These tests pin the brakes: an AI wakes another AI only
 * when explicitly addressed, and only while the exchange is inside the hop
 * budget, which any human message resets.
 *
 * Addressing is structured (`ConversationMessage.mentions`), resolved once at
 * send time by the module's `match_mentions` — the single implementation, tested
 * in `conversations/mod.rs`. These tests cover only how the worker *consumes* it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_AI_HOPS, aiHopBudget, aiHopDepth, shouldWakeFor } from "./conversation.js";

const HUMAN = "aa" + "0".repeat(62);
const AI_SELF = "bb" + "0".repeat(62);
const AI_OTHER = "cc" + "0".repeat(62);

function hexId(hex: string) {
  return { toHexString: () => hex };
}

let nextId = 1n;
function msg(
  senderHex: string | null,
  content: string,
  conversationId = 1n,
  mentions: string[] = [],
) {
  return {
    id: nextId++,
    conversationId,
    sender:
      senderHex === null
        ? { tag: "System", value: "job_completion" }
        : { tag: "User", value: hexId(senderHex) },
    content,
    createdAt: { microsSinceUnixEpoch: 0n },
    mentions: mentions.map(hexId),
  } as never;
}

/** Minimal ConnLike: the profile table and the message table. */
function fakeConn(
  messages: unknown[],
  aiHexes: string[] = [AI_SELF, AI_OTHER],
  settings: Array<{ key: string; valueJson: string }> = [],
) {
  return {
    db: {
      workspace_setting: { iter: () => settings },
      ai_user_profile: {
        iter: () =>
          aiHexes.map((hex) => ({
            identity: hexId(hex),
            displayName: hex === AI_SELF ? "Kira" : "Scribe",
          })),
      },
      conversation_message: { iter: () => messages },
    },
  } as never;
}

// ── hop depth ─────────────────────────────────────────────────────────────────

test("hop depth counts consecutive AI messages at the tail", () => {
  const conn = fakeConn([
    msg(HUMAN, "start"),
    msg(AI_SELF, "a"),
    msg(AI_OTHER, "b"),
    msg(AI_SELF, "c"),
  ]);
  assert.equal(aiHopDepth(conn, 1n, new Set([AI_SELF, AI_OTHER])), 3);
});

test("a human message resets the budget", () => {
  const conn = fakeConn([
    msg(AI_SELF, "a"),
    msg(AI_OTHER, "b"),
    msg(HUMAN, "hold on"),
    msg(AI_SELF, "ok"),
  ]);
  assert.equal(aiHopDepth(conn, 1n, new Set([AI_SELF, AI_OTHER])), 1);
});

test("hop depth is zero when a human spoke last", () => {
  const conn = fakeConn([msg(AI_SELF, "a"), msg(HUMAN, "stop")]);
  assert.equal(aiHopDepth(conn, 1n, new Set([AI_SELF, AI_OTHER])), 0);
});

test("hop depth is scoped to one conversation", () => {
  const conn = fakeConn([
    msg(AI_SELF, "a", 1n),
    msg(AI_OTHER, "b", 1n),
    msg(AI_SELF, "elsewhere", 2n),
  ]);
  assert.equal(aiHopDepth(conn, 2n, new Set([AI_SELF, AI_OTHER])), 1);
});

// ── wake decisions ────────────────────────────────────────────────────────────

test("a human message wakes without any mention (unchanged behaviour)", () => {
  const m = msg(HUMAN, "what do you think?");
  assert.equal(shouldWakeFor(fakeConn([m]), m, AI_SELF), true);
});

test("an AI message does NOT wake another AI unless addressed", () => {
  const m = msg(AI_OTHER, "I'll take a look at the schema");
  assert.equal(shouldWakeFor(fakeConn([m]), m, AI_SELF), false);
});

test("an AI message addressing us does wake", () => {
  const m = msg(AI_OTHER, "@Kira confirm the ACL?", 1n, [AI_SELF]);
  assert.equal(shouldWakeFor(fakeConn([msg(HUMAN, "start"), m]), m, AI_SELF), true);
});

test("an AI message addressing someone ELSE does not wake us", () => {
  const m = msg(AI_OTHER, "@Scribe can you check?", 1n, [AI_OTHER]);
  assert.equal(shouldWakeFor(fakeConn([msg(HUMAN, "start"), m]), m, AI_SELF), false);
});

test("fail-closed: @-text in content with no structured mentions does not wake", () => {
  // A message that *looks* addressed but was not sent through the addressing
  // path. Silently not waking is recoverable; silently waking forever is not.
  const m = msg(AI_OTHER, "@Kira are you there?");
  assert.equal(shouldWakeFor(fakeConn([msg(HUMAN, "go"), m]), m, AI_SELF), false);
});

test("our own message never wakes us, even self-addressed", () => {
  const m = msg(AI_SELF, "@Kira note to self", 1n, [AI_SELF]);
  assert.equal(shouldWakeFor(fakeConn([m]), m, AI_SELF), false);
});

test("system triggers still wake regardless of addressing", () => {
  const m = msg(null, "job finished");
  assert.equal(shouldWakeFor(fakeConn([m]), m, AI_SELF), true);
});

test("the hop budget stops a runaway AI-to-AI exchange", () => {
  const history: unknown[] = [];
  for (let i = 0; i < MAX_AI_HOPS; i++) {
    history.push(msg(i % 2 === 0 ? AI_OTHER : AI_SELF, "turn", 1n, [AI_SELF]));
  }
  const trigger = msg(AI_OTHER, "one more?", 1n, [AI_SELF]);
  history.push(trigger);

  assert.equal(shouldWakeFor(fakeConn(history), trigger, AI_SELF), false);
});

test("a human stepping in re-enables waking after the budget is spent", () => {
  const history: unknown[] = [];
  for (let i = 0; i < MAX_AI_HOPS; i++) {
    history.push(msg(i % 2 === 0 ? AI_OTHER : AI_SELF, "turn", 1n, [AI_SELF]));
  }
  history.push(msg(HUMAN, "carry on"));
  const trigger = msg(AI_OTHER, "resuming", 1n, [AI_SELF]);
  history.push(trigger);

  assert.equal(shouldWakeFor(fakeConn(history), trigger, AI_SELF), true);
});

// ── configurable hop budget ───────────────────────────────────────────────────

test("falls back to the default budget when the workspace has not set one", () => {
  assert.equal(aiHopBudget(fakeConn([])), MAX_AI_HOPS);
});

test("uses the workspace setting when present", () => {
  const conn = fakeConn([], [AI_SELF, AI_OTHER], [{ key: "ai.max_hops", valueJson: "2" }]);
  assert.equal(aiHopBudget(conn), 2);
});

test("a malformed or zero setting falls back rather than removing the brake", () => {
  for (const bad of ["", "abc", "0", "-3"]) {
    const conn = fakeConn([], [AI_SELF, AI_OTHER], [{ key: "ai.max_hops", valueJson: bad }]);
    assert.equal(aiHopBudget(conn), MAX_AI_HOPS);
  }
});

test("a lowered budget actually stops waking sooner", () => {
  const history: unknown[] = [
    msg(AI_OTHER, "one", 1n, [AI_SELF]),
    msg(AI_SELF, "two", 1n, [AI_OTHER]),
  ];
  const trigger = msg(AI_OTHER, "three", 1n, [AI_SELF]);
  history.push(trigger);

  // Default budget still allows it; a budget of 2 does not.
  assert.equal(shouldWakeFor(fakeConn(history), trigger, AI_SELF), true);
  const tight = fakeConn(history, [AI_SELF, AI_OTHER], [{ key: "ai.max_hops", valueJson: "2" }]);
  assert.equal(shouldWakeFor(tight, trigger, AI_SELF), false);
});
