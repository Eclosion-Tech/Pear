"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { useUpdatePageTitle, useUpdatePageIcon, useDeletePage, useChildPages } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { EmojiPicker } from "./EmojiPicker";
import { PearEditor } from "./PearEditor";
import { PageMoreMenu } from "./PageMoreMenu";
import { PageHistoryPanel } from "./PageHistoryPanel";
import { PagePropertiesPanel } from "./PagePropertiesPanel";
import { Breadcrumb } from "./Breadcrumb";
import { useDatabaseSchema, usePropertyDefinitions } from "@/src/hooks/useDatabase";
import { clearIdbCache, clearIdbCacheForPage } from "@/src/lib/spacetime";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { usePageAncestors } from "@/src/hooks/usePages";
import { useWorkspaceAiPanel } from "@/src/components/WorkspaceShell";

interface DocPageProps {
  page: PageRow;
}

export function DocPage({ page }: DocPageProps) {
  const { idbNamespace } = useWorkspace();
  const aiPanel = useWorkspaceAiPanel();
  const router = useRouter();
  const updateTitle = useUpdatePageTitle();
  const updatePageIcon = useUpdatePageIcon();
  const deletePage = useDeletePage();
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [contents] = useTable(tables.page_content);
  const content = contents.find((c) => c.pageId === page.id);

  const [allPages] = useTable(tables.page);
  const parentPage = page.parentId != null
    ? allPages.find((p) => p.id === page.parentId)
    : undefined;
  const parentIsDatabase = parentPage?.pageType?.tag === "Database";

  const { schema } = useDatabaseSchema(parentPage?.id ?? BigInt(0));
  const properties = usePropertyDefinitions(schema?.id ?? BigInt(0));

  const { children } = useChildPages(page.id);
  const ancestors = usePageAncestors(page.id);
  const [title, setTitle] = useState(page.title);
  const [historyOpen, setHistoryOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the title input is focused so we can ignore server echoes
  // that would overwrite characters the user is still typing.
  const titleFocusedRef = useRef(false);

  useEffect(() => {
    if (!titleFocusedRef.current) {
      setTitle(page.title);
    }
  }, [page.title]);

  async function handleTitleChange(value: string) {
    setTitle(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (value.trim()) await updateTitle({ pageId: page.id, title: value });
    }, 400);
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div
        className={`flex flex-col overflow-y-auto transition-all ${historyOpen ? "flex-1 min-w-0" : "flex-1"}`}
      >
      <div className="max-w-3xl mx-auto w-full px-8 pt-16 pb-24 flex-1">
        <Breadcrumb ancestors={ancestors} currentTitle={title} />
        <div className="flex items-center gap-3 mb-6">
          <button
            ref={iconButtonRef}
            type="button"
            onClick={() => setEmojiPickerOpen((o) => !o)}
            className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-2xl hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Change icon"
          >
            {page.icon ?? "📄"}
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
            className="flex-1 text-4xl font-bold text-neutral-900 dark:text-white bg-transparent outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-700"
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
        {parentIsDatabase && properties.length > 0 && (
          <div className="mb-6 pb-4 border-b border-neutral-100 dark:border-neutral-800">
            <PagePropertiesPanel pageId={page.id} properties={properties} />
          </div>
        )}
        <PearEditor
          key={String(page.id)}
          pageId={page.id}
          initialContent={content?.content ?? ""}
          initialContentUpdatedAt={content?.updatedAt?.microsSinceUnixEpoch}
          childPages={children}
          onMentionAiUser={() => aiPanel.openPanel({ pageId: page.id })}
        />
      </div>
      </div>
      {historyOpen && (
        <div className="w-72 shrink-0 border-l border-neutral-200 dark:border-neutral-800">
          <PageHistoryPanel
            pageId={page.id}
            onClose={() => setHistoryOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
