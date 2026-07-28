/**
 * Permission-scoped cross-conversation recall for AI users (ticket 323).
 *
 * Conversation RLS is tracked separately in ticket 333. Until that lands, the
 * public conversation tables cannot be treated as an authorization boundary.
 * Every function in this file therefore derives the caller's AI identity from
 * the authenticated `aiUserId` and only returns conversations where that
 * identity has an active `conversation_participant` row.
 */

import {
  decodeEnumVariant,
  isOptionNone,
  normaliseTs,
  unwrapScalar,
} from "../api-endpoint";
import type { McpContext, StdbTransport } from "./types";

const CONVERSATION_KINDS = [
  "CONTEXT_THREAD",
  "DM",
  "AI_DM",
  "GROUP_DM",
  "SHARED_THREAD",
] as const;
const CONVERSATION_STATUSES = ["ACTIVE", "CLOSED"] as const;
const QUERY_ID_CHUNK = 50;
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;
const READ_LIMIT_DEFAULT = 50;
const READ_LIMIT_MAX = 200;
const READ_CHAR_BUDGET_DEFAULT = 40_000;
const READ_CHAR_BUDGET_MAX = 80_000;

type RawAiProfile = {
  ai_user_id: number | string;
  identity: unknown;
  display_name: string;
};

type RawUser = {
  identity: unknown;
  name: string;
};

type RawParticipant = {
  conversation_id: number | string;
  identity: unknown;
  left_at: unknown;
};

type RawConversation = {
  id: number | string;
  page_id: unknown;
  status: unknown;
  kind: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type RawMessage = {
  id: number | string;
  conversation_id: number | string;
  sender: unknown;
  content: string;
  created_at: unknown;
};

type RawPage = {
  id: number | string;
  title: string;
};

type SenderInfo = {
  identity: string | null;
  systemLabel: string | null;
};

type HistoryData = {
  activeConversationIds: Set<number>;
  aiProfiles: RawAiProfile[];
  participants: RawParticipant[];
  users: RawUser[];
};

type ConversationMessageView = {
  message_id: number;
  author: string;
  is_ai: boolean;
  sender_type: "user" | "ai" | "system";
  content: string;
  created_at: string | null;
  content_truncated?: boolean;
};

function identityString(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value) && value.length === 1) return identityString(value[0]);
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const inner =
      obj.__identity__ ??
      obj.identity ??
      obj.value;
    if (inner !== undefined) return identityString(inner);
  }
  return String(value ?? "").toLowerCase();
}

function optionNumber(value: unknown): number | null {
  const scalar = unwrapScalar(value);
  if (scalar === null) return null;
  const n = Number(scalar);
  return Number.isFinite(n) ? n : null;
}

function scalarString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1) return scalarString(value[0]);
  if (value == null) return "";
  return String(value);
}

function senderInfo(sender: unknown): SenderInfo {
  if (Array.isArray(sender) && sender.length >= 1) {
    const tag = Number(sender[0]);
    const payload = sender[1];
    if (tag === 0) {
      return { identity: identityString(payload), systemLabel: null };
    }
    if (tag === 1) {
      return { identity: null, systemLabel: scalarString(payload) || "system" };
    }
  }
  if (typeof sender === "object" && sender !== null) {
    const obj = sender as Record<string, unknown>;
    const user = obj.user ?? obj.User;
    if (user !== undefined) {
      return { identity: identityString(user), systemLabel: null };
    }
    const system = obj.system ?? obj.System;
    if (system !== undefined) {
      return { identity: null, systemLabel: scalarString(system) || "system" };
    }
  }
  return { identity: null, systemLabel: "system" };
}

function clampInteger(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function compactSnippet(content: string, max = 240): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function parseDateFilter(
  field: "after" | "before",
  raw: unknown,
): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  if (typeof raw !== "string") {
    return { value: null, error: `${field} must be an ISO-8601 date or timestamp` };
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) {
    return { value: null, error: `${field} must be an ISO-8601 date or timestamp` };
  }
  return { value };
}

function orChain(column: string, count: number): string {
  return Array.from({ length: count }, () => `${column} = ?`).join(" OR ");
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function rowsForConversationIds<Row>(
  transport: StdbTransport,
  ids: number[],
  select: string,
  table: "conversation" | "conversation_message",
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const batches = await Promise.all(
    chunks(ids, QUERY_ID_CHUNK).map((batch) =>
      transport.sql<Row>(
        `SELECT ${select} FROM ${table} WHERE ${orChain(
          table === "conversation" ? "id" : "conversation_id",
          batch.length,
        )}`,
        batch,
      ),
    ),
  );
  return batches.flat();
}

async function pagesForIds(transport: StdbTransport, ids: number[]): Promise<RawPage[]> {
  if (ids.length === 0) return [];
  const batches = await Promise.all(
    chunks(ids, QUERY_ID_CHUNK).map((batch) =>
      transport.sql<RawPage>(
        `SELECT id, title FROM page WHERE ${orChain("id", batch.length)}`,
        batch,
      ),
    ),
  );
  return batches.flat();
}

async function loadHistoryAccess(ctx: McpContext): Promise<HistoryData | null> {
  const [aiProfiles, participants, users] = await Promise.all([
    ctx.transport.sql<RawAiProfile>(
      "SELECT ai_user_id, identity, display_name FROM ai_user_profile",
    ),
    ctx.transport.sql<RawParticipant>(
      "SELECT conversation_id, identity, left_at FROM conversation_participant",
    ),
    ctx.transport.sql<RawUser>("SELECT identity, name FROM user"),
  ]);

  const own = aiProfiles.find((p) => String(p.ai_user_id) === String(ctx.aiUserId));
  if (!own) return null;
  const callerIdentity = identityString(own.identity);
  const activeConversationIds = new Set<number>();
  for (const participant of participants) {
    if (identityString(participant.identity) !== callerIdentity) continue;
    if (!isOptionNone(participant.left_at)) continue;
    const conversationId = Number(participant.conversation_id);
    if (Number.isFinite(conversationId)) activeConversationIds.add(conversationId);
  }

  return { activeConversationIds, aiProfiles, participants, users };
}

function authorMaps(data: HistoryData): {
  aiByIdentity: Map<string, string>;
  userByIdentity: Map<string, string>;
} {
  return {
    aiByIdentity: new Map(
      data.aiProfiles.map((profile) => [
        identityString(profile.identity),
        profile.display_name || "AI user",
      ]),
    ),
    userByIdentity: new Map(
      data.users.map((user) => [identityString(user.identity), user.name || "User"]),
    ),
  };
}

function messageView(
  row: RawMessage,
  maps: ReturnType<typeof authorMaps>,
  content = row.content ?? "",
): ConversationMessageView {
  const sender = senderInfo(row.sender);
  if (sender.identity === null) {
    const suffix =
      sender.systemLabel && sender.systemLabel !== "system"
        ? ` (${sender.systemLabel})`
        : "";
    return {
      message_id: Number(row.id),
      author: `system${suffix}`,
      is_ai: false,
      sender_type: "system",
      content,
      created_at: normaliseTs(row.created_at) ?? null,
    };
  }
  const aiName = maps.aiByIdentity.get(sender.identity);
  const userName = maps.userByIdentity.get(sender.identity);
  return {
    message_id: Number(row.id),
    author: aiName ?? userName ?? `${sender.identity.slice(0, 8)}…`,
    is_ai: aiName !== undefined,
    sender_type: aiName !== undefined ? "ai" : "user",
    content,
    created_at: normaliseTs(row.created_at) ?? null,
  };
}

function conversationKind(raw: unknown): string {
  return (decodeEnumVariant(raw, CONVERSATION_KINDS) ?? "CONTEXT_THREAD").toLowerCase();
}

function conversationStatus(raw: unknown): "active" | "closed" {
  return decodeEnumVariant(raw, CONVERSATION_STATUSES) === "CLOSED" ? "closed" : "active";
}

function participantNames(
  conversationId: number,
  allParticipants: RawParticipant[],
  maps: ReturnType<typeof authorMaps>,
): string[] {
  const names: string[] = [];
  for (const row of allParticipants) {
    if (Number(row.conversation_id) !== conversationId || !isOptionNone(row.left_at)) continue;
    const identity = identityString(row.identity);
    const name =
      maps.aiByIdentity.get(identity) ??
      maps.userByIdentity.get(identity) ??
      `${identity.slice(0, 8)}…`;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export async function executeSearchConversations(
  ctx: McpContext,
  input: Record<string, unknown>,
): Promise<string> {
  const access = await loadHistoryAccess(ctx);
  if (!access) {
    return JSON.stringify({ ok: false, error: "AI user profile not found" });
  }

  const after = parseDateFilter("after", input.after);
  if (after.error) return JSON.stringify({ ok: false, error: after.error });
  const before = parseDateFilter("before", input.before);
  if (before.error) return JSON.stringify({ ok: false, error: before.error });
  if (after.value !== null && before.value !== null && after.value >= before.value) {
    return JSON.stringify({ ok: false, error: "after must be earlier than before" });
  }

  const query = typeof input.query === "string" ? input.query.trim() : "";
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const limit = clampInteger(input.limit, SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX);
  const includeCurrent = input.include_current === true;
  const ambientId = ctx.conversationId === undefined ? null : Number(ctx.conversationId);
  const ids = [...access.activeConversationIds].filter(
    (id) => includeCurrent || ambientId === null || id !== ambientId,
  );

  const [conversations, messages] = await Promise.all([
    rowsForConversationIds<RawConversation>(
      ctx.transport,
      ids,
      "id, page_id, status, kind, created_at, updated_at",
      "conversation",
    ),
    rowsForConversationIds<RawMessage>(
      ctx.transport,
      ids,
      "id, conversation_id, sender, content, created_at",
      "conversation_message",
    ),
  ]);

  const pageIds = conversations
    .map((conversation) => optionNumber(conversation.page_id))
    .filter((id): id is number => id !== null);
  const pages = await pagesForIds(ctx.transport, [...new Set(pageIds)]);
  const pageById = new Map(pages.map((page) => [Number(page.id), page.title]));
  const maps = authorMaps(access);
  const messagesByConversation = new Map<number, RawMessage[]>();
  for (const row of messages) {
    const id = Number(row.conversation_id);
    const group = messagesByConversation.get(id) ?? [];
    group.push(row);
    messagesByConversation.set(id, group);
  }

  const results: Array<Record<string, unknown> & { _score: number; _activityMs: number }> = [];
  for (const conversation of conversations) {
    const id = Number(conversation.id);
    const ownMessages = (messagesByConversation.get(id) ?? []).sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    const names = participantNames(id, access.participants, maps);
    const pageId = optionNumber(conversation.page_id);
    const pageTitle = pageId === null ? null : (pageById.get(pageId) ?? null);
    const searchable = [
      pageTitle ?? "",
      ...names,
      ...ownMessages.map((message) => message.content ?? ""),
    ].join("\n").toLowerCase();
    if (terms.length > 0 && !terms.every((term) => searchable.includes(term))) continue;

    const messageDates = ownMessages
      .map((message) => normaliseTs(message.created_at))
      .filter((value): value is string => value !== undefined)
      .map(Date.parse)
      .filter(Number.isFinite);
    const updatedAt = normaliseTs(conversation.updated_at);
    const activityMs = Math.max(
      updatedAt ? Date.parse(updatedAt) : 0,
      ...messageDates,
    );
    if (after.value !== null && activityMs < after.value) continue;
    if (before.value !== null && activityMs >= before.value) continue;

    const matchingMessages =
      terms.length === 0
        ? []
        : ownMessages.filter((message) => {
            const content = (message.content ?? "").toLowerCase();
            return terms.some((term) => content.includes(term));
          });
    const selectedMatches = matchingMessages.slice(-3).reverse();
    const last = ownMessages.at(-1);
    const score =
      matchingMessages.length * 10 +
      terms.filter((term) => (pageTitle ?? "").toLowerCase().includes(term)).length * 3 +
      terms.filter((term) => names.join(" ").toLowerCase().includes(term)).length * 2;

    results.push({
      conversation_id: id,
      kind: conversationKind(conversation.kind),
      status: conversationStatus(conversation.status),
      page_id: pageId,
      page_title: pageTitle,
      participants: names,
      created_at: normaliseTs(conversation.created_at) ?? null,
      updated_at: updatedAt ?? null,
      message_count: ownMessages.length,
      last_message_preview: last ? compactSnippet(last.content ?? "", 200) : null,
      matches: selectedMatches.map((message) => {
        const view = messageView(message, maps);
        return {
          message_id: view.message_id,
          author: view.author,
          created_at: view.created_at,
          snippet: compactSnippet(view.content),
        };
      }),
      _score: score,
      _activityMs: activityMs,
    });
  }

  results.sort((a, b) => b._score - a._score || b._activityMs - a._activityMs);
  const windowed = results.slice(0, limit).map(({ _score, _activityMs, ...result }) => result);
  return JSON.stringify({
    ok: true,
    query,
    after: after.value === null ? null : new Date(after.value).toISOString(),
    before: before.value === null ? null : new Date(before.value).toISOString(),
    conversations: windowed,
    truncated: results.length > windowed.length,
    excluded_current_conversation:
      !includeCurrent && ambientId !== null ? ambientId : null,
  });
}

export async function executeReadConversation(
  ctx: McpContext,
  input: Record<string, unknown>,
): Promise<string> {
  const conversationId = Math.trunc(Number(input.conversation_id));
  if (!Number.isFinite(conversationId) || conversationId < 0) {
    return JSON.stringify({ ok: false, error: "conversation_id must be a non-negative integer" });
  }

  const access = await loadHistoryAccess(ctx);
  if (!access) {
    return JSON.stringify({ ok: false, error: "AI user profile not found" });
  }
  // Deliberately use the same response for absent and unauthorized rows so an
  // AI user cannot probe the existence of private conversations by id.
  if (!access.activeConversationIds.has(conversationId)) {
    return JSON.stringify({ ok: false, error: "Conversation not found or not accessible" });
  }

  const limit = clampInteger(input.limit, READ_LIMIT_DEFAULT, 1, READ_LIMIT_MAX);
  const charBudget = clampInteger(
    input.max_chars,
    READ_CHAR_BUDGET_DEFAULT,
    1_000,
    READ_CHAR_BUDGET_MAX,
  );
  const beforeMessageId =
    input.before_message_id === undefined || input.before_message_id === null
      ? null
      : Math.trunc(Number(input.before_message_id));
  if (
    beforeMessageId !== null &&
    (!Number.isFinite(beforeMessageId) || beforeMessageId < 0)
  ) {
    return JSON.stringify({
      ok: false,
      error: "before_message_id must be a non-negative integer",
    });
  }

  const [conversations, messages] = await Promise.all([
    rowsForConversationIds<RawConversation>(
      ctx.transport,
      [conversationId],
      "id, page_id, status, kind, created_at, updated_at",
      "conversation",
    ),
    rowsForConversationIds<RawMessage>(
      ctx.transport,
      [conversationId],
      "id, conversation_id, sender, content, created_at",
      "conversation_message",
    ),
  ]);
  const conversation = conversations[0];
  if (!conversation) {
    return JSON.stringify({ ok: false, error: "Conversation not found or not accessible" });
  }

  const eligible = messages
    .filter(
      (message) =>
        Number(message.conversation_id) === conversationId &&
        (beforeMessageId === null || Number(message.id) < beforeMessageId),
    )
    .sort((a, b) => Number(a.id) - Number(b.id));
  const byCount = eligible.slice(-limit);
  const maps = authorMaps(access);
  const selected: ConversationMessageView[] = [];
  let remaining = charBudget;
  let omittedForBudget = false;

  for (let i = byCount.length - 1; i >= 0; i--) {
    const row = byCount[i];
    const content = row.content ?? "";
    if (remaining <= 0) {
      omittedForBudget = true;
      break;
    }
    const visibleContent = content.length > remaining ? content.slice(0, remaining) : content;
    const view = messageView(row, maps, visibleContent);
    if (visibleContent.length < content.length) view.content_truncated = true;
    selected.unshift(view);
    remaining -= visibleContent.length;
  }

  const omittedForCount = eligible.length > byCount.length;
  const hasMore = omittedForCount || omittedForBudget;
  const firstMessageId = selected[0]?.message_id;
  const pageId = optionNumber(conversation.page_id);
  const pageRows = pageId === null ? [] : await pagesForIds(ctx.transport, [pageId]);

  return JSON.stringify({
    ok: true,
    conversation_id: conversationId,
    kind: conversationKind(conversation.kind),
    status: conversationStatus(conversation.status),
    page_id: pageId,
    page_title: pageRows[0]?.title ?? null,
    created_at: normaliseTs(conversation.created_at) ?? null,
    updated_at: normaliseTs(conversation.updated_at) ?? null,
    total_message_count: messages.length,
    messages: selected,
    has_more: hasMore,
    next_before_message_id: hasMore && firstMessageId !== undefined ? firstMessageId : null,
  });
}
