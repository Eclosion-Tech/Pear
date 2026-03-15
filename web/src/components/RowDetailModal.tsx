"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { PearEditor } from "./PearEditor";
import { useUpdatePageTitle, useDeletePage } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { PageMoreMenu } from "./PageMoreMenu";
import { PageHistoryPanel } from "./PageHistoryPanel";
import {
  useDatabaseSchema,
  usePropertyDefinitions,
} from "@/src/hooks/useDatabase";
import { PagePropertiesPanel } from "./PagePropertiesPanel";

interface RowDetailModalProps {
  page: PageRow;
  /** The parent database page — used to look up schema + properties. */
  parentPage: PageRow;
  onClose: () => void;
}

export function RowDetailModal({ page, parentPage, onClose }: RowDetailModalProps) {
  const router = useRouter();
  const [contents] = useTable(tables.page_content);
  const content = contents.find((c) => c.pageId === page.id);
  const updateTitle = useUpdatePageTitle();
  const deletePage = useDeletePage();

  const [title, setTitle] = useState(page.title);
  const [historyOpen, setHistoryOpen] = useState(false);
  const titleFocusedRef = useRef(false);
  const titleDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local title in sync when not focused
  useEffect(() => {
    if (!titleFocusedRef.current) {
      setTitle(page.title);
    }
  }, [page.title]);

  async function handleTitleChange(value: string) {
    setTitle(value);
    if (titleDebounce.current) clearTimeout(titleDebounce.current);
    titleDebounce.current = setTimeout(async () => {
      if (value.trim()) {
        await updateTitle({ pageId: page.id, title: value });
      }
    }, 400);
  }

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const { schema } = useDatabaseSchema(parentPage.id);
  const properties = usePropertyDefinitions(schema?.id ?? BigInt(0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`relative bg-white dark:bg-neutral-900 rounded-xl shadow-2xl max-h-[85vh] flex flex-col overflow-hidden border border-neutral-200 dark:border-neutral-700 transition-all ${
          historyOpen ? "w-full max-w-4xl" : "w-full max-w-3xl"
        }`}
      >
        {/* Title bar */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-3 border-b border-neutral-200 dark:border-neutral-800">
          <input
            className="flex-1 bg-transparent text-xl font-semibold text-neutral-900 dark:text-white outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            onFocus={() => { titleFocusedRef.current = true; }}
            onBlur={() => {
              titleFocusedRef.current = false;
              setTitle(page.title);
            }}
            placeholder="Untitled"
          />
          <button
            onClick={() => {
              onClose();
              router.push(`/workspace/${page.id}`);
            }}
            title="Open in full page"
            className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
            aria-label="Open in full page"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
            </svg>
          </button>
          <button
            onClick={() => setHistoryOpen((o) => !o)}
            title="Page history"
            aria-label="Page history"
            className={`shrink-0 p-1.5 rounded transition-colors ${
              historyOpen
                ? "text-neutral-900 dark:text-white bg-neutral-200 dark:bg-neutral-700"
                : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </button>
          <PageMoreMenu
            items={[
              {
                label: "Move to trash",
                onClick: () => {
                  deletePage({ pageId: page.id });
                  onClose();
                },
                destructive: true,
              },
            ]}
          />
          <button
            onClick={onClose}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-white text-lg transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {/* Properties panel */}
            {properties.length > 0 && (
              <div className="px-6 pt-3 pb-2 border-b border-neutral-100 dark:border-neutral-800">
                <PagePropertiesPanel pageId={page.id} properties={properties} />
              </div>
            )}

            {/* Editor */}
            <div className="px-6 py-4">
              <PearEditor
                key={`${page.id}-${content?.updatedAt ?? 0}`}
                pageId={page.id}
                initialContent={content?.content ?? ""}
              />
            </div>
          </div>
          {historyOpen && (
            <div className="w-72 shrink-0 border-l border-neutral-200 dark:border-neutral-700">
              <PageHistoryPanel
                pageId={page.id}
                onClose={() => setHistoryOpen(false)}
                onRestore={onClose}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

