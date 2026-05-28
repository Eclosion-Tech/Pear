import {
  headingPropsJson,
  normalizeTextAlign,
} from "../rich-text/richTextFormatting";
import {
  blockNoteInlineToYDoc,
  blockNoteInlineToYjsUpdate,
  type BlockNoteInlineNode,
} from "./blockNoteInline";

/**
 * BlockNote → ComponentTree conversion for document lists (DF-007).
 *
 * **List mapping**
 * - `bulletListItem` → `BulletListItem`
 * - `numberedListItem` → `NumberedListItem`
 * - `checkListItem` → `ChecklistItem` (`props.checked` from BlockNote)
 *
 * **Nesting**
 * BlockNote stores Tab-nested blocks in `block.children`. Each child becomes
 * a `ComponentNode` whose parent is the converted list item (or other
 * `accepts_children` ancestor). Sibling order in `children` is preserved —
 * numbered markers are renderer-derived from contiguous `NumberedListItem`
 * siblings, so no `start` prop is emitted.
 *
 * **Inline content**
 * List-item text lives in the item's Yjs doc (not a nested `RichText` child).
 * Non-list blocks nested under a list item (e.g. paragraph via Tab) convert
 * normally and become children of that list item.
 *
 * Output is depth-first preorder so migration reducers can insert parent
 * before child. `sourceBlockId` retains the original BlockNote block id for
 * correlating per-block Yjs slices from the page-level Y.Doc when available.
 */

export type BlockNoteBlock = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: BlockNoteInlineNode[];
  children?: BlockNoteBlock[];
};

export type ConvertedComponentNode = {
  sourceBlockId: string;
  parentSourceBlockId: string | null;
  componentType: string;
  props: Record<string, unknown>;
  /** Present when the target type is Yjs-backed (`RichText`, list items, `Heading`). */
  yjsUpdate: Uint8Array | null;
  siblingIndex: number;
};

export type ConvertBlockNoteOptions = {
  /** When false, unknown block types become `RichText`. Default true. */
  skipUnknownBlocks?: boolean;
};

const LIST_BLOCK_TYPES = new Set([
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
]);

const YJS_BLOCK_TYPES = new Set([
  "paragraph",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "heading",
  "codeBlock",
]);

/**
 * Flatten a BlockNote document into ComponentTree insert descriptors.
 * Root-level blocks use `parentSourceBlockId: null`.
 */
export function convertBlockNoteDocument(
  blocks: BlockNoteBlock[],
  opts: ConvertBlockNoteOptions = {},
): ConvertedComponentNode[] {
  const out: ConvertedComponentNode[] = [];
  walkBlocks(blocks, null, out, opts);
  return out;
}

function walkBlocks(
  blocks: BlockNoteBlock[],
  parentSourceId: string | null,
  out: ConvertedComponentNode[],
  opts: ConvertBlockNoteOptions,
): void {
  blocks.forEach((block, siblingIndex) => {
    const converted = convertBlock(block, parentSourceId, siblingIndex, opts);
    if (!converted) return;
    out.push(converted);
    if (block.children?.length) {
      walkBlocks(block.children, block.id, out, opts);
    }
  });
}

function convertBlock(
  block: BlockNoteBlock,
  parentSourceBlockId: string | null,
  siblingIndex: number,
  opts: ConvertBlockNoteOptions,
): ConvertedComponentNode | null {
  const mapped = mapBlockNoteBlock(block);
  if (!mapped) {
    if (opts.skipUnknownBlocks) return null;
    return null;
  }

  const yjsUpdate = YJS_BLOCK_TYPES.has(block.type)
    ? blockNoteInlineToYjsUpdate(block.content, block.props?.textAlignment)
    : null;

  return {
    sourceBlockId: block.id,
    parentSourceBlockId,
    componentType: mapped.componentType,
    props: mapped.props,
    yjsUpdate,
    siblingIndex,
  };
}

type MappedBlock = {
  componentType: string;
  props: Record<string, unknown>;
};

function mapBlockNoteBlock(block: BlockNoteBlock): MappedBlock | null {
  switch (block.type) {
    case "paragraph":
      return { componentType: "RichText", props: {} };

    case "heading": {
      const level = clampHeadingLevel(block.props?.level);
      const textAlign = normalizeTextAlign(block.props?.textAlignment);
      return {
        componentType: "Heading",
        props: JSON.parse(
          headingPropsJson(level, {
            textAlign,
            collapsed: block.props?.isToggleable === true,
          }),
        ),
      };
    }

    case "bulletListItem":
      return mapListItem("BulletListItem", block);

    case "numberedListItem":
      return mapListItem("NumberedListItem", block);

    case "checkListItem":
      return mapListItem("ChecklistItem", block, {
        checked: block.props?.checked === true,
      });

    case "image":
      return {
        componentType: "ImageBlock",
        props: {
          storageKey: String(
            block.props?.storageKey ?? block.props?.url ?? "",
          ),
          caption:
            String(block.props?.caption ?? "") || captionFromInline(block.content),
        },
      };

    case "pageLink":
      return {
        componentType: "PageLink",
        props: {
          pageId: String(block.props?.pageId ?? ""),
          pageTitle: String(block.props?.pageTitle ?? "Untitled"),
        },
      };

    case "conversation":
      return {
        componentType: "Conversation",
        props: {
          conversationId: String(block.props?.conversationId ?? ""),
          collapsed: String(block.props?.collapsed ?? "true"),
          autoCollapseThresholdMinutes: String(
            block.props?.autoCollapseThresholdMinutes ?? "60",
          ),
        },
      };

    case "audio":
      return {
        componentType: "Audio",
        props: {
          storageKey: String(block.props?.storageKey ?? ""),
          transcript: String(block.props?.transcript ?? ""),
          durationSec: Number(block.props?.durationSec) || 0,
          boot: String(block.props?.boot ?? ""),
        },
      };

    case "codeBlock":
      return { componentType: "RichText", props: {} };

    default:
      if (Array.isArray(block.content) && block.content.length > 0) {
        return { componentType: "RichText", props: {} };
      }
      return null;
  }
}

function mapListItem(
  componentType: string,
  block: BlockNoteBlock,
  extra: Record<string, unknown> = {},
): MappedBlock {
  return {
    componentType,
    props: {
      ...extra,
      ...(normalizeTextAlign(block.props?.textAlignment) !== "left"
        ? { textAlign: normalizeTextAlign(block.props?.textAlignment) }
        : {}),
    },
  };
}

function clampHeadingLevel(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, Math.round(n)));
}

function captionFromInline(inline: BlockNoteInlineNode[] | undefined): string {
  if (!inline?.length) return "";
  return inline
    .map((n) => {
      if (n.type === "text") return n.text;
      if (n.type === "link") {
        return (n.content ?? [])
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");
      }
      return "";
    })
    .join("");
}

/** Whether a BlockNote block type is a document list row. */
export function isBlockNoteListBlock(type: string): boolean {
  return LIST_BLOCK_TYPES.has(type);
}

/** Re-export for migration tooling that builds Y.Doc without the flat walk. */
export { blockNoteInlineToYDoc, blockNoteInlineToYjsUpdate };
