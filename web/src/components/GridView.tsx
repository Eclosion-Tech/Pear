"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useChildPages,
  useCreatePage,
  useAddProperty,
  useCreateDatabaseSchema,
  useCreateView,
  useSetPropertyValue,
  useDeletePage,
} from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import {
  useDatabaseSchema,
  usePropertyDefinitions,
  usePagePropertyValues,
  useClearPropertyValue,
  useDeleteProperty,
  useRenameProperty,
  useUpdatePropertyType,
  useUpdatePropertyConfig,
} from "@/src/hooks/useDatabase";
import type { PropertyDefinitionRow } from "@/src/hooks/useDatabase";
import { PropertyCell } from "./PropertyCell";
import { RowDetailModal } from "./RowDetailModal";
import {
  PropertyTypePicker,
  type PropertyTypeTag,
} from "./PropertyTypePicker";
import { FloatingPopup } from "./FloatingPopup";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

// ──── Filter types & helpers ──────────────────────────────────────────────────

type FilterOperator =
  | "contains" | "does_not_contain"
  | "is" | "is_not"
  | "equals" | "not_equals" | "gt" | "gte" | "lt" | "lte"
  | "is_empty" | "is_not_empty"
  | "checked" | "unchecked"
  | "before" | "after" | "on";

interface FilterRule {
  id: string;
  propertyId: bigint | null; // null = row title
  operator: FilterOperator;
  value: string;
}

// ──── Sort types & helpers ────────────────────────────────────────────────────

interface SortRule {
  id: string;
  propertyId: bigint | null; // null = row title
  direction: "asc" | "desc";
}

function compareForSort(
  a: PageRow,
  b: PageRow,
  rule: SortRule,
  allValues: PropValRow[],
): number {
  const dir = rule.direction === "asc" ? 1 : -1;

  if (rule.propertyId === null) {
    return dir * (a.title ?? "").localeCompare(b.title ?? "");
  }

  const aEntry = allValues.find(
    (v) => v.pageId === a.id && v.propertyDefinitionId === rule.propertyId,
  );
  const bEntry = allValues.find(
    (v) => v.pageId === b.id && v.propertyDefinitionId === rule.propertyId,
  );

  // Rows missing a value sort last regardless of direction
  if (!aEntry && !bEntry) return 0;
  if (!aEntry) return 1;
  if (!bEntry) return -1;

  const av = aEntry.value;
  const bv = bEntry.value;
  if (av.tag !== bv.tag) return 0;

  switch (av.tag) {
    case "Text": case "Select": case "Url":
      return dir * (av.value as string).localeCompare(bv.value as string);
    case "Number":
      return dir * ((av.value as number) - (bv.value as number));
    case "Date":
      return dir * (Number(av.value as bigint) - Number(bv.value as bigint));
    case "Checkbox":
      return dir * ((av.value ? 1 : 0) - (bv.value ? 1 : 0));
    case "MultiSelect": {
      const af = (av.value as string[])[0] ?? "";
      const bf = (bv.value as string[])[0] ?? "";
      return dir * af.localeCompare(bf);
    }
    case "Relation":
      return dir * ((av.value as bigint[]).length - (bv.value as bigint[]).length);
    default:
      return 0;
  }
}

const OP_LABELS: Record<FilterOperator, string> = {
  contains: "contains",
  does_not_contain: "does not contain",
  is: "is",
  is_not: "is not",
  equals: "=",
  not_equals: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  checked: "is checked",
  unchecked: "is unchecked",
  before: "before",
  after: "after",
  on: "on",
};

function opsForType(type: string): FilterOperator[] {
  switch (type) {
    case "Number":
      return ["equals", "not_equals", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"];
    case "Select":
      return ["is", "is_not", "is_empty", "is_not_empty"];
    case "MultiSelect":
      return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
    case "Checkbox":
      return ["checked", "unchecked"];
    case "Date":
      return ["before", "after", "on", "is_empty", "is_not_empty"];
    case "Relation":
      return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
    case "Text":
    case "Url":
    default:
      return ["contains", "does_not_contain", "is", "is_not", "is_empty", "is_not_empty"];
  }
}

const TITLE_OPS: FilterOperator[] = [
  "contains", "does_not_contain", "is", "is_not", "is_empty", "is_not_empty",
];

function needsValueInput(op: FilterOperator): boolean {
  return !["is_empty", "is_not_empty", "checked", "unchecked"].includes(op);
}

function parseConfig(cfg: string): Record<string, unknown> {
  try { return JSON.parse(cfg); } catch { return {}; }
}

function configOptions(cfg: string): string[] {
  const parsed = parseConfig(cfg);
  return Array.isArray(parsed.options) ? (parsed.options as string[]) : [];
}

function isPropValueEmpty(pv: { tag: string; value: unknown }): boolean {
  switch (pv.tag) {
    case "Text": case "Select": case "Url":
      return (pv.value as string).trim() === "";
    case "MultiSelect":
      return (pv.value as string[]).length === 0;
    case "Relation":
      return (pv.value as bigint[]).length === 0;
    case "Date":
      return (pv.value as bigint) === BigInt(0);
    default:
      return false;
  }
}

type PropValRow = { pageId: bigint; propertyDefinitionId: bigint; value: { tag: string; value: unknown } };

function matchesTextOp(text: string, op: FilterOperator, value: string): boolean {
  const t = text.toLowerCase();
  const v = value.toLowerCase();
  switch (op) {
    case "contains": return t.includes(v);
    case "does_not_contain": return !t.includes(v);
    case "is": return t === v;
    case "is_not": return t !== v;
    case "is_empty": return text.trim() === "";
    case "is_not_empty": return text.trim() !== "";
    default: return true;
  }
}

function matchesFilter(
  row: PageRow,
  filter: FilterRule,
  allValues: PropValRow[],
  properties: PropertyDefinitionRow[],
): boolean {
  const { propertyId, operator, value } = filter;

  if (propertyId === null) {
    return matchesTextOp(row.title ?? "", operator, value);
  }

  const pv = allValues.find(
    (v) => v.pageId === row.id && v.propertyDefinitionId === propertyId,
  );

  if (operator === "is_empty") return !pv || isPropValueEmpty(pv.value);
  if (operator === "is_not_empty") return !!pv && !isPropValueEmpty(pv.value);
  if (!pv) return false;

  const val = pv.value;
  switch (val.tag) {
    case "Text": case "Url":
      return matchesTextOp(val.value as string, operator, value);
    case "Number": {
      const n = parseFloat(value);
      if (isNaN(n)) return true;
      const v2 = val.value as number;
      if (operator === "equals") return v2 === n;
      if (operator === "not_equals") return v2 !== n;
      if (operator === "gt") return v2 > n;
      if (operator === "gte") return v2 >= n;
      if (operator === "lt") return v2 < n;
      if (operator === "lte") return v2 <= n;
      return true;
    }
    case "Select":
      if (operator === "is") return (val.value as string) === value;
      if (operator === "is_not") return (val.value as string) !== value;
      return true;
    case "MultiSelect":
      if (operator === "contains") return (val.value as string[]).includes(value);
      if (operator === "does_not_contain") return !(val.value as string[]).includes(value);
      return true;
    case "Checkbox":
      if (operator === "checked") return val.value === true;
      if (operator === "unchecked") return val.value === false;
      return true;
    case "Date": {
      const inputTs = new Date(value).getTime();
      if (isNaN(inputTs)) return true;
      const rowTs = Number(val.value as bigint);
      if (operator === "before") return rowTs < inputTs;
      if (operator === "after") return rowTs > inputTs;
      if (operator === "on")
        return new Date(rowTs).toDateString() === new Date(inputTs).toDateString();
      return true;
    }
    case "Relation": {
      const linked = val.value as bigint[];
      if (operator === "contains") return linked.some((id) => String(id) === value);
      if (operator === "does_not_contain") return !linked.some((id) => String(id) === value);
      return true;
    }
    default: return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

interface GridViewProps {
  page: PageRow;
}

export function GridView({ page }: GridViewProps) {
  const { schema, isReady: schemaReady } = useDatabaseSchema(page.id);
  const properties = usePropertyDefinitions(schema?.id ?? BigInt(0));
  const { children: rows } = useChildPages(page.id);

  const createPage = useCreatePage();
  const addProperty = useAddProperty();
  const createSchema = useCreateDatabaseSchema();
  const createView = useCreateView();

  const [selectedRow, setSelectedRow] = useState<PageRow | null>(null);

  // Two-phase seed for brand-new databases.
  // Phase 1: detect no schema → create schema + view.
  // Phase 2: schema arrives in subscription → add 3 columns + 3 rows.
  const seedingRef = useRef<"idle" | "schema-pending" | "done">("idle");

  useEffect(() => {
    if (!schemaReady || schema || seedingRef.current !== "idle") return;
    seedingRef.current = "schema-pending";
    createSchema({ pageId: page.id, name: page.title });
    createView({
      pageId: page.id,
      name: "Default Grid",
      viewType: { tag: "Grid" },
      ownerIdentity: undefined,
    });
  }, [schemaReady, schema]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (seedingRef.current !== "schema-pending" || !schema) return;
    seedingRef.current = "done";
    const sid = schema.id;
    addProperty({ schemaId: sid, name: "Name",   propertyType: { tag: "Text" },   config: "{}" });
    addProperty({ schemaId: sid, name: "Tags",   propertyType: { tag: "Select" }, config: '{"options":["Todo","In Progress","Done"]}' });
    addProperty({ schemaId: sid, name: "Notes",  propertyType: { tag: "Text" },   config: "{}" });
    createPage({ parentId: page.id, pageType: { tag: "Doc" }, title: "Untitled" });
    createPage({ parentId: page.id, pageType: { tag: "Doc" }, title: "Untitled" });
    createPage({ parentId: page.id, pageType: { tag: "Doc" }, title: "Untitled" });
  }, [schema]); // eslint-disable-line react-hooks/exhaustive-deps

  // Add-column wizard state
  const [addStep, setAddStep] = useState<"idle" | "pick-type" | "name" | "relation-target">("idle");
  const [pendingType, setPendingType] = useState<PropertyTypeTag>("Text");
  const [newPropName, setNewPropName] = useState("");
  const [relationTargetId, setRelationTargetId] = useState<bigint | null>(null);
  const addAnchorRef = useRef<HTMLButtonElement>(null);

  // All Database pages for Relation target picker
  const [allPages] = useTable(tables.page);
  const databasePages = allPages.filter(
    (p) => p.pageType.tag === "Database" && !p.deletedAt && p.id !== page.id
  );

  // ── Filtering ───────────────────────────────────────────────────────────────
  const [allPropertyValues] = useTable(tables.page_property_value);
  const [activeFilters, setActiveFilters] = useState<FilterRule[]>([]);
  const [filterBarOpen, setFilterBarOpen] = useState(false);

  const filteredRows = useMemo(() => {
    if (activeFilters.length === 0) return rows;
    return rows.filter((row) =>
      activeFilters.every((f) => matchesFilter(row, f, allPropertyValues as unknown as PropValRow[], properties)),
    );
  }, [rows, activeFilters, allPropertyValues, properties]);

  function addFilter() {
    const firstProp = properties[0] ?? null;
    const propId = firstProp ? firstProp.id : null;
    const ops = propId ? opsForType(firstProp!.propertyType.tag) : TITLE_OPS;
    setActiveFilters((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, propertyId: propId, operator: ops[0], value: "" },
    ]);
  }

  function removeFilter(id: string) {
    setActiveFilters((prev) => prev.filter((f) => f.id !== id));
  }

  function updateFilter(id: string, changes: Partial<FilterRule>) {
    setActiveFilters((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const updated = { ...f, ...changes };
        if ("propertyId" in changes) {
          const prop = properties.find((p) => p.id === changes.propertyId);
          const ops = prop ? opsForType(prop.propertyType.tag) : TITLE_OPS;
          updated.operator = ops[0];
          updated.value = "";
        }
        if ("operator" in changes && changes.operator && !needsValueInput(changes.operator)) {
          updated.value = "";
        }
        return updated;
      }),
    );
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Sorting ─────────────────────────────────────────────────────────────────
  const [activeSort, setActiveSort] = useState<SortRule[]>([]);
  const [sortBarOpen, setSortBarOpen] = useState(false);

  const sortedRows = useMemo(() => {
    if (activeSort.length === 0) return filteredRows;
    return [...filteredRows].sort((a, b) => {
      for (const rule of activeSort) {
        const cmp = compareForSort(a, b, rule, allPropertyValues as unknown as PropValRow[]);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }, [filteredRows, activeSort, allPropertyValues]);

  function addSort() {
    const firstProp = properties[0] ?? null;
    setActiveSort((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, propertyId: firstProp?.id ?? null, direction: "asc" },
    ]);
  }

  function removeSort(id: string) {
    setActiveSort((prev) => prev.filter((s) => s.id !== id));
  }

  function updateSort(id: string, changes: Partial<SortRule>) {
    setActiveSort((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)));
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Cell selection ──────────────────────────────────────────────────────────
  // Key format: `${rowId}|${propDefinitionId}` (both as decimal strings)
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const setPropertyValue = useSetPropertyValue();
  const deletePage = useDeletePage();
  const clearPropertyValue = useClearPropertyValue();

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  function cellKey(rowId: bigint, propId: bigint) {
    return `${rowId}|${propId}`;
  }

  function handleCellClick(rowId: bigint, propId: bigint, e: React.MouseEvent) {
    const key = cellKey(rowId, propId);
    if (e.metaKey || e.ctrlKey) {
      // Toggle the cell in/out of the selection
      setSelectedCells((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    } else {
      // Single-cell selection (replaces any existing selection)
      setSelectedCells(new Set([key]));
    }
  }

  function clearSelectedCells() {
    for (const key of selectedCells) {
      const [rowIdStr, propIdStr] = key.split("|");
      const propId = BigInt(propIdStr);
      const prop = properties.find((p) => p.id === propId);
      if (!prop) continue;
      setPropertyValue({
        pageId: BigInt(rowIdStr),
        propertyDefinitionId: propId,
        value: emptyPropertyValue(prop.propertyType.tag),
      });
    }
    setSelectedCells(new Set());
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't intercept while the user is typing inside an input / textarea / editor
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) return;

      if (e.key === "Escape") {
        setSelectedCells(new Set());
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedCells.size > 0) {
        e.preventDefault();
        clearSelectedCells();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedCells]); // eslint-disable-line react-hooks/exhaustive-deps
  // ────────────────────────────────────────────────────────────────────────────

  async function ensureSchemaAndView() {
    if (!schema) {
      await createSchema({ pageId: page.id, name: page.title });
      await createView({
        pageId: page.id,
        name: "Default Grid",
        viewType: { tag: "Grid" },
        ownerIdentity: undefined,
      });
    }
  }

  async function handleAddRow() {
    await ensureSchemaAndView();
    await createPage({
      parentId: page.id,
      pageType: { tag: "Doc" },
      title: "Untitled",
    });
  }

  function startAddProperty() {
    setAddStep("pick-type");
  }

  function onTypePicked(tag: PropertyTypeTag) {
    setPendingType(tag);
    setNewPropName("");
    setRelationTargetId(null);
    setAddStep("name");
  }

  async function commitAddProperty() {
    const name = newPropName.trim();
    if (!name) {
      setAddStep("idle");
      return;
    }

    // Schema must exist before adding a property. If it doesn't yet, bail —
    // the seeding useEffect will create it and the user can retry.
    if (!schema) {
      setAddStep("idle");
      return;
    }

    let config = "{}";
    if (pendingType === "Relation" && relationTargetId) {
      config = JSON.stringify({ targetPageId: String(relationTargetId) });
    }

    await addProperty({
      schemaId: schema.id,
      name,
      propertyType: { tag: pendingType },
      config,
    });
    setAddStep("idle");
    setNewPropName("");
  }

  function cancelAdd() {
    setAddStep("idle");
    setNewPropName("");
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* Grid toolbar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <button
          onClick={() => setFilterBarOpen((prev) => !prev)}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
            filterBarOpen || activeFilters.length > 0
              ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
              : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <path d="M1 2.5h10M3 6h6M5 9.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Filter
          {activeFilters.length > 0 && (
            <span className="bg-blue-500 text-white text-[10px] font-medium rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
              {activeFilters.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setSortBarOpen((prev) => !prev)}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${
            sortBarOpen || activeSort.length > 0
              ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
              : "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <path d="M2 2h8M2 5.5h5.5M2 9h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Sort
          {activeSort.length > 0 && (
            <span className="bg-blue-500 text-white text-[10px] font-medium rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
              {activeSort.length}
            </span>
          )}
        </button>
      </div>

      {/* Filter bar (collapsible) */}
      {filterBarOpen && (
        <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/30 flex flex-col gap-1.5 shrink-0">
          {activeFilters.map((filter, i) => (
            <FilterRuleRow
              key={filter.id}
              filter={filter}
              properties={properties}
              isFirst={i === 0}
              onChange={(changes) => updateFilter(filter.id, changes)}
              onRemove={() => removeFilter(filter.id)}
            />
          ))}
          <button
            onClick={addFilter}
            className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 self-start transition-colors pl-10"
          >
            + Add filter
          </button>
        </div>
      )}

      {/* Sort bar (collapsible) */}
      {sortBarOpen && (
        <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/30 flex flex-col gap-1.5 shrink-0">
          {activeSort.map((rule, i) => (
            <SortRuleRow
              key={rule.id}
              rule={rule}
              properties={properties}
              isFirst={i === 0}
              onChange={(changes) => updateSort(rule.id, changes)}
              onRemove={() => removeSort(rule.id)}
            />
          ))}
          <button
            onClick={addSort}
            className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 self-start transition-colors pl-10"
          >
            + Add sort
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th className="text-left px-3 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wider w-56 border-r border-neutral-200 dark:border-neutral-800">
                Name
              </th>
              {properties.map((prop) => (
                <ColumnHeader
                  key={String(prop.id)}
                  prop={prop}
                  schemaId={schema?.id ?? BigInt(0)}
                  databasePages={databasePages}
                />
              ))}
              <th className="px-3 py-2 w-10">
                <button
                  ref={addAnchorRef}
                  onClick={startAddProperty}
                  className="text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300 text-lg leading-none transition-colors"
                  title="Add property"
                >
                  +
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 && (
              <tr>
                <td
                  colSpan={properties.length + 2}
                  className="px-3 py-6 text-center text-neutral-400 dark:text-neutral-600 text-sm italic"
                >
                  {rows.length === 0
                    ? "No rows yet — click below to add one"
                    : "No rows match the active filters"}
                </td>
              </tr>
            )}
            {sortedRows.map((row) => (
              <GridRow
                key={String(row.id)}
                row={row}
                properties={properties}
                selectedCells={selectedCells}
                onCellClick={handleCellClick}
                onOpenRow={(r) => {
                  setSelectedCells(new Set());
                  setSelectedRow(r);
                }}
                onRowContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      {
                        label: "Move to trash",
                        onClick: () => deletePage({ pageId: row.id }),
                        destructive: true,
                      },
                    ],
                  });
                }}
                onCellContextMenu={(e, propId) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const prop = properties.find((p) => p.id === propId);
                  if (!prop) return;
                  setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      {
                        label: "Move to trash",
                        onClick: () => deletePage({ pageId: row.id }),
                        destructive: true,
                      },
                      {
                        label: "Clear",
                        onClick: () =>
                          clearPropertyValue({
                            pageId: row.id,
                            propertyDefinitionId: propId,
                          }),
                      },
                    ],
                  });
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2">
        <button
          onClick={handleAddRow}
          className="text-sm text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200 transition-colors"
        >
          + New row
        </button>
      </div>

      {selectedRow && (
        <RowDetailModal
          page={selectedRow}
          parentPage={page}
          onClose={() => setSelectedRow(null)}
        />
      )}

      {/* Add-column wizard — portal-based so it escapes overflow-auto */}
      {addStep === "pick-type" && (
        <FloatingPopup
          anchorRef={addAnchorRef}
          onClose={cancelAdd}
          className="w-44 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <PropertyTypePicker onSelect={onTypePicked} />
        </FloatingPopup>
      )}

      {addStep === "name" && (
        <FloatingPopup
          anchorRef={addAnchorRef}
          onClose={cancelAdd}
          className="w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl p-3"
        >
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-1.5 font-medium">
            {pendingType} property name
          </div>
          <input
            autoFocus
            className="w-full bg-neutral-100 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-white px-2 py-1 rounded outline-none border border-blue-500/60"
            placeholder="Property name…"
            value={newPropName}
            onChange={(e) => setNewPropName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                pendingType === "Relation" ? setAddStep("relation-target") : commitAddProperty();
              }
            }}
          />
          <div className="flex gap-2 mt-2">
            <button
              className="flex-1 text-xs py-1 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600"
              onClick={cancelAdd}
            >
              Cancel
            </button>
            <button
              className="flex-1 text-xs py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40"
              disabled={!newPropName.trim()}
              onClick={() =>
                pendingType === "Relation" ? setAddStep("relation-target") : commitAddProperty()
              }
            >
              {pendingType === "Relation" ? "Next →" : "Add"}
            </button>
          </div>
        </FloatingPopup>
      )}

      {addStep === "relation-target" && (
        <FloatingPopup
          anchorRef={addAnchorRef}
          onClose={cancelAdd}
          className="w-64 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl p-3"
        >
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-1.5 font-medium">
            Link to database
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {databasePages.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-600 italic py-2">
                No other databases found
              </p>
            ) : (
              databasePages.map((db) => (
                <button
                  key={String(db.id)}
                  className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors ${
                    relationTargetId === db.id
                      ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200"
                      : "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  }`}
                  onClick={() =>
                    setRelationTargetId(relationTargetId === db.id ? null : db.id)
                  }
                >
                  {db.title || "Untitled"}
                </button>
              ))
            )}
          </div>
          <div className="flex gap-2 mt-2 border-t border-neutral-100 dark:border-neutral-700 pt-2">
            <button
              className="flex-1 text-xs py-1 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600"
              onClick={() => setAddStep("name")}
            >
              ← Back
            </button>
            <button
              className="flex-1 text-xs py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40"
              disabled={!relationTargetId}
              onClick={commitAddProperty}
            >
              Add
            </button>
          </div>
        </FloatingPopup>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ————————————————— Column header with context menu —————————————————

function ColumnHeader({
  prop,
  schemaId: _schemaId,
  databasePages,
}: {
  prop: NonNullable<PropertyDefinitionRow>;
  schemaId: bigint;
  databasePages: { id: bigint; title: string; deletedAt: unknown }[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<"idle" | "rename" | "change-type" | "relation-target">("idle");
  const [renameValue, setRenameValue] = useState(prop.name);
  const [relTargetId, setRelTargetId] = useState<bigint | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const deleteProperty = useDeleteProperty();
  const renameProperty = useRenameProperty();
  const updatePropertyType = useUpdatePropertyType();
  const updatePropertyConfig = useUpdatePropertyConfig();

  function closeMenu() {
    setMenuOpen(false);
    setMode("idle");
    setRenameValue(prop.name);
    setRelTargetId(null);
  }

  async function commitRename() {
    const name = renameValue.trim();
    if (name && name !== prop.name) {
      await renameProperty({ propertyDefinitionId: prop.id, name });
    }
    closeMenu();
  }

  async function handleChangeType(tag: PropertyTypeTag) {
    if (tag === "Relation") {
      setRelTargetId(null);
      setMode("relation-target");
      return;
    }
    await updatePropertyType({
      propertyDefinitionId: prop.id,
      propertyType: { tag },
    });
    closeMenu();
  }

  async function commitRelationTarget() {
    if (!relTargetId) return;
    await updatePropertyType({
      propertyDefinitionId: prop.id,
      propertyType: { tag: "Relation" },
    });
    await updatePropertyConfig({
      propertyDefinitionId: prop.id,
      config: JSON.stringify({ targetPageId: String(relTargetId) }),
    });
    closeMenu();
  }

  async function handleDelete() {
    await deleteProperty({ propertyDefinitionId: prop.id });
    closeMenu();
  }

  return (
    <th className="text-left px-3 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wider min-w-32 border-r border-neutral-200 dark:border-neutral-800">
      {mode === "rename" ? (
        <input
          autoFocus
          className="bg-neutral-100 dark:bg-neutral-700 text-neutral-900 dark:text-white text-xs px-1.5 py-0.5 rounded outline-none border border-blue-500/60 w-full"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") closeMenu();
          }}
        />
      ) : (
        <button
          ref={buttonRef}
          className="flex items-center gap-1 w-full text-left hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
          onClick={() => setMenuOpen(true)}
        >
          <PropertyTypeIcon type={prop.propertyType.tag} />
          {prop.name}
        </button>
      )}

      {menuOpen && mode === "idle" && (
        <FloatingPopup
          anchorRef={buttonRef}
          onClose={closeMenu}
          className="w-40 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            onClick={() => {
              setMenuOpen(false);
              setMode("rename");
            }}
          >
            Rename
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            onClick={() => {
              setMenuOpen(false);
              setMode("change-type");
            }}
          >
            Change type
          </button>
          <div className="border-t border-neutral-100 dark:border-neutral-700" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
            onClick={handleDelete}
          >
            Delete
          </button>
        </FloatingPopup>
      )}

      {mode === "change-type" && (
        <FloatingPopup
          anchorRef={buttonRef}
          onClose={closeMenu}
          className="w-44 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <PropertyTypePicker onSelect={handleChangeType} />
        </FloatingPopup>
      )}

      {mode === "relation-target" && (
        <FloatingPopup
          anchorRef={buttonRef}
          onClose={closeMenu}
          className="w-64 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl p-3"
        >
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-1.5 font-medium">
            Link to database
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {databasePages.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-600 italic py-2">
                No other databases found
              </p>
            ) : (
              databasePages.map((db) => (
                <button
                  key={String(db.id)}
                  className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors ${
                    relTargetId === db.id
                      ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200"
                      : "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  }`}
                  onClick={() => setRelTargetId(relTargetId === db.id ? null : db.id)}
                >
                  {db.title || "Untitled"}
                </button>
              ))
            )}
          </div>
          <div className="flex gap-2 mt-2 border-t border-neutral-100 dark:border-neutral-700 pt-2">
            <button
              className="flex-1 text-xs py-1 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600"
              onClick={() => setMode("change-type")}
            >
              ← Back
            </button>
            <button
              className="flex-1 text-xs py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40"
              disabled={!relTargetId}
              onClick={commitRelationTarget}
            >
              Save
            </button>
          </div>
        </FloatingPopup>
      )}
    </th>
  );
}

// ————————————————— Grid row —————————————————

function GridRow({
  row,
  properties,
  selectedCells,
  onCellClick,
  onOpenRow,
  onRowContextMenu,
  onCellContextMenu,
}: {
  row: PageRow;
  properties: ReturnType<typeof usePropertyDefinitions>;
  selectedCells: Set<string>;
  onCellClick: (rowId: bigint, propId: bigint, e: React.MouseEvent) => void;
  onOpenRow: (p: PageRow) => void;
  onRowContextMenu?: (e: React.MouseEvent) => void;
  onCellContextMenu?: (e: React.MouseEvent, propId: bigint) => void;
}) {
  const values = usePagePropertyValues(row.id);

  return (
    <tr className="border-b border-neutral-200/60 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-900/40 group">
      <td
        className="px-3 py-0 h-9 border-r border-neutral-200 dark:border-neutral-800"
        onContextMenu={onRowContextMenu}
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onOpenRow(row)}
            className="text-sm text-neutral-800 dark:text-neutral-200 hover:text-neutral-900 dark:hover:text-white hover:underline truncate max-w-52"
          >
            {row.title || "Untitled"}
          </button>
          <button
            onClick={() => onOpenRow(row)}
            className="opacity-0 group-hover:opacity-100 text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-all"
            title="Open"
          >
            ↗
          </button>
        </div>
      </td>
      {properties.map((prop) => {
        const val = values.find((v) => v.propertyDefinitionId === prop.id);
        const isSelected = selectedCells.has(`${row.id}|${prop.id}`);
        return (
          <td
            key={String(prop.id)}
            className={`px-0 py-0 h-9 border-r border-neutral-200 dark:border-neutral-800 relative select-none ${
              isSelected
                ? "shadow-[inset_0_0_0_2px_#3b82f6] bg-blue-50/40 dark:bg-blue-900/20"
                : ""
            }`}
            onClick={(e) => onCellClick(row.id, prop.id, e)}
            onContextMenu={(e) => onCellContextMenu?.(e, prop.id)}
          >
            <PropertyCell
              pageId={row.id}
              definition={prop}
              value={val?.value}
            />
          </td>
        );
      })}
      <td />
    </tr>
  );
}

// Returns the "cleared" value for a given property type tag.
// BigInt(0) is falsy in JS so DateCell treats it as "no date".
function emptyPropertyValue(tag: string) {
  switch (tag) {
    case "Number":      return { tag: "Number" as const, value: 0 };
    case "Checkbox":    return { tag: "Checkbox" as const, value: false };
    case "Select":      return { tag: "Select" as const, value: "" };
    case "MultiSelect": return { tag: "MultiSelect" as const, value: [] as string[] };
    case "Relation":    return { tag: "Relation" as const, value: [] as bigint[] };
    case "Date":        return { tag: "Date" as const, value: BigInt(0) };
    case "Url":         return { tag: "Url" as const, value: "" };
    default:            return { tag: "Text" as const, value: "" };
  }
}

// ────────────────────────── Sort rule row ────────────────────────────────────

function SortRuleRow({
  rule,
  properties,
  isFirst,
  onChange,
  onRemove,
}: {
  rule: SortRule;
  properties: PropertyDefinitionRow[];
  isFirst: boolean;
  onChange: (changes: Partial<SortRule>) => void;
  onRemove: () => void;
}) {
  const selectCls =
    "bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 px-2 py-1 rounded text-xs border-0 outline-none cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-neutral-400 dark:text-neutral-500 w-10 text-right shrink-0 font-medium">
        {isFirst ? "Sort by" : "Then by"}
      </span>

      {/* Column picker */}
      <select
        value={rule.propertyId === null ? "__title__" : String(rule.propertyId)}
        onChange={(e) => {
          const v = e.target.value;
          onChange({ propertyId: v === "__title__" ? null : BigInt(v) });
        }}
        className={selectCls}
      >
        <option value="__title__">Name</option>
        {properties.map((p) => (
          <option key={String(p.id)} value={String(p.id)}>
            {p.name}
          </option>
        ))}
      </select>

      {/* Direction toggle */}
      <button
        onClick={() => onChange({ direction: rule.direction === "asc" ? "desc" : "asc" })}
        className="flex items-center gap-1 bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 px-2 py-1 rounded text-xs hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors"
        title="Toggle sort direction"
      >
        {rule.direction === "asc" ? (
          <>↑ <span>A → Z</span></>
        ) : (
          <>↓ <span>Z → A</span></>
        )}
      </button>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors ml-1 shrink-0 text-base leading-none"
        title="Remove sort"
      >
        ×
      </button>
    </div>
  );
}

// ────────────────────────── Filter rule row ──────────────────────────────────

function FilterRuleRow({
  filter,
  properties,
  isFirst,
  onChange,
  onRemove,
}: {
  filter: FilterRule;
  properties: PropertyDefinitionRow[];
  isFirst: boolean;
  onChange: (changes: Partial<FilterRule>) => void;
  onRemove: () => void;
}) {
  const currentProp = filter.propertyId !== null
    ? properties.find((p) => p.id === filter.propertyId)
    : null;
  const propType = currentProp?.propertyType.tag ?? "Text";
  const ops = filter.propertyId === null ? TITLE_OPS : opsForType(propType);
  const showValue = needsValueInput(filter.operator);

  const selectCls =
    "bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 px-2 py-1 rounded text-xs border-0 outline-none cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-neutral-400 dark:text-neutral-500 w-10 text-right shrink-0 font-medium">
        {isFirst ? "Where" : "And"}
      </span>

      {/* Column picker */}
      <select
        value={filter.propertyId === null ? "__title__" : String(filter.propertyId)}
        onChange={(e) => {
          const v = e.target.value;
          onChange({ propertyId: v === "__title__" ? null : BigInt(v) });
        }}
        className={selectCls}
      >
        <option value="__title__">Name</option>
        {properties.map((p) => (
          <option key={String(p.id)} value={String(p.id)}>
            {p.name}
          </option>
        ))}
      </select>

      {/* Operator picker */}
      <select
        value={filter.operator}
        onChange={(e) => onChange({ operator: e.target.value as FilterOperator })}
        className={selectCls}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>

      {/* Value input — adapts to property type */}
      {showValue && (
        <FilterValueInput
          propType={propType}
          propConfig={currentProp?.config ?? "{}"}
          operator={filter.operator}
          value={filter.value}
          onChange={(v) => onChange({ value: v })}
        />
      )}

      {/* Remove */}
      <button
        onClick={onRemove}
        className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors ml-1 shrink-0 text-base leading-none"
        title="Remove filter"
      >
        ×
      </button>
    </div>
  );
}

// ────────────────────────── Filter value input ───────────────────────────────

function FilterValueInput({
  propType,
  propConfig,
  operator,
  value,
  onChange,
}: {
  propType: string;
  propConfig: string;
  operator: FilterOperator;
  value: string;
  onChange: (v: string) => void;
}) {
  const sharedCls =
    "bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 px-2 py-1 rounded text-xs outline-none border border-transparent focus:border-blue-500/60 min-w-0 transition-colors";

  // Relation — enumerate actual pages from the target database
  const [allPages] = useTable(tables.page);
  if (
    propType === "Relation" &&
    (operator === "contains" || operator === "does_not_contain")
  ) {
    const targetPageId = (() => {
      try {
        const cfg = parseConfig(propConfig);
        return cfg.targetPageId ? BigInt(cfg.targetPageId as string) : null;
      } catch { return null; }
    })();
    const targetPages = targetPageId
      ? allPages.filter((p) => p.parentId === targetPageId && !p.deletedAt)
      : [];
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${sharedCls} cursor-pointer w-40`}
      >
        <option value="">Pick a page…</option>
        {targetPages.map((p) => (
          <option key={String(p.id)} value={String(p.id)}>
            {p.title || "Untitled"}
          </option>
        ))}
      </select>
    );
  }

  // Select / MultiSelect — show the field's own options as a dropdown
  if (
    (propType === "Select" || propType === "MultiSelect") &&
    (operator === "is" || operator === "is_not" || operator === "contains" || operator === "does_not_contain")
  ) {
    const options = configOptions(propConfig);
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${sharedCls} cursor-pointer w-36`}
      >
        <option value="">Pick an option…</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  // Number
  if (propType === "Number") {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Value…"
        className={`${sharedCls} w-24`}
      />
    );
  }

  // Date
  if (propType === "Date") {
    return (
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${sharedCls} w-36`}
      />
    );
  }

  // Default: plain text
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value…"
      className={`${sharedCls} w-32`}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function PropertyTypeIcon({ type }: { type: string }) {
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
    <span className="text-neutral-400 dark:text-neutral-600 font-mono text-xs">
      {icons[type] ?? "?"}
    </span>
  );
}
