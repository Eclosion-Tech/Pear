"use client";

import { useState, useCallback, useMemo } from "react";
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
  useCreateApiEndpointKey,
  useRevokeApiEndpointKey,
  type ApiEndpointRow,
} from "@/src/hooks/useApiEndpoints";

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

async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
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

  function handleCreate() {
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

    createEndpoint({
      databasePageId: BigInt(databasePageId),
      slug: slug.trim().toLowerCase(),
      displayName: displayName.trim(),
      description: description.trim(),
      allowedMethods: allowedMethods as never,
      requireAuth,
    });
    onClose();
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
              <span className="text-xs text-neutral-400 dark:text-neutral-500 mr-1">
                /api/e/
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

// ── API Key Management ────────────────────────────────────────────────────────

function ApiKeySection({ endpointId }: { endpointId: bigint }) {
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createKey = useCreateApiEndpointKey();

  const handleCreateKey = useCallback(async () => {
    if (!label.trim()) return;

    const rawKey = `pear_${crypto.randomUUID().replace(/-/g, "")}`;
    const keyHash = await sha256Hex(rawKey);

    const allMethods = [
      { tag: "Get" as const },
      { tag: "Post" as const },
      { tag: "Patch" as const },
      { tag: "Delete" as const },
    ];

    createKey({
      endpointId,
      keyHash,
      label: label.trim(),
      allowedMethods: allMethods as never,
      expiresAt: undefined,
    });

    setGeneratedKey(rawKey);
    setLabel("");
  }, [label, endpointId, createKey]);

  const handleCopy = useCallback(() => {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [generatedKey]);

  if (generatedKey) {
    return (
      <div className="mt-3 p-3 border border-amber-300 dark:border-amber-600 rounded bg-amber-50 dark:bg-amber-900/20">
        <p className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-2">
          Copy this key now — it will not be shown again.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-white dark:bg-neutral-800 px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 font-mono break-all text-neutral-900 dark:text-neutral-100">
            {generatedKey}
          </code>
          <button
            onClick={handleCopy}
            className="px-2 py-1 text-xs bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:opacity-90 transition-opacity shrink-0"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <button
          onClick={() => {
            setGeneratedKey(null);
            setShowCreate(false);
          }}
          className="mt-2 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          Done
        </button>
      </div>
    );
  }

  if (!showCreate) {
    return (
      <button
        onClick={() => setShowCreate(true)}
        className="mt-2 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        + Create API Key
      </button>
    );
  }

  return (
    <div className="mt-3 flex items-end gap-2">
      <div className="flex-1">
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
          Key Label
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="CI pipeline"
          className="w-full px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white"
          onKeyDown={(e) => e.key === "Enter" && handleCreateKey()}
        />
      </div>
      <button
        onClick={handleCreateKey}
        className="px-3 py-1 text-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:opacity-90 transition-opacity"
      >
        Generate
      </button>
      <button
        onClick={() => setShowCreate(false)}
        className="px-2 py-1 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        Cancel
      </button>
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

  function handleSave() {
    updateMapping({
      mappingId: mapping.id,
      fieldName: fieldName.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""),
      requiredOnCreate: required,
      defaultValue: mapping.defaultValue ?? undefined,
      readOnly,
      fieldOrder: mapping.fieldOrder,
    });
    setEditing(false);
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
          onClick={() => deleteMapping({ mappingId: mapping.id })}
          className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
        >
          Remove
        </button>
      </td>
    </tr>
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

  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "";

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
            {baseUrl}/api/e/{endpoint.slug}
          </code>
        </div>

        {/* Quick curl example */}
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
            Example
          </label>
          <code className="block text-xs bg-white dark:bg-neutral-800 px-3 py-2 rounded border border-neutral-200 dark:border-neutral-700 font-mono text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap break-all">
            {`curl ${baseUrl}/api/e/${endpoint.slug}${endpoint.requireAuth ? ' \\\n  -H "Authorization: Bearer <key>"' : ""}`}
          </code>
        </div>

        {/* OpenAPI link */}
        <div className="flex items-center gap-2 text-xs">
          <a
            href={`/api/e/${endpoint.slug}/_schema`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            OpenAPI Schema
          </a>
          <span className="text-neutral-400">|</span>
          <span className="text-neutral-500 dark:text-neutral-400">
            Methods: {allowedMethodsList(endpoint)}
          </span>
          <span className="text-neutral-400">|</span>
          <span className="text-neutral-500 dark:text-neutral-400">
            Auth: {endpoint.requireAuth ? "Required" : "Open"}
          </span>
        </div>

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
          <ApiKeySection endpointId={endpoint.id} />
        </div>

        {/* Danger zone */}
        <div className="pt-3 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={() => {
              if (
                confirm(
                  `Delete endpoint "${endpoint.displayName}"? This will also delete all field mappings and API keys.`
                )
              ) {
                deleteEndpoint({ endpointId: endpoint.id });
                onClose();
              }
            }}
            className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
          >
            Delete Endpoint
          </button>
        </div>
      </div>
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
                /api/e/{ep.slug}
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
