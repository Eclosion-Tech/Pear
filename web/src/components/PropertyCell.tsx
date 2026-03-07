"use client";

import { useState, useRef, useEffect } from "react";
import { useSetPropertyValue } from "@/src/hooks/usePages";
import type { PropertyDefinitionRow, PagePropertyValueRow } from "@/src/hooks/useDatabase";

// PropertyValue tag union inferred from row type
type PropertyValue = NonNullable<PagePropertyValueRow>["value"];

interface PropertyCellProps {
  pageId: bigint;
  definition: NonNullable<PropertyDefinitionRow>;
  value: PropertyValue | undefined;
}

export function PropertyCell({
  pageId,
  definition,
  value,
}: PropertyCellProps) {
  const setPropertyValue = useSetPropertyValue();

  function save(newValue: PropertyValue) {
    setPropertyValue({
      pageId,
      propertyDefinitionId: definition.id,
      value: newValue,
    });
  }

  switch (definition.propertyType.tag) {
    case "Text":
      return (
        <TextCell
          value={value?.tag === "Text" ? value.value : ""}
          onSave={(v) => save({ tag: "Text", value: v })}
        />
      );

    case "Select":
      return (
        <SelectCell
          value={value?.tag === "Select" ? value.value : ""}
          config={definition.config}
          onSave={(v) => save({ tag: "Select", value: v })}
        />
      );

    case "Number":
      return (
        <NumberCell
          value={value?.tag === "Number" ? value.value : null}
          onSave={(v) => save({ tag: "Number", value: v })}
        />
      );

    case "Checkbox":
      return (
        <CheckboxCell
          value={value?.tag === "Checkbox" ? value.value : false}
          onSave={(v) => save({ tag: "Checkbox", value: v })}
        />
      );

    case "Url":
      return (
        <TextCell
          value={value?.tag === "Url" ? value.value : ""}
          onSave={(v) => save({ tag: "Url", value: v })}
          placeholder="https://…"
        />
      );

    default:
      return (
        <div className="px-2 py-1 text-neutral-400 dark:text-neutral-600 text-xs">
          {value ? renderValueFallback(value) : "—"}
        </div>
      );
  }
}

// ————————————————— Text cell —————————————————

function TextCell({
  value,
  onSave,
  placeholder = "",
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function commit() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  if (!editing) {
    return (
      <div
        className="h-full w-full px-2 py-1 text-sm text-neutral-800 dark:text-neutral-200 cursor-text truncate hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
        onClick={() => setEditing(true)}
      >
        {value || (
          <span className="text-neutral-400 dark:text-neutral-600 italic">
            {placeholder || "Empty"}
          </span>
        )}
      </div>
    );
  }

  return (
    <input
      ref={inputRef}
      className="h-full w-full px-2 py-1 text-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white outline-none border border-blue-500/60 rounded-sm"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      placeholder={placeholder}
    />
  );
}

// ————————————————— Number cell —————————————————

function NumberCell({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? String(value) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value != null ? String(value) : "");
  }, [value, editing]);

  function commit() {
    setEditing(false);
    const n = parseFloat(draft);
    if (!isNaN(n)) onSave(n);
  }

  if (!editing) {
    return (
      <div
        className="h-full w-full px-2 py-1 text-sm text-neutral-800 dark:text-neutral-200 cursor-text truncate hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
        onClick={() => setEditing(true)}
      >
        {value != null ? (
          value
        ) : (
          <span className="text-neutral-400 dark:text-neutral-600 italic">—</span>
        )}
      </div>
    );
  }

  return (
    <input
      ref={inputRef}
      type="number"
      className="h-full w-full px-2 py-1 text-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white outline-none border border-blue-500/60 rounded-sm"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

// ————————————————— Select cell —————————————————

interface SelectConfig {
  options?: string[];
}

function SelectCell({
  value,
  config,
  onSave,
}: {
  value: string;
  config: string;
  onSave: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newOption, setNewOption] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const options: string[] = (() => {
    try {
      const parsed: SelectConfig = JSON.parse(config);
      return parsed.options ?? [];
    } catch {
      return [];
    }
  })();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const COLOR_MAP: Record<string, string> = {
    "Not started": "bg-neutral-700 text-neutral-300",
    "In progress": "bg-blue-900 text-blue-200",
    Done: "bg-green-900 text-green-200",
    Blocked: "bg-red-900 text-red-200",
  };
  const colorClass = COLOR_MAP[value] ?? "bg-neutral-700 text-neutral-300";

  return (
    <div className="relative h-full" ref={dropdownRef}>
      <div
        className="h-full px-2 py-1 cursor-pointer flex items-center hover:bg-neutral-800/50"
        onClick={() => setOpen((o) => !o)}
      >
        {value ? (
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${colorClass}`}
          >
            {value}
          </span>
        ) : (
          <span className="text-neutral-600 text-sm italic">—</span>
        )}
      </div>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-40 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors ${
                opt === value ? "text-neutral-900 dark:text-white font-medium" : "text-neutral-600 dark:text-neutral-300"
              }`}
              onClick={() => {
                onSave(opt);
                setOpen(false);
              }}
            >
              {opt}
            </button>
          ))}
          <div className="border-t border-neutral-200 dark:border-neutral-700 px-2 py-1.5 flex gap-1">
            <input
              className="flex-1 bg-neutral-100 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-white px-2 py-0.5 rounded outline-none"
              placeholder="New option…"
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newOption.trim()) {
                  onSave(newOption.trim());
                  setNewOption("");
                  setOpen(false);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ————————————————— Checkbox cell —————————————————

function CheckboxCell({
  value,
  onSave,
}: {
  value: boolean;
  onSave: (v: boolean) => void;
}) {
  return (
    <div className="h-full px-2 py-1 flex items-center hover:bg-neutral-100 dark:hover:bg-neutral-800/50">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onSave(e.target.checked)}
        className="accent-blue-500 cursor-pointer"
      />
    </div>
  );
}

function renderValueFallback(value: PropertyValue): string {
  switch (value.tag) {
    case "Text":
    case "Select":
    case "Url":
      return value.value;
    case "Number":
      return String(value.value);
    case "Checkbox":
      return value.value ? "✓" : "";
    case "MultiSelect":
      return (value.value as string[]).join(", ");
    case "Relation":
      return `${(value.value as bigint[]).length} linked`;
    case "Date":
      return new Date(Number(value.value)).toLocaleDateString();
    default:
      return "";
  }
}
