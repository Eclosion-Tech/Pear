"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import {
  usePages,
  useCreatePage,
  useDeletePageSubtree,
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
import { RepeaterSidebarTree } from "@/src/components/RepeaterSidebarTree";
import { useRepeaterSidebarFlagState } from "@/src/lib/repeater/sidebarFlag";
import { measureDelivery, recordMount } from "@/src/lib/repeater/paintMetrics";
import type { PageRow } from "@/src/hooks/usePages";
import { filterNavVisiblePages } from "@/src/hooks/usePages";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { PAGE_DRAG_MIME } from "@/src/lib/chatAttachments";

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

const NO_CHILD_PAGES: PageRow[] = [];

interface SidebarItemProps {
  page: PageRow;
  childrenByParent: ReadonlyMap<bigint, PageRow[]>;
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
  selectedIds: Set<string>;
  onItemClick: (e: React.MouseEvent, page: PageRow) => void;
  router: ReturnType<typeof useRouter>;
  emojiPickerPageId: bigint | null;
  onOpenEmojiPicker: (pageId: bigint) => void;
  onCloseEmojiPicker: () => void;
  updatePageIcon: (args: { pageId: bigint; icon: string }) => void;
}

function SidebarItem({
  page,
  childrenByParent,
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
  selectedIds,
  onItemClick,
  router,
  emojiPickerPageId,
  onOpenEmojiPicker,
  onCloseEmojiPicker,
  updatePageIcon,
}: SidebarItemProps) {
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const id = String(page.id);
  const isActive = id === activeId;
  const isSelected = selectedIds.has(id);
  const isExpanded = expandedIds.has(id);
  const isDragging = draggingId === page.id;
  const defaultIcon = page.pageType.tag === "Database" ? "📊" : "📄";
  const icon = page.icon ?? defaultIcon;
  const showEmojiPicker = emojiPickerPageId === page.id;

  const children = childrenByParent.get(page.id) ?? NO_CHILD_PAGES;
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
          // Also expose the page for external drop targets (e.g. the AI chat
          // composer, which turns it into a context attachment).
          e.dataTransfer.setData(
            PAGE_DRAG_MIME,
            JSON.stringify({ pageId: String(page.id), title: page.title }),
          );
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
            : isSelected
            ? "bg-blue-100 dark:bg-blue-900/40 text-neutral-900 dark:text-white"
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
          onClick={(e) => onItemClick(e, page)}
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
              childrenByParent={childrenByParent}
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
              selectedIds={selectedIds}
              onItemClick={onItemClick}
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
  const navPages = useMemo(() => filterNavVisiblePages(pages), [pages]);
  const { pages: deletedPages } = useDeletedPages();
  const createPage = useCreatePage();
  const deletePageSubtree = useDeletePageSubtree();
  const movePage = useMovePage();
  const { isActive } = useConnection();
  const { user, displayName, initials } = useCurrentUser();
  const { workspaces, activeId: activeWorkspaceId, switchWorkspace } = useWorkspace();

  const roots = useMemo(
    () =>
      navPages
        .filter((p) => p.parentId == null)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [navPages],
  );

  // One pass over the tree instead of an O(pages) filter per SidebarItem —
  // the tree renders N nodes, so per-node filtering is O(N × pages) on every
  // render (and on every dragover frame while dragging).
  const childrenByParent = useMemo(() => {
    const map = new Map<bigint, PageRow[]>();
    for (const p of navPages) {
      if (p.parentId == null) continue;
      const list = map.get(p.parentId);
      if (list) list.push(p);
      else map.set(p.parentId, [p]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [navPages]);

  const { enabled: repeaterSidebar, settled: flagSettled } = useRepeaterSidebarFlagState();

  // Time the bespoke path exactly as the repeater path is timed, so the M3
  // back-out bar compares like with like rather than against a remembered
  // number. Measured from the delivery that changed `navPages` through to the
  // frame that paints it.
  //
  // Gated on `flagSettled`: before the localStorage override is read, this
  // component renders once under the build default even when the repeater is
  // the one actually being measured. Recording that render attributes a
  // cold-start mount to whichever side happens to lose the race.
  const measuring = flagSettled && !repeaterSidebar;
  const bespokeCommitRef = useRef<(() => void) | null>(null);
  if (measuring) {
    bespokeCommitRef.current = measureDelivery("bespoke-sidebar");
  }
  useEffect(() => {
    if (!measuring) return;
    bespokeCommitRef.current?.();
    bespokeCommitRef.current = null;
  }, [navPages, measuring]);

  useEffect(() => {
    if (measuring) recordMount("bespoke-sidebar");
  }, [measuring]);

  const updatePageIcon = useUpdatePageIcon();
  const [isCreating, setIsCreating] = useState(false);
  const [pendingNav, setPendingNav] = useState<Set<bigint> | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [emojiPickerPageId, setEmojiPickerPageId] = useState<bigint | null>(null);
  // Multi-select: cmd/ctrl-click toggles, shift-click range-selects across the
  // visible tree order. Anchor is the last non-shift click.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
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
  const [dropTarget, setDropTargetState] = useState<DropTarget | null>(null);
  // `dragover` fires ~60Hz with a fresh object each time; bail out when the
  // target hasn't actually changed so dragging doesn't re-render the whole
  // tree per frame.
  const setDropTarget = useCallback((next: DropTarget | null) => {
    setDropTargetState((prev) =>
      prev === next ||
      (prev != null &&
        next != null &&
        prev.type === next.type &&
        prev.pageId === next.pageId)
        ? prev
        : next,
    );
  }, []);
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

  // ── Multi-select ────────────────────────────────────────────────────────────

  /** Page ids in the order they appear in the sidebar (expanded nodes only). */
  function visibleOrderedIds(): string[] {
    const out: string[] = [];
    const walk = (page: PageRow) => {
      const id = String(page.id);
      out.push(id);
      if (!expandedIds.has(id)) return;
      navPages
        .filter((p) => p.parentId === page.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .forEach(walk);
    };
    roots.forEach(walk);
    return out;
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectionAnchor(null);
  }

  function handleItemClick(e: React.MouseEvent, page: PageRow) {
    const id = String(page.id);
    if (e.shiftKey && (selectionAnchor !== null || selectedIds.size > 0)) {
      e.preventDefault();
      const order = visibleOrderedIds();
      const anchor = selectionAnchor ?? order.find((x) => selectedIds.has(x)) ?? id;
      const from = order.indexOf(anchor);
      const to = order.indexOf(id);
      if (from === -1 || to === -1) return;
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(order[i]);
        return next;
      });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      setSelectionAnchor(id);
      return;
    }
    if (selectedIds.size > 0) {
      // A plain click while selecting acts like cmd-click so runs of single
      // clicks build the selection instead of navigating away from it.
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      setSelectionAnchor(id);
      return;
    }
    setSelectionAnchor(id);
    router.push(`/workspace/${page.id}`);
  }

  async function handleBulkDelete() {
    if (isBulkDeleting || selectedIds.size === 0) return;
    // Skip pages whose ancestor is also selected — the subtree delete cascades.
    const selectedPages = navPages.filter((p) => selectedIds.has(String(p.id)));
    const topLevel = selectedPages.filter((p) => {
      let cur = p;
      while (cur.parentId != null) {
        if (selectedIds.has(String(cur.parentId))) return false;
        const parent = navPages.find((x) => x.id === cur.parentId);
        if (!parent) break;
        cur = parent;
      }
      return true;
    });
    setIsBulkDeleting(true);
    try {
      for (const p of topLevel) {
        await deletePageSubtree({ pageId: p.id });
      }
      clearSelection();
    } finally {
      setIsBulkDeleting(false);
    }
  }

  // Escape clears the selection.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.size]);

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
    const inSelection = selectedIds.has(String(page.id)) && selectedIds.size > 1;
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
        inSelection
          ? {
              label: `Move ${selectedIds.size} pages to trash`,
              onClick: () => void handleBulkDelete(),
              destructive: true,
            }
          : {
              label: "Move to trash",
              onClick: () => deletePageSubtree({ pageId: page.id }),
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
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-2">
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
        <label className="sr-only" htmlFor="pear-workspace-select">
          Workspace
        </label>
        <select
          id="pear-workspace-select"
          value={activeWorkspaceId ?? ""}
          onChange={(e) => switchWorkspace(e.target.value)}
          className="mt-2 w-full text-xs bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1.5 text-neutral-800 dark:text-neutral-200"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      {/* Page tree */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {repeaterSidebar ? (
          // M3 flag — off by default. Renders the same page tree through the
          // repeater runtime so the two paths can be compared on one clock.
          // Navigate-only; see `sidebarFlag.ts` for why.
          <RepeaterSidebarTree />
        ) : roots.length === 0 && !isReady ? (
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
                childrenByParent={childrenByParent}
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
                selectedIds={selectedIds}
                onItemClick={handleItemClick}
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

      {/* Multi-select action bar */}
      {selectedIds.size > 0 && (
        <div className="px-2 py-2 border-t border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 flex items-center gap-2 text-xs">
          <span className="flex-1 text-neutral-700 dark:text-neutral-300 font-medium">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => void handleBulkDelete()}
            disabled={isBulkDeleting || !isActive}
            className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium transition-colors disabled:opacity-50"
          >
            {isBulkDeleting ? "Deleting…" : "Delete"}
          </button>
          <button
            onClick={clearSelection}
            disabled={isBulkDeleting}
            className="px-2 py-1 rounded text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      )}

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
