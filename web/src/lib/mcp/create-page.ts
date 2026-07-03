/**
 * Stateless `create_page` (+ Database schema bootstrap) with id discovery
 * via the gap-free `id_counter` (see ids.ts).
 */

import type { StdbTransport } from "../api-endpoint";
import { encodeOption, encodePageType, encodeU64 } from "./encode";
import { discoverAllocatedId, readCounter } from "./ids";
import { reducerErrorMessage } from "./errors";

export interface CreatePageResult {
  ok: boolean;
  error?: string;
  page_id?: number;
  title?: string;
  page_type?: string;
  schema_id?: number;
  schema_warning?: string;
  next_step?: string;
}

export async function createPage(
  transport: StdbTransport,
  args: { parentId: number; pageType: "Doc" | "Database"; title: string },
): Promise<CreatePageResult> {
  const { parentId, pageType, title } = args;

  const before = await readCounter(transport, "page");
  try {
    await transport.call("create_page", [
      // parent_id = 0 means root → Option::None.
      encodeOption(parentId > 0 ? encodeU64(parentId) : undefined),
      encodePageType(pageType),
      title,
    ]);
  } catch (err) {
    return { ok: false, error: reducerErrorMessage(err) };
  }

  const pageId = await discoverAllocatedId(transport, "page", before, async (lo, hi) => {
    // Concurrent writer interleaved — find our page by parent + title in the
    // allocation window; newest id wins.
    const rows = await transport.sql<{ id: number | string }>(
      "SELECT id FROM page WHERE parent_pk = ? AND title = ?",
      [parentId > 0 ? parentId : 0, title],
    );
    const candidates = rows
      .map((r) => Number(r.id))
      .filter((id) => id > lo && id <= hi)
      .sort((a, b) => b - a);
    return candidates[0] ?? null;
  });
  if (pageId === null) {
    return {
      ok: false,
      error: `Page "${title}" was created but its id could not be attributed — check list_child_pages.`,
    };
  }

  const result: CreatePageResult = {
    ok: true,
    page_id: pageId,
    title,
    page_type: pageType,
  };

  // For Database pages: explicitly create the schema so callers can
  // immediately add properties without waiting for a browser to open the
  // page (which is when the schema would otherwise be lazily created).
  if (pageType === "Database") {
    const schemaBefore = await readCounter(transport, "database_schema");
    try {
      await transport.call("create_database_schema", [encodeU64(pageId), title]);
    } catch (err) {
      result.schema_warning = `Schema creation failed: ${reducerErrorMessage(err)}`;
      return result;
    }
    const schemaId = await discoverAllocatedId(
      transport,
      "database_schema",
      schemaBefore,
      async (lo, hi) => {
        const rows = await transport.sql<{ id: number | string }>(
          "SELECT id FROM database_schema WHERE page_id = ?",
          [pageId],
        );
        const candidates = rows
          .map((r) => Number(r.id))
          .filter((id) => id > lo && id <= hi)
          .sort((a, b) => b - a);
        return candidates[0] ?? null;
      },
    );
    if (schemaId !== null) {
      result.schema_id = schemaId;
      result.next_step = `Schema ready. Now call add_property with schema_id=${schemaId} for EVERY column listed in the task before returning your summary.`;
    } else {
      result.schema_warning =
        "Schema creation may still be in progress — call get_schema_id before add_property.";
    }
  }

  return result;
}
