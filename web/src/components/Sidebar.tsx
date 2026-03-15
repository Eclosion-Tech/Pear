"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import {
  usePages,
  useCreatePage,
  useDeletePage,
  useMovePage,
  useDeletedPages,
  useConnection,
  useUpdatePageIcon,
} from "@/src/hooks/usePages";
import { useCurrentUser } from "@/src/hooks/useUser";
import { SettingsPopover } from "@/src/components/SettingsPopover";
import { ContextMenu, type ContextMenuItem } from "@/src/components/ContextMenu";
import { QuickSwitcher } from "@/src/components/QuickSwitcher";
import { EmojiPicker } from "@/src/components/EmojiPicker";
import type { PageRow } from "@/src/hooks/usePages";

// ─── Drag state shared across the whole sidebar ───────────────────────────────

type DropTarget =
  | { type: "before"; pageId: bigint }
  | { type: "after"; pageId: bigint }
  | { type: "into"; pageId: bigint };

// ─── Theme toggle ─────────────────────────────────────────────────────────────

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <button
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      title="Toggle theme"
      className="text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors text-sm"
    >
      {resolvedTheme === "dark" ? "☀︎" : "☾"}
    </button>
  );
}

// ─── Single page row in the sidebar tree ──────────────────────────────────────

interface SidebarItemProps {
  page: PageRow;
  allPages: PageRow[];
  depth: number;
  activeId: string | undefined;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  draggingId: bigint | null;
  dropTarget: DropTarget | null;
  onDragStart: (id: bigint) => void;
  onDragEnd: () => void;
  onDrop: (target: DropTarget) => void;
  onContextMenu: (e: React.MouseEvent, page: PageRow) => void;
  router: ReturnType<typeof useRouter>;
  emojiPickerPageId: bigint | null;
  onOpenEmojiPicker: (pageId: bigint) => void;
  onCloseEmojiPicker: () => void;
  updatePageIcon: (args: { pageId: bigint; icon: string }) => void;
}

function SidebarItem({
  page,
  allPages,
  depth,
  activeId,
  expandedIds,
  onToggleExpand,
  draggingId,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDrop,
  onContextMenu,
  router,
  emojiPickerPageId,
  onOpenEmojiPicker,
  onCloseEmojiPicker,
  updatePageIcon,
}: SidebarItemProps) {
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const id = String(page.id);
  const isActive = id === activeId;
  const isExpanded = expandedIds.has(id);
  const isDragging = draggingId === page.id;
  const defaultIcon = page.pageType.tag === "Database" ? "📊" : "📄";
  const icon = page.icon ?? defaultIcon;
  const showEmojiPicker = emojiPickerPageId === page.id;

  const children = allPages
    .filter((p) => p.parentId === page.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const hasChildren = children.length > 0;

  // Drag-over state for the "drop into" highlight
  const [dragOver, setDragOver] = useState<"before" | "into" | "after" | null>(null);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    if (y < h * 0.25) {
      setDragOver("before");
      onDrop({ type: "before", pageId: page.id });
    } else if (y > h * 0.75) {
      setDragOver("after");
      onDrop({ type: "after", pageId: page.id });
    } else {
      setDragOver("into");
      onDrop({ type: "into", pageId: page.id });
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.stopPropagation();
    setDragOver(null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
  }

  const isDropTarget =
    dropTarget !== null &&
    ((dropTarget.type === "before" && dropTarget.pageId === page.id && dragOver === "before") ||
      (dropTarget.type === "after" && dropTarget.pageId === page.id && dragOver === "after") ||
      (dropTarget.type === "into" && dropTarget.pageId === page.id && dragOver === "into"));

  return (
    <div>
      {/* Drop indicator: before */}
      {dropTarget?.type === "before" && dropTarget.pageId === page.id && dragOver === "before" && (
        <div className="h-0.5 mx-2 rounded bg-blue-500" />
      )}

      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          onDragStart(page.id);
        }}
        onDragEnd={onDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={(e) => onContextMenu(e, page)}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        className={`group flex items-center gap-1 pr-2 py-1 rounded text-sm cursor-pointer select-none transition-colors ${
          isDragging ? "opacity-40" : ""
        } ${
          dragOver === "into"
            ? "bg-blue-100 dark:bg-blue-900/30 outline outline-1 outline-blue-400"
            : isActive
            ? "bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-white"
            : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white"
        }`}
      >
        {/* Expand chevron */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleExpand(id);
          }}
          className={`shrink-0 w-4 h-4 flex items-center justify-center text-neutral-400 dark:text-neutral-600 ${
            hasChildren ? "hover:text-neutral-700 dark:hover:text-neutral-300" : "pointer-events-none"
          }`}
        >
          {hasChildren ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          ) : null}
        </button>

        {/* Icon + title */}
        <div
          className="flex-1 flex items-center gap-1.5 min-w-0"
          onClick={() => router.push(`/workspace/${page.id}`)}
        >
          <button
            ref={iconButtonRef}
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenEmojiPicker(page.id); }}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-base hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
            title="Change icon"
          >
            {icon}
          </button>
          {showEmojiPicker && (
            <EmojiPicker
              anchorRef={iconButtonRef}
              currentIcon={page.icon != null ? page.icon : undefined}
              onSelect={(emoji) => updatePageIcon({ pageId: page.id, icon: emoji ?? "" })}
              onClose={onCloseEmojiPicker}
            />
          )}
          <span className="truncate">{page.title}</span>
        </div>
      </div>

      {/* Drop indicator: after */}
      {dropTarget?.type === "after" && dropTarget.pageId === page.id && dragOver === "after" && (
        <div className="h-0.5 mx-2 rounded bg-blue-500" />
      )}

      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {children.map((child) => (
            <SidebarItem
              key={String(child.id)}
              page={child}
              allPages={allPages}
              depth={depth + 1}
              activeId={activeId}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              draggingId={draggingId}
              dropTarget={dropTarget}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
              onContextMenu={onContextMenu}
              router={router}
              emojiPickerPageId={emojiPickerPageId}
              onOpenEmojiPicker={onOpenEmojiPicker}
              onCloseEmojiPicker={onCloseEmojiPicker}
              updatePageIcon={(args) => updatePageIcon({ pageId: args.pageId, icon: args.icon ?? "" })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const activeId = pathname?.split("/").pop() ?? undefined;

  const { pages, isReady } = usePages();
  const { pages: deletedPages } = useDeletedPages();
  const createPage = useCreatePage();
  const deletePage = useDeletePage();
  const movePage = useMovePage();
  const { isActive } = useConnection();
  const { user, displayName, initials } = useCurrentUser();

  const roots = pages
    .filter((p) => p.parentId == null)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const updatePageIcon = useUpdatePageIcon();
  const [isCreating, setIsCreating] = useState(false);
  const [pendingNav, setPendingNav] = useState<Set<bigint> | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [emojiPickerPageId, setEmojiPickerPageId] = useState<bigint | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  // Quick switcher
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Global ⌘K / Ctrl+K listener
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSwitcherOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // DnD state
  const [draggingId, setDraggingId] = useState<bigint | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const draggingIdRef = useRef<bigint | null>(null);

  // Keep a stable ref to pages so the auto-expand effect can read the latest
  // value without listing `pages` as a dependency (pages is a new array
  // reference every render due to .filter(), which would cause the effect to
  // run on every render and could hit React's max update depth).
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // Auto-expand ancestor nodes when navigating to a nested page.
  // Only re-runs when activeId changes (navigation), not on every pages update.
  useEffect(() => {
    if (!activeId) return;
    const allPages = pagesRef.current;
    const active = allPages.find((p) => String(p.id) === activeId);
    if (!active?.parentId) return;

    const toExpand: string[] = [];
    let cur: PageRow | undefined = active;
    while (cur?.parentId) {
      toExpand.push(String(cur.parentId));
      cur = allPages.find((p) => p.id === cur!.parentId);
    }

    setExpandedIds((prev) => {
      if (toExpand.every((id) => prev.has(id))) return prev; // bail out — nothing new
      const next = new Set(prev);
      toExpand.forEach((id) => next.add(id));
      return next;
    });
  }, [activeId]); // ← pages intentionally omitted; read via ref above

  // Navigate to newly created page
  useEffect(() => {
    if (!pendingNav) return;
    const newPage = pages.find((p) => !pendingNav.has(p.id));
    if (newPage) {
      setPendingNav(null);
      router.push(`/workspace/${newPage.id}`);
    }
  }, [pages, pendingNav, router]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleNewPage(parentId?: bigint, type: "Doc" | "Database" = "Doc") {
    const snapshot = new Set(pages.map((p) => p.id));
    setPendingNav(snapshot);
    if (parentId) setExpandedIds((prev) => new Set(prev).add(String(parentId)));
    setIsCreating(true);
    try {
      await createPage({
        parentId,
        pageType: { tag: type },
        title: type === "Database" ? "Untitled Database" : "Untitled",
      });
    } catch {
      setPendingNav(null);
    } finally {
      setIsCreating(false);
    }
  }

  function handleContextMenu(e: React.MouseEvent, page: PageRow) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "New subpage",
          onClick: () => handleNewPage(page.id, "Doc"),
        },
        {
          label: "New sub-database",
          onClick: () => handleNewPage(page.id, "Database"),
        },
        {
          label: "Move to trash",
          onClick: () => deletePage({ pageId: page.id }),
          destructive: true,
        },
      ],
    });
  }

  // ── Drag-and-drop handlers ──────────────────────────────────────────────────

  function handleDragStart(id: bigint) {
    setDraggingId(id);
    draggingIdRef.current = id;
  }

  function handleDragEnd() {
    const dragId = draggingIdRef.current;
    const target = dropTarget;

    if (dragId !== null && target !== null) {
      const dragPage = pages.find((p) => p.id === dragId);
      if (!dragPage) return;

      if (target.type === "into") {
        // Reparent as last child of the target
        const targetPage = pages.find((p) => p.id === target.pageId);
        if (!targetPage || target.pageId === dragId) return;
        // Guard against dropping into own descendant
        if (isDescendant(target.pageId, dragId, pages)) return;
        movePage({
          pageId: dragId,
          newParentId: target.pageId,
          afterPageId: undefined,
        });
        setExpandedIds((prev) => new Set(prev).add(String(target.pageId)));
      } else {
        // Reorder: place before or after target sibling
        const targetPage = pages.find((p) => p.id === target.pageId);
        if (!targetPage || target.pageId === dragId) return;
        const newParent = targetPage.parentId;
        if (isDescendant(target.pageId, dragId, pages)) return;

        // Find the sibling that comes before the insertion point
        const siblings = pages
          .filter((p) => p.parentId === newParent && p.deletedAt == null && p.id !== dragId)
          .sort((a, b) => a.sortOrder - b.sortOrder);

        let afterPageId: bigint | undefined;
        if (target.type === "before") {
          const idx = siblings.findIndex((p) => p.id === target.pageId);
          afterPageId = idx > 0 ? siblings[idx - 1].id : undefined;
        } else {
          afterPageId = target.pageId;
        }

        movePage({ pageId: dragId, newParentId: newParent, afterPageId });
      }
    }

    setDraggingId(null);
    draggingIdRef.current = null;
    setDropTarget(null);
  }

  return (
    <aside className="w-56 flex-shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
        <span className="text-lg font-semibold text-neutral-900 dark:text-white tracking-tight">
          🍐 Pear
        </span>
        {!isActive && (
          <span className="ml-auto text-xs text-yellow-600 dark:text-yellow-500">connecting…</span>
        )}
        {isActive && (
          <button
            onClick={() => setSwitcherOpen(true)}
            title="Quick switcher (⌘K)"
            className="ml-auto text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
        )}
      </div>

      {/* Page tree */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {roots.length === 0 && !isReady ? (
          <div className="px-2 py-1 text-xs text-neutral-400 dark:text-neutral-500">Loading…</div>
        ) : roots.length === 0 ? (
          <div className="px-2 py-2 text-xs text-neutral-400 dark:text-neutral-500 italic">
            No pages yet — create one below
          </div>
        ) : (
          <div>
            {roots.map((page) => (
              <SidebarItem
                key={String(page.id)}
                page={page}
                allPages={pages}
                depth={0}
                activeId={activeId}
                expandedIds={expandedIds}
                onToggleExpand={toggleExpand}
                draggingId={draggingId}
                dropTarget={dropTarget}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDrop={setDropTarget}
                onContextMenu={handleContextMenu}
                router={router}
                emojiPickerPageId={emojiPickerPageId}
                onOpenEmojiPicker={setEmojiPickerPageId}
                onCloseEmojiPicker={() => setEmojiPickerPageId(null)}
                updatePageIcon={(args) => updatePageIcon({ pageId: args.pageId, icon: args.icon ?? "" })}
              />
            ))}
          </div>
        )}

        {/* Trash + Settings */}
        <button
          onClick={() => router.push("/workspace/trash")}
          className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors mt-2 ${
            activeId === "trash"
              ? "bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-white"
              : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white"
          }`}
        >
          <span className="mr-1.5 text-xs">🗑</span>
          Trash
          {deletedPages.length > 0 && (
            <span className="ml-1 text-xs text-neutral-400 dark:text-neutral-500">
              ({deletedPages.length})
            </span>
          )}
        </button>
        <button
          onClick={() => router.push("/workspace/settings")}
          className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
            activeId === "settings"
              ? "bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-white"
              : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white"
          }`}
        >
          <span className="mr-1.5 text-xs">⚙</span>
          Settings
        </button>
      </nav>

      {/* New page buttons */}
      <div className="px-2 py-2 border-t border-neutral-200 dark:border-neutral-800 space-y-1">
        <button
          onClick={() => handleNewPage(undefined, "Doc")}
          disabled={isCreating || !isActive}
          className="w-full text-left px-2 py-1.5 rounded text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white transition-colors disabled:opacity-40"
        >
          + New page
        </button>
        <button
          onClick={() => handleNewPage(undefined, "Database")}
          disabled={isCreating || !isActive}
          className="w-full text-left px-2 py-1.5 rounded text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white transition-colors disabled:opacity-40"
        >
          + New database
        </button>
      </div>

      {/* User widget */}
      {user && (
        <div className="px-3 py-2.5 border-t border-neutral-200 dark:border-neutral-800 flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{initials}</span>
          </div>
          <span className="flex-1 text-xs text-neutral-500 dark:text-neutral-400 truncate">{displayName}</span>
          <ThemeToggle />
          <SettingsPopover />
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      <QuickSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </aside>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isDescendant(candidateId: bigint, ancestorId: bigint, pages: PageRow[]): boolean {
  let cur = pages.find((p) => p.id === candidateId);
  while (cur?.parentId != null) {
    if (cur.parentId === ancestorId) return true;
    cur = pages.find((p) => p.id === cur!.parentId);
  }
  return false;
}
