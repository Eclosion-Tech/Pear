"use client";

import { useMemo } from "react";
import type { ComponentRendererProps } from "../registry";

/**
 * Built-in `Button` component — sprint 1 read-only render path.
 *
 * Renders the button chrome (label + variant) without wiring any action.
 * Sprint 4 wires the action types declared in the prop schema:
 * `submit_form`, `navigate`, `open_url`, `trigger_automation`, `create_row`,
 * `delete_row`, `write_property`. Per-instance capability narrowing is
 * tracked as a follow-up in `docs/PEAR_COMPONENT_NODE_SCHEMA.md`.
 *
 * Prop schema (`prop_schemas::BUTTON` in components.rs):
 *   { label: string (required),
 *     variant?: "primary" | "secondary" | "danger" | "ghost",
 *     action: { type: ActionType, ... } (required) }
 */
type ButtonProps = {
  label?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  action?: { type?: string };
};

const VARIANT_CLASS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-indigo-600 hover:bg-indigo-500 text-white border-transparent",
  secondary:
    "bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-neutral-900 dark:text-neutral-100 border-neutral-200 dark:border-neutral-700",
  danger:
    "bg-red-600 hover:bg-red-500 text-white border-transparent",
  ghost:
    "bg-transparent hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-transparent",
};

export function ButtonRenderer({ node }: ComponentRendererProps) {
  const props = useMemo<ButtonProps>(() => safeParse(node.props), [node.props]);
  const variant = props.variant ?? "secondary";
  const cls = VARIANT_CLASS[variant];

  return (
    <button
      type="button"
      disabled
      title={`Action: ${props.action?.type ?? "(unset)"} — wiring lands in sprint 4`}
      className={`my-1 inline-flex items-center justify-center rounded-md
                  border px-4 py-1.5 text-sm font-medium
                  transition-colors disabled:cursor-not-allowed disabled:opacity-80
                  ${cls}`}
    >
      {props.label ?? "Button"}
    </button>
  );
}

function safeParse(s: string): ButtonProps {
  try {
    return JSON.parse(s) as ButtonProps;
  } catch {
    return {};
  }
}
