"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSpacetimeDB } from "spacetimedb/react";
import type { BlockRendererProps } from "@eclosion-tech/pulp";
import {
  useMessagesForConversation,
  useParticipantsForConversation,
  useConversations,
} from "@/src/hooks/useConversations";
import { useAiUserInConversation } from "@/src/hooks/useAiUsers";

/**
 * Built-in `Conversation` — inline AI thread embed.
 *
 * Prop schema (`prop_schemas::CONVERSATION` in components.rs):
 *   { conversationId: string (required),
 *     collapsed?: string ("true" | "false"),
 *     autoCollapseThresholdMinutes?: string }
 *
 * Ported from BlockNote `ConversationBlock`.
 */
type ConversationProps = {
  conversationId?: string;
  collapsed?: string;
  autoCollapseThresholdMinutes?: string;
};

export function ConversationRenderer({ node }: BlockRendererProps) {
  const props = useMemo<ConversationProps>(() => safeParse(node.props), [node.props]);
  return (
    <ConversationBlockBody
      conversationId={props.conversationId ?? ""}
      startCollapsed={props.collapsed !== "false"}
      autoCollapseMinutes={
        Number(props.autoCollapseThresholdMinutes) || 60
      }
    />
  );
}

function ConversationBlockBody({
  conversationId,
  startCollapsed,
  autoCollapseMinutes,
}: {
  conversationId: string;
  startCollapsed: boolean;
  autoCollapseMinutes: number;
}) {
  const router = useRouter();
  const { identity } = useSpacetimeDB();
  const { conversations } = useConversations();

  let convId: bigint | null = null;
  try {
    convId = conversationId ? BigInt(conversationId) : null;
  } catch {
    convId = null;
  }
  const conversation = convId
    ? conversations.find((c) => c.id === convId) ?? null
    : null;

  const messages = useMessagesForConversation(convId ?? 0n);
  const participants = useParticipantsForConversation(convId ?? 0n);
  const aiUser = useAiUserInConversation(convId ?? 0n);

  const [expanded, setExpanded] = useState(!startCollapsed);

  if (!conversation || !convId) {
    return null;
  }

  const meHex = identity?.toHexString();
  const iAmParticipant = participants.some(
    (p) => p.identity.toHexString() === meHex,
  );

  if (
    conversation.visibility.tag === "Participants" &&
    !iAmParticipant
  ) {
    return null;
  }

  const last = messages[messages.length - 1];
  const lastAgeMs = last
    ? Date.now() - Number(last.createdAt.microsSinceUnixEpoch / 1000n)
    : Infinity;
  const stale = lastAgeMs > autoCollapseMinutes * 60 * 1000;
  const showCollapsed = !expanded || (startCollapsed && stale);

  const aiName = aiUser?.displayName ?? "Conversation";

  return (
    <div className="my-2 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden bg-neutral-50 dark:bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition-colors"
      >
        <span className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-400 to-indigo-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
          {aiName[0]?.toUpperCase() ?? "?"}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-xs font-medium text-neutral-800 dark:text-neutral-200">
            {aiName}
          </span>
          {last && (
            <span className="block text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
              {last.content}
            </span>
          )}
        </span>
        <span
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              router.push(
                `/workspace/${conversation.pageId}?conversation=${conversation.id}`,
              );
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            router.push(
              `/workspace/${conversation.pageId}?conversation=${conversation.id}`,
            );
          }}
          className="text-[10px] px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-300 dark:hover:bg-neutral-600 cursor-pointer"
        >
          Open
        </span>
      </button>
      {!showCollapsed && (
        <div className="px-3 py-2 border-t border-neutral-200 dark:border-neutral-800 max-h-64 overflow-y-auto space-y-2">
          {messages.length === 0 ? (
            <p className="text-xs text-neutral-400 italic">No messages yet</p>
          ) : (
            messages.slice(-10).map((m) => (
              <div key={String(m.id)} className="text-xs">
                <p className="text-neutral-400 mb-0.5">
                  {m.sender.tag === "User" ? "User" : m.sender.tag}
                </p>
                <p className="text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap">
                  {m.content}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function safeParse(s: string): ConversationProps {
  try {
    return JSON.parse(s) as ConversationProps;
  } catch {
    return {};
  }
}
