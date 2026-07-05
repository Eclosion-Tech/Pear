"use client";

/**
 * Live view of one engine session: renders the normalized event stream from
 * the desktop process manager and provides follow-up input + cancel.
 *
 * Rendering is deliberately engine-generic: adapters emit normalized events
 * for text, tool use, tool results, and turn completion. `raw` remains in the
 * stream for replay/scribe work and as a temporary fallback for old adapters.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sessionCancel, sessionSend, type EngineEvent, type SessionMeta } from "@/src/lib/tauri";

interface FeedItem {
  id: number;
  variant: "text" | "tool" | "result" | "meta" | "stderr";
  text: string;
}

function summarizeUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Fallback renderer for raw lines the adapter's normalized events don't
 * already cover. assistant/user/result lines are handled by the normalized
 * `assistantMessage`/`toolUse`/`toolResult`/`turnCompleted` events (the reader
 * emits both), so this only surfaces lifecycle lines like session init —
 * rendering them here too would double up the feed.
 */
function itemsFromLine(line: Record<string, unknown>, nextId: () => number): FeedItem[] {
  const type = line.type as string | undefined;
  if (type === "system" && line.subtype === "init") {
    return [{ id: nextId(), variant: "meta", text: "session initialized" }];
  }
  return [];
}

export function SessionView({
  session,
  events,
  onClose,
}: {
  session: SessionMeta;
  events: EngineEvent[];
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  const items: FeedItem[] = [];
  let exited: number | null | undefined;
  let transcriptPageId = session.transcriptPageId;
  for (const event of events) {
    if (event.kind === "transcriptPage") {
      transcriptPageId = event.pageId;
      continue;
    }
    if (event.kind === "assistantMessage") {
      items.push({ id: nextId(), variant: "text", text: event.text });
    } else if (event.kind === "toolUse") {
      const input = summarizeUnknown(event.input);
      items.push({
        id: nextId(),
        variant: "tool",
        text: input ? `⚒ ${event.name} ${input}` : `⚒ ${event.name}`,
      });
    } else if (event.kind === "toolResult") {
      const content = summarizeUnknown(event.content);
      items.push({
        id: nextId(),
        variant: "meta",
        text: content ? `tool result ${content}` : "tool result",
      });
    } else if (event.kind === "turnCompleted") {
      const summary = [
        event.success ? "✓ turn complete" : "✗ turn failed",
        event.costUsd != null ? `$${event.costUsd.toFixed(4)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      items.push({ id: nextId(), variant: "result", text: summary });
    } else if (event.kind === "raw") items.push(...itemsFromLine(event.line, nextId));
    else if (event.kind === "stderr") items.push({ id: nextId(), variant: "stderr", text: event.line });
    else if (event.kind === "error") items.push({ id: nextId(), variant: "stderr", text: event.message });
    else if (event.kind === "exited") exited = event.code;
  }
  idRef.current = 0; // deterministic ids per render

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    setError(null);
    try {
      await sessionSend(session.id, text);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-2" style={{ maxHeight: "60vh" }}>
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-neutral-900 dark:text-white">{session.title}</h4>
          <p className="text-[11px] text-neutral-500">{session.engine} · {session.cwd}</p>
        </div>
        <div className="flex gap-2">
          {transcriptPageId != null && (
            <button
              type="button"
              onClick={() => router.push(`/workspace/${transcriptPageId}`)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 text-xs px-2 py-1"
              title="Open the live transcript page"
            >
              Transcript ↗
            </button>
          )}
          {exited === undefined && (
            <button
              type="button"
              onClick={() => void sessionCancel(session.id).catch(() => undefined)}
              className="rounded-md border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 text-xs px-2 py-1"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-xs px-2 py-1"
          >
            Back
          </button>
        </div>
      </div>

      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-2 space-y-1.5 min-h-40"
      >
        {items.length === 0 && <p className="text-xs text-neutral-500">Waiting for the engine…</p>}
        {items.map((item) => (
          <div
            key={item.id}
            className={
              item.variant === "text"
                ? "text-xs whitespace-pre-wrap text-neutral-900 dark:text-neutral-100"
                : item.variant === "tool"
                  ? "text-[11px] font-mono text-blue-600 dark:text-blue-400"
                  : item.variant === "result"
                    ? "text-[11px] text-green-700 dark:text-green-400"
                    : item.variant === "stderr"
                      ? "text-[11px] font-mono text-red-600 dark:text-red-400"
                      : "text-[11px] text-neutral-500"
            }
          >
            {item.text}
          </div>
        ))}
        {exited !== undefined && (
          <div className="text-[11px] text-neutral-500">process exited ({exited ?? "signal"})</div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {exited === undefined && (
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSend();
            }}
            placeholder="Follow up…"
            className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            className="rounded-md bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
