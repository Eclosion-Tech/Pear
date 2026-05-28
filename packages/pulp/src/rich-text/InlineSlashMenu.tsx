"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  SlashMenuList,
  computeSlashMenuPosition,
  type SlashMenuItem,
} from "../SlashMenu";

/**
 * Editor-driven slash menu. Unlike `<SlashMenu>` it has no search input and no
 * keyboard handling — the query lives in the document and arrow/enter/escape
 * are routed from the ProseMirror keymap. Purely presentational: it renders
 * the already-filtered `items` controlled by `activeIndex`.
 */
export function InlineSlashMenu({
  anchorRect,
  items,
  activeIndex,
  onHover,
  onSelect,
  onClose,
}: {
  anchorRect: DOMRect;
  items: SlashMenuItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: SlashMenuItem) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / scroll. Escape is handled by the editor keymap.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    function onScroll(e: Event) {
      const target = e.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const position = computeSlashMenuPosition(anchorRect);

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
      <SlashMenuList
        items={items}
        activeIndex={activeIndex}
        onHover={onHover}
        onSelect={onSelect}
      />
    </div>,
    document.body,
  );
}
