"use client";

import { useEffect, useMemo, useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";

import { useAiUserProfiles, type AiUserProfileRow } from "@/src/hooks/useAiUsers";
import {
  isVisibleConversationMessage,
  useConversationMessages,
  useConversationParticipants,
  useConversations,
  useCreateConversation,
  type ConversationMessageRow,
  type ConversationRow,
} from "@/src/hooks/useConversations";
import { selectMyConversations } from "@/src/lib/chatAdapter";
import { EclosionChatThread } from "./EclosionChatThread";

/** Flag for the parallel @eclosion-tech/chat panel (phase 0/1 of the migration). */
export const ECLOSION_CHAT_PANEL_ENABLED = process.env.NEXT_PUBLIC_PEAR_ECLOSION_CHAT === "1";

/**
 * Stand-in for AiPanel while the new renderer is validated. The list mirrors
 * AiPanel's selection: conversations the current user participates in
 * (never "all conversations on the page" — that is mostly other people's
 * block-anchored comment threads), newest first, labeled by the thread's AI
 * participant and its last visible message.
 */
export function EclosionChatPanel({
  pageId,
  onClose,
  openConversationId,
}: {
  pageId: bigint;
  onClose: () => void;
  openConversationId?: bigint;
}) {
  const { identity } = useSpacetimeDB();
  const { conversations: allConversations } = useConversations();
  const allParticipants = useConversationParticipants();
  const allMessages = useConversationMessages();
  const { profiles } = useAiUserProfiles();
  const createConversation = useCreateConversation();
  const [selectedId, setSelectedId] = useState<bigint | null>(openConversationId ?? null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (openConversationId != null) setSelectedId(openConversationId);
  }, [openConversationId]);

  const conversations = useMemo(
    () => selectMyConversations(allConversations, allParticipants, identity?.toHexString()),
    [allConversations, allParticipants, identity]
  );

  const lastMessageByConversation = useMemo(() => {
    const last = new Map<bigint, ConversationMessageRow>();
    for (const message of allMessages) {
      if (!isVisibleConversationMessage(message)) continue;
      const existing = last.get(message.conversationId);
      if (!existing || message.createdAt.microsSinceUnixEpoch > existing.createdAt.microsSinceUnixEpoch) {
        last.set(message.conversationId, message);
      }
    }
    return last;
  }, [allMessages]);

  const aiUserByConversation = useMemo(() => {
    const profileByIdentity = new Map(profiles.map((p) => [p.identity.toHexString(), p]));
    const grouped = new Map<bigint, AiUserProfileRow>();
    for (const participant of allParticipants) {
      if (grouped.has(participant.conversationId)) continue;
      const profile = profileByIdentity.get(participant.identity.toHexString());
      if (profile) grouped.set(participant.conversationId, profile);
    }
    return grouped;
  }, [profiles, allParticipants]);

  const aiIdentityHexes = useMemo(
    () => new Set(profiles.map((p) => p.identity.toHexString())),
    [profiles]
  );

  const conversation: ConversationRow | undefined = conversations.find((c) => c.id === selectedId)
    ?? allConversations.find((c) => c.id === selectedId);

  const newThread = async () => {
    setCreating(true);
    try {
      await createConversation({
        pageId,
        participantIdentities: profiles[0] ? [profiles[0].identity] : [],
        blockAnchor: undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  const kindBadge = (c: ConversationRow): string | null =>
    c.kind.tag === "Dm" ? "DM"
      : c.kind.tag === "AiDm" ? "AI DM"
      : c.kind.tag === "GroupDm" ? "Group DM"
      : c.kind.tag === "SharedThread" ? "Shared"
      : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
        <div className="flex items-center gap-2">
          {conversation ? (
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              ←
            </button>
          ) : null}
          <span className="font-medium">Chat (new renderer)</span>
        </div>
        <div className="flex items-center gap-2">
          {!conversation ? (
            <button
              type="button"
              onClick={newThread}
              disabled={creating}
              className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              New thread
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ✕
          </button>
        </div>
      </header>
      {conversation ? (
        <div className="min-h-0 flex-1">
          <EclosionChatThread conversation={conversation} />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.length === 0 ? (
            <li className="px-2 py-4 text-sm text-neutral-500">
              No conversations yet — start one with “New thread”.
            </li>
          ) : (
            conversations.map((c) => {
              const aiUser = aiUserByConversation.get(c.id);
              const last = lastMessageByConversation.get(c.id);
              const lastSenderIsHuman =
                last?.sender.tag === "User" && !aiIdentityHexes.has(last.sender.value.toHexString());
              const badge = kindBadge(c);
              return (
                <li key={c.id.toString()}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className="flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-indigo-500 text-xs font-bold text-white">
                      {(aiUser?.displayName ?? "?")[0]?.toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
                          {aiUser?.displayName ?? "Thread"}
                        </span>
                        {badge ? (
                          <span className="shrink-0 rounded bg-neutral-200 px-1 py-px text-[9px] font-semibold uppercase text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">
                            {badge}
                          </span>
                        ) : null}
                        {c.status.tag === "Active" ? (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-neutral-400">
                        {last ? `${lastSenderIsHuman ? "You: " : ""}${last.content}` : "No messages yet"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
