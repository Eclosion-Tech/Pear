"use client";

import type { BlockRendererProps } from "@eclosion-tech/pulp";

/**
 * Sprint-1 placeholder for Table / Card / List. Form / Input / Button
 * shipped in sprint 4; Table / Card / List await the custom-view runtime ADR.
 *
 * The placeholder is visible — same defence-in-depth stance as
 * `UnregisteredComponentFallback`. We want a workspace running this build
 * against a future-modified page tree to *see* that a data-bound block is
 * present but not yet rendering, rather than silently dropping it.
 *
 * Children (Form, Card, List all `accepts_children = true`) are passed
 * through, so a Form's inner Input components still render even though the
 * Form's submit wiring is stubbed.
 */
const NICE_NAMES: Record<string, string> = {
  Form: "Form",
  Table: "Database table",
  Card: "Card view",
  List: "List view",
};

export function DataBoundPlaceholder({
  node,
  def,
  children,
}: BlockRendererProps) {
  const niceName = NICE_NAMES[node.componentType] ?? node.componentType;

  return (
    <div className="my-3 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 font-mono text-neutral-600 dark:text-neutral-400">
          {niceName}
        </span>
        <span className="text-neutral-400 dark:text-neutral-500">
          Data wiring ships with the custom-view runtime ADR
        </span>
      </div>
      {def.acceptsChildren && <div className="ml-2">{children}</div>}
    </div>
  );
}
