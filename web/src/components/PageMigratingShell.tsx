"use client";

interface PageMigratingShellProps {
  error?: string | null;
  onRetry?: () => void;
  /** Lazy migration is switched off (`NEXT_PUBLIC_LAZY_BLOCKNOTE_MIGRATION=false`). */
  disabled?: boolean;
}

/**
 * Shown while BlockNote → ComponentTree lazy migration runs, and as the
 * terminal state when migration failed or is disabled (there is no legacy
 * editor to fall back to).
 */
export function PageMigratingShell({
  error,
  onRetry,
  disabled,
}: PageMigratingShellProps) {
  if (disabled) {
    return (
      <div
        className="rounded-lg border border-neutral-200 dark:border-neutral-800
                   bg-neutral-50 dark:bg-neutral-900/50 px-4 py-6 text-sm
                   text-neutral-600 dark:text-neutral-400"
      >
        <p className="font-medium text-neutral-800 dark:text-neutral-200">
          This page is still in the legacy format
        </p>
        <p className="mt-2">
          Lazy migration is disabled
          (<code className="font-mono text-xs">NEXT_PUBLIC_LAZY_BLOCKNOTE_MIGRATION=false</code>).
          Run the batch migration (<code className="font-mono text-xs">pnpm --filter web migrate-blocknote</code>)
          or re-enable lazy migration to edit this page.
        </p>
      </div>
    );
  }

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
