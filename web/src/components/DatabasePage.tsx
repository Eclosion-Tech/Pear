"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUpdatePageTitle, useUpdatePageIcon, useDeletePage } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { GridView } from "./GridView";
import { PageMoreMenu } from "./PageMoreMenu";
import { PageHistoryPanel } from "./PageHistoryPanel";
import { Breadcrumb } from "./Breadcrumb";
import { EmojiPicker } from "./EmojiPicker";
import { usePageAncestors } from "@/src/hooks/usePages";
import { clearIdbCache, clearIdbCacheForPage } from "@/src/lib/spacetime";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { useWorkspaceAiPanel } from "@/src/components/WorkspaceShell";

interface DatabasePageProps {
  page: PageRow;
}

export function DatabasePage({ page }: DatabasePageProps) {
  const { idbNamespace } = useWorkspace();
  const aiPanel = useWorkspaceAiPanel();
  const router = useRouter();
  const updateTitle = useUpdatePageTitle();
  const updatePageIcon = useUpdatePageIcon();
  const deletePage = useDeletePage();
  const ancestors = usePageAncestors(page.id);
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [title, setTitle] = useState(page.title);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    setTitle(page.title);
  }, [page.title]);

  async function handleTitleChange(value: string) {
    setTitle(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (value.trim()) await updateTitle({ pageId: page.id, title: value });
    }, 400);
  }

  return (
    <div className="relative flex flex-col h-full">
      <div className="px-8 pt-8 pb-4 flex-shrink-0">
        <Breadcrumb ancestors={ancestors} currentTitle={title} />
        <div className="flex items-center gap-3 mt-1">
          <button
            ref={iconButtonRef}
            type="button"
            onClick={() => setEmojiPickerOpen((o) => !o)}
            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-2xl hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Change icon"
          >
            {page.icon ?? "📊"}
          </button>
          {emojiPickerOpen && (
            <EmojiPicker
              anchorRef={iconButtonRef}
              currentIcon={page.icon != null ? page.icon : undefined}
              onSelect={(emoji) => { updatePageIcon({ pageId: page.id, icon: emoji ?? "" }); setEmojiPickerOpen(false); }}
              onClose={() => setEmojiPickerOpen(false)}
            />
          )}
          <input
            className="flex-1 text-3xl font-bold text-neutral-900 dark:text-white bg-transparent outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-700"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Untitled Database"
          />
          <button
            onClick={() => aiPanel.togglePanelForPage(page.id)}
            title="AI jobs"
            aria-label="AI jobs"
            className={`shrink-0 p-1.5 rounded transition-colors ${
              aiPanel.isOpen && aiPanel.activePageId === page.id
                ? "text-neutral-900 dark:text-white bg-neutral-200 dark:bg-neutral-700"
                : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
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
                label: "Clear cache for this page",
                onClick: async () => {
                  await clearIdbCacheForPage(page.id, idbNamespace);
                  window.location.reload();
                },
              },
              {
                label: "Clear cache for workspace",
                onClick: async () => {
                  await clearIdbCache(idbNamespace);
                  window.location.reload();
                },
              },
              {
                label: "Move to trash",
                onClick: () => {
                  deletePage({ pageId: page.id });
                  router.push("/workspace");
                },
                destructive: true,
              },
            ]}
          />
        </div>
        <p className="text-xs text-neutral-400 dark:text-neutral-600 mt-1">Database</p>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-8">
        <GridView page={page} />
      </div>

      {/* History panel — fixed overlay so it doesn't shrink the grid */}
      {historyOpen && (
        <div className="absolute top-0 right-0 h-full w-72 border-l border-neutral-200 dark:border-neutral-800 shadow-xl z-20">
          <PageHistoryPanel
            pageId={page.id}
            onClose={() => setHistoryOpen(false)}
          />
        </div>
      )}

    </div>
  );
}
