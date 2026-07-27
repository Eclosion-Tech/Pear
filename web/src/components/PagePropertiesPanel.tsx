"use client";

import { useMemo } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { PropertyCell } from "./PropertyCell";
import { usePagePropertyValues, usePropertyDefinitions } from "@/src/hooks/useDatabase";
import { useUsers } from "@/src/hooks/useUser";
import { buildSiblingValues } from "@/src/lib/formulaEval";

export function PagePropertiesPanel({
  pageId,
  properties,
}: {
  pageId: bigint;
  properties: ReturnType<typeof usePropertyDefinitions>;
}) {
  const values = usePagePropertyValues(pageId);
  // Subscribed once for the whole panel — Relation/Person cells resolve
  // titles and names from these instead of subscribing per cell.
  const [allPages] = useTable(tables.page);
  const { users } = useUsers();

  const siblingValues = useMemo(
    () => buildSiblingValues(values, properties),
    [values, properties]
  );

  return (
    <div className="space-y-1">
      {properties.map((prop) => {
        const val = values.find((v) => v.propertyDefinitionId === prop.id);
        return (
          <div key={String(prop.id)} className="flex items-start gap-3 min-h-8">
            <div className="w-36 flex-shrink-0 text-xs text-neutral-500 dark:text-neutral-400 pt-1.5 flex items-center gap-1.5 truncate">
              <PropIcon type={prop.propertyType.tag} />
              <span className="truncate">{prop.name}</span>
            </div>
            <div className="flex-1 min-w-0 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
              <PropertyCell
                pageId={pageId}
                definition={prop}
                value={val?.value}
                siblingValues={siblingValues}
                allPages={allPages}
                users={users}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PropIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    Text: "T",
    Number: "#",
    Date: "📅",
    Select: "◉",
    MultiSelect: "☰",
    Relation: "↗",
    Checkbox: "✓",
    Url: "🔗",
  };
  return (
    <span className="font-mono text-neutral-400 dark:text-neutral-600 text-xs">
      {icons[type] ?? "?"}
    </span>
  );
}
