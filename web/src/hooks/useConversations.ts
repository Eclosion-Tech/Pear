"use client";

import { useTable, useReducer } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";

export function useConversations() {
  const [conversations, isReady] = useTable(tables.conversation);
  return { conversations, isReady };
}

/** Conversations for a specific page, newest first. */
export function useConversationsForPage(pageId: bigint) {
  const { conversations, isReady } = useConversations();
  const pageConvs = conversations
    .filter((c) => c.pageId === pageId)
    .sort(
      (a, b) =>
        Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch)
    );
  return { conversations: pageConvs, isReady };
}

export function useConversationMessages() {
  const [messages] = useTable(tables.conversation_message);
  return messages;
}

/** Messages for a specific conversation, oldest first (chronological). */
export function useMessagesForConversation(conversationId: bigint) {
  const messages = useConversationMessages();
  return messages
    .filter((m) => m.conversationId === conversationId)
    .sort(
      (a, b) =>
        Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch)
    );
}

/** All conversation_participant rows. */
export function useConversationParticipants() {
  const [participants] = useTable(tables.conversation_participant);
  return participants;
}

/** Participants in a single conversation. */
export function useParticipantsForConversation(conversationId: bigint) {
  const all = useConversationParticipants();
  return all.filter((p) => p.conversationId === conversationId);
}

export function useCreateConversation() {
  return useReducer(reducers.createConversation);
}

export function useSendMessage() {
  return useReducer(reducers.sendMessage);
}

export function useCloseConversation() {
  return useReducer(reducers.closeConversation);
}

/** Compare two Identity values structurally (Identity has no equality op). */
export function identitiesEqual(a: Identity | undefined, b: Identity | undefined): boolean {
  if (!a || !b) return false;
  return a.toHexString() === b.toHexString();
}

export type ConversationRow = ReturnType<typeof useConversations>["conversations"][number];
export type ConversationMessageRow = ReturnType<typeof useConversationMessages>[number];
export type ConversationParticipantRow = ReturnType<typeof useConversationParticipants>[number];
