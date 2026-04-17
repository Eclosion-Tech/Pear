"use client";

/**
 * Lazy-loaded wrapper around `@stoplight/elements`. Imported via
 * `next/dynamic({ ssr: false })` so the ~600KB Stoplight bundle is only
 * fetched when an operator actually opens the API docs panel for one of
 * their custom endpoints. Keeping this in its own file is what lets that
 * code split happen.
 */

import { useEffect, useState } from "react";
import "@stoplight/elements/styles.min.css";
// Type-only — runtime is accessed via the dynamic import below to avoid
// pulling Stoplight into the main client bundle.
import type { ComponentType } from "react";

type ApiPropsLike = {
  apiDescriptionUrl?: string;
  apiDescriptionDocument?: string;
  router?: "hash" | "memory" | "history" | "static";
  layout?: "sidebar" | "stacked";
  hideSchemas?: boolean;
  hideInternal?: boolean;
};

interface Props {
  /** Fully-resolved URL of the endpoint's `_schema` route. */
  schemaUrl: string;
}

export default function ApiEndpointsDocsPanel({ schemaUrl }: Props) {
  const [Comp, setComp] = useState<ComponentType<ApiPropsLike> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Stoplight ships a partial type tree that doesn't resolve under its
    // package.json `exports`; the ambient declaration in
    // `src/types/stoplight-elements.d.ts` makes this a typed `any` so we
    // don't need to maintain our own typings for the entire surface.
    import("@stoplight/elements")
      .then((mod) => {
        if (cancelled) return;
        setComp(() => mod.API as ComponentType<ApiPropsLike>);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p className="text-xs text-red-600 dark:text-red-400">
        Failed to load API docs viewer: {error}
      </p>
    );
  }

  if (!Comp) {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Loading API docs…
      </p>
    );
  }

  return (
    <div className="h-[600px] border border-neutral-200 dark:border-neutral-700 rounded overflow-hidden bg-white dark:bg-neutral-950">
      <Comp
        apiDescriptionUrl={schemaUrl}
        router="hash"
        layout="sidebar"
        hideInternal
      />
    </div>
  );
}
