/**
 * Comment-thread tools for the MCP surface (ticket 14264).
 *
 * The worker exposes equivalents to the chat turn, where the current
 * conversation is implicit. MCP has no ambient conversation, so every tool here
 * takes an explicit `conversation_id` — and `list_page_threads` exists because
 * without discovery the others are unusable: an MCP client has no way to learn
 * a thread id otherwise.
 *
 * Authority is enforced by the module, not here: `send_addressed_message`
 * requires participation, and `close_conversation` / `reopen_conversation`
 * require participation or page-write. So an MCP caller cannot act on a thread
 * it has no standing in, regardless of what it passes.
 */

import type { StdbTransport } from "../api-endpoint";
import { encodeOption, encodeU64 } from "./encode";
import { readCounter } from "./ids";

export type ThreadSummary = {
  conversation_id: number;
  page_id: number | null;
  block_anchor: number | null;
  status: "active" | "resolved";
  message_count: number;
  last_message_preview: string | null;
};

type RawConversation = {
  id: number | string;
  page_id: unknown;
  block_anchor: unknown;
  status: unknown;
  kind: unknown;
};

type RawMessage = {
  id: number | string;
  conversation_id: number | string;
  content: string;
};

/** STDB `/sql` returns Options as `[0, v]` / `[1, []]` and enums as `[idx, []]`. */
function optNum(v: unknown): number | null {
  if (Array.isArray(v) && v.length === 2 && v[0] === 0) {
    const inner = Array.isArray(v[1]) ? v[1][0] : v[1];
    return inner == null ? null : Number(inner);
  }
  return null;
}

function variantIndex(v: unknown): number | null {
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : null;
}

function reducerErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Block-anchored comment threads on a page.
 *
 * Scoped to `ContextThread` with a `block_anchor` — i.e. actual comments, not
 * the AI sidebar's own conversations, which would otherwise flood the result
 * and expose side chats that are not comments on anything.
 */
export async function listPageThreads(
  transport: StdbTransport,
  pageId: number,
  includeResolved: boolean,
): Promise<ThreadSummary[]> {
  // `page_id`/`block_anchor` are Options — unfilterable in STDB SQL — so fetch
  // by the table and decode client-side (same approach as component-tree.ts).
  const rows = await transport.sql<RawConversation>(
    `SELECT id, page_id, block_anchor, status, kind FROM conversation`,
  );

  const threads: ThreadSummary[] = [];
  for (const r of rows) {
    if (optNum(r.page_id) !== pageId) continue;
    const anchor = optNum(r.block_anchor);
    if (anchor === null) continue;
    // ConversationKind::ContextThread is variant 0.
    if (variantIndex(r.kind) !== 0) continue;
    // ConversationStatus::Active is variant 0, Closed is 1.
    const resolved = variantIndex(r.status) === 1;
    if (resolved && !includeResolved) continue;

    threads.push({
      conversation_id: Number(r.id),
      page_id: pageId,
      block_anchor: anchor,
      status: resolved ? "resolved" : "active",
      message_count: 0,
      last_message_preview: null,
    });
  }

  if (threads.length === 0) return threads;

  // One pass over messages to fill counts and a preview, so a caller can tell
  // threads apart without opening each one.
  const byId = new Map(threads.map((t) => [t.conversation_id, t]));
  const msgs = await transport.sql<RawMessage>(
    `SELECT id, conversation_id, content FROM conversation_message`,
  );
  const lastId = new Map<number, number>();
  for (const m of msgs) {
    const cid = Number(m.conversation_id);
    const t = byId.get(cid);
    if (!t) continue;
    t.message_count++;
    const id = Number(m.id);
    if (id >= (lastId.get(cid) ?? -1)) {
      lastId.set(cid, id);
      const text = (m.content ?? "").trim();
      t.last_message_preview = text.length > 160 ? `${text.slice(0, 160)}…` : text || null;
    }
  }

  return threads;
}

/**
 * Start a comment thread anchored to a block.
 *
 * MCP can only create *block-anchored threads on a page* — never a detached or
 * sidebar conversation. A comment on a block is page-visible and belongs to the
 * page; a detached thread is a private side channel, and an agent opening those
 * unprompted is not something this surface should enable.
 *
 * Participants may be AI users or people. On a page-visible thread a participant
 * is a wake list rather than an access grant, so adding someone does not widen
 * who can read it — it says who should look. Tagging a person is how they find
 * out something needs them, which is the point. The caller is added as Initiator
 * by the reducer.
 *
 * `create_conversation` returns nothing (reducers never do), so the new id is
 * recovered from the gap-free `id_counter` the same way `create_page` does.
 */
export async function createThread(
  transport: StdbTransport,
  args: { pageId: number; blockId: number; participants: string[]; content?: string },
): Promise<ThreadActionResult & { block_anchor?: number }> {
  const { pageId, blockId, participants, content } = args;

  // Resolve names → identities across both AI users and people. Anything
  // unmatched is an error rather than a silent drop: a thread that quietly
  // excludes the person you meant to ask is worse than a failed call.
  const identities: string[] = [];
  if (participants.length > 0) {
    const [aiProfiles, people] = await Promise.all([
      transport.sql<{ identity: string; display_name: string }>(
        `SELECT identity, display_name FROM ai_user_profile`,
      ),
      transport.sql<{ identity: string; name: string }>(`SELECT identity, name FROM user`),
    ]);
    const byName = new Map<string, string>();
    const known: string[] = [];
    for (const p of aiProfiles) {
      const n = String(p.display_name).trim();
      if (!n) continue;
      byName.set(n.toLowerCase(), p.identity);
      known.push(n);
    }
    for (const u of people) {
      const n = String(u.name).trim();
      if (!n) continue;
      // AI display names win a collision — they are the ones addressed by tools.
      if (!byName.has(n.toLowerCase())) {
        byName.set(n.toLowerCase(), u.identity);
        known.push(n);
      }
    }

    const missing: string[] = [];
    for (const name of participants) {
      const id = byName.get(name.trim().toLowerCase());
      if (id) {
        if (!identities.includes(id)) identities.push(id);
      } else {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      return {
        ok: false,
        error:
          `Unknown participant(s): ${missing.join(", ")}. ` +
          `Known: ${known.join(", ") || "(none)"}.`,
      };
    }
  }

  const before = await readCounter(transport, "conversation");
  try {
    await transport.call("create_conversation", [
      encodeOption(encodeU64(pageId)),
      identities,
      encodeOption(encodeU64(blockId)),
    ]);
  } catch (err) {
    return { ok: false, error: reducerErrorMessage(err) };
  }

  const after = await readCounter(transport, "conversation");
  if (after <= before) {
    return { ok: false, error: "create_conversation did not allocate a conversation id" };
  }
  const conversationId = after;

  if (content && content.trim()) {
    const posted = await postToThread(transport, conversationId, content);
    if (!posted.ok) {
      // The thread exists either way — report the partial outcome rather than
      // implying nothing happened.
      return {
        ok: true,
        conversation_id: conversationId,
        block_anchor: blockId,
        created: true,
        first_message_error: posted.error,
      };
    }
  }

  return {
    ok: true,
    conversation_id: conversationId,
    block_anchor: blockId,
    created: true,
  };
}

export type ThreadActionResult =
  | { ok: true; conversation_id: number; [k: string]: unknown }
  | { ok: false; error: string };

/**
 * Post into a thread. Mentions are resolved server-side from the text, so an
 * `@Name` in `content` is what addresses (and wakes) a teammate — there is no
 * separate parameter, deliberately, to keep one source of truth.
 */
export async function postToThread(
  transport: StdbTransport,
  conversationId: number,
  content: string,
): Promise<ThreadActionResult> {
  const text = content.trim();
  if (!text) return { ok: false, error: "content is required" };
  try {
    await transport.call("send_addressed_message", [
      encodeU64(conversationId),
      text,
      [],
    ]);
  } catch (err) {
    return { ok: false, error: reducerErrorMessage(err) };
  }
  return { ok: true, conversation_id: conversationId, posted: true };
}

export async function resolveThread(
  transport: StdbTransport,
  conversationId: number,
): Promise<ThreadActionResult> {
  try {
    await transport.call("close_conversation", [encodeU64(conversationId)]);
  } catch (err) {
    return { ok: false, error: reducerErrorMessage(err) };
  }
  return { ok: true, conversation_id: conversationId, resolved: true };
}

export async function reopenThread(
  transport: StdbTransport,
  conversationId: number,
): Promise<ThreadActionResult> {
  try {
    await transport.call("reopen_conversation", [encodeU64(conversationId)]);
  } catch (err) {
    return { ok: false, error: reducerErrorMessage(err) };
  }
  return { ok: true, conversation_id: conversationId, reopened: true };
}
