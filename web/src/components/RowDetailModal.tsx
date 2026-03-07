"use client";

import { useEffect, useRef, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { PearEditor } from "./PearEditor";
import { useUpdatePageTitle } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";

interface RowDetailModalProps {
  page: PageRow;
  onClose: () => void;
}

export function RowDetailModal({ page, onClose }: RowDetailModalProps) {
  const [contents] = useTable(tables.page_content);
  const content = contents.find((c) => c.pageId === page.id);
  const updateTitle = useUpdatePageTitle();

  const [title, setTitle] = useState(page.title);
  const titleDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local title in sync with server changes
  useEffect(() => {
    setTitle(page.title);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden border border-neutral-200 dark:border-neutral-700">
        {/* Title bar */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-2 border-b border-neutral-200 dark:border-neutral-800">
          <input
            className="flex-1 bg-transparent text-xl font-semibold text-neutral-900 dark:text-white outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Untitled"
          />
          <button
            onClick={onClose}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-white text-lg transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <PearEditor
            key={String(page.id)}
            pageId={page.id}
            initialContent={content?.content ?? ""}
          />
        </div>
      </div>
    </div>
  );
}
