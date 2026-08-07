"use client";

import { useMemo } from "react";
import { useTable, useReducer } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";

// Derivations are useMemo'd on the stable useTable snapshot so consumers
// get stable array identities between row events (ticket 14378).

export function useConversations() {
  const [conversations, isReady] = useTable(tables.conversation);
  return { conversations, isReady };
}

/** Conversations for a specific page, newest first. */
export function useConversationsForPage(pageId: bigint) {
  const { conversations, isReady } = useConversations();
  const pageConvs = useMemo(
    () =>
      conversations
        .filter((c) => c.pageId === pageId)
        .sort(
          (a, b) =>
            Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch)
        ),
    [conversations, pageId],
  );
  return { conversations: pageConvs, isReady };
}

export function useConversationMessages() {
  const [messages] = useTable(tables.conversation_message);
  return messages;
}

/**
 * Hide server-posted system triggers (job completion, scheduled routines,
 * feedback): they exist only to wake the AI user's worker for a turn. The
 * AI's follow-up message is the human-facing artifact.
 */
export function isVisibleConversationMessage(m: ConversationMessageRow): boolean {
  return !(
    m.sender.tag === "System" &&
    (m.sender.value === "job_completion" ||
      m.sender.value === "routine" ||
      m.sender.value === "feedback" ||
      m.sender.value === "access_resolution")
  );
}

/** Messages for a specific conversation, oldest first (chronological). */
export function useMessagesForConversation(conversationId: bigint) {
  const messages = useConversationMessages();
  return useMemo(
    () =>
      messages
        .filter((m) => m.conversationId === conversationId)
        .filter(isVisibleConversationMessage)
        .sort(
          (a, b) =>
            Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch)
        ),
    [messages, conversationId],
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
  return useMemo(
    () => all.filter((p) => p.conversationId === conversationId),
    [all, conversationId],
  );
}

export function useCreateConversation() {
  return useReducer(reducers.createConversation);
}

export function useFindOrCreateDm() {
  return useReducer(reducers.findOrCreateDm);
}

export function useFindOrCreateAiDm() {
  return useReducer(reducers.findOrCreateAiDm);
}

/** Returns the canonical DM conversation between the current user and another identity, if it exists. */
export function useDmConversation(
  myIdentity: Identity | null | undefined,
  otherIdentity: Identity | undefined,
): ConversationRow | undefined {
  const { conversations } = useConversations();
  return useMemo(() => {
    if (!myIdentity || !otherIdentity) return undefined;
    const a = myIdentity.toHexString();
    const b = otherIdentity.toHexString();
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    return conversations.find((c) => c.canonicalKey === key);
  }, [conversations, myIdentity, otherIdentity]);
}

export function useSendMessage() {
  return useReducer(reducers.sendMessage);
}

/** Human send with attachments (images, page refs, block snapshots). */
export function useSendUserMessage() {
  return useReducer(reducers.sendUserMessage);
}

/** All attachments in a conversation, keyed for per-message lookup by the thread. */
export function useAttachmentsForConversation(conversationId: bigint) {
  const [attachments] = useTable(tables.conversation_attachment);
  return useMemo(
    () =>
      attachments
        .filter((a) => a.conversationId === conversationId)
        .sort((a, b) => Number(a.id - b.id)),
    [attachments, conversationId],
  );
}

export function useAddConversationParticipant() {
  return useReducer(reducers.addConversationParticipant);
}

/**
 * Resolve a thread. Enforced, not cosmetic: the module refuses new messages on
 * a non-Active conversation, so resolving a comment thread genuinely ends it.
 */
export function useCloseConversation() {
  return useReducer(reducers.closeConversation);
}

/** Reopen a resolved thread. Without this, resolving would be a one-way door. */
export function useReopenConversation() {
  return useReducer(reducers.reopenConversation);
}

/**
 * Set or clear this conversation's model override. Pass a model id to pin the
 * thread to a specific model, or `undefined` to revert to the AI user's
 * configured default. The provider/API key are unchanged, so the model must be
 * one the AI user's existing key can reach.
 */
export function useSetConversationModel() {
  return useReducer(reducers.setConversationModel);
}

/** Compare two Identity values structurally (Identity has no equality op). */
export function identitiesEqual(a: Identity | undefined, b: Identity | undefined): boolean {
  if (!a || !b) return false;
  return a.toHexString() === b.toHexString();
}

export type ConversationRow = ReturnType<typeof useConversations>["conversations"][number];
export type ConversationAttachmentRow = ReturnType<typeof useAttachmentsForConversation>[number];
export type ConversationMessageRow = ReturnType<typeof useConversationMessages>[number];
export type ConversationParticipantRow = ReturnType<typeof useConversationParticipants>[number];
