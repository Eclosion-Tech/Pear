"use client";

interface PageMigratingShellProps {
  error?: string | null;
  onRetry?: () => void;
}

/** Shown while BlockNote → ComponentTree lazy migration runs (no PearEditor flash). */
export function PageMigratingShell({ error, onRetry }: PageMigratingShellProps) {
  if (error) {
    return (
      <div
        className="rounded-lg border border-amber-200 dark:border-amber-900/50
                   bg-amber-50 dark:bg-amber-950/30 px-4 py-6 text-sm"
        role="alert"
      >
        <p className="font-medium text-amber-900 dark:text-amber-200">
          Could not upgrade this page to the new editor
        </p>
        <p className="mt-2 text-amber-800/90 dark:text-amber-300/90 font-mono text-xs break-all">
          {error}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-md bg-amber-900 px-3 py-1.5 text-xs font-medium
                       text-white hover:bg-amber-800 dark:bg-amber-100 dark:text-amber-950
                       dark:hover:bg-white transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-16 text-neutral-500
                 dark:text-neutral-400"
      aria-busy="true"
      aria-live="polite"
    >
      <div
        className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300
                   border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300"
      />
      <p className="text-sm">Upgrading page to the new editor…</p>
    </div>
  );
}
