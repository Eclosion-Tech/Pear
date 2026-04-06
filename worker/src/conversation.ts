/**
 * Conversation handler — watches for human messages in conversations and
 * generates AI responses via the inference provider with streaming support.
 *
 * Flow:
 *   1. Human sends a ConversationMessage (via @mention or the AiPanel input)
 *   2. Worker detects the new message (onInsert callback)
 *   3. Worker looks up the Conversation → AiUserProfile → provider config
 *   4. Creates a placeholder AI message with status=Thinking
 *   5. Streams the response (thinking → tool use → text) with periodic flushes
 *   6. Finalizes the message with status=Complete
 */

import type { ConnLike } from "./tools.js";
import {
  type Message,
  type ToolUseBlock,
  type ToolDef,
  type StreamEvent,
  type ChatStreamRequest,
  getDefaultProvider,
} from "./providers.js";
import { buildPageContext } from "./llm.js";
import { getConversationTools, executeTool } from "./tools.js";
import { SystemPromptBuilder } from "./prompt-builder.js";
import {
  discoverInstructionPages,
  buildBreadcrumb,
  summarizePageHistory,
  todayIso8601,
  type WorkspaceContext,
} from "./workspace-context.js";
import { loadCompactionSummary, reconstructSessionTail } from "./session-reconstruct.js";

type ConversationRow = {
  id: bigint;
  pageId: bigint;
  aiUserId: bigint;
  initiatedBy: { toHexString(): string };
  status: { tag: string };
  createdAt: { microsSinceUnixEpoch: bigint };
  updatedAt: { microsSinceUnixEpoch: bigint };
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
  displayName: string;
  avatarUrl: string | undefined;
  providerName: string;
  modelName: string;
};

/** Fallback system prompt for conversations without a full WorkspaceContext. */
const CONVERSATION_SYSTEM_FALLBACK = `\
You are an AI assistant embedded in **Pear**, a real-time collaborative workspace built on SpacetimeDB.
You are participating in a conversation attached to a specific page. You have context about that page's content.

# About Pear

Pear is a collaborative workspace (similar in concept to Notion) where users create, organize, and collaborate on documents and databases. Everything lives in a single shared workspace — there are no per-page permissions. All authenticated users see the same data.

## Page Types

There are two page types, both using the same underlying Page entity:

- **Doc** — A rich-text document. The editor is built on BlockNote (a block-based editor like Notion). Docs support headings, paragraphs, bullet/numbered/check lists, blockquotes, horizontal rules, code blocks (with syntax highlighting for TypeScript, JavaScript, Python, SQL, Bash, HTML, CSS, JSON, Markdown), images (uploaded to object storage), and page links (embedded references to child pages).
- **Database** — A structured table/grid. Its rows are child Doc pages, so opening a row reveals a full document editor plus the row's property values. Databases have a schema of typed columns (properties).

## Page Organization

- Pages are organized in a **tree** via parent/child relationships. Any page can be nested under another.
- Pages can be **reordered** and **moved** between parents via drag-and-drop in the sidebar.
- Each page can have an optional **emoji icon** and a **title**.
- **Sidebar navigation** shows the page tree with expand/collapse. There's also a **Quick Switcher** (⌘K) for fuzzy search across all pages.
- **Trash**: Deleted pages are soft-deleted and can be restored. Hard purge reparents children to the deleted page's parent.
- **Breadcrumbs** show the page ancestry for navigation.

## Database Features

Databases support these column (property) types:

| Type | Description |
|------|-------------|
| Text | Plain text |
| Number | Numeric values |
| Date | Date values with before/after/on filtering |
| Select | Single-select dropdown with configurable options |
| MultiSelect | Multi-select tags |
| Relation | Links to pages in other databases |
| Checkbox | Boolean toggle |
| Url | URL/link |

Database UI features:
- **Grid and List** view modes
- **Filters** per column type (contains, equals, gt/lt, empty, etc.)
- **Sorts** by title or any property (asc/desc)
- **Column resize**, auto-fit, and drag-to-reorder
- **Row detail modal** for editing a row as a full page
- **Cell selection**, multi-select, bulk delete
- New databases are seeded with Name, Tags (Select: Todo/In Progress/Done), and Notes columns plus 3 starter rows.

## Editor Capabilities

The BlockNote editor supports:
- Standard blocks: paragraphs, headings (H1–H3), bullet lists, numbered lists, checklists, blockquotes, dividers
- **Code blocks** with language selection
- **Image blocks** with upload and captions
- **Page link blocks** — embedded links to child pages
- **Slash menu** (/): insert any block type, upload images, create child pages, or trigger an AI job
- **@ mentions**: mention workspace users or AI users. Mentioning an AI user opens a conversation.
- Rich text formatting: bold, italic, underline, strikethrough, code, links, text color, background color

## AI Features

- **AI Users**: AI assistants configured with a provider (Anthropic, OpenAI, Ollama, OpenAI-compatible), model, and optional custom system prompt. Created and managed in Settings.
- **Conversations**: Initiated by @mentioning an AI user in the editor or from the AI panel. Each conversation is attached to a specific page, giving the AI context about that page's content.
- **AI Jobs (Orcha)**: Triggered via the slash menu "Ask AI" command. Creates a multi-step task that can plan subtasks, create pages, add database properties, create rows, set values, and update page content. Jobs appear in the AI panel.
- **Your tools**: create_page, update_page_title, update_page_content, add_property, create_row, set_property_value, get_schema_id, list_properties, web_search, fetch_url. You can directly create and modify pages, databases, and their content from within conversations.

## Version History

- Pages have **snapshots** (manual or automatic every 5 minutes) that can be restored.
- Snapshot types: Manual, Periodic, PreAgentEdit, PostAgentEdit.

## Collaboration

- Real-time data sync via SpacetimeDB subscriptions — all table changes propagate to connected clients instantly.
- Document content uses Yjs for CRDT-based editing with IndexedDB local caching.

# Guidelines

- Be helpful, concise, and conversational.
- You have context about the page this conversation is attached to — reference specific content when relevant.
- When a user asks you to create pages, databases, add columns, or modify content, do it directly using your tools. Don't tell users to use AI Jobs or the slash menu — just do it.
- When creating a Database, call create_page first, then add_property for each column. For pre-populated databases, also call create_row and set_property_value for each row/cell.
- Use markdown for formatting when it helps readability.
- Keep responses focused and actionable.
- When suggesting how to organize content in Pear, leverage your knowledge of its features (databases with typed columns, nested pages, page links, etc.) to give concrete, practical advice.`;

const processing = new Set<string>();
const FLUSH_INTERVAL_MS = 300;
const THINKING_BUDGET = 5_000;
const MAX_TOOL_ITERATIONS = 15;

function messageKey(convId: bigint, msgId: bigint): string {
  return `${convId}:${msgId}`;
}

function buildConversationMessages(
  messages: ConversationMessageRow[],
  aiUserId: bigint,
  pageContext: string,
): Message[] {
  const llmMessages: Message[] = [];

  if (pageContext) {
    llmMessages.push({
      role: "user",
      content: `[Page context]\n${pageContext}`,
    });
    llmMessages.push({
      role: "assistant",
      content: [{ type: "text", text: "I've reviewed the page context. How can I help?" }],
    });
  }

  for (const msg of messages) {
    const isAi = msg.sender.tag === "AiUser" && msg.sender.value === aiUserId;
    if (isAi) {
      if (!msg.content) continue;
      llmMessages.push({
        role: "assistant",
        content: [{ type: "text", text: msg.content }],
      });
    } else {
      if (!msg.content) continue;
      llmMessages.push({
        role: "user",
        content: msg.content,
      });
    }
  }

  return llmMessages;
}

/**
 * Find the AI message we just created by looking for the latest one
 * from this AI user in the conversation.
 */
async function findAiMessageId(
  conn: ConnLike,
  conversationId: bigint,
  retries = 5,
): Promise<bigint | null> {
  for (let i = 0; i < retries; i++) {
    const msgs = [
      ...(conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>),
    ]
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          m.sender.tag === "AiUser" &&
          m.status?.tag === "Thinking",
      )
      .sort(
        (a, b) =>
          Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch),
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
      toolCallsJson: toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined,
    });
  } catch (err) {
    console.warn(`[conversation] flush failed:`, err instanceof Error ? err.message : err);
  }
}

async function handleConversationMessage(
  conn: ConnLike,
  msg: ConversationMessageRow,
): Promise<void> {
  const key = messageKey(msg.conversationId, msg.id);
  if (processing.has(key)) return;
  processing.add(key);

  try {
    const ageMs = Number(BigInt(Date.now()) * 1000n - msg.createdAt.microsSinceUnixEpoch) / 1000;
    if (ageMs > 30_000) return;

    const conv = conn.db.conversation.id.find(msg.conversationId) as ConversationRow | undefined;
    if (!conv || conv.status.tag !== "Active") return;

    const laterReplies = [
      ...(conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>),
    ].filter(
      (m) =>
        m.conversationId === msg.conversationId &&
        m.sender.tag === "AiUser" &&
        m.createdAt.microsSinceUnixEpoch > msg.createdAt.microsSinceUnixEpoch,
    );
    if (laterReplies.length > 0) return;

    const aiProfile = conn.db.ai_user_profile.aiUserId.find(conv.aiUserId) as AiUserProfileRow | undefined;
    if (!aiProfile) {
      console.warn(`[conversation] AI user profile not found for id=${conv.aiUserId}`);
      return;
    }

    console.log(
      `[conversation] Responding as "${aiProfile.displayName}" in conversation ${conv.id} (page ${conv.pageId})`,
    );

    // Step 1: Create placeholder AI message with Thinking status
    await conn.reducers.sendMessage({
      conversationId: conv.id,
      content: "",
      senderAiUserId: conv.aiUserId,
      jobId: undefined,
      status: { tag: "Thinking" },
      thinking: undefined,
      toolCallsJson: undefined,
    });

    const aiMsgId = await findAiMessageId(conn, conv.id);
    if (!aiMsgId) {
      console.error(`[conversation] Could not find placeholder AI message`);
      return;
    }

    const pageContext = await buildPageContext(conn, conv.pageId);

    // Build WorkspaceContext from SpacetimeDB subscription cache
    const pageRow = conn.db.page.id.find(conv.pageId) as { title: string } | undefined;
    const instructionPages = discoverInstructionPages(conn, conv.pageId);
    const breadcrumb = buildBreadcrumb(conn, conv.pageId);
    const pageHistory = summarizePageHistory(conn, conv.pageId);
    const compactionSummary = loadCompactionSummary(conn, conv.id);

    const workspaceCtx: WorkspaceContext = {
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

    const builder = new SystemPromptBuilder()
      .withWorkspaceContext(workspaceCtx)
      .withAiUserSystemPrompt(
        aiProfile.displayName
          ? `Your name is "${aiProfile.displayName}". You are powered by ${aiProfile.providerName} (${aiProfile.modelName}).`
          : "",
      );

    const systemPrompt = compactionSummary
      ? builder.withCompactionSummary(compactionSummary).render()
      : builder.render();

    // Reconstruct message tail (respects compaction floor)
    const tailMessages = reconstructSessionTail(conn, conv.id);
    // Filter out the placeholder AI message we just created
    const llmMessages: Message[] = tailMessages.filter((m) => {
      // The placeholder message has no content — it won't appear in the tail
      // since reconstructSessionTail only includes messages before the insert.
      // Extra safety: skip assistant messages with empty content arrays.
      return !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0);
    });

    // Prepend page context as a user/assistant pair (same as before)
    if (pageContext) {
      llmMessages.unshift(
        { role: "assistant", content: [{ type: "text", text: "I've reviewed the page context. How can I help?" }] },
      );
      llmMessages.unshift({ role: "user", content: `[Page context]\n${pageContext}` });
    }

    const { provider: defaultProvider, model, maxTokens } = getDefaultProvider();

    const tools: ToolDef[] = getConversationTools() as ToolDef[];
    const allToolCalls: ToolCallInfo[] = [];
    let thinkingText = "";
    let responseText = "";
    let iterations = 0;

    // Step 2: Streaming tool-use loop
    if (defaultProvider.chatStream) {
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

        let doneResponse: StreamEvent & { type: "done" } | null = null;

        for await (const event of defaultProvider.chatStream(streamReq)) {
          if (event.type === "thinking_delta") {
            thinkingText += event.text;
            if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
              await flushMessage(conn, aiMsgId, responseText, "Thinking", thinkingText, allToolCalls);
              lastFlush = Date.now();
            }
          } else if (event.type === "text_delta") {
            responseText += event.text;
            const currentStatus = responseText ? "Streaming" : "Thinking";
            if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
              await flushMessage(conn, aiMsgId, responseText, currentStatus, thinkingText, allToolCalls);
              lastFlush = Date.now();
            }
          } else if (event.type === "tool_use_start") {
            allToolCalls.push({ name: event.block.name, status: "executing" });
            await flushMessage(conn, aiMsgId, responseText, "ToolUse", thinkingText, allToolCalls);
          } else if (event.type === "done") {
            doneResponse = event;
          }
        }

        if (!doneResponse) break;

        const toolBlocks = doneResponse.response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        if (toolBlocks.length === 0 || doneResponse.response.stopReason === "end_turn") {
          const textBlock = doneResponse.response.content.find((b) => b.type === "text");
          if (textBlock?.type === "text") {
            responseText = textBlock.text;
          }
          break;
        }

        // Execute tools
        llmMessages.push({ role: "assistant", content: doneResponse.response.content });

        const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
        for (const block of toolBlocks) {
          const idx = allToolCalls.findIndex(
            (tc) => tc.name === block.name && tc.status === "executing",
          );

          console.log(`[conversation] Tool call [${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`);
          const result = await executeTool(conn, block.name, block.input, BigInt(0));
          console.log(`[conversation] Tool result [${block.name}]: ${result.slice(0, 200)}`);

          if (idx >= 0) {
            allToolCalls[idx].status = "done";
            allToolCalls[idx].result = result.slice(0, 200);
          }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }

        await flushMessage(conn, aiMsgId, responseText, "ToolUse", thinkingText, allToolCalls);
        llmMessages.push({ role: "user", content: toolResults });

        // Reset response text for next iteration's streaming
        responseText = "";
      }
    } else {
      // Fallback: non-streaming path for providers that don't support chatStream
      while (iterations++ < MAX_TOOL_ITERATIONS) {
        const response = await defaultProvider.chat({
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

        const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
        for (const block of toolCalls) {
          console.log(`[conversation] Tool call [${block.name}]: ${JSON.stringify(block.input).slice(0, 200)}`);
          const result = await executeTool(conn, block.name, block.input, BigInt(0));
          console.log(`[conversation] Tool result [${block.name}]: ${result.slice(0, 200)}`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }

        llmMessages.push({ role: "user", content: toolResults });
      }
    }

    // Step 3: Finalize message
    if (!responseText) {
      console.warn(`[conversation] No text response generated for conversation ${conv.id}`);
      await flushMessage(conn, aiMsgId, "(No response generated)", "Error", thinkingText, allToolCalls);
      return;
    }

    await flushMessage(conn, aiMsgId, responseText, "Complete", thinkingText, allToolCalls);

    console.log(
      `[conversation] Responded in conversation ${conv.id} (${responseText.length} chars, thinking: ${thinkingText.length} chars, tools: ${allToolCalls.length})`,
    );
  } catch (err) {
    console.error(
      `[conversation] Failed to respond in conversation ${msg.conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    processing.delete(key);
  }
}

export function registerConversationHandlers(conn: ConnLike): void {
  conn.db.conversation_message.onInsert(
    (_ctx: unknown, msg: ConversationMessageRow) => {
      if (msg.sender.tag === "Human") {
        void handleConversationMessage(conn, msg);
      }
    },
  );

  console.log("[conversation] Handlers registered");
}
