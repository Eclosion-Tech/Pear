"use client";

import { useMemo } from "react";
import type { BlockRendererProps } from "@eclosion-tech/pulp";

/**
 * Built-in `CodeRef` component — typed pointer to code in an external
 * repository. Read-through is mediated by the outbound MCP server; no
 * direct authority on the workspace substrate (see `PEAR_PROGRAMMING.md` §
 * Code context and `docs/PEAR_RENDERING_SUBSTRATE.md` § What's shipped).
 *
 * Sprint 1 renders the reference as a self-describing pill — repo / path /
 * range — without fetching the actual snippet. Sprint 4 (or a dedicated
 * MCP-rendering ADR) plumbs through to the snippet contents and renders
 * syntax-highlighted code; for now the pill is enough to confirm the
 * component model end-to-end.
 *
 * Prop schema (`prop_schemas::CODE_REF` in components.rs):
 *   { repo: { kind: "git_remote" | "local_path", url?: string, path?: string } (required),
 *     ref: string (required),     // git ref / branch / tag / SHA
 *     path: string (required),    // file path inside the repo
 *     range?: { startLine: integer, endLine: integer },
 *     symbol?: string,
 *     snapshot?: object }
 */
type CodeRefProps = {
  repo?: { kind?: string; url?: string; path?: string };
  ref?: string;
  path?: string;
  range?: { startLine?: number; endLine?: number };
  symbol?: string;
};

export function CodeRefRenderer({ node }: BlockRendererProps) {
  const props = useMemo<CodeRefProps>(() => safeParse(node.props), [node.props]);

  const repoLabel =
    props.repo?.kind === "local_path"
      ? props.repo.path ?? "(local)"
      : props.repo?.url ?? "(remote)";
  const range = props.range
    ? `:L${props.range.startLine ?? "?"}-L${props.range.endLine ?? "?"}`
    : "";

  return (
    <div className="my-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="rounded bg-indigo-100 dark:bg-indigo-900/40 px-1.5 py-0.5 font-mono text-indigo-700 dark:text-indigo-300">
          code
        </span>
        <span className="font-mono text-neutral-700 dark:text-neutral-300">
          {repoLabel}
        </span>
        {props.ref != null && (
          <>
            <span className="text-neutral-300 dark:text-neutral-600">@</span>
            <span className="font-mono text-neutral-700 dark:text-neutral-300">
              {props.ref}
            </span>
          </>
        )}
      </div>
      <div className="mt-1 font-mono text-neutral-900 dark:text-neutral-100">
        {props.path ?? "(no path)"}
        <span className="text-neutral-400 dark:text-neutral-500">{range}</span>
        {props.symbol != null && props.symbol.length > 0 && (
          <span className="ml-2 text-neutral-500 dark:text-neutral-400">
            · {props.symbol}
          </span>
        )}
      </div>
    </div>
  );
}

function safeParse(s: string): CodeRefProps {
  try {
    return JSON.parse(s) as CodeRefProps;
  } catch {
    return {};
  }
}
