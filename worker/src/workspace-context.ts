/**
 * WorkspaceContext — replaces claw-code's ProjectContext with SpacetimeDB queries.
 *
 * All data comes from the local SpacetimeDB subscription cache — no IO.
 * Page content is intentionally absent: it is always passed as a tool result,
 * never injected into the system prompt, so the static prompt stays cacheable.
 */

import type { ConnLike } from "./tools.js";

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

// ── AI user private pages (hidden memory subtree) ───────────────────────────

/** Max characters of page body text to inject into the system prompt (across all private pages). */
const AI_USER_PRIVATE_PAGES_CHAR_BUDGET = 48_000;

type AiUserMemoryRow = {
  aiUserId: bigint;
  rootPageId: bigint;
};

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

export interface AiUserPrivatePagesResult {
  pages: InstructionPage[];
  /** True if at least one page body was cut off to stay within the char budget. */
  truncated: boolean;
}

/**
 * Load Doc pages under this AI user's `ai_user_memory.root_page_id` subtree.
 * The subtree is normally hidden from sidebar (`is_hidden`); content is injected
 * into the system prompt so the model keeps persona / notes across turns.
 *
 * If `provision_ai_user_memory` was never run for this user, returns empty pages.
 */
export function discoverAiUserPrivatePages(
  conn: ConnLike,
  aiUserId: bigint,
  maxChars: number = AI_USER_PRIVATE_PAGES_CHAR_BUDGET,
): AiUserPrivatePagesResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memTable = (conn.db as any).ai_user_memory;
  if (!memTable?.iter) {
    return { pages: [], truncated: false };
  }

  let memory: AiUserMemoryRow | undefined;
  for (const row of memTable.iter() as Iterable<{
    aiUserId: bigint;
    rootPageId: bigint;
  }>) {
    if (row.aiUserId === aiUserId) {
      memory = { aiUserId: row.aiUserId, rootPageId: row.rootPageId };
      break;
    }
  }

  if (!memory) {
    return { pages: [], truncated: false };
  }

  const rootId = memory.rootPageId;
  const idSet = collectSubtreePageIds(conn, rootId);
  const ordered = orderSubtreePagesBfs(conn, rootId, idSet);

  const depthMap = new Map<bigint, number>();
  depthMap.set(rootId, 0);
  for (const p of ordered) {
    if (p.id === rootId) continue;
    const pd =
      p.parentId !== undefined ? (depthMap.get(p.parentId) ?? 0) : 0;
    depthMap.set(p.id, pd + 1);
  }

  const pages: InstructionPage[] = [];
  let budget = maxChars;
  let truncated = false;

  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i]!;
    if (p.deletedAt) continue;

    const pageContent = conn.db.page_content?.pageId?.find(p.id) as
      | PageContentRow
      | undefined;
    const full = pageContent?.content ?? "";
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const take = Math.min(full.length, budget);
    const slice = full.slice(0, take);
    if (take < full.length) truncated = true;
    budget -= take;

    pages.push({
      pageId: p.id,
      title: p.title,
      content: slice,
      depth: depthMap.get(p.id) ?? 0,
    });

    if (budget <= 0 && i < ordered.length - 1) {
      truncated = true;
    }
  }

  return { pages, truncated };
}
