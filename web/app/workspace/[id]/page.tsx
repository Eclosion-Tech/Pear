"use client";

import { useParams } from "next/navigation";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { DatabasePage } from "@/src/components/DatabasePage";
import { DocPage } from "@/src/components/DocPage";

export default function PageRoute() {
  const params = useParams();
  const pageId = BigInt(params.id as string);

  const [pages, isReady] = useTable(tables.page);
  const page = pages.find((p) => p.id === pageId);

  // Render as soon as the page is in the local cache — don't block on isReady,
  // which resets to false on every navigation even when data is already available.
  if (page) {
    if (page.deletedAt != null) {
      return (
        <div className="flex h-full items-center justify-center">
          <p className="text-neutral-500 text-sm">This page has been deleted.</p>
        </div>
      );
    }
    return page.pageType.tag === "Database" ? (
      <DatabasePage page={page} />
    ) : (
      <DocPage page={page} />
    );
  }

  // Page not in cache yet — wait for subscription to finish before declaring not found.
  if (!isReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-neutral-500 text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-neutral-500 text-sm">Page not found.</p>
    </div>
  );
}
