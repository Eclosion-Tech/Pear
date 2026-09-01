/**
 * Converts Pear's SpacetimeDB conversation rows into assistant-ui
 * `ThreadMessageLike` objects for `useExternalRuntime` (@eclosion-tech/chat).
 *
 * Pure functions over structural row types so this stays testable under the
 * node vitest config — no spacetimedb or React imports.
 */
import type { ThreadMessageLike } from "@eclosion-tech/chat";

// ---------------------------------------------------------------------------
// Structural row inputs (compatible with the generated module bindings)

export type ChatSenderLike =
  | { tag: "User"; value: { toHexString(): string } }
  | { tag: "System"; value: string };

export type ChatMessageStatusTag = "Complete" | "Thinking" | "ToolUse" | "Streaming" | "Error";

export interface AdapterMessage {
  id: bigint;
  sender: ChatSenderLike;
  content: string;
  jobId?: bigint;
  createdAt: { microsSinceUnixEpoch: bigint };
  status?: { tag: ChatMessageStatusTag };
  thinking?: string;
  toolCallsJson?: string;
  timelineJson?: string;
  componentTreeJson?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AdapterContext {
  /** Current user's Identity hex; undefined while the connection settles. */
  myIdentityHex?: string;
  /** Identity hexes of AI users (from ai_user_profile). */
  aiIdentityHexes: ReadonlySet<string>;
  /** Optional identity hex → display name (AI profiles, members). */
  displayNames?: ReadonlyMap<string, string>;
}

/** Per-message app data carried in `metadata.custom`. */
export interface PearMessageMeta {
  senderHex?: string;
  senderName?: string;
  isAi: boolean;
  isSystem: boolean;
  systemReason?: string;
  tokens?: { input: number; output: number };
}

// ---------------------------------------------------------------------------
// Tolerant JSON column parsers (mirrors AiPanel's reading behavior)

/** Client-tolerant union over StoredToolCall and the legacy persisted shape. */
export interface ToolCallInfo {
  id?: string;
  name: string;
  status?: "executing" | "done" | "error";
  input?: string;
  output?: string;
  /** Legacy field predating `output`. */
  result?: string;
  isError?: boolean;
}

type TimelineBlock = { t: "text"; text: string } | { t: "tool"; id: string };

export function parseToolCalls(json: string | undefined): ToolCallInfo[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ToolCallInfo => !!x && typeof x === "object" && typeof (x as ToolCallInfo).name === "string"
    );
  } catch {
    return [];
  }
}

export function parseTimeline(json: string | undefined): TimelineBlock[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is TimelineBlock =>
        !!b &&
        typeof b === "object" &&
        (((b as TimelineBlock).t === "text" && typeof (b as { text?: unknown }).text === "string") ||
          ((b as TimelineBlock).t === "tool" && typeof (b as { id?: unknown }).id === "string"))
    );
  } catch {
    return [];
  }
}

const parseJsonObject = (json: string | undefined): Record<string, unknown> => {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------

type Part = Exclude<ThreadMessageLike["content"], string>[number];

const toolCallPart = (call: ToolCallInfo, index: number): Part => {
  const output = call.output ?? call.result;
  return {
    type: "tool-call",
    toolCallId: call.id ?? `${call.name}-${index}`,
    toolName: call.name,
    args: parseJsonObject(call.input),
    ...(output !== undefined ? { result: output } : {}),
    ...(call.isError || call.status === "error" ? { isError: true } : {}),
  } as Part;
};

/**
 * Ordered content parts for one message: reasoning first (AiPanel renders the
 * thinking block above content), then the timeline interleaving when present,
 * else the legacy "tools first, then content" layout; generated UI and
 * delegated-job markers ride along as data parts.
 */
export function messageParts(msg: AdapterMessage): Part[] {
  const parts: Part[] = [];
  const thinking = msg.thinking?.trim();
  if (thinking) parts.push({ type: "reasoning", text: thinking } as Part);

  const toolCalls = parseToolCalls(msg.toolCallsJson);
  const byId = new Map(toolCalls.filter((c) => c.id).map((c) => [c.id as string, c]));
  const timeline = parseTimeline(msg.timelineJson);

  if (timeline.length > 0) {
    timeline.forEach((block, i) => {
      if (block.t === "text") {
        if (block.text.length > 0) parts.push({ type: "text", text: block.text } as Part);
      } else {
        const call = byId.get(block.id);
        if (call) parts.push(toolCallPart(call, i));
      }
    });
  } else {
    toolCalls.forEach((call, i) => parts.push(toolCallPart(call, i)));
    if (msg.content.length > 0) parts.push({ type: "text", text: msg.content } as Part);
  }

  if (msg.componentTreeJson) {
    parts.push({
      type: "data-component-tree",
      data: { json: msg.componentTreeJson, messageId: msg.id },
    } as Part);
  }
  if (msg.jobId != null) {
    parts.push({ type: "data-orcha-job", data: { jobId: msg.jobId } } as Part);
  }
  return parts;
}

export function isMessageInFlight(msg: AdapterMessage): boolean {
  const tag = msg.status?.tag ?? "Complete";
  return tag !== "Complete" && tag !== "Error";
}

const senderHex = (sender: ChatSenderLike): string | undefined =>
  sender.tag === "User" ? sender.value.toHexString() : undefined;

export function toThreadMessage(msg: AdapterMessage, ctx: AdapterContext): ThreadMessageLike {
  const hex = senderHex(msg.sender);
  const isSystem = msg.sender.tag === "System";
  const isMine = !isSystem && !!ctx.myIdentityHex && hex === ctx.myIdentityHex;
  const isAi = !isSystem && !!hex && ctx.aiIdentityHexes.has(hex);
  const role: "user" | "assistant" = isMine ? "user" : "assistant";

  const meta: PearMessageMeta = {
    senderHex: hex,
    senderName: hex ? ctx.displayNames?.get(hex) : undefined,
    isAi,
    isSystem,
    ...(isSystem ? { systemReason: msg.sender.value as string } : {}),
    ...(msg.inputTokens || msg.outputTokens
      ? { tokens: { input: msg.inputTokens ?? 0, output: msg.outputTokens ?? 0 } }
      : {}),
  };

  const statusTag = msg.status?.tag ?? "Complete";
  return {
    id: msg.id.toString(),
    role,
    createdAt: new Date(Number(msg.createdAt.microsSinceUnixEpoch / 1000n)),
    content: messageParts(msg),
    ...(role === "assistant"
      ? {
          status:
            statusTag === "Error"
              ? { type: "incomplete", reason: "error" }
              : isMessageInFlight(msg)
                ? { type: "running" }
                : { type: "complete", reason: "stop" },
        }
      : {}),
    metadata: { custom: meta as unknown as Record<string, unknown> },
  } as ThreadMessageLike;
}

/**
 * Port of AiPanel's `isAiActive`: the conversation is Active and the last
 * visible message is either a human turn awaiting a reply, or an AI message
 * that hasn't reached a terminal status.
 */
export function conversationIsRunning(
  conversationStatusTag: "Active" | "Closed",
  messages: readonly AdapterMessage[],
  ctx: AdapterContext
): boolean {
  if (conversationStatusTag !== "Active") return false;
  const last = messages[messages.length - 1];
  if (!last) return false;
  const hex = senderHex(last.sender);
  if (last.sender.tag === "System") return false;
  const isAi = !!hex && ctx.aiIdentityHexes.has(hex);
  if (!isAi) return true;
  return isMessageInFlight(last);
}
