"use client";

import { useEffect, useRef } from "react";
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
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
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
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] py-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
      style={{ left: x, top: y }}
    >
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
