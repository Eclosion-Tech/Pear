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
    // Hide server-posted job-completion triggers (System("job_completion")):
    // they exist only to wake the AI user's worker for a verify+report turn.
    // The AI's follow-up message is the human-facing artifact.
    .filter(
      (m) => !(m.sender.tag === "System" && m.sender.value === "job_completion"),
    )
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

/**
 * Inbox view: every conversation the given identity participates in (and has
 * not left), newest activity first. Backs the sidebar's Inbox mode.
 *
 * We join `conversation_participant` ⨝ `conversation` on the client because
 * the SpacetimeDB hook layer doesn't expose ad-hoc joins, and the row counts
 * are tiny (workspace-scoped) so the cost is negligible.
 */
export function useInboxConversations(identity: Identity | undefined) {
  const { conversations } = useConversations();
  const participants = useConversationParticipants();
  if (!identity) return [] as ConversationRow[];
  const meHex = identity.toHexString();
  const myConvIds = new Set(
    participants
      .filter((p) => p.identity.toHexString() === meHex && !p.leftAt)
      .map((p) => String(p.conversationId)),
  );
  return conversations
    .filter((c) => myConvIds.has(String(c.id)))
    .sort(
      (a, b) =>
        Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch),
    );
}

/**
 * Returns the count of unread messages for a conversation given the
 * participant's `last_viewed_message_id`. A message is unread if its id is
 * strictly greater than the watermark (or all messages if there is no
 * watermark yet).
 */
export function useUnreadCountForConversation(
  conversationId: bigint,
  identity: Identity | undefined,
): number {
  const messages = useMessagesForConversation(conversationId);
  const participants = useConversationParticipants();
  if (!identity) return 0;
  const meHex = identity.toHexString();
  const me = participants.find(
    (p) =>
      p.conversationId === conversationId && p.identity.toHexString() === meHex,
  );
  const watermark = me?.lastViewedMessageId ?? 0n;
  return messages.filter((m) => m.id > watermark).length;
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
  if (!myIdentity || !otherIdentity) return undefined;
  const a = myIdentity.toHexString();
  const b = otherIdentity.toHexString();
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  return conversations.find((c) => c.canonicalKey === key);
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
  return attachments
    .filter((a) => a.conversationId === conversationId)
    .sort((a, b) => Number(a.id - b.id));
}

export function useAddConversationParticipant() {
  return useReducer(reducers.addConversationParticipant);
}

export function useCloseConversation() {
  return useReducer(reducers.closeConversation);
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
