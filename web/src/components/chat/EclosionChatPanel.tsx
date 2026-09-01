"use client";

import { useEffect, useState } from "react";

import { useAiUserProfiles } from "@/src/hooks/useAiUsers";
import {
  useConversationsForPage,
  useCreateConversation,
  type ConversationRow,
} from "@/src/hooks/useConversations";
import { EclosionChatThread } from "./EclosionChatThread";

/** Flag for the parallel @eclosion-tech/chat panel (phase 0/1 of the migration). */
export const ECLOSION_CHAT_PANEL_ENABLED = process.env.NEXT_PUBLIC_PEAR_ECLOSION_CHAT === "1";

/**
 * Minimal stand-in for AiPanel while the new renderer is validated: a plain
 * conversation list plus the external-store thread. Composer chrome
 * (mentions, attachments, model switcher) intentionally stays in AiPanel
 * until the swap-over phase.
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
  const { conversations } = useConversationsForPage(pageId);
  const { profiles } = useAiUserProfiles();
  const createConversation = useCreateConversation();
  const [selectedId, setSelectedId] = useState<bigint | null>(openConversationId ?? null);
  const [creating, setCreating] = useState(false);

  const newThread = async () => {
    setCreating(true);
    try {
      await createConversation({
        pageId,
        participantIdentities: profiles[0] ? [profiles[0].identity] : [],
        blockAnchor: undefined,
      });
      // The new conversation lands at the top of the page's list once the row
      // replicates; select it on the next render pass.
    } finally {
      setCreating(false);
    }
  };
  useEffect(() => {
    if (openConversationId != null) setSelectedId(openConversationId);
  }, [openConversationId]);

  const conversation: ConversationRow | undefined = conversations.find((c) => c.id === selectedId);

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
        <ul className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
          {conversations.length === 0 ? (
            <li className="px-2 py-4 text-neutral-500">No conversations on this page yet.</li>
          ) : (
            conversations.map((c) => (
              <li key={c.id.toString()}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className="w-full rounded px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  #{c.id.toString()} · {c.kind.tag} · {c.status.tag}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
