/**
 * Session reconstruction — implements Option C compaction strategy from
 * pear-claw-code-schema-changes.md.
 *
 * On session resume the worker:
 *   1. Finds the most recent System("compaction") message (compaction floor)
 *   2. Discards all messages at or before the floor id
 *   3. Reconstructs Message[] from the tail for the LLM context window
 *
 * The compaction summary text goes into the system prompt via
 * SystemPromptBuilder.withCompactionSummary — not into the message list.
 */

import type { ConnLike } from "./tools.js";
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
  TextBlock,
  UserContentBlock,
} from "./providers.js";
import { isStoredToolCall } from "./tool-call-record.js";
import type { ResolvedMessageAttachments } from "./attachments.js";

// ── Internal row type ─────────────────────────────────────────────────────────

type ConversationMessageRow = {
  id: bigint;
  conversationId: bigint;
  sender: { tag: string; value: unknown };
  content: string;
  toolCallsJson: string | undefined;
  status: { tag: string };
};

function identityHex(value: unknown): string {
  if (value && typeof (value as { toHexString?: () => string }).toHexString === "function") {
    return (value as { toHexString(): string }).toHexString();
  }
  return String(value);
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Load the content of the most recent compaction message for a conversation.
 * Returns undefined if no compaction has occurred.
 *
 * The returned text should be passed to SystemPromptBuilder.withCompactionSummary.
 */
export function loadCompactionSummary(
  conn: ConnLike,
  conversationId: bigint,
): string | undefined {
  const compactionMessages = [
    ...(conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>),
  ]
    .filter(
      (m) =>
        m.conversationId === conversationId &&
        m.sender.tag === "System" &&
        m.sender.value === "compaction",
    )
    .sort((a, b) => Number(b.id - a.id)); // most recent first

  return compactionMessages[0]?.content;
}

/**
 * Reconstruct the tail of a conversation as LLM Message[] for the context window.
 *
 * Option C compaction:
 *   - All messages at or before the most recent compaction floor are discarded.
 *   - The tail (messages after the floor) is reconstructed into Message[].
 *   - System messages within the tail are skipped (handled as system prompt).
 *
 * tool_calls_json records are parsed and reconstructed as properly paired
 * assistant (ToolUse) + user (ToolResult) messages so the Anthropic API
 * can correctly resume a mid-session conversation. Legacy records that predate
 * the unified `StoredToolCall` shape carry no tool_use id, so they can't be
 * re-paired; for those the assistant text is preserved but the tool blocks are
 * dropped (the same lossy behavior as before this fix).
 *
 * `assistantIdentityHex` must be the SpacetimeDB identity (hex) of the AI
 * user whose worker is reconstructing the thread. Human messages are every
 * other `User(identity)` row; the assistant's rows use the same `User` tag
 * after the MessageSender refactor (there is no separate `AiUser` variant).
 *
 * `attachments` (optional, from `resolveConversationAttachments`) maps message
 * id → resolved images/context for human turns. Resolved separately because
 * image resolution is async (S3) while reconstruction stays synchronous.
 */
export function reconstructSessionTail(
  conn: ConnLike,
  conversationId: bigint,
  assistantIdentityHex: string,
  attachments?: Map<bigint, ResolvedMessageAttachments>,
): Message[] {
  const allMessages = [
    ...(conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>),
  ]
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => Number(a.id - b.id)); // ascending by id

  // Find the compaction floor (most recent compaction message)
  let floorId: bigint | undefined;
  for (const msg of [...allMessages].reverse()) {
    if (msg.sender.tag === "System" && msg.sender.value === "compaction") {
      floorId = msg.id;
      break;
    }
  }

  const tail =
    floorId !== undefined
      ? allMessages.filter((m) => m.id > floorId!)
      : allMessages;

  const result: Message[] = [];
  const assistantHex = assistantIdentityHex.toLowerCase();

  for (const msg of tail) {
    if (msg.sender.tag === "System") {
      // System triggers — a delegated job finishing ("job_completion"), a
      // scheduled routine firing ("routine"), a human thumbs-down with a note
      // ("feedback"), or a page-access request being resolved
      // ("access_resolution") — are reconstructed as a user-role note so the
      // model sees the instruction/outcome and produces a turn. All other system
      // messages (compaction markers, etc.) go via the system prompt / skipped.
      if (
        (msg.sender.value === "job_completion" ||
          msg.sender.value === "routine" ||
          msg.sender.value === "feedback" ||
          msg.sender.value === "access_resolution") &&
        msg.content
      ) {
        result.push({ role: "user", content: msg.content });
      }
      continue;
    }

    if (msg.sender.tag !== "User") {
      continue;
    }

    const senderHex = identityHex(msg.sender.value).toLowerCase();
    const isAssistantTurn = senderHex === assistantHex;

    if (!isAssistantTurn) {
      const att = attachments?.get(msg.id);
      const text = [msg.content, att?.contextText].filter(Boolean).join("\n\n");
      if (att && att.images.length > 0) {
        const blocks: UserContentBlock[] = [...att.images];
        if (text) blocks.push({ type: "text", text });
        result.push({ role: "user", content: blocks });
      } else if (text) {
        result.push({ role: "user", content: text });
      }
      continue;
    }

    // Assistant turn (AI user connected as User(identity))
    if (!msg.toolCallsJson) {
      if (msg.content) {
        result.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
        });
      }
      continue;
    }

    let records: unknown[];
    try {
      const parsed = JSON.parse(msg.toolCallsJson);
      records = Array.isArray(parsed) ? parsed : [];
    } catch {
      records = [];
    }

    // Only the unified shape carries the tool_use id needed to pair an
    // assistant call with its result; legacy records are dropped (text-only).
    const toolCalls = records.filter(isStoredToolCall);

    const assistantContent: (TextBlock | ToolUseBlock)[] = [];
    if (msg.content) {
      assistantContent.push({ type: "text", text: msg.content });
    }
    for (const call of toolCalls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.input) as Record<string, unknown>;
      } catch {
        input = { raw: call.input };
      }
      assistantContent.push({ type: "tool_use", id: call.id, name: call.name, input });
    }

    if (assistantContent.length > 0) {
      result.push({ role: "assistant", content: assistantContent });
    }

    // Every tool_use must be answered by a matching tool_result or the API
    // rejects the resumed turn. A call with no recorded output (e.g. the prior
    // turn crashed mid-flight) gets a placeholder so the pairing stays valid.
    if (toolCalls.length > 0) {
      const userContent: ToolResultBlock[] = toolCalls.map((call) => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: call.output ?? "(no result recorded)",
      }));
      result.push({ role: "user", content: userContent });
    }
  }

  return result;
}
