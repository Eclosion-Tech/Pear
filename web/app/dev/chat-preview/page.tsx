"use client";

/**
 * Fixture-driven preview of the @eclosion-tech/chat renderer with Pear-shaped
 * rows — no SpacetimeDB connection required. Dev flag only.
 */
import "@eclosion-tech/chat/styles.css";

import { notFound } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import {
  Chat,
  Thread,
  makeAssistantDataUI,
  useExternalRuntime,
  type AppendMessage,
} from "@eclosion-tech/chat";

import {
  conversationIsRunning,
  toThreadMessage,
  type AdapterContext,
  type AdapterMessage,
} from "@/src/lib/chatAdapter";

const HUMAN = "c0ffee01";
const AI = "a1a1a1a1";
const identity = (hex: string) => ({ toHexString: () => hex });
const at = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * 1000n });

const ctx: AdapterContext = {
  myIdentityHex: HUMAN,
  aiIdentityHexes: new Set([AI]),
  displayNames: new Map([[AI, "Pear Assistant"]]),
};

const FIXTURES: AdapterMessage[] = [
  {
    id: 1n,
    sender: { tag: "User", value: identity(HUMAN) },
    content: "Can you research pear cultivars and add a summary block?",
    createdAt: at(1_756_000_000_000),
    status: { tag: "Complete" },
  },
  {
    id: 2n,
    sender: { tag: "User", value: identity(AI) },
    content: "",
    createdAt: at(1_756_000_060_000),
    status: { tag: "Complete" },
    thinking: "The user wants cultivar research. I should search first, then write.",
    toolCallsJson: JSON.stringify([
      {
        type: "tool_use",
        id: "t1",
        name: "web_search",
        input: '{"query":"pear cultivars comparison"}',
        status: "done",
        output: "Top results: Anjou, Bartlett, Bosc, Comice…",
      },
    ]),
    timelineJson: JSON.stringify([
      { t: "text", text: "Let me look up current cultivar data." },
      { t: "tool", id: "t1" },
      { t: "text", text: "**Anjou** keeps longest; **Comice** is the dessert pick. I've added a summary block below." },
    ]),
    componentTreeJson: '{"v":"component_tree_v1","root_id":1,"nodes":[]}',
  },
  {
    id: 3n,
    sender: { tag: "User", value: identity(AI) },
    content: "",
    createdAt: at(1_756_000_120_000),
    status: { tag: "Error" },
    toolCallsJson: JSON.stringify([{ name: "fetch_url", status: "error", result: "403 Forbidden" }]),
  },
];

const ComponentTreeStub = makeAssistantDataUI<{ json: string; messageId: bigint }>({
  name: "component-tree",
  render: ({ data }) => (
    <div className="my-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
      generated UI block (component_tree_v1, message {data.messageId.toString()}) — rendered by
      StaticComponentTree in the app
    </div>
  ),
});

const REPLY =
  "This reply streams by mutating the fixture row, exactly like the worker updates conversation_message.";

export default function ChatPreviewPage() {
  if (process.env.NEXT_PUBLIC_PEAR_ECLOSION_CHAT !== "1" && process.env.NODE_ENV === "production") {
    notFound();
  }
  const [rows, setRows] = useState<AdapterMessage[]>(FIXTURES);
  const nextId = useRef(10n);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    if (!text) return;
    const userId = nextId.current++;
    const aiId = nextId.current++;
    const now = Date.now();
    setRows((prev) => [
      ...prev,
      { id: userId, sender: { tag: "User", value: identity(HUMAN) }, content: text, createdAt: at(now), status: { tag: "Complete" } },
      { id: aiId, sender: { tag: "User", value: identity(AI) }, content: "", createdAt: at(now + 1), status: { tag: "Thinking" } },
    ]);
    const words = REPLY.split(" ");
    let i = 0;
    timer.current = setInterval(() => {
      i += 2;
      const done = i >= words.length;
      setRows((prev) =>
        prev.map((r) =>
          r.id === aiId
            ? { ...r, content: words.slice(0, i).join(" "), status: { tag: done ? "Complete" : "Streaming" } }
            : r
        )
      );
      if (done && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    }, 120);
  }, []);

  const isRunning = conversationIsRunning("Active", rows, ctx);
  const runtime = useExternalRuntime<AdapterMessage>({
    messages: rows,
    isRunning,
    convertMessage: (m) => toThreadMessage(m, ctx),
    onNew,
  });

  return (
    <main className="mx-auto h-dvh max-w-3xl">
      <Chat runtime={runtime} className="h-full border-x border-neutral-200 dark:border-neutral-800">
        <ComponentTreeStub />
        <Thread />
      </Chat>
    </main>
  );
}
