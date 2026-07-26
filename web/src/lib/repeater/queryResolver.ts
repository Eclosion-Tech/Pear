"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type { DataSourceConfig, QueryResolver, RepeaterRow } from "@eclosion-tech/pulp";
import { evaluatePagesQuery } from "./evaluatePagesQuery";
import { DatabaseRowCache, schemaChainIds } from "./databaseRows";
import { applyFilter, comparatorFor } from "./rowFilter";

/**
 * The host half of the repeater (ADR D1) for every entity kind.
 *
 * Supersedes the pages-only resolver: `pages` behaviour is unchanged, and
 * `database` (M4) resolves a Database page's rows with their property values
 * flattened by column name, so a template writes `{{row.Status}}` and a filter
 * writes `{ property: "Status", … }`.
 *
 * Pulp still knows nothing about SpacetimeDB — this maps a `DataSourceConfig`
 * onto subscriptions, which is what keeps the primitive portable to RN.
 *
 * Evaluation is full re-evaluation per delivery (D4). `IncrementalQuery` slots in
 * behind this interface later without touching a stored config.
 */

type Subscription = {
  config: DataSourceConfig;
  onRows: (rows: ReadonlyArray<RepeaterRow>) => void;
};

export function useQueryResolver(): QueryResolver {
  const [pages] = useTable(tables.page);
  const [schemas] = useTable(tables.database_schema);
  const [propertyDefs] = useTable(tables.property_definition);
  const [propertyValues] = useTable(tables.page_property_value);

  // One cache per resolver instance. Row objects must survive across deliveries
  // or the materializer's subtree memo never fires — see DatabaseRowCache.
  const rowCache = useRef(new DatabaseRowCache());

  const dataRef = useRef({ pages, schemas, propertyDefs, propertyValues });
  dataRef.current = { pages, schemas, propertyDefs, propertyValues };

  const evaluate = useRef((config: DataSourceConfig): RepeaterRow[] => {
    const { pages, schemas, propertyDefs, propertyValues } = dataRef.current;

    if (config.entity.kind === "pages") {
      return evaluatePagesQuery(pages, config);
    }

    // ── database ──────────────────────────────────────────────────────────
    const { schemaId, includeDescendants } = config.entity;
    const inScope = schemaChainIds(schemas, schemaId, includeDescendants === true);

    // Rows are the child pages of every Database page owned by a schema in
    // scope. Schema-chain support (D5) is why this is a set rather than one id.
    const dbPageIds = new Set(
      schemas.filter((s) => inScope.has(s.id)).map((s) => s.pageId),
    );
    const candidates = pages.filter(
      (p) =>
        p.parentId != null &&
        dbPageIds.has(p.parentId) &&
        p.deletedAt == null &&
        !p.isHidden,
    );

    const defs = propertyDefs
      .filter((d) => inScope.has(d.schemaId))
      .sort((a, b) => a.order - b.order);

    const rowPageIds = new Set(candidates.map((p) => p.id));
    const valuesFor = new Map<bigint, (typeof propertyValues)[number][]>();
    for (const v of propertyValues) {
      if (!rowPageIds.has(v.pageId)) continue;
      const list = valuesFor.get(v.pageId) ?? [];
      list.push(v);
      valuesFor.set(v.pageId, list);
    }
    // Stable order so a value-row reshuffle does not look like a change to the
    // identity check in the cache.
    for (const list of valuesFor.values()) {
      list.sort((a, b) => Number(a.propertyDefinitionId - b.propertyDefinitionId));
    }

    let rows = rowCache.current.build(candidates, defs, valuesFor);
    rows = applyFilter(rows, config.filter);
    if (config.sort && config.sort.length > 0) {
      rows = rows.slice().sort(comparatorFor(config.sort));
    }
    if (config.limit !== undefined) rows = rows.slice(0, config.limit);
    return rows;
  });

  const subsRef = useRef(new Map<number, Subscription>());
  const nextIdRef = useRef(0);

  useEffect(() => {
    for (const sub of subsRef.current.values()) {
      sub.onRows(evaluate.current(sub.config));
    }
  }, [pages, schemas, propertyDefs, propertyValues]);

  // Stable identity: a fresh resolver each render would tear down and rebuild
  // every repeater's subscription on every render.
  return useMemo<QueryResolver>(
    () => ({
      subscribe(config, onRows) {
        const id = nextIdRef.current++;
        subsRef.current.set(id, { config, onRows });
        // Deliver immediately so a repeater mounting against a warm cache
        // renders on its first frame.
        onRows(evaluate.current(config));
        return () => {
          subsRef.current.delete(id);
        };
      },
    }),
    [],
  );
}
