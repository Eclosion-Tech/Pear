/**
 * Author ComponentTree Doc content from markdown (assessment #27 / #32).
 *
 * `update_page_content` (BlockNote) can't write ComponentTree pages. This is
 * the replacement path: it converts markdown to component block specs, then
 * builds the tree via the component reducers — one Yjs-backed `ComponentNode`
 * per block, with text written through `save_component_yjs_state`.
 *
 * SpacetimeDB reducer calls are fire-and-forget, so every insert is verified
 * by reading the new row back from the subscription before continuing
 * (assessment #31 — no false positives). The list of affected node ids is
 * returned so the tool result can link to exactly what changed (#32).
 *
 * NOTE: the pure pieces (encoder, markdown splitter) are unit-tested in
 * `rich-text-encode.test.ts`. This orchestration touches the live DB and is
 * exercised end-to-end against a running workspace, not in unit tests.
 */

import * as Y from "yjs";
import { yDocToPlainText } from "@eclosion-tech/pulp/rich-text/yjsToHtml";
import type { ConnLike } from "./tools.js";
import {
  markdownTablePropsToMarkdown,
  markdownToComponentBlocks,
  richTextBlockToYjsBytes,
  type ComponentBlockSpec,
} from "./rich-text-encode.js";

type ComponentNodeRow = {
  id: bigint;
  surfaceId: bigint;
  parentId: bigint | undefined;
  componentType: string;
  props: string;
  order: number;
  deletedAt: unknown;
};

type ComponentYjsStateRow = { componentNodeId: bigint; data: Uint8Array };

const YJS_BACKED = new Set([
  "RichText",
  "Heading",
  "BulletListItem",
  "NumberedListItem",
  "ChecklistItem",
]);

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2500): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

function liveChildrenOf(conn: ConnLike, surfaceId: bigint, parentId: bigint): ComponentNodeRow[] {
  return [...(conn.db.component_node.iter() as Iterable<ComponentNodeRow>)].filter(
    (n) => n.surfaceId === surfaceId && n.parentId === parentId && !n.deletedAt,
  );
}

function findRoot(conn: ConnLike, surfaceId: bigint): ComponentNodeRow | undefined {
  return [...(conn.db.component_node.iter() as Iterable<ComponentNodeRow>)].find(
    (n) => n.surfaceId === surfaceId && (n.parentId === undefined || n.parentId === null) && !n.deletedAt,
  );
}

/** Markdown prefix to re-emit per block type when reconstructing page text. */
const MARKDOWN_PREFIX: Record<string, string> = {
  Heading: "# ",
  BulletListItem: "- ",
  NumberedListItem: "1. ",
  ChecklistItem: "- [ ] ",
};

/**
 * Plain text of a single ComponentNode by id (its decoded per-node Yjs state).
 * Used to surface the block a conversation is anchored to (`block_anchor`) as
 * the focus in the AI's page context. Empty string if the node has no text.
 */
export function readComponentNodeText(conn: ConnLike, nodeId: bigint): string {
  return decodeNodeText(conn, nodeId);
}

function decodeNodeText(conn: ConnLike, nodeId: bigint): string {
  const row = [...(conn.db.component_yjs_state.iter() as Iterable<ComponentYjsStateRow>)].find(
    (s) => s.componentNodeId === nodeId,
  );
  if (!row?.data || row.data.length === 0) return "";
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.data);
    return yDocToPlainText(doc);
  } catch {
    return "";
  }
}

/**
 * Reconstruct a ComponentTree page's body as markdown-ish text: walk the live
 * children of the root in order and decode each block's per-node Yjs state.
 *
 * This is the read counterpart to {@link writeComponentTreeDoc}. The legacy
 * `page_content` table is empty for ComponentTree pages, so `get_page` must
 * rebuild content from the nodes (assessment #27 — read side). Returns
 * `undefined` when the page has no component tree (i.e. not ComponentTree).
 */
export function readComponentTreeDoc(conn: ConnLike, pageId: bigint): string | undefined {
  const root = findRoot(conn, pageId);
  if (!root) return undefined;

  const blocks: string[] = [];
  // Direct children of the root cover the common flat doc (paragraphs/headings).
  // Nested containers (e.g. list groups) are walked one level so their items
  // aren't silently dropped.
  for (const child of liveChildrenOf(conn, pageId, root.id).sort((a, b) => a.order - b.order)) {
    if (YJS_BACKED.has(child.componentType)) {
      const prefix = MARKDOWN_PREFIX[child.componentType] ?? "";
      blocks.push(prefix + decodeNodeText(conn, child.id));
      continue;
    }
    if (child.componentType === "MarkdownTable") {
      blocks.push(markdownTablePropsToMarkdown(child.props) ?? "[MarkdownTable]");
      continue;
    }
    const grandchildren = liveChildrenOf(conn, pageId, child.id).sort((a, b) => a.order - b.order);
    if (grandchildren.length === 0) {
      blocks.push(`[${child.componentType}]`);
      continue;
    }
    for (const gc of grandchildren) {
      const prefix = MARKDOWN_PREFIX[gc.componentType] ?? "";
      blocks.push(prefix + (YJS_BACKED.has(gc.componentType) ? decodeNodeText(conn, gc.id) : `[${gc.componentType}]`));
    }
  }
  return blocks.join("\n\n");
}

export interface WriteComponentTreeResult {
  ok: boolean;
  error?: string;
  page_id: number;
  /** ComponentNode ids created this call — the blocks that changed (#32). */
  created_node_ids?: number[];
  blocks?: number;
}

/**
 * Replace a ComponentTree page's body with `markdown`, rendered as component
 * nodes. Existing live children of the root are soft-deleted first (replace
 * semantics, matching the legacy `update_page_content`).
 */
export async function writeComponentTreeDoc(
  conn: ConnLike,
  pageId: bigint,
  markdown: string,
): Promise<WriteComponentTreeResult> {
  const root = findRoot(conn, pageId);
  if (!root) {
    return {
      ok: false,
      page_id: Number(pageId),
      error: "No root component node for this page — cannot author content.",
    };
  }

  const specs: ComponentBlockSpec[] = markdownToComponentBlocks(markdown);
  if (specs.length === 0) {
    // Nothing to write — treat an empty doc as a single empty paragraph so the
    // page isn't left without a content node.
    specs.push({ componentType: "RichText", props: {}, text: "" });
  }

  // Replace: soft-delete current live children of the root.
  for (const child of liveChildrenOf(conn, pageId, root.id)) {
    try {
      await conn.reducers.deleteComponent({ componentId: child.id });
    } catch (err) {
      return {
        ok: false,
        page_id: Number(pageId),
        error: `Failed clearing existing content (node ${child.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  const createdNodeIds: bigint[] = [];
  let afterSiblingId: bigint | undefined = undefined;

  for (const spec of specs) {
    const existingIds = new Set(
      [...(conn.db.component_node.iter() as Iterable<ComponentNodeRow>)].map((n) => n.id),
    );

    try {
      await conn.reducers.insertComponent({
        parentId: root.id,
        componentType: spec.componentType,
        propsJson: JSON.stringify(spec.props ?? {}),
        afterSiblingId,
      });
    } catch (err) {
      return {
        ok: false,
        page_id: Number(pageId),
        error: `insert_component failed for ${spec.componentType}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        created_node_ids: createdNodeIds.map(Number),
      };
    }

    // Read back the newly inserted node (fire-and-forget reducer → verify #31).
    const newNode = await waitFor(() =>
      [...(conn.db.component_node.iter() as Iterable<ComponentNodeRow>)].find(
        (n) =>
          !existingIds.has(n.id) &&
          n.surfaceId === pageId &&
          n.parentId === root.id &&
          n.componentType === spec.componentType &&
          !n.deletedAt,
      ),
    );
    if (!newNode) {
      return {
        ok: false,
        page_id: Number(pageId),
        error: `insert_component for ${spec.componentType} did not appear — write may have been rejected server-side.`,
        created_node_ids: createdNodeIds.map(Number),
      };
    }

    createdNodeIds.push(newNode.id);
    afterSiblingId = newNode.id;

    // Write the block's text into per-node Yjs state.
    if (YJS_BACKED.has(spec.componentType)) {
      try {
        const bytes = richTextBlockToYjsBytes(spec.text);
        await conn.reducers.saveComponentYjsState({
          componentId: newNode.id,
          data: bytes,
        });
      } catch (err) {
        return {
          ok: false,
          page_id: Number(pageId),
          error: `save_component_yjs_state failed for node ${newNode.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          created_node_ids: createdNodeIds.map(Number),
        };
      }
    }
  }

  return {
    ok: true,
    page_id: Number(pageId),
    created_node_ids: createdNodeIds.map(Number),
    blocks: specs.length,
  };
}
