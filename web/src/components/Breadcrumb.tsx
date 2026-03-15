"use client";

import { useRouter } from "next/navigation";

interface BreadcrumbProps {
  ancestors: Array<{ id: bigint; title: string }>;
  currentTitle: string;
}

export function Breadcrumb({ ancestors, currentTitle }: BreadcrumbProps) {
  const router = useRouter();

  return (
    <nav className="flex items-center gap-1.5 text-sm text-neutral-500 dark:text-neutral-400 mb-1 min-w-0">
      <button
        type="button"
        onClick={() => router.push("/workspace")}
        className="hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors truncate"
      >
        Workspace
      </button>
      {ancestors.map(({ id, title }) => (
        <span key={String(id)} className="flex items-center gap-1.5 shrink-0">
          <span aria-hidden className="text-neutral-300 dark:text-neutral-600">/</span>
          <button
            type="button"
            onClick={() => router.push(`/workspace/${id}`)}
            className="hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors truncate max-w-[140px]"
            title={title}
          >
            {title}
          </button>
        </span>
      ))}
      <span className="flex items-center gap-1.5 min-w-0">
        <span aria-hidden className="text-neutral-300 dark:text-neutral-600 shrink-0">/</span>
        <span className="text-neutral-700 dark:text-neutral-200 font-medium truncate" title={currentTitle}>
          {currentTitle || "Untitled"}
        </span>
      </span>
    </nav>
  );
}
