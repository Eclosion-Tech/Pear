"use client";

/**
 * Engine setup: provisions a dedicated pear AI user for a local agent engine
 * (per-installation identity — the default from the multi-agent identity
 * design) and hands its worker token to the desktop keychain over IPC.
 *
 * The shared provisioning flow (mint → create → setToken → provisionMemory)
 * lives in `@/src/lib/engines/provision`; this component owns the
 * engine-specific final step — `engine_bind` over IPC — and the UI around it.
 * "Attach to an existing AI user" needs the sanctioned token-fetch endpoint
 * (cloud security work) and is intentionally absent until that ships.
 */

import { useRef, useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import {
  useAiUserProfiles,
  useCreateAiUser,
  useProvisionAiUserMemory,
  useSetAiUserWorkerToken,
} from "@/src/hooks/useAiUsers";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { resolveWorkspaceDbName, resolveWorkspaceWsUri } from "@/src/lib/workspaceConnections";
import { engineBind } from "@/src/lib/tauri";
import { provisionEngineAiUser } from "@/src/lib/engines/provision";

export function workspaceKeyFor(wsUri: string, dbName: string): string {
  return `${resolveWorkspaceWsUri(wsUri)}::${resolveWorkspaceDbName(dbName)}`;
}

export function EngineSetupWizard({
  engine,
  engineDisplayName,
  onDone,
  onCancel,
}: {
  engine: string;
  engineDisplayName: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { identity } = useSpacetimeDB();
  const { activeWorkspace } = useWorkspace();
  const createAiUser = useCreateAiUser();
  const setAiUserWorkerToken = useSetAiUserWorkerToken();
  const provisionAiUserMemory = useProvisionAiUserMemory();
  const { profiles } = useAiUserProfiles();
  // Live view for polling inside async closures (the hook value is a render
  // snapshot; the ref always points at the latest subscription state).
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const defaultName = `${engineDisplayName} — ${typeof navigator !== "undefined" ? navigator.platform : "this machine"}`;
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSetup() {
    if (!activeWorkspace) return setError("No active workspace.");
    setBusy(true);
    setError(null);
    try {
      const wsUri = resolveWorkspaceWsUri(activeWorkspace.wsUri);
      const dbName = resolveWorkspaceDbName(activeWorkspace.dbName);

      const provisioned = await provisionEngineAiUser(
        { wsUri, dbName, displayName: name.trim() || defaultName },
        {
          identity,
          createAiUser,
          setAiUserWorkerToken,
          provisionAiUserMemory,
          profilesRef,
          onStep: setStep,
        },
      );

      setStep("Binding engine on this machine…");
      await engineBind({
        engine,
        workspaceKey: workspaceKeyFor(activeWorkspace.wsUri, activeWorkspace.dbName),
        aiUserHex: provisioned.aiUserHex,
        aiUserId: provisioned.aiUserId,
        displayName: provisioned.displayName,
        token: provisioned.token,
      });

      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-white">
          Set up {engineDisplayName}
        </h4>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Creates a dedicated AI user for this engine on this machine — its own
          identity, attribution, and private memory.
        </p>
      </div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
      />
      {step && <p className="text-xs text-neutral-500">{step}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void handleSetup()}
          disabled={busy}
          className="rounded-md bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5"
        >
          {busy ? "Setting up…" : "Create AI user"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 text-xs px-3 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
