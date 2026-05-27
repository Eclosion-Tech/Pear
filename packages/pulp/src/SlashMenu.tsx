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
 * Slash-menu popover — opened by `<RichText>` when the user types `/`
 * at the start of an empty doc. Patterned after Notion / BlockNote.
 *
 * **Item set.** Sprint 3b ships a curated list pinned to the
 * non-data-bound built-ins that have working sprint 1/2/3a renderers.
 * Form / Input / Button require data bindings the slash menu doesn't
 * have a picker for yet — they're deferred. Image needs an attachment
 * picker; also deferred. The registry has all types, but slash-menu
 * visibility is a *curation* concern, not a registry concern — see
 * `docs/PEAR_WEB_RENDERER.md` § Open question #1 (menu-visibility
 * capability on ComponentTypeDefinition).
 *
 * **Selection contract.** On select, the parent calls back with the
 * chosen `componentType` and `defaultProps`. The parent owns the
 * insert-and-replace dispatch — slash menu stays UI-only so we can
 * reuse it (post-sprint-3b) for the BlockMenu's "Turn into…" entry.
 *
 * **Focus.** Menu opens with the filter input autofocused. Arrow keys
 * navigate, Enter selects, Escape closes. The filter is a `<input>`
 * not a contenteditable — keeps the popover keyboard contract simple
 * and lets the browser handle composition events normally.
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
    defaultProps: { level: 1, text: "" },
    searchTokens: ["h1", "heading", "title", "header"],
  },
  {
    id: "h2",
    section: "Text",
    label: "Heading 2",
    description: "Medium section title.",
    componentType: "Heading",
    defaultProps: { level: 2, text: "" },
    searchTokens: ["h2", "heading", "subheading"],
  },
  {
    id: "h3",
    section: "Text",
    label: "Heading 3",
    description: "Small section title.",
    componentType: "Heading",
    defaultProps: { level: 3, text: "" },
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return items;
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.section?.toLowerCase().includes(q) ||
        i.searchTokens.some((t) => t.includes(q)),
    );
  }, [items, query]);

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

  const position = useMemo(() => computePosition(anchorRect), [anchorRect]);

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
      <div className="max-h-[280px] overflow-y-auto py-1" role="listbox">
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">
            No matching blocks
          </div>
        ) : (
          filtered.map((item, idx) => {
            const section = normalizedSection(item);
            const previousSection =
              idx > 0 ? normalizedSection(filtered[idx - 1]) : null;
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
                  onMouseEnter={() => setActiveIndex(idx)}
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
    </div>,
    document.body,
  );
}

function computePosition(anchor: DOMRect): { top: number; left: number } {
  const top = anchor.bottom + 4;
  const desiredLeft = anchor.left;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const menuWidth = 280;
  const left = Math.min(desiredLeft, viewportWidth - menuWidth - 8);
  return { top, left };
}

function normalizedSection(item: SlashMenuItem): string | null {
  const section = item.section?.trim();
  return section && section.length > 0 ? section : null;
}
