/**
 * MCP-only memory tools: `remember` and `list_memory`.
 *
 * The chat agent writes memory with the general page tools because its system
 * prompt carries the memory index; an external MCP client has no such prompt,
 * so it gets a first-class write tool (`remember`) and an index tool
 * (`list_memory`). Both operate strictly inside the AI user's own memory
 * subtree — privacy is enforced server-side by the access rules provisioned
 * with the subtree, and client-side by the same scope checks the chat memory
 * tools use.
 */

import { executeTool, type ConnLike, type ToolCallContext } from "../tools.js";
import {
  buildAiUserMemoryIndex,
  readAiUserMemoryPage,
} from "../workspace-context.js";

type AiUserMemoryRow = { aiUserId: bigint; rootPageId: bigint };

/** The AI user's memory root page id, or null when memory is unprovisioned. */
function memoryRootId(conn: ConnLike, aiUserId: bigint): bigint | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (conn.db as any).ai_user_memory as
    | { iter: () => Iterable<AiUserMemoryRow> }
    | undefined;
  if (!table?.iter) return null;
  for (const row of table.iter()) {
    if (row.aiUserId === aiUserId) return row.rootPageId;
  }
  return null;
}

const UNPROVISIONED_ERROR =
  "This AI user has no provisioned memory. Ask the workspace owner to run " +
  "`pnpm mcp:provision` (or enable memory for this AI user in Pear settings).";

export async function executeListMemory(
  conn: ConnLike,
  toolContext: ToolCallContext,
): Promise<string> {
  const aiUserId = toolContext.aiUserId;
  if (aiUserId === undefined) {
    return JSON.stringify({ ok: false, error: "No AI user resolved on this connection." });
  }
  if (memoryRootId(conn, aiUserId) === null) {
    return JSON.stringify({ ok: false, error: UNPROVISIONED_ERROR });
  }
  const entries = buildAiUserMemoryIndex(conn, aiUserId);
  return JSON.stringify({
    ok: true,
    pages: entries.map((e) => ({
      page_id: Number(e.pageId),
      title: e.title,
      depth: e.depth,
      snippet: e.snippet,
      chars: e.chars,
      updated: e.updated,
    })),
  });
}

export async function executeRemember(
  conn: ConnLike,
  input: Record<string, unknown>,
  toolContext: ToolCallContext,
): Promise<string> {
  const aiUserId = toolContext.aiUserId;
  if (aiUserId === undefined) {
    return JSON.stringify({ ok: false, error: "No AI user resolved on this connection." });
  }
  const rootId = memoryRootId(conn, aiUserId);
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
    const pageId = BigInt(input.memory_page_id as number | string);
    const existing = readAiUserMemoryPage(conn, aiUserId, pageId);
    if (!existing) {
      return JSON.stringify({
        ok: false,
        error: `No memory page ${pageId} in your memory subtree. Use list_memory to see valid ids, or omit memory_page_id to create a new page.`,
      });
    }
    const markdown =
      mode === "append" && existing.content.trim()
        ? `${existing.content.replace(/\s+$/, "")}\n\n${content}`
        : content;
    const result = await executeTool(
      conn,
      "update_page_content",
      { page_id: Number(pageId), markdown },
      0n,
      toolContext,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, page_id: Number(pageId), mode });
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
  const created = await executeTool(
    conn,
    "create_page",
    { parent_id: Number(rootId), page_type: "Doc", title },
    0n,
    toolContext,
  );
  const createdParsed = JSON.parse(created) as { ok?: boolean; page_id?: number; error?: string };
  if (!createdParsed.ok || typeof createdParsed.page_id !== "number") {
    return JSON.stringify({
      ok: false,
      error: `Failed to create memory page: ${createdParsed.error ?? "unknown error"}`,
    });
  }
  const wrote = await executeTool(
    conn,
    "update_page_content",
    { page_id: createdParsed.page_id, markdown: content },
    0n,
    toolContext,
  );
  const wroteParsed = JSON.parse(wrote) as Record<string, unknown>;
  return JSON.stringify({
    ...wroteParsed,
    page_id: createdParsed.page_id,
    title,
    created: true,
  });
}
