"use client";

import { useCallback } from "react";
import { useTable, useReducer } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";
import type { AiUserProfile } from "@/src/module_bindings/types";
import type { UpdateAiUserSystemPromptParams } from "@/src/module_bindings/types/reducers";
import {
  isAiUserHostDelegated,
  hostPatchAiUserSystemPrompt,
  hostPatchProfile,
} from "@/src/lib/aiUserApi";

function toSystemPromptReducerArg(
  s: string | null
): NonNullable<UpdateAiUserSystemPromptParams["systemPrompt"]> {
  if (s == null || s === "") return { tag: "none" };
  return { tag: "some", value: s };
}

function optionStringForHostPatch(v: AiUserProfile["avatarUrl"]): string | null {
  if (v == null) return null;
  if (v.tag === "none") return null;
  return v.value;
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

export function useDeleteAiUser() {
  return useReducer(reducers.deleteAiUser);
}

export function useProvisionAiUserMemory() {
  return useReducer(reducers.provisionAiUserMemory);
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
        });
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
          avatarUrl: optionStringForHostPatch(p.avatarUrl),
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
