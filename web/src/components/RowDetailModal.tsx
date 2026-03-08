"use client";

import { useEffect, useRef, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { PearEditor } from "./PearEditor";
import { PropertyCell } from "./PropertyCell";
import { useUpdatePageTitle } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import {
  useDatabaseSchema,
  usePropertyDefinitions,
  usePagePropertyValues,
} from "@/src/hooks/useDatabase";

interface RowDetailModalProps {
  page: PageRow;
  /** The parent database page — used to look up schema + properties. */
  parentPage: PageRow;
  onClose: () => void;
}

export function RowDetailModal({ page, parentPage, onClose }: RowDetailModalProps) {
  const [contents] = useTable(tables.page_content);
  const content = contents.find((c) => c.pageId === page.id);
  const updateTitle = useUpdatePageTitle();

  const [title, setTitle] = useState(page.title);
  const titleFocusedRef = useRef(false);
  const titleDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local title in sync when not focused
  useEffect(() => {
    if (!titleFocusedRef.current) {
      setTitle(page.title);
    }
  }, [page.title]);

  async function handleTitleChange(value: string) {
    setTitle(value);
    if (titleDebounce.current) clearTimeout(titleDebounce.current);
    titleDebounce.current = setTimeout(async () => {
      if (value.trim()) {
        await updateTitle({ pageId: page.id, title: value });
      }
    }, 400);
  }

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const { schema } = useDatabaseSchema(parentPage.id);
  const properties = usePropertyDefinitions(schema?.id ?? BigInt(0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden border border-neutral-200 dark:border-neutral-700">
        {/* Title bar */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-3 border-b border-neutral-200 dark:border-neutral-800">
          <input
            className="flex-1 bg-transparent text-xl font-semibold text-neutral-900 dark:text-white outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            onFocus={() => { titleFocusedRef.current = true; }}
            onBlur={() => {
              titleFocusedRef.current = false;
              setTitle(page.title);
            }}
            placeholder="Untitled"
          />
          <button
            onClick={onClose}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-white text-lg transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Properties panel */}
          {properties.length > 0 && (
            <div className="px-6 pt-3 pb-2 border-b border-neutral-100 dark:border-neutral-800">
              <PropertiesPanel pageId={page.id} properties={properties} />
            </div>
          )}

          {/* Editor */}
          <div className="px-6 py-4">
            <PearEditor
              key={String(page.id)}
              pageId={page.id}
              initialContent={content?.content ?? ""}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ————————————————— Properties panel —————————————————

function PropertiesPanel({
  pageId,
  properties,
}: {
  pageId: bigint;
  properties: ReturnType<typeof usePropertyDefinitions>;
}) {
  const values = usePagePropertyValues(pageId);

  return (
    <div className="space-y-1">
      {properties.map((prop) => {
        const val = values.find((v) => v.propertyDefinitionId === prop.id);
        return (
          <div key={String(prop.id)} className="flex items-start gap-3 min-h-8">
            <div className="w-32 flex-shrink-0 text-xs text-neutral-500 dark:text-neutral-400 pt-1.5 flex items-center gap-1.5 truncate">
              <PropIcon type={prop.propertyType.tag} />
              <span className="truncate">{prop.name}</span>
            </div>
            <div className="flex-1 min-w-0 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
              <PropertyCell
                pageId={pageId}
                definition={prop}
                value={val?.value}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PropIcon({ type }: { type: string }) {
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
