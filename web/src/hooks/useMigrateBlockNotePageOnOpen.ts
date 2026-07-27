"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducer, useTable } from "spacetimedb/react";
import {
  buildMigrationPayload,
  parseBlockNotePageContent,
} from "@eclosion-tech/pulp";
import { tables, reducers } from "@/src/module_bindings";
import { clearIdbCacheForPage } from "@/src/lib/spacetime";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import type { PageRow } from "./usePages";

/** Set to `"false"` to keep legacy BlockNote on open (batch CLI only). */
const LAZY_MIGRATION_ENABLED =
  process.env.NEXT_PUBLIC_LAZY_BLOCKNOTE_MIGRATION !== "false";

export type BlockNoteMigrationStatus =
  | "not_needed"
  | "disabled"
  | "pending"
  | "migrating"
  | "done"
  | "failed";

function isBenignMigrationError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("already has componentnode") ||
    lower.includes("already migrated") ||
    lower.includes("not blocknote format") ||
    lower.includes("componenttree format")
  );
}

/**
 * Lazily migrate a BlockNote page to ComponentTree on first open.
 *
 * Primary rollout path — unvisited pages stay BlockNote until opened or
 * swept by `pnpm --filter web migrate-blocknote`.
 */
export function useMigrateBlockNotePageOnOpen(
  page: PageRow,
  contentJson: string | undefined,
) {
  const { idbNamespace } = useWorkspace();
  const migratePage = useReducer(reducers.migratePageToComponentTree);
  const [allPages] = useTable(tables.page);
  const livePage = allPages.find((p) => p.id === page.id) ?? page;
  const isComponentTree = livePage.contentFormat?.tag === "ComponentTree";

  const [status, setStatus] = useState<BlockNoteMigrationStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setRetryCount(0);
    setError(null);

    if (isComponentTree) {
      setStatus("not_needed");
      return;
    }
    if (!LAZY_MIGRATION_ENABLED) {
      setStatus("disabled");
      return;
    }
    setStatus(contentJson === undefined ? "pending" : "pending");
  }, [page.id, isComponentTree]);

  useEffect(() => {
    if (isComponentTree || !LAZY_MIGRATION_ENABLED) return;
    if (contentJson === undefined) return;

    const gen = ++generationRef.current;
    let cancelled = false;

    async function migrate() {
      setStatus("migrating");
      setError(null);

      try {
        const blocks = contentJson!.trim()
          ? parseBlockNotePageContent(contentJson!)
          : [];
        const payload = buildMigrationPayload(blocks);
        await migratePage({
          pageId: page.id,
          payloadJson: JSON.stringify(payload),
        });
        if (cancelled || gen !== generationRef.current) return;
        await clearIdbCacheForPage(page.id, idbNamespace).catch(() => {});
        setStatus("done");
      } catch (e) {
        if (cancelled || gen !== generationRef.current) return;
        const message = e instanceof Error ? e.message : String(e);
        if (isBenignMigrationError(message)) {
          setStatus("done");
          return;
        }
        setError(message);
        setStatus("failed");
      }
    }

    void migrate();
    return () => {
      cancelled = true;
    };
  }, [
    page.id,
    contentJson,
    isComponentTree,
    migratePage,
    idbNamespace,
    retryCount,
  ]);

  const retry = useCallback(() => {
    setRetryCount((n) => n + 1);
  }, []);

  const showComponentTree =
    isComponentTree || status === "not_needed" || status === "done";
  const showMigrating =
    !showComponentTree && (status === "pending" || status === "migrating");

  return {
    status,
    error,
    retry,
    showComponentTree,
    showMigrating,
  };
}
