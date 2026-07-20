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
import { TurnLock } from "./turn-lock.js";
import {
  type Message,
  type ToolUseBlock,
  type ToolDef,
  type StreamEvent,
  type ChatStreamRequest,
  type TokenUsage,
  getProviderForAiUser,
} from "./providers.js";
import { resolveRouting } from "./model-catalog.js";
import { buildPageContext } from "./llm.js";
import { readComponentNodeText } from "./component-authoring.js";
import {
  getConversationTools,
  executeTool,
  toolContextFromAiUserConfigRow,
} from "./tools.js";
import { SystemPromptBuilder } from "./prompt-builder.js";
import {
  discoverInstructionPages,
  discoverAccessibleResources,
  buildAiUserMemoryIndex,
  buildBreadcrumb,
  summarizePageHistory,
  todayIso8601,
  type WorkspaceContext,
} from "./workspace-context.js";
import {
  loadCompactionSummary,
  reconstructSessionTail,
} from "./session-reconstruct.js";
import { resolveConversationAttachments } from "./attachments.js";
import {
  type StoredToolCall,
  cap,
  extractAffected,
  MAX_STORED_INPUT_CHARS,
  MAX_STORED_OUTPUT_CHARS,
} from "./tool-call-record.js";

type ConversationRow = {
  id: bigint;
  pageId: bigint | undefined;
  initiatedBy: { toHexString(): string };
  status: { tag: string };
  createdAt: { microsSinceUnixEpoch: bigint };
  updatedAt: { microsSinceUnixEpoch: bigint };
  blockAnchor: bigint | undefined;
  modelOverride: string | undefined;
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

// Per-conversation turn lock. Ensures at most one in-flight turn per
// (responder, conversation) and remembers a message that arrives mid-turn so
// it is answered AFTER the current turn finishes (queue, not a second
// concurrent turn). See turn-lock.ts + turn-lock.test.ts.
const turnLock = new TurnLock();
const FLUSH_INTERVAL_MS = 300;
const THINKING_BUDGET = 5_000;
const MAX_TOOL_ITERATIONS = 15;

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
 * Server-posted `System(...)` messages the worker must treat as turn triggers
 * even though they are not from another user: a delegated job finishing
 * (`post_job_completion_trigger`), a scheduled routine firing
 * (`run_ai_user_routine`), and a human thumbs-down with a note
 * (`post_feedback_trigger` — the AI can't read the RLS-scoped feedback itself).
 * Each is reconstructed as a user-role note so the AI runs the instruction /
 * addresses the feedback and reports back.
 */
const SYSTEM_TRIGGER_TAGS = new Set([
  "job_completion",
  "routine",
  "feedback",
  "access_resolution",
]);

function isSystemTrigger(msg: ConversationMessageRow): boolean {
  return (
    msg.sender.tag === "System" && SYSTEM_TRIGGER_TAGS.has(String(msg.sender.value))
  );
}

/** True if `msg` should wake the AI user for a turn: a message from another
 * user, or a system trigger (job completion / routine). */
function isTriggerMessage(
  msg: ConversationMessageRow,
  selfHex: string,
): boolean {
  return isFromOtherUser(msg, selfHex) || isSystemTrigger(msg);
}

/** Highest message id currently visible in `conversationId` (0 if none). Used
 * as a correlation boundary: the placeholder we are about to post will have an
 * id strictly greater than this. */
function maxMessageId(conn: ConnLike, conversationId: bigint): bigint {
  let max = 0n;
  for (const m of conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>) {
    if (m.conversationId === conversationId && m.id > max) max = m.id;
  }
  return max;
}

/**
 * Find the placeholder we just created. Auto-inc ids are monotonic, so the row
 * we posted has an id strictly greater than `afterId` (the max captured *before*
 * posting). We return the smallest self-authored `Thinking` message with
 * `id > afterId` — i.e. our own newly-created placeholder — rather than "latest
 * Thinking by self," which could adopt a stale placeholder left by a crashed
 * prior turn or swap placeholders between concurrent turns (assessment #9).
 */
async function findAiMessageId(
  conn: ConnLike,
  conversationId: bigint,
  selfHex: string,
  afterId: bigint,
  retries = 5,
): Promise<bigint | null> {
  for (let i = 0; i < retries; i++) {
    let best: bigint | null = null;
    for (const m of conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>) {
      if (
        m.conversationId === conversationId &&
        m.id > afterId &&
        isFromSelf(m, selfHex) &&
        m.status?.tag === "Thinking" &&
        (best === null || m.id < best)
      ) {
        best = m.id;
      }
    }
    if (best !== null) return best;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * True if a *newer* message from another user exists in the conversation. Only
 * the latest unanswered user message should trigger a reply — earlier ones are
 * folded into its reconstructed context — so we skip a message superseded by a
 * later one (prevents a backlog of replies on reconnect; pairs with #7).
 */
function hasLaterForeignMessage(
  conn: ConnLike,
  msg: ConversationMessageRow,
  selfHex: string,
): boolean {
  for (const m of conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>) {
    if (
      m.conversationId === msg.conversationId &&
      isFromOtherUser(m, selfHex) &&
      m.createdAt.microsSinceUnixEpoch > msg.createdAt.microsSinceUnixEpoch
    ) {
      return true;
    }
  }
  return false;
}

/** Mutable running total of token usage across a turn's LLM calls (#3). */
function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function addUsage(total: TokenUsage, delta: TokenUsage | undefined): void {
  if (!delta) return;
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheCreationInputTokens += delta.cacheCreationInputTokens;
  total.cacheReadInputTokens += delta.cacheReadInputTokens;
}

/**
 * Convert provider/worker failures into a safe, actionable chat message.
 * Never echo the raw provider body: SDK errors can include request metadata or
 * credential-adjacent details that belong in server logs, not the workspace.
 */
export function userVisibleTurnFailure(err: unknown): string {
  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined;
  const cause = record?.cause && typeof record.cause === "object"
    ? (record.cause as Record<string, unknown>)
    : undefined;
  const directStatus = Number(record?.status ?? record?.statusCode ?? cause?.status);
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const is429 = directStatus === 429 || /\b429\b|rate.?limit|overload/i.test(raw);
  if (is429) {
    return (
      "⚠️ The model provider is currently rate-limited or overloaded (429). " +
      "This turn was interrupted before it could finish. Retry the message or switch models."
    );
  }
  const isAuth = directStatus === 401 || directStatus === 403 || /\b(401|403)\b/.test(raw);
  if (isAuth) {
    return (
      "⚠️ The configured model provider rejected its credentials. " +
      "This turn could not finish; check the AI user's provider and API-key settings, then retry."
    );
  }
  return (
    "⚠️ The model provider or worker returned an error before this turn could finish. " +
    "Please retry; if it happens again, check the provider configuration and worker logs."
  );
}

/** u32 columns — clamp the running totals so a long turn can't overflow. */
const U32_MAX = 0xffffffff;
function u32(n: number): number {
  return Math.min(Math.max(0, Math.round(n)), U32_MAX);
}

async function flushMessage(
  conn: ConnLike,
  messageId: bigint,
  content: string,
  status: string,
  thinking: string | undefined,
  toolCalls: StoredToolCall[],
  jobId?: bigint,
  usage?: TokenUsage,
  timelineJson?: string,
): Promise<void> {
  try {
    await conn.reducers.updateMessage({
      messageId,
      content,
      status: { tag: status },
      thinking: thinking || undefined,
      toolCallsJson:
        toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined,
      timelineJson,
      jobId,
      inputTokens: usage ? u32(usage.inputTokens) : undefined,
      outputTokens: usage ? u32(usage.outputTokens) : undefined,
      cacheCreationInputTokens: usage
        ? u32(usage.cacheCreationInputTokens)
        : undefined,
      cacheReadInputTokens: usage ? u32(usage.cacheReadInputTokens) : undefined,
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
    const parsed = JSON.parse(result);
    // A tool result that isn't a JSON object, or whose `ok` is explicitly
    // false, is a failure. Fail closed: a non-object/garbage result must not
    // render as a green "done" pill (assessment #31).
    if (parsed === null || typeof parsed !== "object") return false;
    return parsed.ok !== false;
  } catch {
    // Non-JSON result — cannot confirm success. Fail closed.
    return false;
  }
}

/**
 * Read-only tools. Excluded from the action receipt (they don't represent a
 * mutation the model could falsely claim it "did").
 */
const READ_ONLY_TOOLS = new Set([
  "get_page",
  "get_context",
  "list_pages",
  "list_databases",
  "search_pages",
  "query_database",
  "check_job",
  "list_sensor_findings",
  "fetch_url",
  "web_search",
  // Renders a display-only UI on the message; changes no workspace data.
  "render_ui",
  "read_memory",
  "search_memory",
]);

/**
 * One concise, system-verified line per call: page id, affected blocks, or
 * error. Reads the structured `affected` refs (parsed from the *full* result at
 * persist time, #32) rather than re-parsing a display-truncated snippet — so
 * counts like "N block(s)" are accurate.
 */
function summarizeToolCall(t: StoredToolCall): string {
  if (t.status === "error") {
    let err = "failed";
    try {
      const p = JSON.parse(t.output ?? "") as Record<string, unknown>;
      if (typeof p?.error === "string") err = p.error;
    } catch {
      /* keep generic */
    }
    return err.length > 80 ? `${err.slice(0, 77)}…` : err;
  }
  const a = t.affected;
  if (!a) return "";
  const bits: string[] = [];
  if (a.jobId !== undefined) bits.push(`job ${a.jobId}`);
  if (a.pageId !== undefined) bits.push(`page ${a.pageId}`);
  if (a.propertyDefinitionId !== undefined) bits.push(`property ${a.propertyDefinitionId}`);
  if (a.createdNodeIds?.length) bits.push(`${a.createdNodeIds.length} block(s)`);
  return bits.join(", ");
}

/**
 * Deterministic "action receipt" appended to the finalized message, built from
 * the *actual* tool-call outcomes — not the model's prose. Guarantees the user
 * sees what really happened even if the model over-claims success (the
 * "said it did something it didn't" failure mode). Returns "" when the turn
 * performed no mutating actions.
 */
function buildActionReceipt(toolCalls: StoredToolCall[]): string {
  const actions = toolCalls.filter((t) => !READ_ONLY_TOOLS.has(t.name));
  if (actions.length === 0) return "";
  const lines = actions.map((t) => {
    const icon = t.status === "done" ? "✓" : t.status === "error" ? "✗" : "…";
    const label = t.name.replace(/_/g, " ");
    const detail = summarizeToolCall(t);
    return `- ${icon} ${label}${detail ? ` — ${detail}` : ""}`;
  });
  return `\n\n---\n_Actions this turn (system-verified):_\n${lines.join("\n")}`;
}

/** Extract the job id from a successful `delegate` tool result, if present. */
function delegatedJobIdFromResult(result: string): bigint | undefined {
  try {
    const p = JSON.parse(result) as { ok?: boolean; job_id?: number };
    if (p?.ok === true && typeof p.job_id === "number") return BigInt(p.job_id);
  } catch {
    /* not a delegate result */
  }
  return undefined;
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

/** Latest message in `conversationId` that should trigger a reply — from
 * another user or a job-completion trigger. */
function latestTriggerMessage(
  conn: ConnLike,
  conversationId: bigint,
  selfHex: string,
): ConversationMessageRow | undefined {
  let latest: ConversationMessageRow | undefined;
  for (const m of conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>) {
    if (m.conversationId !== conversationId) continue;
    if (!isTriggerMessage(m, selfHex)) continue;
    if (!latest || m.id > latest.id) latest = m;
  }
  return latest;
}

async function handleConversationMessage(
  conn: ConnLike,
  msg: ConversationMessageRow,
  selfHex: string,
  logTag: string,
  opts: { bypassWatermark?: boolean } = {},
): Promise<void> {
  // Per-conversation turn lock. The dedup key intentionally OMITS the message
  // id: only one turn may run per (responder, conversation) at a time. A
  // message that arrives while a turn is in flight must NOT spawn a second
  // concurrent turn (that produced two interleaved replies in one
  // conversation). Instead we record that the conversation needs a re-check and
  // pick the newest message up when the current turn releases the lock.
  const convKey = `${selfHex}:${msg.conversationId}`;
  // begin() returns false if a turn is already running for this conversation;
  // it records the conversation as pending so this finally-block re-dispatches.
  if (!turnLock.begin(convKey)) return;

  let aiMsgId: bigint | undefined;
  const allToolCalls: StoredToolCall[] = [];
  let thinkingText = "";
  let responseText = "";

  try {
    const conv = conn.db.conversation.id.find(msg.conversationId) as
      | ConversationRow
      | undefined;
    if (!conv || conv.status.tag !== "Active") return;

    if (!isParticipant(conn, conv.id, selfHex)) {
      // Visibility usually prevents this, but bail rather than spam reducers.
      return;
    }

    // Durable inbox (assessment #7): respond based on a per-conversation reply
    // watermark, not a wall-clock age window — so a message sent during an
    // outage longer than the old 5-minute cap is still answered on reconnect.
    //
    // Two guards implement the watermark:
    //   1. If we already replied *after* this message, it's handled — skip.
    //   2. If a *newer* user message exists, that one will reply and carries
    //      this message as context — skip, so a backlog doesn't fan out into
    //      one reply per message.
    let repliedAfter = false;
    for (const m of conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>) {
      if (
        m.conversationId === msg.conversationId &&
        isFromSelf(m, selfHex) &&
        m.createdAt.microsSinceUnixEpoch > msg.createdAt.microsSinceUnixEpoch
      ) {
        repliedAfter = true;
        break;
      }
    }
    // `bypassWatermark` is set only when this call is a re-dispatch fired from
    // the finally-block of a just-finished turn: the message genuinely arrived
    // mid-turn and has NOT been answered, even though an (older) reply now
    // post-dates it, so the timestamp watermark would wrongly skip it.
    if (!opts.bypassWatermark) {
      if (repliedAfter) return;
      if (hasLaterForeignMessage(conn, msg, selfHex)) return;
    }

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

    // Step 1: placeholder message (Thinking). Capture the id boundary first so
    // we can correlate the row we're about to create (its id will exceed this)
    // rather than guessing "latest Thinking" (#9).
    const preMaxId = maxMessageId(conn, conv.id);
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

    aiMsgId = await findAiMessageId(conn, conv.id, selfHex, preMaxId);
    if (!aiMsgId) {
      console.error(`${logTag} could not find placeholder AI message`);
      return;
    }

    let pageContext = conv.pageId
      ? await buildPageContext(conn, conv.pageId)
      : "";
    // Block-anchored ContextThread: surface the anchored component-tree node's
    // text as the primary focus, so the AI knows where the user pointed it.
    if (conv.pageId && conv.blockAnchor != null) {
      const focusText = readComponentNodeText(conn, conv.blockAnchor).trim();
      if (focusText) {
        pageContext +=
          `${pageContext ? "\n\n" : ""}Focused block (node ${conv.blockAnchor}) — the user placed ` +
          `their request on this block; treat it as the primary focus:\n"${focusText.slice(0, 1000)}"`;
      }
    }

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

    // Inject a compact index of the AI user's memory subtree (titles + snippets)
    // rather than dumping ~12K tokens of full bodies each turn; the model opens
    // what it needs via read_memory / search_memory (assessment #19).
    const memoryIndex = buildAiUserMemoryIndex(conn, aiProfile.aiUserId);

    // Pages the user granted this AI access to (the "Context for …" chips).
    // Surfaced in the prompt so the model knows what it can act on — fixes the
    // case where a read grant exists but the AI claims it has no page access.
    const accessibleResources = discoverAccessibleResources(conn, selfHex);

    let builder = new SystemPromptBuilder()
      .withAiUserSystemPrompt(assistantParts.join("\n\n"))
      .withAiUserMemoryIndex(memoryIndex)
      .withAccessibleResources(accessibleResources);
    if (pageContext) builder = builder.withCurrentPageContext(pageContext);
    if (workspaceCtx) builder = builder.withWorkspaceContext(workspaceCtx);
    if (compactionSummary) {
      builder = builder.withCompactionSummary(compactionSummary);
    }
    // Cache-aware system blocks: stable prefix is cached, volatile content last
    // (assessment #8/#21/#22). Providers without caching flatten it to a string.
    const systemBlocks = builder.buildBlocks();

    // Reconstruct message tail (respects compaction floor). Filter out the
    // placeholder we just inserted (no content). Attachments (images via S3,
    // page/block snapshots) resolve into the human turns they were sent with.
    const resolvedAttachments = await resolveConversationAttachments(
      conn,
      conv.id,
      logTag,
    );
    const tailMessages = reconstructSessionTail(
      conn,
      conv.id,
      selfHex,
      resolvedAttachments,
    );
    const llmMessages: Message[] = tailMessages.filter(
      (m) =>
        !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0),
    );
    // Page context is no longer prepended as a synthetic user/assistant turn
    // each request — it now lives in the cached conversation-stable system block
    // (#24), so it's re-read at cache price instead of re-billed every turn.

    const {
      provider: aiProvider,
      model: defaultModel,
      maxTokens,
      providerTag,
    } = getProviderForAiUser(conn, aiProfile.aiUserId);
    // Two-dial routing. The human `modelOverride` pins this thread to a specific
    // model and wins; the agent's tier/effort dials plug into this same call
    // once surfaced (see RoutingChoice). The provider/key/maxTokens still come
    // from ai_user_config, so any chosen model must be one that key can reach.
    // `effort` is threaded into the stream request below and applied only where
    // the resolved model supports it.
    const { model, effort } = resolveRouting(
      { providerTag, model: defaultModel },
      { modelOverride: conv.modelOverride, effort: conv.effortOverride },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiCfg = (conn.db as any).ai_user_config?.id?.find(
      aiProfile.aiUserId,
    ) as { toolSecretsJson?: unknown } | undefined;
    const toolContext = {
      ...toolContextFromAiUserConfigRow(aiCfg),
      conversationId: conv.id,
      currentPageId: conv.pageId,
      aiIdentityHex: selfHex,
      aiUserId: aiProfile.aiUserId,
      // Target for the render_ui tool — the assistant message being authored.
      messageId: aiMsgId,
    };

    const tools: ToolDef[] = getConversationTools() as ToolDef[];
    /** All raw tool result strings this turn — for assessing success when the model omits a text reply. */
    const toolResultLog: string[] = [];
    /** Text emitted in earlier tool iterations of this turn, preserved so the
     * final message reflects the whole turn rather than just the last segment
     * (assessment #30). */
    let narration = "";
    /** Set when the model stopped on `max_tokens` (#29) or we hit the tool-call
     * iteration cap (#12) — surfaced to the user instead of finalizing silently. */
    let truncated = false;
    let toolLimitReached = false;
    let iterations = 0;
    /** First Orcha job this turn spawned via `delegate`, linked to the message
     * so the thread renders it inline as a subagent card. */
    let spawnedJobId: bigint | undefined;
    /** Running token total across every LLM call this turn — persisted on the
     * finalized message so the per-AI-user spend surface is real (#3). */
    const turnUsage = emptyUsage();

    /** Append the current segment to `narration` before it is reset between
     * tool iterations. */
    const accrueNarration = () => {
      const seg = responseText.trim();
      if (seg) narration += (narration ? "\n\n" : "") + seg;
      responseText = "";
    };

    /** Cumulative on-screen text: earlier-iteration narration plus the segment
     * currently streaming. Streaming flushes use this (not bare `responseText`)
     * so the message grows monotonically instead of blanking each time
     * `accrueNarration` resets `responseText` at a tool boundary. */
    const visibleContent = () =>
      narration
        ? responseText
          ? `${narration}\n\n${responseText}`
          : narration
        : responseText;

    /** Render-only ordered timeline of the turn: text segments and tool refs in
     * the order they occurred, so the client can interleave tool cards between
     * prose instead of stacking them all at the top (#inline-tools). Tools are
     * stored by id; the client looks up name/status/output in `tool_calls_json`.
     * `content` + `tool_calls_json` are unchanged and remain the source of truth
     * for session reconstruction. */
    type TimelineBlock = { t: "text"; text: string } | { t: "tool"; id: string };
    const timeline: TimelineBlock[] = [];
    // How many of `allToolCalls` are already represented in `timeline`. The rest
    // belong to the in-progress iteration.
    let committedTools = 0;
    /** Committed timeline plus the in-progress iteration (live streaming text +
     * any tools started but not yet committed). Sent on every streaming flush. */
    const liveTimeline = (): TimelineBlock[] => {
      const live = timeline.slice();
      const seg = responseText.trim();
      if (seg) live.push({ t: "text", text: seg });
      for (let i = committedTools; i < allToolCalls.length; i++) {
        live.push({ t: "tool", id: allToolCalls[i].id });
      }
      return live;
    };
    /** Fold the in-progress iteration (current text segment + new tools) into the
     * committed timeline. Call before `accrueNarration` resets `responseText`. */
    const commitTimeline = () => {
      const seg = responseText.trim();
      if (seg) timeline.push({ t: "text", text: seg });
      for (let i = committedTools; i < allToolCalls.length; i++) {
        timeline.push({ t: "tool", id: allToolCalls[i].id });
      }
      committedTools = allToolCalls.length;
    };

    if (aiProvider.chatStream) {
      let cleanFinish = false;
      while (iterations++ < MAX_TOOL_ITERATIONS) {
        let lastFlush = Date.now();

        // Extended thinking shares the `max_tokens` budget with the visible
        // answer, so the thinking budget must be ADDED on top of the desired
        // output budget — not max()'d with it, which left only ~4k tokens for
        // the answer and truncated long replies (assessment #28).
        const effectiveMaxTokens = maxTokens + THINKING_BUDGET;
        const streamReq: ChatStreamRequest = {
          model,
          maxTokens: effectiveMaxTokens,
          system: systemBlocks,
          messages: llmMessages,
          tools: tools.length > 0 ? tools : undefined,
          thinkingBudget: THINKING_BUDGET,
          effort,
        };

        let doneResponse: (StreamEvent & { type: "done" }) | null = null;

        for await (const event of aiProvider.chatStream(streamReq)) {
          if (event.type === "thinking_delta") {
            thinkingText += event.text;
            if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
              await flushMessage(
                conn,
                aiMsgId,
                visibleContent(),
                "Thinking",
                thinkingText,
                allToolCalls,
                undefined,
                undefined,
                JSON.stringify(liveTimeline()),
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
                visibleContent(),
                currentStatus,
                thinkingText,
                allToolCalls,
                undefined,
                undefined,
                JSON.stringify(liveTimeline()),
              );
              lastFlush = Date.now();
            }
          } else if (event.type === "tool_use_start") {
            // Emitted at content_block_stop, so id + input are already complete.
            allToolCalls.push({
              type: "tool_use",
              id: event.block.id,
              name: event.block.name,
              input: cap(JSON.stringify(event.block.input ?? {}), MAX_STORED_INPUT_CHARS),
              status: "executing",
            });
            await flushMessage(
              conn,
              aiMsgId,
              visibleContent(),
              "ToolUse",
              thinkingText,
              allToolCalls,
              undefined,
              undefined,
              JSON.stringify(liveTimeline()),
            );
          } else if (event.type === "done") {
            doneResponse = event;
          }
        }

        if (!doneResponse) break;

        addUsage(turnUsage, doneResponse.response.usage);

        const toolBlocks = doneResponse.response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        const stopReason = doneResponse.response.stopReason;
        if (
          toolBlocks.length === 0 ||
          stopReason === "end_turn" ||
          stopReason === "max_tokens"
        ) {
          // `max_tokens` mid-tool-call can leave tool input JSON incomplete, so
          // we stop here rather than execute a possibly-truncated call (#29).
          const textBlock = doneResponse.response.content.find(
            (b) => b.type === "text",
          );
          if (textBlock?.type === "text") {
            responseText = textBlock.text;
          }
          if (stopReason === "max_tokens") truncated = true;
          cleanFinish = true;
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
          const idx = allToolCalls.findIndex((tc) => tc.id === block.id);

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

          const ok = toolResultWasOk(result);
          if (idx >= 0) {
            allToolCalls[idx].status = ok ? "done" : "error";
            allToolCalls[idx].output = cap(result, MAX_STORED_OUTPUT_CHARS);
            allToolCalls[idx].isError = !ok;
            allToolCalls[idx].affected = extractAffected(result);
          }
          if (spawnedJobId === undefined && block.name === "delegate") {
            spawnedJobId = delegatedJobIdFromResult(result);
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
          visibleContent(),
          "ToolUse",
          thinkingText,
          allToolCalls,
          spawnedJobId,
          undefined,
          JSON.stringify(liveTimeline()),
        );
        llmMessages.push({ role: "user", content: toolResults });

        // Fold this iteration's prose + tools into the render timeline, then
        // preserve the prose for the final content composition (#30).
        commitTimeline();
        accrueNarration();
      }
      if (!cleanFinish) toolLimitReached = true;
    } else {
      let cleanFinish = false;
      while (iterations++ < MAX_TOOL_ITERATIONS) {
        const response = await aiProvider.chat({
          model,
          maxTokens,
          system: systemBlocks,
          messages: llmMessages,
          tools: tools.length > 0 ? tools : undefined,
        });

        addUsage(turnUsage, response.usage);

        const toolCalls = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        const textBlock = response.content.find((b) => b.type === "text");
        if (textBlock?.type === "text") {
          responseText = textBlock.text;
        }

        if (
          toolCalls.length === 0 ||
          response.stopReason === "end_turn" ||
          response.stopReason === "max_tokens"
        ) {
          if (response.stopReason === "max_tokens") truncated = true;
          cleanFinish = true;
          break;
        }

        llmMessages.push({ role: "assistant", content: response.content });

        const toolResults: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
        }[] = [];
        for (const block of toolCalls) {
          const inputStr = cap(JSON.stringify(block.input), MAX_STORED_INPUT_CHARS);
          allToolCalls.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: inputStr,
            status: "executing",
          });
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
          const ok = toolResultWasOk(result);
          allToolCalls[tcIdx] = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: inputStr,
            status: ok ? "done" : "error",
            output: cap(result, MAX_STORED_OUTPUT_CHARS),
            isError: !ok,
            affected: extractAffected(result),
          };
          if (spawnedJobId === undefined && block.name === "delegate") {
            spawnedJobId = delegatedJobIdFromResult(result);
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }

        llmMessages.push({ role: "user", content: toolResults });

        // Fold this iteration's prose + tools into the render timeline, then
        // preserve the prose for the final content composition (#30).
        commitTimeline();
        accrueNarration();
      }
      if (!cleanFinish) toolLimitReached = true;
    }

    // Fold the final iteration (closing prose + any tools left uncommitted, e.g.
    // unexecuted tool blocks on a max_tokens stop) into the render timeline.
    commitTimeline();

    // Compose the full turn: earlier-iteration narration + final segment (#30).
    if (narration) {
      const finalSeg = responseText.trim();
      responseText = finalSeg ? `${narration}\n\n${finalSeg}` : narration;
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

    // Surface truncation rather than presenting a cut-off answer as a clean
    // success (assessment #29 / #12).
    if (truncated) {
      console.warn(`${logTag} response truncated on max_tokens in conversation ${conv.id}`);
      const warn = "_⚠️ This response was cut off at the length limit. Ask me to continue._";
      responseText = `${responseText}\n\n${warn}`.trim();
      timeline.push({ t: "text", text: warn });
    } else if (toolLimitReached) {
      console.warn(
        `${logTag} hit tool-iteration cap (${MAX_TOOL_ITERATIONS}) in conversation ${conv.id}`,
      );
      const warn = `_⚠️ I stopped after ${MAX_TOOL_ITERATIONS} tool steps. Ask me to continue if the task isn't finished._`;
      responseText = `${responseText}\n\n${warn}`.trim();
      timeline.push({ t: "text", text: warn });
    }

    // Append a deterministic, system-verified record of what the tools actually
    // did, so the user sees ground truth regardless of how the model narrated
    // it (prevents "claimed it did something it didn't").
    responseText = `${responseText}${buildActionReceipt(allToolCalls)}`;

    // (Removed the inline LLM "intent check" banner: it fired a utility-model
    // call on every mutating turn and surfaced a noisy ⚠️/✓ line the user found
    // unhelpful. Human review of agent actions now lives in the message feedback
    // control in the UI — a durable thumbs up/down signal instead of an advisory
    // the model graded itself on.)

    await flushMessage(
      conn,
      aiMsgId,
      responseText,
      "Complete",
      thinkingText,
      allToolCalls,
      spawnedJobId,
      turnUsage,
      timeline.length > 0 ? JSON.stringify(timeline) : undefined,
    );

    console.log(
      `${logTag} responded in conversation ${conv.id} (${responseText.length} chars, thinking: ${thinkingText.length} chars, tools: ${allToolCalls.length}, truncated: ${truncated}, toolLimit: ${toolLimitReached}, tokens: in=${turnUsage.inputTokens} out=${turnUsage.outputTokens} cacheRead=${turnUsage.cacheReadInputTokens})`,
    );
  } catch (err) {
    console.error(
      `${logTag} failed to respond in conversation ${msg.conversationId}:`,
      err instanceof Error ? err.message : err,
    );
    if (aiMsgId !== undefined) {
      const failure = userVisibleTurnFailure(err);
      const partial = responseText.trim();
      const content = partial ? `${partial}\n\n---\n\n${failure}` : failure;
      await flushMessage(
        conn,
        aiMsgId,
        content,
        "Error",
        thinkingText,
        allToolCalls,
      );
    }
  } finally {
    // end() returns true if a message arrived mid-turn and was deferred.
    // Queue-on-release: pick up the newest one now, bypassing the timestamp
    // watermark (the reply we just sent post-dates it).
    if (turnLock.end(convKey)) {
      const latest = latestTriggerMessage(conn, msg.conversationId, selfHex);
      if (latest && latest.id > msg.id) {
        void handleConversationMessage(conn, latest, selfHex, logTag, {
          bypassWatermark: true,
        });
      }
    }
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
      // Wake on a message from another user, or on a job-completion trigger the
      // server posted for a job this AI delegated. `isParticipant` +
      // watermark guards inside handleConversationMessage keep this scoped.
      if (isTriggerMessage(msg, selfHex)) {
        void handleConversationMessage(conn, msg, selfHex, logTag);
      }
    },
  );

  console.log(`${logTag} handlers registered (self=${selfHex.slice(0, 12)}…)`);
}

/**
 * Catch-up sweep on (re)connect. Instead of a wall-clock age filter (which
 * dropped messages sent during an outage longer than 5 minutes, #7), we take
 * the *latest* user message per conversation and let `handleConversationMessage`
 * decide via the reply watermark whether it still needs an answer. Earlier
 * messages are folded into that reply's reconstructed context, so we don't fan
 * out one reply per backlog message.
 */
export async function processRecentConversationMessages(
  conn: ConnLike,
  selfIdentity: Identity,
  logTag = "[conversation]",
): Promise<void> {
  const selfHex = selfIdentity.toHexString();

  // Latest trigger (foreign message or job-completion trigger) per conversation.
  // A job that completed while this worker was offline left a trigger we still
  // owe a verify+report turn on; the reply watermark inside
  // handleConversationMessage dedups anything already answered.
  const latestByConv = new Map<bigint, ConversationMessageRow>();
  for (const msg of conn.db.conversation_message.iter() as Iterable<ConversationMessageRow>) {
    if (!isTriggerMessage(msg, selfHex)) continue;
    const current = latestByConv.get(msg.conversationId);
    if (
      !current ||
      msg.createdAt.microsSinceUnixEpoch > current.createdAt.microsSinceUnixEpoch
    ) {
      latestByConv.set(msg.conversationId, msg);
    }
  }

  if (latestByConv.size === 0) return;

  console.log(
    `${logTag} catch-up: ${latestByConv.size} conversation(s) with a pending trigger`,
  );
  for (const msg of latestByConv.values()) {
    await handleConversationMessage(conn, msg, selfHex, logTag);
  }
}
