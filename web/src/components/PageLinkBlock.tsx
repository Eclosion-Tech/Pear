"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useRouter } from "next/navigation";
import { usePages } from "@/src/hooks/usePages";

/**
 * Factory that produces the pageLink BlockSpec for BlockNoteSchema.create.
 *
 * In BlockNote v0.47, createReactBlockSpec returns a factory function — you
 * must call the result (e.g. PageLinkBlockSpec()) to get the actual BlockSpec.
 *
 * The block stores BOTH pageId and pageTitle as props. pageTitle is set at
 * insertion time and cached in the Yjs doc / IndexedDB so the link renders
 * instantly without waiting for SpacetimeDB. The live subscription title
 * overrides the cached one once available (handles renames automatically).
 */
export const PageLinkBlockSpec = createReactBlockSpec(
  {
    type: "pageLink" as const,
    propSchema: {
      pageId: { default: "" },
      pageTitle: { default: "Untitled" },
    },
    content: "none",
  },
  {
    render: ({ block }) => (
      <PageLinkRenderer
        pageId={block.props.pageId}
        cachedTitle={block.props.pageTitle}
      />
    ),
  }
);

// ─── Renderer ────────────────────────────────────────────────────────────────

function PageLinkRenderer({
  pageId,
  cachedTitle,
}: {
  pageId: string;
  cachedTitle: string;
}) {
  const router = useRouter();
  const { pages } = usePages();
  const livePage = pages.find((p) => String(p.id) === pageId);

  // Show live title when available (handles renames); fall back to the title
  // baked into the block props so content renders immediately from IndexedDB
  // without waiting for the SpacetimeDB subscription to land.
  const title = livePage?.title || cachedTitle;

  return (
    <div
      contentEditable={false}
      onMouseDown={(e) => {
        e.preventDefault();
        router.push(`/workspace/${pageId}`);
      }}
      className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors group select-none my-0.5"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-neutral-400 dark:text-neutral-600"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-sm text-neutral-700 dark:text-neutral-300 font-medium">
        {title}
      </span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 ml-auto text-neutral-300 dark:text-neutral-700 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    </div>
  );
}
