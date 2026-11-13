"use client";

import {
  SPRINT_3B_SLASH_ITEMS,
  type SlashMenuItem,
  type BlockTypeDefinition,
} from "@eclosion-tech/pulp";

/**
 * Pear-only built-ins the slash menu expects in `component_type_definition`.
 * When any are missing, `slashItemsForDefs` hides them and inserts would fail.
 */
export const PEAR_REGISTRY_REQUIRED_TYPES = [
  "BulletListItem",
  "NumberedListItem",
  "ChecklistItem",
  "ImageBlock",
  "Audio",
  "FileBlock",
  "PageLink",
  // Custom-view runtime M2. Listed so `useEnsureBuiltinComponentTypes` runs
  // pending migrations on workspaces provisioned before the type existed —
  // without it, a repeater on an older workspace renders as an unregistered
  // component with no path to recovery.
  "Repeater",
  "Reference",
  "PropertyReference",
  "TrellisPanel",
] as const;

/** Pear sprint-4 slash / turn-into items — extends pulp's curated set. */
export const PEAR_SLASH_ITEMS: SlashMenuItem[] = [
  ...SPRINT_3B_SLASH_ITEMS,
  {
    id: "property", section: "Data", label: "Property", componentType: "PropertyReference",
    description: "Display a live text property from this page or another page.",
    defaultProps: {}, searchTokens: ["property", "summary", "reference", "text", "binding"],
  },
  {
    id: "trellis-component",
    section: "Components",
    label: "New component",
    description:
      "Build from scratch or collaborate with AI, connect live data, then save a reusable template.",
    componentType: "TrellisPanel",
    defaultProps: { kind: "component", title: "Untitled component" },
    searchTokens: ["component", "builder", "interface", "trellis", "template"],
  },
  {
    id: "reference",
    section: "Pages",
    label: "Reference",
    description: "Include and edit a page or block from elsewhere.",
    componentType: "Reference",
    defaultProps: {},
    searchTokens: ["reference", "include", "embed", "linked", "section"],
  },
  {
    id: "repeater",
    section: "Data",
    label: "Repeater",
    description:
      "Repeat a template for every row of a data source. Blocks placed inside become the template.",
    componentType: "Repeater",
    // A repeater with no dataSource renders a visible "invalid data source"
    // notice rather than nothing, so an unconfigured one is obvious and
    // recoverable instead of silently blank.
    defaultProps: {
      dataSource: { v: 1, entity: { kind: "pages", parentId: null } },
    },
    searchTokens: [
      "repeat",
      "repeater",
      "list",
      "rows",
      "data",
      "query",
      "view",
    ],
  },
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
    id: "file-block",
    section: "Media",
    label: "File",
    description: "Upload any file as a downloadable attachment.",
    componentType: "FileBlock",
    defaultProps: {
      storageKey: "",
      filename: "",
      contentType: "",
      sizeBytes: 0,
      caption: "",
    },
    searchTokens: [
      "file",
      "upload",
      "attachment",
      "attach",
      "document",
      "pdf",
      "csv",
      "zip",
      "download",
    ],
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

export function workspaceTemplateSlashItems(
  families: readonly {
    templateId: string;
    name: string;
    description: string;
    tagsJson: string;
    latestVersion: string;
    archived: boolean;
  }[],
  versions: readonly {
    templateId: string;
    version: string;
    contentHash: string;
    packageJson: string;
  }[],
): SlashMenuItem[] {
  return families
    .filter((family) => !family.archived)
    .flatMap((family) => {
      const version = versions.find(
        (row) =>
          row.templateId === family.templateId &&
          row.version === family.latestVersion,
      );
      if (!version) return [];
      try {
        const value = JSON.parse(version.packageJson);
        const descriptor =
          value.format === "trellis_authored_template_v1"
            ? {
                kind: "component-template",
                templateId: family.templateId,
                version: version.version,
                hash: version.contentHash,
              }
            : {
                templateId: value.definition.template.id,
                templateVersion: value.definition.template.version,
                parameters: {},
              };
        return [
          {
            id: `template:${family.templateId}`,
            section: "Components",
            label: family.name,
            description: family.description || "Reusable workspace component",
            componentType: "TrellisPanel",
            defaultProps: descriptor,
            searchTokens: [
              "component",
              "template",
              family.tagsJson.toLowerCase(),
            ],
          },
        ];
      } catch {
        return [];
      }
    });
}

/** Only offer slash items whose type exists in this workspace's registry table. */
export function slashItemsForDefs(
  items: SlashMenuItem[],
  defs: Map<string, BlockTypeDefinition>,
): SlashMenuItem[] {
  const filtered = items.filter((item) => defs.has(item.componentType));
  if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
    const hidden = items.filter((item) => !defs.has(item.componentType));
    if (hidden.length > 0) {
      console.debug(
        "[slash menu] hidden — not in workspace registry:",
        hidden.map((item) => item.componentType),
      );
    }
  }
  return filtered;
}
