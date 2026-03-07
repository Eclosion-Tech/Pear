"use client";

import { useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

export function useDatabaseSchema(pageId: bigint) {
  const [schemas, isReady] = useTable(tables.database_schema);
  const schema = schemas.find((s) => s.pageId === pageId);
  return { schema, isReady };
}

export function usePropertyDefinitions(schemaId: bigint) {
  const [defs] = useTable(tables.property_definition);
  return defs
    .filter((d) => d.schemaId === schemaId)
    .sort((a, b) => a.order - b.order);
}

export function usePagePropertyValues(pageId: bigint) {
  const [values] = useTable(tables.page_property_value);
  return values.filter((v) => v.pageId === pageId);
}

export function useDatabaseViews(pageId: bigint) {
  const [views, isReady] = useTable(tables.database_view);
  const pageViews = views.filter((v) => v.pageId === pageId);
  return { views: pageViews, isReady };
}

export function useDeleteProperty() {
  return useReducer(reducers.deleteProperty);
}

export function useReorderProperty() {
  return useReducer(reducers.reorderProperty);
}

// Row types inferred from table query builders
export type DatabaseSchemaRow = ReturnType<typeof useDatabaseSchema>["schema"];
export type PropertyDefinitionRow = ReturnType<typeof usePropertyDefinitions>[number];
export type PagePropertyValueRow = ReturnType<typeof usePagePropertyValues>[number];
