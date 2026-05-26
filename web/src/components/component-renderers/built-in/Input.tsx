"use client";

import { useEffect, useMemo, useState } from "react";
import type { BlockRendererProps } from "@eclosion-tech/pulp";
import { useDatabaseSchema, usePropertyDefinitions } from "@/src/hooks/useDatabase";
import { useFormContext } from "../FormContext";

/**
 * Built-in `Input` — form-leaf bound to a property definition.
 *
 * Inside a `Form`, edits are collected on submit. Outside a Form, renders
 * read-only chrome with a hint.
 */
type InputProps = {
  propertyDefinitionId?: number | bigint;
  label?: string;
  placeholder?: string;
  required?: boolean;
};

export function InputRenderer({ node }: BlockRendererProps) {
  const props = useMemo<InputProps>(() => safeParse(node.props), [node.props]);
  const form = useFormContext();
  const propId = normalizeId(props.propertyDefinitionId);

  const { schema } = useDatabaseSchema(form?.databaseId ?? 0n);
  const defs = usePropertyDefinitions(schema?.id ?? 0n);
  const def = propId != null ? defs.find((d) => d.id === propId) : undefined;

  const [value, setValue] = useState("");

  useEffect(() => {
    if (!form || propId == null) return;
    return form.registerField(propId, () => {
      if (!value.trim()) return null;
      return { tag: "Text", value: value.trim() };
    });
  }, [form, propId, value]);

  const editable = form != null && propId != null;

  return (
    <label className="my-2 flex flex-col gap-1">
      {(props.label != null && props.label.length > 0) || def ? (
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {props.label ?? def?.name ?? "Field"}
          {props.required ? (
            <span className="ml-1 text-red-500">*</span>
          ) : null}
        </span>
      ) : null}
      <input
        type="text"
        readOnly={!editable}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={props.placeholder ?? ""}
        className={`rounded-md border border-neutral-300 dark:border-neutral-700
                   bg-white dark:bg-neutral-900 px-3 py-2 text-sm
                   text-neutral-900 dark:text-neutral-100
                   placeholder:text-neutral-400 dark:placeholder:text-neutral-600
                   ${editable ? "" : "cursor-not-allowed opacity-90"}`}
        title={
          editable
            ? undefined
            : "Place this Input inside a Form block to enable editing"
        }
      />
    </label>
  );
}

function normalizeId(raw: unknown): bigint | null {
  if (raw == null) return null;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(raw);
  if (typeof raw === "string") {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function safeParse(s: string): InputProps {
  try {
    return JSON.parse(s) as InputProps;
  } catch {
    return {};
  }
}
