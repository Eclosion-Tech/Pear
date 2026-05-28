"use client";

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Slash-menu popover. Two presentations share one item list:
 *
 *   - `<SlashMenu>` — a standalone, self-filtering picker with its own search
 *     input and keyboard handling. Used by `<BlockMenu>`'s "Turn into…" entry.
 *   - `<InlineSlashMenu>` (rich-text/) — driven by the editor: the query lives
 *     in the document and arrow/enter/escape come from the ProseMirror keymap.
 *
 * Both render `<SlashMenuList>` for the sectioned option list.
 *
 * **Item set.** The curated default below pins to the non-data-bound built-ins
 * with working renderers. The host (Pear) extends it via `config.slashItems`.
 *
 * **Selection contract.** On select, the parent receives the chosen
 * `componentType` + `defaultProps` and owns the insert/turn-into dispatch —
 * the menu stays UI-only.
 */
export type SlashMenuItem = {
  id: string;
  /** Optional menu section label used to group related blocks. */
  section?: string;
  label: string;
  description: string;
  componentType: string;
  defaultProps: Record<string, unknown>;
  /** Lowercased tokens the filter input matches against. */
  searchTokens: string[];
};

/**
 * Curated insertable types for sprint 3b. Order is the default ranking
 * shown when the filter is empty. RichText leads because it's by far
 * the most common pick.
 */
export const SPRINT_3B_SLASH_ITEMS: SlashMenuItem[] = [
  {
    id: "text",
    section: "Text",
    label: "Text",
    description: "Plain paragraph.",
    componentType: "RichText",
    defaultProps: {},
    searchTokens: ["text", "paragraph", "plain", "p"],
  },
  {
    id: "h1",
    section: "Text",
    label: "Heading 1",
    description: "Large section title.",
    componentType: "Heading",
    defaultProps: { level: 1 },
    searchTokens: ["h1", "heading", "title", "header"],
  },
  {
    id: "h2",
    section: "Text",
    label: "Heading 2",
    description: "Medium section title.",
    componentType: "Heading",
    defaultProps: { level: 2 },
    searchTokens: ["h2", "heading", "subheading"],
  },
  {
    id: "h3",
    section: "Text",
    label: "Heading 3",
    description: "Small section title.",
    componentType: "Heading",
    defaultProps: { level: 3 },
    searchTokens: ["h3", "heading", "subheading"],
  },
  {
    id: "container",
    section: "Layout",
    label: "Container",
    description: "Layout group for nested blocks.",
    componentType: "Container",
    defaultProps: { layout: "stack" },
    searchTokens: ["container", "group", "stack", "layout", "section"],
  },
];

/** Filter the item list by a free-text query (label / section / tokens). */
export function filterSlashItems(
  items: SlashMenuItem[],
  query: string,
): SlashMenuItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  return items.filter(
    (i) =>
      i.label.toLowerCase().includes(q) ||
      i.section?.toLowerCase().includes(q) ||
      i.searchTokens.some((t) => t.includes(q)),
  );
}

/** Standalone, self-filtering picker (BlockMenu "Turn into…"). */
export function SlashMenu({
  anchorRect,
  onSelect,
  onClose,
  items = SPRINT_3B_SLASH_ITEMS,
}: {
  anchorRect: DOMRect;
  onSelect: (item: SlashMenuItem) => void;
  onClose: () => void;
  items?: SlashMenuItem[];
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => filterSlashItems(items, query), [items, query]);

  // Reset active index whenever the filtered list shape changes —
  // otherwise activeIndex can stay pointing past the end.
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length]);

  // Focus the filter input on open. Use rAF — the portal mounts after
  // the parent dispatches setState, and focusing too eagerly can lose
  // to other concurrent focus changes (e.g. an editor blur handler).
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Close on outside click / Escape / scroll. Same shape as
  // <BlockMenu>; matches established Pear popover conventions.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target as Node)) return;
      onClose();
    }
    function onScroll(e: Event) {
      if (!menuRef.current) return;
      const target = e.target;
      if (target instanceof Node && menuRef.current.contains(target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const position = useMemo(() => computeSlashMenuPosition(anchorRect), [anchorRect]);

  return createPortal(
    <div
      ref={menuRef}
      style={{ top: position.top, left: position.left }}
      className="fixed z-50 w-[260px] rounded-md border border-neutral-200
                 dark:border-neutral-700 bg-white dark:bg-neutral-900
                 shadow-lg overflow-hidden"
      role="dialog"
      aria-label="Insert block"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const item = filtered[activeIndex];
            if (item) onSelect(item);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Search blocks…"
        className="w-full px-3 py-2 text-sm bg-transparent
                   border-b border-neutral-200 dark:border-neutral-700
                   text-neutral-900 dark:text-neutral-100
                   outline-none placeholder:text-neutral-400
                   dark:placeholder:text-neutral-500"
      />
      <SlashMenuList
        items={filtered}
        activeIndex={activeIndex}
        onHover={setActiveIndex}
        onSelect={onSelect}
      />
    </div>,
    document.body,
  );
}

/** Presentational, sectioned option list. Shared by both presentations. */
export function SlashMenuList({
  items,
  activeIndex,
  onHover,
  onSelect,
}: {
  items: SlashMenuItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: SlashMenuItem) => void;
}) {
  return (
    <div className="max-h-[280px] overflow-y-auto py-1" role="listbox">
      {items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">
          No matching blocks
        </div>
      ) : (
        items.map((item, idx) => {
          const section = normalizedSection(item);
          const previousSection =
            idx > 0 ? normalizedSection(items[idx - 1]) : null;
          const showSection = section != null && section !== previousSection;

          return (
            <Fragment key={item.id}>
              {showSection ? (
                <div
                  role="presentation"
                  className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase
                             text-neutral-500 dark:text-neutral-400"
                >
                  {section}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => onHover(idx)}
                onMouseDown={(e) => {
                  // Keep editor focus (inline menu) — selection runs on click.
                  e.preventDefault();
                }}
                onClick={() => onSelect(item)}
                className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left
                            transition-colors
                            ${
                              idx === activeIndex
                                ? "bg-neutral-100 dark:bg-neutral-800"
                                : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                            }`}
              >
                <span className="text-sm text-neutral-900 dark:text-neutral-100">
                  {item.label}
                </span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {item.description}
                </span>
              </button>
            </Fragment>
          );
        })
      )}
    </div>
  );
}

export function computeSlashMenuPosition(anchor: DOMRect): {
  top: number;
  left: number;
} {
  const top = anchor.bottom + 4;
  const desiredLeft = anchor.left;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const menuWidth = 280;
  const left = Math.min(desiredLeft, viewportWidth - menuWidth - 8);
  return { top, left };
}

function normalizedSection(item: SlashMenuItem | undefined): string | null {
  const section = item?.section?.trim();
  return section && section.length > 0 ? section : null;
}
