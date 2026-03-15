"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { usePages } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";

// ─── Fuzzy match ──────────────────────────────────────────────────────────────
// Returns null if no match, otherwise a score (lower = better) and the indices
// of matched characters in the target string for highlighting.

function fuzzyMatch(
  query: string,
  target: string
): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  if (qi < q.length) return null;

  // Score: penalise gaps between matched chars; reward word-boundary matches
  let score = 0;
  for (let i = 1; i < indices.length; i++) {
    score += indices[i] - indices[i - 1] - 1;
  }
  // Small bonus for matching at the start of the string
  if (indices[0] === 0) score -= 5;
  return { score, indices };
}

// Highlight matched characters in a string
function Highlighted({
  text,
  indices,
}: {
  text: string;
  indices: number[];
}) {
  const set = new Set(indices);
  return (
    <>
      {text.split("").map((ch, i) =>
        set.has(i) ? (
          <mark
            key={i}
            className="bg-transparent text-blue-600 dark:text-blue-400 font-semibold"
          >
            {ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </>
  );
}

// ─── Breadcrumb builder ───────────────────────────────────────────────────────

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

// ─── QuickSwitcher ────────────────────────────────────────────────────────────

interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
}

export function QuickSwitcher({ open, onClose }: QuickSwitcherProps) {
  const router = useRouter();
  const { pages } = usePages();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Compute results: when no query, show all pages sorted by sort order;
  // when query, fuzzy-match and sort by score.
  const results = useMemo<Array<{ page: PageRow; indices: number[] }>>(() => {
    const q = query.trim();
    if (!q) {
      return pages
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .slice(0, 12)
        .map((page) => ({ page, indices: [] }));
    }
    return pages
      .map((page) => {
        const m = fuzzyMatch(q, page.title || "Untitled");
        return m ? { page, indices: m.indices, score: m.score } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map(({ page, indices }) => ({ page, indices }));
  }, [query, pages]);

  // Reset selection when results change
  useEffect(() => setSelectedIdx(0), [results]);

  // Focus + reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      // rAF so the element is mounted and visible before we focus
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    const item = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  function navigate(pageId: string) {
    router.push(`/workspace/${pageId}`);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "Escape":
        onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        if (results[selectedIdx]) navigate(String(results[selectedIdx].page.id));
        break;
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-lg mx-4 bg-white dark:bg-neutral-900 rounded-xl shadow-2xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {/* Search input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          {/* Search icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-neutral-400 dark:text-neutral-500"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>

          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to page…"
            className="flex-1 bg-transparent outline-none text-sm text-neutral-900 dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
          />

          {query ? (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setQuery("")}
              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors text-xs"
            >
              ✕
            </button>
          ) : (
            <kbd className="text-[10px] text-neutral-300 dark:text-neutral-600 border border-neutral-200 dark:border-neutral-700 rounded px-1 py-0.5 font-mono leading-none">
              esc
            </kbd>
          )}
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
              No pages found
            </p>
          ) : (
            results.map(({ page, indices }, i) => {
              const breadcrumb = buildBreadcrumb(page, pages);
              const title = page.title || "Untitled";
              return (
                <button
                  key={String(page.id)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => navigate(String(page.id))}
                  onMouseEnter={() => setSelectedIdx(i)}
                  className={`w-full text-left flex items-center gap-3 px-4 py-2 transition-colors ${
                    i === selectedIdx
                      ? "bg-blue-50 dark:bg-blue-900/30"
                      : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                  }`}
                >
                  {/* Page type icon */}
                  <span className="text-base shrink-0 leading-none">
                    {page.pageType.tag === "Database" ? "⊞" : "📄"}
                  </span>

                  {/* Title + breadcrumb */}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-neutral-900 dark:text-white truncate">
                      <Highlighted text={title} indices={indices} />
                    </div>
                    {breadcrumb && (
                      <div className="text-xs text-neutral-400 dark:text-neutral-500 truncate mt-0.5">
                        {breadcrumb}
                      </div>
                    )}
                  </div>

                  {/* Enter hint on selected row */}
                  {i === selectedIdx && (
                    <kbd className="ml-auto shrink-0 text-[10px] text-neutral-300 dark:text-neutral-600 border border-neutral-200 dark:border-neutral-700 rounded px-1 py-0.5 font-mono leading-none">
                      ↵
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-neutral-100 dark:border-neutral-800 flex items-center gap-4 text-[10px] text-neutral-300 dark:text-neutral-600">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
