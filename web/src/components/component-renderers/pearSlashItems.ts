"use client";

import {
  SPRINT_3B_SLASH_ITEMS,
  type SlashMenuItem,
  type BlockTypeDefinition,
} from "@eclosion-tech/pulp";

/** Pear sprint-4 slash / turn-into items — extends pulp's curated set. */
export const PEAR_SLASH_ITEMS: SlashMenuItem[] = [
  ...SPRINT_3B_SLASH_ITEMS,
  {
    id: "bullet-list",
    section: "Lists",
    label: "Bullet list",
    description: "Simple bulleted list item.",
    componentType: "BulletListItem",
    defaultProps: { placeholder: "" },
    searchTokens: ["bullet", "list", "ul", "unordered"],
  },
  {
    id: "numbered-list",
    section: "Lists",
    label: "Numbered list",
    description: "Simple numbered list item.",
    componentType: "NumberedListItem",
    defaultProps: { placeholder: "" },
    searchTokens: ["number", "numbered", "list", "ol", "ordered"],
  },
  {
    id: "checklist",
    section: "Lists",
    label: "Checklist",
    description: "Task list item with a checkbox.",
    componentType: "ChecklistItem",
    defaultProps: { checked: false, placeholder: "" },
    searchTokens: ["check", "checklist", "todo", "task"],
  },
  {
    id: "image-block",
    section: "Media",
    label: "Image",
    description: "Upload an image with optional caption.",
    componentType: "ImageBlock",
    defaultProps: { storageKey: "", caption: "" },
    searchTokens: ["image", "photo", "picture", "upload"],
  },
  {
    id: "audio",
    section: "Media",
    label: "Audio",
    description: "Record or upload audio with transcript.",
    componentType: "Audio",
    defaultProps: { storageKey: "", transcript: "", durationSec: 0, boot: "" },
    searchTokens: ["audio", "record", "recording", "voice", "sound"],
  },
  {
    id: "new-page",
    section: "Pages",
    label: "New page",
    description: "Create a subpage linked here.",
    componentType: "PageLink",
    defaultProps: { pageId: "", pageTitle: "Untitled", createSubpage: true },
    searchTokens: ["new", "page", "subpage", "child", "doc"],
  },
  {
    id: "page-link",
    section: "Pages",
    label: "Link to page",
    description: "Link to an existing page.",
    componentType: "PageLink",
    defaultProps: { pageId: "", pageTitle: "Untitled" },
    searchTokens: ["page", "link", "existing", "doc"],
  },
];

/** Only offer slash items whose type exists in this workspace's registry table. */
export function slashItemsForDefs(
  items: SlashMenuItem[],
  defs: Map<string, BlockTypeDefinition>,
): SlashMenuItem[] {
  return items.filter((item) => defs.has(item.componentType));
}
