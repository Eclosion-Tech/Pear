"use client";

import { useCallback, useRef, useState } from "react";
import { CompositionLayoutToggle, type CompositionLayout } from "@eclosion-tech/pulp";
import "@eclosion-tech/pulp/composition.css";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

interface PageMoreMenuProps {
  items: ContextMenuItem[];
  compositionLayout?: {
    layout: CompositionLayout;
    onLayoutChange: (layout: CompositionLayout) => void;
  };
}

/**
 * A small "•••" icon button that opens a context menu anchored to itself.
 * Used in page title bars as an explicit replacement for full-page right-click
 * traps — intentional click, never an accidental gesture.
 */
export function PageMoreMenu({ items, compositionLayout }: PageMoreMenuProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const focusOnOpen = useRef(false);
  const closeMenu = useCallback(() => setMenuPos(null), []);

  function handleClick() {
    if (menuPos) {
      setMenuPos(null);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ x: rect.right, y: rect.bottom + 4 });
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onMouseDown={event => event.preventDefault()}
        onClick={event => { focusOnOpen.current = event.detail === 0; handleClick(); }}
        title="More options"
        aria-label="More options"
        aria-expanded={menuPos != null}
        className="shrink-0 p-1.5 rounded text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>
        </svg>
      </button>
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          align="right"
          anchorRef={btnRef}
          focusOnOpen={focusOnOpen.current}
          items={items}
          onClose={closeMenu}
          header={compositionLayout && (
            <div className="mx-1 mb-1 border-b border-neutral-200 px-2 pb-3 pt-2 dark:border-neutral-700">
              <div className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">Page layout</div>
              <CompositionLayoutToggle {...compositionLayout} />
            </div>
          )}
        />
      )}
    </>
  );
}
