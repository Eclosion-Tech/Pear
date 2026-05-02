"use client";

import { useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { useSetPropertyValue, useCreatePage } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import type { DatabaseSchemaRow, PropertyDefinitionRow } from "@/src/hooks/useDatabase";
import { parseSelectConfig, getOptionColorClass } from "@/src/lib/formulaEval";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BoardViewProps {
  page: PageRow;
  schema: DatabaseSchemaRow | null;
  properties: PropertyDefinitionRow[];
  rows: PageRow[];
  groupByPropertyId: string | null;
  onSetGroupByPropertyId: (id: string | null) => void;
  onOpenRow: (row: PageRow) => void;
}

type PropValRow = {
  id: bigint;
  pageId: bigint;
  propertyDefinitionId: bigint;
  value: { tag: string; value: unknown };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRowSelectValue(
  rowId: bigint,
  propDefId: bigint,
  allValues: PropValRow[],
): string | null {
  const entry = allValues.find(
    (v) => v.pageId === rowId && v.propertyDefinitionId === propDefId,
  );
  if (!entry) return null;
  const val = entry.value;
  if (val.tag === "Select") return (val.value as string) || null;
  if (val.tag === "MultiSelect") {
    const arr = val.value as string[];
    return arr[0] ?? null;
  }
  return null;
}

function getRowMultiSelectValues(
  rowId: bigint,
  propDefId: bigint,
  allValues: PropValRow[],
): string[] {
  const entry = allValues.find(
    (v) => v.pageId === rowId && v.propertyDefinitionId === propDefId,
  );
  if (!entry) return [];
  const val = entry.value;
  if (val.tag === "MultiSelect") return val.value as string[];
  if (val.tag === "Select") return [(val.value as string)].filter(Boolean);
  return [];
}

function renderPropValue(
  rowId: bigint,
  prop: PropertyDefinitionRow,
  allValues: PropValRow[],
): string | null {
  const entry = allValues.find(
    (v) => v.pageId === rowId && v.propertyDefinitionId === prop.id,
  );
  if (!entry) return null;
  const val = entry.value;
  switch (val.tag) {
    case "Text":
    case "Url":
      return (val.value as string) || null;
    case "Number":
      return val.value != null ? String(val.value) : null;
    case "Select":
      return (val.value as string) || null;
    case "MultiSelect":
      return (val.value as string[]).join(", ") || null;
    case "Checkbox":
      return val.value ? "Yes" : null;
    default:
      return null;
  }
}

// ── Board card ────────────────────────────────────────────────────────────────

function BoardCard({
  row,
  properties,
  groupByPropId,
  allValues,
  onOpenRow,
  onDragStart,
}: {
  row: PageRow;
  properties: PropertyDefinitionRow[];
  groupByPropId: bigint;
  allValues: PropValRow[];
  onOpenRow: (row: PageRow) => void;
  onDragStart: (rowId: bigint) => void;
}) {
  // Show up to 3 non-groupBy properties
  const visibleProps = properties
    .filter((p) => p.id !== groupByPropId)
    .slice(0, 3);

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart(row.id);
      }}
      className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-sm px-3 py-2.5 cursor-pointer hover:shadow-md hover:border-neutral-300 dark:hover:border-neutral-600 transition-all select-none"
      onClick={() => onOpenRow(row)}
    >
      {/* Title */}
      <div className="text-sm font-medium text-neutral-800 dark:text-neutral-100 mb-1.5 leading-snug break-words">
        {row.title || "Untitled"}
      </div>

      {/* Property snippets */}
      {visibleProps.length > 0 && (
        <div className="flex flex-col gap-1">
          {visibleProps.map((prop) => {
            const text = renderPropValue(row.id, prop, allValues);
            if (!text) return null;
            const tag = prop.propertyType.tag;
            if (tag === "Select" || tag === "MultiSelect") {
              const chips =
                tag === "Select"
                  ? [text]
                  : (allValues.find(
                      (v) =>
                        v.pageId === row.id &&
                        v.propertyDefinitionId === prop.id,
                    )?.value.value as string[] | undefined) ?? [text];
              const cfg = parseSelectConfig(prop.config);
              return (
                <div key={String(prop.id)} className="flex flex-wrap gap-1">
                  {chips.slice(0, 2).map((chip) => (
                    <span
                      key={chip}
                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${getOptionColorClass(chip, cfg)}`}
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              );
            }
            return (
              <div
                key={String(prop.id)}
                className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400"
              >
                <span className="font-medium text-neutral-400 dark:text-neutral-500 shrink-0">
                  {prop.name}:
                </span>
                <span className="truncate">{text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function BoardView({
  page,
  schema: _schema,
  properties,
  rows,
  groupByPropertyId,
  onSetGroupByPropertyId,
  onOpenRow,
}: BoardViewProps) {
  const [allValues] = useTable(tables.page_property_value);
  const setPropertyValue = useSetPropertyValue();
  const createPage = useCreatePage();

  const [draggedRowId, setDraggedRowId] = useState<bigint | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  // Cast to our internal type shape
  const typedValues = allValues as unknown as PropValRow[];

  // Only Select and MultiSelect properties can be group-by
  const selectProps = properties.filter(
    (p) =>
      p.propertyType.tag === "Select" || p.propertyType.tag === "MultiSelect",
  );

  const groupByProperty = groupByPropertyId
    ? properties.find((p) => String(p.id) === groupByPropertyId) ?? null
    : null;

  // ── Picker screen ────────────────────────────────────────────────────────────
  if (!groupByProperty) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-neutral-500 py-16">
        <p className="text-sm">Choose a property to group by</p>
        {selectProps.length === 0 ? (
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Add a Select or Multi-select property first
          </p>
        ) : (
          <div className="flex flex-wrap gap-2 justify-center">
            {selectProps.map((p) => (
              <button
                key={String(p.id)}
                onClick={() => onSetGroupByPropertyId(String(p.id))}
                className="text-sm px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Column derivation ─────────────────────────────────────────────────────────
  let configOptions: string[] = [];
  try {
    const cfg = JSON.parse(groupByProperty.config || "{}") as {
      options?: string[];
    };
    configOptions = cfg.options ?? [];
  } catch {
    configOptions = [];
  }

  const isMulti = groupByProperty.propertyType.tag === "MultiSelect";

  interface BoardColumn {
    value: string | null; // null = "No value"
    label: string;
    rows: PageRow[];
  }

  // Build columns: one per option, then "No value"
  const columns: BoardColumn[] = [
    ...configOptions.map((opt) => {
      const colRows = rows.filter((row) => {
        if (isMulti) {
          const vals = getRowMultiSelectValues(
            row.id,
            groupByProperty.id,
            typedValues,
          );
          return vals.includes(opt);
        } else {
          return (
            getRowSelectValue(row.id, groupByProperty.id, typedValues) === opt
          );
        }
      });
      return { value: opt, label: opt, rows: colRows };
    }),
    {
      value: null,
      label: "No value",
      rows: rows.filter((row) => {
        if (isMulti) {
          const vals = getRowMultiSelectValues(
            row.id,
            groupByProperty.id,
            typedValues,
          );
          return vals.length === 0;
        } else {
          const v = getRowSelectValue(row.id, groupByProperty.id, typedValues);
          return !v;
        }
      }),
    },
  ];

  // ── Drag handlers ────────────────────────────────────────────────────────────
  function handleDrop(columnValue: string | null) {
    if (!draggedRowId) return;
    setDragOverColumn(null);

    if (isMulti) {
      const current = getRowMultiSelectValues(
        draggedRowId,
        groupByProperty!.id,
        typedValues,
      );
      // Remove existing membership in any listed option, add the new one
      const withoutOld = current.filter((v) => !configOptions.includes(v));
      const newVal = columnValue
        ? [...withoutOld, columnValue]
        : withoutOld;
      setPropertyValue({
        pageId: draggedRowId,
        propertyDefinitionId: groupByProperty!.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: { tag: "MultiSelect", value: newVal } as any,
      });
    } else {
      setPropertyValue({
        pageId: draggedRowId,
        propertyDefinitionId: groupByProperty!.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: { tag: "Select", value: columnValue ?? "" } as any,
      });
    }
    setDraggedRowId(null);
  }

  async function createNewRowInColumn(columnValue: string | null) {
    await createPage({
      parentId: page.id,
      pageType: { tag: "Doc" },
      title: "Untitled",
    });
    // We can't set the property value on creation in one call, but the row
    // will appear in "No value" first; a follow-up set is needed once we
    // have the new row id. For now the UX creates the card; the user can
    // then drag it or open it to assign the value.
    // TODO: wire up post-creation property set once createPage returns the id.
    void columnValue;
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Board sub-toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-200 dark:border-neutral-800">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          Grouped by{" "}
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            {groupByProperty.name}
          </span>
        </span>
        <button
          onClick={() => onSetGroupByPropertyId(null)}
          className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 underline transition-colors"
        >
          Change
        </button>
      </div>

      {/* Column layout */}
      <div className="flex gap-4 overflow-x-auto px-4 py-4 items-start flex-1">
        {columns.map((col) => {
          const colKey = col.value ?? "__none";
          const isDragTarget = dragOverColumn === colKey;

          return (
            <div
              key={colKey}
              className="flex-shrink-0 w-72 flex flex-col gap-2"
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {col.label}
                </span>
                <span className="text-xs text-neutral-400 dark:text-neutral-500 tabular-nums">
                  {col.rows.length}
                </span>
              </div>

              {/* Cards container */}
              <div
                className={`flex flex-col gap-2 min-h-[100px] p-1.5 rounded-lg transition-colors ${
                  isDragTarget
                    ? "bg-blue-50/80 dark:bg-blue-950/30 ring-1 ring-blue-300 dark:ring-blue-700"
                    : "bg-neutral-100/60 dark:bg-neutral-800/40"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverColumn(colKey);
                }}
                onDragLeave={() => {
                  setDragOverColumn(null);
                }}
                onDrop={() => handleDrop(col.value)}
              >
                {col.rows.map((row) => (
                  <BoardCard
                    key={String(row.id)}
                    row={row}
                    properties={properties}
                    groupByPropId={groupByProperty.id}
                    allValues={typedValues}
                    onOpenRow={onOpenRow}
                    onDragStart={(rowId) => {
                      setDraggedRowId(rowId);
                      setDragOverColumn(null);
                    }}
                  />
                ))}

                {/* New row button */}
                <button
                  onClick={() => createNewRowInColumn(col.value)}
                  className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 py-1 px-2 rounded hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60 transition-colors text-left"
                >
                  + New
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
