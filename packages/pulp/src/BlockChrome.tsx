"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { usePulp } from "./context/PulpProvider";
import { useSurfaceFocus } from "./focus/SurfaceFocusProvider";
import { useSurfaceSelectionOptional } from "./selection/SurfaceSelectionProvider";
import { knownSiblingIdsForParent } from "./focus/insertFocusHelpers";
import type { BlockNode } from "./types";
import { BlockMenu } from "./BlockMenu";
import {
  BlockChromeHandlesProvider,
  useBlockChromeHandles,
  type BlockChromeGripProps,
} from "./BlockChromeHandlesContext";

/**
 * - `side` — default leaf blocks: + / grip in the left gutter.
 * - `header` — layout blocks (Container) with children: chrome moves into
 *   the block header so nested blocks keep the only visible side gutters.
 */
export type BlockChromeGutterMode = "side" | "header";

export function BlockChrome({
  node,
  children,
  gutterMode = "side",
}: {
  node: BlockNode;
  children: ReactNode;
  gutterMode?: BlockChromeGutterMode;
}) {
  const { insertBlock, tree } = usePulp();
  const focus = useSurfaceFocus();
  const selection = useSurfaceSelectionOptional();
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  const wrapperElRef = useRef<HTMLDivElement | null>(null);

  // Register this block's live rect so the marquee can hit-test it, and reflect
  // block-selection as a highlight ring.
  const selected = selection?.isSelected(node.id) ?? false;
  useEffect(() => {
    if (!selection) return;
    return selection.registerRect(
      node.id,
      () => wrapperElRef.current?.getBoundingClientRect() ?? null,
    );
  }, [selection, node.id]);

  const sortable = useSortable({ id: node.id.toString() });
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = sortable;

  const wrapperStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  const insertSiblingBelow = useCallback(() => {
    if (node.parentId == null) return;
    focus.armForInsert(node.parentId, node.id, {
      knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
    });
    insertBlock({
      parentId: node.parentId,
      componentType: "RichText",
      propsJson: "{}",
      afterSiblingId: node.id,
    });
  }, [focus, insertBlock, node.id, node.parentId, tree]);

  const openMenu = useCallback(() => {
    const el = gripRef.current;
    if (!el) return;
    setMenuRect(el.getBoundingClientRect());
  }, []);

  const bindGrip = useCallback(
    (el: HTMLButtonElement | null) => {
      setActivatorNodeRef(el);
      gripRef.current = el;
    },
    [setActivatorNodeRef],
  );

  const bindWrapper = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el);
      wrapperElRef.current = el;
    },
    [setNodeRef],
  );

  const gripProps: BlockChromeGripProps = {
    ...attributes,
    ...listeners,
  };

  const showSideGutter = gutterMode === "side";
  const [gutterVisible, setGutterVisible] = useState(false);

  const revealGutter = useCallback(() => {
    if (!showSideGutter) return;
    setGutterVisible(true);
  }, [showSideGutter]);

  const hideGutter = useCallback(
    (relatedTarget: EventTarget | null, currentTarget: EventTarget) => {
      if (!showSideGutter) return;
      if (
        relatedTarget instanceof Node &&
        currentTarget instanceof Node &&
        currentTarget.contains(relatedTarget)
      ) {
        return;
      }
      setGutterVisible(false);
    },
    [showSideGutter],
  );

  return (
    <BlockChromeHandlesProvider
      value={
        gutterMode === "header"
          ? { bindGrip, gripProps, insertSiblingBelow, openMenu }
          : null
      }
    >
      <div
        id={`block-${node.id}`}
        ref={bindWrapper}
        style={wrapperStyle}
        data-block-chrome
        data-selected={selected ? "true" : undefined}
        className={`relative scroll-mt-24 ${
          selected ? "rounded-sm bg-blue-400/10 ring-2 ring-blue-400/50" : ""
        }`}
        onMouseEnter={showSideGutter ? revealGutter : undefined}
        onMouseLeave={
          showSideGutter
            ? (e) => hideGutter(e.relatedTarget, e.currentTarget)
            : undefined
        }
        onFocusCapture={showSideGutter ? revealGutter : undefined}
        onBlurCapture={
          showSideGutter
            ? (e) => hideGutter(e.relatedTarget, e.currentTarget)
            : undefined
        }
      >
        {showSideGutter ? (
          <>
            <div
              data-block-gutter-extender
              aria-hidden="true"
              className="absolute -left-12 inset-y-0 w-12 pointer-events-auto"
            />
            <div
              data-block-gutter
              className={`absolute -left-12 inset-y-0 flex items-center gap-0.5
                          transition-opacity duration-100
                          ${
                            gutterVisible
                              ? "opacity-100 pointer-events-auto"
                              : "opacity-0 pointer-events-none"
                          }`}
            >
              <SideGutterButtons
                onInsert={insertSiblingBelow}
                bindGrip={bindGrip}
                gripProps={gripProps}
                onOpenMenu={openMenu}
              />
            </div>
          </>
        ) : null}
        {children}
        {menuRect != null && (
          <BlockMenu
            node={node}
            anchorRect={menuRect}
            onClose={() => setMenuRect(null)}
          />
        )}
      </div>
    </BlockChromeHandlesProvider>
  );
}

function SideGutterButtons({
  onInsert,
  bindGrip,
  gripProps,
  onOpenMenu,
}: {
  onInsert: () => void;
  bindGrip: (el: HTMLButtonElement | null) => void;
  gripProps: BlockChromeGripProps;
  onOpenMenu: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onInsert}
        title="Insert a RichText block below"
        className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700
                   dark:hover:bg-neutral-800 dark:hover:text-neutral-300 transition-colors"
        aria-label="Insert block below"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        ref={bindGrip}
        {...gripProps}
        type="button"
        onClick={onOpenMenu}
        title="Drag to reorder, click for block actions"
        aria-label="Block actions / drag handle"
        aria-haspopup="menu"
        className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700
                   dark:hover:bg-neutral-800 dark:hover:text-neutral-300
                   cursor-grab active:cursor-grabbing transition-colors"
      >
        <GripIcon />
      </button>
    </>
  );
}

/** Compact + / grip for layout blocks — lives in the Container header row. */
export function BlockChromeHeaderControls({
  className = "",
}: {
  className?: string;
}) {
  const handles = useBlockChromeHandles();
  if (!handles) return null;
  return (
    <div className={`flex items-center gap-0.5 pointer-events-auto ${className}`}>
      <button
        type="button"
        onClick={handles.insertSiblingBelow}
        title="Insert a RichText block below this container"
        className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700
                   dark:hover:bg-neutral-800 dark:hover:text-neutral-300 transition-colors"
        aria-label="Insert block below container"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        ref={handles.bindGrip}
        {...handles.gripProps}
        type="button"
        onClick={handles.openMenu}
        title="Drag to reorder, click for block actions"
        aria-label="Container block actions / drag handle"
        aria-haspopup="menu"
        className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700
                   dark:hover:bg-neutral-800 dark:hover:text-neutral-300
                   cursor-grab active:cursor-grabbing transition-colors"
      >
        <GripIcon size={12} />
      </button>
    </div>
  );
}

function GripIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="3" r="1" fill="currentColor" />
      <circle cx="10" cy="3" r="1" fill="currentColor" />
      <circle cx="6" cy="8" r="1" fill="currentColor" />
      <circle cx="10" cy="8" r="1" fill="currentColor" />
      <circle cx="6" cy="13" r="1" fill="currentColor" />
      <circle cx="10" cy="13" r="1" fill="currentColor" />
    </svg>
  );
}
