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
import type { Message, ToolResultBlock } from "./providers.js";

// ── Internal row type ─────────────────────────────────────────────────────────

type ConversationMessageRow = {
  id: bigint;
  conversationId: bigint;
  sender: { tag: string; value: unknown };
  content: string;
  toolCallsJson: string | undefined;
  status: { tag: string };
};

// ── Stored tool_calls_json block shapes ───────────────────────────────────────

interface StoredToolUse {
  type: "tool_use";
  id: string;
  name: string;
  /** Raw input string passed to the executor — may be stringified JSON. */
  input: string;
  status: string;
}

interface StoredToolResult {
  type: "tool_result";
  tool_use_id: string;
  tool_name: string;
  output: string;
  is_error: boolean;
}

type StoredBlock = StoredToolUse | StoredToolResult;

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
 * tool_calls_json blocks are parsed and reconstructed as properly paired
 * assistant (ToolUse) + user (ToolResult) messages so the Anthropic API
 * can correctly resume a mid-session conversation.
 *
 * `assistantIdentityHex` must be the SpacetimeDB identity (hex) of the AI
 * user whose worker is reconstructing the thread. Human messages are every
 * other `User(identity)` row; the assistant's rows use the same `User` tag
 * after the MessageSender refactor (there is no separate `AiUser` variant).
 */
export function reconstructSessionTail(
  conn: ConnLike,
  conversationId: bigint,
  assistantIdentityHex: string,
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
      // Compaction markers or other system messages within the tail are skipped
      continue;
    }

    if (msg.sender.tag !== "User") {
      continue;
    }

    const senderHex = identityHex(msg.sender.value).toLowerCase();
    const isAssistantTurn = senderHex === assistantHex;

    if (!isAssistantTurn) {
      if (!msg.content) continue;
      result.push({ role: "user", content: msg.content });
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

    let blocks: StoredBlock[];
    try {
      blocks = JSON.parse(msg.toolCallsJson) as StoredBlock[];
    } catch {
      if (msg.content) {
        result.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
        });
      }
      continue;
    }

    const toolUseBlocks = blocks.filter((b): b is StoredToolUse => b.type === "tool_use");
    const toolResultBlocks = blocks.filter(
      (b): b is StoredToolResult => b.type === "tool_result",
    );

    const assistantContent: Message["content"] = [];
    if (msg.content) {
      (assistantContent as { type: "text"; text: string }[]).push({
        type: "text",
        text: msg.content,
      });
    }
    for (const block of toolUseBlocks) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(block.input) as Record<string, unknown>;
      } catch {
        input = { raw: block.input };
      }
      (
        assistantContent as {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        }[]
      ).push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input,
      });
    }

    if ((assistantContent as unknown[]).length > 0) {
      result.push({ role: "assistant", content: assistantContent as never });
    }

    if (toolResultBlocks.length > 0) {
      const userContent: ToolResultBlock[] = toolResultBlocks.map((r) => ({
        type: "tool_result",
        tool_use_id: r.tool_use_id,
        content: r.output,
      }));
      result.push({ role: "user", content: userContent });
    }
  }

  return result;
}
