"use client";

import { useState } from "react";
import { Identity } from "spacetimedb";
import {
  useExtensionManifests,
  useInstalledExtensions,
  useExtensionRuntimeHealth,
  usePublishExtension,
  useInstallExtension,
  useConfirmExtensionInstall,
  useCancelExtensionInstall,
  useUninstallExtension,
  useSetExtensionEnabled,
  useUpdateExtension,
  useSeedBuiltinExtensions,
  type ExtensionManifestRow,
  type InstalledExtensionRow,
  type ExtensionRuntimeHealthRow,
} from "@/src/hooks/useExtensions";
import { mintIdentity } from "@/src/lib/aiUserApi";

const SELF_HOSTED_WS_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI?.trim() ?? "";

/**
 * Mint a fresh SpacetimeDB Identity for a ConfigBundle/Hybrid extension's
 * AI user. In pear-cloud the lifecycle service should mint identities itself
 * (via a future host-delegated install endpoint); for self-hosted Pear the
 * web client mints directly.
 */
async function mintAiUserIdentityForExtension(): Promise<Identity> {
  if (!SELF_HOSTED_WS_URI) {
    throw new Error(
      "Cannot mint AI user identity for extension: NEXT_PUBLIC_SPACETIMEDB_URI is not set."
    );
  }
  const minted = await mintIdentity(SELF_HOSTED_WS_URI);
  return Identity.fromString(minted.identity);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extensionTypeLabel(tag: string) {
  switch (tag) {
    case "ConfigBundle":
      return "Config Bundle";
    case "McpServer":
      return "MCP Server";
    case "Hybrid":
      return "Hybrid";
    case "Builtin":
      return "Built-in";
    default:
      return tag;
  }
}

function isBuiltin(manifest: ExtensionManifestRow | undefined) {
  return manifest?.extensionType.tag === "Builtin";
}

function installStatusLabel(tag: string) {
  switch (tag) {
    case "Active":
      return "Active";
    case "PendingConfirmation":
      return "Pending confirmation";
    default:
      return tag;
  }
}

// ── Install from URL Form ─────────────────────────────────────────────────────

function InstallFromUrlForm({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [prefilled, setPrefilled] = useState<{
    name: string;
    description: string;
    version: string;
    extensionType: "ConfigBundle" | "McpServer" | "Hybrid";
    manifestJson: string;
  } | null>(null);
  const [publishError, setPublishError] = useState("");
  const publishExtension = usePublishExtension();

  async function handleFetch() {
    setFetchError("");
    setPublishError("");
    if (!url.trim()) {
      setFetchError("URL is required");
      return;
    }
    setFetching(true);
    try {
      const res = await fetch(url.trim());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const doc = JSON.parse(text) as {
        name?: string;
        description?: string;
        version?: string;
        extension_type?: string;
        config_bundle?: unknown;
        mcp_server?: unknown;
      };
      const extensionType: "ConfigBundle" | "McpServer" | "Hybrid" =
        doc.extension_type === "ConfigBundle"
          ? "ConfigBundle"
          : doc.extension_type === "Hybrid"
            ? "Hybrid"
            : "McpServer";
      setPrefilled({
        name: doc.name ?? "",
        description: doc.description ?? "",
        version: doc.version ?? "1.0.0",
        extensionType,
        manifestJson: text,
      });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to fetch manifest");
    } finally {
      setFetching(false);
    }
  }

  async function handlePublish() {
    if (!prefilled) return;
    setPublishError("");
    if (!prefilled.name.trim()) {
      setPublishError("Manifest must include a name field");
      return;
    }
    try {
      await publishExtension({
        name: prefilled.name,
        description: prefilled.description,
        extensionType: { tag: prefilled.extensionType },
        version: prefilled.version,
        manifestJson: prefilled.manifestJson,
        sourceUrl: url.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-white">
            Install from URL
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
              Manifest URL
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setPrefilled(null); setFetchError(""); }}
                placeholder="https://registry.example.com/ext/my-tool/manifest.json"
                className="flex-1 px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <button
                onClick={handleFetch}
                disabled={fetching || !url.trim()}
                className="px-3 py-2 text-sm font-medium text-white bg-neutral-700 hover:bg-neutral-800 dark:bg-neutral-600 dark:hover:bg-neutral-500 rounded-lg transition-colors disabled:opacity-50"
              >
                {fetching ? "Fetching…" : "Fetch"}
              </button>
            </div>
            {fetchError && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{fetchError}</p>
            )}
          </div>

          {prefilled && (
            <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-4 bg-neutral-50 dark:bg-neutral-800/50 space-y-2">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-3">
                Manifest preview
              </p>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                  {prefilled.name || "(no name)"}
                </p>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400">
                  v{prefilled.version}
                </span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-900/30 text-slate-500 dark:text-slate-400">
                  {extensionTypeLabel(prefilled.extensionType)}
                </span>
              </div>
              {prefilled.description && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {prefilled.description}
                </p>
              )}
            </div>
          )}

          {publishError && (
            <p className="text-sm text-red-600 dark:text-red-400">{publishError}</p>
          )}
        </div>

        <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-4">
          The manifest will be published to your workspace and become available for installation.
        </p>

        <div className="flex gap-2 justify-end mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handlePublish}
            disabled={!prefilled}
            className="px-4 py-2 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-40 rounded-lg transition-colors"
          >
            Publish &amp; install
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Installed Extension Card ──────────────────────────────────────────────────

function InstalledExtensionCard({
  installed,
  manifest,
  latestManifest,
  runtimeHealth,
  onToggleEnabled,
  onUninstall,
  onConfirm,
  onCancel,
  onUpgrade,
}: {
  installed: InstalledExtensionRow;
  manifest: ExtensionManifestRow | undefined;
  latestManifest: ExtensionManifestRow | undefined;
  runtimeHealth: ExtensionRuntimeHealthRow | undefined;
  onToggleEnabled: (id: bigint, enabled: boolean) => void;
  onUninstall: (id: bigint) => void;
  onConfirm: (id: bigint) => void;
  onCancel: (id: bigint) => void;
  onUpgrade: (installedId: bigint, newManifestId: bigint) => void;
}) {
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const isPending = installed.installStatus.tag === "PendingConfirmation";
  const hasUpgrade = latestManifest && latestManifest.id !== installed.manifestId;
  const builtin = isBuiltin(manifest);
  const runtimeStatus = !installed.enabled
    ? {
        label: "Disabled",
        classes: "bg-neutral-100 dark:bg-neutral-800 text-neutral-500",
        title: "This extension is disabled.",
      }
    : runtimeHealth?.status.tag === "Connected"
      ? {
          label: `Connected · ${runtimeHealth.toolCount} ${runtimeHealth.toolCount === 1 ? "tool" : "tools"}`,
          classes: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300",
          title: "Pear successfully initialized this MCP server and listed its tools.",
        }
      : runtimeHealth?.status.tag === "Connecting"
        ? {
            label: "Connecting",
            classes: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300",
            title: "Pear is initializing this MCP server.",
          }
        : runtimeHealth?.status.tag === "Error"
          ? {
              label: "Connection failed",
              classes: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
              title: runtimeHealth.detail ?? "Pear could not initialize this MCP server.",
            }
          : {
              label: "Not checked",
              classes: "bg-neutral-100 dark:bg-neutral-800 text-neutral-500",
              title: "No AI worker has successfully checked this MCP server yet.",
            };

  return (
    <div className="flex flex-col gap-2 py-4 border-b border-neutral-200 dark:border-neutral-800 last:border-0">
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0 ${builtin ? "bg-gradient-to-br from-indigo-400 to-violet-500" : "bg-gradient-to-br from-emerald-400 to-teal-500"}`}>
          {(manifest?.name ?? "?")[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
              {manifest?.name ?? `Extension ${installed.id}`}
            </p>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${builtin ? "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400" : "bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400"}`}>
              {manifest ? extensionTypeLabel(manifest.extensionType.tag) : "Unknown"}
            </span>
            {isPending && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 shrink-0">
                Awaiting confirmation
              </span>
            )}
            {!builtin && !isPending && (
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${runtimeStatus.classes}`}
                title={runtimeStatus.title}
              >
                {runtimeStatus.label}
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-400 truncate mt-0.5">
            {manifest?.description ?? ""}
            {manifest?.version ? ` · v${manifest.version}` : ""}
          </p>
        </div>

        {/* Builtin extensions are always-on — no controls needed */}
        {!builtin && (
          <>
            <div className="flex items-center gap-2 shrink-0">
              {hasUpgrade && !isPending && (
                <button
                  onClick={() => onUpgrade(installed.id, latestManifest.id)}
                  className="px-2 py-1 rounded text-xs font-medium text-sky-700 bg-sky-50 dark:bg-sky-900/20 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/40 transition-colors whitespace-nowrap"
                  title={`Upgrade to v${latestManifest.version}`}
                >
                  ↑ v{latestManifest.version}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Enable / Disable toggle — only for Active installs */}
              {!isPending && (
                <button
                  onClick={() => onToggleEnabled(installed.id, !installed.enabled)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                    installed.enabled
                      ? "bg-teal-500"
                      : "bg-neutral-300 dark:bg-neutral-600"
                  }`}
                  aria-label={installed.enabled ? "Disable extension" : "Enable extension"}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                      installed.enabled ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              )}

              {/* Confirm / Cancel for pending installs */}
              {isPending ? (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => onConfirm(installed.id)}
                    className="px-2 py-1 rounded text-xs font-medium text-teal-700 bg-teal-50 dark:bg-teal-900/20 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/40 transition-colors"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => onCancel(installed.id)}
                    className="px-2 py-1 rounded text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : confirmingUninstall ? (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      onUninstall(installed.id);
                      setConfirmingUninstall(false);
                    }}
                    className="px-2 py-1 rounded text-xs font-medium text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                  >
                    Uninstall
                  </button>
                  <button
                    onClick={() => setConfirmingUninstall(false)}
                    className="px-2 py-1 rounded text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingUninstall(true)}
                  className="px-2 py-1 rounded text-xs font-medium text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  Uninstall
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Confirm Install Modal ─────────────────────────────────────────────────────

function ConfirmInstallModal({
  installed,
  manifest,
  onConfirm,
  onCancel,
}: {
  installed: InstalledExtensionRow;
  manifest: ExtensionManifestRow | undefined;
  onConfirm: (
    installedExtensionId: bigint,
    confirmedCapabilities: string[],
    confirmedPermissionsJson: string,
    aiApiKey: string | undefined,
    mcpApiKey: string | undefined,
    endpointOverride: string | undefined,
  ) => void;
  onCancel: () => void;
}) {
  const [mcpApiKey, setMcpApiKey] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [endpointOverride, setEndpointOverride] = useState("");

  if (!manifest) return null;

  let requestedCapabilities: string[] = [];
  let requestedPermissions: unknown[] = [];
  try {
    const doc = JSON.parse(manifest.manifestJson) as {
      config_bundle?: { requested_capabilities?: string[]; requested_permissions?: unknown[] };
      mcp_server?: { requested_capabilities?: string[]; requested_permissions?: unknown[] };
    };
    requestedCapabilities = [
      ...(doc.config_bundle?.requested_capabilities ?? []),
      ...(doc.mcp_server?.requested_capabilities ?? []),
    ];
    requestedPermissions = [
      ...(doc.config_bundle?.requested_permissions ?? []),
      ...(doc.mcp_server?.requested_permissions ?? []),
    ];
  } catch {
    // Ignore parse errors
  }

  const needsMcpKey = manifest.extensionType.tag === "McpServer" || manifest.extensionType.tag === "Hybrid";
  const needsAiKey = manifest.extensionType.tag === "ConfigBundle" || manifest.extensionType.tag === "Hybrid";

  function handleConfirm() {
    onConfirm(
      installed.id,
      requestedCapabilities,
      JSON.stringify(requestedPermissions),
      needsAiKey && aiApiKey ? aiApiKey : undefined,
      needsMcpKey && mcpApiKey ? mcpApiKey : undefined,
      endpointOverride || undefined,
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-white mb-1">
          Confirm extension install
        </h3>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-5">
          Review the capabilities and permissions requested by{" "}
          <strong>{manifest.name}</strong> before granting access.
        </p>

        {requestedCapabilities.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">
              Requested capabilities
            </p>
            <ul className="space-y-1">
              {requestedCapabilities.map((cap) => (
                <li
                  key={cap}
                  className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0" />
                  <code className="text-xs bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded">
                    {cap}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(needsAiKey || needsMcpKey) && (
          <div className="space-y-3 mb-4">
            {needsAiKey && (
              <div>
                <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                  AI Provider API Key
                </label>
                <input
                  type="password"
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            )}
            {needsMcpKey && (
              <>
                <div>
                  <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                    MCP Server API Key (optional)
                  </label>
                  <input
                    type="password"
                    value={mcpApiKey}
                    onChange={(e) => setMcpApiKey(e.target.value)}
                    placeholder="Leave blank if not required"
                    className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                    Endpoint override (optional)
                  </label>
                  <input
                    type="url"
                    value={endpointOverride}
                    onChange={(e) => setEndpointOverride(e.target.value)}
                    placeholder="https://my-mcp-server.example.com/sse"
                    className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors"
          >
            Grant access &amp; install
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Publish Extension Form ────────────────────────────────────────────────────

function PublishExtensionForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [extensionType, setExtensionType] = useState<"ConfigBundle" | "McpServer" | "Hybrid">("McpServer");
  const [manifestJson, setManifestJson] = useState(
    JSON.stringify(
      {
        mcp_server: {
          endpoint: "https://example.com/mcp/sse",
          auth_scheme: "api_key",
          requested_capabilities: ["tool-page-read"],
          requested_permissions: [{ scope: "workspace", action: "Read" }],
        },
      },
      null,
      2,
    ),
  );
  const [error, setError] = useState("");
  const publishExtension = usePublishExtension();

  async function handlePublish() {
    setError("");
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    try {
      JSON.parse(manifestJson);
    } catch {
      setError("Invalid JSON in manifest");
      return;
    }
    try {
      await publishExtension({
        name: name.trim(),
        description: description.trim(),
        extensionType: { tag: extensionType },
        version: version.trim() || "1.0.0",
        manifestJson,
        sourceUrl: undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-white">
            Publish extension manifest
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Extension"
              className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this extension do?"
              className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                Type
              </label>
              <select
                value={extensionType}
                onChange={(e) =>
                  setExtensionType(e.target.value as "ConfigBundle" | "McpServer" | "Hybrid")
                }
                className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
              >
                <option value="McpServer">MCP Server</option>
                <option value="ConfigBundle">Config Bundle</option>
                <option value="Hybrid">Hybrid</option>
              </select>
            </div>
            <div className="w-32">
              <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                Version
              </label>
              <input
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
                className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
              Manifest JSON
            </label>
            <textarea
              value={manifestJson}
              onChange={(e) => setManifestJson(e.target.value)}
              rows={8}
              spellCheck={false}
              className="w-full px-3 py-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="flex gap-2 justify-end mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handlePublish}
            className="px-4 py-2 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors"
          >
            Publish manifest
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Install Extension Form ────────────────────────────────────────────────────

function InstallExtensionForm({
  manifest,
  onClose,
}: {
  manifest: ExtensionManifestRow;
  onClose: () => void;
}) {
  const [aiApiKey, setAiApiKey] = useState("");
  const [mcpApiKey, setMcpApiKey] = useState("");
  const [endpointOverride, setEndpointOverride] = useState("");
  const [error, setError] = useState("");
  const installExtension = useInstallExtension();

  const needsMcpKey = manifest.extensionType.tag === "McpServer" || manifest.extensionType.tag === "Hybrid";
  const needsAiKey = manifest.extensionType.tag === "ConfigBundle" || manifest.extensionType.tag === "Hybrid";
  const needsAiUserIdentity = needsAiKey;

  async function handleInstall() {
    setError("");
    try {
      const aiUserIdentity = needsAiUserIdentity
        ? await mintAiUserIdentityForExtension()
        : undefined;
      await installExtension({
        manifestId: manifest.id,
        aiApiKey: needsAiKey && aiApiKey ? aiApiKey : undefined,
        mcpApiKey: needsMcpKey && mcpApiKey ? mcpApiKey : undefined,
        endpointOverride: endpointOverride || undefined,
        aiUserIdentity,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
              Install {manifest.name}
            </h3>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
              {manifest.description}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 ml-3 shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="space-y-3">
          {needsAiKey && (
            <div>
              <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                AI Provider API Key
              </label>
              <input
                type="password"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
          )}
          {needsMcpKey && (
            <>
              <div>
                <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                  MCP Server API Key (optional)
                </label>
                <input
                  type="password"
                  value={mcpApiKey}
                  onChange={(e) => setMcpApiKey(e.target.value)}
                  placeholder="Leave blank if not required"
                  className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1">
                  Endpoint override (optional)
                </label>
                <input
                  type="url"
                  value={endpointOverride}
                  onChange={(e) => setEndpointOverride(e.target.value)}
                  placeholder="https://my-mcp-server.example.com/sse"
                  className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            </>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400 mt-3">{error}</p>
        )}

        <div className="flex gap-2 justify-end mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            className="px-4 py-2 text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Available Extension Card ──────────────────────────────────────────────────

function AvailableExtensionCard({
  manifest,
  isInstalled,
  onInstall,
}: {
  manifest: ExtensionManifestRow;
  isInstalled: boolean;
  onInstall: (manifest: ExtensionManifestRow) => void;
}) {
  const builtin = isBuiltin(manifest);
  return (
    <div className="flex items-center gap-3 py-3 border-b border-neutral-200 dark:border-neutral-800 last:border-0">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0 ${builtin ? "bg-gradient-to-br from-indigo-400 to-violet-500" : "bg-gradient-to-br from-slate-400 to-slate-600"}`}>
        {manifest.name[0]?.toUpperCase() ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
            {manifest.name}
          </p>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 shrink-0">
            v{manifest.version}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${builtin ? "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400" : "bg-slate-100 dark:bg-slate-900/30 text-slate-500 dark:text-slate-400"}`}>
            {extensionTypeLabel(manifest.extensionType.tag)}
          </span>
        </div>
        <p className="text-xs text-neutral-400 truncate mt-0.5">
          {manifest.description}
        </p>
      </div>
      <button
        disabled={isInstalled || builtin}
        onClick={() => !builtin && onInstall(manifest)}
        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors shrink-0 ${
          isInstalled || builtin
            ? "text-neutral-400 bg-neutral-100 dark:bg-neutral-800 cursor-not-allowed"
            : "text-teal-700 bg-teal-50 dark:bg-teal-900/20 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/40"
        }`}
      >
        {builtin ? "Built-in" : isInstalled ? "Installed" : "Install"}
      </button>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ExtensionsSettings() {
  const { manifests } = useExtensionManifests();
  const { installed } = useInstalledExtensions();
  const { health } = useExtensionRuntimeHealth();

  const setExtensionEnabled = useSetExtensionEnabled();
  const uninstallExtension = useUninstallExtension();
  const confirmExtensionInstall = useConfirmExtensionInstall();
  const cancelExtensionInstall = useCancelExtensionInstall();
  const updateExtension = useUpdateExtension();
  const seedBuiltinExtensions = useSeedBuiltinExtensions();

  const [showPublishForm, setShowPublishForm] = useState(false);
  const [showInstallFromUrl, setShowInstallFromUrl] = useState(false);
  const [installTarget, setInstallTarget] = useState<ExtensionManifestRow | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<InstalledExtensionRow | null>(null);
  const [builtinExpanded, setBuiltinExpanded] = useState(false);

  // Build a map from name → latest manifest (highest id = most recently published)
  const latestByName = new Map<string, ExtensionManifestRow>();
  for (const m of manifests) {
    const existing = latestByName.get(m.name);
    if (!existing || m.id > existing.id) {
      latestByName.set(m.name, m);
    }
  }

  const installedManifestIds = new Set(installed.map((i) => i.manifestId));

  function handleToggleEnabled(id: bigint, enabled: boolean) {
    setExtensionEnabled({ installedExtensionId: id, enabled }).catch(console.error);
  }

  function handleUninstall(id: bigint) {
    uninstallExtension({ installedExtensionId: id }).catch(console.error);
  }

  function handleUpgrade(installedId: bigint, newManifestId: bigint) {
    updateExtension({ installedExtensionId: installedId, newManifestId })
      .catch(console.error);
  }

  function handleConfirmInstall(
    installedExtensionId: bigint,
    confirmedCapabilities: string[],
    confirmedPermissionsJson: string,
    aiApiKey: string | undefined,
    mcpApiKey: string | undefined,
    endpointOverride: string | undefined,
    needsAiUser: boolean,
  ) {
    (async () => {
      try {
        const aiUserIdentity = needsAiUser
          ? await mintAiUserIdentityForExtension()
          : undefined;
        await confirmExtensionInstall({
          installedExtensionId,
          confirmedCapabilities,
          confirmedPermissionsJson,
          aiApiKey,
          mcpApiKey,
          endpointOverride,
          aiUserIdentity,
        });
        setConfirmTarget(null);
      } catch (err) {
        console.error(err);
      }
    })();
  }

  function handleCancelInstall(id: bigint) {
    cancelExtensionInstall({ installedExtensionId: id }).catch(console.error);
  }

  return (
    <>
      {/* Install from URL modal */}
      {showInstallFromUrl && (
        <InstallFromUrlForm onClose={() => setShowInstallFromUrl(false)} />
      )}

      {/* Install form modal */}
      {installTarget && (
        <InstallExtensionForm
          manifest={installTarget}
          onClose={() => setInstallTarget(null)}
        />
      )}

      {/* Confirm install modal */}
      {confirmTarget && (
        <ConfirmInstallModal
          installed={confirmTarget}
          manifest={manifests.find((m) => m.id === confirmTarget.manifestId)}
          onConfirm={(id, caps, perms, aiKey, mcpKey, endpoint) => {
            const m = manifests.find((mm) => mm.id === confirmTarget.manifestId);
            const needsAiUser =
              m?.extensionType.tag === "ConfigBundle" ||
              m?.extensionType.tag === "Hybrid";
            handleConfirmInstall(id, caps, perms, aiKey, mcpKey, endpoint, needsAiUser);
          }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}

      {/* Publish manifest modal */}
      {showPublishForm && (
        <PublishExtensionForm onClose={() => setShowPublishForm(false)} />
      )}

      {/* Built-in extensions — collapsible, collapsed by default */}
      {(() => {
        const builtinExts = installed.filter((ext) =>
          isBuiltin(manifests.find((m) => m.id === ext.manifestId))
        );
        return (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-1">
              <button
                onClick={() => setBuiltinExpanded((v) => !v)}
                className="flex items-center gap-2 text-left"
              >
                <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
                  Built-in
                </h2>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`text-neutral-400 transition-transform ${builtinExpanded ? "rotate-180" : ""}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {builtinExts.length === 0 && (
                <button
                  onClick={() => seedBuiltinExtensions().catch(console.error)}
                  className="text-xs text-indigo-500 dark:text-indigo-400 hover:underline"
                >
                  Restore defaults
                </button>
              )}
            </div>
            {builtinExpanded && (
              <div className="mt-3">
                {builtinExts.length === 0 ? (
                  <p className="text-sm text-neutral-400 dark:text-neutral-500 py-2">
                    No built-in extensions found.{" "}
                    <button
                      onClick={() => seedBuiltinExtensions().catch(console.error)}
                      className="text-indigo-500 dark:text-indigo-400 hover:underline"
                    >
                      Restore defaults
                    </button>
                  </p>
                ) : (
                  builtinExts.map((ext) => {
                    const currentManifest = manifests.find((m) => m.id === ext.manifestId);
                    return (
                      <InstalledExtensionCard
                        key={String(ext.id)}
                        installed={ext}
                        manifest={currentManifest}
                        latestManifest={undefined}
                        runtimeHealth={undefined}
                        onToggleEnabled={handleToggleEnabled}
                        onUninstall={handleUninstall}
                        onConfirm={(id) => setConfirmTarget(installed.find((i) => i.id === id) ?? null)}
                        onCancel={handleCancelInstall}
                        onUpgrade={handleUpgrade}
                      />
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* User-installed extensions */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
            Installed Extensions
          </h2>
        </div>

        {(() => {
          const userExts = installed.filter(
            (ext) => !isBuiltin(manifests.find((m) => m.id === ext.manifestId))
          );
          if (userExts.length === 0) {
            return (
              <p className="text-sm text-neutral-400 dark:text-neutral-500 py-4">
                No extensions installed yet. Browse available manifests below to install one.
              </p>
            );
          }
          return (
            <div>
              {userExts.map((ext) => {
                const currentManifest = manifests.find((m) => m.id === ext.manifestId);
                const latestManifest = currentManifest
                  ? latestByName.get(currentManifest.name)
                  : undefined;
                return (
                  <InstalledExtensionCard
                    key={String(ext.id)}
                    installed={ext}
                    manifest={currentManifest}
                    latestManifest={latestManifest}
                    runtimeHealth={health.find((row) => row.installedExtensionId === ext.id)}
                    onToggleEnabled={handleToggleEnabled}
                    onUninstall={handleUninstall}
                    onConfirm={(id) => setConfirmTarget(installed.find((i) => i.id === id) ?? null)}
                    onCancel={handleCancelInstall}
                    onUpgrade={handleUpgrade}
                  />
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* Extension browser (available manifests) */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
            Available Manifests
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowInstallFromUrl(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-lg transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Install from URL
            </button>
            <button
              onClick={() => setShowPublishForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-900/20 hover:bg-teal-100 dark:hover:bg-teal-900/40 rounded-lg transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Publish manifest
            </button>
          </div>
        </div>

        {manifests.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500 py-4">
            No extension manifests published yet. Click "Publish manifest" to add one, or use "Install from URL" to fetch a manifest from an external registry.
          </p>
        ) : (
          <div>
            {manifests.map((manifest) => (
              <AvailableExtensionCard
                key={String(manifest.id)}
                manifest={manifest}
                isInstalled={installedManifestIds.has(manifest.id)}
                onInstall={setInstallTarget}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
