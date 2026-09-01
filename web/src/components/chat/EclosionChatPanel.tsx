"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";

import { useAiUserProfiles, type AiUserProfileRow } from "@/src/hooks/useAiUsers";
import {
  isVisibleConversationMessage,
  useConversationMessages,
  useConversationParticipants,
  useConversations,
  useCreateConversation,
  useDmConversation,
  useFindOrCreateDm,
  type ConversationMessageRow,
  type ConversationRow,
} from "@/src/hooks/useConversations";
import { useUsers } from "@/src/hooks/useUser";
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
  const [selectedId, setSelectedId] = useState<bigint | null>(openConversationId ?? null);

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
            <NewChatMenu
              pageId={pageId}
              conversations={allConversations}
              profiles={profiles}
              onOpen={(id) => setSelectedId(id)}
            />
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

/**
 * "New chat" picker: start a fresh thread with a specific AI user, or open a
 * DM with a workspace member — AiPanel's NewConversationButton and
 * HumanMemberRow flows, in one menu.
 */
function NewChatMenu({
  pageId,
  conversations,
  profiles,
  onOpen,
}: {
  pageId: bigint;
  conversations: readonly ConversationRow[];
  profiles: readonly AiUserProfileRow[];
  onOpen: (id: bigint) => void;
}) {
  const { identity } = useSpacetimeDB();
  const { users } = useUsers();
  const createConversation = useCreateConversation();
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<Set<string> | null>(null);

  // Auto-open the conversation created by startThread once it replicates.
  useEffect(() => {
    const existing = pendingRef.current;
    if (!existing || !identity) return;
    const meHex = identity.toHexString();
    const fresh = conversations
      .filter((c) => !existing.has(String(c.id)) && c.initiatedBy.toHexString() === meHex)
      .sort((a, b) => Number(b.id - a.id))[0];
    if (fresh) {
      pendingRef.current = null;
      setOpen(false);
      onOpen(fresh.id);
    }
  }, [conversations, identity, onOpen]);

  const startThread = async (aiIdentity?: { toHexString(): string }) => {
    pendingRef.current = new Set(conversations.map((c) => String(c.id)));
    await createConversation({
      pageId,
      participantIdentities: aiIdentity ? [aiIdentity as never] : [],
      blockAnchor: undefined,
    });
  };

  const otherHumans = users.filter(
    (u) => !identity || u.identity.toHexString() !== identity.toHexString()
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        New chat
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 max-h-72 w-60 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            <p className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-neutral-400">
              Start a thread with
            </p>
            {profiles.length === 0 ? (
              <button
                type="button"
                onClick={() => void startThread()}
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                New thread (no AI members yet)
              </button>
            ) : (
              profiles.map((p) => (
                <button
                  key={String(p.aiUserId)}
                  type="button"
                  onClick={() => void startThread(p.identity)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-indigo-500 text-[10px] font-bold text-white">
                    {p.displayName[0]?.toUpperCase() ?? "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-800 dark:text-neutral-200">{p.displayName}</span>
                    <span className="block truncate text-[11px] text-neutral-400">{p.modelName}</span>
                  </span>
                </button>
              ))
            )}
            {otherHumans.length > 0 ? (
              <>
                <p className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-neutral-400">People</p>
                {otherHumans.map((u) => (
                  <HumanDmItem key={u.identity.toHexString()} user={u} onOpen={(id) => { setOpen(false); onOpen(id); }} />
                ))}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function HumanDmItem({
  user,
  onOpen,
}: {
  user: ReturnType<typeof useUsers>["users"][number];
  onOpen: (id: bigint) => void;
}) {
  const { identity: myIdentity } = useSpacetimeDB();
  const findOrCreate = useFindOrCreateDm();
  const dm = useDmConversation(myIdentity, user.identity);
  const [pending, setPending] = useState(false);
  const displayName = user.name || user.email || user.identity.toHexString().slice(0, 8);

  useEffect(() => {
    if (pending && dm) {
      setPending(false);
      onOpen(dm.id);
    }
  }, [pending, dm, onOpen]);

  const handleClick = async () => {
    if (dm) {
      onOpen(dm.id);
      return;
    }
    setPending(true);
    await findOrCreate({ otherIdentity: user.identity });
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={pending}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50 disabled:opacity-50 dark:hover:bg-neutral-800"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-300 text-[10px] font-bold text-neutral-700 dark:bg-neutral-600 dark:text-neutral-200">
        {displayName[0]?.toUpperCase() ?? "?"}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-800 dark:text-neutral-200">{displayName}</span>
      <span className="text-[10px] text-neutral-400">{pending ? "…" : "DM"}</span>
    </button>
  );
}
