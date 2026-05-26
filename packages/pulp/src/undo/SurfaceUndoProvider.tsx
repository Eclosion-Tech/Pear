"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  SurfaceUndoCoordinator,
  NOOP_UNDO_COORDINATOR,
} from "./SurfaceUndoCoordinator";

type SurfaceUndoValue = {
  coordinator: SurfaceUndoCoordinator;
  registerYjsUndoManager: SurfaceUndoCoordinator["registerYjsUndoManager"];
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
};

const SurfaceUndoContext = createContext<SurfaceUndoValue | null>(null);

export function SurfaceUndoProvider({
  coordinator,
  children,
}: {
  coordinator: SurfaceUndoCoordinator;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const value = useMemo<SurfaceUndoValue>(
    () => ({
      coordinator,
      registerYjsUndoManager: (id, um) =>
        coordinator.registerYjsUndoManager(id, um),
      undo: () => coordinator.undo(),
      redo: () => coordinator.redo(),
    }),
    [coordinator],
  );

  // Surface-level Cmd-Z / Cmd-Shift-Z / Ctrl-Y — wins over per-editor
  // yUndoPlugin keymaps so structural ops interleave correctly with text
  // edits on the same timeline. § Cross-block undo / redo — Keystroke routing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target;
      if (!(target instanceof Node) || !root.contains(target)) return;

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const isUndo = e.key === "z" && !e.shiftKey;
      const isRedo =
        (e.key === "z" && e.shiftKey) || (e.key === "y" && !e.shiftKey);
      if (!isUndo && !isRedo) return;

      e.preventDefault();
      e.stopPropagation();
      if (isUndo) {
        void coordinator.undo();
      } else {
        void coordinator.redo();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [coordinator]);

  return (
    <SurfaceUndoContext.Provider value={value}>
      <div ref={rootRef} className="contents">
        {children}
      </div>
    </SurfaceUndoContext.Provider>
  );
}

export function useSurfaceUndo(): SurfaceUndoValue {
  const ctx = useContext(SurfaceUndoContext);
  if (ctx) return ctx;
  return {
    coordinator: NOOP_UNDO_COORDINATOR as unknown as SurfaceUndoCoordinator,
    registerYjsUndoManager: NOOP_UNDO_COORDINATOR.registerYjsUndoManager,
    undo: NOOP_UNDO_COORDINATOR.undo,
    redo: NOOP_UNDO_COORDINATOR.redo,
  };
}

export { SurfaceUndoCoordinator } from "./SurfaceUndoCoordinator";
