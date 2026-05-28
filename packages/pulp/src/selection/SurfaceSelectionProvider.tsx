"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { BlockId } from "../types";
import { SurfaceSelectionController } from "./SurfaceSelectionController";
import type { Rect } from "./selectionGeometry";

export type SurfaceSelectionValue = {
  controller: SurfaceSelectionController;
  selectedIds: readonly BlockId[];
  isSelected: (id: BlockId) => boolean;
  /** Register a block's live bounding-rect getter (for marquee hit-testing). */
  registerRect: (id: BlockId, getRect: () => DOMRect | null) => () => void;
  /** Snapshot all registered block rects in viewport coordinates. */
  getRects: () => Map<BlockId, Rect>;
};

const SurfaceSelectionContext = createContext<SurfaceSelectionValue | null>(null);

export function SurfaceSelectionProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<SurfaceSelectionController | null>(null);
  if (controllerRef.current == null) {
    controllerRef.current = new SurfaceSelectionController();
  }
  const controller = controllerRef.current;

  const rectsRef = useRef(new Map<BlockId, () => DOMRect | null>());

  const selectedIds = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const value = useMemo<SurfaceSelectionValue>(() => {
    const selectedSet = new Set(selectedIds);
    return {
      controller,
      selectedIds,
      isSelected: (id) => selectedSet.has(id),
      registerRect: (id, getRect) => {
        rectsRef.current.set(id, getRect);
        return () => {
          if (rectsRef.current.get(id) === getRect) {
            rectsRef.current.delete(id);
          }
        };
      },
      getRects: () => {
        const out = new Map<BlockId, Rect>();
        for (const [id, getRect] of rectsRef.current) {
          const r = getRect();
          if (r) {
            out.set(id, {
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
            });
          }
        }
        return out;
      },
    };
  }, [controller, selectedIds]);

  return (
    <SurfaceSelectionContext.Provider value={value}>
      {children}
    </SurfaceSelectionContext.Provider>
  );
}

export function useSurfaceSelection(): SurfaceSelectionValue {
  const ctx = useContext(SurfaceSelectionContext);
  if (!ctx) {
    throw new Error("useSurfaceSelection must be used within SurfaceSelectionProvider");
  }
  return ctx;
}

/** Optional variant — returns null outside a provider (standalone renderers). */
export function useSurfaceSelectionOptional(): SurfaceSelectionValue | null {
  return useContext(SurfaceSelectionContext);
}
