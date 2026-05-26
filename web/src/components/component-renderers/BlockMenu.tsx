"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDeleteComponent } from "@/src/hooks/usePages";
import type { ComponentNode } from "@/src/module_bindings/types";

/**
 * Block action menu — the popover opened by clicking (not dragging) the
 * grip button in `<BlockChrome>`. Patterned after Notion's "•••" block
 * menu, but anchored to the existing grip handle since dnd-kit's
 * activation distance gives us a free click-vs-drag distinction.
 *
 * Sprint 3a ships a single action: **Delete**. The menu architecture is
 * here so sprint 3b (slash menu work) can drop in Duplicate, Turn into,
 * Copy link, Comment, etc. without re-litigating the popover plumbing.
 *
 * Why a menu and not a bare trash button: a trash icon next to `+` and
 * grip is a one-click footgun. A click-through menu makes deletion
 * intentional ("click grip → read menu → click Delete") and aligns
 * with the rest of the block chrome direction.
 */
export function BlockMenu({
  node,
  anchorRect,
  onClose,
}: {
  node: ComponentNode;
  /** Bounding rect of the grip button — used to position the menu. */
  anchorRect: DOMRect;
  onClose: () => void;
}) {
  const deleteComponent = useDeleteComponent();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() => computePosition(anchorRect));

  // If the page reflows (scroll, resize) while the menu is open, the
  // anchor's screen position may have shifted. We don't bother repositioning
  // mid-flow; the menu closes on scroll instead. Matches Notion's behaviour
  // and avoids the jank of a popover that follows a moving target.
  useEffect(() => {
    setPosition(computePosition(anchorRect));
  }, [anchorRect]);

  // Outside-click + Escape to close. Using `mousedown` (not `click`) so the
  // close fires before the new target's click handler — feels snappier and
  // matches how every other popover library on the planet does it.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target as Node)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    function onScroll() {
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      style={{ top: position.top, left: position.left }}
      className="fixed z-50 min-w-[180px] rounded-md border border-neutral-200
                 dark:border-neutral-700 bg-white dark:bg-neutral-900
                 py-1 shadow-lg"
      role="menu"
      aria-label="Block actions"
    >
      <MenuItem
        label="Delete"
        shortcut=""
        destructive
        onSelect={() => {
          // Soft delete — `restore_component` reachable from the page
          // history panel until purge. Same semantics as Backspace-on-
          // empty per `PEAR_COMPONENT_NODE_SCHEMA.md` § Integrity model.
          deleteComponent({ componentId: node.id });
          onClose();
        }}
      />
      {/* Sprint 3b will populate: Duplicate, Turn into…, Copy link,
          Comment. The popover is structured to accept those entries
          without a redesign — pattern is the same shape as
          `<FormattingToolbar>`'s mark buttons. */}
    </div>,
    document.body,
  );
}

function MenuItem({
  label,
  shortcut,
  destructive,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role="menuitem"
      className={`flex w-full items-center justify-between px-3 py-1.5
                  text-sm transition-colors
                  ${
                    destructive
                      ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                      : "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
    >
      <span>{label}</span>
      {shortcut ? (
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Places the menu just below the grip button, viewport-clamped on the right.
 * No floating-ui dependency — the rect math is cheap and the menu is small.
 */
function computePosition(anchor: DOMRect): { top: number; left: number } {
  const top = anchor.bottom + 4;
  const desiredLeft = anchor.left;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const menuWidth = 200; // rough — Tailwind min-w-[180px] + padding
  const left = Math.min(desiredLeft, viewportWidth - menuWidth - 8);
  return { top, left };
}
