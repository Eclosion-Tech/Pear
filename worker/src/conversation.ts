/**
 * Conversation handler — runs in the context of one AI user. Watches for
 * messages from anyone *other than* the AI user itself in any conversation
 * the AI user is a participant of, and generates a streaming reply.
 *
 * Connection model: this handler must be registered against an AI-user-scoped
 * `DbConnection` (i.e. one that authenticated with the AI user's identity
 * token), because:
 *
 *   1. `client_visibility_filter` on `ai_user_config` only exposes the row
 *      whose `identity = :sender`. The AI user's API key is therefore only
 *      readable when we connect AS that AI user.
 *   2. Reducer calls (e.g. `send_message`) record `ctx.sender()` as the
 *      message author. Connecting as the AI user makes the placeholder /
 *      response messages naturally show up as `MessageSender::User(<ai>)`.
 *
 * Flow:
 *   1. Some other participant sends a ConversationMessage.
 *   2. AiUserWorker observes the insert (only on conversations where it is
 *      a participant — guaranteed by visibility, but we double-check).
 *   3. We post a placeholder message with status=Thinking.
 *   4. We stream the LLM response (thinking → tool_use → text) with
 *      periodic flushes via update_message.
 *   5. We finalize with status=Complete (or Error).
 */

import type { Identity } from "spacetimedb";
import type { ConnLike } from "./tools.js";
import {
  type Message,
  type ToolUseBlock,
  type ToolDef,
  type StreamEvent,
  type ChatStreamRequest,
  getProviderForAiUser,
} from "./providers.js";
import { buildPageContext } from "./llm.js";
import {
  getConversationTools,
  executeTool,
  toolContextFromAiUserConfigRow,
} from "./tools.js";
import { SystemPromptBuilder } from "./prompt-builder.js";
import {
  discoverInstructionPages,
  discoverAiUserPrivatePages,
  buildBreadcrumb,
  summarizePageHistory,
  todayIso8601,
  type WorkspaceContext,
} from "./workspace-context.js";
import {
  loadCompactionSummary,
  reconstructSessionTail,
} from "./session-reconstruct.js";

type ConversationRow = {
  id: bigint;
  pageId: bigint | undefined;
  initiatedBy: { toHexString(): string };
  status: { tag: string };
  createdAt: { microsSinceUnixEpoch: bigint };
  updatedAt: { microsSinceUnixEpoch: bigint };
};

type ConversationParticipantRow = {
  id: bigint;
  conversationId: bigint;
  identity: { toHexString(): string };
  role: { tag: string };
  joinedAt: { microsSinceUnixEpoch: bigint };
};

type ConversationMessageRow = {
  id: bigint;
  conversationId: bigint;
  sender: { tag: string; value: unknown };
  content: string;
  jobId: bigint | undefined;
  createdAt: { microsSinceUnixEpoch: bigint };
  status: { tag: string };
  thinking: string | undefined;
  toolCallsJson: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

type AiUserProfileRow = {
  aiUserId: bigint;
  identity: { toHexString(): string };
  displayName: string;
  avatarUrl: string | undefined;
  providerName: string;
  modelName: string;
  hasApiKey: boolean;
};

const processing = new Set<string>();
const FLUSH_INTERVAL_MS = 300;
const THINKING_BUDGET = 5_000;
const MAX_TOOL_ITERATIONS = 15;
const RECENT_MESSAGE_MAX_AGE_MS = 5 * 60_000;

function messageKey(convId: bigint, msgId: bigint): string {
  return `${convId}:${msgId}`;
}

function messageAgeMs(msg: ConversationMessageRow): number {
  return (
    Number(BigInt(Date.now()) * 1000n - msg.createdAt.microsSinceUnixEpoch) /
    1000
  );
}

function identityHex(id: { toHexString(): string } | unknown): string {
  if (id && typeof (id as { toHexString?: () => string }).toHexString === "function") {
    return (id as { toHexString(): string }).toHexString();
  }
  return String(id);
}

/** True if `msg.sender` is `User(identity)` and the identity matches `selfHex`. */
function isFromSelf(
  msg: ConversationMessageRow,
  selfHex: string,
): boolean {
  if (msg.sender.tag !== "User") return false;
  return identityHex(msg.sender.value) === selfHex;
}

/** True if `msg.sender` is `User(identity)` and the identity is NOT us. */
function isFromOtherUser(
  msg: ConversationMessageRow,
  selfHex: string,
): boolean {
  if (msg.sender.tag !== "User") return false;
  return identityHex(msg.sender.value) !== selfHex;
}

/**
 * Find the AI message we just created by looking for the latest `Thinking`
 * message authored by *us* in this conversation.
 */
async function findAiMessageId(
  conn: ConnLike,
  conversationId: bigint,
  selfHex: string,
  retries = 5,
): Promise<bigint | null> {
  for (let i = 0; i < retries; i++) {
    const msgs = [
      ...(conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>),
    ]
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          isFromSelf(m, selfHex) &&
          m.status?.tag === "Thinking",
      )
      .sort(
        (a, b) =>
          Number(
            b.createdAt.microsSinceUnixEpoch -
              a.createdAt.microsSinceUnixEpoch,
          ),
      );

    if (msgs.length > 0) return msgs[0].id;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

interface ToolCallInfo {
  name: string;
  status: "executing" | "done" | "error";
  result?: string;
}

async function flushMessage(
  conn: ConnLike,
  messageId: bigint,
  content: string,
  status: string,
  thinking: string | undefined,
  toolCalls: ToolCallInfo[],
): Promise<void> {
  try {
    await conn.reducers.updateMessage({
      messageId,
      content,
      status: { tag: status },
      thinking: thinking || undefined,
      toolCallsJson:
        toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined,
    });
  } catch (err) {
    console.warn(
      `[conversation] flush failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Resolve the AiUserProfile for `selfHex` from the subscribed `ai_user_profile` table. */
function findOwnProfile(
  conn: ConnLike,
  selfHex: string,
): AiUserProfileRow | null {
  for (const row of conn.db.ai_user_profile.iter() as Iterable<AiUserProfileRow>) {
    if (identityHex(row.identity) === selfHex) return row;
  }
  return null;
}

/**
 * If the model returns no final text but every tool result parsed as `{ ok: true }`,
 * we still mark the turn successful with a short confirmation so the user does not
 * see a spurious "No response generated" after a long tool chain.
 */
function toolResultStringsIndicateFullSuccess(log: string[]): boolean {
  if (log.length === 0) return false;
  for (const s of log) {
    try {
      if (JSON.parse(s).ok !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function fallbackTextWhenNoAssistantMessage(toolResultLog: string[]): string {
  if (toolResultLog.length === 0) {
    return "(No response generated)";
  }
  if (toolResultStringsIndicateFullSuccess(toolResultLog)) {
    return "Done. I used tools in your workspace as requested. Ask if you want a detailed summary of the changes.";
  }
  return "I ran some tools, but at least one step did not return success, or a tool returned non-JSON. Check the tool trace above for details.";
}

function toolResultWasOk(result: string): boolean {
  try {
    return JSON.parse(result).ok !== false;
  } catch {
    return true;
  }
}

/**
 * Confirm the AI user is a participant in `conversationId`. Cheap defensive
 * check on top of visibility filters.
 */
function isParticipant(
  conn: ConnLike,
  conversationId: bigint,
  selfHex: string,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const partTable = (conn.db as any).conversation_participant;
  if (!partTable?.iter) return true; // Older bindings — best-effort allow.
  for (const row of partTable.iter() as Iterable<ConversationParticipantRow>) {
    if (
      row.conversationId === conversationId &&
      identityHex(row.identity) === selfHex
    ) {
      return true;
    }
  }
  return false;
}

async function handleConversationMessage(
  conn: ConnLike,
  msg: ConversationMessageRow,
  selfHex: string,
  logTag: string,
): Promise<void> {
  const key = messageKey(msg.conversationId, msg.id);
  if (processing.has(key)) return;
  processing.add(key);

  try {
    if (messageAgeMs(msg) > RECENT_MESSAGE_MAX_AGE_MS) return;

    const conv = conn.db.conversation.id.find(msg.conversationId) as
      | ConversationRow
      | undefined;
    if (!conv || conv.status.tag !== "Active") return;

    if (!isParticipant(conn, conv.id, selfHex)) {
      // Visibility usually prevents this, but bail rather than spam reducers.
      return;
    }

    // Respect ordering: if we already replied later than this message, skip.
    const laterReplies = [
      ...(conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>),
    ].filter(
      (m) =>
        m.conversationId === msg.conversationId &&
        isFromSelf(m, selfHex) &&
        m.createdAt.microsSinceUnixEpoch > msg.createdAt.microsSinceUnixEpoch,
    );
    if (laterReplies.length > 0) return;

    const aiProfile = findOwnProfile(conn, selfHex);
    if (!aiProfile) {
      console.warn(
        `${logTag} no AiUserProfile row visible for self ${selfHex.slice(0, 12)}…`,
      );
      return;
    }

    console.log(
      `${logTag} responding as "${aiProfile.displayName}" in conversation ${conv.id}` +
        (conv.pageId !== undefined ? ` (page ${conv.pageId})` : ""),
    );

    // Step 1: placeholder message (Thinking)
    await conn.reducers.sendMessage({
      conversationId: conv.id,
      content: "",
      jobId: undefined,
      status: { tag: "Thinking" },
      thinking: undefined,
      toolCallsJson: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
    });

    const aiMsgId = await findAiMessageId(conn, conv.id, selfHex);
    if (!aiMsgId) {
      console.error(`${logTag} could not find placeholder AI message`);
      return;
    }

    const pageContext = conv.pageId
      ? await buildPageContext(conn, conv.pageId)
      : "";

    // Build WorkspaceContext (page-anchored conversations only).
    let workspaceCtx: WorkspaceContext | undefined;
    if (conv.pageId !== undefined) {
      const pageRow = conn.db.page.id.find(conv.pageId) as
        | { title: string }
        | undefined;
      const instructionPages = discoverInstructionPages(conn, conv.pageId);
      const breadcrumb = buildBreadcrumb(conn, conv.pageId);
      const pageHistory = summarizePageHistory(conn, conv.pageId);
      workspaceCtx = {
        currentPageId: conv.pageId,
        currentPageTitle: pageRow?.title ?? "Unknown page",
        breadcrumb,
        currentDate: todayIso8601(),
        aiDisplayName: aiProfile.displayName,
        modelName: aiProfile.modelName,
        providerName: aiProfile.providerName,
        instructionPages,
        pageHistory,
      };
    }

    const compactionSummary = loadCompactionSummary(conn, conv.id);

    const assistantParts: string[] = [];
    if (aiProfile.displayName) {
      assistantParts.push(
        `Your display name is "${aiProfile.displayName}". You are powered by ${aiProfile.providerName} (${aiProfile.modelName}).`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownCfg = (conn.db as any).ai_user_config?.id?.find(aiProfile.aiUserId) as
      | { systemPrompt?: string }
      | undefined;
    if (ownCfg?.systemPrompt?.trim()) {
      assistantParts.push(ownCfg.systemPrompt.trim());
    }

    const privatePages = discoverAiUserPrivatePages(conn, aiProfile.aiUserId);

    let builder = new SystemPromptBuilder()
      .withAiUserSystemPrompt(assistantParts.join("\n\n"))
      .withAiUserPrivatePages(privatePages.pages, privatePages.truncated);
    if (workspaceCtx) builder = builder.withWorkspaceContext(workspaceCtx);
    if (compactionSummary) {
      builder = builder.withCompactionSummary(compactionSummary);
    }
    const systemPrompt = builder.render();

    // Reconstruct message tail (respects compaction floor). Filter out the
    // placeholder we just inserted (no content).
    const tailMessages = reconstructSessionTail(conn, conv.id, selfHex);
    const llmMessages: Message[] = tailMessages.filter(
      (m) =>
        !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0),
    );

    if (pageContext) {
      llmMessages.unshift({
        role: "assistant",
        content: [
          { type: "text", text: "I've reviewed the page context. How can I help?" },
        ],
      });
      llmMessages.unshift({
        role: "user",
        content: `[Page context]\n${pageContext}`,
      });
    }

    const {
      provider: aiProvider,
      model,
      maxTokens,
    } = getProviderForAiUser(conn, aiProfile.aiUserId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiCfg = (conn.db as any).ai_user_config?.id?.find(
      aiProfile.aiUserId,
    ) as { toolSecretsJson?: unknown } | undefined;
    const toolContext = {
      ...toolContextFromAiUserConfigRow(aiCfg),
      conversationId: conv.id,
      currentPageId: conv.pageId,
    };

    const tools: ToolDef[] = getConversationTools() as ToolDef[];
    const allToolCalls: ToolCallInfo[] = [];
    /** All raw tool result strings this turn — for assessing success when the model omits a text reply. */
    const toolResultLog: string[] = [];
    let thinkingText = "";
    let responseText = "";
    let iterations = 0;

    if (aiProvider.chatStream) {
      while (iterations++ < MAX_TOOL_ITERATIONS) {
        let lastFlush = Date.now();

        const effectiveMaxTokens = Math.max(maxTokens, THINKING_BUDGET + 4096);
        const streamReq: ChatStreamRequest = {
          model,
          maxTokens: effectiveMaxTokens,
          system: systemPrompt,
          messages: llmMessages,
          tools: tools.length > 0 ? tools : undefined,
          thinkingBudget: THINKING_BUDGET,
        };

        let doneResponse: (StreamEvent & { type: "done" }) | null = null;

        for await (const event of aiProvider.chatStream(streamReq)) {
          if (event.type === "thinking_delta") {
            thinkingText += event.text;
            if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
              await flushMessage(
                conn,
                aiMsgId,
                responseText,
                "Thinking",
                thinkingText,
                allToolCalls,
              );
              lastFlush = Date.now();
            }
          } else if (event.type === "text_delta") {
            responseText += event.text;
            const currentStatus = responseText ? "Streaming" : "Thinking";
            if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
              await flushMessage(
                conn,
                aiMsgId,
                responseText,
                currentStatus,
                thinkingText,
                allToolCalls,
              );
              lastFlush = Date.now();
            }
          } else if (event.type === "tool_use_start") {
            allToolCalls.push({ name: event.block.name, status: "executing" });
            await flushMessage(
              conn,
              aiMsgId,
              responseText,
              "ToolUse",
              thinkingText,
              allToolCalls,
            );
          } else if (event.type === "done") {
            doneResponse = event;
          }
        }

        if (!doneResponse) break;

        const toolBlocks = doneResponse.response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        if (
          toolBlocks.length === 0 ||
          doneResponse.response.stopReason === "end_turn"
        ) {
          const textBlock = doneResponse.response.content.find(
            (b) => b.type === "text",
          );
          if (textBlock?.type === "text") {
            responseText = textBlock.text;
          }
          break;
        }

        llmMessages.push({
          role: "assistant",
          content: doneResponse.response.content,
        });

        const toolResults: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
        }[] = [];
        for (const block of toolBlocks) {
          const idx = allToolCalls.findIndex(
            (tc) => tc.name === block.name && tc.status === "executing",
          );

          console.log(
            `${logTag} tool call [${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`,
          );
          const result = await executeTool(
            conn,
            block.name,
            block.input,
            BigInt(0),
            toolContext,
          );
          console.log(`${logTag} tool result [${block.name}]: ${result.slice(0, 200)}`);
          toolResultLog.push(result);

          if (idx >= 0) {
            allToolCalls[idx].status = toolResultWasOk(result) ? "done" : "error";
            allToolCalls[idx].result = result.slice(0, 200);
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }

        await flushMessage(
          conn,
          aiMsgId,
          responseText,
          "ToolUse",
          thinkingText,
          allToolCalls,
        );
        llmMessages.push({ role: "user", content: toolResults });

        responseText = "";
      }
    } else {
      while (iterations++ < MAX_TOOL_ITERATIONS) {
        const response = await aiProvider.chat({
          model,
          maxTokens,
          system: systemPrompt,
          messages: llmMessages,
          tools: tools.length > 0 ? tools : undefined,
        });

        const toolCalls = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        const textBlock = response.content.find((b) => b.type === "text");
        if (textBlock?.type === "text") {
          responseText = textBlock.text;
        }

        if (toolCalls.length === 0 || response.stopReason === "end_turn") break;

        llmMessages.push({ role: "assistant", content: response.content });

        const toolResults: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
        }[] = [];
        for (const block of toolCalls) {
          allToolCalls.push({ name: block.name, status: "executing" });
          const tcIdx = allToolCalls.length - 1;
          console.log(
            `${logTag} tool call [${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`,
          );
          const result = await executeTool(
            conn,
            block.name,
            block.input,
            BigInt(0),
            toolContext,
          );
          console.log(`${logTag} tool result [${block.name}]: ${result.slice(0, 200)}`);
          toolResultLog.push(result);
          allToolCalls[tcIdx] = {
            name: block.name,
            status: toolResultWasOk(result) ? "done" : "error",
            result: result.slice(0, 200),
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }

        llmMessages.push({ role: "user", content: toolResults });
      }
    }

    const hadAssistantText = Boolean(responseText?.trim());
    if (!hadAssistantText) {
      responseText = fallbackTextWhenNoAssistantMessage(toolResultLog);
    } else {
      responseText = responseText.trim();
    }

    if (responseText === "(No response generated)") {
      console.warn(
        `${logTag} no text response and no tool results to assess for conversation ${conv.id}`,
      );
      await flushMessage(
        conn,
        aiMsgId,
        responseText,
        "Error",
        thinkingText,
        allToolCalls,
      );
      return;
    }

    if (!hadAssistantText) {
      if (toolResultLog.length > 0 && !toolResultStringsIndicateFullSuccess(toolResultLog)) {
        console.warn(
          `${logTag} no assistant text; at least one tool result was not ok for conversation ${conv.id}`,
        );
      } else {
        console.warn(
          `${logTag} no assistant text; using tool-outcome message for conversation ${conv.id} (${toolResultLog.length} tool result(s))`,
        );
      }
    }

    await flushMessage(
      conn,
      aiMsgId,
      responseText,
      "Complete",
      thinkingText,
      allToolCalls,
    );

    console.log(
      `${logTag} responded in conversation ${conv.id} (${responseText.length} chars, thinking: ${thinkingText.length} chars, tools: ${allToolCalls.length})`,
    );
  } catch (err) {
    console.error(
      `${logTag} failed to respond in conversation ${msg.conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    processing.delete(key);
  }
}

/**
 * Register conversation handlers against an AI-user-scoped connection.
 *
 * @param conn          Connection authenticated as the AI user
 * @param selfIdentity  The AI user's Identity (used to filter own messages)
 * @param logTag        Prefix for log lines (e.g. `[ai:eclosion/Kira]`)
 */
export function registerConversationHandlers(
  conn: ConnLike,
  selfIdentity: Identity,
  logTag = "[conversation]",
): void {
  const selfHex = selfIdentity.toHexString();

  conn.db.conversation_message.onInsert(
    (_ctx: unknown, msg: ConversationMessageRow) => {
      if (isFromOtherUser(msg, selfHex)) {
        void handleConversationMessage(conn, msg, selfHex, logTag);
      }
    },
  );

  console.log(`${logTag} handlers registered (self=${selfHex.slice(0, 12)}…)`);
}

export async function processRecentConversationMessages(
  conn: ConnLike,
  selfIdentity: Identity,
  logTag = "[conversation]",
): Promise<void> {
  const selfHex = selfIdentity.toHexString();
  const messages = [
    ...(conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>),
  ]
    .filter(
      (msg) =>
        isFromOtherUser(msg, selfHex) &&
        messageAgeMs(msg) <= RECENT_MESSAGE_MAX_AGE_MS,
    )
    .sort((a, b) =>
      a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch
        ? -1
        : a.createdAt.microsSinceUnixEpoch > b.createdAt.microsSinceUnixEpoch
          ? 1
          : 0,
    );

  if (messages.length === 0) return;

  console.log(`${logTag} checking ${messages.length} recent visible user message(s)`);
  for (const msg of messages) {
    await handleConversationMessage(conn, msg, selfHex, logTag);
  }
}
