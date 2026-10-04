"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Persistent controls above the one-shot actions. Interacting here keeps the menu open. */
  header?: ReactNode;
  align?: "left" | "right";
  anchorRef?: RefObject<HTMLElement | null>;
  focusOnOpen?: boolean;
}

export function ContextMenu({ x, y, items, onClose, header, align = "left", anchorRef, focusOnOpen }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchorRef?.current?.contains(e.target as Node)) onClose();
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); anchorRef?.current?.focus(); }
    }
    // Defer to avoid closing immediately from the same click that opened
    const t = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });
    return () => {
      cancelAnimationFrame(t);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose, anchorRef]);

  useEffect(() => {
    if (focusOnOpen) {
      const initial = ref.current?.querySelector<HTMLButtonElement>("button[aria-pressed='true']")
        ?? ref.current?.querySelector<HTMLButtonElement>("button");
      initial?.focus();
    }
  }, [focusOnOpen]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] py-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
      style={{ left: x, top: y, transform: align === "right" ? "translateX(-100%)" : undefined }}
    >
      {header}
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
            item.destructive
              ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
              : "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
