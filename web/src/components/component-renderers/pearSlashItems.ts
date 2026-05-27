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
    id: "page-link",
    label: "Page link",
    description: "Link to another page (set pageId in props).",
    componentType: "PageLink",
    defaultProps: { pageId: "", pageTitle: "Untitled" },
    searchTokens: ["page", "link", "subpage", "doc"],
  },
];

/** Only offer slash items whose type exists in this workspace's registry table. */
export function slashItemsForDefs(
  items: SlashMenuItem[],
  defs: Map<string, BlockTypeDefinition>,
): SlashMenuItem[] {
  return items.filter((item) => defs.has(item.componentType));
}
