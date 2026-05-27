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
    id: "image-block",
    label: "Image",
    description: "Upload an image with optional caption.",
    componentType: "ImageBlock",
    defaultProps: { storageKey: "", caption: "" },
    searchTokens: ["image", "photo", "picture", "upload"],
  },
  {
    id: "audio",
    label: "Audio",
    description: "Record or upload audio with transcript.",
    componentType: "Audio",
    defaultProps: { storageKey: "", transcript: "", durationSec: 0, boot: "" },
    searchTokens: ["audio", "record", "recording", "voice", "sound"],
  },
  {
    id: "new-page",
    label: "New page",
    description: "Create a subpage linked here.",
    componentType: "PageLink",
    defaultProps: { pageId: "", pageTitle: "Untitled", createSubpage: true },
    searchTokens: ["new", "page", "subpage", "child", "doc"],
  },
  {
    id: "page-link",
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
