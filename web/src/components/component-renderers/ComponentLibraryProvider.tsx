"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import { WorkspaceLibrary } from "./ComponentTemplateLibrary";
export type LibraryRequest = {
  surfaceId?: bigint;
  parentId?: bigint | null;
  onInsert?: (
    descriptor: Record<string, unknown>,
    name: string,
  ) => void | Promise<void>;
};
const Context = createContext<{
  open: (request?: LibraryRequest) => void;
} | null>(null);
export const useComponentLibrary = () => useContext(Context);
export function ComponentLibraryProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { identity } = useSpacetimeDB(),
    principal = identity?.toHexString() ?? "anonymous";
  const [request, setRequest] = useState<LibraryRequest | null>(null);
  useEffect(() => setRequest(null), [principal]);
  const open = useCallback(
      (request: LibraryRequest = {}) => setRequest(request),
      [],
    ),
    value = useMemo(() => ({ open }), [open]);
  return (
    <Context.Provider value={value}>
      {children}
      {request && (
        <WorkspaceLibrary
          surfaceId={request.surfaceId ?? 0n}
          parentId={request.parentId ?? null}
          onInsert={request.onInsert}
          onClose={() => setRequest(null)}
        />
      )}
    </Context.Provider>
  );
}
export function WorkspaceComponentsButton() {
  const library = useComponentLibrary();
  return (
    <button
      type="button"
      onClick={() => library?.open()}
      disabled={!library}
      className="mb-2 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
    >
      <span aria-hidden="true">▦</span>Components
    </button>
  );
}
