"use client";

import { useCallback } from "react";
import { useTable, useReducer } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";
import type { UpdateAiUserSystemPromptParams } from "@/src/module_bindings/types/reducers";
import {
  isAiUserHostDelegated,
  hostPatchAiUserSystemPrompt,
  hostPatchProfile,
} from "@/src/lib/aiUserApi";
import { optionStringOrNullForHost } from "@/src/lib/spacetime";
import type { AiUserProfile } from "@/src/module_bindings/types";

/** BSATN `Option<String>` for reducers; generated `Params` types often infer `string` instead. */
function toSystemPromptReducerArg(s: string | null) {
  if (s == null || s === "") return { tag: "none" as const };
  return { tag: "some" as const, value: s };
}

export function useAiUserProfiles() {
  const [profiles, isReady] = useTable(tables.ai_user_profile);
  return { profiles, isReady };
}

export function useAiUserProfile(aiUserId: bigint) {
  const { profiles } = useAiUserProfiles();
  return profiles.find((p) => p.aiUserId === aiUserId);
}

/**
 * Lookup an AI user profile by its SpacetimeDB Identity.
 *
 * After the AI user identity refactor, every AI user owns a unique Identity;
 * this hook is the canonical way to resolve a `MessageSender::User(identity)`
 * back to a profile (and tell humans from AI users — humans won't match).
 */
export function useAiUserProfileByIdentity(identity: Identity | undefined) {
  const { profiles } = useAiUserProfiles();
  if (!identity) return undefined;
  const hex = identity.toHexString();
  return profiles.find((p) => p.identity.toHexString() === hex);
}

/**
 * Find the first AI user participating in a conversation. Page-attached
 * conversations have exactly one AI participant today; channel/DM threads in
 * the future may have many — this hook returns the first match.
 */
export function useAiUserInConversation(conversationId: bigint) {
  const [allParticipants] = useTable(tables.conversation_participant);
  const { profiles } = useAiUserProfiles();
  const participantHexes = new Set(
    allParticipants
      .filter((p) => p.conversationId === conversationId)
      .map((p) => p.identity.toHexString())
  );
  return profiles.find((p) => participantHexes.has(p.identity.toHexString()));
}

export function useCreateAiUser() {
  return useReducer(reducers.createAiUser);
}

export function useUpdateAiUserProfile() {
  return useReducer(reducers.updateAiUserProfile);
}

export function useUpdateAiUserConfig() {
  return useReducer(reducers.updateAiUserConfig);
}

export function useSetAiUserApiKey() {
  return useReducer(reducers.setAiUserApiKey);
}

/** Change only the default model for an AI user (provider/key/endpoint preserved). */
export function useSetAiUserModel() {
  return useReducer(reducers.setAiUserModel);
}

/**
 * Persist the SpacetimeDB worker token for an AI user (keyed by identity) so
 * the OSS worker can spawn an `AiUserWorker` that connects as the AI user. Only
 * used on the self-hosted path; host-delegated deployments store the token
 * server-side in their own lifecycle and never call this.
 */
export function useSetAiUserWorkerToken() {
  return useReducer(reducers.setAiUserWorkerToken);
}

/** Set or clear the optional Serper API key for this AI user's `web_search` tool. */
export function useSetAiUserSerperApiKey() {
  return useReducer(reducers.setAiUserSerperApiKey);
}

export function useDeleteAiUser() {
  return useReducer(reducers.deleteAiUser);
}

export function useProvisionAiUserMemory() {
  return useReducer(reducers.provisionAiUserMemory);
}

// ── Scheduled routines ──────────────────────────────────────────────────────────

/** All AiUserRoutine rows (scheduled proactive routines). Filter by aiUserId. */
export function useAiUserRoutines() {
  const [routines] = useTable(tables.ai_user_routine);
  return routines;
}

/** Create a custom interval routine (prompt + interval_secs). */
export function useCreateAiUserRoutine() {
  return useReducer(reducers.createAiUserRoutine);
}

/** Create a cron routine: five-field expression evaluated in an IANA timezone. */
export function useCreateAiUserRoutineCron() {
  return useReducer(reducers.createAiUserRoutineCron);
}

export function useCreateSensorTriageRoutine() {
  return useReducer(reducers.createSensorTriageRoutine);
}

export function useCreateMemoryConsolidationRoutine() {
  return useReducer(reducers.createMemoryConsolidationRoutine);
}

export function useSetAiUserRoutineEnabled() {
  return useReducer(reducers.setAiUserRoutineEnabled);
}

export function useDeleteAiUserRoutine() {
  return useReducer(reducers.deleteAiUserRoutine);
}

export function useDisableAiUserMemory() {
  return useReducer(reducers.disableAiUserMemory);
}

export function useUpdateAiUserSystemPrompt() {
  const run = useReducer(reducers.updateAiUserSystemPrompt);
  return useCallback(
    async (p: { aiUserId: bigint; systemPrompt: string | null }) => {
      if (isAiUserHostDelegated()) {
        await hostPatchAiUserSystemPrompt(p.aiUserId, p.systemPrompt);
      } else {
        await run({
          aiUserId: p.aiUserId,
          systemPrompt: toSystemPromptReducerArg(p.systemPrompt),
        } as unknown as UpdateAiUserSystemPromptParams);
      }
    },
    [run]
  );
}

/** Display name (+ avatar) update; host path sends current avatar so it is not cleared. */
export function usePatchAiUserProfileSettings() {
  const run = useReducer(reducers.updateAiUserProfile);
  return useCallback(
    async (p: { aiUserId: bigint; displayName: string; avatarUrl: AiUserProfile["avatarUrl"] }) => {
      if (isAiUserHostDelegated()) {
        await hostPatchProfile(p.aiUserId, {
          displayName: p.displayName,
          avatarUrl: optionStringOrNullForHost(p.avatarUrl),
        });
      } else {
        await run({
          aiUserId: p.aiUserId,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl,
        });
      }
    },
    [run]
  );
}

export type AiUserProfileRow = ReturnType<typeof useAiUserProfiles>["profiles"][number];
