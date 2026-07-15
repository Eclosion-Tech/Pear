"use client";

import { createReactBlockSpec } from "@blocknote/react";

/**
 * Callout block: an icon + tinted panel with editable inline content,
 * matching Notion's callout semantics (the Notion importer emits these).
 *
 * Like PageLinkBlockSpec, createReactBlockSpec returns a factory in
 * BlockNote v0.47 — call CalloutBlockSpec() when building the schema.
 *
 * `color` uses the shared nine-color palette (gray, brown, red, orange,
 * yellow, green, blue, purple, pink) or "default".
 */

const CALLOUT_BG: Record<string, string> = {
  default: "bg-neutral-100 dark:bg-neutral-800/60",
  gray: "bg-neutral-200/70 dark:bg-neutral-700/50",
  brown: "bg-amber-100/70 dark:bg-amber-900/30",
  red: "bg-red-100/70 dark:bg-red-900/30",
  orange: "bg-orange-100/70 dark:bg-orange-900/30",
  yellow: "bg-yellow-100/70 dark:bg-yellow-900/30",
  green: "bg-green-100/70 dark:bg-green-900/30",
  blue: "bg-blue-100/70 dark:bg-blue-900/30",
  purple: "bg-purple-100/70 dark:bg-purple-900/30",
  pink: "bg-pink-100/70 dark:bg-pink-900/30",
};

export const CalloutBlockSpec = createReactBlockSpec(
  {
    type: "callout" as const,
    propSchema: {
      icon: { default: "" },
      color: { default: "default" },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef }) => {
      const bg = CALLOUT_BG[block.props.color] ?? CALLOUT_BG.default;
      return (
        <div className={`flex items-start gap-2 rounded-md px-3 py-2.5 my-0.5 ${bg}`}>
          {block.props.icon ? (
            <span className="shrink-0 text-base leading-6 select-none">{block.props.icon}</span>
          ) : null}
          <div ref={contentRef} className="flex-1 min-w-0" />
        </div>
      );
    },
  }
);
