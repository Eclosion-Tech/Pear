"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type { DataSourceConfig, QueryResolver, RepeaterRow } from "@eclosion-tech/pulp";
import { evaluatePagesQuery } from "./evaluatePagesQuery";

/**
 * `QueryResolver` for the `pages` entity — the host half of the repeater (D1).
 *
 * Pulp owns materialization and virtual-node rendering; this owns storage,
 * mapping a `DataSourceConfig` onto the existing `page` subscription. Keeping
 * the split here is what lets the primitive stay storage-agnostic and port to
 * the RN renderer later without dragging SpacetimeDB along.
 *
 * Query semantics live in `evaluatePagesQuery` — this file is only the glue.
 */

type Subscription = {
  config: DataSourceConfig;
  onRows: (rows: ReadonlyArray<RepeaterRow>) => void;
};

export function usePagesQueryResolver(): QueryResolver {
  const [pages] = useTable(tables.page);

  const subsRef = useRef(new Map<number, Subscription>());
  const nextIdRef = useRef(0);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // Re-evaluate every open query on each delivery (D4 v1: full re-evaluation).
  useEffect(() => {
    for (const sub of subsRef.current.values()) {
      sub.onRows(evaluatePagesQuery(pagesRef.current, sub.config));
    }
  }, [pages]);

  // Stable identity: a fresh resolver each render would tear down and rebuild
  // every repeater's subscription on every render.
  return useMemo<QueryResolver>(
    () => ({
      subscribe(config, onRows) {
        const id = nextIdRef.current++;
        subsRef.current.set(id, { config, onRows });
        // Deliver immediately so a repeater mounting against a warm cache
        // renders on its first frame instead of waiting for the next delivery.
        onRows(evaluatePagesQuery(pagesRef.current, config));
        return () => {
          subsRef.current.delete(id);
        };
      },
    }),
    [],
  );
}

export { evaluatePagesQuery };
