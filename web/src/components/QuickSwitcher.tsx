"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { usePages, filterNavVisiblePages } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { cosineSimilarity, getPageEmbeddingVector } from "@/src/lib/semanticSearch";

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

  let score = 0;
  for (let i = 1; i < indices.length; i++) {
    score += indices[i] - indices[i - 1] - 1;
  }
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

type ResultRow = {
  page: PageRow;
  indices: number[];
  /** How this row matched — for subtle UI hint */
  matchKind: "title" | "semantic";
};

// ─── QuickSwitcher ────────────────────────────────────────────────────────────

interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
}

export function QuickSwitcher({ open, onClose }: QuickSwitcherProps) {
  const router = useRouter();
  const { pages: allPages } = usePages();
  const pages = useMemo(() => filterNavVisiblePages(allPages), [allPages]);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [semanticScores, setSemanticScores] = useState<Map<string, number>>(new Map());
  const [semanticBusy, setSemanticBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Latest pages for async semantic search (SpacetimeDB gives a new `pages` array ref every render). */
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  /** Stable string — only changes when a page id or embedding presence changes (not array identity). */
  const embeddingIndexKey = useMemo(
    () =>
      pages
        .map((p) => `${p.id}:${getPageEmbeddingVector(p) ? "1" : "0"}`)
        .join("|"),
    [pages]
  );

  const hasEmbeddings = useMemo(
    () => pages.some((p) => getPageEmbeddingVector(p) !== null),
    [pages]
  );

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSemanticBusy(false);
      setSemanticScores((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }

    const pagesWithEmb = pagesRef.current.filter(
      (p) => getPageEmbeddingVector(p) !== null
    );
    if (pagesWithEmb.length === 0) {
      setSemanticBusy(false);
      setSemanticScores((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }

    const t = setTimeout(() => {
      void (async () => {
        setSemanticBusy(true);
        try {
          const res = await fetch("/api/embed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: q }),
          });
          if (!res.ok) {
            setSemanticScores((prev) => (prev.size === 0 ? prev : new Map()));
            return;
          }
          const data = (await res.json()) as { embedding?: number[] };
          const qEmb = data.embedding;
          if (!qEmb?.length) {
            setSemanticScores((prev) => (prev.size === 0 ? prev : new Map()));
            return;
          }
          const next = new Map<string, number>();
          for (const p of pagesRef.current) {
            const pv = getPageEmbeddingVector(p);
            if (!pv) continue;
            const sim = cosineSimilarity(qEmb, pv);
            if (sim > 0.2) next.set(String(p.id), sim);
          }
          setSemanticScores(next);
        } finally {
          setSemanticBusy(false);
        }
      })();
    }, 280);
    return () => clearTimeout(t);
  }, [query, embeddingIndexKey]);

  const results = useMemo<ResultRow[]>(() => {
    const q = query.trim();
    if (!q) {
      return pages
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .slice(0, 12)
        .map((page) => ({ page, indices: [], matchKind: "title" as const }));
    }

    const fuzzyRows: Array<{
      page: PageRow;
      indices: number[];
      score: number;
    }> = [];
    for (const page of pages) {
      const m = fuzzyMatch(q, page.title || "Untitled");
      if (m) fuzzyRows.push({ page, indices: m.indices, score: m.score });
    }
    fuzzyRows.sort((a, b) => a.score - b.score);

    const seen = new Set<string>();
    const out: ResultRow[] = [];

    const semanticSorted = [...semanticScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => pages.find((p) => String(p.id) === id))
      .filter((p): p is PageRow => p != null);

    for (const page of semanticSorted) {
      const id = String(page.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const fm = fuzzyMatch(q, page.title || "Untitled");
      out.push({
        page,
        indices: fm?.indices ?? [],
        matchKind: "semantic",
      });
    }

    for (const row of fuzzyRows) {
      const id = String(row.page.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        page: row.page,
        indices: row.indices,
        matchKind: "title",
      });
    }

    return out.slice(0, 12);
  }, [query, pages, semanticScores]);

  /** Reset selection when the query changes — do not depend on `results` (new array ref every render). */
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

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
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />

      <div className="relative w-full max-w-lg mx-4 bg-white dark:bg-neutral-900 rounded-xl shadow-2xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
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
            placeholder={
              hasEmbeddings
                ? "Search pages by title or meaning…"
                : "Jump to page…"
            }
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

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
              {semanticBusy ? "Searching…" : "No pages found"}
            </p>
          ) : (
            results.map(({ page, indices, matchKind }, i) => {
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
                  <span className="text-base shrink-0 leading-none">
                    {page.pageType.tag === "Database" ? "⊞" : "📄"}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="text-sm text-neutral-900 dark:text-white truncate flex-1">
                        <Highlighted text={title} indices={indices} />
                      </div>
                      {matchKind === "semantic" && query.trim().length >= 2 && (
                        <span className="text-[9px] uppercase tracking-wide text-violet-500 dark:text-violet-400 shrink-0">
                          semantic
                        </span>
                      )}
                    </div>
                    {breadcrumb && (
                      <div className="text-xs text-neutral-400 dark:text-neutral-500 truncate mt-0.5">
                        {breadcrumb}
                      </div>
                    )}
                  </div>

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

        <div className="px-4 py-2 border-t border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-neutral-300 dark:text-neutral-600">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> close
          </span>
          {hasEmbeddings && (
            <span className="text-neutral-400 dark:text-neutral-500">
              Meaning search uses local MiniLM (first open may download the model)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
