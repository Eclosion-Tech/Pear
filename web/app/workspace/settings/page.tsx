"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { clearIdbCache } from "@/src/lib/spacetime";

export default function SettingsPage() {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [clearing, setClearing] = useState(false);

  async function handleClearCache() {
    setClearing(true);
    await clearIdbCache();
    window.location.reload();
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-xl mx-auto px-8 py-12">
        <div className="flex items-center gap-3 mb-10">
          <button
            onClick={() => router.push("/workspace")}
            className="p-1.5 rounded text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            aria-label="Back"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">Settings</h1>
        </div>

        <section className="mb-10">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">Appearance</h2>
          <div className="flex items-center justify-between py-3 border-b border-neutral-200 dark:border-neutral-800">
            <span className="text-neutral-700 dark:text-neutral-300">Theme</span>
            <div className="flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 rounded p-0.5">
              <button
                onClick={() => setTheme("light")}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${resolvedTheme === "light" ? "bg-white dark:bg-neutral-700 shadow text-neutral-900 dark:text-white" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"}`}
              >
                Light
              </button>
              <button
                onClick={() => setTheme("dark")}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${resolvedTheme === "dark" ? "bg-white dark:bg-neutral-700 shadow text-neutral-900 dark:text-white" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"}`}
              >
                Dark
              </button>
            </div>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">Data</h2>
          <div className="py-3 border-b border-neutral-200 dark:border-neutral-800">
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
              Clear all locally cached editor state (IndexedDB). Content will re-sync from the server on next load. Use if you see sync issues or after schema changes.
            </p>
            <button
              onClick={handleClearCache}
              disabled={clearing}
              className="px-3 py-1.5 rounded text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50 transition-colors"
            >
              {clearing ? "Clearing…" : "Clear cached data"}
            </button>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">About</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Pear — self-hosted, relational-first workspace.
          </p>
        </section>
      </div>
    </div>
  );
}
