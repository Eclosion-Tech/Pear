/**
 * Pure transcript rendering: normalized engine events → markdown lines.
 *
 * The scribe keeps the whole transcript as markdown and rewrites the page on
 * each flush (replace semantics match writePageContent). Rendering is
 * line-oriented so appends are just array pushes.
 */

/** Mirror of the desktop's normalized EngineEvent (engines/events.rs). */
export type ScribeEngineEvent =
  | { kind: "started"; sessionId: string }
  | { kind: "assistantMessage"; text: string }
  | { kind: "toolUse"; id?: string | null; name: string; input?: unknown }
  | { kind: "toolResult"; toolUseId?: string | null; content?: unknown }
  | {
      kind: "turnCompleted";
      success: boolean;
      costUsd?: number | null;
      usage?: unknown;
    }
  | { kind: "raw"; line: Record<string, unknown> }
  | { kind: "stderr"; line: string }
  | { kind: "exited"; code: number | null }
  | { kind: "error"; message: string };

export interface TranscriptHeader {
  engine: string;
  sessionId: string;
  cwd: string;
  startedAtIso: string;
}

const MAX_INLINE_JSON = 300;

function inlineJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  s = s.replace(/\s+/g, " ");
  if (s.length > MAX_INLINE_JSON) s = `${s.slice(0, MAX_INLINE_JSON)}…`;
  // Inline code spans can't hold backticks.
  return s.replace(/`/g, "'");
}

export function headerMarkdown(h: TranscriptHeader): string[] {
  return [
    `Engine: ${h.engine} · Working dir: ${h.cwd}`,
    `Session ${h.sessionId} · started ${h.startedAtIso}`,
  ];
}

export function userMarkdown(text: string): string[] {
  return [`**User:** ${text.trim()}`];
}

/** Markdown lines for one engine event; [] for events we don't transcribe. */
export function eventMarkdown(ev: ScribeEngineEvent): string[] {
  switch (ev.kind) {
    case "assistantMessage":
      return ev.text.trim() ? [ev.text.trim()] : [];
    case "toolUse": {
      const args = inlineJson(ev.input);
      return [`- 🔧 ${ev.name}${args ? ` \`${args}\`` : ""}`];
    }
    case "toolResult": {
      const out = inlineJson(ev.content);
      return out ? [`- ↩ \`${out}\``] : [];
    }
    case "turnCompleted": {
      const cost =
        typeof ev.costUsd === "number" ? ` · $${ev.costUsd.toFixed(4)}` : "";
      return [`Turn ${ev.success ? "completed" : "failed"}${cost}`];
    }
    case "exited":
      return [`Session exited${ev.code !== null ? ` (code ${ev.code})` : ""}`];
    case "error":
      return [`⚠ ${ev.message}`];
    // Protocol noise — the raw JSONL on disk is the full-fidelity record.
    case "started":
    case "raw":
    case "stderr":
      return [];
  }
}
