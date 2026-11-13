"use client";
import { tables } from "@/src/module_bindings";
import type { DatabaseSchema, PagePropertyValue, PropertyDefinition } from "@/src/module_bindings/types";
import { useScopedTable } from "./useScopedTable";
import { usePageAccess } from "./usePageAccess";
export function useWorkspaceComponentData(surfaceId: bigint) {
  const access = usePageAccess(surfaceId);
  const schemas = useScopedTable<DatabaseSchema>(
    tables.database_schema,
    "SELECT * FROM database_schema",
    () => true,
  );
  const properties = useScopedTable<PropertyDefinition>(
    tables.property_definition,
    "SELECT * FROM property_definition",
    () => true,
  );
  const values = useScopedTable<PagePropertyValue>(
    tables.page_property_value,
    "SELECT * FROM page_property_value",
    () => true,
  );
  const rules = { rows: access.rules, ready: access.ready };
  const data = {
    ...access,
    ready:
      access.ready &&
      schemas.ready &&
      properties.ready &&
      values.ready &&
      rules.ready,
    schemas: schemas.rows,
    properties: properties.rows,
    values: values.rows,
    rules: rules.rows,
  };
  return { access, data, schemas, properties, values, rules };
}
