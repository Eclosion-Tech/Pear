"use client";
import { useCallback, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useSpacetimeDB } from "spacetimedb/react";
import { usePulpOptional, type BlockRendererProps } from "@eclosion-tech/pulp";
import { RetainedInterfaceView } from "@eclosion-tech/trellis-react";
import { canonicalJson, observeInterfaceCommit, type InterfaceCommit } from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY, readPageInterface } from "@pear/trellis-ui";
import { usePageAccess } from "@/src/hooks/usePageAccess";
import { blockReferenceHref } from "@/src/lib/blockReferenceLink";
import type { DbConnection } from "@/src/module_bindings";

export function RetainedPageInterfaceRenderer({ node }: BlockRendererProps) {
  const access = usePageAccess(node.surfaceId), { getConnection } = useSpacetimeDB(), route = useParams(), pulp = usePulpOptional();
  const workspace = Array.isArray(route?.slug) ? route.slug[0] : route?.slug;
  const live = useRef(access); live.current = access;
  const parsed = useMemo(() => { try { return { saved: readPageInterface(node.props, String(node.surfaceId), String(node.id)), error: "" }; } catch { return { saved: null, error: "This saved interface is unsupported or invalid. Its stored content has been retained." }; } }, [node.props, node.id, node.surfaceId]);
  const commit = useCallback(async (request: InterfaceCommit, signal: AbortSignal) => {
    const connection = getConnection() as DbConnection | null, principal = live.current.principal;
    function check() {
      if (signal.aborted || connection?.identity?.toHexString() !== principal || live.current.principal !== principal) throw new Error("SESSION_ENDED: This editing session ended.");
      if (!live.current.canEdit) throw new Error("Caller lacks write access on this page");
    }
    check();
    return observeInterfaceCommit(request, {
      registry: INTERFACE_REGISTRY, principal, signal,
      write: args => { check(); return connection!.reducers.commitTrellisPanel({ componentId: String(node.id), baseRevision: BigInt(args.baseRevision), requestId: args.requestId, parametersJson: canonicalJson(args.command) }); },
      read: () => {
        check();
        const row = connection!.db.component_node.id.find(node.id);
        if (!row || row.deletedAt != null || row.surfaceId !== node.surfaceId || row.componentType !== "TrellisPanel") throw new Error("Source interface is deleted or unavailable.");
        return readPageInterface(row.props, String(node.surfaceId), String(node.id));
      },
    });
  }, [getConnection, node.id, node.surfaceId]);
  if (!parsed.saved) return <div role="alert">{parsed.error}</div>;
  return <section aria-label="Page interface" data-trellis-page-panel={String(node.id)} className="my-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700 [&_input]:rounded [&_input]:border [&_input]:border-neutral-400 [&_input]:bg-transparent [&_input]:p-2 [&_button]:rounded [&_button]:border [&_button]:px-2 [&_button]:py-1 [&_h2]:text-xl [&_h2]:font-semibold">
    <div className="mb-3 flex items-center gap-3 text-xs text-neutral-500"><a href={blockReferenceHref({ surfaceId: node.surfaceId, blockId: node.id }, workspace)}>Open source</a>{pulp?.config.onCommentBlock && access.canEdit && <button type="button" onClick={() => pulp.config.onCommentBlock?.(node.id)}>Discuss panel</button>}</div>
    <RetainedInterfaceView saved={parsed.saved} registry={INTERFACE_REGISTRY} principalKey={access.principal} canEdit={access.canEdit} onCommit={commit} />
  </section>;
}
