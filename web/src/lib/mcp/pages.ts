/**
 * `page` / `page_content` reads over `/sql`, normalized to plain JS rows.
 *
 * SQL-subset constraints honored here (see api-endpoint/dispatcher.ts):
 *   • `parent_id` is Option<u64> and CANNOT be filtered by literal — the
 *     non-null indexed shadow `parent_pk` (0 = root) exists for exactly this.
 *   • `deleted_at` is Option<Timestamp> — decoded client-side, never
 *     compared in SQL.
 *   • No ORDER BY on non-indexed columns — sorting happens in JS.
 */

import type { StdbTransport } from "../api-endpoint";
import type { PageRow } from "./types";
import {
  decodeContentFormat,
  decodePageType,
  isOptionNone,
  toNumberOrNull,
  unwrapScalar,
} from "./decode";

const PAGE_COLUMNS =
  "id, parent_id, title, page_type, content_format, sort_order, deleted_at, updated_at";

type RawPage = {
  id: number | string;
  parent_id: unknown;
  title: string;
  page_type: unknown;
  content_format: unknown;
  sort_order: number | string;
  deleted_at: unknown;
  updated_at: unknown;
};

function decodePage(raw: RawPage): PageRow {
  const updated = unwrapScalar(raw.updated_at);
  return {
    id: Number(raw.id),
    parentId: toNumberOrNull(raw.parent_id),
    title: raw.title,
    pageType: decodePageType(raw.page_type),
    contentFormat: decodeContentFormat(raw.content_format),
    sortOrder: Number(raw.sort_order ?? 0),
    deleted: !isOptionNone(raw.deleted_at),
    updatedAtMicros:
      updated === null ? null : typeof updated === "string" ? Number(updated) : updated,
  };
}

export async function getPageRow(
  transport: StdbTransport,
  pageId: number,
): Promise<PageRow | null> {
  const rows = await transport.sql<RawPage>(
    `SELECT ${PAGE_COLUMNS} FROM page WHERE id = ?`,
    [pageId],
  );
  return rows.length > 0 ? decodePage(rows[0]) : null;
}

/** Live (non-deleted) children of `parentId`; 0 = workspace root. */
export async function listChildren(
  transport: StdbTransport,
  parentId: number,
): Promise<PageRow[]> {
  const rows = await transport.sql<RawPage>(
    `SELECT ${PAGE_COLUMNS} FROM page WHERE parent_pk = ?`,
    [parentId],
  );
  return rows
    .map(decodePage)
    .filter((p) => !p.deleted)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Every live page in the workspace (tables are public; parity with the
 * subscription-cache iteration the WS implementation used). */
export async function allLivePages(transport: StdbTransport): Promise<PageRow[]> {
  const rows = await transport.sql<RawPage>(`SELECT ${PAGE_COLUMNS} FROM page`);
  return rows.map(decodePage).filter((p) => !p.deleted);
}

/** Legacy BlockNote content blob; empty string when absent. */
export async function getPageContent(
  transport: StdbTransport,
  pageId: number,
): Promise<string> {
  const rows = await transport.sql<{ content: string }>(
    "SELECT content FROM page_content WHERE page_id = ?",
    [pageId],
  );
  return rows[0]?.content ?? "";
}
