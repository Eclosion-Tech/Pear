"use client";

import { useState, useRef, useEffect } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useChildPages,
  useCreatePage,
  useAddProperty,
  useCreateDatabaseSchema,
  useCreateView,
  useSetPropertyValue,
} from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import {
  useDatabaseSchema,
  usePropertyDefinitions,
  usePagePropertyValues,
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

  // ── Cell selection ──────────────────────────────────────────────────────────
  // Key format: `${rowId}|${propDefinitionId}` (both as decimal strings)
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const setPropertyValue = useSetPropertyValue();

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
    <div className="flex-1 flex flex-col overflow-hidden">
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
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={properties.length + 2}
                  className="px-3 py-6 text-center text-neutral-400 dark:text-neutral-600 text-sm italic"
                >
                  No rows yet — click below to add one
                </td>
              </tr>
            )}
            {rows.map((row) => (
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
}: {
  row: PageRow;
  properties: ReturnType<typeof usePropertyDefinitions>;
  selectedCells: Set<string>;
  onCellClick: (rowId: bigint, propId: bigint, e: React.MouseEvent) => void;
  onOpenRow: (p: PageRow) => void;
}) {
  const values = usePagePropertyValues(row.id);

  return (
    <tr className="border-b border-neutral-200/60 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-900/40 group">
      <td className="px-3 py-0 h-9 border-r border-neutral-200 dark:border-neutral-800">
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
