/**
 * AI-user private memory over `/sql` — stateless port of the memory helpers
 * in worker/src/workspace-context.ts plus the MCP `remember`/`list_memory`
 * composition from worker/src/mcp/memory.ts.
 *
 * IMPORTANT: `page`/`component_*`/`ai_user_memory` are PUBLIC tables — memory
 * privacy is (a) the server-side write rule provisioned with the subtree and
 * (b) the client-side subtree scope check in `readAiUserMemoryPage` below.
 * Keep the scope check: it is what stops read_memory/remember from touching
 * arbitrary workspace pages. (Parity with the WS implementation, which read
 * the same public tables from its subscription cache.)
 */

import type { StdbTransport } from "../api-endpoint";
import type { McpContext, PageRow } from "./types";
import { allLivePages, getPageContent } from "./pages";
import { readComponentTreeDoc } from "./component-tree";
import { writePageContent } from "./write-content";
import { createPage } from "./create-page";

// ── Subtree resolution ─────────────────────────────────────────────────────────

async function memoryRootId(
  transport: StdbTransport,
  aiUserId: bigint,
): Promise<number | null> {
  const rows = await transport.sql<{ ai_user_id: number | string; root_page_id: number | string }>(
    "SELECT ai_user_id, root_page_id FROM ai_user_memory",
  );
  const own = rows.find((r) => String(r.ai_user_id) === String(aiUserId));
  return own ? Number(own.root_page_id) : null;
}

interface MemorySubtree {
  rootId: number;
  /** BFS order (sortOrder, then id) — root first. */
  ordered: PageRow[];
  depthMap: Map<number, number>;
}

async function resolveMemorySubtree(
  transport: StdbTransport,
  aiUserId: bigint,
): Promise<MemorySubtree | null> {
  const rootId = await memoryRootId(transport, aiUserId);
  if (rootId === null) return null;

  const pages = await allLivePages(transport);
  const byId = new Map(pages.map((p) => [p.id, p]));

  // Fixpoint: collect every live page reachable from the root via parentId.
  const ids = new Set<number>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of pages) {
      if (ids.has(p.id)) continue;
      if (p.parentId !== null && ids.has(p.parentId)) {
        ids.add(p.id);
        changed = true;
      }
    }
  }

  // BFS order with stable sibling order (sortOrder, then id).
  const ordered: PageRow[] = [];
  const queue: number[] = [rootId];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (!row) continue;
    ordered.push(row);
    const children = pages
      .filter((c) => c.parentId === id && ids.has(c.id))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    for (const c of children) queue.push(c.id);
  }

  const depthMap = new Map<number, number>([[rootId, 0]]);
  for (const p of ordered) {
    if (p.id === rootId) continue;
    const pd = p.parentId !== null ? (depthMap.get(p.parentId) ?? 0) : 0;
    depthMap.set(p.id, pd + 1);
  }
  return { rootId, ordered, depthMap };
}

// ── Content + formatting helpers ───────────────────────────────────────────────

async function memoryPageContent(
  transport: StdbTransport,
  pageId: number,
): Promise<string> {
  // Memory pages are ComponentTree; fall back to `page_content` for any
  // legacy BlockNote memory pages provisioned before the format switch.
  const tree = await readComponentTreeDoc(transport, pageId);
  if (tree !== undefined) return tree;
  return getPageContent(transport, pageId);
}

function snippetOf(content: string, max = 200): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function microsToIsoDate(micros: number | null): string | undefined {
  if (micros === null) return undefined;
  const ms = micros / 1000;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Read tools ────────────────────────────────────────────────────────────────

const UNPROVISIONED_ERROR =
  "This AI user has no provisioned memory. Ask the workspace owner to run " +
  "`pnpm mcp:provision` (or enable memory for this AI user in Pear settings).";

export async function executeListMemory(ctx: McpContext): Promise<string> {
  const tree = await resolveMemorySubtree(ctx.transport, ctx.aiUserId);
  if (!tree) return JSON.stringify({ ok: false, error: UNPROVISIONED_ERROR });

  const pages = [];
  for (const p of tree.ordered) {
    const body = await memoryPageContent(ctx.transport, p.id);
    pages.push({
      page_id: p.id,
      title: p.title,
      depth: tree.depthMap.get(p.id) ?? 0,
      snippet: snippetOf(body),
      chars: body.length,
      updated: microsToIsoDate(p.updatedAtMicros),
    });
  }
  return JSON.stringify({ ok: true, pages });
}

export async function executeReadMemory(
  ctx: McpContext,
  input: Record<string, unknown>,
): Promise<string> {
  const pageId = Number(input.page_id);
  const tree = await resolveMemorySubtree(ctx.transport, ctx.aiUserId);
  // Scope check: only pages inside this AI user's own memory subtree are
  // readable through this tool — never an arbitrary workspace page.
  const page = tree?.ordered.find((p) => p.id === pageId);
  if (!page) {
    return JSON.stringify({
      ok: false,
      error: `No memory page ${pageId} in your memory subtree.`,
    });
  }
  const content = await memoryPageContent(ctx.transport, page.id);
  return JSON.stringify({ ok: true, page_id: pageId, title: page.title, content });
}

export async function executeSearchMemory(
  ctx: McpContext,
  input: Record<string, unknown>,
): Promise<string> {
  const query = String(input.query ?? "");
  const tree = await resolveMemorySubtree(ctx.transport, ctx.aiUserId);
  if (!tree) return JSON.stringify({ ok: true, query, matches: [] });

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return JSON.stringify({ ok: true, query, matches: [] });

  type Scored = {
    match: { page_id: number; title: string; snippet: string };
    score: number;
    updatedMicros: number;
  };
  const scored: Scored[] = [];

  for (const page of tree.ordered) {
    const body = await memoryPageContent(ctx.transport, page.id);
    const hayTitle = page.title.toLowerCase();
    const hayBody = body.toLowerCase();

    let score = 0;
    let termsMatched = 0;
    let firstBodyIdx = -1;
    for (const term of terms) {
      const inTitle = hayTitle.includes(term);
      const bodyIdx = hayBody.indexOf(term);
      const inBody = bodyIdx >= 0;
      if (!inTitle && !inBody) continue;
      termsMatched++;
      if (inTitle) score += 3; // title hits weigh more than body hits
      if (inBody) score += 1;
      if (inBody && (firstBodyIdx < 0 || bodyIdx < firstBodyIdx)) firstBodyIdx = bodyIdx;
    }
    if (termsMatched === 0) continue;
    if (termsMatched === terms.length) score += 5; // all-terms beats some-terms

    const snippet =
      firstBodyIdx >= 0
        ? snippetOf(body.slice(Math.max(0, firstBodyIdx - 80), firstBodyIdx + 200), 240)
        : snippetOf(body);
    scored.push({
      match: { page_id: page.id, title: page.title, snippet },
      score,
      updatedMicros: page.updatedAtMicros ?? 0,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.updatedMicros - a.updatedMicros);
  return JSON.stringify({
    ok: true,
    query,
    matches: scored.slice(0, 8).map((s) => s.match),
  });
}

// ── remember ──────────────────────────────────────────────────────────────────

export async function executeRemember(
  ctx: McpContext,
  input: Record<string, unknown>,
): Promise<string> {
  const rootId = await memoryRootId(ctx.transport, ctx.aiUserId);
  if (rootId === null) {
    return JSON.stringify({ ok: false, error: UNPROVISIONED_ERROR });
  }

  const content = typeof input.content === "string" ? input.content : "";
  if (!content.trim()) {
    return JSON.stringify({ ok: false, error: "`content` is required and must be non-empty." });
  }
  const mode = input.mode === "replace" ? "replace" : "append";

  // Update an existing memory page.
  if (input.memory_page_id !== undefined && input.memory_page_id !== null) {
    const pageId = Number(input.memory_page_id);
    const tree = await resolveMemorySubtree(ctx.transport, ctx.aiUserId);
    const existing = tree?.ordered.find((p) => p.id === pageId);
    if (!existing) {
      return JSON.stringify({
        ok: false,
        error: `No memory page ${pageId} in your memory subtree. Use list_memory to see valid ids, or omit memory_page_id to create a new page.`,
      });
    }
    const body = await memoryPageContent(ctx.transport, pageId);
    const markdown =
      mode === "append" && body.trim()
        ? `${body.replace(/\s+$/, "")}\n\n${content}`
        : content;
    const result = await writePageContent(ctx.transport, existing, markdown, {
      snapshot: true,
    });
    return JSON.stringify({ ...result, page_id: pageId, mode });
  }

  // Create a new memory page under the root.
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : undefined;
  if (!title) {
    return JSON.stringify({
      ok: false,
      error: "`title` is required when creating a new memory page (no memory_page_id given).",
    });
  }
  const created = await createPage(ctx.transport, {
    parentId: rootId,
    pageType: "Doc",
    title,
  });
  if (!created.ok || created.page_id === undefined) {
    return JSON.stringify({
      ok: false,
      error: `Failed to create memory page: ${created.error ?? "unknown error"}`,
    });
  }
  const page = {
    id: created.page_id,
    contentFormat: "ComponentTree" as const,
  };
  const wrote = await writePageContent(ctx.transport, page, content, { snapshot: false });
  return JSON.stringify({ ...wrote, page_id: created.page_id, title, created: true });
}
