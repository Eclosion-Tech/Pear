"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createReactBlockSpec } from "@blocknote/react";
import { useSpacetimeDB } from "spacetimedb/react";
import {
  useMessagesForConversation,
  useParticipantsForConversation,
  useConversations,
} from "@/src/hooks/useConversations";
import { useAiUserInConversation } from "@/src/hooks/useAiUsers";

/**
 * BlockNote custom block embedding a conversation inline in a page (Phase A).
 *
 * Rendering rules per the integration doc visibility matrix:
 *   - If the viewer is a participant or the conversation visibility is
 *     `Participants`/`PageInheriting` and the viewer can read this page,
 *     render a collapsed preview with the latest message + a "Open" button
 *     that routes to `?conversation=<id>` so the right panel opens it.
 *   - If the viewer lacks read access, the block renders nothing — no
 *     placeholder, no leak.
 *
 * Auto-collapse: when the latest message is older than
 * `auto_collapse_threshold` minutes, the block starts collapsed even if the
 * user previously had it expanded; this keeps long-archived inline threads
 * from dominating the page on revisit.
 */
export const ConversationBlockSpec = createReactBlockSpec(
  {
    type: "conversation" as const,
    propSchema: {
      conversationId: { default: "" },
      collapsed: { default: "true" },
      autoCollapseThresholdMinutes: { default: "60" },
    },
    content: "none",
  },
  {
    render: ({ block }) => (
      <ConversationBlockRenderer
        conversationId={block.props.conversationId}
        startCollapsed={block.props.collapsed !== "false"}
        autoCollapseMinutes={
          Number(block.props.autoCollapseThresholdMinutes) || 60
        }
      />
    ),
  },
);

function ConversationBlockRenderer({
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
    convId = BigInt(conversationId);
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
    // Visibility filter blocked the conversation row. Render nothing per
    // the doc's "Not rendered" spec — no tombstone, no leak.
    return <div contentEditable={false} className="hidden" />;
  }

  const meHex = identity?.toHexString();
  const iAmParticipant = participants.some(
    (p) => p.identity.toHexString() === meHex,
  );

  // PageInheriting falls through to the page's read access (already enforced
  // by the row visibility filter on `conversation`). For Participants and
  // Private, the row would be hidden if we weren't a participant — so a
  // visible row implies access.
  if (
    conversation.visibility.tag === "Participants" &&
    !iAmParticipant
  ) {
    return <div contentEditable={false} className="hidden" />;
  }

  const last = messages[messages.length - 1];
  const lastAgeMs = last
    ? Date.now() -
      Number(last.createdAt.microsSinceUnixEpoch / 1000n)
    : Infinity;
  const stale = lastAgeMs > autoCollapseMinutes * 60 * 1000;
  const showCollapsed = !expanded || (startCollapsed && stale);

  const aiName = aiUser?.displayName ?? "Conversation";

  return (
    <div
      contentEditable={false}
      className="my-2 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden bg-neutral-50 dark:bg-neutral-900/40"
    >
      <button
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
