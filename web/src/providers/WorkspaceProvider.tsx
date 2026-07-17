"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  loadWorkspaces,
  peekActiveWorkspaceId,
  saveWorkspaces,
  setActiveWorkspaceId,
  type WorkspaceConnection,
} from "@/src/lib/workspaceConnections";
import { getIdbNamespace } from "@/src/lib/spacetime";

type WorkspaceContextValue = {
  ready: boolean;
  workspaces: WorkspaceConnection[];
  activeWorkspace: WorkspaceConnection | null;
  activeId: string | null;
  /** IndexedDB namespace for the active workspace (Yjs / editor cache). */
  idbNamespace: string;
  setActiveId: (id: string) => void;
  /**
   * Switch to another workspace as a user action. Defaults to persisting the
   * active id and reloading (standalone: every consumer of the active
   * workspace — connection, IDB namespace — re-initializes from localStorage).
   * Hosts where localStorage is NOT the source of truth (Pear Cloud pins the
   * active workspace to the URL slug on load) inject `onSwitchWorkspace` to
   * navigate instead. Prefer this over raw `setActiveId` + reload in UI.
   */
  switchWorkspace: (id: string) => void;
  addWorkspace: (w: Omit<WorkspaceConnection, "id">) => WorkspaceConnection;
  updateWorkspace: (id: string, patch: Partial<Omit<WorkspaceConnection, "id">>) => void;
  removeWorkspace: (id: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  children,
  onSwitchWorkspace,
}: {
  children: React.ReactNode;
  /** Override the user-initiated switch behavior (see `switchWorkspace`). */
  onSwitchWorkspace?: (workspace: WorkspaceConnection) => void;
}) {
  const [ready, setReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceConnection[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);

  useEffect(() => {
    const { list, activeId: a } = loadWorkspaces();
    setWorkspaces(list);
    setActiveIdState(a);
    setReady(true);
  }, []);

  const setActiveId = useCallback((id: string) => {
    setActiveWorkspaceId(id);
    setActiveIdState(id);
  }, []);

  const switchWorkspace = useCallback(
    (id: string) => {
      if (id === activeId) return;
      const target = workspaces.find((w) => w.id === id);
      if (!target) return;
      if (onSwitchWorkspace) {
        onSwitchWorkspace(target);
        return;
      }
      setActiveWorkspaceId(id);
      setActiveIdState(id);
      // Drop any WorkspaceQueryBootstrap params before reloading — they pin
      // the active workspace back to the deep-linked one on every load, which
      // would silently undo this switch.
      const url = new URL(window.location.href);
      for (const p of ["ws", "db", "wsname"]) url.searchParams.delete(p);
      window.location.assign(url.toString());
    },
    [activeId, workspaces, onSwitchWorkspace]
  );

  const addWorkspace = useCallback(
    (w: Omit<WorkspaceConnection, "id">) => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const row: WorkspaceConnection = { id, ...w };
      setWorkspaces((prev) => {
        const next = [...prev, row];
        saveWorkspaces(next, id);
        return next;
      });
      setActiveIdState(id);
      setActiveWorkspaceId(id);
      return row;
    },
    []
  );

  const updateWorkspace = useCallback((id: string, patch: Partial<Omit<WorkspaceConnection, "id">>) => {
    setWorkspaces((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, ...patch } : w));
      const aid = peekActiveWorkspaceId() ?? next[0]?.id ?? id;
      saveWorkspaces(next, aid);
      return next;
    });
  }, []);

  const removeWorkspace = useCallback((id: string) => {
    setWorkspaces((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((w) => w.id !== id);
      const curActive = peekActiveWorkspaceId();
      let newActive = curActive;
      if (curActive === id) {
        newActive = next[0].id;
        setActiveIdState(newActive);
        setActiveWorkspaceId(newActive);
      }
      saveWorkspaces(next, newActive ?? next[0].id);
      return next;
    });
  }, []);

  const activeWorkspace = useMemo(() => {
    if (!activeId) return workspaces[0] ?? null;
    return workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? null;
  }, [workspaces, activeId]);

  const idbNamespace = useMemo(() => {
    if (!activeWorkspace) return "pear_idb_pending";
    return getIdbNamespace(activeWorkspace.wsUri, activeWorkspace.dbName);
  }, [activeWorkspace]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      ready,
      workspaces,
      activeWorkspace,
      activeId,
      idbNamespace,
      setActiveId,
      switchWorkspace,
      addWorkspace,
      updateWorkspace,
      removeWorkspace,
    }),
    [
      ready,
      workspaces,
      activeWorkspace,
      activeId,
      idbNamespace,
      setActiveId,
      switchWorkspace,
      addWorkspace,
      updateWorkspace,
      removeWorkspace,
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return ctx;
}

/** Safe for components that may render outside the provider (should not happen). */
export function useWorkspaceOptional(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
