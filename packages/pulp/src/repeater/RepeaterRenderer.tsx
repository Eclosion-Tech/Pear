"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { BlockRendererProps } from "../registry";
import type { BlockTree } from "../types";
import { usePulpOptional } from "../context/PulpProvider";
import {
  dataSourceEquals,
  parseDataSource,
  type DataSourceConfig,
  type RepeaterRow,
} from "./dataSource";
import { IncrementalMaterializer } from "./materialize";
import { buildTemplate, templateSignature } from "./template";
import { VirtualNodeView } from "./VirtualNodeView";

const NO_ROWS: ReadonlyArray<RepeaterRow> = [];

function readDataSourceProp(propsJson: string): unknown {
  try {
    const parsed: unknown = JSON.parse(propsJson);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).dataSource
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Visible notice for a repeater that cannot render data. Same defence-in-depth
 * stance as `UnregisteredComponentFallback` and `DataBoundPlaceholder`: a
 * surface that can't evaluate its binding should *say so* rather than render
 * nothing, which is indistinguishable from an empty result.
 */
function RepeaterNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="my-3 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-3 text-xs">
      <span className="rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 font-mono text-neutral-600 dark:text-neutral-400">
        Repeater
      </span>
      <span className="ml-2 text-neutral-500 dark:text-neutral-400">{title}</span>
      {detail && (
        <div className="mt-1 font-mono text-neutral-400 dark:text-neutral-500">{detail}</div>
      )}
    </div>
  );
}

/**
 * The repeater primitive (ADR D1).
 *
 * One stored node with a query and a template, instantiated per result row at
 * render time. The stored children *are* the template (D6) — editing them is
 * ordinary pulp editing on ordinary nodes; only the materialized instances are
 * virtual.
 *
 * Pulp owns materialization and virtual-node rendering; the host owns storage
 * and supplies rows through `config.queryResolver`. Nothing here knows about
 * SpacetimeDB, which is what keeps the primitive OSS-safe and RN-portable.
 */
export const RepeaterRenderer = memo(function RepeaterRenderer({
  node,
  tree,
  children,
}: BlockRendererProps) {
  const pulp = usePulpOptional();
  const resolver = pulp?.config.queryResolver;
  const readOnly = pulp?.config.readOnly ?? false;

  // Template mode shows the stored subtree for editing; data mode shows
  // materialized rows (D6). Read-only surfaces have no reason to show the
  // template, so they never offer the toggle.
  const [showTemplate, setShowTemplate] = useState(false);

  const parsed = useMemo(() => parseDataSource(readDataSourceProp(node.props)), [node.props]);

  // Props are re-parsed every render, so a fresh-but-equal config object would
  // tear down and rebuild the subscription on every delivery. Hold the last
  // structurally-distinct config instead.
  const configRef = useRef<DataSourceConfig | null>(null);
  const nextConfig = parsed.ok ? parsed.config : null;
  if (!dataSourceEquals(configRef.current, nextConfig)) {
    configRef.current = nextConfig;
  }
  const config = configRef.current;

  const [rows, setRows] = useState<ReadonlyArray<RepeaterRow>>(NO_ROWS);

  useEffect(() => {
    if (!resolver || !config) {
      setRows(NO_ROWS);
      return;
    }
    return resolver.subscribe(config, setRows);
  }, [resolver, config]);

  // `tree` changes identity on every delivery; a stable proxy keeps that churn
  // from invalidating every memoized virtual node beneath us. Getters keep the
  // data live even though the object never changes. See `VirtualNodeView`.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const stableTree = useMemo<BlockTree>(
    () => ({
      get root() {
        return treeRef.current.root;
      },
      get byId() {
        return treeRef.current.byId;
      },
      get byParent() {
        return treeRef.current.byParent;
      },
      get defs() {
        return treeRef.current.defs;
      },
      get yjs() {
        return treeRef.current.yjs;
      },
      get loading() {
        return treeRef.current.loading;
      },
    }),
    [],
  );

  const template = useMemo(() => buildTemplate(tree, node.id), [tree, node.id]);
  const signature = useMemo(() => templateSignature(template), [template]);

  // Keyed on the signature, not the template object, so the materializer's
  // cache survives deliveries — see `templateSignature`.
  const materializerRef = useRef<{ sig: string; m: IncrementalMaterializer } | null>(null);
  if (!materializerRef.current || materializerRef.current.sig !== signature) {
    materializerRef.current = {
      sig: signature,
      m: new IncrementalMaterializer(node.id, node.surfaceId, template),
    };
  }
  const materializer = materializerRef.current.m;

  const virtualNodes = useMemo(
    () => (template.length === 0 ? [] : materializer.update(rows)),
    [materializer, rows, template.length],
  );

  const toggle =
    readOnly || !parsed.ok ? null : (
      <button
        type="button"
        onClick={() => setShowTemplate((v) => !v)}
        className="mb-2 rounded border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 text-xs text-neutral-600 dark:text-neutral-400"
      >
        {showTemplate ? "Show data" : "Edit template"}
      </button>
    );

  if (template.length === 0) {
    return (
      <RepeaterNotice
        title="no template — add blocks inside this repeater to define one row"
      />
    );
  }

  if (!parsed.ok) {
    // Template stays editable so a bad binding is recoverable in place.
    return (
      <div>
        <RepeaterNotice title="invalid data source" detail={parsed.error} />
        {children}
      </div>
    );
  }

  if (!resolver) {
    return (
      <div>
        <RepeaterNotice title="no query resolver configured on this surface" />
        {children}
      </div>
    );
  }

  if (showTemplate) {
    return (
      <div>
        {toggle}
        {children}
      </div>
    );
  }

  return (
    <div>
      {toggle}
      {virtualNodes.length === 0 ? (
        <RepeaterNotice title="no rows match this data source" />
      ) : (
        virtualNodes.map((n) => (
          <VirtualNodeView key={String(n.id)} node={n} tree={stableTree} />
        ))
      )}
    </div>
  );
});
