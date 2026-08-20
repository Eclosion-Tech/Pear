/**
 * Render a ComponentTree page body as markdown-ish text — the ONE walk both
 * the MCP core (`get_page`, memory reads, scribe) and the worker (page
 * context in the system prompt) use, so what an agent sees is the same
 * regardless of which surface it reads through.
 *
 * Why a rewrite: the previous walks visited the root's direct children and,
 * for non-Yjs containers, one level of grandchildren. Yjs-backed blocks got
 * no recursion at all — but Headings own their section body and list items
 * own their nested items, so every paragraph under a heading and every
 * nested bullet was silently dropped from what the AI read. This walk is
 * fully recursive and keeps structure:
 *
 *   - headings: `#`×level, section body follows at the same indent
 *   - lists: `- `, `N. ` (ordinal among consecutive numbered siblings),
 *     `- [x] `/`- [ ] `; nested items indent two spaces per level
 *   - media/reference blocks: one-line descriptors carrying their handle
 *     (storage_key / page_id) — see `describeMediaNode`
 *   - other containers: `[Type]` line, then children
 *
 * Pure: takes decoded rows + a text lookup, no I/O. `collectDocYjsIds`
 * tells callers which node texts to fetch first.
 */

import { markdownTablePropsToMarkdown } from "@eclosion-tech/pulp/rich-text/encode";
import { describeMediaNode } from "./file-text";

/** Minimal node shape the renderer needs (matches `ComponentNodeRow`). */
export interface DocNode {
  id: number;
  parentId: number | null;
  componentType: string;
  props?: string;
  order: number;
  deleted: boolean;
}

/** Component types whose text lives in per-node Yjs state. */
export const YJS_BACKED = new Set([
  "RichText",
  "Heading",
  "BulletListItem",
  "NumberedListItem",
  "ChecklistItem",
]);

/** Containers that are pure layout — rendered transparently (children only). */
const TRANSPARENT_TYPES = new Set(["Container"]);

function parseProps(props: string | undefined): Record<string, unknown> {
  if (!props) return {};
  try {
    const v = JSON.parse(props) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function childrenIndex(nodes: DocNode[]): Map<number | null, DocNode[]> {
  const byParent = new Map<number | null, DocNode[]>();
  for (const n of nodes) {
    if (n.deleted) continue;
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);
  return byParent;
}

export function findDocRoot(nodes: DocNode[]): DocNode | undefined {
  return nodes.find((n) => n.parentId === null && !n.deleted);
}

/** Ids of every live Yjs-backed node reachable from the root (any depth). */
export function collectDocYjsIds(nodes: DocNode[]): number[] {
  const root = findDocRoot(nodes);
  if (!root) return [];
  const byParent = childrenIndex(nodes);
  const out: number[] = [];
  const walk = (parentId: number) => {
    for (const n of byParent.get(parentId) ?? []) {
      if (YJS_BACKED.has(n.componentType)) out.push(n.id);
      walk(n.id);
    }
  };
  walk(root.id);
  return out;
}

/** Reference blocks that are not media but still deserve a real descriptor. */
function describeRefNode(node: DocNode): string | undefined {
  const p = parseProps(node.props);
  switch (node.componentType) {
    case "PageLink": {
      const title = typeof p.pageTitle === "string" && p.pageTitle ? `"${p.pageTitle}"` : "";
      const id = p.pageId != null && p.pageId !== "" ? `page_id=${String(p.pageId)}` : "";
      return `[Page link: ${[title, id].filter(Boolean).join(" ")}]`.replace(": ]", "]");
    }
    case "Conversation": {
      const id = p.conversationId != null && p.conversationId !== "" ? ` conversation_id=${String(p.conversationId)}` : "";
      return `[Conversation${id}]`;
    }
    case "CodeRef": {
      const path = typeof p.path === "string" ? p.path : "";
      const ref = typeof p.ref === "string" ? p.ref : "";
      const range = p.range && typeof p.range === "object" ? (p.range as { startLine?: unknown; endLine?: unknown }) : undefined;
      const lines =
        range && typeof range.startLine === "number"
          ? `:${range.startLine}${typeof range.endLine === "number" ? `-${range.endLine}` : ""}`
          : "";
      return `[Code ref: ${path}${lines}${ref ? ` @ ${ref}` : ""}]`;
    }
    default:
      return undefined;
  }
}

function indentLines(text: string, depth: number): string {
  if (depth <= 0 || !text) return text;
  const pad = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => (line.length ? pad + line : line))
    .join("\n");
}

type ListKind = "bullet" | "numbered";

interface Rendered {
  text: string;
  /** Set for list items (and anything nested inside one) — see `glue`. */
  listKind: ListKind | null;
  depth: number;
}

/**
 * Separator between two consecutive rendered blocks. List items of the same
 * kind, and anything nested deeper under an item, join with one newline so
 * the output is a real markdown list; everything else is paragraph-spaced.
 */
function glue(prev: Rendered, next: Rendered): string {
  if (prev.listKind && next.listKind) {
    if (next.depth > prev.depth) return "\n";
    if (prev.listKind === next.listKind) return "\n";
  }
  return "\n\n";
}

function listKindOf(type: string): ListKind | null {
  if (type === "NumberedListItem") return "numbered";
  if (type === "BulletListItem" || type === "ChecklistItem") return "bullet";
  return null;
}

/**
 * Render a page body. Returns `undefined` when `nodes` has no live root
 * (i.e. the page is not a ComponentTree page).
 */
export function renderDocTree(nodes: DocNode[], textOf: (id: number) => string): string | undefined {
  const root = findDocRoot(nodes);
  if (!root) return undefined;
  const byParent = childrenIndex(nodes);

  const renderChildren = (parentId: number, depth: number): Rendered[] => {
    const out: Rendered[] = [];
    let numbered = 0;
    for (const node of byParent.get(parentId) ?? []) {
      if (node.componentType === "NumberedListItem") numbered += 1;
      else numbered = 0;
      out.push(...renderNode(node, depth, numbered));
    }
    return out;
  };

  const renderNode = (node: DocNode, depth: number, ordinal: number): Rendered[] => {
    const type = node.componentType;
    const props = parseProps(node.props);

    const plain = (text: string): Rendered => ({ text: indentLines(text, depth), listKind: null, depth });

    if (YJS_BACKED.has(type)) {
      const text = textOf(node.id);
      let line: string;
      switch (type) {
        case "Heading": {
          const level = Math.min(6, Math.max(1, Math.trunc(Number(props.level)) || 1));
          line = `${"#".repeat(level)} ${text}`;
          break;
        }
        case "BulletListItem":
          line = `- ${text}`;
          break;
        case "NumberedListItem":
          line = `${ordinal}. ${text}`;
          break;
        case "ChecklistItem":
          line = `- [${props.checked === true ? "x" : " "}] ${text}`;
          break;
        default:
          line = text;
      }
      const kind = listKindOf(type);
      const self: Rendered = { text: indentLines(line, depth), listKind: kind, depth };
      if (kind) {
        // Anything nested under a list item is part of that item: indented
        // one level and glued to it as list continuation.
        const kids = renderChildren(node.id, depth + 1).map((k) => ({
          ...k,
          listKind: k.listKind ?? kind,
        }));
        return [self, ...kids];
      }
      // Section bodies (heading children) stay at the same indent.
      return [self, ...renderChildren(node.id, depth)];
    }

    if (type === "MarkdownTable") {
      return [
        plain(markdownTablePropsToMarkdown(node.props) ?? "[MarkdownTable]"),
        ...renderChildren(node.id, depth),
      ];
    }

    const descriptor = describeMediaNode(node) ?? describeRefNode(node);
    if (descriptor) {
      return [plain(descriptor), ...renderChildren(node.id, depth)];
    }

    if (TRANSPARENT_TYPES.has(type)) {
      const kids = renderChildren(node.id, depth);
      return kids.length > 0 ? kids : [plain(`[${type}]`)];
    }

    // Any other component: a placeholder naming the type, then its children
    // so nothing inside a Form / Card / Repeater template is lost.
    return [plain(`[${type}]`), ...renderChildren(node.id, depth)];
  };

  const blocks = renderChildren(root.id, 0);
  let out = "";
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) out += glue(blocks[i - 1], blocks[i]);
    out += blocks[i].text;
  }
  return out;
}
