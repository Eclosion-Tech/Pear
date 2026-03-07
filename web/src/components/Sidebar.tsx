"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { useTheme } from "next-themes";
import {
  useRootPages,
  useCreatePage,
  useConnection,
} from "@/src/hooks/usePages";
import { useCurrentUser } from "@/src/hooks/useUser";
import { SignOutButton } from "@/src/components/SignOutButton";

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Avoid hydration mismatch — only render after client mount.
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <button
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      title="Toggle theme"
      className="text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors text-sm"
    >
      {resolvedTheme === "dark" ? "☀︎" : "☾"}
    </button>
  );
}

export function Sidebar() {
  const router = useRouter();
  const params = useParams();
  const activeId = params?.id as string | undefined;

  const { roots, isReady } = useRootPages();
  const createPage = useCreatePage();
  const { isActive } = useConnection();
  const { user, displayName, initials } = useCurrentUser();

  const [isCreating, setIsCreating] = useState(false);
  const [pendingNav, setPendingNav] = useState<Set<bigint> | null>(null);

  useEffect(() => {
    if (!pendingNav) return;
    const newPage = roots.find((p) => !pendingNav.has(p.id));
    if (newPage) {
      setPendingNav(null);
      router.push(`/workspace/${newPage.id}`);
    }
  }, [roots, pendingNav, router]);

  async function handleNewDoc() {
    setPendingNav(new Set(roots.map((p) => p.id)));
    setIsCreating(true);
    try {
      await createPage({
        parentId: undefined,
        pageType: { tag: "Doc" },
        title: "Untitled",
      });
    } catch {
      setPendingNav(null);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleNewDatabase() {
    setPendingNav(new Set(roots.map((p) => p.id)));
    setIsCreating(true);
    try {
      await createPage({
        parentId: undefined,
        pageType: { tag: "Database" },
        title: "Untitled Database",
      });
    } catch {
      setPendingNav(null);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <aside className="w-56 flex-shrink-0 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
        <span className="text-lg font-semibold text-neutral-900 dark:text-white tracking-tight">
          🍐 Pear
        </span>
        {!isActive && (
          <span className="ml-auto text-xs text-yellow-600 dark:text-yellow-500">connecting…</span>
        )}
      </div>

      {/* Page list */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {roots.length === 0 && !isReady ? (
          <div className="px-2 py-1 text-xs text-neutral-400 dark:text-neutral-500">Loading…</div>
        ) : roots.length === 0 ? (
          <div className="px-2 py-2 text-xs text-neutral-400 dark:text-neutral-500 italic">
            No pages yet — create one below
          </div>
        ) : (
          roots.map((page) => (
            <button
              key={String(page.id)}
              onClick={() => router.push(`/workspace/${page.id}`)}
              className={`w-full text-left px-2 py-1.5 rounded text-sm truncate transition-colors ${
                String(page.id) === activeId
                  ? "bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-white"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white"
              }`}
            >
              <span className="mr-1.5 text-xs">
                {page.pageType.tag === "Database" ? "⊞" : "📄"}
              </span>
              {page.title}
            </button>
          ))
        )}
      </nav>

      {/* New page buttons */}
      <div className="px-2 py-2 border-t border-neutral-200 dark:border-neutral-800 space-y-1">
        <button
          onClick={handleNewDoc}
          disabled={isCreating || !isActive}
          className="w-full text-left px-2 py-1.5 rounded text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white transition-colors disabled:opacity-40"
        >
          + New page
        </button>
        <button
          onClick={handleNewDatabase}
          disabled={isCreating || !isActive}
          className="w-full text-left px-2 py-1.5 rounded text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-white transition-colors disabled:opacity-40"
        >
          + New database
        </button>
      </div>

      {/* User widget */}
      {user && (
        <div className="px-3 py-2.5 border-t border-neutral-200 dark:border-neutral-800 flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{initials}</span>
          </div>
          <span className="flex-1 text-xs text-neutral-500 dark:text-neutral-400 truncate">{displayName}</span>
          <ThemeToggle />
          <SignOutButton />
        </div>
      )}
    </aside>
  );
}
