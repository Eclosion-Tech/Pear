/**
 * Notion → Pear data transformer.
 *
 * Converts a NotionFetchResult + attachment upload map into a
 * `notion-import-v1` JSON payload ready to be passed to the
 * SpacetimeDB `import_notion` reducer.
 *
 * Wire format conventions (must match pear_v1.rs decoders):
 *   u64       → { "__pear": "bigint", "v": "<decimal string>" }
 *   Identity  → { "__pear": "identity", "v": "<64-char hex string>" }
 *   Timestamp → { "__pear": "timestamp", "v": <micros i64 as bigint-tagged> }
 *   Enum tag  → { "tag": "<Variant>" }  (for PropertyType, ActorType, etc.)
 *   PropertyValue → { "tag": "<Variant>", "value": <payload> }
 */

import type {
  NotionFetchResult,
  NotionPage,
  BlockObjectResponse,
  CommentObjectResponse,
  RichTextItemResponse,
  PageObjectResponse,
  DataSourceObjectResponse,
} from "./fetcher.js";
import { extractPlainText } from "./fetcher.js";
import type { AttachmentUploadResult } from "./attachments.js";

// ── ID assignment ─────────────────────────────────────────────────────────────

function makeIdAssigner() {
  const map = new Map<string, bigint>();
  let next = 1n;
  return (notionId: string): bigint => {
    if (!map.has(notionId)) map.set(notionId, next++);
    return map.get(notionId)!;
  };
}

// ── Wire format helpers ───────────────────────────────────────────────────────

function pearBigint(n: bigint | number): unknown {
  return { "__pear": "bigint", "v": String(n) };
}

function pearIdentity(hex: string): unknown {
  // Pad to 64 hex chars (32 bytes) if needed
  const padded = hex.replace(/^0x/, "").padStart(64, "0");
  return { "__pear": "identity", "v": padded };
}

function pearTimestamp(isoOrMs: string | number): unknown {
  let micros: bigint;
  if (typeof isoOrMs === "string") {
    micros = BigInt(new Date(isoOrMs).getTime()) * 1000n;
  } else {
    micros = BigInt(isoOrMs) * 1000n;
  }
  return { "__pear": "timestamp", "v": { "__pear": "bigint", "v": String(micros) } };
}

const ACTOR_HUMAN = { "tag": "Human" };
const STATUS_ACTIVE = { "tag": "Active" };
const STATUS_COMPLETE = { "tag": "Complete" };
const ROLE_INITIATOR = { "tag": "Initiator" };
const VIEW_GRID = { "tag": "Grid" };

// ── Page title extraction ─────────────────────────────────────────────────────

function getPageTitle(page: NotionPage): string {
  if (page.object === "data_source") {
    return extractPlainText(page.title) || "Untitled Database";
  }
  // Page object: title is in properties.title (type: "title")
  const p = page as PageObjectResponse;
  for (const prop of Object.values(p.properties)) {
    if (prop.type === "title") {
      return extractPlainText(prop.title) || "Untitled";
    }
  }
  return "Untitled";
}

function getPageIcon(page: NotionPage): string | null {
  const icon = page.icon;
  if (!icon) return null;
  if (icon.type === "emoji") return icon.emoji;
  return null;
}

// ── Rich text → ProseMirror inline content ────────────────────────────────────

type PMNode = Record<string, unknown>;

function richTextToPmInline(richText: RichTextItemResponse[]): PMNode[] {
  return richText.map((rt) => {
    const marks: PMNode[] = [];
    if (rt.annotations.bold) marks.push({ type: "bold" });
    if (rt.annotations.italic) marks.push({ type: "italic" });
    if (rt.annotations.strikethrough) marks.push({ type: "strike" });
    if (rt.annotations.code) marks.push({ type: "code" });
    if (rt.annotations.underline) marks.push({ type: "underline" });
    if (rt.type === "text" && rt.text.link) {
      marks.push({ type: "link", attrs: { href: rt.text.link.url } });
    }
    const node: PMNode = { type: "text", text: rt.plain_text };
    if (marks.length > 0) node.marks = marks;
    return node;
  });
}

// ── Block → ProseMirror nodes ─────────────────────────────────────────────────

function blockToPmNodes(
  block: BlockObjectResponse,
  allBlocks: BlockObjectResponse[],
  slug: string,
  attachmentMap: Map<string, AttachmentUploadResult>,
  notionToId: (id: string) => bigint
): PMNode[] {
  const childBlocks = allBlocks.filter(
    (b) => "parent" in b && (b.parent as { block_id?: string }).block_id === block.id
  );

  switch (block.type) {
    case "paragraph": {
      const content = richTextToPmInline(block.paragraph.rich_text);
      return [{ type: "paragraph", content: content.length ? content : [{ type: "text", text: "" }] }];
    }
    case "heading_1":
      return [{ type: "heading", attrs: { level: 1 }, content: richTextToPmInline(block.heading_1.rich_text) }];
    case "heading_2":
      return [{ type: "heading", attrs: { level: 2 }, content: richTextToPmInline(block.heading_2.rich_text) }];
    case "heading_3":
      return [{ type: "heading", attrs: { level: 3 }, content: richTextToPmInline(block.heading_3.rich_text) }];
    case "bulleted_list_item": {
      const children = childBlocks.flatMap((c) => blockToPmNodes(c, allBlocks, slug, attachmentMap, notionToId));
      return [{
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: richTextToPmInline(block.bulleted_list_item.rich_text) },
            ...children,
          ],
        }],
      }];
    }
    case "numbered_list_item": {
      const children = childBlocks.flatMap((c) => blockToPmNodes(c, allBlocks, slug, attachmentMap, notionToId));
      return [{
        type: "orderedList",
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: richTextToPmInline(block.numbered_list_item.rich_text) },
            ...children,
          ],
        }],
      }];
    }
    case "to_do": {
      return [{
        type: "taskList",
        content: [{
          type: "taskItem",
          attrs: { checked: block.to_do.checked },
          content: [{ type: "paragraph", content: richTextToPmInline(block.to_do.rich_text) }],
        }],
      }];
    }
    case "toggle": {
      const children = childBlocks.flatMap((c) => blockToPmNodes(c, allBlocks, slug, attachmentMap, notionToId));
      return [
        { type: "paragraph", content: richTextToPmInline(block.toggle.rich_text) },
        ...children,
      ];
    }
    case "code": {
      return [{
        type: "codeBlock",
        attrs: { language: block.code.language || null },
        content: [{ type: "text", text: extractPlainText(block.code.rich_text) }],
      }];
    }
    case "quote": {
      return [{
        type: "blockquote",
        content: [{ type: "paragraph", content: richTextToPmInline(block.quote.rich_text) }],
      }];
    }
    case "callout": {
      return [{
        type: "blockquote",
        content: [{ type: "paragraph", content: richTextToPmInline(block.callout.rich_text) }],
      }];
    }
    case "divider":
      return [{ type: "horizontalRule" }];
    case "image": {
      const img = block.image;
      let src = "";
      if (img.type === "external") {
        src = img.external.url;
      } else if (img.type === "file") {
        const uploaded = attachmentMap.get(img.file.url);
        if (uploaded) {
          src = `/api/workspaces/${slug}/blobs/${uploaded.objectId}/raw`;
        } else {
          src = img.file.url; // fallback to original (may expire)
        }
      }
      const caption = img.type === "external"
        ? extractPlainText(img.caption)
        : extractPlainText((img as { caption: RichTextItemResponse[] }).caption ?? []);
      return [{ type: "image", attrs: { src, alt: caption || null, title: null } }];
    }
    case "file":
    case "pdf": {
      const f = block.type === "file" ? block.file : block.pdf;
      let url = "";
      if (f.type === "external") {
        url = f.external.url;
      } else if (f.type === "file") {
        const uploaded = attachmentMap.get(f.file.url);
        url = uploaded ? `/api/workspaces/${slug}/blobs/${uploaded.objectId}/raw` : f.file.url;
      }
      return [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "link", attrs: { href: url } }], text: url }] }];
    }
    case "table": {
      const tableChildren = childBlocks;
      const rows: PMNode[] = tableChildren.map((rowBlock) => {
        if (rowBlock.type !== "table_row") return { type: "tableRow", content: [] };
        const cells: PMNode[] = rowBlock.table_row.cells.map((cell) => ({
          type: "tableCell",
          content: [{ type: "paragraph", content: richTextToPmInline(cell) }],
        }));
        return { type: "tableRow", content: cells };
      });
      return [{ type: "table", content: rows }];
    }
    case "equation": {
      return [{ type: "paragraph", content: [{ type: "text", text: block.equation.expression }] }];
    }
    case "child_page":
    case "child_database": {
      // These are their own Page rows; the block id IS the child's Notion id,
      // so link to the imported page instead of leaving dead placeholder text.
      const childTitle =
        (block.type === "child_page" ? block.child_page.title : block.child_database.title) ||
        "Untitled";
      const pearId = notionToId(block.id);
      return [{
        type: "paragraph",
        content: [{
          type: "text",
          marks: [{ type: "link", attrs: { href: `/workspace/${slug}/${pearId}` } }],
          text: `→ ${childTitle}`,
        }],
      }];
    }
    case "video": {
      const v = block.video;
      let url = "";
      if (v.type === "external") {
        url = v.external.url;
      } else if (v.type === "file") {
        const uploaded = attachmentMap.get(v.file.url);
        url = uploaded ? `/api/workspaces/${slug}/blobs/${uploaded.objectId}/raw` : v.file.url;
      }
      if (!url) return [];
      return [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "link", attrs: { href: url } }], text: url }] }];
    }
    case "audio": {
      const a = block.audio;
      let url = "";
      if (a.type === "external") {
        url = a.external.url;
      } else if (a.type === "file") {
        const uploaded = attachmentMap.get(a.file.url);
        url = uploaded ? `/api/workspaces/${slug}/blobs/${uploaded.objectId}/raw` : a.file.url;
      }
      if (!url) return [];
      return [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "link", attrs: { href: url } }], text: url }] }];
    }
    case "embed": {
      const url = block.embed.url;
      if (!url) return [];
      return [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "link", attrs: { href: url } }], text: url }] }];
    }
    case "bookmark": {
      const url = block.bookmark.url;
      const caption = extractPlainText(block.bookmark.caption ?? []);
      if (!url) return [];
      return [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "link", attrs: { href: url } }], text: caption || url }] }];
    }
    case "link_preview": {
      const url = block.link_preview.url;
      if (!url) return [];
      return [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "link", attrs: { href: url } }], text: url }] }];
    }
    case "link_to_page": {
      const ltp = block.link_to_page;
      const targetNotionId =
        ltp.type === "page_id" ? ltp.page_id :
        ltp.type === "database_id" ? ltp.database_id :
        null;
      if (!targetNotionId) return [];
      const pearId = notionToId(targetNotionId);
      return [{
        type: "paragraph",
        content: [{
          type: "text",
          marks: [{ type: "link", attrs: { href: `/workspace/${slug}/${pearId}` } }],
          text: "→ Linked page",
        }],
      }];
    }
    case "column_list": {
      // childBlocks are the column blocks; recurse into each column's children
      return childBlocks.flatMap((col) => {
        const colChildren = allBlocks.filter(
          (b) => "parent" in b && (b.parent as { block_id?: string }).block_id === col.id
        );
        return colChildren.flatMap((c) => blockToPmNodes(c, allBlocks, slug, attachmentMap, notionToId));
      });
    }
    case "column": {
      return childBlocks.flatMap((c) => blockToPmNodes(c, allBlocks, slug, attachmentMap, notionToId));
    }
    case "synced_block": {
      return childBlocks.flatMap((c) => blockToPmNodes(c, allBlocks, slug, attachmentMap, notionToId));
    }
    case "table_of_contents":
    case "breadcrumb":
      return [];
    default:
      // Unknown block — render plain text fallback
      return [];
  }
}

// ── ProseMirror → BlockNote conversion ────────────────────────────────────────
// Pear renders imported pages with `content_format: BlockNote`, whose JSON is
// a flat array of `{id, type, props, content, children}` blocks — not a
// ProseMirror doc. `blockToPmNodes` stays as the (well-tested) Notion→PM
// mapping; this pass flattens that PM tree into BlockNote blocks so imported
// page bodies actually render.

let bnIdCounter = 1;
function bnId(): string {
  return `notion-${(bnIdCounter++).toString(36)}`;
}

function bnProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { textColor: "default", backgroundColor: "default", textAlignment: "left", ...extra };
}

type BNBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown[] | Record<string, unknown>;
  children: BNBlock[];
};

function bnTextBlock(type: string, inline: unknown[], props: Record<string, unknown> = {}, children: BNBlock[] = []): BNBlock {
  return { id: bnId(), type, props: bnProps(props), content: inline, children };
}


/** Untrusted-content guard: only http(s) URLs survive into hrefs/images. */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** PM inline text (with marks) → BlockNote styled-text / link inline content. */
function pmInlineToBn(nodes: PMNode[] | undefined): unknown[] {
  const out: unknown[] = [];
  for (const n of nodes ?? []) {
    if ((n as { type?: string }).type !== "text") continue;
    const styles: Record<string, boolean> = {};
    let href: string | null = null;
    for (const m of ((n.marks as PMNode[] | undefined) ?? [])) {
      const t = m.type as string;
      if (t === "bold") styles.bold = true;
      else if (t === "italic") styles.italic = true;
      else if (t === "strike") styles.strikethrough = true;
      else if (t === "underline") styles.underline = true;
      else if (t === "code") styles.code = true;
      else if (t === "link") {
        const raw = (m.attrs as { href?: string } | undefined)?.href;
        // Workspace-relative paths (blob/page links we generated) are ours;
        // absolute URLs must be http(s).
        href = raw?.startsWith("/") ? raw : safeHttpUrl(raw);
      }
    }
    const text = { type: "text", text: (n.text as string) ?? "", styles };
    out.push(href ? { type: "link", href, content: [text] } : text);
  }
  return out;
}

/** Inline content of a listItem/taskItem's leading paragraph; rest → children. */
function splitItemContent(item: PMNode): { inline: unknown[]; children: BNBlock[] } {
  const parts = (item.content as PMNode[] | undefined) ?? [];
  const [first, ...rest] = parts;
  const inline = first?.type === "paragraph" ? pmInlineToBn(first.content as PMNode[]) : [];
  const children = (first?.type === "paragraph" ? rest : parts).flatMap(pmNodeToBnBlocks);
  return { inline, children };
}

function pmNodeToBnBlocks(node: PMNode): BNBlock[] {
  switch (node.type) {
    case "paragraph":
      return [bnTextBlock("paragraph", pmInlineToBn(node.content as PMNode[]))];
    case "heading": {
      const raw = Number((node.attrs as { level?: number } | undefined)?.level ?? 1);
      const level = Math.min(3, Math.max(1, Number.isFinite(raw) ? raw : 1));
      return [bnTextBlock("heading", pmInlineToBn(node.content as PMNode[]), { level })];
    }
    case "bulletList":
      return ((node.content as PMNode[]) ?? []).map((item) => {
        const { inline, children } = splitItemContent(item);
        return bnTextBlock("bulletListItem", inline, {}, children);
      });
    case "orderedList":
      return ((node.content as PMNode[]) ?? []).map((item) => {
        const { inline, children } = splitItemContent(item);
        return bnTextBlock("numberedListItem", inline, {}, children);
      });
    case "taskList":
      return ((node.content as PMNode[]) ?? []).map((item) => {
        const { inline, children } = splitItemContent(item);
        const checked = Boolean((item.attrs as { checked?: boolean } | undefined)?.checked);
        return bnTextBlock("checkListItem", inline, { checked }, children);
      });
    case "codeBlock": {
      // Conservative: a paragraph in code style (BlockNote codeBlock support
      // varies by version; a styled paragraph renders everywhere).
      const text = ((node.content as PMNode[]) ?? [])
        .map((t) => (t.text as string) ?? "")
        .join("");
      return [bnTextBlock("paragraph", text ? [{ type: "text", text, styles: { code: true } }] : [])];
    }
    case "blockquote":
      return ((node.content as PMNode[]) ?? []).flatMap(pmNodeToBnBlocks);
    case "horizontalRule":
      return [bnTextBlock("paragraph", [])];
    case "image": {
      const attrs = (node.attrs as { src?: string; alt?: string } | undefined) ?? {};
      // Relative /api/workspaces/... blob paths are ours; absolute URLs must be http(s).
      const src = attrs.src?.startsWith("/") ? attrs.src : safeHttpUrl(attrs.src);
      if (!src) return [];
      return [{
        id: bnId(),
        type: "image",
        props: {
          backgroundColor: "default",
          textAlignment: "left",
          name: attrs.alt ?? "",
          url: src,
          caption: attrs.alt ?? "",
          showPreview: true,
          previewWidth: 512,
        },
        content: [],
        children: [],
      }];
    }
    case "table": {
      const rows = ((node.content as PMNode[]) ?? []).map((row) => ({
        cells: ((row.content as PMNode[]) ?? []).map((cell) => {
          const cellParas = (cell.content as PMNode[]) ?? [];
          return cellParas.flatMap((p) => pmInlineToBn(p.content as PMNode[]));
        }),
      }));
      return [{
        id: bnId(),
        type: "table",
        props: { textColor: "default", backgroundColor: "default" },
        content: { type: "tableContent", rows },
        children: [],
      }];
    }
    default: {
      // Unknown container → flatten its children; bare text → paragraph.
      const inner = (node.content as PMNode[] | undefined) ?? [];
      if (inner.length > 0) return inner.flatMap(pmNodeToBnBlocks);
      if (typeof node.text === "string" && node.text) {
        return [bnTextBlock("paragraph", [{ type: "text", text: node.text, styles: {} }])];
      }
      return [];
    }
  }
}

/** Exported for tests. */
export function pmNodesToBlockNoteJson(nodes: PMNode[]): string {
  const blocks = nodes.flatMap(pmNodeToBnBlocks);
  return JSON.stringify(blocks.length > 0 ? blocks : [bnTextBlock("paragraph", [])]);
}

function buildBlockNoteContent(
  pageBlocks: BlockObjectResponse[],
  slug: string,
  attachmentMap: Map<string, AttachmentUploadResult>,
  notionToId: (id: string) => bigint,
  coverImageUrl?: string,
  description?: RichTextItemResponse[]
): string {
  // Top-level blocks only (children are inlined by blockToPmNodes when needed)
  const topLevel = pageBlocks.filter((b) => {
    const parent = "parent" in b ? (b.parent as { type?: string; block_id?: string }) : null;
    return !parent?.block_id; // block_id means it's a child of another block
  });

  const nodes = topLevel.flatMap((b) => blockToPmNodes(b, pageBlocks, slug, attachmentMap, notionToId));

  // Prepend cover image if present
  const prefixNodes: PMNode[] = [];
  if (coverImageUrl) {
    prefixNodes.push({ type: "image", attrs: { src: coverImageUrl, alt: "Cover", title: null } });
  }
  if (description && description.length > 0) {
    const inline = richTextToPmInline(description);
    if (inline.length > 0) prefixNodes.push({ type: "paragraph", content: inline });
  }
  return pmNodesToBlockNoteJson([...prefixNodes, ...nodes]);
}

// ── Database property transformers ────────────────────────────────────────────

function notionPropertyTypeToTag(notionType: string): string {
  const map: Record<string, string> = {
    title: "Text",
    rich_text: "Text",
    number: "Number",
    unique_id: "Number",
    date: "Date",
    created_time: "Date",
    last_edited_time: "Date",
    select: "Select",
    status: "Select",
    multi_select: "MultiSelect",
    checkbox: "Checkbox",
    verification: "Checkbox",
    url: "Url",
    email: "Url",
    phone_number: "Text",
    people: "Person",
    created_by: "Person",
    last_edited_by: "Person",
    relation: "Relation",
    formula: "Formula",
    rollup: "Rollup",
    files: "Text",
  };
  return map[notionType] ?? "Text";
}


/** Pear's option-chip palette. Notion's gray/brown collapse to default. */
const PEAR_OPTION_COLORS = new Set(["default", "blue", "green", "yellow", "orange", "red", "purple", "pink"]);

function pearSelectConfig(raw: { options?: { name: string; color: string }[] } | undefined): string {
  const options: string[] = [];
  const colors: Record<string, string> = {};
  for (const o of raw?.options ?? []) {
    if (typeof o?.name !== "string") continue;
    options.push(o.name);
    if (PEAR_OPTION_COLORS.has(o.color) && o.color !== "default") colors[o.name] = o.color;
  }
  return JSON.stringify(Object.keys(colors).length > 0 ? { options, colors } : { options });
}

function notionPropertyConfig(
  prop: { type: string } & Record<string, unknown>,
  notionToId: (id: string) => bigint
): string {
  // Pear stores select options as a string array + colors map — emitting
  // {label, color} objects crashed option renderers.
  if (prop.type === "select") {
    return pearSelectConfig(prop.select as { options?: { name: string; color: string }[] });
  }
  if (prop.type === "status") {
    return pearSelectConfig(prop.status as { options?: { name: string; color: string }[] });
  }
  if (prop.type === "multi_select") {
    return pearSelectConfig(prop.multi_select as { options?: { name: string; color: string }[] });
  }
  if (prop.type === "relation") {
    const rel = prop.relation as { database_id?: string };
    // Key the Pear UI reads (PropertyCell parses config.targetPageId). The
    // Notion database UUID maps to a payload-local Pear id here; the reducer
    // offset-remaps it into the workspace's id space at import time.
    const target = rel?.database_id ? String(notionToId(rel.database_id)) : null;
    return JSON.stringify(target ? { targetPageId: target } : {});
  }
  if (prop.type === "formula") {
    const f = prop.formula as { expression?: string } | undefined;
    return JSON.stringify({ expression: f?.expression ?? "" });
  }
  if (prop.type === "rollup") {
    const r = prop.rollup as {
      relation_property_name?: string;
      relation_property_id?: string;
      rollup_property_name?: string;
      rollup_property_id?: string;
      function?: string;
    } | undefined;
    return JSON.stringify({
      function: r?.function ?? "count",
      relationPropertyName: r?.relation_property_name ?? "",
      rollupPropertyName: r?.rollup_property_name ?? "",
    });
  }
  return "{}";
}

// Map a Notion page property value to a Pear PropertyValue wire object.
// Returns null for computed property types (Formula, Rollup) that should not be stored.
function notionPropValueToWire(
  prop: Record<string, unknown> & { type: string },
  notionToId: (id: string) => bigint
): unknown | null {
  switch (prop.type) {
    case "title": {
      const rt = (prop.title as RichTextItemResponse[] | undefined) ?? [];
      return { tag: "Text", value: extractPlainText(rt) };
    }
    case "rich_text": {
      const rt = (prop.rich_text as RichTextItemResponse[] | undefined) ?? [];
      return { tag: "Text", value: extractPlainText(rt) };
    }
    case "number":
      return { tag: "Number", value: typeof prop.number === "number" ? prop.number : 0 };
    case "unique_id": {
      const uid = prop.unique_id as { number?: number | null };
      return { tag: "Number", value: uid?.number ?? 0 };
    }
    case "date": {
      const d = prop.date as { start?: string | null } | null;
      const ts = d?.start ? new Date(d.start).getTime() : 0;
      return { tag: "Date", value: pearBigint(ts) };
    }
    case "created_time":
      return { tag: "Date", value: pearBigint(new Date(prop.created_time as string).getTime()) };
    case "last_edited_time":
      return { tag: "Date", value: pearBigint(new Date(prop.last_edited_time as string).getTime()) };
    case "select": {
      const s = prop.select as { name?: string } | null;
      return { tag: "Select", value: s?.name ?? "" };
    }
    case "status": {
      const s = prop.status as { name?: string } | null;
      return { tag: "Select", value: s?.name ?? "" };
    }
    case "multi_select": {
      const ms = (prop.multi_select as { name: string }[] | undefined) ?? [];
      return { tag: "MultiSelect", value: ms.map((x) => x.name) };
    }
    case "checkbox":
      return { tag: "Checkbox", value: Boolean(prop.checkbox) };
    case "verification": {
      const v = prop.verification as { state?: string } | null;
      return { tag: "Checkbox", value: v?.state === "verified" };
    }
    case "url":
      return { tag: "Url", value: typeof prop.url === "string" ? prop.url : "" };
    case "email":
      return { tag: "Url", value: typeof prop.email === "string" ? prop.email : "" };
    case "phone_number":
      return { tag: "Text", value: typeof prop.phone_number === "string" ? prop.phone_number : "" };
    case "people": {
      const people = (prop.people as { id: string; name?: string }[] | undefined) ?? [];
      return { tag: "Person", value: people.map((p) => p.name ?? p.id) };
    }
    case "created_by": {
      const cb = prop.created_by as { name?: string; id?: string } | undefined;
      return { tag: "Person", value: [cb?.name ?? cb?.id ?? ""] };
    }
    case "last_edited_by": {
      const lb = prop.last_edited_by as { name?: string; id?: string } | undefined;
      return { tag: "Person", value: [lb?.name ?? lb?.id ?? ""] };
    }
    case "relation": {
      const rels = (prop.relation as { id: string }[] | undefined) ?? [];
      return { tag: "Relation", value: rels.map((r) => pearBigint(notionToId(r.id))) };
    }
    case "formula":
      // Formula values are computed client-side; skip storing a static value
      return null;
    case "rollup":
      // Rollup values are computed client-side from related rows; skip storing a static value
      return null;
    case "files": {
      const files = (prop.files as { name?: string }[] | undefined) ?? [];
      return { tag: "Text", value: files.map((f) => f.name ?? "").join(", ") };
    }
    default:
      return { tag: "Text", value: "" };
  }
}

// ── Main transform function ───────────────────────────────────────────────────

export type NotionImportPayload = {
  format: "notion-import-v1";
  importedAt: string;
  callerIdentityHex: string;
  /** Source Notion workspace name; the reducer titles the container page with it. */
  notionWorkspaceName?: string | null;
  tables: {
    page: unknown[];
    page_content: unknown[];
    database_schema: unknown[];
    property_definition: unknown[];
    database_view: unknown[];
    page_property_value: unknown[];
    attachment: unknown[];
    conversation: unknown[];
    conversation_participant: unknown[];
    conversation_message: unknown[];
  };
};

/**
 * Transform a complete Notion fetch result into a notion-import-v1 payload.
 *
 * @param fetchResult        Output of fetchNotionWorkspace.
 * @param uploadedAttachments Output of reuploadNotionAttachments.
 * @param callerIdentityHex  The importing user's SpacetimeDB identity hex string.
 * @param workspaceSlug      Pear workspace slug (used to build blob URLs).
 */
export function transformNotionToPayload(
  fetchResult: NotionFetchResult,
  uploadedAttachments: Map<string, AttachmentUploadResult>,
  callerIdentityHex: string,
  workspaceSlug: string,
  notionWorkspaceName?: string | null
): NotionImportPayload {
  const notionToId = makeIdAssigner();
  const now = new Date().toISOString();

  // Which page each fetched block belongs to — resolves `block_id` page
  // parents (a page created inside a toggle/column) to its containing page.
  const blockToPage = new Map<string, string>();
  for (const [pageId, pageBlocks] of fetchResult.blocks) {
    for (const b of pageBlocks) blockToPage.set(b.id, pageId);
  }

  const pageRows: unknown[] = [];
  const pageContentRows: unknown[] = [];
  const dbSchemaRows: unknown[] = [];
  const propDefRows: unknown[] = [];
  const dbViewRows: unknown[] = [];
  const propValueRows: unknown[] = [];
  const attachmentRows: unknown[] = [];
  const conversationRows: unknown[] = [];
  const participantRows: unknown[] = [];
  const messageRows: unknown[] = [];

  let schemaIdCounter = 0n;
  let propDefIdCounter = 0n;
  let dbViewIdCounter = 0n;
  let propValueIdCounter = 0n;
  let attachmentIdCounter = 0n;
  let conversationIdCounter = 0n;
  let participantIdCounter = 0n;
  let messageIdCounter = 0n;

  // Build a map of data_source page_id → data source object for property schemas
  const databaseById = new Map<string, DataSourceObjectResponse>();
  for (const [id, page] of fetchResult.pages) {
    if (page.object === "data_source") {
      databaseById.set(id, page as DataSourceObjectResponse);
    }
  }

  // Build a map of database_id → schema_id and prop_name → prop_def_id
  // so we can fill in PagePropertyValues for rows
  type SchemaMeta = {
    schemaId: bigint;
    propDefs: Map<string, { defId: bigint; propType: string }>;
  };
  const schemaMetaByDbId = new Map<string, SchemaMeta>();

  // Sort pages so databases come before their rows
  const allPages = [...fetchResult.pages.values()];
  const orderedPages: NotionPage[] = [
    ...allPages.filter((p) => p.object === "data_source"),
    ...allPages.filter((p) => p.object === "page"),
  ];

  let sortPos = 0;

  for (const page of orderedPages) {
    const pearId = notionToId(page.id);
    const createdAt = pearTimestamp(page.created_time);
    const updatedAt = pearTimestamp(page.last_edited_time);
    const title = getPageTitle(page);
    const icon = getPageIcon(page);
    const isDatabase = page.object === "data_source";

    // Determine parent. Database rows carry `data_source_id` parents in the
    // current API (the pages map is keyed by data-source id); `database_id`
    // is the legacy shape; pages nested inside blocks (toggles, columns)
    // carry `block_id`, resolved to the containing page via blockToPage.
    let parentId: unknown = null;
    let parentPk = pearBigint(0n);
    if ("parent" in page && page.parent) {
      const parent = page.parent as Record<string, unknown>;
      let pid =
        (parent["data_source_id"] as string | undefined) ??
        (parent["page_id"] as string | undefined) ??
        (parent["database_id"] as string | undefined) ??
        null;
      const blockPid = parent["block_id"] as string | undefined;
      if ((!pid || !fetchResult.pages.has(pid)) && blockPid) {
        pid = blockToPage.get(blockPid) ?? null;
      }
      if (pid && fetchResult.pages.has(pid)) {
        const pidU64 = notionToId(pid);
        parentId = pearBigint(pidU64);
        parentPk = pearBigint(pidU64);
      }
    }

    sortPos += 1000;

    pageRows.push({
      id: pearBigint(pearId),
      parentId,
      pageType: isDatabase ? { tag: "Database" } : { tag: "Doc" },
      title,
      sortOrder: pearBigint(sortPos),
      embedding: null,
      createdBy: ACTOR_HUMAN,
      createdAt,
      updatedAt,
      deletedAt: null,
      icon,
      parentPk,
      isHidden: false,
    });

    // PageContent — blocks → ProseMirror JSON
    const pageBlocks = fetchResult.blocks.get(page.id) ?? [];

    // Compute cover image URL
    let coverImageUrl: string | undefined;
    if (page.cover) {
      if (page.cover.type === "external") {
        coverImageUrl = page.cover.external.url;
      } else if (page.cover.type === "file") {
        const uploaded = uploadedAttachments.get(page.cover.file.url);
        coverImageUrl = uploaded
          ? `/api/workspaces/${workspaceSlug}/blobs/${uploaded.objectId}/raw`
          : page.cover.file.url;
      }
    }

    // Compute database description
    let description: RichTextItemResponse[] | undefined;
    if (isDatabase) {
      const ds = page as DataSourceObjectResponse;
      if (ds.description && ds.description.length > 0) {
        description = ds.description as RichTextItemResponse[];
      }
    }

    const content = buildBlockNoteContent(pageBlocks, workspaceSlug, uploadedAttachments, notionToId, coverImageUrl, description);
    pageContentRows.push({
      pageId: pearBigint(pearId),
      content,
      updatedAt,
    });

    // Database schema + property definitions + default view
    if (isDatabase) {
      const db = page as DataSourceObjectResponse;
      schemaIdCounter += 1n;
      const schemaId = schemaIdCounter;
      const schemaMeta: SchemaMeta = { schemaId, propDefs: new Map() };
      schemaMetaByDbId.set(page.id, schemaMeta);

      dbSchemaRows.push({
        id: pearBigint(schemaId),
        pageId: pearBigint(pearId),
        name: title,
        config: null,
      });

      let propOrder = 0;
      for (const [propName, prop] of Object.entries(db.properties)) {
        // The title property maps to the Pear page title (built-in column);
        // emitting a definition for it duplicated it as a "Name" text column.
        if (prop.type === "title") continue;
        propDefIdCounter += 1n;
        const defId = propDefIdCounter;
        const pType = notionPropertyTypeToTag(prop.type);
        const config = notionPropertyConfig(
          prop as { type: string } & Record<string, unknown>,
          notionToId
        );

        propDefRows.push({
          id: pearBigint(defId),
          schemaId: pearBigint(schemaId),
          name: propName,
          propertyType: { tag: pType },
          config,
          order: pearBigint(propOrder),
        });

        schemaMeta.propDefs.set(propName, { defId, propType: pType });
        propOrder += 1000;
      }

      // Default Grid view
      dbViewIdCounter += 1n;
      dbViewRows.push({
        id: pearBigint(dbViewIdCounter),
        pageId: pearBigint(pearId),
        name: "Default View",
        viewType: VIEW_GRID,
        config: "{}",
        isDefault: true,
        ownerIdentity: null,
        createdBy: ACTOR_HUMAN,
        createdAt,
        updatedAt,
      });
    }
  }

  // PagePropertyValues — iterate database row pages
  for (const page of fetchResult.pages.values()) {
    if (page.object !== "page") continue;
    const p = page as PageObjectResponse;
    const parent = p.parent as Record<string, unknown>;
    // Rows carry data_source_id parents in the current API (schemaMetaByDbId
    // is keyed by data-source id); database_id is the legacy shape.
    const dbId =
      (parent["data_source_id"] as string | undefined) ??
      (parent["database_id"] as string | undefined);
    if (!dbId) continue;

    const meta = schemaMetaByDbId.get(dbId);
    if (!meta) continue;

    const rowPearId = notionToId(page.id);
    for (const [propName, prop] of Object.entries(p.properties)) {
      const propMeta = meta.propDefs.get(propName);
      if (!propMeta) continue;

      const value = notionPropValueToWire(
        prop as Record<string, unknown> & { type: string },
        notionToId
      );

      // Skip computed property types (Formula, Rollup) — values are client-side only
      if (value === null) continue;

      propValueIdCounter += 1n;
      propValueRows.push({
        id: pearBigint(propValueIdCounter),
        pageId: pearBigint(rowPearId),
        propertyDefinitionId: pearBigint(propMeta.defId),
        value,
      });
    }
  }

  // Attachments — only for successfully re-uploaded files
  for (const uploaded of uploadedAttachments.values()) {
    // Find the page this attachment belongs to via notionUrl matching
    const ref = [...fetchResult.attachmentRefs ?? []].find(
      (r) => r.notionUrl === uploaded.notionUrl
    );
    if (!ref) continue;
    const pagePearId = notionToId(ref.pageId);

    attachmentIdCounter += 1n;
    attachmentRows.push({
      id: pearBigint(attachmentIdCounter),
      pageId: pearBigint(pagePearId),
      filename: ref.filename || uploaded.objectId,
      contentType: uploaded.contentType,
      storageKey: uploaded.objectId,
      sizeBytes: pearBigint(uploaded.byteSize),
      createdAt: pearTimestamp(now),
    });
  }

  // Conversations + participants + messages (from Notion comments)
  const callerIdentity = pearIdentity(callerIdentityHex);
  for (const [pageId, pageComments] of fetchResult.comments) {
    if (pageComments.length === 0) continue;
    const pagePearId = notionToId(pageId);

    conversationIdCounter += 1n;
    const convId = conversationIdCounter;

    conversationRows.push({
      id: pearBigint(convId),
      pageId: pearBigint(pagePearId),
      initiatedBy: callerIdentity,
      status: STATUS_ACTIVE,
      createdAt: pearTimestamp(pageComments[0].created_time ?? now),
      updatedAt: pearTimestamp(now),
    });

    // Participant: the importing user
    participantIdCounter += 1n;
    participantRows.push({
      id: pearBigint(participantIdCounter),
      conversationId: pearBigint(convId),
      identity: callerIdentity,
      role: ROLE_INITIATOR,
      joinedAt: pearTimestamp(now),
      lastViewedMessageId: null,
      leftAt: null,
    });

    for (const comment of pageComments) {
      const text = comment.rich_text?.map((r: RichTextItemResponse) => r.plain_text).join("") ?? "";
      if (!text) continue;

      messageIdCounter += 1n;
      messageRows.push({
        id: pearBigint(messageIdCounter),
        conversationId: pearBigint(convId),
        sender: { tag: "User", value: callerIdentity },
        content: text,
        jobId: null,
        createdAt: pearTimestamp(comment.created_time ?? now),
        status: STATUS_COMPLETE,
        thinking: null,
        toolCallsJson: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
    }
  }

  return {
    format: "notion-import-v1",
    importedAt: now,
    notionWorkspaceName: notionWorkspaceName ?? null,
    callerIdentityHex,
    tables: {
      page: pageRows,
      page_content: pageContentRows,
      database_schema: dbSchemaRows,
      property_definition: propDefRows,
      database_view: dbViewRows,
      page_property_value: propValueRows,
      attachment: attachmentRows,
      conversation: conversationRows,
      conversation_participant: participantRows,
      conversation_message: messageRows,
    },
  };
}
