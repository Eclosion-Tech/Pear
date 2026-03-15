"use client";

import { createReactBlockSpec, useBlockNoteEditor } from "@blocknote/react";
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
 *
 * When the referenced page is deleted or moved out of scope, the block shows
 * a tombstone state and can be removed with a single click.
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
        block={block}
        pageId={block.props.pageId}
        cachedTitle={block.props.pageTitle}
      />
    ),
  }
);

// ─── Renderer ────────────────────────────────────────────────────────────────

function PageLinkRenderer({
  block,
  pageId,
  cachedTitle,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any;
  pageId: string;
  cachedTitle: string;
}) {
  const router = useRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = useBlockNoteEditor() as any;
  const { pages } = usePages();
  const livePage = pages.find((p) => String(p.id) === pageId);

  // Page has been deleted or moved out of reach — show tombstone.
  if (!livePage) {
    return (
      <div
        contentEditable={false}
        className="flex items-center gap-2 px-2 py-1.5 rounded select-none my-0.5 opacity-50 group"
      >
        {/* Broken-link icon */}
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
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
        <span className="text-sm text-neutral-400 dark:text-neutral-500 line-through">
          {cachedTitle}
        </span>
        <span className="text-xs text-neutral-400 dark:text-neutral-600 ml-0.5">
          — deleted
        </span>
        <button
          title="Remove this block"
          className="ml-auto text-neutral-400 hover:text-red-400 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs leading-none"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            editor.removeBlocks([block]);
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  // Show live title when available (handles renames); fall back to the title
  // baked into the block props so content renders immediately from IndexedDB
  // without waiting for the SpacetimeDB subscription to land.
  const title = livePage.title || cachedTitle;

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
