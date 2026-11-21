import { describe, expect, it } from "vitest";
import { newestMessageId, recentTurns, settleRequests, voiceRequestMessage, type PendingRequest, type ThreadMessage } from "./thread";

const ME = "aa";
const AI = "bb";
const OTHER = "cc";
const CONVERSATION = 7n;

function message(id: bigint, from: string | null, content: string, status = "Complete", conversationId = CONVERSATION): ThreadMessage {
  return {
    id,
    conversationId,
    sender: from === null ? { tag: "System", value: "routine" } : { tag: "User", value: { toHexString: () => from } },
    content,
    status: { tag: status },
  };
}

describe("what a call knows of the written conversation", () => {
  it("gives the latest finished messages, oldest first, with the AI user as the assistant", () => {
    const messages = [
      message(5n, AI, "Yes, on Friday."),
      message(4n, ME, "Did the invoice go out?"),
      message(6n, null, "wake up"),
      message(7n, AI, "Still writing", "Streaming"),
      message(8n, ME, "   "),
      message(9n, OTHER, "Thanks both."),
      message(3n, ME, "Elsewhere", "Complete", 99n),
    ];
    expect(recentTurns(messages, { conversationId: CONVERSATION, aiIdentityHex: AI })).toEqual([
      { role: "user", text: "Did the invoice go out?" },
      { role: "assistant", text: "Yes, on Friday." },
      { role: "user", text: "Thanks both." },
    ]);
    expect(recentTurns(messages, { conversationId: CONVERSATION, aiIdentityHex: AI, max: 1 })).toEqual([{ role: "user", text: "Thanks both." }]);
    expect(newestMessageId(messages, CONVERSATION)).toBe(9n);
    expect(newestMessageId(messages, 123n)).toBe(0n);
  });
});

describe("a request from a call and its answer in the conversation", () => {
  const ask = voiceRequestMessage("Check whether the reply was sent.");
  const settle = (pending: PendingRequest[], messages: ThreadMessage[], claimed: bigint[] = []) =>
    settleRequests({ pending, messages, conversationId: CONVERSATION, callerIdentityHex: ME, aiIdentityHex: AI, claimed: new Set(claimed) });

  it("words the request as a message the AI user can act on and answer briefly", () => {
    expect(ask).toMatch(/^Voice call request: Check whether the reply was sent\.\n\n/);
    expect(ask).toContain("two or three short sentences");
  });

  it("waits until the request has been written, then until the answer is finished", () => {
    const pending: PendingRequest[] = [{ id: "q1", message: ask, afterId: 10n }];
    expect(settle(pending, [message(10n, AI, "Earlier reply.")])).toEqual({ rows: [], outcomes: [] });

    const written = [message(10n, AI, "Earlier reply."), message(11n, ME, ask)];
    expect(settle(pending, written)).toEqual({ rows: [{ id: "q1", rowId: 11n }], outcomes: [] });

    const answering = [...written, message(12n, AI, "Looking", "ToolUse")];
    expect(settle([{ ...pending[0]!, rowId: 11n }], answering).outcomes).toEqual([]);

    const answered = [...written, message(12n, AI, " It went out on Tuesday. ")];
    expect(settle([{ ...pending[0]!, rowId: 11n }], answered).outcomes).toEqual([{ id: "q1", status: "answered", text: "It went out on Tuesday.", replyId: 12n }]);
  });

  it("does not mistake an identical request from an earlier call for this one", () => {
    const messages = [message(3n, ME, ask), message(4n, AI, "Old answer."), message(11n, ME, ask), message(12n, AI, "New answer.")];
    const result = settle([{ id: "q1", message: ask, afterId: 10n }], messages, [4n]);
    expect(result.rows).toEqual([{ id: "q1", rowId: 11n }]);
    expect(result.outcomes).toEqual([{ id: "q1", status: "answered", text: "New answer.", replyId: 12n }]);
  });

  it("ignores messages from other people, system messages, and other conversations", () => {
    const messages = [
      message(11n, ME, ask),
      message(12n, OTHER, "Not the AI user."),
      message(13n, null, "job done"),
      message(14n, AI, "Wrong room.", "Complete", 99n),
      message(15n, AI, "The right answer."),
    ];
    expect(settle([{ id: "q1", message: ask, afterId: 10n }], messages).outcomes).toEqual([{ id: "q1", status: "answered", text: "The right answer.", replyId: 15n }]);
  });

  it("hands two requests their own answers, in order, and holds the second while the first is still being written", () => {
    const second = voiceRequestMessage("Move the demo to Friday.");
    const pending: PendingRequest[] = [
      { id: "q1", message: ask, afterId: 10n },
      { id: "q2", message: second, afterId: 10n },
    ];
    const asked = [message(11n, ME, ask), message(12n, ME, second)];
    expect(settle(pending, [...asked, message(13n, AI, "Working", "Thinking")]).outcomes).toEqual([]);

    const first = settle(pending, [...asked, message(13n, AI, "Sent on Tuesday.")]);
    expect(first.outcomes).toEqual([{ id: "q1", status: "answered", text: "Sent on Tuesday.", replyId: 13n }]);

    // The first answer is taken; the second request gets the next one.
    const later = settle([{ ...pending[1]!, rowId: 12n }], [...asked, message(13n, AI, "Sent on Tuesday."), message(14n, AI, "Moved.")], [13n]);
    expect(later.outcomes).toEqual([{ id: "q2", status: "answered", text: "Moved.", replyId: 14n }]);

    // Both answers present at once: each request still gets its own.
    const both = settle(pending, [...asked, message(13n, AI, "Sent on Tuesday."), message(14n, AI, "Moved.")]);
    expect(both.outcomes.map((outcome) => [outcome.id, outcome.text])).toEqual([["q1", "Sent on Tuesday."], ["q2", "Moved."]]);
  });

  it("reports an answer that failed, and shortens a very long one", () => {
    const failed = settle([{ id: "q1", message: ask, afterId: 10n }], [message(11n, ME, ask), message(12n, AI, "boom", "Error")]);
    expect(failed.outcomes).toEqual([{ id: "q1", status: "failed", text: "it ran into an error; the details are in the chat", replyId: 12n }]);

    const long = settle([{ id: "q1", message: ask, afterId: 10n }], [message(11n, ME, ask), message(12n, AI, "x".repeat(4000))]);
    expect(long.outcomes[0]!.text).toHaveLength(1501);
    expect(long.outcomes[0]!.text.endsWith("…")).toBe(true);
  });
});
