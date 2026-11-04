"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  getAnchorRect,
  items,
  activeIndex,
  onHover,
  onSelect,
  onClose,
}: {
  anchorRect: DOMRect;
  getAnchorRect: () => DOMRect | null;
  items: SlashMenuItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: SlashMenuItem) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() =>
    computeSlashMenuPosition(anchorRect),
  );

  // The editor scrolls the caret into view while typing. Follow the live
  // document anchor instead of treating that scroll as a dismissal.
  useLayoutEffect(() => {
    function reposition() {
      const rect = getAnchorRect();
      if (
        !rect ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        onClose();
        return;
      }
      const next = computeSlashMenuPosition(rect);
      setPosition((previous) =>
        previous.top === next.top && previous.left === next.left
          ? previous
          : next,
      );
    }
    function onScroll(e: Event) {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      reposition();
    }
    reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchorRect, getAnchorRect, onClose]);

  // Close on outside click. Escape is handled by the editor keymap.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

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
