"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { usePulp, type BlockRendererProps } from "@eclosion-tech/pulp";
import {
  filterNavVisiblePages,
  useConnection,
  useCreateComponentTreePage,
  usePages,
  useUpdateComponentProps,
  type PageRow,
} from "@/src/hooks/usePages";

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
  createSubpage?: boolean;
};

export function PageLinkRenderer({ node }: BlockRendererProps) {
  const props = useMemo<PageLinkProps>(() => safeParse(node.props), [node.props]);
  const router = useRouter();
  const { deleteBlock } = usePulp();
  const { pages } = usePages();
  const updateComponentProps = useUpdateComponentProps();
  const createComponentTreePage = useCreateComponentTreePage();
  const spacetime = useConnection();
  const pendingInsertCleanupRef = useRef<(() => void) | null>(null);
  const autoCreateStartedRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const pageId = props.pageId ?? "";
  const cachedTitle = props.pageTitle ?? "Untitled";
  const livePage = pages.find((p) => String(p.id) === pageId);
  const visiblePages = useMemo(() => filterNavVisiblePages(pages), [pages]);

  useEffect(() => {
    return () => {
      pendingInsertCleanupRef.current?.();
      pendingInsertCleanupRef.current = null;
    };
  }, []);

  function selectPage(page: PageRow) {
    updateComponentProps({
      componentId: node.id,
      propsJson: JSON.stringify({
        pageId: String(page.id),
        pageTitle: page.title || "Untitled",
      }),
    });
    setPickerOpen(false);
  }

  async function createSubpage() {
    if (creating) return;
    const conn = spacetime.getConnection();
    if (!conn) return;

    setCreating(true);

    const knownChildIds = new Set(
      Array.from((conn.db as any).page?.iter?.() ?? [])
        .filter((p: any) => p.parentId === node.surfaceId && p.deletedAt == null)
        .map((p: any) => String(p.id)),
    );

    const cleanup = () => {
      (conn.db as any).page?.removeOnInsert?.(onInsert);
    };

    const onInsert = (_ctx: unknown, newPage: PageRow) => {
      if (newPage.parentId !== node.surfaceId) return;
      if (knownChildIds.has(String(newPage.id))) return;

      cleanup();
      pendingInsertCleanupRef.current = null;
      updateComponentProps({
        componentId: node.id,
        propsJson: JSON.stringify({
          pageId: String(newPage.id),
          pageTitle: newPage.title || "Untitled",
        }),
      });
      setCreating(false);
      setPickerOpen(false);
    };

    pendingInsertCleanupRef.current?.();
    pendingInsertCleanupRef.current = cleanup;
    (conn.db as any).page?.onInsert?.(onInsert);

    try {
      await createComponentTreePage({
        parentId: node.surfaceId,
        pageType: { tag: "Doc" },
        title: "Untitled",
      });
    } catch (err) {
      cleanup();
      pendingInsertCleanupRef.current = null;
      setCreating(false);
      console.error("[PageLink] Failed to create subpage", err);
    }
  }

  useEffect(() => {
    if (pageId || !props.createSubpage || autoCreateStartedRef.current) return;
    autoCreateStartedRef.current = true;
    void createSubpage();
  });

  if (!pageId) {
    return (
      <div className="relative my-0.5">
        <div className="flex items-center gap-2.5 rounded px-2 py-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors group">
          <PageIcon />
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => setPickerOpen(true)}
          >
            Link to page
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
            onClick={createSubpage}
            disabled={creating}
          >
            {creating ? "Creating…" : "New subpage"}
          </button>
        </div>
        {pickerOpen && (
          <PagePicker
            pages={visiblePages}
            onSelect={selectPage}
            onCreate={createSubpage}
            onClose={() => setPickerOpen(false)}
            creating={creating}
          />
        )}
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

function PagePicker({
  pages,
  creating,
  onSelect,
  onCreate,
  onClose,
}: {
  pages: PageRow[];
  creating: boolean;
  onSelect: (page: PageRow) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = pages
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    if (!q) return source.slice(0, 10);
    return source
      .filter((page) => {
        const title = (page.title || "Untitled").toLowerCase();
        return title.includes(q) || buildBreadcrumb(page, pages).toLowerCase().includes(q);
      })
      .slice(0, 10);
  }, [pages, query]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, results.length]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      onClose();
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const page = results[activeIndex];
      if (page) onSelect(page);
    }
  }

  return (
    <div
      ref={popoverRef}
      className="absolute left-2 top-full z-40 mt-1 w-[320px] overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      <div className="border-b border-neutral-100 p-2 dark:border-neutral-800">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search pages…"
          className="w-full rounded border border-neutral-200 bg-transparent px-2 py-1.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100 disabled:opacity-60 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          <span className="text-neutral-400">+</span>
          <span>{creating ? "Creating…" : "New subpage"}</span>
        </button>
        {results.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-neutral-400 dark:text-neutral-500">
            No pages found
          </div>
        ) : (
          results.map((page, index) => {
            const title = page.title || "Untitled";
            const breadcrumb = buildBreadcrumb(page, pages);
            return (
              <button
                key={String(page.id)}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelect(page)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  index === activeIndex
                    ? "bg-neutral-100 dark:bg-neutral-800"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                }`}
              >
                <PageIcon />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-neutral-900 dark:text-neutral-100">
                    {title}
                  </span>
                  {breadcrumb && (
                    <span className="block truncate text-xs text-neutral-400 dark:text-neutral-500">
                      {breadcrumb}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function buildBreadcrumb(page: PageRow, allPages: PageRow[]): string {
  const parts: string[] = [];
  let cur = page;
  while (cur.parentId != null) {
    const parent = allPages.find((p) => p.id === cur.parentId);
    if (!parent) break;
    parts.unshift(parent.title || "Untitled");
    cur = parent;
  }
  return parts.join(" / ");
}

function safeParse(s: string): PageLinkProps {
  try {
    return JSON.parse(s) as PageLinkProps;
  } catch {
    return {};
  }
}
