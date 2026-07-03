/**
 * Stateless ComponentTree document read/write over `/sql` + `/call`.
 *
 * Port of worker/src/component-authoring.ts with the subscription cache
 * replaced by SQL reads and the `waitFor` id-discovery replaced by the
 * gap-free `id_counter` (see ids.ts). Reducer rejections are synchronous
 * over HTTP, so every failure path returns immediately with the server's
 * `Err(String)` text.
 */

import * as Y from "yjs";
import { yDocToPlainText } from "@eclosion-tech/pulp/rich-text/yjsToHtml";
import {
  markdownToComponentBlocks,
  richTextBlockToYjsBytes,
  type ComponentBlockSpec,
} from "@eclosion-tech/pulp/rich-text/encode";
import type { StdbTransport } from "../api-endpoint";
import type { ComponentNodeRow } from "./types";
import { decodeBytesColumn, isOptionNone, orChain, toNumberOrNull } from "./decode";
import { encodeBytes, encodeOption, encodeU64 } from "./encode";
import { discoverAllocatedId, readCounter } from "./ids";
import { reducerErrorMessage } from "./errors";

/** Component types whose text lives in per-node Yjs state. */
export const YJS_BACKED = new Set([
  "RichText",
  "Heading",
  "BulletListItem",
  "NumberedListItem",
  "ChecklistItem",
]);

/** Markdown prefix to re-emit per block type when reconstructing page text. */
export const MARKDOWN_PREFIX: Record<string, string> = {
  Heading: "# ",
  BulletListItem: "- ",
  NumberedListItem: "1. ",
  ChecklistItem: "- [ ] ",
};

type RawNode = {
  id: number | string;
  parent_id: unknown;
  component_type: string;
  order: number | string;
  deleted_at: unknown;
};

/** All component nodes of one surface (page), live and deleted. */
export async function selectSurfaceNodes(
  transport: StdbTransport,
  pageId: number,
): Promise<ComponentNodeRow[]> {
  const rows = await transport.sql<RawNode>(
    // `parent_id`/`deleted_at` are Options — unfilterable in STDB SQL; fetch
    // by the non-null indexed surface_id and decode client-side. `order` is
    // a keyword and must be quoted.
    `SELECT id, parent_id, component_type, "order", deleted_at FROM component_node WHERE surface_id = ?`,
    [pageId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    parentId: toNumberOrNull(r.parent_id),
    componentType: r.component_type,
    order: Number(r.order ?? 0),
    deleted: !isOptionNone(r.deleted_at),
  }));
}

function findRoot(nodes: ComponentNodeRow[]): ComponentNodeRow | undefined {
  return nodes.find((n) => n.parentId === null && !n.deleted);
}

function liveChildrenOf(nodes: ComponentNodeRow[], parentId: number): ComponentNodeRow[] {
  return nodes.filter((n) => n.parentId === parentId && !n.deleted);
}

/** Fetch + decode Yjs text for a set of node ids (chunked OR-chains). */
async function nodeTexts(
  transport: StdbTransport,
  nodeIds: number[],
): Promise<Map<number, string>> {
  const texts = new Map<number, string>();
  const CHUNK = 50;
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);
    const rows = await transport.sql<{ component_node_id: number | string; data: unknown }>(
      `SELECT component_node_id, data FROM component_yjs_state WHERE ${orChain("component_node_id", chunk.length)}`,
      chunk,
    );
    for (const row of rows) {
      texts.set(Number(row.component_node_id), decodeYjsText(row.data));
    }
  }
  return texts;
}

function decodeYjsText(data: unknown): string {
  const bytes = decodeBytesColumn(data);
  if (bytes.length === 0) return "";
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    return yDocToPlainText(doc);
  } catch {
    return "";
  }
}

/**
 * Reconstruct a ComponentTree page's body as markdown-ish text: live children
 * of the root in order, one level of nesting for list groups. Returns
 * `undefined` when the page has no component tree (i.e. not ComponentTree).
 */
export async function readComponentTreeDoc(
  transport: StdbTransport,
  pageId: number,
): Promise<string | undefined> {
  const nodes = await selectSurfaceNodes(transport, pageId);
  const root = findRoot(nodes);
  if (!root) return undefined;

  const children = liveChildrenOf(nodes, root.id).sort((a, b) => a.order - b.order);
  const walk: Array<{ node: ComponentNodeRow; nested: ComponentNodeRow[] }> = children.map(
    (child) => ({
      node: child,
      nested: YJS_BACKED.has(child.componentType)
        ? []
        : liveChildrenOf(nodes, child.id).sort((a, b) => a.order - b.order),
    }),
  );

  const yjsIds = walk.flatMap(({ node, nested }) => [
    ...(YJS_BACKED.has(node.componentType) ? [node.id] : []),
    ...nested.filter((gc) => YJS_BACKED.has(gc.componentType)).map((gc) => gc.id),
  ]);
  const texts = await nodeTexts(transport, yjsIds);
  const textOf = (id: number) => texts.get(id) ?? "";

  const blocks: string[] = [];
  for (const { node, nested } of walk) {
    if (YJS_BACKED.has(node.componentType)) {
      blocks.push((MARKDOWN_PREFIX[node.componentType] ?? "") + textOf(node.id));
      continue;
    }
    if (nested.length === 0) {
      blocks.push(`[${node.componentType}]`);
      continue;
    }
    for (const gc of nested) {
      const prefix = MARKDOWN_PREFIX[gc.componentType] ?? "";
      blocks.push(
        prefix + (YJS_BACKED.has(gc.componentType) ? textOf(gc.id) : `[${gc.componentType}]`),
      );
    }
  }
  return blocks.join("\n\n");
}

export interface WriteComponentTreeResult {
  ok: boolean;
  error?: string;
  page_id: number;
  /** ComponentNode ids created this call — the blocks that changed. */
  created_node_ids?: number[];
  blocks?: number;
}

/**
 * Replace a ComponentTree page's body with `markdown`, rendered as component
 * nodes. Existing live children of the root are soft-deleted first (replace
 * semantics, matching the legacy `update_page_content`).
 */
export async function writeComponentTreeDoc(
  transport: StdbTransport,
  pageId: number,
  markdown: string,
): Promise<WriteComponentTreeResult> {
  const nodes = await selectSurfaceNodes(transport, pageId);
  const root = findRoot(nodes);
  if (!root) {
    return {
      ok: false,
      page_id: pageId,
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
  for (const child of liveChildrenOf(nodes, root.id)) {
    try {
      await transport.call("delete_component", [encodeU64(child.id)]);
    } catch (err) {
      return {
        ok: false,
        page_id: pageId,
        error: `Failed clearing existing content (node ${child.id}): ${reducerErrorMessage(err)}`,
      };
    }
  }

  const createdNodeIds: number[] = [];
  let afterSiblingId: number | undefined = undefined;

  for (const spec of specs) {
    const before = await readCounter(transport, "component_node");
    try {
      await transport.call("insert_component", [
        encodeU64(root.id),
        spec.componentType,
        JSON.stringify(spec.props ?? {}),
        encodeOption(afterSiblingId !== undefined ? encodeU64(afterSiblingId) : undefined),
      ]);
    } catch (err) {
      return {
        ok: false,
        page_id: pageId,
        error: `insert_component failed for ${spec.componentType}: ${reducerErrorMessage(err)}`,
        created_node_ids: createdNodeIds,
      };
    }

    const newId = await discoverAllocatedId(
      transport,
      "component_node",
      before,
      async (lo, hi) => {
        // Concurrent writer interleaved — re-select this surface's nodes and
        // pick the one we just created: in (lo, hi], child of root, right
        // type, live, not already claimed. Newest id wins.
        const fresh = await selectSurfaceNodes(transport, pageId);
        const candidates = fresh
          .filter(
            (n) =>
              n.id > lo &&
              n.id <= hi &&
              n.parentId === root.id &&
              n.componentType === spec.componentType &&
              !n.deleted &&
              !createdNodeIds.includes(n.id),
          )
          .sort((a, b) => b.id - a.id);
        return candidates[0]?.id ?? null;
      },
    );
    if (newId === null) {
      return {
        ok: false,
        page_id: pageId,
        error: `insert_component for ${spec.componentType} did not appear — write may have been rejected server-side.`,
        created_node_ids: createdNodeIds,
      };
    }

    createdNodeIds.push(newId);
    afterSiblingId = newId;

    // Write the block's text into per-node Yjs state.
    if (YJS_BACKED.has(spec.componentType)) {
      try {
        const bytes = richTextBlockToYjsBytes(spec.text);
        await transport.call("save_component_yjs_state", [
          encodeU64(newId),
          encodeBytes(bytes),
        ]);
      } catch (err) {
        return {
          ok: false,
          page_id: pageId,
          error: `save_component_yjs_state failed for node ${newId}: ${reducerErrorMessage(err)}`,
          created_node_ids: createdNodeIds,
        };
      }
    }
  }

  return {
    ok: true,
    page_id: pageId,
    created_node_ids: createdNodeIds,
    blocks: specs.length,
  };
}
