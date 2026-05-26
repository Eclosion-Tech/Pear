"use client";

import { useMemo } from "react";
import type { ComponentRendererProps } from "../registry";

/**
 * Built-in `Input` component — sprint 1 read-only render path.
 *
 * Renders the input chrome (label, placeholder, disabled state) without
 * wiring to any data source. Sprint 4 wires `propertyDefinitionId` to its
 * actual `PagePropertyValue` and enables editing through
 * `update_property_value` (or whatever the custom-view runtime ADR settles
 * on for write-back).
 *
 * Prop schema (`prop_schemas::INPUT` in components.rs):
 *   { propertyDefinitionId: integer (required),
 *     label?: string,
 *     placeholder?: string,
 *     required?: boolean }
 */
type InputProps = {
  propertyDefinitionId?: number | bigint;
  label?: string;
  placeholder?: string;
  required?: boolean;
};

export function InputRenderer({ node }: ComponentRendererProps) {
  const props = useMemo<InputProps>(() => safeParse(node.props), [node.props]);

  return (
    <label className="my-2 flex flex-col gap-1">
      {props.label != null && props.label.length > 0 && (
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {props.label}
          {props.required ? (
            <span className="ml-1 text-red-500">*</span>
          ) : null}
        </span>
      )}
      <input
        type="text"
        readOnly
        placeholder={props.placeholder ?? ""}
        className="rounded-md border border-neutral-300 dark:border-neutral-700
                   bg-white dark:bg-neutral-900 px-3 py-2 text-sm
                   text-neutral-900 dark:text-neutral-100
                   placeholder:text-neutral-400 dark:placeholder:text-neutral-600
                   cursor-not-allowed opacity-90"
        title="Input wiring lands in sprint 4"
      />
    </label>
  );
}

function safeParse(s: string): InputProps {
  try {
    return JSON.parse(s) as InputProps;
  } catch {
    return {};
  }
}
