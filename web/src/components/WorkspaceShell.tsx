"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Sidebar } from "@/src/components/Sidebar";
import { AiPanel } from "@/src/components/AiPanel";

interface WorkspaceAiPanelContextValue {
  isOpen: boolean;
  activePageId: bigint | null;
  openPanel: (options?: { pageId?: bigint; conversationId?: bigint }) => void;
  closePanel: () => void;
  togglePanelForPage: (pageId: bigint) => void;
}

const WorkspaceAiPanelContext =
  createContext<WorkspaceAiPanelContextValue | null>(null);

export function useWorkspaceAiPanel() {
  const value = useContext(WorkspaceAiPanelContext);
  if (!value) {
    throw new Error(
      "useWorkspaceAiPanel must be used inside WorkspaceAiPanelLayout (or WorkspaceShell)",
    );
  }
  return value;
}

/**
 * Provides AI panel context + optional slide-over {@link AiPanel}. Pass the same
 * `Sidebar` + `main` row you would render without the panel (see {@link WorkspaceShell}).
 * Pear-cloud CloudWorkspaceShell uses this so doc/database pages can call
 * {@link useWorkspaceAiPanel} without duplicating the pear standalone layout.
 */
export function WorkspaceAiPanelLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const conversationParam = searchParams.get("conversation");
  const currentPageId = useMemo(() => pageIdFromPathname(pathname), [pathname]);

  const [isOpen, setIsOpen] = useState(false);
  const [fallbackPageId, setFallbackPageId] = useState<bigint | null>(null);
  const [openConversationId, setOpenConversationId] = useState<
    bigint | undefined
  >(undefined);
  const [panelWidth, setPanelWidth] = useState(340);
  const resizing = useRef(false);

  const activePageId = currentPageId ?? fallbackPageId;

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizing.current) return;
      const newWidth = window.innerWidth - e.clientX;
      setPanelWidth(Math.max(280, Math.min(newWidth, 720)));
    }

    function onMouseUp() {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const openPanel = useCallback(
    (options?: { pageId?: bigint; conversationId?: bigint }) => {
      const nextPageId = options?.pageId ?? currentPageId ?? fallbackPageId;
      if (nextPageId != null) {
        setFallbackPageId(nextPageId);
      }
      if (options?.conversationId !== undefined) {
        setOpenConversationId(options.conversationId);
      }
      setIsOpen(true);
    },
    [currentPageId, fallbackPageId],
  );

  const closePanel = useCallback(() => {
    setIsOpen(false);
    setOpenConversationId(undefined);
  }, []);

  const togglePanelForPage = useCallback(
    (pageId: bigint) => {
      if (isOpen) {
        closePanel();
        return;
      }
      openPanel({ pageId });
    },
    [closePanel, isOpen, openPanel],
  );

  useEffect(() => {
    if (!conversationParam) return;

    let conversationId: bigint;
    try {
      conversationId = BigInt(conversationParam);
    } catch {
      return;
    }

    if (currentPageId != null) {
      setFallbackPageId(currentPageId);
    }
    setOpenConversationId(conversationId);
    setIsOpen(true);
  }, [conversationParam, currentPageId]);

  const contextValue = useMemo<WorkspaceAiPanelContextValue>(
    () => ({
      isOpen,
      activePageId,
      openPanel,
      closePanel,
      togglePanelForPage,
    }),
    [activePageId, closePanel, isOpen, openPanel, togglePanelForPage],
  );

  return (
    <WorkspaceAiPanelContext.Provider value={contextValue}>
      <div className="flex h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-200 overflow-hidden">
        {children}
        {isOpen && activePageId != null && (
          <aside
            className="shrink-0 relative flex border-l border-neutral-200 dark:border-neutral-800"
            style={{ width: panelWidth }}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize AI panel"
              title="Drag to resize panel"
              className="absolute left-0 top-0 bottom-0 w-3 -translate-x-1/2 z-10 flex items-center justify-center cursor-col-resize hover:bg-violet-400/20 active:bg-violet-400/35 transition-colors select-none"
              onMouseDown={(e) => {
                e.preventDefault();
                resizing.current = true;
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
            >
              <span
                className="w-1 h-12 rounded-full bg-neutral-300/80 dark:bg-neutral-600/80 pointer-events-none shadow-sm"
                aria-hidden
              />
            </div>
            <div className="flex-1 min-w-0">
              <AiPanel
                pageId={activePageId}
                onClose={closePanel}
                openConversationId={openConversationId}
              />
            </div>
          </aside>
        )}
      </div>
    </WorkspaceAiPanelContext.Provider>
  );
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceAiPanelLayout>
      <Sidebar />
      <main className="flex-1 overflow-hidden">{children}</main>
    </WorkspaceAiPanelLayout>
  );
}

function pageIdFromPathname(pathname: string | null): bigint | null {
  if (!pathname) return null;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "workspace") return null;

  // Standalone pear: /workspace/<pageId>
  if (parts.length === 2) {
    try {
      return BigInt(decodeURIComponent(parts[1]));
    } catch {
      return null;
    }
  }

  // Pear-cloud: /workspace/<slug>/<pageId> (ignore /settings, /trash, etc.)
  const last = parts[parts.length - 1];
  if (!/^\d+$/.test(last)) return null;
  try {
    return BigInt(last);
  } catch {
    return null;
  }
}
