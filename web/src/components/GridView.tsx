"use client";

import { useState, useRef } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useChildPages,
  useCreatePage,
  useAddProperty,
  useCreateDatabaseSchema,
  useCreateView,
} from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import {
  useDatabaseSchema,
  usePropertyDefinitions,
  usePagePropertyValues,
} from "@/src/hooks/useDatabase";
import { PropertyCell } from "./PropertyCell";
import { RowDetailModal } from "./RowDetailModal";

interface GridViewProps {
  page: PageRow;
}

export function GridView({ page }: GridViewProps) {
  const { schema } = useDatabaseSchema(page.id);
  const properties = usePropertyDefinitions(schema?.id ?? BigInt(0));
  const { children: rows } = useChildPages(page.id);

  const createPage = useCreatePage();
  const addProperty = useAddProperty();
  const createSchema = useCreateDatabaseSchema();
  const createView = useCreateView();

  const [selectedRow, setSelectedRow] = useState<PageRow | null>(null);
  const [addingProperty, setAddingProperty] = useState(false);
  const [newPropName, setNewPropName] = useState("");

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

  async function handleAddProperty() {
    if (!newPropName.trim()) return;
    if (!schema) {
      await createSchema({ pageId: page.id, name: page.title });
    }
    await addProperty({
      schemaId: schema?.id ?? BigInt(0),
      name: newPropName.trim(),
      propertyType: { tag: "Text" },
      config: "{}",
    });
    setNewPropName("");
    setAddingProperty(false);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Grid table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th className="text-left px-3 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wider w-56 border-r border-neutral-200 dark:border-neutral-800">
                Name
              </th>
              {properties.map((prop) => (
                <th
                  key={String(prop.id)}
                  className="text-left px-3 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wider min-w-32 border-r border-neutral-200 dark:border-neutral-800"
                >
                  <span className="flex items-center gap-1">
                    <PropertyTypeIcon type={prop.propertyType.tag} />
                    {prop.name}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2 w-10">
                {addingProperty ? (
                  <input
                    autoFocus
                    className="bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white text-xs px-2 py-1 rounded outline-none border border-blue-500/60 w-28"
                    placeholder="Property name…"
                    value={newPropName}
                    onChange={(e) => setNewPropName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddProperty();
                      if (e.key === "Escape") setAddingProperty(false);
                    }}
                    onBlur={() => {
                      if (!newPropName.trim()) setAddingProperty(false);
                    }}
                  />
                ) : (
                  <button
                    onClick={() => setAddingProperty(true)}
                    className="text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300 text-lg leading-none transition-colors"
                    title="Add property"
                  >
                    +
                  </button>
                )}
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
                onOpenRow={setSelectedRow}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Add row */}
      <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2">
        <button
          onClick={handleAddRow}
          className="text-sm text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200 transition-colors"
        >
          + New row
        </button>
      </div>

      {selectedRow && (
        <RowDetailModal page={selectedRow} onClose={() => setSelectedRow(null)} />
      )}
    </div>
  );
}

function GridRow({
  row,
  properties,
  onOpenRow,
}: {
  row: PageRow;
  properties: ReturnType<typeof usePropertyDefinitions>;
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
        return (
          <td
            key={String(prop.id)}
            className="px-0 py-0 h-9 border-r border-neutral-200 dark:border-neutral-800"
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
