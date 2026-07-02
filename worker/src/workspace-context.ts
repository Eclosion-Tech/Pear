/**
 * WorkspaceContext — replaces claw-code's ProjectContext with SpacetimeDB queries.
 *
 * All data comes from the local SpacetimeDB subscription cache — no IO.
 * A bounded snapshot of the attached page is placed in the cached, conversation-
 * stable system block (#24) so it's re-read at cache price rather than re-billed
 * each turn; the model calls `get_page` for the live/full content on demand.
 */

import type { ConnLike } from "./tools.js";
import { readComponentTreeDoc } from "./component-authoring.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InstructionPage {
  pageId: bigint;
  title: string;
  content: string;
  /** Depth from workspace root — root-level pages appear first, current page last. */
  depth: number;
}

export interface PageHistorySummary {
  summary: string;
  snapshotCount: number;
  lastSnapshotType: string | undefined;
}

/**
 * A page this conversation's AI user has been explicitly granted access to via
 * `page_access_rule` (the "Context for …" chips). Surfaced in the system prompt
 * so the model knows what it can act on without guessing (it can read/edit these
 * page IDs directly), rather than discovering grants only when a tool succeeds.
 */
export interface AccessibleResource {
  pageId: bigint;
  title: string;
  permission: "Read" | "Write";
}

export interface WorkspaceContext {
  /** The page the agent is currently operating on. */
  currentPageId: bigint;
  currentPageTitle: string;
  /** Path of page titles from workspace root to current page. */
  breadcrumb: string[];
  currentDate: string;
  aiDisplayName: string;
  modelName: string;
  providerName: string;
  /**
   * Instruction pages discovered by walking the page hierarchy root-first.
   * Only pages with agent_instruction=Checkbox(true) property are included.
   */
  instructionPages: InstructionPage[];
  pageHistory: PageHistorySummary | undefined;
}

// ── Internal row shapes ───────────────────────────────────────────────────────

type PageRow = {
  id: bigint;
  parentId: bigint | undefined;
  title: string;
  sortOrder: number;
  deletedAt?: unknown;
  updatedAt?: { microsSinceUnixEpoch: bigint };
};

type PropertyDefinitionRow = {
  id: bigint;
  schemaId: bigint;
  name: string;
  propertyType: { tag: string };
};

type PagePropertyValueRow = {
  pageId: bigint;
  propertyDefinitionId: bigint;
  value: { tag: string; value: unknown };
};

type PageSnapshotRow = {
  pageId: bigint;
  snapshotType: { tag: string };
  snapshotAt: { microsSinceUnixEpoch: bigint };
};

type PageContentRow = {
  pageId: bigint;
  content: string;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Walk the parent_id chain from currentPageId to the workspace root.
 * Returns page rows in root-first order (shallowest ancestor first, current page last).
 */
function walkAncestors(conn: ConnLike, currentPageId: bigint): PageRow[] {
  const chain: PageRow[] = [];
  let pageId: bigint | undefined = currentPageId;
  const visited = new Set<bigint>();

  while (pageId !== undefined) {
    if (visited.has(pageId)) break;
    visited.add(pageId);
    const page = conn.db.page.id.find(pageId) as PageRow | undefined;
    if (!page) break;
    chain.unshift(page); // prepend so root is first
    pageId = page.parentId;
  }

  return chain;
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Discover instruction pages by walking the ancestor chain from currentPageId.
 * Returns pages with agent_instruction=Checkbox(true), ordered root-first.
 *
 * Returns an empty array if the agent_instruction property does not exist
 * (pre-seed workspaces) — workers degrade gracefully.
 */
export function discoverInstructionPages(
  conn: ConnLike,
  currentPageId: bigint,
): InstructionPage[] {
  const agentInstructionProp = [
    ...(conn.db.property_definition.iter() as Iterable<PropertyDefinitionRow>),
  ].find((p) => p.name === "agent_instruction");

  if (!agentInstructionProp) {
    return [];
  }

  const ancestors = walkAncestors(conn, currentPageId);
  const result: InstructionPage[] = [];

  for (let i = 0; i < ancestors.length; i++) {
    const page = ancestors[i];
    if (page.deletedAt) continue;

    const hasFlag = [...(conn.db.page_property_value.iter() as Iterable<PagePropertyValueRow>)].some(
      (pv) =>
        pv.pageId === page.id &&
        pv.propertyDefinitionId === agentInstructionProp.id &&
        pv.value.tag === "Checkbox" &&
        pv.value.value === true,
    );

    if (!hasFlag) continue;

    const pageContent = conn.db.page_content?.pageId?.find(page.id) as
      | PageContentRow
      | undefined;

    result.push({
      pageId: page.id,
      title: page.title,
      content: pageContent?.content ?? "",
      depth: i,
    });
  }

  return result;
}

/** Build the breadcrumb path from workspace root to the current page (titles only). */
export function buildBreadcrumb(conn: ConnLike, currentPageId: bigint): string[] {
  return walkAncestors(conn, currentPageId).map((p) => p.title);
}

/**
 * Enumerate the pages this AI user has been granted access to, mirroring the
 * `page_access_rule` enforcement in tools.ts (`hasChatPageGrant`) and the
 * "Context for …" chips in ContextBar. Dedups per page, keeping the strongest
 * permission (Write > Read). The host page is intentionally NOT added here — it
 * already appears in the Environment section as the current page.
 */
export function discoverAccessibleResources(
  conn: ConnLike,
  aiIdentityHex: string,
): AccessibleResource[] {
  const rows = conn.db.page_access_rule?.iter?.() as
    | Iterable<{ pageId: bigint; principal: unknown; permission: { tag?: string } }>
    | undefined;
  if (!rows) return [];

  const byPage = new Map<string, AccessibleResource>();
  for (const row of rows) {
    const p = row.principal as { tag?: string; value?: { toHexString?: () => string } };
    if (p?.tag !== "WorkspaceMember") continue;
    if (p.value?.toHexString?.() !== aiIdentityHex) continue;
    const tag = row.permission?.tag;
    if (tag !== "Read" && tag !== "Write") continue;

    const key = String(row.pageId);
    const existing = byPage.get(key);
    // Write supersedes Read; keep the strongest grant per page.
    if (existing && (existing.permission === "Write" || tag === "Read")) continue;

    const page = conn.db.page?.id?.find?.(row.pageId) as { title?: string } | undefined;
    byPage.set(key, {
      pageId: row.pageId,
      title: page?.title || `#${row.pageId}`,
      permission: tag,
    });
  }
  return [...byPage.values()];
}

/**
 * Summarize recent snapshot history for a page.
 * Returns undefined if no snapshots exist.
 */
export function summarizePageHistory(
  conn: ConnLike,
  pageId: bigint,
): PageHistorySummary | undefined {
  const snapshots = [...(conn.db.page_snapshot.iter() as Iterable<PageSnapshotRow>)]
    .filter((s) => s.pageId === pageId)
    .sort((a, b) => Number(b.snapshotAt.microsSinceUnixEpoch - a.snapshotAt.microsSinceUnixEpoch));

  if (snapshots.length === 0) return undefined;

  const nowMicros = BigInt(Date.now()) * 1000n;
  const sevenDaysAgoMicros = nowMicros - BigInt(7 * 24 * 60 * 60 * 1_000_000);
  const recentCount = snapshots.filter(
    (s) => s.snapshotAt.microsSinceUnixEpoch >= sevenDaysAgoMicros,
  ).length;

  const lastType = snapshots[0].snapshotType.tag;

  return {
    summary: `${recentCount} snapshot${recentCount !== 1 ? "s" : ""} in the last 7 days. Last: ${lastType}.`,
    snapshotCount: snapshots.length,
    lastSnapshotType: lastType,
  };
}

/** Return today's date as an ISO 8601 date string (YYYY-MM-DD). */
export function todayIso8601(): string {
  return new Date().toISOString().split("T")[0]!;
}

// ── AI user memory subtree (hidden persona / notes pages) ───────────────────

function collectSubtreePageIds(conn: ConnLike, rootId: bigint): Set<bigint> {
  const ids = new Set<bigint>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of conn.db.page.iter() as Iterable<PageRow>) {
      if (p.deletedAt) continue;
      if (ids.has(p.id)) continue;
      const par = p.parentId;
      if (par !== undefined && ids.has(par)) {
        ids.add(p.id);
        changed = true;
      }
    }
  }
  return ids;
}

/**
 * Breadth-first order under `rootId`: stable sibling order via `sort_order`, then id.
 */
function orderSubtreePagesBfs(
  conn: ConnLike,
  rootId: bigint,
  idSet: Set<bigint>,
): PageRow[] {
  const byId = new Map<bigint, PageRow>();
  for (const p of conn.db.page.iter() as Iterable<PageRow>) {
    if (idSet.has(p.id)) byId.set(p.id, p);
  }
  const result: PageRow[] = [];
  const queue: bigint[] = [rootId];
  const seen = new Set<bigint>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (!row) continue;
    result.push(row);

    const children = [...byId.values()]
      .filter((c) => c.parentId === id)
      .sort(
        (a, b) =>
          Number((a.sortOrder ?? 0) - (b.sortOrder ?? 0)) ||
          Number(a.id - b.id),
      );
    for (const c of children) queue.push(c.id);
  }

  return result;
}

// ── AI user memory: on-demand index + read/search (assessment #19) ───────────

/** Resolve the AI user's memory subtree to an ordered page list + depth map. */
function resolveMemorySubtree(
  conn: ConnLike,
  aiUserId: bigint,
): { rootId: bigint; ordered: PageRow[]; depthMap: Map<bigint, number> } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memTable = (conn.db as any).ai_user_memory;
  if (!memTable?.iter) return null;

  let rootId: bigint | undefined;
  for (const row of memTable.iter() as Iterable<{ aiUserId: bigint; rootPageId: bigint }>) {
    if (row.aiUserId === aiUserId) {
      rootId = row.rootPageId;
      break;
    }
  }
  if (rootId === undefined) return null;

  const idSet = collectSubtreePageIds(conn, rootId);
  const ordered = orderSubtreePagesBfs(conn, rootId, idSet).filter((p) => !p.deletedAt);

  const depthMap = new Map<bigint, number>([[rootId, 0]]);
  for (const p of ordered) {
    if (p.id === rootId) continue;
    const pd = p.parentId !== undefined ? (depthMap.get(p.parentId) ?? 0) : 0;
    depthMap.set(p.id, pd + 1);
  }
  return { rootId, ordered, depthMap };
}

/** Collapse whitespace and clip to `max` chars for a one-line preview. */
function snippetOf(content: string, max = 200): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** SpacetimeDB micros-since-epoch → `YYYY-MM-DD`, or undefined if unset. */
function microsToIsoDate(micros: bigint | undefined): string | undefined {
  if (micros === undefined) return undefined;
  const ms = Number(micros / 1000n);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

function memoryPageContent(conn: ConnLike, pageId: bigint): string {
  // Memory pages are ComponentTree, whose body lives in `ComponentNode` rows —
  // `page_content` is empty for them. Fall back to `page_content` for any
  // legacy BlockNote memory pages provisioned before the format switch.
  const tree = readComponentTreeDoc(conn, pageId);
  if (tree !== undefined) return tree;
  const row = conn.db.page_content?.pageId?.find(pageId) as PageContentRow | undefined;
  return row?.content ?? "";
}

export interface AiUserMemoryEntry {
  pageId: bigint;
  title: string;
  depth: number;
  /** One-line preview of the body. */
  snippet: string;
  /** Full body length, so the model can judge whether to open it. */
  chars: number;
  /** Last-updated date (`YYYY-MM-DD`), so the model can judge staleness. */
  updated?: string;
}

/**
 * Lightweight index of every page in the AI user's memory subtree — title, id,
 * depth, size, and a one-line snippet. Injected each turn in place of the full
 * ~12K-token body dump (#19); the model opens what it needs via `read_memory` /
 * `search_memory`. Empty when the user has no provisioned memory.
 */
export function buildAiUserMemoryIndex(
  conn: ConnLike,
  aiUserId: bigint,
): AiUserMemoryEntry[] {
  const tree = resolveMemorySubtree(conn, aiUserId);
  if (!tree) return [];
  return tree.ordered.map((p) => {
    const body = memoryPageContent(conn, p.id);
    return {
      pageId: p.id,
      title: p.title,
      depth: tree.depthMap.get(p.id) ?? 0,
      snippet: snippetOf(body),
      chars: body.length,
      updated: microsToIsoDate(p.updatedAt?.microsSinceUnixEpoch),
    };
  });
}

/**
 * Read one memory page's full body. Scope-checked: returns null unless `pageId`
 * is inside this AI user's own memory subtree (so the tool can't read arbitrary
 * workspace pages).
 */
export function readAiUserMemoryPage(
  conn: ConnLike,
  aiUserId: bigint,
  pageId: bigint,
): { title: string; content: string } | null {
  const tree = resolveMemorySubtree(conn, aiUserId);
  if (!tree) return null;
  const page = tree.ordered.find((p) => p.id === pageId);
  if (!page) return null;
  return { title: page.title, content: memoryPageContent(conn, page.id) };
}

export interface AiUserMemoryMatch {
  pageId: bigint;
  title: string;
  /** Snippet centered on the match (or the page head if matched in the title). */
  snippet: string;
}

/**
 * Tokenized, scored search across this AI user's memory pages (title + body).
 * The query is split into terms; a page scores on how many terms it matches and
 * where — a title hit weighs more than a body hit, and matching *all* terms beats
 * matching only some. Ties break toward the most recently updated page. Returns
 * the top `limit` matches, each with a snippet centered on the first body hit
 * (or the page head when only the title matched).
 */
export function searchAiUserMemory(
  conn: ConnLike,
  aiUserId: bigint,
  query: string,
  limit = 8,
): AiUserMemoryMatch[] {
  const tree = resolveMemorySubtree(conn, aiUserId);
  if (!tree) return [];
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];

  type Scored = { match: AiUserMemoryMatch; score: number; updatedMicros: bigint };
  const scored: Scored[] = [];

  for (const page of tree.ordered) {
    const body = memoryPageContent(conn, page.id);
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
      match: { pageId: page.id, title: page.title, snippet },
      score,
      updatedMicros: page.updatedAt?.microsSinceUnixEpoch ?? 0n,
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.updatedMicros < b.updatedMicros
        ? 1
        : a.updatedMicros > b.updatedMicros
          ? -1
          : 0),
  );
  return scored.slice(0, limit).map((s) => s.match);
}
