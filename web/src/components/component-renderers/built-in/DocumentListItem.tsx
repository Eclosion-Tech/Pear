"use client";

import { useMemo } from "react";
import {
  RichTextRenderer,
  usePulp,
  type BlockRendererProps,
} from "@eclosion-tech/pulp";

/** Align list markers with the first line of editable text (matches RichText min-height). */
const MARKER_ROW = "flex h-[1.5em] shrink-0 items-center";

type ChecklistProps = {
  checked?: boolean;
};

export function BulletListItemRenderer(props: BlockRendererProps) {
  return (
    <div className="flex items-start gap-2">
      <span className={`${MARKER_ROW} w-4 justify-center`} aria-hidden>
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 dark:bg-neutral-400" />
      </span>
      <div className="min-w-0 flex-1">
        <RichTextRenderer {...props} />
        <NestedListChildren>{props.children}</NestedListChildren>
      </div>
    </div>
  );
}

export function NumberedListItemRenderer(props: BlockRendererProps) {
  const index = useMemo(() => contiguousNumberFor(props), [props]);

  return (
    <div className="flex items-start gap-2">
      <span
        className={`${MARKER_ROW} min-w-5 justify-end text-sm tabular-nums text-neutral-500 dark:text-neutral-400`}
      >
        {index}.
      </span>
      <div className="min-w-0 flex-1">
        <RichTextRenderer {...props} />
        <NestedListChildren>{props.children}</NestedListChildren>
      </div>
    </div>
  );
}

export function ChecklistItemRenderer(props: BlockRendererProps) {
  const parsed = useMemo<ChecklistProps>(() => safeParse(props.node.props), [props.node.props]);
  const { updateBlockProps } = usePulp();
  const checked = parsed.checked ?? false;

  return (
    <div className="flex items-start gap-2">
      <span className={`${MARKER_ROW} w-4 justify-center`}>
        <button
          type="button"
          aria-pressed={checked}
          aria-label={checked ? "Mark incomplete" : "Mark complete"}
          className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
            checked
              ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
              : "border-neutral-300 bg-transparent text-transparent hover:border-neutral-500 dark:border-neutral-600 dark:hover:border-neutral-300"
          }`}
          onClick={() => {
            updateBlockProps({
              componentId: props.node.id,
              propsJson: JSON.stringify({ ...parsed, checked: !checked }),
            });
          }}
        >
          <CheckIcon />
        </button>
      </span>
      <div className={`min-w-0 flex-1 ${checked ? "opacity-60 line-through" : ""}`}>
        <RichTextRenderer {...props} />
        <NestedListChildren>{props.children}</NestedListChildren>
      </div>
    </div>
  );
}

function NestedListChildren({ children }: { children: React.ReactNode }) {
  return <div className="ml-4">{children}</div>;
}

function contiguousNumberFor({ node, tree }: BlockRendererProps): number {
  if (node.parentId == null) return 1;
  const siblings = tree.byParent.get(node.parentId) ?? [];
  const idx = siblings.findIndex((s) => s.id === node.id);
  if (idx < 0) return 1;

  let count = 1;
  for (let i = idx - 1; i >= 0; i--) {
    if (siblings[i]?.componentType !== "NumberedListItem") break;
    count++;
  }
  return count;
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function safeParse(s: string): ChecklistProps {
  try {
    return JSON.parse(s) as ChecklistProps;
  } catch {
    return {};
  }
}
