"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { usePulp, type BlockRendererProps } from "@eclosion-tech/pulp";
import { usePages } from "@/src/hooks/usePages";

/**
 * Built-in `PageLink` — navigates to a workspace page by id.
 *
 * Prop schema (`prop_schemas::PAGE_LINK` in components.rs):
 *   { pageId: string (required), pageTitle: string (required) }
 *
 * Ported from BlockNote `PageLinkBlock`; tombstone + remove when deleted.
 */
type PageLinkProps = {
  pageId?: string;
  pageTitle?: string;
};

export function PageLinkRenderer({ node }: BlockRendererProps) {
  const props = useMemo<PageLinkProps>(() => safeParse(node.props), [node.props]);
  const router = useRouter();
  const { deleteBlock } = usePulp();
  const { pages } = usePages();

  const pageId = props.pageId ?? "";
  const cachedTitle = props.pageTitle ?? "Untitled";
  const livePage = pages.find((p) => String(p.id) === pageId);

  if (!pageId) {
    return (
      <div className="my-0.5 rounded border border-dashed border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs text-neutral-400">
        Page link — no page selected
      </div>
    );
  }

  if (!livePage) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 rounded select-none my-0.5 opacity-50 group"
      >
        <BrokenLinkIcon />
        <span className="text-sm text-neutral-400 dark:text-neutral-500 line-through">
          {cachedTitle}
        </span>
        <span className="text-xs text-neutral-400 dark:text-neutral-600 ml-0.5">
          — deleted
        </span>
        <button
          type="button"
          title="Remove this block"
          className="ml-auto text-neutral-400 hover:text-red-400 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs leading-none"
          onClick={() => deleteBlock({ componentId: node.id })}
        >
          ✕
        </button>
      </div>
    );
  }

  const title = livePage.title || cachedTitle;

  return (
    <div
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(`/workspace/${pageId}`);
        }
      }}
      onClick={() => router.push(`/workspace/${pageId}`)}
      className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors group select-none my-0.5"
    >
      <PageIcon />
      <span className="text-sm text-neutral-700 dark:text-neutral-300 font-medium">
        {title}
      </span>
      <ChevronIcon />
    </div>
  );
}

function PageIcon() {
  return (
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
  );
}

function BrokenLinkIcon() {
  return (
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
  );
}

function ChevronIcon() {
  return (
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
  );
}

function safeParse(s: string): PageLinkProps {
  try {
    return JSON.parse(s) as PageLinkProps;
  } catch {
    return {};
  }
}
