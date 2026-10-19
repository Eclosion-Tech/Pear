"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import { useParams } from "next/navigation";
import {
  usePulpOptional,
  type BlockRendererProps as PulpProps,
} from "@eclosion-tech/pulp";
import {
  TrellisSurface,
  defaultRenderers,
  useTrellisField,
  useTrellisAction,
  type BlockRendererProps,
  type RendererCatalog,
} from "@eclosion-tech/trellis-react";
import {
  canonicalJson,
  type ActionEvent,
  type ActionResult,
} from "@eclosion-tech/trellis";
import {
  readPagePanel,
  pagePanelDocument,
  PAGE_PANEL_CATALOG,
  PAGE_PANEL_ACTION,
  commitObservedPagePanel,
  PanelCommitError,
  type PagePanel,
  type PanelParameters,
  type PanelCommit,
} from "@pear/trellis-ui";
import type { DbConnection } from "@/src/module_bindings";
import { usePageAccess } from "@/src/hooks/usePageAccess";
import { blockReferenceHref } from "@/src/lib/blockReferenceLink";

const Editable = createContext(false);
function Input({ node }: BlockRendererProps) {
  const props = JSON.parse(node.props);
  const field = useTrellisField(node.id);
  const editable = useContext(Editable);
  return (
    <label className="my-2 flex flex-col gap-1 text-sm">
      <span>
        {props.label}
        {props.required ? " *" : ""}
      </span>
      <input
        className="rounded border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
        value={field.value}
        placeholder={props.placeholder}
        readOnly={!editable}
        onChange={(event) => field.setValue(event.target.value)}
      />
    </label>
  );
}
function Button({ node }: BlockRendererProps) {
  const action = useTrellisAction(node.id);
  const editable = useContext(Editable);
  return (
    <div className="my-2">
      <button
        type="button"
        disabled={!editable || action.status === "pending"}
        className="rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        onClick={() => void action.invoke()}
      >
        {JSON.parse(node.props).label}
      </button>
      {action.message && (
        <p
          role={
            action.status === "failure" || action.status === "denied"
              ? "alert"
              : "status"
          }
          className="mt-2 text-sm"
        >
          {action.message}
        </p>
      )}
    </div>
  );
}
const renderers: RendererCatalog = { ...defaultRenderers, Input, Button };

export function TrellisPagePanelRenderer({ node }: PulpProps) {
  const access = usePageAccess(node.surfaceId);
  const parsed = useMemo(() => {
    try {
      return { saved: readPagePanel(node.props), error: "" };
    } catch {
      return {
        saved: null,
        error:
          "This saved panel is unsupported or invalid. Its stored content has been retained.",
      };
    }
  }, [node.props]);
  if (!parsed.saved) return <div role="alert">{parsed.error}</div>;
  return (
    <PanelSession
      key={`${access.principal}:${node.id}`}
      saved={parsed.saved}
      surfaceId={node.surfaceId}
      componentId={node.id}
      principal={access.principal}
      canEdit={access.canEdit}
    />
  );
}
function PanelSession({
  saved,
  surfaceId,
  componentId,
  principal,
  canEdit,
}: {
  saved: PagePanel;
  surfaceId: bigint;
  componentId: bigint;
  principal: string;
  canEdit: boolean;
}) {
  const { getConnection } = useSpacetimeDB();
  const route = useParams();
  const workspaceSlug = Array.isArray(route?.slug)
    ? route.slug[0]
    : route?.slug;
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const session = new AbortController();
    lifetime.current = session;
    return () => session.abort();
  }, []);
  const pulp = usePulpOptional();
  const document = useMemo(
    () => pagePanelDocument(saved, String(surfaceId), String(componentId)),
    [saved, surfaceId, componentId],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved.parameters);
  const [originalSettings, setOriginalSettings] = useState(saved.parameters);
  const [baseRevision, setBaseRevision] = useState(saved.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState<PanelCommit | null>(null);
  const pendingAction = useRef<PanelCommit | null>(null);
  const live = useRef({ canEdit, saved });
  live.current = { canEdit, saved };
  const readFrom = useCallback(
    (connection: DbConnection | null) => {
      const row = connection?.db.component_node.id.find(componentId);
      if (
        !row ||
        row.deletedAt != null ||
        row.surfaceId !== surfaceId ||
        row.componentType !== "TrellisPanel"
      )
        return null;
      return readPagePanel(row.props);
    },
    [componentId, surfaceId],
  );
  const read = useCallback(
    () => readFrom(getConnection() as DbConnection | null),
    [getConnection, readFrom],
  );
  const commit = useCallback(
    async (input: PanelCommit, actionSignal?: AbortSignal) => {
      const connection = getConnection() as DbConnection | null;
      const session = lifetime.current;
      function checkSession() {
        if (
          !session ||
          session.signal.aborted ||
          actionSignal?.aborted ||
          connection?.identity?.toHexString() !== principal
        )
          throw new PanelCommitError(
            "SESSION_ENDED",
            "This editing session ended.",
          );
        if (!live.current.canEdit)
          throw new PanelCommitError(
            "AUTHORIZATION_DENIED",
            "Write access to the source page is required.",
          );
      }
      checkSession();
      return commitObservedPagePanel(input, {
        principal,
        signal: session!.signal,
        read: () => {
          checkSession();
          return readFrom(connection);
        },
        commit: (args) => {
          checkSession();
          return connection!.reducers.commitTrellisPanel({
            componentId: args.componentId,
            baseRevision: BigInt(args.baseRevision),
            requestId: args.requestId,
            parametersJson: canonicalJson(args.parameters),
          });
        },
      });
    },
    [principal, getConnection, readFrom],
  );
  const act = useCallback(
    async (
      event: ActionEvent,
      { signal }: { signal: AbortSignal },
    ): Promise<ActionResult> => {
      if (
        event.documentId !==
          `pear-page:${surfaceId}:component:${componentId}` ||
        event.slot !== PAGE_PANEL_ACTION ||
        Object.keys(event.input).length !== 1 ||
        typeof event.input.value !== "string" ||
        !event.input.value.trim()
      )
        return { status: "denied", message: "This note action is invalid." };
      const prior = pendingAction.current;
      const confirmed =
        prior &&
        read()?.receipts.some(
          (receipt) =>
            receipt.principal === principal &&
            receipt.requestId === prior.requestId,
        );
      if (
        prior &&
        !confirmed &&
        prior.parameters.savedNote !== event.input.value
      )
        return {
          status: "denied",
          message:
            "The previous save is unconfirmed. Retry the same note before changing it.",
        };
      const request =
        prior && !confirmed
          ? prior
          : {
              componentId: String(componentId),
              baseRevision: event.revision,
              requestId: `note:${event.invocationId}`,
              parameters: { savedNote: event.input.value },
            };
      pendingAction.current = request;
      try {
        await commit(request, signal);
        pendingAction.current = null;
        return { status: "success", message: "Note saved." };
      } catch (caught) {
        if (
          !(caught instanceof PanelCommitError) ||
          caught.code !== "COMMIT_UNCONFIRMED"
        )
          pendingAction.current = null;
        return {
          status:
            caught instanceof PanelCommitError &&
            ["STALE_REVISION", "AUTHORIZATION_DENIED"].includes(caught.code)
              ? "denied"
              : "failure",
          message:
            caught instanceof Error
              ? caught.message
              : "The host did not confirm the note.",
        };
      }
    },
    [componentId, surfaceId, principal, read, commit],
  );
  function reloadSettings() {
    setDraft({ ...saved.parameters });
    setOriginalSettings({ ...saved.parameters });
    setBaseRevision(saved.revision);
    setAttempt(null);
    setError("");
  }
  async function saveSettings() {
    const session = lifetime.current;
    const request = attempt ?? {
      componentId: String(componentId),
      baseRevision,
      requestId: `settings:${crypto.randomUUID()}`,
      parameters: Object.fromEntries(
        Object.entries(draft).filter(
          ([key, value]) =>
            value !== originalSettings[key as keyof PanelParameters],
        ),
      ),
    };
    setBusy(true);
    setError("");
    try {
      await commit(request);
      if (session?.signal.aborted) return;
      setEditing(false);
      setAttempt(null);
    } catch (caught) {
      if (session?.signal.aborted) return;
      setAttempt(
        caught instanceof PanelCommitError &&
          caught.code === "COMMIT_UNCONFIRMED"
          ? request
          : null,
      );
      setError(
        caught instanceof PanelCommitError && caught.code === "STALE_REVISION"
          ? "This panel changed while you were editing. Your settings draft is still here. Reload saved settings before proposing another edit."
          : caught instanceof Error
            ? caught.message
            : "The settings were not confirmed.",
      );
    } finally {
      if (!session?.signal.aborted) setBusy(false);
    }
  }
  const labels: Record<keyof PanelParameters, string> = {
    title: "Panel title",
    body: "Panel description",
    savedNote: "Saved note",
    fieldLabel: "Field label",
    placeholder: "Placeholder",
    defaultValue: "Initial value",
  };
  return (
    <section
      aria-label="Page note panel"
      data-trellis-page-panel={String(componentId)}
      className="my-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700 [&_h2]:text-xl [&_h2]:font-semibold [&_p]:my-2"
    >
      <div className="mb-3 flex items-center gap-3 text-xs text-neutral-500">
        <a
          href={blockReferenceHref(
            { surfaceId, blockId: componentId },
            workspaceSlug,
          )}
        >
          Open source
        </a>
        <span aria-label="Panel revision">Revision {saved.revision}</span>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              reloadSettings();
              setEditing(true);
            }}
          >
            Edit panel
          </button>
        )}
        {pulp?.config.onCommentBlock && canEdit && (
          <button
            type="button"
            onClick={() => pulp.config.onCommentBlock?.(componentId)}
          >
            Discuss panel
          </button>
        )}
        {!canEdit && <span>Read only</span>}
      </div>
      <Editable.Provider value={canEdit}>
        <TrellisSurface
          document={document}
          catalog={PAGE_PANEL_CATALOG}
          renderers={renderers}
          principalKey={principal}
          onAction={act}
        />
      </Editable.Provider>
      {editing && (
        <form
          aria-label="Panel settings"
          className="mt-4 space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-700"
          onSubmit={(event) => {
            event.preventDefault();
            void saveSettings();
          }}
        >
          <fieldset
            disabled={!canEdit || busy || attempt !== null}
            className="space-y-3"
          >
            {(Object.keys(labels) as Array<keyof PanelParameters>).map(
              (key) => (
                <label key={key} className="flex flex-col gap-1 text-sm">
                  <span>{labels[key]}</span>
                  <input
                    className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
                    value={draft[key]}
                    maxLength={
                      key === "title" ||
                      key === "fieldLabel" ||
                      key === "placeholder"
                        ? 160
                        : 4000
                    }
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ),
            )}
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <div className="flex gap-3 text-sm">
            <button type="submit" disabled={busy || !canEdit}>
              {busy ? "Saving…" : attempt ? "Retry save" : "Save settings"}
            </button>
            <button type="button" disabled={busy} onClick={reloadSettings}>
              Reload saved settings
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
