"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import {
  classifyRowMembership,
  unscopedFallbackSql,
} from "@/src/lib/scopedTable";

/**
 * `useTable` twin that subscribes with a **raw SQL string** instead of the
 * typed query builder (ticket 14384 — stop downloading whole tables).
 *
 * Why raw SQL: the SDK 2.0.3 query builder renders the generated camelCase
 * accessor name into SQL (`WHERE surfaceId = …`) against snake_case server
 * columns (`surface_id`), so `.where()` subscriptions error out server-side —
 * a previous scoping attempt was reverted for exactly this reason (commit
 * 801af29 "fix failing connections"). Raw SQL strings pass through untouched
 * (see `SubscriptionBuilderImpl.subscribe`), so we write the server-side
 * names ourselves.
 *
 * Semantics mirror `useTable` (spacetimedb/src/react/useTable.ts): subscribe
 * on mount / whenever `sql` changes, rebuild the snapshot at most once per
 * transaction (event-id guard), unsubscribe on unmount, `ready` false until
 * the subscription for the *current* `sql` is applied.
 *
 * Safety: if the server rejects the scoped query, `onError` logs a warning
 * with the SQL and falls back to subscribing the unscoped
 * `SELECT * FROM <table>` — degrading to the pre-scoping behavior instead of
 * a broken page.
 *
 * The client cache is shared by every subscription of a table, so it can hold
 * rows from *other* mounted scopes (and the whole table on fallback). `filter`
 * therefore ALWAYS re-filters rows client-side; it must be a pure function of
 * the row and of the same parameters that produced `sql` (multiple
 * simultaneous mounts with different scopes each keep their own subscription
 * and their own filter).
 */
export interface UseScopedTableCallbacks<Row> {
  onInsert?: (row: Row) => void;
  /**
   * Fires when a row leaves the scope — a true cache delete or an update
   * moving the row outside `filter` — matching `useTable`'s membership
   * semantics.
   */
  onDelete?: (row: Row) => void;
  onUpdate?: (oldRow: Row, newRow: Row) => void;
}

/**
 * The subset of a `tables.*` registry entry the hook needs. `sourceName` is
 * the server-side (snake_case) table name; `accessorName` keys the client
 * cache on `connection.db`.
 */
export interface ScopedTableHandle {
  sourceName: string;
  accessorName: string;
}

// Minimal structural view of the SDK internals `useTable` relies on, to avoid
// importing non-exported types from package internals.
type RowEventCtx = { event: { id: string } };
type ClientTableCache<Row> = {
  iter(): Iterable<Row>;
  onInsert(cb: (ctx: RowEventCtx, row: Row) => void): void;
  removeOnInsert(cb: (ctx: RowEventCtx, row: Row) => void): void;
  onDelete(cb: (ctx: RowEventCtx, row: Row) => void): void;
  removeOnDelete(cb: (ctx: RowEventCtx, row: Row) => void): void;
  onUpdate?: (cb: (ctx: RowEventCtx, oldRow: Row, newRow: Row) => void) => void;
  removeOnUpdate?: (
    cb: (ctx: RowEventCtx, oldRow: Row, newRow: Row) => void,
  ) => void;
};
type SubscriptionHandle = { unsubscribe(): void; isEnded(): boolean };

type Snapshot<Row> = { rows: readonly Row[]; ready: boolean };

const EMPTY_SNAPSHOT: Snapshot<never> = Object.freeze({
  rows: Object.freeze([]) as readonly never[],
  ready: false,
});

export function useScopedTable<Row>(
  table: ScopedTableHandle,
  sql: string,
  filter: (row: Row) => boolean,
  callbacks?: UseScopedTableCallbacks<Row>,
): Snapshot<Row> {
  const { sourceName, accessorName } = table;

  let connectionState: ReturnType<typeof useSpacetimeDB>;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- unconditional; try/catch only rewrites the error (same pattern as the SDK's useTable)
    connectionState = useSpacetimeDB();
  } catch {
    throw new Error(
      "Could not find SpacetimeDB client! `useScopedTable` must be used in " +
        "the React component tree under a `SpacetimeDBProvider` component.",
    );
  }

  // `filter`/`callbacks` are read through refs so inline closures at call
  // sites don't churn the subscription or the store wiring.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Track WHICH sql is currently applied rather than a boolean, so changing
  // scope (e.g. navigating surfaces) reads as not-ready in the very same
  // render instead of flashing stale readiness over an empty cache.
  const [appliedSql, setAppliedSql] = useState<string | null>(null);
  const ready = appliedSql === sql;

  const latestTransactionEventId = useRef<string | null>(null);
  const lastSnapshotRef = useRef<Snapshot<Row> | null>(null);

  const computeSnapshot = useCallback((): Snapshot<Row> => {
    const connection = connectionState.getConnection();
    if (!connection) {
      return EMPTY_SNAPSHOT;
    }
    const cache = (connection.db as Record<string, unknown>)[
      accessorName
    ] as ClientTableCache<Row>;
    // ALWAYS re-filter: the shared cache can hold rows from other scoped
    // subscriptions of this table (or the whole table after a fallback).
    const rows = Array.from(cache.iter()).filter((row) =>
      filterRef.current(row),
    );
    return { rows, ready };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sql invalidates the snapshot when the scope changes; filter is intentionally a ref
  }, [connectionState, accessorName, sql, ready]);

  // Invalidate the cached snapshot when computeSnapshot changes (e.g. when
  // `ready` flips or `sql` changes) so getSnapshot() recomputes on the next
  // read instead of returning a stale tuple — same trick as useTable.
  useEffect(() => {
    lastSnapshotRef.current = null;
  }, [computeSnapshot]);

  // Per-instance subscription: subscribe on mount / when `sql` changes,
  // unsubscribe on cleanup. Overlapping subscriptions are safe — the client
  // cache refcounts rows per query set (spacetimedb/src/sdk/table_cache.ts).
  useEffect(() => {
    const connection = connectionState.getConnection();
    if (!connectionState.isActive || !connection) return;

    let disposed = false;
    let fallbackHandle: SubscriptionHandle | null = null;

    const scopedHandle: SubscriptionHandle = connection
      .subscriptionBuilder()
      .onApplied(() => {
        if (!disposed) setAppliedSql(sql);
      })
      .onError((ctx) => {
        // Server rejected the scoped query (bad SQL, unsupported join shape,
        // …). Degrade to the unscoped full-table subscription — exactly the
        // pre-14384 behavior — instead of leaving the page without data. The
        // client-side `filter` keeps the returned rows correct either way.
        console.warn(
          `[useScopedTable] Scoped subscription failed; falling back to full-table ` +
            `subscription of "${sourceName}". sql=${sql}`,
          ctx.event,
        );
        if (disposed) return;
        fallbackHandle = connection
          .subscriptionBuilder()
          .onApplied(() => {
            if (!disposed) setAppliedSql(sql);
          })
          .onError((fallbackCtx) => {
            console.warn(
              `[useScopedTable] Fallback full-table subscription failed for "${sourceName}".`,
              fallbackCtx.event,
            );
          })
          .subscribe(unscopedFallbackSql(sourceName));
      })
      .subscribe(sql);

    return () => {
      disposed = true;
      // An errored subscription is already ended (and deregistered by the
      // SDK); unsubscribing it again would throw / send a bogus Unsubscribe.
      try {
        if (!scopedHandle.isEnded()) scopedHandle.unsubscribe();
      } catch {
        // Already torn down (e.g. disconnect mid-flight) — nothing to release.
      }
      try {
        if (fallbackHandle && !fallbackHandle.isEnded()) {
          fallbackHandle.unsubscribe();
        }
      } catch {
        // Same — best-effort teardown.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, sourceName, connectionState.isActive, connectionState]);

  // Row-event wiring for useSyncExternalStore, mirroring useTable: run
  // callbacks per row (filtered / membership-classified), but rebuild the
  // snapshot at most once per transaction via the event-id guard.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const connection = connectionState.getConnection();
      if (!connection) {
        return () => {};
      }

      const maybeNotify = (ctx: RowEventCtx) => {
        if (ctx.event.id !== latestTransactionEventId.current) {
          latestTransactionEventId.current = ctx.event.id;
          lastSnapshotRef.current = computeSnapshot();
          onStoreChange();
        }
      };

      const onInsert = (ctx: RowEventCtx, row: Row) => {
        if (!filterRef.current(row)) return;
        callbacksRef.current?.onInsert?.(row);
        maybeNotify(ctx);
      };

      const onDelete = (ctx: RowEventCtx, row: Row) => {
        if (!filterRef.current(row)) return;
        callbacksRef.current?.onDelete?.(row);
        maybeNotify(ctx);
      };

      const onUpdate = (ctx: RowEventCtx, oldRow: Row, newRow: Row) => {
        const change = classifyRowMembership(filterRef.current, oldRow, newRow);
        switch (change) {
          case "leave":
            callbacksRef.current?.onDelete?.(oldRow);
            break;
          case "enter":
            callbacksRef.current?.onInsert?.(newRow);
            break;
          case "stayIn":
            callbacksRef.current?.onUpdate?.(oldRow, newRow);
            break;
          case "stayOut":
            return; // no-op
        }
        maybeNotify(ctx);
      };

      const cache = (connection.db as Record<string, unknown>)[
        accessorName
      ] as ClientTableCache<Row>;
      cache.onInsert(onInsert);
      cache.onDelete(onDelete);
      cache.onUpdate?.(onUpdate);

      return () => {
        cache.removeOnInsert(onInsert);
        cache.removeOnDelete(onDelete);
        cache.removeOnUpdate?.(onUpdate);
      };
    },
    [connectionState, accessorName, computeSnapshot],
  );

  const getSnapshot = useCallback((): Snapshot<Row> => {
    if (!lastSnapshotRef.current) {
      lastSnapshotRef.current = computeSnapshot();
    }
    return lastSnapshotRef.current;
  }, [computeSnapshot]);

  // SSR fallback can be the same getter (returns the empty snapshot).
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
