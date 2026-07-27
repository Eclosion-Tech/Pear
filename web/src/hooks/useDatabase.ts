"use client";

import { useMemo } from "react";
import { useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

// Derivations are useMemo'd on the stable useTable snapshot so consumers
// get stable array identities between row events (ticket 14378).

export function useDatabaseSchema(pageId: bigint) {
  const [schemas, isReady] = useTable(tables.database_schema);
  const schema = useMemo(
    () => schemas.find((s) => s.pageId === pageId),
    [schemas, pageId],
  );
  return { schema, isReady };
}

export function usePropertyDefinitions(schemaId: bigint) {
  const [defs] = useTable(tables.property_definition);
  return useMemo(
    () =>
      defs
        .filter((d) => d.schemaId === schemaId)
        .sort((a, b) => a.order - b.order),
    [defs, schemaId],
  );
}

export function usePagePropertyValues(pageId: bigint) {
  const [values] = useTable(tables.page_property_value);
  return useMemo(
    () => values.filter((v) => v.pageId === pageId),
    [values, pageId],
  );
}

export function useDatabaseViews(pageId: bigint) {
  const [views, isReady] = useTable(tables.database_view);
  const pageViews = useMemo(
    () => views.filter((v) => v.pageId === pageId),
    [views, pageId],
  );
  return { views: pageViews, isReady };
}

export function useClearPropertyValue() {
  return useReducer(reducers.clearPropertyValue);
}

export function useDeleteProperty() {
  return useReducer(reducers.deleteProperty);
}

export function useReorderProperty() {
  return useReducer(reducers.reorderProperty);
}

export function useRenameProperty() {
  return useReducer(reducers.renameProperty);
}

export function useUpdatePropertyConfig() {
  return useReducer(reducers.updatePropertyConfig);
}

export function useUpdatePropertyType() {
  return useReducer(reducers.updatePropertyType);
}

export function useUpdateViewConfig() {
  return useReducer(reducers.updateViewConfig);
}

export function useUpdateDatabaseSchemaConfig() {
  return useReducer(reducers.updateDatabaseSchemaConfig);
}

// Row types inferred from table query builders
export type DatabaseSchemaRow = ReturnType<typeof useDatabaseSchema>["schema"];
export type PropertyDefinitionRow = ReturnType<typeof usePropertyDefinitions>[number];
export type PagePropertyValueRow = ReturnType<typeof usePagePropertyValues>[number];
