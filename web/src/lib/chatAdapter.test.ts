import { describe, expect, it } from "vitest";
import {
  conversationIsRunning,
  isMessageInFlight,
  messageParts,
  parseTimeline,
  parseToolCalls,
  toThreadMessage,
  type AdapterContext,
  type AdapterMessage,
} from "./chatAdapter";

const identity = (hex: string) => ({ toHexString: () => hex });
const at = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * 1000n });

const HUMAN = "c0ffee01";
const OTHER_HUMAN = "c0ffee02";
const AI = "a1a1a1a1";

const ctx: AdapterContext = {
  myIdentityHex: HUMAN,
  aiIdentityHexes: new Set([AI]),
  displayNames: new Map([[AI, "Pear Assistant"]]),
};

function msg(overrides: Partial<AdapterMessage> = {}): AdapterMessage {
  return {
    id: 1n,
    sender: { tag: "User", value: identity(AI) },
    content: "",
    createdAt: at(1_700_000_000_000),
    status: { tag: "Complete" },
    ...overrides,
  };
}

describe("parsers", () => {
  it("tolerate malformed json", () => {
    expect(parseToolCalls("{not json")).toEqual([]);
    expect(parseTimeline('"str"')).toEqual([]);
    expect(parseToolCalls(JSON.stringify([{ nope: 1 }, { name: "web_search" }]))).toEqual([
      { name: "web_search" },
    ]);
  });
});

describe("messageParts", () => {
  it("orders timeline text and tools, resolving tool ids", () => {
    const m = msg({
      thinking: "let me look",
      toolCallsJson: JSON.stringify([
        { type: "tool_use", id: "t1", name: "web_search", input: '{"q":"pears"}', status: "done", output: "found 3" },
      ]),
      timelineJson: JSON.stringify([
        { t: "text", text: "Searching…" },
        { t: "tool", id: "t1" },
        { t: "text", text: "Done." },
      ]),
      content: "legacy content ignored when timeline present",
    });
    const parts = messageParts(m) as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "text", "tool-call", "text"]);
    expect(parts[2]).toMatchObject({ toolCallId: "t1", toolName: "web_search", args: { q: "pears" }, result: "found 3" });
  });

  it("falls back to tools-then-content without a timeline, keeping legacy result field", () => {
    const m = msg({
      toolCallsJson: JSON.stringify([{ name: "get_context", status: "error", result: "boom" }]),
      content: "Sorry about that.",
    });
    const parts = messageParts(m) as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
    expect(parts[0]).toMatchObject({ toolName: "get_context", result: "boom", isError: true });
    expect(parts[0].toolCallId).toBe("get_context-0");
  });

  it("appends component-tree and job data parts", () => {
    const m = msg({ content: "here you go", componentTreeJson: '{"v":"component_tree_v1"}', jobId: 42n });
    const parts = messageParts(m) as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(["text", "data-component-tree", "data-orcha-job"]);
    expect(parts[1]).toMatchObject({ data: { json: '{"v":"component_tree_v1"}', messageId: 1n } });
    expect(parts[2]).toMatchObject({ data: { jobId: 42n } });
  });
});

describe("toThreadMessage", () => {
  it("maps my messages to user and everyone else to assistant with metadata", () => {
    const mine = toThreadMessage(msg({ sender: { tag: "User", value: identity(HUMAN) }, content: "hi" }), ctx);
    expect(mine.role).toBe("user");
    const ai = toThreadMessage(msg({ content: "hello" }), ctx);
    expect(ai.role).toBe("assistant");
    expect((ai.metadata!.custom as { isAi: boolean; senderName?: string }).isAi).toBe(true);
    expect((ai.metadata!.custom as { senderName?: string }).senderName).toBe("Pear Assistant");
    const otherHuman = toThreadMessage(
      msg({ sender: { tag: "User", value: identity(OTHER_HUMAN) }, content: "yo" }),
      ctx
    );
    expect(otherHuman.role).toBe("assistant");
    expect((otherHuman.metadata!.custom as { isAi: boolean }).isAi).toBe(false);
    const system = toThreadMessage(msg({ sender: { tag: "System", value: "job_completion" }, content: "done" }), ctx);
    expect((system.metadata!.custom as { isSystem: boolean; systemReason?: string })).toMatchObject({
      isSystem: true,
      systemReason: "job_completion",
    });
  });

  it("maps status: streaming → running, error → incomplete, absent → complete", () => {
    expect(toThreadMessage(msg({ status: { tag: "Streaming" } }), ctx).status).toEqual({ type: "running" });
    expect(toThreadMessage(msg({ status: { tag: "Thinking" } }), ctx).status).toEqual({ type: "running" });
    expect(toThreadMessage(msg({ status: { tag: "Error" } }), ctx).status).toEqual({ type: "incomplete", reason: "error" });
    expect(toThreadMessage(msg({ status: undefined }), ctx).status).toEqual({ type: "complete", reason: "stop" });
    expect(
      toThreadMessage(msg({ sender: { tag: "User", value: identity(HUMAN) }, status: { tag: "Streaming" } }), ctx).status
    ).toBeUndefined();
  });

  it("converts spacetime micros to Date", () => {
    expect(toThreadMessage(msg(), ctx).createdAt).toEqual(new Date(1_700_000_000_000));
  });
});

describe("conversationIsRunning", () => {
  const human = msg({ sender: { tag: "User", value: identity(HUMAN) } });
  const aiDone = msg({ status: { tag: "Complete" } });
  const aiStreaming = msg({ status: { tag: "Streaming" } });

  it("true when a human turn awaits a reply", () => {
    expect(conversationIsRunning("Active", [aiDone, human], ctx)).toBe(true);
  });
  it("true while the AI message is non-terminal, false when terminal", () => {
    expect(conversationIsRunning("Active", [human, aiStreaming], ctx)).toBe(true);
    expect(conversationIsRunning("Active", [human, aiDone], ctx)).toBe(false);
    expect(isMessageInFlight(aiStreaming)).toBe(true);
  });
  it("false when closed or empty", () => {
    expect(conversationIsRunning("Closed", [human, aiStreaming], ctx)).toBe(false);
    expect(conversationIsRunning("Active", [], ctx)).toBe(false);
  });
});
