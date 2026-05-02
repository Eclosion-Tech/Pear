"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useSetPropertyValue,
  useChildPages,
} from "@/src/hooks/usePages";
import { useUpdatePropertyConfig } from "@/src/hooks/useDatabase";
import type { PropertyDefinitionRow, PagePropertyValueRow } from "@/src/hooks/useDatabase";
import { useUsers, type UserRow } from "@/src/hooks/useUser";
import { FloatingPopup } from "./FloatingPopup";
import {
  parseSelectConfig,
  serializeSelectConfig,
  parseOptionFormula,
  evaluateOption,
  isOptionValid,
  getOptionColorClass,
} from "@/src/lib/formulaEval";
import { evaluateFormula } from "@/src/lib/formulaEvaluator";

type PropertyValue = NonNullable<PagePropertyValueRow>["value"];

/** Direction passed to onRequestNavigate when the user commits / escapes. */
export type NavigateDir = "down" | "right" | "left" | "escape";

interface PropertyCellProps {
  pageId: bigint;
  definition: NonNullable<PropertyDefinitionRow>;
  value: PropertyValue | undefined;
  /**
   * Current string values of all sibling properties on this row,
   * keyed by property name. Used to evaluate conditional select options.
   * e.g. `{ Type: "Video", Status: "Filming" }`
   */
  siblingValues?: Record<string, string>;
  /** When true the cell starts in edit mode immediately (keyboard Enter). */
  forceEdit?: boolean;
  /**
   * Called by editable cells when the user commits (Enter / Tab) or cancels
   * (Escape) so the parent can move focus to the next cell.
   */
  onRequestNavigate?: (dir: NavigateDir) => void;
}

export function PropertyCell({
  pageId,
  definition,
  value,
  siblingValues = {},
  forceEdit,
  onRequestNavigate,
}: PropertyCellProps) {
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
          forceEdit={forceEdit}
          onRequestNavigate={onRequestNavigate}
        />
      );

    case "Select":
      return (
        <SelectCell
          value={value?.tag === "Select" ? value.value : ""}
          config={definition.config}
          siblingValues={siblingValues}
          onSave={(v) => save({ tag: "Select", value: v })}
          onSaveConfig={saveConfig}
          forceEdit={forceEdit}
          onRequestNavigate={onRequestNavigate}
        />
      );

    case "MultiSelect":
      return (
        <MultiSelectCell
          value={value?.tag === "MultiSelect" ? (value.value as string[]) : []}
          config={definition.config}
          siblingValues={siblingValues}
          onSave={(v) => save({ tag: "MultiSelect", value: v })}
          onSaveConfig={saveConfig}
          forceEdit={forceEdit}
          onRequestNavigate={onRequestNavigate}
        />
      );

    case "Number":
      return (
        <NumberCell
          value={value?.tag === "Number" ? value.value : null}
          onSave={(v) => save({ tag: "Number", value: v })}
          forceEdit={forceEdit}
          onRequestNavigate={onRequestNavigate}
        />
      );

    case "Checkbox":
      return (
        <CheckboxCell
          value={value?.tag === "Checkbox" ? value.value : false}
          onSave={(v) => save({ tag: "Checkbox", value: v })}
          onRequestNavigate={onRequestNavigate}
        />
      );

    case "Url":
      return (
        <TextCell
          value={value?.tag === "Url" ? value.value : ""}
          onSave={(v) => save({ tag: "Url", value: v })}
          placeholder="https://…"
          forceEdit={forceEdit}
          onRequestNavigate={onRequestNavigate}
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

    case "Person":
      return (
        <PersonCell
          value={value?.tag === "Person" ? (value.value as string[]) : []}
          onSave={(v) => save({ tag: "Person", value: v })}
        />
      );

    case "Ai":
      return (
        <AiCell
          value={
            value?.tag === "Ai"
              ? (value.value as { output: string; evaluationId: bigint; isStale: boolean })
              : null
          }
        />
      );

    case "Formula" as string: {
      let config: { expression?: string } = {};
      try { config = JSON.parse(definition.config || "{}"); } catch { /* */ }
      const expression = config.expression ?? "";
      if (!expression) return <span className="text-xs text-neutral-400 dark:text-neutral-500 px-3 py-1.5 block">No formula</span>;

      // Build props map from siblingValues (string values) plus any raw values
      const result = evaluateFormula(expression, siblingValues);
      const display = result === null ? "" : String(result);
      return (
        <span className="text-sm text-neutral-700 dark:text-neutral-300 px-3 py-1.5 block select-none">
          {display || <span className="text-neutral-400 dark:text-neutral-500">—</span>}
        </span>
      );
    }

    case "Rollup" as string: {
      // Rollup aggregation is computed from related rows — show config summary for now
      let config: { function?: string; relationPropertyId?: string; rollupPropertyId?: string } = {};
      try { config = JSON.parse(definition.config || "{}"); } catch { /* */ }
      return (
        <span className="text-sm text-neutral-400 dark:text-neutral-500 px-3 py-1.5 block select-none italic">
          {config.function ?? "rollup"}
        </span>
      );
    }

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
  forceEdit,
  onRequestNavigate,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  forceEdit?: boolean;
  onRequestNavigate?: (dir: NavigateDir) => void;
}) {
  const [editing, setEditing] = useState(forceEdit ?? false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Enter edit mode when forceEdit flips to true
  useEffect(() => {
    if (forceEdit) setEditing(true);
  }, [forceEdit]);

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
        if (e.key === "Escape") {
          setEditing(false);
          onRequestNavigate?.("escape");
        } else if (e.key === "Enter") {
          commit();
          onRequestNavigate?.("down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          commit();
          onRequestNavigate?.(e.shiftKey ? "left" : "right");
        }
      }}
      placeholder={placeholder}
    />
  );
}

// ————————————————— Number cell —————————————————

function NumberCell({
  value,
  onSave,
  forceEdit,
  onRequestNavigate,
}: {
  value: number | null;
  onSave: (v: number) => void;
  forceEdit?: boolean;
  onRequestNavigate?: (dir: NavigateDir) => void;
}) {
  const [editing, setEditing] = useState(forceEdit ?? false);
  const [draft, setDraft] = useState(value != null ? String(value) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (forceEdit) setEditing(true);
  }, [forceEdit]);

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
        if (e.key === "Escape") {
          setEditing(false);
          onRequestNavigate?.("escape");
        } else if (e.key === "Enter") {
          commit();
          onRequestNavigate?.("down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          commit();
          onRequestNavigate?.(e.shiftKey ? "left" : "right");
        }
      }}
    />
  );
}

// ————————————————— Select cell —————————————————


function SelectCell({
  value,
  config,
  siblingValues,
  onSave,
  onSaveConfig,
  forceEdit,
  onRequestNavigate,
}: {
  value: string;
  config: string;
  siblingValues: Record<string, string>;
  onSave: (v: string) => void;
  onSaveConfig: (config: string) => void;
  forceEdit?: boolean;
  onRequestNavigate?: (dir: NavigateDir) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const cellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cfg = parseSelectConfig(config);
  const { options } = cfg;

  // Only show options whose conditions pass for this row.
  const visibleOptions = options.filter(
    (o) => evaluateOption(o, cfg, siblingValues) !== null
  );

  // Did the current value's condition stop passing (e.g. Type changed)?
  const currentValueValid = isOptionValid(value, cfg, siblingValues);

  const filtered = visibleOptions.filter((o) =>
    o.toLowerCase().includes(search.toLowerCase())
  );
  const trimmed = search.trim();
  // For "can create" check, look at the resolved label (formula or plain)
  const resolvedCreate = parseOptionFormula(trimmed);
  const createLabel = resolvedCreate ? resolvedCreate.label : trimmed;
  const canCreate =
    trimmed !== "" &&
    !options.some((o) => o.toLowerCase() === createLabel.toLowerCase());

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
    const formula = parseOptionFormula(trimmed);
    const label = formula ? formula.label : trimmed;

    if (!options.some((o) => o.toLowerCase() === label.toLowerCase())) {
      const newConditions = formula
        ? { ...cfg.conditions, [label]: formula.condition }
        : cfg.conditions;
      onSaveConfig(
        serializeSelectConfig({ options: [...options, label], conditions: newConditions })
      );
    }
    onSave(label);
    close();
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    <div ref={cellRef} className="h-full">
      {editing ? (
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
            currentValueValid ? (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getOptionColorClass(value, cfg)}`}>
                {value}
              </span>
            ) : (
              <span
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
                title="This option isn't valid for the current field values"
              >
                <span>⚠</span>
                {value}
              </span>
            )
          ) : (
            <span className="text-neutral-400 dark:text-neutral-600 text-sm italic">—</span>
          )}
        </div>
      )}

      {editing && (
        <FloatingPopup
          anchorRef={cellRef}
          onClose={close}
          className="w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
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
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getOptionColorClass(opt, cfg)}`}>
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
                {resolvedCreate ? (
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">
                      &ldquo;{createLabel}&rdquo;
                    </span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 font-mono">
                      if {resolvedCreate.condition.propName}={resolvedCreate.condition.value}
                    </span>
                  </span>
                ) : (
                  <span>
                    Create{" "}
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">
                      &ldquo;{trimmed}&rdquo;
                    </span>
                  </span>
                )}
              </button>
            )}

            {filtered.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-sm text-neutral-400 dark:text-neutral-500 italic">
                No options
              </div>
            )}
          </div>

          {/* Formula hint */}
          <div className="px-3 py-1.5 border-t border-neutral-100 dark:border-neutral-700">
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono leading-snug">
              this[Field]=&quot;Value&quot;?&quot;Label&quot;
            </p>
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
  siblingValues,
  onSave,
  onSaveConfig,
  forceEdit,
  onRequestNavigate,
}: {
  value: string[];
  config: string;
  siblingValues: Record<string, string>;
  onSave: (v: string[]) => void;
  onSaveConfig: (config: string) => void;
  forceEdit?: boolean;
  onRequestNavigate?: (dir: NavigateDir) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const cellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cfg = parseSelectConfig(config);
  const { options } = cfg;

  // Only show options whose conditions pass for this row.
  const visibleOptions = options.filter(
    (o) => evaluateOption(o, cfg, siblingValues) !== null
  );

  const filtered = visibleOptions.filter((o) =>
    o.toLowerCase().includes(search.toLowerCase())
  );
  const trimmed = search.trim();
  const resolvedCreate = parseOptionFormula(trimmed);
  const createLabel = resolvedCreate ? resolvedCreate.label : trimmed;
  const canCreate =
    trimmed !== "" &&
    !options.some((o) => o.toLowerCase() === createLabel.toLowerCase());

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
    inputRef.current?.focus();
  }

  function createAndToggle() {
    if (!trimmed) return;
    const formula = parseOptionFormula(trimmed);
    const label = formula ? formula.label : trimmed;

    if (!options.some((o) => o.toLowerCase() === label.toLowerCase())) {
      const newConditions = formula
        ? { ...cfg.conditions, [label]: formula.condition }
        : cfg.conditions;
      onSaveConfig(
        serializeSelectConfig({ options: [...options, label], conditions: newConditions })
      );
    }
    if (!value.includes(label)) {
      onSave([...value, label]);
    }
    setSearch("");
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Invalid selected tags: their conditions no longer pass.
  const invalidValues = value.filter((v) => !isOptionValid(v, cfg, siblingValues));

  return (
    <div
      ref={cellRef}
      className={`h-9 overflow-hidden px-2 flex items-center gap-1 ${
        editing
          ? "border border-blue-500/70 rounded-sm"
          : "cursor-default hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
      }`}
      onDoubleClick={() => { if (!editing) setEditing(true); }}
    >
      {value.map((v) => {
        const invalid = invalidValues.includes(v);
        return invalid ? (
          <span
            key={v}
            title="This option isn't valid for the current field values"
            className="flex-shrink-0 flex items-center gap-0.5 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
          >
            <span>⚠</span>{v}
          </span>
        ) : (
          <span
            key={v}
            className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${getOptionColorClass(v, cfg)}`}
          >
            {v}
          </span>
        );
      })}

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
          className="w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
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
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getOptionColorClass(opt, cfg)}`}>
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
                {resolvedCreate ? (
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">
                      &ldquo;{createLabel}&rdquo;
                    </span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 font-mono">
                      if {resolvedCreate.condition.propName}={resolvedCreate.condition.value}
                    </span>
                  </span>
                ) : (
                  <span>
                    Create{" "}
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">
                      &ldquo;{trimmed}&rdquo;
                    </span>
                  </span>
                )}
              </button>
            )}

            {filtered.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-sm text-neutral-400 dark:text-neutral-500 italic">
                No options
              </div>
            )}
          </div>

          <div className="px-3 py-1.5 border-t border-neutral-100 dark:border-neutral-700">
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono leading-snug">
              this[Field]=&quot;Value&quot;?&quot;Label&quot;
            </p>
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
  onRequestNavigate,
}: {
  value: boolean;
  onSave: (v: boolean) => void;
  onRequestNavigate?: (dir: NavigateDir) => void;
}) {
  return (
    <div className="h-full px-2 py-1 flex items-center hover:bg-neutral-100 dark:hover:bg-neutral-800/50">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onSave(e.target.checked)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onSave(!value); onRequestNavigate?.("down"); }
          else if (e.key === "Tab") { e.preventDefault(); onRequestNavigate?.(e.shiftKey ? "left" : "right"); }
          else if (e.key === "Escape") onRequestNavigate?.("escape");
        }}
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

// ————————————————— Person cell —————————————————

const AVATAR_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-pink-500",
  "bg-teal-500",
];

function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function userInitials(user: UserRow): string {
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  if (user.email) return user.email[0].toUpperCase();
  return "?";
}

function PersonCell({
  value,
  onSave,
}: {
  value: string[];
  onSave: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { users } = useUsers();

  const usersByIdentity = useMemo(() => {
    const map = new Map<string, UserRow>();
    for (const u of users) map.set(u.identity.toHexString(), u);
    return map;
  }, [users]);

  const selectedUsers = value
    .map((hex) => ({ hex, user: usersByIdentity.get(hex) }))
    .filter((e): e is { hex: string; user: UserRow } => !!e.user);

  const filtered = users.filter(
    (u) =>
      (u.name.toLowerCase().includes(search.toLowerCase()) ||
        u.email.toLowerCase().includes(search.toLowerCase())) &&
      !value.includes(u.identity.toHexString())
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function toggle(hex: string) {
    const next = value.includes(hex)
      ? value.filter((v) => v !== hex)
      : [...value, hex];
    onSave(next);
  }

  function handleClose() {
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="h-full">
      <div
        ref={anchorRef}
        className="h-full px-2 py-1 cursor-default flex items-center flex-wrap gap-1 min-h-9 hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
        onDoubleClick={() => setOpen((o) => !o)}
      >
        {selectedUsers.length > 0 ? (
          selectedUsers.map(({ hex, user }) => (
            <span
              key={hex}
              className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 border border-neutral-200 dark:border-neutral-600"
            >
              <span
                className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] text-white font-semibold ${hashColor(hex)}`}
              >
                {userInitials(user)}
              </span>
              {user.name || user.email}
            </span>
          ))
        ) : (
          <span className="text-neutral-400 dark:text-neutral-600 text-sm italic">
            —
          </span>
        )}
      </div>

      {open && (
        <FloatingPopup
          anchorRef={anchorRef}
          onClose={handleClose}
          className="w-60 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="px-2 py-1.5 border-b border-neutral-100 dark:border-neutral-700">
            <input
              ref={inputRef}
              className="w-full bg-neutral-100 dark:bg-neutral-700 text-sm text-neutral-900 dark:text-white px-2 py-0.5 rounded outline-none"
              placeholder="Search people…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {/* Already-selected users (shown at top for easy removal) */}
            {selectedUsers.map(({ hex, user }) => (
              <button
                key={hex}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                onClick={() => toggle(hex)}
              >
                <span className="w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-xs bg-blue-500 border-blue-500 text-white">
                  ✓
                </span>
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] text-white font-semibold flex-shrink-0 ${hashColor(hex)}`}
                >
                  {userInitials(user)}
                </span>
                <span className="truncate">
                  {user.name || user.email}
                </span>
              </button>
            ))}

            {selectedUsers.length > 0 && filtered.length > 0 && (
              <div className="border-t border-neutral-100 dark:border-neutral-700" />
            )}

            {/* Unselected users */}
            {filtered.map((user) => {
              const hex = user.identity.toHexString();
              return (
                <button
                  key={hex}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                  onClick={() => toggle(hex)}
                >
                  <span className="w-3.5 h-3.5 rounded border flex-shrink-0 border-neutral-400 dark:border-neutral-500" />
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] text-white font-semibold flex-shrink-0 ${hashColor(hex)}`}
                  >
                    {userInitials(user)}
                  </span>
                  <span className="truncate">
                    {user.name || user.email}
                  </span>
                </button>
              );
            })}

            {selectedUsers.length === 0 && filtered.length === 0 && (
              <div className="px-3 py-2 text-sm text-neutral-400 dark:text-neutral-600 italic">
                No users found
              </div>
            )}
          </div>
        </FloatingPopup>
      )}
    </div>
  );
}

// ————————————————— AI cell —————————————————
//
// Read-only display of a materialised `PropertyValue::Ai` payload. The value
// is computed by the worker's `ai_primitive` task and written back through the
// `record_ai_evaluation` reducer; the cell never edits in place. The sparkle
// icon makes the provenance visible; the staleness pill warns when an input
// changed and the evaluation is queued to re-run. Hover shows the
// evaluation id so support / debugging can correlate with `ai_evaluation`
// rows.

function AiCell({
  value,
}: {
  value: { output: string; evaluationId: bigint; isStale: boolean } | null;
}) {
  if (!value) {
    return (
      <div className="h-full w-full px-2 py-1 text-sm flex items-center gap-1.5 text-neutral-400 dark:text-neutral-600 italic">
        <span aria-hidden>✨</span>
        <span>Pending…</span>
      </div>
    );
  }
  return (
    <div
      className="h-full w-full px-2 py-1 text-sm flex items-center gap-1.5 text-neutral-800 dark:text-neutral-200 truncate"
      title={`AI evaluation #${value.evaluationId.toString()}`}
    >
      <span aria-hidden className="text-violet-500 dark:text-violet-400">✨</span>
      <span className="truncate">{value.output}</span>
      {value.isStale && (
        <span className="ml-auto flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
          stale
        </span>
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
    case "Person":
      return `${(value.value as string[]).length} assigned`;
    case "Date":
      return new Date(Number(value.value as bigint)).toLocaleDateString();
    default:
      return "";
  }
}
