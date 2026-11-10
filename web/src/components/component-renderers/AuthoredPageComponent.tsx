"use client";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useSpacetimeDB } from "spacetimedb/react";
import { usePulpOptional, type BlockRendererProps } from "@eclosion-tech/pulp";
import { AuthoredComponentView } from "@eclosion-tech/trellis-react";
import {
  canonicalJson,
  createComponentDataSession,
  observeComponentCommit,
  type ComponentCommit,
} from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY, readPageComponent } from "@pear/trellis-ui";
import { usePageAccess } from "@/src/hooks/usePageAccess";
import { useOpenWorkspaceRecord } from "@/src/hooks/useOpenWorkspaceRecord";
import { useComponentData } from "@/src/hooks/useComponentData";
import { blockReferenceHref } from "@/src/lib/blockReferenceLink";
import { HostSourceRegistry } from "@/src/lib/repeater/hostSources";
import type { DbConnection } from "@/src/module_bindings";
import { SaveComponentTemplate } from "./ComponentTemplateLibrary";
import { RecordDetailPanel, useOpenRecordPanel } from "./RecordDetailPanel";
export function AuthoredPageComponentRenderer({ node }: BlockRendererProps) {
  const access = usePageAccess(node.surfaceId),
    { getConnection } = useSpacetimeDB(),
    route = useParams(),
    pulp = usePulpOptional();
  const workspace = Array.isArray(route?.slug) ? route.slug[0] : route?.slug;
  const live = useRef(access);
  live.current = access;
  const parsed = useMemo(() => {
    try {
      return readPageComponent(
        node.props,
        String(node.surfaceId),
        String(node.id),
      );
    } catch {
      return null;
    }
  }, [node.props, node.surfaceId, node.id]);
  const read = useCallback(() => {
    const connection = getConnection() as DbConnection | null,
      row = connection?.db.component_node.id.find(node.id);
    if (
      !row ||
      row.deletedAt != null ||
      row.surfaceId !== node.surfaceId ||
      row.componentType !== "TrellisPanel"
    )
      throw new Error("Source component is deleted or unavailable.");
    return readPageComponent(
      row.props,
      String(node.surfaceId),
      String(node.id),
    );
  }, [getConnection, node.id, node.surfaceId]);
  const commit = useCallback(
    async (request: ComponentCommit, signal: AbortSignal) => {
      const connection = getConnection() as DbConnection | null,
        principal = live.current.principal;
      const check = () => {
        if (
          signal.aborted ||
          connection?.identity?.toHexString() !== principal ||
          live.current.principal !== principal
        )
          throw new Error("SESSION_ENDED: This editing session ended.");
        if (!live.current.canEdit)
          throw new Error("Caller lacks write access on this page");
      };
      check();
      return observeComponentCommit(request, {
        catalog: INTERFACE_REGISTRY.catalog,
        principal,
        signal,
        write: (args) => {
          check();
          return connection!.reducers.commitTrellisPanel({
            componentId: String(node.id),
            baseRevision: BigInt(args.baseRevision),
            requestId: args.requestId,
            parametersJson: canonicalJson(args.command),
          });
        },
        read: () => {
          check();
          return read();
        },
      });
    },
    [getConnection, node.id, read],
  );
  const data = useComponentData(node.surfaceId, commit, read);
  const workspaceAdapter = data.dataAdapters["pear.database"];
  const registry = useContext(HostSourceRegistry);
  const surfaceId = parsed?.document.documentId;
  // Pulp's `host` entity addresses a numeric surface id; the component node id
  // is that identity, while the document id identifies the view for opens.
  const hostSurfaceId = node.id.toString();
  const sources = parsed?.sources;
  useEffect(() => {
    if (!registry || !sources) return;
    // AuthoredComponentView owns private sessions; repeaters need their own.
    const entries = Object.fromEntries(
      Object.entries(sources).filter(([, source]) => source.connection).map(([id, source]) => [id, {
        source,
        session: createComponentDataSession({ ...source, mode: "query" }, workspaceAdapter),
      }]),
    );
    const unregister = registry.register(hostSurfaceId, entries);
    return () => {
      unregister();
      for (const { session } of Object.values(entries)) session.close();
    };
  }, [registry, hostSurfaceId, sources, workspaceAdapter]);
  const { openRecord, onOpenRecord: openPanel, onClose } = useOpenRecordPanel(workspace ?? "", surfaceId);
  const { onOpenRecord, message: openRecordMessage } = useOpenWorkspaceRecord({
    workspace, surfaceId, principal: access.principal, sources, read,
    adapter: workspaceAdapter, openPanel,
  });
  if (!parsed)
    return (
      <p role="alert">
        This saved component is invalid or unsupported. Its stored definition
        has been retained.
      </p>
    );
  return (
    <section
      aria-label="Page component"
      data-trellis-page-panel={String(node.id)}
      className="trellis-authored-component my-4 min-w-0"
    >
      <AuthoredComponentView
        saved={parsed}
        catalog={INTERFACE_REGISTRY.catalog}
        principalKey={access.principal}
        canEdit={access.canEdit}
        onCommit={commit}
        workspace={workspace}
        onOpenRecord={onOpenRecord}
        {...data}
        onDiscuss={
          pulp?.config.onCommentBlock && access.canEdit
            ? () => pulp.config.onCommentBlock?.(node.id)
            : undefined
        }
        menuActions={
          <>
            <a
              href={blockReferenceHref(
                { surfaceId: node.surfaceId, blockId: node.id },
                workspace,
              )}
            >
              Open source
            </a>
            <SaveComponentTemplate
              saved={parsed}
              registry={INTERFACE_REGISTRY}
              componentId={String(node.id)}
              principal={access.principal}
              canEdit={access.canEdit}
            />
          </>
        }
      />
      {openRecordMessage && <p role="status">{openRecordMessage}</p>}
      {openRecord && (
        <RecordDetailPanel
          key={canonicalJson([openRecord, access.principal])}
          recordRef={openRecord}
          source={Object.hasOwn(parsed.sources, openRecord.source) ? parsed.sources[openRecord.source] : undefined}
          adapter={data.dataAdapters[parsed.sources[openRecord.source]?.connection?.adapter ?? "pear.database"]}
          onClose={onClose}
        />
      )}
    </section>
  );
}
