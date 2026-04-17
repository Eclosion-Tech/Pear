"use client";

import { useTable, useReducer } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";

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

export type AiUserProfileRow = ReturnType<typeof useAiUserProfiles>["profiles"][number];
