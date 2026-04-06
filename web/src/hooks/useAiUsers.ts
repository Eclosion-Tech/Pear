"use client";

import { useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

export function useAiUserProfiles() {
  const [profiles, isReady] = useTable(tables.ai_user_profile);
  return { profiles, isReady };
}

export function useAiUserProfile(aiUserId: bigint) {
  const { profiles } = useAiUserProfiles();
  return profiles.find((p) => p.aiUserId === aiUserId);
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
