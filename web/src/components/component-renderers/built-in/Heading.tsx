"use client";

import { useMemo } from "react";
import type { ComponentRendererProps } from "../registry";

/**
 * Built-in `Heading` component. Text headings, levels 1–6.
 *
 * Prop schema (`prop_schemas::HEADING` in components.rs):
 *   { level: integer 1..6 (required),
 *     text: string (required) }
 *
 * Heading is not Yjs-backed at v1 — the title text lives on
 * `ComponentNode.props.text` and edits go through `update_component_props`
 * directly (no per-character collab). This matches the substrate's
 * `has_yjs_state: false` for Heading; co-editing headings can be promoted
 * later by flipping that flag and migrating the text into a Y.Doc.
 */
type HeadingProps = {
  level?: number;
  text?: string;
};

const SIZE_CLASS: Record<number, string> = {
  1: "text-4xl font-bold mt-8 mb-3",
  2: "text-3xl font-bold mt-6 mb-2",
  3: "text-2xl font-semibold mt-5 mb-2",
  4: "text-xl font-semibold mt-4 mb-2",
  5: "text-lg font-medium mt-3 mb-1",
  6: "text-base font-medium mt-3 mb-1",
};

export function HeadingRenderer({ node }: ComponentRendererProps) {
  const props = useMemo<HeadingProps>(() => safeParse(node.props), [node.props]);

  const level = clampLevel(props.level);
  const text = props.text ?? "";
  const cls = `${SIZE_CLASS[level]} text-neutral-900 dark:text-neutral-100`;

  switch (level) {
    case 1:
      return <h1 className={cls}>{text}</h1>;
    case 2:
      return <h2 className={cls}>{text}</h2>;
    case 3:
      return <h3 className={cls}>{text}</h3>;
    case 4:
      return <h4 className={cls}>{text}</h4>;
    case 5:
      return <h5 className={cls}>{text}</h5>;
    case 6:
      return <h6 className={cls}>{text}</h6>;
  }
}

function clampLevel(raw: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 6) return 6;
  return Math.floor(n) as 1 | 2 | 3 | 4 | 5 | 6;
}

function safeParse(s: string): HeadingProps {
  try {
    return JSON.parse(s) as HeadingProps;
  } catch {
    return {};
  }
}
