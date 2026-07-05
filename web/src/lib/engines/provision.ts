"use client";

/**
 * Self-hosted engine AI-user provisioning.
 *
 * Extracted from the engine setup wizard (and mirroring the self-hosted branch
 * of `CreateAiUserForm` in `AiUsersSettings.tsx`) so M2/M3 surfaces can reuse
 * the same flow without re-implementing it.
 *
 * Steps: mintIdentity → createAiUser → setAiUserWorkerToken → (wait for the
 * profile row to appear) → provisionAiUserMemory. Returns the binding info
 * (hex identity, numeric AI user id, display name); the caller is responsible
 * for the engine-specific final step — e.g. the desktop wizard calls
 * `engine_bind` over IPC to hand the worker token to the keychain.
 *
 * Self-hosted only. "Attach to an existing AI user" needs the sanctioned
 * token-fetch endpoint (cloud security work) and is intentionally absent until
 * that ships.
 */

import type { Identity } from "spacetimedb";
import type {
  CreateAiUserParams,
  SetAiUserWorkerTokenParams,
} from "@/src/module_bindings/types/reducers";
import type { AiUserProfile } from "@/src/module_bindings/types";
import { identityFromHex, mintIdentity } from "@/src/lib/aiUserApi";

export interface ProvisionEngineAiUserParams {
  /** SpacetimeDB WebSocket URI of the workspace to provision against. */
  wsUri: string;
  /** SpacetimeDB database (module) name of the workspace. */
  dbName: string;
  /** Display name for the new AI user. */
  displayName: string;
  /**
   * Provider/model for the AI user row. The external engine CLI is the real
   * model; these fields are never used for inference — `external-engine` /
   * Anthropic are placeholders the server requires.
   */
  provider?: { tag: "Anthropic" | "OpenAi" | "Ollama" | "OpenAiCompatible" };
  model?: string;
}

export interface ProvisionEngineAiUserDeps {
  /** The connected user's own identity (from `useSpacetimeDB().identity`). */
  identity: Identity | undefined;
  /** `useCreateAiUser()` — fires the `createAiUser` reducer. */
  createAiUser: (args: CreateAiUserParams) => Promise<void>;
  /** `useSetAiUserWorkerToken()` — persists the minted token on the AI user. */
  setAiUserWorkerToken: (args: SetAiUserWorkerTokenParams) => Promise<void>;
  /** `useProvisionAiUserMemory()` — creates the AI user's private memory subtree. */
  provisionAiUserMemory: (args: { aiUserId: bigint }) => Promise<void>;
  /**
   * Live ref to the `ai_user_profile` subscription rows. The hook value is a
   * render snapshot; the ref lets the polling loop here read the latest state
   * without re-running on every subscription tick. The caller is expected to
   * keep this ref in sync (see `EngineSetupWizard`).
   */
  profilesRef: React.MutableRefObject<readonly AiUserProfile[]>;
  /** Optional progress callback; receives a human-readable step label. */
  onStep?: (step: string) => void;
}

export interface ProvisionedEngineAiUser {
  /** Hex-encoded SpacetimeDB identity of the new AI user. */
  aiUserHex: string;
  /** Numeric AI user id (row primary key), once the profile row is visible. */
  aiUserId: number;
  /** Resolved display name (input or default). */
  displayName: string;
  /**
   * The minted SpacetimeDB worker token. Travels webview → Rust once (via the
   * desktop's `engine_bind` IPC) so Rust can store it in the OS keychain; Rust
   * never returns it to the webview after that. The caller is responsible for
   * that handoff and for not persisting it anywhere else.
   */
  token: string;
}

/** How long to wait for the AI user profile row to appear after creation. */
const PROFILE_WAIT_TIMEOUT_MS = 15_000;
const PROFILE_WAIT_INTERVAL_MS = 300;

/**
 * Provision a dedicated pear AI user for a local agent engine on this machine.
 * Throws on any failure (caller surfaces the error to the user).
 */
export async function provisionEngineAiUser(
  params: ProvisionEngineAiUserParams,
  deps: ProvisionEngineAiUserDeps,
): Promise<ProvisionedEngineAiUser> {
  const { wsUri, dbName, displayName } = params;
  const { identity, createAiUser, setAiUserWorkerToken, provisionAiUserMemory, profilesRef, onStep } = deps;

  if (!identity) throw new Error("Connect to the workspace first.");

  onStep?.("Minting identity…");
  const minted = await mintIdentity(wsUri);
  const aiUserIdentity = await identityFromHex(minted.identity);

  onStep?.("Creating AI user…");
  await createAiUser({
    aiUserIdentity,
    createdByIdentity: identity,
    displayName,
    provider: params.provider ?? { tag: "Anthropic" },
    // Never used for inference — the external engine CLI is the model.
    model: params.model ?? "external-engine",
    endpoint: undefined,
    apiKey: undefined,
    systemPrompt: undefined,
    maxTokens: undefined,
    avatarUrl: undefined,
  } as unknown as CreateAiUserParams);

  onStep?.("Storing worker token…");
  await setAiUserWorkerToken({
    aiUserIdentity,
    workerToken: minted.token,
  } as unknown as SetAiUserWorkerTokenParams);

  onStep?.("Waiting for AI user…");
  const aiUserId = await waitForProfile(minted.identity, profilesRef);

  onStep?.("Provisioning private memory…");
  await provisionAiUserMemory({ aiUserId });

  return {
    aiUserHex: minted.identity,
    aiUserId: Number(aiUserId),
    displayName,
    token: minted.token,
  };
}

/**
 * Poll the live `ai_user_profile` subscription for the row matching `hex`.
 * The row is written by a reducer the client doesn't see directly, so we wait
 * for the subscription to replay it.
 */
async function waitForProfile(
  hex: string,
  profilesRef: React.MutableRefObject<readonly AiUserProfile[]>,
  timeoutMs = PROFILE_WAIT_TIMEOUT_MS,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = profilesRef.current.find((p) => p.identity.toHexString() === hex);
    if (row) return row.aiUserId;
    if (Date.now() > deadline) throw new Error("AI user row did not appear");
    await new Promise((r) => setTimeout(r, PROFILE_WAIT_INTERVAL_MS));
  }
}
