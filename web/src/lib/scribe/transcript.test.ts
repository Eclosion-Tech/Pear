import { describe, expect, it } from "vitest";
import { eventMarkdown, headerMarkdown, userMarkdown } from "./transcript";

describe("transcript rendering", () => {
  it("renders assistant text verbatim", () => {
    expect(
      eventMarkdown({ kind: "assistantMessage", text: "  Stored it.\n" }),
    ).toEqual(["Stored it."]);
    expect(eventMarkdown({ kind: "assistantMessage", text: "   " })).toEqual([]);
  });

  it("renders tool use with inlined args", () => {
    expect(
      eventMarkdown({
        kind: "toolUse",
        name: "mcp__pear__remember",
        input: { title: "note", content: "hi" },
      }),
    ).toEqual(['- 🔧 mcp__pear__remember `{"title":"note","content":"hi"}`']);
  });

  it("truncates oversized tool payloads and strips backticks", () => {
    const [line] = eventMarkdown({
      kind: "toolResult",
      content: { text: "`x`".repeat(400) },
    });
    expect(line.length).toBeLessThan(340);
    expect(line.endsWith("…`")).toBe(true);
    // Only the wrapping code-span backticks survive.
    expect(line.slice(5, -1)).not.toContain("`");
  });

  it("renders turn completion with cost", () => {
    expect(
      eventMarkdown({ kind: "turnCompleted", success: true, costUsd: 0.1234 }),
    ).toEqual(["Turn completed · $0.1234"]);
    expect(
      eventMarkdown({ kind: "turnCompleted", success: false, costUsd: null }),
    ).toEqual(["Turn failed"]);
  });

  it("skips protocol noise", () => {
    expect(eventMarkdown({ kind: "started", sessionId: "s" })).toEqual([]);
    expect(eventMarkdown({ kind: "raw", line: {} })).toEqual([]);
    expect(eventMarkdown({ kind: "stderr", line: "npm warn" })).toEqual([]);
  });

  it("renders exit and user turns", () => {
    expect(eventMarkdown({ kind: "exited", code: 0 })).toEqual([
      "Session exited (code 0)",
    ]);
    expect(userMarkdown(" do the thing ")).toEqual(["**User:** do the thing"]);
  });

  it("renders the session header", () => {
    expect(
      headerMarkdown({
        engine: "codex",
        sessionId: "abc",
        cwd: "/repo/proj",
        startedAtIso: "2026-07-05T01:02:03.000Z",
      }),
    ).toEqual([
      "Engine: codex · Working dir: /repo/proj",
      "Session abc · started 2026-07-05T01:02:03.000Z",
    ]);
  });
});
