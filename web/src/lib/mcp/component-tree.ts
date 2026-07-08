/**
 * Stateless ComponentTree document read/write over `/sql` + `/call`.
 *
 * Write side rides the batched `replace_page_doc` / `append_page_doc`
 * reducers: one `/call` carries every block (nodes + Yjs state) in a single
 * transaction, so cost no longer scales with document size and a failed
 * write can't leave a half-written page (task #242; symptoms #210/#211/#241).
 * Read side is one nodes query + chunked Yjs fetches, with a bulk multi-page
 * variant for memory list/search. Reducer rejections are synchronous over
 * HTTP, so every failure path returns immediately with the server's
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
import { readCounter } from "./ids";
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
  surface_id?: number | string;
  parent_id: unknown;
  component_type: string;
  order: number | string;
  deleted_at: unknown;
};

function decodeNode(r: RawNode): ComponentNodeRow {
  return {
    id: Number(r.id),
    parentId: toNumberOrNull(r.parent_id),
    componentType: r.component_type,
    order: Number(r.order ?? 0),
    deleted: !isOptionNone(r.deleted_at),
  };
}

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
  return rows.map(decodeNode);
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

// ── Document assembly (shared by single-page and bulk reads) ──────────────────

type DocWalk = Array<{ node: ComponentNodeRow; nested: ComponentNodeRow[] }>;

/**
 * Compute the render walk for one surface: live children of the root in
 * order, one level of nesting for list groups. Returns `undefined` when the
 * surface has no live root (i.e. not a ComponentTree page).
 */
function docWalkOf(nodes: ComponentNodeRow[]): DocWalk | undefined {
  const root = findRoot(nodes);
  if (!root) return undefined;
  const children = liveChildrenOf(nodes, root.id).sort((a, b) => a.order - b.order);
  return children.map((child) => ({
    node: child,
    nested: YJS_BACKED.has(child.componentType)
      ? []
      : liveChildrenOf(nodes, child.id).sort((a, b) => a.order - b.order),
  }));
}

/** Node ids in a walk whose text must be fetched from Yjs state. */
function walkYjsIds(walk: DocWalk): number[] {
  return walk.flatMap(({ node, nested }) => [
    ...(YJS_BACKED.has(node.componentType) ? [node.id] : []),
    ...nested.filter((gc) => YJS_BACKED.has(gc.componentType)).map((gc) => gc.id),
  ]);
}

/** Render a walk to markdown-ish text given a node-id → text lookup. */
function renderWalk(walk: DocWalk, textOf: (id: number) => string): string {
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

/**
 * Reconstruct a ComponentTree page's body as markdown-ish text. Returns
 * `undefined` when the page has no component tree (i.e. not ComponentTree).
 */
export async function readComponentTreeDoc(
  transport: StdbTransport,
  pageId: number,
): Promise<string | undefined> {
  const nodes = await selectSurfaceNodes(transport, pageId);
  const walk = docWalkOf(nodes);
  if (!walk) return undefined;
  const texts = await nodeTexts(transport, walkYjsIds(walk));
  return renderWalk(walk, (id) => texts.get(id) ?? "");
}

/**
 * Bulk variant of {@link readComponentTreeDoc}: reconstruct many pages with
 * a fixed number of queries — chunked node fetches by surface_id plus one
 * chunked Yjs fetch across ALL pages — instead of 2+ subrequests per page.
 * This is what keeps `list_memory`/`search_memory` alive on large memory
 * subtrees (#241). Pages without a component tree are absent from the map.
 */
export async function readComponentTreeDocs(
  transport: StdbTransport,
  pageIds: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pageIds.length === 0) return result;

  const nodesBySurface = new Map<number, ComponentNodeRow[]>();
  const CHUNK = 50;
  for (let i = 0; i < pageIds.length; i += CHUNK) {
    const chunk = pageIds.slice(i, i + CHUNK);
    const rows = await transport.sql<RawNode>(
      `SELECT id, surface_id, parent_id, component_type, "order", deleted_at FROM component_node WHERE ${orChain("surface_id", chunk.length)}`,
      chunk,
    );
    for (const r of rows) {
      const surfaceId = Number(r.surface_id);
      const list = nodesBySurface.get(surfaceId) ?? [];
      list.push(decodeNode(r));
      nodesBySurface.set(surfaceId, list);
    }
  }

  const walks = new Map<number, DocWalk>();
  const allYjsIds: number[] = [];
  for (const pageId of pageIds) {
    const walk = docWalkOf(nodesBySurface.get(pageId) ?? []);
    if (!walk) continue;
    walks.set(pageId, walk);
    allYjsIds.push(...walkYjsIds(walk));
  }

  const texts = await nodeTexts(transport, allYjsIds);
  for (const [pageId, walk] of walks) {
    result.set(pageId, renderWalk(walk, (id) => texts.get(id) ?? ""));
  }
  return result;
}

// ── Batched writes ────────────────────────────────────────────────────────────

export interface WriteComponentTreeResult {
  ok: boolean;
  error?: string;
  page_id: number;
  /** ComponentNode ids created this call — the blocks that changed. */
  created_node_ids?: number[];
  blocks?: number;
}

/**
 * Wire-encode one `DocBlockInput` for the batched reducers. Products encode
 * positionally (SATS-JSON seq form) so Rust field-name casing never enters
 * the picture; Option uses the same `{some}`/`{none}` shape as every other
 * reducer arg in this library.
 */
function encodeDocBlock(spec: ComponentBlockSpec): unknown[] {
  return [
    spec.componentType,
    JSON.stringify(spec.props ?? {}),
    encodeOption(
      YJS_BACKED.has(spec.componentType)
        ? encodeBytes(richTextBlockToYjsBytes(spec.text))
        : undefined,
    ),
  ];
}

async function callPageDoc(
  transport: StdbTransport,
  pageId: number,
  specs: ComponentBlockSpec[],
  reducer: "replace_page_doc" | "append_page_doc",
): Promise<WriteComponentTreeResult> {
  const before = await readCounter(transport, "component_node");
  try {
    await transport.call(reducer, [encodeU64(pageId), specs.map(encodeDocBlock)]);
  } catch (err) {
    // The reducer is a single transaction — a rejection means NOTHING was
    // written (no partial pages), so there is no cleanup path here.
    return { ok: false, page_id: pageId, error: reducerErrorMessage(err) };
  }

  // One readback for the created ids: every node this batch inserted has
  // id > the pre-call counter watermark and is a live child of the root.
  // A concurrent writer on the SAME page inside this window could add ids
  // we'd misattribute — informational only, and the write itself is safe.
  const nodes = await selectSurfaceNodes(transport, pageId);
  const root = findRoot(nodes);
  const createdNodeIds =
    root === undefined
      ? []
      : nodes
          .filter((n) => n.id > before && !n.deleted && n.parentId === root.id)
          .sort((a, b) => a.order - b.order)
          .map((n) => n.id);
  return { ok: true, page_id: pageId, created_node_ids: createdNodeIds, blocks: specs.length };
}

/**
 * Replace a ComponentTree page's body with `markdown`, rendered as component
 * nodes. Existing live children of the root are soft-deleted server-side in
 * the same transaction (replace semantics, matching the legacy
 * `update_page_content`).
 */
export async function writeComponentTreeDoc(
  transport: StdbTransport,
  pageId: number,
  markdown: string,
): Promise<WriteComponentTreeResult> {
  const specs: ComponentBlockSpec[] = markdownToComponentBlocks(markdown);
  if (specs.length === 0) {
    // Nothing to write — treat an empty doc as a single empty paragraph so the
    // page isn't left without a content node.
    specs.push({ componentType: "RichText", props: {}, text: "" });
  }
  return callPageDoc(transport, pageId, specs, "replace_page_doc");
}

/**
 * Append `markdown`'s blocks after the page's existing content, in one
 * transaction. Never reads or rewrites existing nodes — the safe primitive
 * for memory appends.
 */
export async function appendComponentTreeDoc(
  transport: StdbTransport,
  pageId: number,
  markdown: string,
): Promise<WriteComponentTreeResult> {
  const specs: ComponentBlockSpec[] = markdownToComponentBlocks(markdown);
  if (specs.length === 0) {
    return { ok: true, page_id: pageId, created_node_ids: [], blocks: 0 };
  }
  return callPageDoc(transport, pageId, specs, "append_page_doc");
}
