"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { AiUsersSettings } from "@/src/components/AiUsersSettings";
import { ApiEndpointsSettings } from "@/src/components/ApiEndpointsSettings";
import { ExtensionsSettings } from "@/src/components/ExtensionsSettings";
import { MembersSettings } from "@/src/components/MembersSettings";
import { WorkspaceConnectionsPanel } from "@/src/components/WorkspaceConnectionsPanel";

export default function SettingsPage() {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
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

        <WorkspaceConnectionsPanel />

        <MembersSettings />

        <AiUsersSettings />

        <section className="mb-10">
          <ExtensionsSettings />
        </section>

        <ApiEndpointsSettings />

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
