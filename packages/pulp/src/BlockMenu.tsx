"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { duplicateBlock, turnIntoBlock } from "./blockActions";
import { copyBlockLink } from "./blockLink";
import { usePulp } from "./context/PulpProvider";
import { useSurfaceFocus } from "./focus/SurfaceFocusProvider";
import { SlashMenu, SPRINT_3B_SLASH_ITEMS } from "./SlashMenu";
import type { BlockNode } from "./types";

/**
 * Block action menu — the popover opened by clicking (not dragging) the
 * grip button in `<BlockChrome>`. Patterned after Notion's "•••" block
 * menu, but anchored to the existing grip handle since dnd-kit's
 * activation distance gives us a free click-vs-drag distinction.
 */
export function BlockMenu({
  node,
  anchorRect,
  onClose,
}: {
  node: BlockNode;
  /** Bounding rect of the grip button — used to position the menu. */
  anchorRect: DOMRect;
  onClose: () => void;
}) {
  const pulp = usePulp();
  const focus = useSurfaceFocus();
  const { onCommentBlock } = pulp.config;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() => computePosition(anchorRect));
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    setPosition(computePosition(anchorRect));
  }, [anchorRect]);

  useEffect(() => {
    // SlashMenu registers its own dismiss-on-scroll when "Turn into…" is open.
    if (turnIntoOpen) return;

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
    function onScroll(e: Event) {
      if (!menuRef.current) return;
      const target = e.target;
      if (target instanceof Node && menuRef.current.contains(target)) return;
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
  }, [onClose, turnIntoOpen]);

  const pulpMutations = pulp;

  if (turnIntoOpen) {
    return (
      <SlashMenu
        anchorRect={anchorRect}
        items={pulp.config.slashItems ?? SPRINT_3B_SLASH_ITEMS}
        onClose={() => {
          setTurnIntoOpen(false);
          onClose();
        }}
        onSelect={(item) => {
          turnIntoBlock(node, pulp.tree, item, pulpMutations, focus);
          setTurnIntoOpen(false);
          onClose();
        }}
      />
    );
  }

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
        label="Duplicate"
        onSelect={() => {
          duplicateBlock(node, pulp.tree, pulpMutations, focus);
          onClose();
        }}
      />
      <MenuItem
        label="Turn into…"
        onSelect={() => setTurnIntoOpen(true)}
      />
      <MenuItem
        label={copyFeedback ? "Link copied" : "Copy link"}
        onSelect={async () => {
          const ok = await copyBlockLink(node.id);
          if (ok) {
            setCopyFeedback(true);
            window.setTimeout(onClose, 600);
          } else {
            onClose();
          }
        }}
      />
      {onCommentBlock && (
        <>
          <MenuDivider />
          <MenuItem
            label="Comment"
            onSelect={() => {
              onCommentBlock(node.id);
              onClose();
            }}
          />
        </>
      )}
      <MenuDivider />
      <MenuItem
        label="Delete"
        destructive
        onSelect={() => {
          pulp.deleteBlock({ componentId: node.id });
          onClose();
        }}
      />
    </div>,
    document.body,
  );
}

function MenuDivider() {
  return (
    <div
      role="separator"
      className="my-1 border-t border-neutral-200 dark:border-neutral-700"
    />
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

function computePosition(anchor: DOMRect): { top: number; left: number } {
  const top = anchor.bottom + 4;
  const desiredLeft = anchor.left;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const menuWidth = 200;
  const left = Math.min(desiredLeft, viewportWidth - menuWidth - 8);
  return { top, left };
}
