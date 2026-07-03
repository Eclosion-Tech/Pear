/**
 * Stateless page-body write, shared by the `update_page_content` tool and
 * `remember`. Branches on the page's content format:
 *   • ComponentTree → component-node authoring (writeComponentTreeDoc)
 *   • BlockNote (legacy) → markdown→BlockNote JSON + `update_page_content`
 * Optionally takes a best-effort PreAgentEdit snapshot first so a
 * destructive overwrite stays restorable — never blocks the edit.
 */

import type { StdbTransport } from "../api-endpoint";
import { markdownToBlockNote } from "./blocknote";
import { writeComponentTreeDoc } from "./component-tree";
import { encodeSnapshotTypePreAgentEdit, encodeU64 } from "./encode";
import { discoverAllocatedId, readCounter } from "./ids";
import { reducerErrorMessage } from "./errors";

export interface WriteContentResult {
  ok: boolean;
  error?: string;
  page_id: number;
  snapshot_id?: number;
  created_node_ids?: number[];
  blocks?: number;
}

async function takePreEditSnapshot(
  transport: StdbTransport,
  pageId: number,
): Promise<number | undefined> {
  try {
    const before = await readCounter(transport, "page_snapshot");
    await transport.call("take_snapshot", [
      encodeU64(pageId),
      encodeSnapshotTypePreAgentEdit(),
    ]);
    const id = await discoverAllocatedId(transport, "page_snapshot", before, async (lo, hi) => {
      const rows = await transport.sql<{ id: number | string }>(
        "SELECT id FROM page_snapshot WHERE page_id = ?",
        [pageId],
      );
      const candidates = rows
        .map((r) => Number(r.id))
        .filter((sid) => sid > lo && sid <= hi)
        .sort((a, b) => b - a);
      return candidates[0] ?? null;
    });
    return id ?? undefined;
  } catch {
    // Best-effort — a content edit is never blocked on snapshot failure.
    return undefined;
  }
}

export async function writePageContent(
  transport: StdbTransport,
  page: { id: number; contentFormat: "BlockNote" | "ComponentTree" },
  markdown: string,
  opts: { snapshot: boolean },
): Promise<WriteContentResult> {
  const snapshotId = opts.snapshot
    ? await takePreEditSnapshot(transport, page.id)
    : undefined;

  if (page.contentFormat === "ComponentTree") {
    const result = await writeComponentTreeDoc(transport, page.id, markdown);
    return { ...result, snapshot_id: snapshotId };
  }

  // Legacy BlockNote path — reducer rejects ComponentTree pages server-side,
  // but we already routed those above.
  try {
    await transport.call("update_page_content", [
      encodeU64(page.id),
      markdownToBlockNote(markdown),
    ]);
  } catch (err) {
    return {
      ok: false,
      page_id: page.id,
      snapshot_id: snapshotId,
      error: reducerErrorMessage(err),
    };
  }
  return { ok: true, page_id: page.id, snapshot_id: snapshotId };
}
