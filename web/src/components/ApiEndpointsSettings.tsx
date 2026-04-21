"use client";

import { useState, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useApiEndpoints,
  useApiFieldMappings,
  useCreateApiEndpoint,
  useUpdateApiEndpoint,
  useDeleteApiEndpoint,
  useUpdateApiFieldMapping,
  useDeleteApiFieldMapping,
  useCreateApiFieldMapping,
  type ApiEndpointRow,
} from "@/src/hooks/useApiEndpoints";
import { useIdentityDriftRecovery } from "@/src/hooks/useIdentityDriftRecovery";
import { resolveEndpointUrl } from "@/src/lib/api-endpoint";
import { ApiEndpointKeysPanel } from "./api-endpoints/ApiEndpointKeysPanel";

/**
 * Stoplight Elements is a ~600KB dependency that's only needed when the
 * operator opens the API docs panel for an endpoint. Loading it via
 * `next/dynamic({ ssr: false })` keeps it out of the main settings bundle
 * and out of the SSR pass entirely (it touches `window` on import).
 */
const ApiEndpointsDocsPanel = dynamic(
  () => import("./ApiEndpointsDocsPanel"),
  {
    ssr: false,
    loading: () => (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Loading API docs…
      </p>
    ),
  }
);

/**
 * Parse `acme` from `/workspace/acme/settings` so the URL template can
 * substitute `{workspaceSlug}` even though Pear's OSS routes are
 * workspace-agnostic.
 */
function getCurrentWorkspaceSlug(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^\/workspace\/([^/]+)/);
  return match?.[1] ?? "";
}

function buildEndpointUrl(endpointSlug: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  return resolveEndpointUrl({
    template: process.env.NEXT_PUBLIC_PEAR_API_URL_TEMPLATE,
    workspaceSlug: getCurrentWorkspaceSlug(),
    endpointSlug,
    origin,
  });
}

function buildEndpointDisplayPath(endpointSlug: string): string {
  // Used by the list-row label where we want a short path-style preview
  // independent of the absolute URL. Strips the scheme + host from the
  // resolved URL so it stays compact when the operator points the UI at a
  // multi-tenant gateway.
  const url = buildEndpointUrl(endpointSlug);
  try {
    const parsed = new URL(url);
    return parsed.pathname || `/${endpointSlug}`;
  } catch {
    return `/api/e/${endpointSlug}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpMethodLabel(tag: string) {
  switch (tag) {
    case "Get":
      return "GET";
    case "Post":
      return "POST";
    case "Patch":
      return "PATCH";
    case "Delete":
      return "DELETE";
    default:
      return tag;
  }
}

function allowedMethodsList(endpoint: ApiEndpointRow) {
  return endpoint.allowedMethods
    .map((m) => httpMethodLabel(m.tag))
    .join(", ");
}

// ── Create Endpoint Form ──────────────────────────────────────────────────────

function CreateEndpointForm({ onClose }: { onClose: () => void }) {
  const [pages] = useTable(tables.page);
  const databases = useMemo(
    () => pages.filter((p) => p.pageType.tag === "Database" && p.deletedAt == null),
    [pages]
  );

  const [databasePageId, setDatabasePageId] = useState("");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [methods, setMethods] = useState({
    Get: true,
    Post: true,
    Patch: true,
    Delete: false,
  });
  const [requireAuth, setRequireAuth] = useState(true);
  const [error, setError] = useState("");

  const createEndpoint = useCreateApiEndpoint();
  const checkDrift = useIdentityDriftRecovery();

  async function handleCreate() {
    setError("");
    if (!databasePageId) {
      setError("Select a database");
      return;
    }
    if (!slug.trim()) {
      setError("Slug is required");
      return;
    }
    if (!displayName.trim()) {
      setError("Display name is required");
      return;
    }

    const allowedMethods = (
      Object.entries(methods) as [string, boolean][]
    )
      .filter(([, v]) => v)
      .map(([k]) => ({ tag: k }));

    if (allowedMethods.length === 0) {
      setError("At least one method must be enabled");
      return;
    }

    try {
      await createEndpoint({
        databasePageId: BigInt(databasePageId),
        slug: slug.trim().toLowerCase(),
        displayName: displayName.trim(),
        description: description.trim(),
        allowedMethods: allowedMethods as never,
        requireAuth,
      });
      onClose();
    } catch (err) {
      if (checkDrift(err, "create the API endpoint")) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mt-4 p-4 border border-neutral-200 dark:border-neutral-700 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
      <h3 className="text-sm font-medium text-neutral-900 dark:text-white mb-3">
        Create API Endpoint
      </h3>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
            Database
          </label>
          <select
            value={databasePageId}
            onChange={(e) => setDatabasePageId(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white"
          >
            <option value="">Select a database...</option>
            {databases.map((db) => (
              <option key={String(db.id)} value={String(db.id)}>
                {db.title || "Untitled"}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
              URL Slug
            </label>
            <div className="flex items-center">
              <span
                className="text-xs text-neutral-400 dark:text-neutral-500 mr-1 truncate max-w-[60%]"
                title={buildEndpointDisplayPath("").replace(/\/+$/, "") + "/"}
              >
                {buildEndpointDisplayPath("").replace(/\/+$/, "") + "/"}
              </span>
              <input
                type="text"
                value={slug}
                onChange={(e) =>
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                }
                placeholder="tickets"
                className="flex-1 px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Tickets"
              className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="External API for creating and reading tickets"
            className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white"
          />
        </div>

        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
            Allowed Methods
          </label>
          <div className="flex gap-3">
            {(["Get", "Post", "Patch", "Delete"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={methods[m]}
                  onChange={(e) =>
                    setMethods({ ...methods, [m]: e.target.checked })
                  }
                  className="rounded border-neutral-300 dark:border-neutral-600"
                />
                {httpMethodLabel(m)}
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={requireAuth}
            onChange={(e) => setRequireAuth(e.target.checked)}
            className="rounded border-neutral-300 dark:border-neutral-600"
          />
          Require API key authentication
        </label>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="px-3 py-1.5 text-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:opacity-90 transition-opacity"
          >
            Create Endpoint
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Field Mapping Editor ──────────────────────────────────────────────────────

function FieldMappingRow({
  mapping,
  propertyName,
}: {
  mapping: ReturnType<typeof useApiFieldMappings>["mappings"][number];
  propertyName: string;
}) {
  const [editing, setEditing] = useState(false);
  const [fieldName, setFieldName] = useState(mapping.fieldName);
  const [required, setRequired] = useState(mapping.requiredOnCreate);
  const [readOnly, setReadOnly] = useState(mapping.readOnly);

  const updateMapping = useUpdateApiFieldMapping();
  const deleteMapping = useDeleteApiFieldMapping();
  const checkDrift = useIdentityDriftRecovery();

  async function handleSave() {
    try {
      await updateMapping({
        mappingId: mapping.id,
        fieldName: fieldName.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""),
        requiredOnCreate: required,
        defaultValue: mapping.defaultValue ?? undefined,
        readOnly,
        fieldOrder: mapping.fieldOrder,
      });
      setEditing(false);
    } catch (err) {
      if (checkDrift(err, "update the field mapping")) return;
      alert(
        `Failed to update field mapping: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async function handleDelete() {
    try {
      await deleteMapping({ mappingId: mapping.id });
    } catch (err) {
      if (checkDrift(err, "delete the field mapping")) return;
      alert(
        `Failed to delete field mapping: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  if (editing) {
    return (
      <tr className="border-b border-neutral-100 dark:border-neutral-800">
        <td className="py-2 pr-3 text-sm text-neutral-500 dark:text-neutral-400">
          {propertyName}
        </td>
        <td className="py-2 pr-3">
          <input
            type="text"
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value)}
            className="w-full px-2 py-0.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white font-mono"
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
          />
        </td>
        <td className="py-2 pr-3 text-center">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="rounded border-neutral-300 dark:border-neutral-600"
          />
        </td>
        <td className="py-2 pr-3 text-center">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
            className="rounded border-neutral-300 dark:border-neutral-600"
          />
        </td>
        <td className="py-2 text-right">
          <button
            onClick={handleSave}
            className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white mr-2"
          >
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            Cancel
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-neutral-100 dark:border-neutral-800 group">
      <td className="py-2 pr-3 text-sm text-neutral-500 dark:text-neutral-400">
        {propertyName}
      </td>
      <td className="py-2 pr-3 text-sm font-mono text-neutral-700 dark:text-neutral-300">
        {mapping.fieldName}
      </td>
      <td className="py-2 pr-3 text-center text-sm text-neutral-500 dark:text-neutral-400">
        {mapping.requiredOnCreate ? "Yes" : "—"}
      </td>
      <td className="py-2 pr-3 text-center text-sm text-neutral-500 dark:text-neutral-400">
        {mapping.readOnly ? "Yes" : "—"}
      </td>
      <td className="py-2 text-right opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mr-2"
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

// ── Disable Auth Confirm Modal ────────────────────────────────────────────────

/**
 * "Are you absolutely sure" modal shown before turning auth off on an
 * existing endpoint. Removing auth converts a private API into a fully
 * public, internet-reachable mutation surface — that's almost never what
 * the operator wants by accident, so we require typing the slug to
 * confirm rather than relying on a single click.
 */
function DisableAuthConfirmModal({
  endpoint,
  onCancel,
  onConfirm,
}: {
  endpoint: ApiEndpointRow;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === endpoint.slug;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-white dark:bg-neutral-900 border border-red-300 dark:border-red-800 shadow-xl p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="text-red-600 dark:text-red-400 text-2xl leading-none">
            !
          </div>
          <div>
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">
              Make this endpoint public?
            </h3>
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
              You're about to disable authentication on{" "}
              <span className="font-mono text-neutral-900 dark:text-white">
                {endpoint.slug}
              </span>
              . Anyone on the internet who knows the URL will be able to{" "}
              {endpoint.allowedMethods.length > 1 ? "read and modify" : "call"}{" "}
              data in this database. There is no rate limit beyond what the
              host enforces.
            </p>
          </div>
        </div>

        <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-1.5">
          Type the slug{" "}
          <span className="font-mono text-neutral-900 dark:text-white">
            {endpoint.slug}
          </span>{" "}
          to confirm:
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white font-mono"
          placeholder={endpoint.slug}
        />

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
          >
            Cancel
          </button>
          <button
            disabled={!matches}
            onClick={() => {
              if (matches) onConfirm();
            }}
            className="px-3 py-1.5 text-xs rounded bg-red-600 hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900/50 disabled:cursor-not-allowed text-white"
          >
            Make public
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recent API Calls Panel ────────────────────────────────────────────────────

const HTTP_STATUS_TONE: Array<{
  test: (code: number) => boolean;
  className: string;
}> = [
  { test: (c) => c < 300, className: "text-green-600 dark:text-green-400" },
  { test: (c) => c < 400, className: "text-blue-600 dark:text-blue-400" },
  { test: (c) => c < 500, className: "text-amber-600 dark:text-amber-400" },
  { test: () => true, className: "text-red-600 dark:text-red-400" },
];

function statusToneClassName(code: number): string {
  return HTTP_STATUS_TONE.find((t) => t.test(code))!.className;
}

function formatRelativeTime(at: { toDate: () => Date } | Date): string {
  const date = at instanceof Date ? at : at.toDate();
  const diffMs = Date.now() - date.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return date.toLocaleString();
}

function EndpointRecentCalls({ endpointId }: { endpointId: bigint }) {
  const [logs] = useTable(tables.api_call_log);
  const recent = useMemo(() => {
    return logs
      .filter((row) => row.endpointId === endpointId)
      .sort((a, b) => {
        const aMs = a.at.toDate().getTime();
        const bMs = b.at.toDate().getTime();
        return bMs - aMs;
      })
      .slice(0, 20);
  }, [logs, endpointId]);

  if (recent.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        No requests yet.
      </p>
    );
  }

  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b border-neutral-200 dark:border-neutral-700">
          <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            When
          </th>
          <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Method
          </th>
          <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Path
          </th>
          <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400 text-right">
            Status
          </th>
          <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400 text-right">
            Latency
          </th>
          <th className="py-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Caller
          </th>
        </tr>
      </thead>
      <tbody>
        {recent.map((row) => (
          <tr
            key={String(row.id)}
            className="border-b border-neutral-100 dark:border-neutral-800"
          >
            <td className="py-1.5 pr-3 text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
              {formatRelativeTime(row.at)}
            </td>
            <td className="py-1.5 pr-3 text-xs font-mono text-neutral-700 dark:text-neutral-300">
              {httpMethodLabel(row.method.tag)}
            </td>
            <td
              className="py-1.5 pr-3 text-xs font-mono text-neutral-700 dark:text-neutral-300 truncate max-w-[260px]"
              title={row.path}
            >
              {row.path}
            </td>
            <td
              className={`py-1.5 pr-3 text-xs font-mono text-right ${statusToneClassName(row.statusCode)}`}
            >
              {row.statusCode}
            </td>
            <td className="py-1.5 pr-3 text-xs text-neutral-500 dark:text-neutral-400 text-right">
              {row.latencyMs}ms
            </td>
            <td className="py-1.5 text-xs text-neutral-500 dark:text-neutral-400 font-mono truncate max-w-[140px]">
              {row.callerIp ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Endpoint Detail ───────────────────────────────────────────────────────────

function EndpointDetail({
  endpoint,
  onClose,
}: {
  endpoint: ApiEndpointRow;
  onClose: () => void;
}) {
  const { mappings } = useApiFieldMappings();
  const endpointMappings = useMemo(
    () =>
      mappings
        .filter((m) => m.endpointId === endpoint.id)
        .sort((a, b) => a.fieldOrder - b.fieldOrder),
    [mappings, endpoint.id]
  );

  const [propDefs] = useTable(tables.property_definition);
  const [schemas] = useTable(tables.database_schema);

  const schema = useMemo(
    () => schemas.find((s) => s.pageId === endpoint.databasePageId),
    [schemas, endpoint.databasePageId]
  );

  const propDefsForDb = useMemo(
    () =>
      schema
        ? propDefs
            .filter((d) => d.schemaId === schema.id)
            .sort((a, b) => a.order - b.order)
        : [],
    [propDefs, schema]
  );

  const propNameMap = useMemo(() => {
    const map = new Map<bigint, string>();
    for (const d of propDefsForDb) {
      map.set(d.id, d.name);
    }
    return map;
  }, [propDefsForDb]);

  const deleteEndpoint = useDeleteApiEndpoint();
  const updateEndpoint = useUpdateApiEndpoint();
  const checkDrift = useIdentityDriftRecovery();

  const [disableAuthModalOpen, setDisableAuthModalOpen] = useState(false);
  const [showDocs, setShowDocs] = useState(false);

  const endpointUrl = useMemo(
    () => buildEndpointUrl(endpoint.slug),
    [endpoint.slug]
  );
  const schemaUrl = useMemo(
    () => `${endpointUrl}/_schema`,
    [endpointUrl]
  );

  async function applyAuthChange(nextRequireAuth: boolean) {
    try {
      await updateEndpoint({
        endpointId: endpoint.id,
        slug: endpoint.slug,
        displayName: endpoint.displayName,
        description: endpoint.description,
        allowedMethods: endpoint.allowedMethods,
        requireAuth: nextRequireAuth,
      });
    } catch (err) {
      if (checkDrift(err, "update the endpoint's auth setting")) return;
      alert(
        `Failed to update endpoint: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async function handleDeleteEndpoint() {
    if (
      !confirm(
        `Delete endpoint "${endpoint.displayName}"? This will also delete all field mappings and API keys.`
      )
    ) {
      return;
    }
    try {
      await deleteEndpoint({ endpointId: endpoint.id });
      onClose();
    } catch (err) {
      if (checkDrift(err, "delete the endpoint")) return;
      alert(
        `Failed to delete endpoint: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  function handleAuthToggleClick() {
    if (endpoint.requireAuth) {
      // Disabling — gate behind the confirm modal.
      setDisableAuthModalOpen(true);
    } else {
      // Re-enabling auth is always safe and doesn't need confirmation.
      applyAuthChange(true);
    }
  }

  return (
    <div className="mt-4 p-4 border border-neutral-200 dark:border-neutral-700 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-neutral-900 dark:text-white">
          {endpoint.displayName}
        </h3>
        <button
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          Close
        </button>
      </div>

      <div className="space-y-4">
        {/* Endpoint URL */}
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
            Endpoint URL
          </label>
          <code className="block text-sm bg-white dark:bg-neutral-800 px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 font-mono text-neutral-700 dark:text-neutral-300">
            {endpointUrl}
          </code>
        </div>

        {/* Quick curl example */}
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
            Example
          </label>
          <code className="block text-xs bg-white dark:bg-neutral-800 px-3 py-2 rounded border border-neutral-200 dark:border-neutral-700 font-mono text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap break-all">
            {`curl ${endpointUrl}${endpoint.requireAuth ? ' \\\n  -H "Authorization: Bearer <key>"' : ""}`}
          </code>
        </div>

        {/* OpenAPI link + auth toggle */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <a
            href={schemaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            OpenAPI Schema
          </a>
          <span className="text-neutral-400">|</span>
          <button
            onClick={() => setShowDocs((v) => !v)}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            {showDocs ? "Hide API docs" : "Show API docs"}
          </button>
          <span className="text-neutral-400">|</span>
          <span className="text-neutral-500 dark:text-neutral-400">
            Methods: {allowedMethodsList(endpoint)}
          </span>
          <span className="text-neutral-400">|</span>
          <button
            onClick={handleAuthToggleClick}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${
              endpoint.requireAuth
                ? "text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/20"
                : "text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/20"
            }`}
            title={
              endpoint.requireAuth
                ? "Click to make this endpoint public"
                : "Click to require an API key"
            }
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                endpoint.requireAuth ? "bg-amber-400" : "bg-red-500"
              }`}
            />
            Auth: {endpoint.requireAuth ? "Required" : "Public (no key)"}
          </button>
        </div>

        {/* Stoplight Elements docs panel — lazy-loaded on demand */}
        {showDocs && (
          <div>
            <h4 className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">
              API Docs
            </h4>
            <ApiEndpointsDocsPanel schemaUrl={schemaUrl} />
          </div>
        )}

        {/* Field Mappings */}
        <div>
          <h4 className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">
            Field Mappings
          </h4>
          {endpointMappings.length > 0 ? (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-700">
                  <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    Property
                  </th>
                  <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    API Field
                  </th>
                  <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400 text-center">
                    Required
                  </th>
                  <th className="py-1.5 pr-3 text-xs font-medium text-neutral-500 dark:text-neutral-400 text-center">
                    Read-only
                  </th>
                  <th className="py-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 text-right w-24">
                  </th>
                </tr>
              </thead>
              <tbody>
                {endpointMappings.map((m) => (
                  <FieldMappingRow
                    key={String(m.id)}
                    mapping={m}
                    propertyName={
                      propNameMap.get(m.propertyDefinitionId) ?? "Unknown"
                    }
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              No field mappings configured.
            </p>
          )}
        </div>

        {/* API Keys */}
        <div>
          <h4 className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">
            API Keys
          </h4>
          <ApiEndpointKeysPanel endpointId={endpoint.id} />
        </div>

        {/* Recent Calls */}
        <div>
          <h4 className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">
            Recent Calls
          </h4>
          <EndpointRecentCalls endpointId={endpoint.id} />
        </div>

        {/* Danger zone */}
        <div className="pt-3 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={handleDeleteEndpoint}
            className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
          >
            Delete Endpoint
          </button>
        </div>
      </div>

      {disableAuthModalOpen && (
        <DisableAuthConfirmModal
          endpoint={endpoint}
          onCancel={() => setDisableAuthModalOpen(false)}
          onConfirm={() => {
            applyAuthChange(false);
            setDisableAuthModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ApiEndpointsSettings() {
  const { endpoints, isReady } = useApiEndpoints();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);

  const selectedEndpoint = useMemo(
    () => endpoints.find((e) => e.id === selectedId) ?? null,
    [endpoints, selectedId]
  );

  if (!isReady) return null;

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
          API Endpoints
        </h2>
        <button
          onClick={() => {
            setShowCreate(!showCreate);
            setSelectedId(null);
          }}
          className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          {showCreate ? "Cancel" : "+ New Endpoint"}
        </button>
      </div>

      {endpoints.length === 0 && !showCreate && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 py-3">
          No API endpoints configured. Create one to expose a database for
          external access.
        </p>
      )}

      {/* Endpoint list */}
      {endpoints.map((ep) => (
        <div
          key={String(ep.id)}
          className={`flex items-center justify-between py-3 border-b border-neutral-200 dark:border-neutral-800 ${
            selectedId === ep.id
              ? ""
              : "cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
          } transition-colors`}
          onClick={() => {
            if (selectedId !== ep.id) {
              setSelectedId(ep.id);
              setShowCreate(false);
            }
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                {ep.displayName}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 font-mono">
                {buildEndpointDisplayPath(ep.slug)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              {allowedMethodsList(ep)}
            </span>
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                ep.requireAuth
                  ? "bg-amber-400"
                  : "bg-green-400"
              }`}
              title={ep.requireAuth ? "Auth required" : "Open"}
            />
          </div>
        </div>
      ))}

      {/* Create form */}
      {showCreate && (
        <CreateEndpointForm onClose={() => setShowCreate(false)} />
      )}

      {/* Detail view */}
      {selectedEndpoint && (
        <EndpointDetail
          endpoint={selectedEndpoint}
          onClose={() => setSelectedId(null)}
        />
      )}
    </section>
  );
}
