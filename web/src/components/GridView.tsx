"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTable, useSpacetimeDB } from "spacetimedb/react";
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
  useDatabaseViews,
  usePropertyDefinitions,
  usePagePropertyValues,
  useClearPropertyValue,
  useDeleteProperty,
  useReorderProperty,
  useRenameProperty,
  useUpdatePropertyType,
  useUpdatePropertyConfig,
  useUpdateViewConfig,
  useUpdateDatabaseSchemaConfig,
} from "@/src/hooks/useDatabase";
import type { PropertyDefinitionRow } from "@/src/hooks/useDatabase";
import { PropertyCell } from "./PropertyCell";
import {
  buildSiblingValues,
  parseSelectConfig,
  serializeSelectConfig,
  parseOptionFormula,
  getOptionColorClass,
  COLOR_KEYS,
  OPTION_CHIP_CLASSES,
  SWATCH_BG_CLASSES,
  type SelectOptionCondition,
  type OptionColorKey,
} from "@/src/lib/formulaEval";
import {
  getDefaultExpr,
  mergeDefaultIntoConfig,
  getFormulaHints,
  resolveDefault,
} from "@/src/lib/propertyDefaults";
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

// ─── View config (column widths) ──────────────────────────────────────────────

const NAME_COL_KEY = "__name";
const DEFAULT_NAME_WIDTH = 224;  // w-56
const DEFAULT_COL_WIDTH  = 160;
const MIN_COL_WIDTH      = 60;

interface ViewConfig {
  columnWidths?: Record<string, number>;
}
function parseViewConfig(raw: string): ViewConfig {
  try { return JSON.parse(raw) as ViewConfig; } catch { return {}; }
}
function serializeViewConfig(cfg: ViewConfig): string {
  return JSON.stringify(cfg);
}

// ─────────────────────────────────────────────────────────────────────────────

interface GridViewProps {
  page: PageRow;
}

export function GridView({ page }: GridViewProps) {
  const { schema, isReady: schemaReady } = useDatabaseSchema(page.id);
  const properties = usePropertyDefinitions(schema?.id ?? BigInt(0));
  const { children: rows } = useChildPages(page.id);
  const { views } = useDatabaseViews(page.id);
  const view = views[0] ?? null;
  const { identity } = useSpacetimeDB();

  const createPage = useCreatePage();
  const addProperty = useAddProperty();
  const createSchema = useCreateDatabaseSchema();
  const createView = useCreateView();
  const updateViewConfig = useUpdateViewConfig();
  const updateSchemaConfig = useUpdateDatabaseSchemaConfig();

  // Name column default
  const [nameDefaultOpen, setNameDefaultOpen] = useState(false);
  const [nameDefaultDraft, setNameDefaultDraft] = useState("");
  const nameColRef = useRef<HTMLTableCellElement>(null);
  const currentNameDefault = schema?.config ? getDefaultExpr(schema.config) : null;

  // ── Column widths ───────────────────────────────────────────────────────────
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;
  const viewRef = useRef(view);
  viewRef.current = view;
  const updateViewConfigRef = useRef(updateViewConfig);
  updateViewConfigRef.current = updateViewConfig;

  // Hydrate widths from persisted view config whenever the view first arrives
  useEffect(() => {
    if (!view?.config) return;
    const parsed = parseViewConfig(view.config);
    if (parsed.columnWidths) setColWidths(parsed.columnWidths);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.id]);

  // Stable drag state lives in a ref so mouse handlers don't go stale
  const dragRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  function startColResize(key: string, clientX: number, currentWidth: number) {
    dragRef.current = { key, startX: clientX, startWidth: currentWidth };
    setIsResizing(true);
  }

  function saveColWidths(widths: Record<string, number>) {
    const v = viewRef.current;
    if (!v) return;
    const existing = parseViewConfig(v.config);
    updateViewConfigRef.current({
      viewId: v.id,
      config: serializeViewConfig({ ...existing, columnWidths: widths }),
    });
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const { key, startX, startWidth } = dragRef.current;
      const next = Math.max(MIN_COL_WIDTH, startWidth + e.clientX - startX);
      setColWidths((prev) => ({ ...prev, [key]: next }));
    }
    function onMouseUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      setIsResizing(false);
      saveColWidths(colWidthsRef.current);
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Table ref for auto-fit measurement
  const tableRef = useRef<HTMLTableElement>(null);

  function autoFitColumn(key: string) {
    if (!tableRef.current) return;
    const dp = localPropOrderRef.current
      ? localPropOrderRef.current
          .map((id) => propertiesRef.current.find((p) => p.id === id))
          .filter(Boolean)
      : propertiesRef.current;
    const allKeys = [NAME_COL_KEY, ...dp.map((p) => String(p!.id))];
    const colIdx = allKeys.indexOf(key);
    if (colIdx < 0) return;
    const cells = tableRef.current.querySelectorAll<HTMLElement>(
      `tr > :nth-child(${colIdx + 1})`
    );
    let maxW = MIN_COL_WIDTH;
    cells.forEach((cell) => { maxW = Math.max(maxW, cell.scrollWidth); });
    const next = { ...colWidthsRef.current, [key]: maxW };
    setColWidths(next);
    saveColWidths(next);
  }

  // ── Column reorder ──────────────────────────────────────────────────────────
  const reorderProperty = useReorderProperty();
  const propertiesRef = useRef(properties);
  propertiesRef.current = properties;

  const [localPropOrder, setLocalPropOrder] = useState<bigint[] | null>(null);
  const localPropOrderRef = useRef(localPropOrder);
  localPropOrderRef.current = localPropOrder;

  const displayProperties = useMemo(() => {
    if (!localPropOrder) return properties;
    return localPropOrder
      .map((id) => properties.find((p) => p.id === id))
      .filter((p): p is NonNullable<PropertyDefinitionRow> => p != null);
  }, [localPropOrder, properties]);

  const [draggingColKey, setDraggingColKey] = useState<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);

  const colDragRef = useRef<{
    key: string;
    fromIdx: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);

  function computeDragOverIdx(clientX: number): number {
    if (!tableRef.current) return 0;
    const dp = localPropOrderRef.current
      ? localPropOrderRef.current
          .map((id) => propertiesRef.current.find((p) => p.id === id))
          .filter(Boolean)
      : propertiesRef.current;
    const rect = tableRef.current.getBoundingClientRect();
    let x = rect.left + (colWidthsRef.current[NAME_COL_KEY] ?? DEFAULT_NAME_WIDTH);
    for (let i = 0; i < dp.length; i++) {
      const pw = colWidthsRef.current[String(dp[i]!.id)] ?? DEFAULT_COL_WIDTH;
      if (clientX < x + pw / 2) return i;
      x += pw;
    }
    return dp.length;
  }

  function startColDrag(key: string, fromIdx: number, clientX: number, clientY: number) {
    colDragRef.current = { key, fromIdx, startX: clientX, startY: clientY, started: false };
  }

  // Delegating-ref pattern: always calls the freshest closure
  const colDragHandlersRef = useRef({ onMouseMove: (_e: MouseEvent) => {}, onMouseUp: (_e: MouseEvent) => {} });
  colDragHandlersRef.current = {
    onMouseMove(e: MouseEvent) {
      if (!colDragRef.current) return;
      const { startX, startY, key } = colDragRef.current;
      if (!colDragRef.current.started) {
        if (Math.abs(e.clientX - startX) < 5 && Math.abs(e.clientY - startY) < 5) return;
        colDragRef.current.started = true;
        setDraggingColKey(key);
        setLocalPropOrder(propertiesRef.current.map((p) => p.id));
      }
      setGhostPos({ x: e.clientX, y: e.clientY });

      // Live reorder: move the column into its new slot as the cursor crosses midpoints
      const fromIdx = colDragRef.current.fromIdx;
      const overIdx = computeDragOverIdx(e.clientX);
      if (overIdx !== fromIdx && overIdx !== fromIdx + 1) {
        const currentOrder = localPropOrderRef.current ?? propertiesRef.current.map((p) => p.id);
        const ids = [...currentOrder];
        const [moved] = ids.splice(fromIdx, 1);
        const insertAt = overIdx > fromIdx ? overIdx - 1 : overIdx;
        ids.splice(insertAt, 0, moved);
        setLocalPropOrder(ids);
        colDragRef.current.fromIdx = insertAt; // track new position synchronously
      }
    },
    onMouseUp(_e: MouseEvent) {
      if (!colDragRef.current) return;
      const { started } = colDragRef.current;
      colDragRef.current = null;
      if (!started) { setLocalPropOrder(null); setDraggingColKey(null); setDragOverIdx(null); setGhostPos(null); return; }
      // Persist whatever order the live drag ended on
      const finalOrder = localPropOrderRef.current;
      if (finalOrder) {
        finalOrder.forEach((id, i) => {
          reorderProperty({ propertyDefinitionId: id, newOrder: i * 1000 });
        });
      }
      setLocalPropOrder(null);
      setDraggingColKey(null);
      setDragOverIdx(null);
      setGhostPos(null);
    },
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => colDragHandlersRef.current.onMouseMove(e);
    const onMouseUp   = (e: MouseEvent) => colDragHandlersRef.current.onMouseUp(e);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup",   onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup",   onMouseUp);
    };
  }, []);

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
  const [newPropDefault, setNewPropDefault] = useState("");
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

  // ── View mode (grid / list) ──────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // ── Row multi-select ────────────────────────────────────────────────────────
  const [selectedRowIds, setSelectedRowIds] = useState<Set<bigint>>(new Set());
  const [lastSelectedRowIdx, setLastSelectedRowIdx] = useState<number | null>(null);

  function toggleRowSelect(rowId: bigint, rowIdx: number, shiftKey: boolean) {
    if (shiftKey && lastSelectedRowIdx !== null) {
      // Range: replace selection with the full span
      const from = Math.min(lastSelectedRowIdx, rowIdx);
      const to   = Math.max(lastSelectedRowIdx, rowIdx);
      setSelectedRowIds(() => {
        const next = new Set<bigint>();
        for (let i = from; i <= to; i++) next.add(sortedRows[i].id);
        return next;
      });
    } else {
      setSelectedRowIds((prev) => {
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
        return next;
      });
      setLastSelectedRowIdx(rowIdx);
    }
  }

  function clearRowSelection() {
    setSelectedRowIds(new Set());
    setLastSelectedRowIdx(null);
  }

  function bulkDeleteRows() {
    for (const id of selectedRowIds) deletePage({ pageId: id });
    clearRowSelection();
  }

  // ── Cell selection & keyboard navigation ────────────────────────────────────
  // Key format: `${rowId}|${propDefinitionId}` (both as decimal strings)
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  // When non-null, the matching PropertyCell starts in edit mode.
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const setPropertyValue = useSetPropertyValue();
  const deletePage = useDeletePage();
  const clearPropertyValue = useClearPropertyValue();

  // ── Fill handle ─────────────────────────────────────────────────────────────
  const [fillSource, setFillSource] = useState<{ rowId: bigint; propId: bigint } | null>(null);
  const [fillTarget, setFillTarget] = useState<bigint | null>(null);
  const isDraggingFillRef = useRef(false);

  const fillRangeCells = useMemo(() => {
    const cells = new Set<string>();
    if (!fillSource || !fillTarget) return cells;
    const sourceIdx = sortedRows.findIndex((r) => r.id === fillSource.rowId);
    const targetIdx = sortedRows.findIndex((r) => r.id === fillTarget);
    if (sourceIdx === -1 || targetIdx === -1) return cells;
    const [start, end] = sourceIdx <= targetIdx ? [sourceIdx, targetIdx] : [targetIdx, sourceIdx];
    for (let i = start; i <= end; i++) {
      cells.add(`${sortedRows[i].id}|${fillSource.propId}`);
    }
    return cells;
  }, [fillSource, fillTarget, sortedRows]);

  function handleFillDragStart(rowId: bigint, propId: bigint) {
    isDraggingFillRef.current = true;
    setFillSource({ rowId, propId });
    setFillTarget(rowId);
  }

  function handleFillDragEnter(rowId: bigint, propId: bigint) {
    if (!isDraggingFillRef.current || !fillSource) return;
    if (propId !== fillSource.propId) return;
    setFillTarget(rowId);
  }

  useEffect(() => {
    function onMouseUp() {
      if (!isDraggingFillRef.current) return;
      isDraggingFillRef.current = false;

      if (fillSource && fillTarget && fillSource.rowId !== fillTarget) {
        const sourceValue = (allPropertyValues as unknown as Array<{ pageId: bigint; propertyDefinitionId: bigint; value: unknown }>)
          .find((v) => v.pageId === fillSource.rowId && v.propertyDefinitionId === fillSource.propId)
          ?.value;

        if (sourceValue) {
          const sourceIdx = sortedRows.findIndex((r) => r.id === fillSource.rowId);
          const targetIdx = sortedRows.findIndex((r) => r.id === fillTarget);
          if (sourceIdx !== -1 && targetIdx !== -1) {
            const [fillStart, fillEnd] = sourceIdx < targetIdx
              ? [sourceIdx + 1, targetIdx]
              : [targetIdx, sourceIdx - 1];
            for (let i = fillStart; i <= fillEnd; i++) {
              setPropertyValue({
                pageId: sortedRows[i].id,
                propertyDefinitionId: fillSource.propId,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                value: sourceValue as any,
              });
            }
            // Expand selection to cover the full filled range
            const newSelected = new Set<string>();
            const [selStart, selEnd] = sourceIdx <= targetIdx ? [sourceIdx, targetIdx] : [targetIdx, sourceIdx];
            for (let i = selStart; i <= selEnd; i++) {
              newSelected.add(`${sortedRows[i].id}|${fillSource.propId}`);
            }
            setSelectedCells(newSelected);
          }
        }
      }

      setFillSource(null);
      setFillTarget(null);
    }

    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillSource, fillTarget, sortedRows, allPropertyValues]);

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

  // ── Navigation helpers ──────────────────────────────────────────────────────

  function navigateFrom(
    fromKey: string,
    dir: "up" | "down" | "left" | "right"
  ): string | null {
    const [rowIdStr, propIdStr] = fromKey.split("|");
    const rowId = BigInt(rowIdStr);
    const propId = BigInt(propIdStr);
    const rowIdx = sortedRows.findIndex((r) => r.id === rowId);
    const propIdx = properties.findIndex((p) => p.id === propId);
    if (rowIdx === -1 || propIdx === -1) return null;

    let newRowIdx = rowIdx;
    let newPropIdx = propIdx;
    if (dir === "up") newRowIdx = Math.max(0, rowIdx - 1);
    else if (dir === "down") newRowIdx = Math.min(sortedRows.length - 1, rowIdx + 1);
    else if (dir === "left") newPropIdx = Math.max(0, propIdx - 1);
    else if (dir === "right") newPropIdx = Math.min(properties.length - 1, propIdx + 1);

    // No movement at boundary — don't wrap
    if (newRowIdx === rowIdx && newPropIdx === propIdx) return null;
    return cellKey(sortedRows[newRowIdx].id, properties[newPropIdx].id);
  }

  // Called by PropertyCell sub-components after Enter / Tab / Escape
  function handleCellNavigate(dir: "down" | "right" | "left" | "escape") {
    const current = [...selectedCells][0];
    setEditingCell(null);
    if (dir === "escape" || !current) return;
    const navDir = dir === "down" ? "down" : dir === "right" ? "right" : "left";
    const next = navigateFrom(current, navDir);
    if (next) setSelectedCells(new Set([next]));
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't intercept while the user is typing inside an input / textarea / editor
      const target = e.target as HTMLElement;
      const isEditing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (e.key === "Escape") {
        if (editingCell) {
          setEditingCell(null);
        } else if (selectedCells.size > 0) {
          setSelectedCells(new Set());
        } else {
          clearRowSelection();
        }
        return;
      }

      // Ctrl/Cmd+A → select all rows
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        setSelectedRowIds(new Set(sortedRows.map((r) => r.id)));
        setLastSelectedRowIdx(sortedRows.length - 1);
        setSelectedCells(new Set());
        return;
      }

      // While a cell is actively editing, let the input handle keys
      if (isEditing) return;

      const single = selectedCells.size === 1 ? [...selectedCells][0] : null;

      // Arrow key navigation (only when not editing)
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && single) {
        e.preventDefault();
        const dir = e.key.slice(5).toLowerCase() as "up" | "down" | "left" | "right";
        const next = navigateFrom(single, dir);
        if (next) setSelectedCells(new Set([next]));
        return;
      }

      // Tab navigation
      if (e.key === "Tab" && single) {
        e.preventDefault();
        const next = navigateFrom(single, e.shiftKey ? "left" : "right");
        if (next) setSelectedCells(new Set([next]));
        return;
      }

      // Enter → start editing the selected cell
      if (e.key === "Enter" && single) {
        e.preventDefault();
        setEditingCell(single);
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedCells.size > 0) {
        e.preventDefault();
        clearSelectedCells();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCells, selectedRowIds, editingCell, sortedRows, properties]);
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

  // Refs so the default-application callback can see the latest values
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const allPropValsRef = useRef(allPropertyValues);
  allPropValsRef.current = allPropertyValues;

  async function handleAddRow() {
    await ensureSchemaAndView();

    const existingRowIds = new Set(rowsRef.current.map((r) => String(r.id)));

    // Resolve name column default from schema config
    let title = "Untitled";
    if (schema?.config) {
      const nameDefault = getDefaultExpr(schema.config);
      if (nameDefault) {
        const userHex = identity?.toHexString() ?? "";
        const existingTitles = rowsRef.current.map((r) => r.title ?? "");
        const resolved = resolveDefault(nameDefault, "Text", {
          userIdentityHex: userHex,
          siblingValues: {},
          existingColumnValues: existingTitles,
          selectOptions: [],
        });
        if (resolved && resolved.tag === "Text") {
          title = resolved.value;
        }
      }
    }

    await createPage({
      parentId: page.id,
      pageType: { tag: "Doc" },
      title,
    });

    const currentProps = propertiesRef.current;
    const propsWithDefaults = currentProps
      .filter((p): p is NonNullable<typeof p> => !!p && !!getDefaultExpr(p.config))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    if (propsWithDefaults.length === 0) return;

    // Poll for the new row to appear in the subscription via ref.
    const newRow = await new Promise<PageRow | null>((resolve) => {
      let attempts = 0;
      const interval = setInterval(() => {
        const found = rowsRef.current.find((r) => !existingRowIds.has(String(r.id)));
        if (found) { clearInterval(interval); resolve(found); }
        if (++attempts > 30) { clearInterval(interval); resolve(null); }
      }, 100);
    });
    if (!newRow) return;

    const userHex = identity?.toHexString() ?? "";
    const siblingValues: Record<string, string> = {};

    for (const prop of propsWithDefaults) {
      const expr = getDefaultExpr(prop.config);
      if (!expr) continue;

      const cfg = parseSelectConfig(prop.config);
      const existingColumnValues: string[] = (allPropValsRef.current as unknown as PropValRow[])
        .filter((pv) => pv.propertyDefinitionId === prop.id)
        .map((pv) => {
          const v = pv.value;
          return v.tag === "Text" || v.tag === "Select" || v.tag === "Url"
            ? (v.value as string) : String(v.value);
        });

      const resolved = resolveDefault(expr, prop.propertyType.tag, {
        userIdentityHex: userHex,
        siblingValues,
        existingColumnValues,
        selectOptions: cfg.options,
      });

      if (resolved) {
        setPropertyValue({
          pageId: newRow.id,
          propertyDefinitionId: prop.id,
          value: resolved,
        });
        if (resolved.tag === "Text" || resolved.tag === "Select" || resolved.tag === "Url") {
          siblingValues[prop.name] = resolved.value as string;
        } else if (resolved.tag === "Number") {
          siblingValues[prop.name] = String(resolved.value);
        } else if (resolved.tag === "Checkbox") {
          siblingValues[prop.name] = String(resolved.value);
        }
      }
    }
  }

  function startAddProperty() {
    setAddStep("pick-type");
  }

  function onTypePicked(tag: PropertyTypeTag) {
    setPendingType(tag);
    setNewPropName("");
    setNewPropDefault("");
    setRelationTargetId(null);
    setAddStep("name");
  }

  async function commitAddProperty() {
    const name = newPropName.trim();
    if (!name) {
      setAddStep("idle");
      return;
    }

    if (!schema) {
      setAddStep("idle");
      return;
    }

    const configObj: Record<string, unknown> = {};
    if (pendingType === "Relation" && relationTargetId) {
      configObj.targetPageId = String(relationTargetId);
    }
    const defaultVal = newPropDefault.trim();
    if (defaultVal) {
      configObj.defaultValue = defaultVal;
    }

    await addProperty({
      schemaId: schema.id,
      name,
      propertyType: { tag: pendingType },
      config: JSON.stringify(configObj),
    });
    setAddStep("idle");
    setNewPropName("");
    setNewPropDefault("");
  }

  function cancelAdd() {
    setAddStep("idle");
    setNewPropName("");
    setNewPropDefault("");
  }

  return (
    <div
      className="flex flex-col"
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* Sticky toolbar: stays pinned while table content scrolls */}
      <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950">
      {/* Grid toolbar */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800">
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

        {/* View mode toggle — right-aligned */}
        <div className="ml-auto flex items-center gap-0.5 bg-neutral-100 dark:bg-neutral-800 rounded p-0.5">
          <button
            onClick={() => setViewMode("grid")}
            title="Grid view"
            className={`p-1 rounded transition-colors ${viewMode === "grid" ? "bg-white dark:bg-neutral-700 shadow-sm text-neutral-700 dark:text-neutral-200" : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"}`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="8" y="1" width="5" height="5" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="1" y="8" width="5" height="5" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
              <rect x="8" y="8" width="5" height="5" rx="0.5" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
          </button>
          <button
            onClick={() => setViewMode("list")}
            title="List view"
            className={`p-1 rounded transition-colors ${viewMode === "list" ? "bg-white dark:bg-neutral-700 shadow-sm text-neutral-700 dark:text-neutral-200" : "text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"}`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 3h12M1 7h12M1 11h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Bulk selection bar */}
      {selectedRowIds.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40">
          <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
            {selectedRowIds.size} row{selectedRowIds.size !== 1 ? "s" : ""} selected
          </span>
          <button
            onClick={bulkDeleteRows}
            className="text-xs px-2 py-0.5 rounded text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={clearRowSelection}
            className="text-xs px-2 py-0.5 rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors ml-auto"
          >
            Clear selection
          </button>
        </div>
      )}

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
        <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/30 flex flex-col gap-1.5">
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
      </div>{/* end sticky toolbar */}

      {viewMode === "list" && (
        <ListView
          rows={sortedRows}
          properties={displayProperties}
          selectedRowIds={selectedRowIds}
          anyRowsSelected={selectedRowIds.size > 0}
          onRowSelect={toggleRowSelect}
          onOpenRow={(r) => { clearRowSelection(); setSelectedRow(r); }}
        />
      )}
      <div className={`overflow-x-auto${viewMode === "list" ? " hidden" : ""}${isResizing || draggingColKey ? " select-none" : ""}${isResizing ? " cursor-col-resize" : ""}${draggingColKey ? " cursor-grabbing" : ""}`}>
        <table
          ref={tableRef}
          className={`border-collapse text-sm${fillSource ? " cursor-nwse-resize select-none" : ""}`}
          style={{
            tableLayout: "fixed",
            width:
              (colWidths[NAME_COL_KEY] ?? DEFAULT_NAME_WIDTH) +
              displayProperties.reduce(
                (sum, p) => sum + (colWidths[String(p.id)] ?? DEFAULT_COL_WIDTH),
                0
              ) +
              40,
          }}
        >
          <colgroup>
            <col style={{ width: colWidths[NAME_COL_KEY] ?? DEFAULT_NAME_WIDTH }} />
            {displayProperties.map((prop) => (
              <col key={String(prop.id)} style={{ width: colWidths[String(prop.id)] ?? DEFAULT_COL_WIDTH }} />
            ))}
            <col style={{ width: 40 }} />
          </colgroup>
          <thead>
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th
                ref={nameColRef}
                className="text-left px-3 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wider border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 sticky left-0 z-[2] relative group/col overflow-hidden [box-shadow:1px_0_0_0_#e5e7eb] dark:[box-shadow:1px_0_0_0_#262626]"
              >
                <button
                  className="flex items-center gap-1 w-full text-left hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
                  onClick={() => { setNameDefaultDraft(currentNameDefault ?? ""); setNameDefaultOpen(true); }}
                >
                  <span className="text-[10px] font-mono text-neutral-400 dark:text-neutral-500">T</span>
                  Name
                  {currentNameDefault && (
                    <span className="ml-auto text-[9px] text-neutral-400 dark:text-neutral-500 font-mono truncate max-w-[60px]">
                      {currentNameDefault}
                    </span>
                  )}
                </button>
                <div
                  className="absolute top-0 right-0 h-full w-1 cursor-col-resize opacity-0 group-hover/col:opacity-100 bg-blue-400/60 hover:bg-blue-500 transition-opacity z-10"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startColResize(NAME_COL_KEY, e.clientX, colWidths[NAME_COL_KEY] ?? DEFAULT_NAME_WIDTH);
                  }}
                  onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(NAME_COL_KEY); }}
                />
                {nameDefaultOpen && schema && (
                  <FloatingPopup
                    anchorRef={nameColRef}
                    onClose={() => setNameDefaultOpen(false)}
                    className="w-64 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl p-3"
                  >
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-1.5 font-medium">
                      Name column default
                    </div>
                    <input
                      autoFocus
                      className="w-full bg-neutral-100 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-white px-2 py-1 rounded outline-none border border-blue-500/60 font-mono"
                      placeholder="Value or formula…"
                      value={nameDefaultDraft}
                      onChange={(e) => setNameDefaultDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const val = nameDefaultDraft.trim() || null;
                          updateSchemaConfig({
                            schemaId: schema.id,
                            config: mergeDefaultIntoConfig(schema.config ?? "{}", val),
                          });
                          setNameDefaultOpen(false);
                        }
                        if (e.key === "Escape") setNameDefaultOpen(false);
                      }}
                    />
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {["now()", 'counter("TASK-")', "uuid()"].map((h) => (
                        <button
                          key={h}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 font-mono hover:bg-violet-200 dark:hover:bg-violet-800/60 transition-colors"
                          onClick={() => setNameDefaultDraft(h)}
                        >
                          {h}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-2 border-t border-neutral-100 dark:border-neutral-700 pt-2">
                      {currentNameDefault && (
                        <button
                          className="text-xs py-1 px-2 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                          onClick={() => {
                            updateSchemaConfig({
                              schemaId: schema.id,
                              config: mergeDefaultIntoConfig(schema.config ?? "{}", null),
                            });
                            setNameDefaultOpen(false);
                          }}
                        >
                          Clear
                        </button>
                      )}
                      <div className="flex-1" />
                      <button
                        className="text-xs py-1 px-3 rounded bg-blue-500 text-white hover:bg-blue-600"
                        onClick={() => {
                          const val = nameDefaultDraft.trim() || null;
                          updateSchemaConfig({
                            schemaId: schema.id,
                            config: mergeDefaultIntoConfig(schema.config ?? "{}", val),
                          });
                          setNameDefaultOpen(false);
                        }}
                      >
                        Save
                      </button>
                    </div>
                  </FloatingPopup>
                )}
              </th>
              {displayProperties.map((prop, propIdx) => (
                <ColumnHeader
                  key={String(prop.id)}
                  prop={prop}
                  schemaId={schema?.id ?? BigInt(0)}
                  allProperties={displayProperties}
                  databasePages={databasePages}
                  colWidth={colWidths[String(prop.id)] ?? DEFAULT_COL_WIDTH}
                  onResizeStart={(clientX) => startColResize(String(prop.id), clientX, colWidths[String(prop.id)] ?? DEFAULT_COL_WIDTH)}
                  onAutoFit={() => autoFitColumn(String(prop.id))}
                  onDragStart={(clientX, clientY) => startColDrag(String(prop.id), propIdx, clientX, clientY)}
                  isDragging={draggingColKey === String(prop.id)}
                />
              ))}
              <th
                className="px-3 py-2 bg-white dark:bg-neutral-950"
              >
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
                  colSpan={displayProperties.length + 2}
                  className="px-3 py-6 text-center text-neutral-400 dark:text-neutral-600 text-sm italic"
                >
                  {rows.length === 0
                    ? "No rows yet — click below to add one"
                    : "No rows match the active filters"}
                </td>
              </tr>
            )}
            {sortedRows.map((row, rowIdx) => (
              <GridRow
                key={String(row.id)}
                row={row}
                rowIdx={rowIdx}
                properties={displayProperties}
                selectedCells={selectedCells}
                editingCell={editingCell}
                isRowSelected={selectedRowIds.has(row.id)}
                anyRowsSelected={selectedRowIds.size > 0}
                onRowSelect={(shiftKey) => { setSelectedCells(new Set()); toggleRowSelect(row.id, rowIdx, shiftKey); }}
                onCellClick={(rowId, propId, e) => { clearRowSelection(); handleCellClick(rowId, propId, e); }}
                onCellNavigate={handleCellNavigate}
                fillRangeCells={fillRangeCells}
                isDraggingFill={fillSource !== null}
                onFillDragStart={handleFillDragStart}
                onFillDragEnter={handleFillDragEnter}
                onOpenRow={(r) => {
                  setSelectedCells(new Set());
                  setEditingCell(null);
                  clearRowSelection();
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

      {/* Column drag ghost */}
      {ghostPos && draggingColKey && (
        <div
          className="fixed pointer-events-none z-[9999] flex items-center gap-1 px-2.5 py-1.5 bg-white dark:bg-neutral-800 shadow-xl rounded text-xs font-medium text-neutral-500 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700 whitespace-nowrap"
          style={{ left: ghostPos.x + 14, top: ghostPos.y - 16 }}
        >
          <PropertyTypeIcon type={displayProperties.find((p) => String(p.id) === draggingColKey)?.propertyType.tag ?? "Text"} />
          {displayProperties.find((p) => String(p.id) === draggingColKey)?.name ?? "Column"}
        </div>
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
          <div className="mt-2">
            <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-1 font-medium">
              Default value <span className="text-neutral-400 dark:text-neutral-600 font-normal">(optional)</span>
            </div>
            <input
              className="w-full bg-neutral-100 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-white px-2 py-1 rounded outline-none border border-neutral-300 dark:border-neutral-600 font-mono text-xs"
              placeholder="Value or formula…"
              value={newPropDefault}
              onChange={(e) => setNewPropDefault(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  pendingType === "Relation" ? setAddStep("relation-target") : commitAddProperty();
                }
              }}
            />
            {(() => {
              const hints = getFormulaHints(pendingType);
              return hints.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {hints.map((h) => (
                    <button
                      key={h}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 font-mono hover:bg-violet-200 dark:hover:bg-violet-800/60 transition-colors"
                      onClick={() => setNewPropDefault(h)}
                    >
                      {h}
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
          </div>
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
  allProperties,
  databasePages,
  colWidth: _colWidth,
  onResizeStart,
  onAutoFit,
  onDragStart,
  isDragging,
}: {
  prop: NonNullable<PropertyDefinitionRow>;
  schemaId: bigint;
  allProperties: PropertyDefinitionRow[];
  databasePages: { id: bigint; title: string; deletedAt: unknown }[];
  colWidth: number;
  onResizeStart: (clientX: number) => void;
  onAutoFit: () => void;
  onDragStart: (clientX: number, clientY: number) => void;
  isDragging: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<"idle" | "rename" | "change-type" | "relation-target" | "edit-options" | "set-default">("idle");
  const [renameValue, setRenameValue] = useState(prop.name);
  const [relTargetId, setRelTargetId] = useState<bigint | null>(null);
  const [defaultDraft, setDefaultDraft] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);

  const deleteProperty = useDeleteProperty();
  const renameProperty = useRenameProperty();
  const updatePropertyType = useUpdatePropertyType();
  const updatePropertyConfig = useUpdatePropertyConfig();

  const currentDefault = getDefaultExpr(prop.config);

  function closeMenu() {
    setMenuOpen(false);
    setMode("idle");
    setRenameValue(prop.name);
    setRelTargetId(null);
    setDefaultDraft("");
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
    <th
      className={`text-left px-3 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wider border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 relative group/col overflow-hidden transition-opacity${isDragging ? " opacity-30" : ""}`}
      onMouseDown={(e) => {
        if (mode !== "idle") return;
        onDragStart(e.clientX, e.clientY);
      }}
    >
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
          className="flex items-center gap-1 w-full text-left hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors cursor-grab active:cursor-grabbing"
          onClick={() => setMenuOpen(true)}
        >
          <PropertyTypeIcon type={prop.propertyType.tag} />
          {prop.name}
        </button>
      )}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize opacity-0 group-hover/col:opacity-100 bg-blue-400/60 hover:bg-blue-500 transition-opacity z-10"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation(); // don't trigger column drag
          onResizeStart(e.clientX);
        }}
        onDoubleClick={(e) => { e.stopPropagation(); onAutoFit(); }}
      />

      {menuOpen && mode === "idle" && (
        <FloatingPopup
          anchorRef={buttonRef}
          onClose={closeMenu}
          className="w-44 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            onClick={() => { setMenuOpen(false); setMode("rename"); }}
          >
            Rename
          </button>
          {(prop.propertyType.tag === "Select" || prop.propertyType.tag === "MultiSelect") && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
              onClick={() => { setMenuOpen(false); setMode("edit-options"); }}
            >
              Edit options
            </button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            onClick={() => { setMenuOpen(false); setDefaultDraft(currentDefault ?? ""); setMode("set-default"); }}
          >
            <div className="flex items-center justify-between">
              <span>Set default</span>
              {currentDefault && (
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate max-w-[80px] ml-2">
                  {currentDefault}
                </span>
              )}
            </div>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            onClick={() => { setMenuOpen(false); setMode("change-type"); }}
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

      {mode === "edit-options" && (
        <FloatingPopup
          anchorRef={buttonRef}
          onClose={closeMenu}
          className="w-72 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <OptionsEditor prop={prop} allProperties={allProperties} onClose={closeMenu} />
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

      {mode === "set-default" && (
        <FloatingPopup
          anchorRef={buttonRef}
          onClose={closeMenu}
          className="w-64 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl p-3"
        >
          <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-1.5 font-medium">
            Default value
          </div>
          <input
            autoFocus
            className="w-full bg-neutral-100 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-white px-2 py-1 rounded outline-none border border-blue-500/60 font-mono"
            placeholder="Value or formula…"
            value={defaultDraft}
            onChange={(e) => setDefaultDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const val = defaultDraft.trim() || null;
                updatePropertyConfig({
                  propertyDefinitionId: prop.id,
                  config: mergeDefaultIntoConfig(prop.config, val),
                });
                closeMenu();
              }
              if (e.key === "Escape") closeMenu();
            }}
          />
          {(() => {
            const hints = getFormulaHints(prop.propertyType.tag);
            return hints.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {hints.map((h) => (
                  <button
                    key={h}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 font-mono hover:bg-violet-200 dark:hover:bg-violet-800/60 transition-colors"
                    onClick={() => setDefaultDraft(h)}
                  >
                    {h}
                  </button>
                ))}
              </div>
            ) : null;
          })()}
          <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1.5 leading-snug">
            Also supports: this[Field]=&quot;Value&quot;?&quot;Result&quot;
          </div>
          <div className="flex gap-2 mt-2 border-t border-neutral-100 dark:border-neutral-700 pt-2">
            {currentDefault && (
              <button
                className="text-xs py-1 px-2 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                onClick={() => {
                  updatePropertyConfig({
                    propertyDefinitionId: prop.id,
                    config: mergeDefaultIntoConfig(prop.config, null),
                  });
                  closeMenu();
                }}
              >
                Clear
              </button>
            )}
            <div className="flex-1" />
            <button
              className="text-xs py-1 px-3 rounded bg-blue-500 text-white hover:bg-blue-600"
              onClick={() => {
                const val = defaultDraft.trim() || null;
                updatePropertyConfig({
                  propertyDefinitionId: prop.id,
                  config: mergeDefaultIntoConfig(prop.config, val),
                });
                closeMenu();
              }}
            >
              Save
            </button>
          </div>
        </FloatingPopup>
      )}
    </th>
  );
}

// ————————————————— Options editor (for Select / MultiSelect columns) —————————

// Same palette order as PropertyCell so colors match between editor and cells.

function OptionsEditor({
  prop,
  allProperties,
  onClose: _onClose,
}: {
  prop: NonNullable<PropertyDefinitionRow>;
  allProperties: PropertyDefinitionRow[];
  onClose: () => void;
}) {
  const updatePropertyConfig = useUpdatePropertyConfig();
  const setPropertyValue = useSetPropertyValue();
  const [allValues] = useTable(tables.page_property_value);

  const initialCfg = parseSelectConfig(prop.config);
  const [options, setOptions] = useState<string[]>(initialCfg.options);
  const [conditions, setConditions] = useState<Record<string, SelectOptionCondition>>(
    initialCfg.conditions ?? {}
  );
  const [colors, setColors] = useState<Record<string, OptionColorKey>>(
    initialCfg.colors ?? {}
  );
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  // Which option's condition is open for editing
  const [condEditingFor, setCondEditingFor] = useState<string | null>(null);
  const [condPropName, setCondPropName] = useState("");
  const [condValue, setCondValue] = useState("");
  // Which option's color picker is open
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const [newInput, setNewInput] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);

  // Sibling properties that can be used as condition fields (not this property itself).
  const siblingProps = allProperties.filter((p) => p.id !== prop.id);

  function optColor(opt: string) {
    const cfg = { options, conditions, colors };
    return getOptionColorClass(opt, cfg);
  }

  function saveConfig(
    newOpts: string[],
    newConds: Record<string, SelectOptionCondition>,
    newColors: Record<string, OptionColorKey>
  ) {
    updatePropertyConfig({
      propertyDefinitionId: prop.id,
      config: serializeSelectConfig({
        options: newOpts,
        conditions: Object.keys(newConds).length ? newConds : undefined,
        colors: Object.keys(newColors).length ? newColors : undefined,
      }),
    });
  }

  function startRename(idx: number) {
    setCondEditingFor(null);
    setColorPickerFor(null);
    setEditingIdx(idx);
    setEditingLabel(options[idx]);
  }

  function commitRename(idx: number) {
    const oldLabel = options[idx];
    const newLabel = editingLabel.trim();
    setEditingIdx(null);
    if (!newLabel || newLabel === oldLabel) return;

    const newOpts = options.map((o, i) => (i === idx ? newLabel : o));
    const newConds: Record<string, SelectOptionCondition> = {};
    for (const [k, v] of Object.entries(conditions)) {
      newConds[k === oldLabel ? newLabel : k] = v;
    }
    const newColors: Record<string, OptionColorKey> = {};
    for (const [k, v] of Object.entries(colors)) {
      newColors[k === oldLabel ? newLabel : k] = v;
    }
    setOptions(newOpts);
    setConditions(newConds);
    setColors(newColors);
    saveConfig(newOpts, newConds, newColors);

    const propId = prop.id;
    const propTag = prop.propertyType.tag;
    for (const pv of allValues) {
      if (pv.propertyDefinitionId !== propId) continue;
      if (propTag === "Select" && pv.value.tag === "Select" && pv.value.value === oldLabel) {
        setPropertyValue({ pageId: pv.pageId, propertyDefinitionId: propId, value: { tag: "Select", value: newLabel } });
      } else if (propTag === "MultiSelect" && pv.value.tag === "MultiSelect") {
        const vals = pv.value.value as string[];
        if (vals.includes(oldLabel)) {
          setPropertyValue({ pageId: pv.pageId, propertyDefinitionId: propId, value: { tag: "MultiSelect", value: vals.map((v) => (v === oldLabel ? newLabel : v)) } });
        }
      }
    }
  }

  function deleteOption(label: string) {
    const newOpts = options.filter((o) => o !== label);
    const newConds = { ...conditions };
    delete newConds[label];
    const newColors = { ...colors };
    delete newColors[label];
    if (condEditingFor === label) setCondEditingFor(null);
    if (colorPickerFor === label) setColorPickerFor(null);
    setOptions(newOpts);
    setConditions(newConds);
    setColors(newColors);
    saveConfig(newOpts, newConds, newColors);
  }

  function openConditionEditor(label: string) {
    setEditingIdx(null);
    setColorPickerFor(null);
    const existing = conditions[label];
    setCondPropName(existing?.propName ?? "");
    setCondValue(existing?.value ?? "");
    setCondEditingFor(label);
  }

  function commitCondition(label: string) {
    if (!condPropName || !condValue) {
      setCondEditingFor(null);
      return;
    }
    const newConds = { ...conditions, [label]: { propName: condPropName, value: condValue } };
    setConditions(newConds);
    setCondEditingFor(null);
    saveConfig(options, newConds, colors);
  }

  function removeCondition(label: string) {
    const newConds = { ...conditions };
    delete newConds[label];
    setConditions(newConds);
    setCondEditingFor(null);
    saveConfig(options, newConds, colors);
  }

  function setOptionColor(label: string, colorKey: OptionColorKey) {
    const newColors = { ...colors, [label]: colorKey };
    setColors(newColors);
    setColorPickerFor(null);
    saveConfig(options, conditions, newColors);
  }

  // Get the available values for a condition field (for Select/MultiSelect props).
  function getCondFieldOptions(propName: string): string[] {
    const p = siblingProps.find((sp) => sp.name === propName);
    if (!p) return [];
    if (p.propertyType.tag === "Select" || p.propertyType.tag === "MultiSelect") {
      return parseSelectConfig(p.config).options;
    }
    return [];
  }

  const condFieldOptions = getCondFieldOptions(condPropName);

  function addOption() {
    const trimmed = newInput.trim();
    if (!trimmed) return;
    const label = trimmed;
    if (options.some((o) => o.toLowerCase() === label.toLowerCase())) return;
    const newOpts = [...options, label];
    setOptions(newOpts);
    setNewInput("");
    saveConfig(newOpts, conditions, colors);
    newInputRef.current?.focus();
  }

  const selectCls = "bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 text-xs px-1.5 py-0.5 rounded border-0 outline-none cursor-pointer";

  return (
    <div>
      <div className="px-3 py-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider border-b border-neutral-100 dark:border-neutral-700">
        Options
      </div>

      <div className="max-h-72 overflow-y-auto">
        {options.length === 0 && (
          <div className="px-3 py-3 text-sm text-neutral-400 dark:text-neutral-600 italic">
            No options yet
          </div>
        )}

        {options.map((opt, idx) => {
          const cond = conditions[opt];
          const isRenamingThis = editingIdx === idx;
          const isEditingCondThis = condEditingFor === opt;
          const isEditingColorThis = colorPickerFor === opt;
          const currentColorKey = (colors[opt] ?? COLOR_KEYS[(options.indexOf(opt)) % COLOR_KEYS.length]) as OptionColorKey;

          return (
            <div key={opt} className="border-b border-neutral-50 dark:border-neutral-700/50 last:border-0">
              {/* Main row */}
              <div className="flex items-center gap-1.5 px-3 py-1.5 group">
                {/* Color swatch button */}
                {!isRenamingThis && (
                  <button
                    onClick={() => {
                      setEditingIdx(null);
                      setCondEditingFor(null);
                      setColorPickerFor(isEditingColorThis ? null : opt);
                    }}
                    className={`w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-offset-1 ring-transparent hover:ring-neutral-400 dark:hover:ring-neutral-500 transition-all ${SWATCH_BG_CLASSES[currentColorKey]}`}
                    title="Change color"
                  />
                )}

                {isRenamingThis ? (
                  <input
                    autoFocus
                    className="flex-1 min-w-0 text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-900 dark:text-white px-1.5 py-0.5 rounded outline-none border border-blue-500/60"
                    value={editingLabel}
                    onChange={(e) => setEditingLabel(e.target.value)}
                    onBlur={() => commitRename(idx)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(idx);
                      if (e.key === "Escape") setEditingIdx(null);
                    }}
                  />
                ) : (
                  <button
                    className={`text-xs px-2 py-0.5 rounded-full font-medium truncate max-w-[100px] ${optColor(opt)}`}
                    onClick={() => startRename(idx)}
                    title="Click to rename"
                  >
                    {opt}
                  </button>
                )}

                {/* Condition chip / add-condition button */}
                {!isRenamingThis && (
                  cond ? (
                    <button
                      onClick={() => isEditingCondThis ? setCondEditingFor(null) : openConditionEditor(opt)}
                      className={`flex items-center gap-0.5 shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors ${
                        isEditingCondThis
                          ? "bg-violet-200 dark:bg-violet-800/60 text-violet-700 dark:text-violet-200"
                          : "bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/60"
                      }`}
                      title="Edit condition"
                    >
                      {cond.propName} = {cond.value}
                      <span className="ml-0.5 opacity-60">✎</span>
                    </button>
                  ) : (
                    siblingProps.length > 0 && (
                      <button
                        onClick={() => openConditionEditor(opt)}
                        className="opacity-0 group-hover:opacity-100 shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500 hover:text-violet-500 dark:hover:text-violet-400 transition-all"
                        title="Add condition"
                      >
                        + when…
                      </button>
                    )
                  )
                )}

                <button
                  onClick={() => deleteOption(opt)}
                  className="ml-auto opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 text-xs transition-all shrink-0 leading-none"
                  title="Delete option"
                >
                  ✕
                </button>
              </div>

              {/* Inline condition editor */}
              {isEditingCondThis && (
                <div className="px-3 pb-2.5 flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 font-medium">Show when</span>
                    <select
                      value={condPropName}
                      onChange={(e) => { setCondPropName(e.target.value); setCondValue(""); }}
                      className={selectCls}
                    >
                      <option value="">Field…</option>
                      {siblingProps.map((sp) => (
                        <option key={String(sp.id)} value={sp.name}>{sp.name}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500">=</span>
                    {condFieldOptions.length > 0 ? (
                      <select
                        value={condValue}
                        onChange={(e) => setCondValue(e.target.value)}
                        className={selectCls}
                      >
                        <option value="">Value…</option>
                        {condFieldOptions.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 text-xs px-1.5 py-0.5 rounded outline-none border border-transparent focus:border-blue-500/60 w-20"
                        placeholder="value…"
                        value={condValue}
                        onChange={(e) => setCondValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") commitCondition(opt); if (e.key === "Escape") setCondEditingFor(null); }}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => commitCondition(opt)}
                      disabled={!condPropName || !condValue}
                      className="text-[10px] px-2 py-0.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 transition-colors"
                    >
                      Save
                    </button>
                    {cond && (
                      <button
                        onClick={() => removeCondition(opt)}
                        className="text-[10px] px-2 py-0.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      >
                        Remove condition
                      </button>
                    )}
                    <button
                      onClick={() => setCondEditingFor(null)}
                      className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors ml-auto"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Inline color picker */}
              {isEditingColorThis && (
                <div className="px-3 pb-2.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 font-medium mr-0.5">Color</span>
                    {COLOR_KEYS.map((key) => (
                      <button
                        key={key}
                        onClick={() => setOptionColor(opt, key)}
                        title={key}
                        className={`w-5 h-5 rounded-full transition-all ${SWATCH_BG_CLASSES[key]} ${
                          currentColorKey === key
                            ? "ring-2 ring-offset-1 ring-neutral-500 dark:ring-neutral-400 scale-110"
                            : "hover:scale-110 ring-1 ring-transparent hover:ring-neutral-400 dark:hover:ring-neutral-500"
                        }`}
                      />
                    ))}
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 ml-1">
                      — preview:
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${OPTION_CHIP_CLASSES[currentColorKey]}`}>
                      {opt}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2 border-t border-neutral-100 dark:border-neutral-700">
        <input
          ref={newInputRef}
          className="w-full text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-900 dark:text-white px-2 py-1.5 rounded outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500 border border-transparent focus:border-blue-500/60 transition-colors"
          placeholder="New option…"
          value={newInput}
          onChange={(e) => setNewInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addOption(); }}
        />
      </div>
    </div>
  );
}

// ————————————————— Grid row —————————————————

// ─── List view ────────────────────────────────────────────────────────────────

function ListView({
  rows,
  properties,
  selectedRowIds,
  anyRowsSelected,
  onRowSelect,
  onOpenRow,
}: {
  rows: PageRow[];
  properties: ReturnType<typeof usePropertyDefinitions>;
  selectedRowIds: Set<bigint>;
  anyRowsSelected: boolean;
  onRowSelect: (rowId: bigint, rowIdx: number, shiftKey: boolean) => void;
  onOpenRow: (r: PageRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-neutral-400 dark:text-neutral-600 italic">
        No rows yet
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {rows.map((row, rowIdx) => {
        const isSelected = selectedRowIds.has(row.id);
        return (
          <div
            key={String(row.id)}
            className={`group flex items-center gap-2 px-3 h-9 border-b border-neutral-200/60 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-900/40 transition-colors cursor-pointer${isSelected ? " bg-blue-50/60 dark:bg-blue-950/30" : ""}`}
            onClick={() => onOpenRow(row)}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => {/* handled by onClick */}}
              onClick={(e) => { e.stopPropagation(); onRowSelect(row.id, rowIdx, e.shiftKey); }}
              className={`h-3.5 w-3.5 flex-shrink-0 rounded border-neutral-300 dark:border-neutral-600 text-blue-600 cursor-pointer transition-opacity ${anyRowsSelected || isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            />
            <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-200 truncate">
              {row.title || "Untitled"}
            </span>
            {/* Inline chips for first few select/multi-select properties */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {properties.slice(0, 4).map((prop) => (
                <ListCellValue key={String(prop.id)} row={row} prop={prop} />
              ))}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onOpenRow(row); }}
              className="opacity-0 group-hover:opacity-100 text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-all flex-shrink-0"
              title="Open"
            >
              ↗
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ListCellValue({ row, prop }: { row: PageRow; prop: NonNullable<ReturnType<typeof usePropertyDefinitions>[number]> }) {
  const values = usePagePropertyValues(row.id);
  const val = values.find((v) => v.propertyDefinitionId === prop.id);
  if (!val) return null;
  const tag = prop.propertyType.tag;
  if (tag === "Select" || tag === "MultiSelect") {
    const chips = tag === "Select"
      ? (typeof val.value === "string" ? [val.value] : [])
      : (Array.isArray(val.value) ? val.value as string[] : []);
    if (chips.length === 0) return null;
    const cfg = parseSelectConfig(prop.config);
    return (
      <div className="flex items-center gap-1">
        {chips.slice(0, 2).map((chip) => (
          <span key={chip} className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${getOptionColorClass(chip, cfg)}`}>
            {chip}
          </span>
        ))}
        {chips.length > 2 && <span className="text-[10px] text-neutral-400">+{chips.length - 2}</span>}
      </div>
    );
  }
  if (tag === "Checkbox") {
    const pv = val.value as { tag?: string; value?: boolean } | undefined;
    const checked = pv && "tag" in pv && pv.tag === "Checkbox" && pv.value === true;
    return checked ? (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-blue-500 flex-shrink-0">
        <rect x="0.5" y="0.5" width="11" height="11" rx="2.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor"/>
        <path d="M3 6l2.5 2.5L9 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ) : null;
  }
  if (tag === "Text" || tag === "Number" || tag === "Url") {
    const text = typeof val.value === "string" || typeof val.value === "number" ? String(val.value) : null;
    if (!text) return null;
    return <span className="text-xs text-neutral-400 dark:text-neutral-500 truncate max-w-[80px]">{text}</span>;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

function GridRow({
  row,
  rowIdx: _rowIdx,
  properties,
  selectedCells,
  editingCell,
  isRowSelected,
  anyRowsSelected,
  onRowSelect,
  onCellClick,
  onCellNavigate,
  onOpenRow,
  onRowContextMenu,
  onCellContextMenu,
  fillRangeCells,
  isDraggingFill,
  onFillDragStart,
  onFillDragEnter,
}: {
  row: PageRow;
  rowIdx: number;
  properties: ReturnType<typeof usePropertyDefinitions>;
  selectedCells: Set<string>;
  editingCell: string | null;
  isRowSelected: boolean;
  anyRowsSelected: boolean;
  onRowSelect: (shiftKey: boolean) => void;
  onCellClick: (rowId: bigint, propId: bigint, e: React.MouseEvent) => void;
  onCellNavigate: (dir: "down" | "right" | "left" | "escape") => void;
  onOpenRow: (p: PageRow) => void;
  onRowContextMenu?: (e: React.MouseEvent) => void;
  onCellContextMenu?: (e: React.MouseEvent, propId: bigint) => void;
  fillRangeCells: Set<string>;
  isDraggingFill: boolean;
  onFillDragStart: (rowId: bigint, propId: bigint) => void;
  onFillDragEnter: (rowId: bigint, propId: bigint) => void;
}) {
  const values = usePagePropertyValues(row.id);

  // Build { propName → currentStringValue } for conditional option evaluation.
  const siblingValues = useMemo(
    () => buildSiblingValues(values, properties),
    [values, properties]
  );

  return (
    <tr className={`border-b border-neutral-200/60 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-900/40 group${isRowSelected ? " bg-blue-50/60 dark:bg-blue-950/30" : ""}`}>
      <td
        className={`px-3 py-0 h-9 border-r border-neutral-200 dark:border-neutral-800 sticky left-0 z-[1] transition-colors [box-shadow:1px_0_0_0_#e5e7eb] dark:[box-shadow:1px_0_0_0_#262626] ${isRowSelected ? "bg-blue-50/80 dark:bg-blue-950/40 group-hover:bg-blue-100/60 dark:group-hover:bg-blue-950/60" : "bg-white dark:bg-neutral-950 group-hover:bg-neutral-50 dark:group-hover:bg-neutral-900/40"}`}
        onContextMenu={onRowContextMenu}
      >
        <div className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={isRowSelected}
            onChange={() => {/* handled by onClick */}}
            onClick={(e) => { e.stopPropagation(); onRowSelect(e.shiftKey); }}
            className={`h-3.5 w-3.5 flex-shrink-0 rounded border-neutral-300 dark:border-neutral-600 text-blue-600 cursor-pointer transition-opacity ${anyRowsSelected || isRowSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          />
          <button
            onClick={() => onOpenRow(row)}
            className="text-sm text-neutral-800 dark:text-neutral-200 hover:text-neutral-900 dark:hover:text-white hover:underline truncate"
          >
            {row.title || "Untitled"}
          </button>
          <button
            onClick={() => onOpenRow(row)}
            className="opacity-0 group-hover:opacity-100 text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-all flex-shrink-0"
            title="Open"
          >
            ↗
          </button>
        </div>
      </td>
      {properties.map((prop) => {
        const val = values.find((v) => v.propertyDefinitionId === prop.id);
        const cellKey = `${row.id}|${prop.id}`;
        const isSelected = selectedCells.has(cellKey);
        const isFillRange = fillRangeCells.has(cellKey);
        // Show the fill handle only on the single selected cell, when not already dragging
        const showFillHandle = isSelected && selectedCells.size === 1 && !isDraggingFill;

        return (
          <td
            key={String(prop.id)}
            className={`px-0 py-0 h-9 border-r border-neutral-200 dark:border-neutral-800 relative select-none ${
              isSelected
                ? "shadow-[inset_0_0_0_2px_#3b82f6] bg-blue-50/40 dark:bg-blue-900/20"
                : isFillRange
                ? "bg-blue-50/60 dark:bg-blue-900/25 shadow-[inset_0_0_0_1px_#93c5fd]"
                : ""
            }`}
            onClick={(e) => onCellClick(row.id, prop.id, e)}
            onContextMenu={(e) => onCellContextMenu?.(e, prop.id)}
            onMouseEnter={() => {
              if (isDraggingFill) onFillDragEnter(row.id, prop.id);
            }}
          >
            <PropertyCell
              pageId={row.id}
              definition={prop}
              value={val?.value}
              siblingValues={siblingValues}
              forceEdit={editingCell === cellKey}
              onRequestNavigate={onCellNavigate}
            />
            {showFillHandle && (
              <div
                title="Drag to fill cells"
                className="absolute bottom-0 right-0 w-3 h-3 z-10 cursor-nwse-resize translate-x-1/2 translate-y-1/2 rounded-sm border border-white dark:border-neutral-900 bg-blue-500 shadow-sm hover:bg-blue-600 hover:scale-110 transition-transform"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onFillDragStart(row.id, prop.id);
                }}
              />
            )}
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
