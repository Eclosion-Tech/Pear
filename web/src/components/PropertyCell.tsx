"use client";

import { useState, useRef, useEffect } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useSetPropertyValue,
  useChildPages,
} from "@/src/hooks/usePages";
import { useUpdatePropertyConfig } from "@/src/hooks/useDatabase";
import type { PropertyDefinitionRow, PagePropertyValueRow } from "@/src/hooks/useDatabase";
import { FloatingPopup } from "./FloatingPopup";

type PropertyValue = NonNullable<PagePropertyValueRow>["value"];

interface PropertyCellProps {
  pageId: bigint;
  definition: NonNullable<PropertyDefinitionRow>;
  value: PropertyValue | undefined;
}

export function PropertyCell({ pageId, definition, value }: PropertyCellProps) {
  const setPropertyValue = useSetPropertyValue();
  const updatePropertyConfig = useUpdatePropertyConfig();

  function save(newValue: PropertyValue) {
    setPropertyValue({
      pageId,
      propertyDefinitionId: definition.id,
      value: newValue,
    });
  }

  function saveConfig(config: string) {
    updatePropertyConfig({
      propertyDefinitionId: definition.id,
      config,
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
          onSaveConfig={saveConfig}
        />
      );

    case "MultiSelect":
      return (
        <MultiSelectCell
          value={value?.tag === "MultiSelect" ? (value.value as string[]) : []}
          config={definition.config}
          onSave={(v) => save({ tag: "MultiSelect", value: v })}
          onSaveConfig={saveConfig}
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

    case "Date":
      return (
        <DateCell
          value={value?.tag === "Date" ? (value.value as bigint) : null}
          onSave={(v) => save({ tag: "Date", value: v })}
        />
      );

    case "Relation":
      return (
        <RelationCell
          value={value?.tag === "Relation" ? (value.value as bigint[]) : []}
          config={definition.config}
          onSave={(v) => save({ tag: "Relation", value: v })}
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
        className="h-full w-full px-2 py-1 text-sm text-neutral-800 dark:text-neutral-200 cursor-default truncate hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
        onDoubleClick={() => setEditing(true)}
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
      size={1}
      className="h-full w-full min-w-0 px-2 py-1 text-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white outline-none border border-blue-500/60 rounded-sm"
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
        className="h-full w-full px-2 py-1 text-sm text-neutral-800 dark:text-neutral-200 cursor-default truncate hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
        onDoubleClick={() => setEditing(true)}
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
      size={1}
      className="h-full w-full min-w-0 px-2 py-1 text-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white outline-none border border-blue-500/60 rounded-sm"
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

function parseOptions(config: string): string[] {
  try {
    const parsed: SelectConfig = JSON.parse(config);
    return parsed.options ?? [];
  } catch {
    return [];
  }
}

// Stable color palette cycled for user-created options.
const OPTION_COLORS = [
  "bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200",
  "bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-200",
  "bg-green-100 dark:bg-green-900/60 text-green-700 dark:text-green-200",
  "bg-yellow-100 dark:bg-yellow-900/60 text-yellow-700 dark:text-yellow-200",
  "bg-orange-100 dark:bg-orange-900/60 text-orange-700 dark:text-orange-200",
  "bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-200",
  "bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-200",
  "bg-pink-100 dark:bg-pink-900/60 text-pink-700 dark:text-pink-200",
];

function optionColor(opt: string, allOptions: string[]) {
  const idx = allOptions.indexOf(opt);
  return OPTION_COLORS[(idx < 0 ? 0 : idx) % OPTION_COLORS.length];
}

function SelectCell({
  value,
  config,
  onSave,
  onSaveConfig,
}: {
  value: string;
  config: string;
  onSave: (v: string) => void;
  onSaveConfig: (config: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const cellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = parseOptions(config);

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(search.toLowerCase())
  );
  const trimmed = search.trim();
  const canCreate =
    trimmed !== "" &&
    !options.some((o) => o.toLowerCase() === trimmed.toLowerCase());

  function close() {
    setEditing(false);
    setSearch("");
  }

  function selectOpt(opt: string) {
    onSave(opt);
    close();
  }

  function createAndSelect() {
    if (!trimmed) return;
    if (!options.includes(trimmed)) {
      onSaveConfig(JSON.stringify({ options: [...options, trimmed] }));
    }
    onSave(trimmed);
    close();
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    <div ref={cellRef} className="h-full">
      {editing ? (
        // Cell becomes the input — size={1}+min-w-0 prevents the input's intrinsic
        // minimum width from stretching the column; w-full fills the cell instead.
        <input
          ref={inputRef}
          size={1}
          className="h-full w-full min-w-0 px-2 py-1 bg-transparent text-sm text-neutral-900 dark:text-white outline-none border border-blue-500/70 rounded-sm"
          value={search}
          placeholder={value || "Search or create…"}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length === 1) selectOpt(filtered[0]);
              else if (canCreate) createAndSelect();
            }
            if (e.key === "Escape") close();
          }}
        />
      ) : (
        <div
          className="h-full px-2 py-1 cursor-default flex items-center hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
          onDoubleClick={() => setEditing(true)}
        >
          {value ? (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${optionColor(value, options)}`}>
              {value}
            </span>
          ) : (
            <span className="text-neutral-400 dark:text-neutral-600 text-sm italic">—</span>
          )}
        </div>
      )}

      {editing && (
        <FloatingPopup
          anchorRef={cellRef}
          onClose={close}
          className="w-52 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="max-h-56 overflow-y-auto">
            {/* Clear when a value is set and nothing typed */}
            {value && !search && (
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 italic"
                onClick={() => { onSave(""); close(); }}
              >
                Clear
              </button>
            )}

            {filtered.map((opt) => (
              <button
                key={opt}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                onClick={() => selectOpt(opt)}
              >
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${optionColor(opt, options)}`}>
                  {opt}
                </span>
                {opt === value && (
                  <span className="ml-auto text-blue-500 text-xs">✓</span>
                )}
              </button>
            ))}

            {canCreate && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                onClick={createAndSelect}
              >
                <span className="text-neutral-400 dark:text-neutral-500 text-xs">+</span>
                Create{" "}
                <span className="font-medium text-neutral-800 dark:text-neutral-100">
                  &ldquo;{trimmed}&rdquo;
                </span>
              </button>
            )}

            {filtered.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-sm text-neutral-400 dark:text-neutral-500 italic">
                No options
              </div>
            )}
          </div>
        </FloatingPopup>
      )}
    </div>
  );
}

// ————————————————— MultiSelect cell —————————————————

function MultiSelectCell({
  value,
  config,
  onSave,
  onSaveConfig,
}: {
  value: string[];
  config: string;
  onSave: (v: string[]) => void;
  onSaveConfig: (config: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const cellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = parseOptions(config);

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(search.toLowerCase())
  );
  const trimmed = search.trim();
  const canCreate =
    trimmed !== "" &&
    !options.some((o) => o.toLowerCase() === trimmed.toLowerCase());

  function close() {
    setEditing(false);
    setSearch("");
  }

  function toggle(opt: string) {
    const next = value.includes(opt)
      ? value.filter((v) => v !== opt)
      : [...value, opt];
    onSave(next);
    setSearch("");
    // Stay open so the user can keep picking
    inputRef.current?.focus();
  }

  function createAndToggle() {
    if (!trimmed) return;
    if (!options.includes(trimmed)) {
      onSaveConfig(JSON.stringify({ options: [...options, trimmed] }));
    }
    if (!value.includes(trimmed)) {
      onSave([...value, trimmed]);
    }
    setSearch("");
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    // h-9 + overflow-hidden: cell is always exactly one row tall, pills never push it taller
    <div
      ref={cellRef}
      className={`h-9 overflow-hidden px-2 flex items-center gap-1 ${
        editing
          ? "border border-blue-500/70 rounded-sm"
          : "cursor-default hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
      }`}
      onDoubleClick={() => { if (!editing) setEditing(true); }}
    >
      {/* Selected pills — flex-shrink-0 so they don't get squashed by the input */}
      {value.map((v) => (
        <span
          key={v}
          className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${optionColor(v, options)}`}
        >
          {v}
        </span>
      ))}

      {/* Inline input — only visible while editing */}
      {editing ? (
        <input
          ref={inputRef}
          size={1}
          className="flex-1 min-w-0 bg-transparent text-sm text-neutral-900 dark:text-white outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
          value={search}
          placeholder={value.length === 0 ? "Search or create…" : ""}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length === 1) toggle(filtered[0]);
              else if (canCreate) createAndToggle();
            }
            if (e.key === "Escape") close();
            // Backspace with empty input removes the last tag
            if (e.key === "Backspace" && !search && value.length > 0) {
              onSave(value.slice(0, -1));
            }
          }}
        />
      ) : (
        !value.length && (
          <span className="text-neutral-400 dark:text-neutral-600 text-sm italic">—</span>
        )
      )}

      {editing && (
        <FloatingPopup
          anchorRef={cellRef}
          onClose={close}
          className="w-52 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="max-h-56 overflow-y-auto">
            {filtered.map((opt) => (
              <button
                key={opt}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                onClick={() => toggle(opt)}
              >
                <span
                  className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-xs ${
                    value.includes(opt)
                      ? "bg-blue-500 border-blue-500 text-white"
                      : "border-neutral-400 dark:border-neutral-500"
                  }`}
                >
                  {value.includes(opt) ? "✓" : ""}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${optionColor(opt, options)}`}>
                  {opt}
                </span>
              </button>
            ))}

            {canCreate && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                onClick={createAndToggle}
              >
                <span className="text-neutral-400 dark:text-neutral-500 text-xs">+</span>
                Create{" "}
                <span className="font-medium text-neutral-800 dark:text-neutral-100">
                  &ldquo;{trimmed}&rdquo;
                </span>
              </button>
            )}

            {filtered.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-sm text-neutral-400 dark:text-neutral-500 italic">
                No options
              </div>
            )}
          </div>
        </FloatingPopup>
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

// ————————————————— Date cell —————————————————

function DateCell({
  value,
  onSave,
}: {
  value: bigint | null;
  onSave: (v: bigint) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const dateStr = value
    ? new Date(Number(value)).toISOString().slice(0, 10)
    : "";

  useEffect(() => {
    if (open) {
      // Small delay so the portal is positioned and visible before showing picker.
      setTimeout(() => inputRef.current?.showPicker?.(), 80);
    }
  }, [open]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const ms = e.target.valueAsNumber;
    if (!isNaN(ms)) {
      onSave(BigInt(ms));
    }
    setOpen(false);
  }

  return (
    <div className="h-full">
      <div
        ref={anchorRef}
        className="h-full w-full px-2 py-1 text-sm text-neutral-800 dark:text-neutral-200 cursor-default flex items-center hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
        onDoubleClick={() => setOpen(true)}
      >
        {dateStr ? (
          new Date(dateStr).toLocaleDateString()
        ) : (
          <span className="text-neutral-400 dark:text-neutral-600 italic">—</span>
        )}
      </div>
      {open && (
        <FloatingPopup
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          className="bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl p-2"
        >
          <input
            ref={inputRef}
            type="date"
            className="bg-transparent text-sm text-neutral-900 dark:text-white outline-none"
            defaultValue={dateStr}
            onChange={handleChange}
          />
        </FloatingPopup>
      )}
    </div>
  );
}

// ————————————————— Relation cell —————————————————

interface RelationConfig {
  targetPageId?: string;
}

function RelationCell({
  value,
  config,
  onSave,
}: {
  value: bigint[];
  config: string;
  onSave: (v: bigint[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Store IDs as strings internally to keep React component state free of
  // bigints — React's dev-mode error formatter calls JSON.stringify() on props
  // and will crash on bigint[] values.
  const valueStrs: string[] = value.map((id) => id.toString());

  const targetPageId: bigint | null = (() => {
    try {
      const parsed: RelationConfig = JSON.parse(config);
      return parsed.targetPageId ? BigInt(parsed.targetPageId) : null;
    } catch {
      return null;
    }
  })();

  const { children: allLinkedPages } = useChildPages(
    targetPageId ?? BigInt(0)
  );

  const [allPages] = useTable(tables.page);
  const linkedPageTitles = valueStrs.map((idStr) => {
    const page = allPages.find((p) => p.id.toString() === idStr);
    return { idStr, title: page?.title ?? `#${idStr}` };
  });

  const filtered = allLinkedPages.filter(
    (p) =>
      p.title.toLowerCase().includes(search.toLowerCase()) &&
      !p.deletedAt
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function toggle(idStr: string) {
    const next = valueStrs.includes(idStr)
      ? valueStrs.filter((v) => v !== idStr)
      : [...valueStrs, idStr];
    // Convert back to bigint[] only at the boundary with SpacetimeDB
    onSave(next.map((s) => BigInt(s)));
  }

  function handleClose() {
    setOpen(false);
    setSearch("");
  }

  if (!targetPageId) {
    return (
      <div className="px-2 py-1 text-xs text-neutral-400 dark:text-neutral-600 italic">
        No target database
      </div>
    );
  }

  return (
    <div className="h-full">
      <div
        ref={anchorRef}
        className="h-full px-2 py-1 cursor-default flex items-center flex-wrap gap-1 min-h-9 hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
        onDoubleClick={() => setOpen((o) => !o)}
      >
        {linkedPageTitles.length > 0 ? (
          linkedPageTitles.map(({ idStr, title }) => (
            <span
              key={idStr}
              className="text-xs px-2 py-0.5 rounded-md font-medium bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-200 border border-purple-200 dark:border-purple-700"
            >
              {title}
            </span>
          ))
        ) : (
          <span className="text-neutral-400 dark:text-neutral-600 text-sm italic">—</span>
        )}
      </div>

      {open && (
        <FloatingPopup
          anchorRef={anchorRef}
          onClose={handleClose}
          className="w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="px-2 py-1.5 border-b border-neutral-100 dark:border-neutral-700">
            <input
              ref={inputRef}
              className="w-full bg-neutral-100 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-white px-2 py-0.5 rounded outline-none"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-400 dark:text-neutral-600 italic">
                No rows found
              </div>
            ) : (
              filtered.map((page) => {
                const pidStr = page.id.toString();
                const checked = valueStrs.includes(pidStr);
                return (
                  <button
                    key={pidStr}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                    onClick={() => toggle(pidStr)}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-xs ${
                        checked
                          ? "bg-purple-500 border-purple-500 text-white"
                          : "border-neutral-400 dark:border-neutral-500"
                      }`}
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <span className="truncate">{page.title || "Untitled"}</span>
                  </button>
                );
              })
            )}
          </div>
        </FloatingPopup>
      )}
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
      return new Date(Number(value.value as bigint)).toLocaleDateString();
    default:
      return "";
  }
}
