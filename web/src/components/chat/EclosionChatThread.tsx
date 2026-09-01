"use client";

import "@eclosion-tech/chat/styles.css";

import { useCallback, useMemo, useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import {
  Chat,
  Thread,
  makeAssistantDataUI,
  useExternalRuntime,
  type AppendMessage,
} from "@eclosion-tech/chat";

import { useAiUserProfiles } from "@/src/hooks/useAiUsers";
import {
  useMessagesForConversation,
  useSendUserMessage,
  type ConversationMessageRow,
  type ConversationRow,
} from "@/src/hooks/useConversations";
import { useOrchaJobs } from "@/src/hooks/useOrcha";
import {
  conversationIsRunning,
  toThreadMessage,
  type AdapterContext,
  type AdapterMessage,
} from "@/src/lib/chatAdapter";
import { OrchaJobCard } from "@/src/components/OrchaJobCard";
import { StaticComponentTree } from "@/src/components/component-renderers/StaticComponentTree";

/**
 * Conversation thread rendered by @eclosion-tech/chat over the SpacetimeDB
 * external store. Streaming is row replication: the worker updates
 * conversation_message and every subscriber re-renders from the row.
 *
 * Phase 1 scope: text sends (no attachments/mentions yet); no cancel button
 * until the cancel/interrupt reducer lands — wire it into `onCancel` then.
 */

const ComponentTreeUI = makeAssistantDataUI<{ json: string; messageId: bigint }>({
  name: "component-tree",
  render: ({ data }) => (
    <div className="my-2">
      <StaticComponentTree json={data.json} messageId={data.messageId} />
    </div>
  ),
});

const OrchaJobUI = makeAssistantDataUI<{ jobId: bigint }>({
  name: "orcha-job",
  render: function OrchaJobData({ data }) {
    const { jobs } = useOrchaJobs();
    const job = jobs.find((j) => j.id === data.jobId);
    if (!job) return null;
    return (
      <div className="my-2">
        <OrchaJobCard job={job} />
      </div>
    );
  },
});

/** Data-layer windowing: assistant-ui renders every message it is given. */
const MESSAGE_WINDOW = 60;
const MESSAGE_WINDOW_STEP = 120;

export function EclosionChatThread({ conversation }: { conversation: ConversationRow }) {
  const allMessages = useMessagesForConversation(conversation.id);
  const { identity } = useSpacetimeDB();
  const { profiles } = useAiUserProfiles();
  const sendUserMessage = useSendUserMessage();
  const [limit, setLimit] = useState(MESSAGE_WINDOW);

  const ctx = useMemo<AdapterContext>(
    () => ({
      myIdentityHex: identity?.toHexString(),
      aiIdentityHexes: new Set(profiles.map((p) => p.identity.toHexString())),
      displayNames: new Map(profiles.map((p) => [p.identity.toHexString(), p.displayName])),
    }),
    [identity, profiles]
  );

  const windowed = useMemo(
    () => (allMessages.length <= limit ? allMessages : allMessages.slice(allMessages.length - limit)),
    [allMessages, limit]
  );

  const convertMessage = useCallback(
    (m: ConversationMessageRow) => toThreadMessage(m as unknown as AdapterMessage, ctx),
    [ctx]
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .trim();
      if (!text) return;
      await sendUserMessage({ conversationId: conversation.id, content: text, attachments: [] });
    },
    [sendUserMessage, conversation.id]
  );

  const isRunning = conversationIsRunning(
    conversation.status.tag,
    allMessages as unknown as AdapterMessage[],
    ctx
  );

  const runtime = useExternalRuntime<ConversationMessageRow>({
    messages: windowed,
    isRunning,
    convertMessage,
    onNew,
  });

  return (
    <Chat runtime={runtime} className="h-full">
      <ComponentTreeUI />
      <OrchaJobUI />
      {allMessages.length > limit ? (
        <button
          type="button"
          onClick={() => setLimit((l) => l + MESSAGE_WINDOW_STEP)}
          className="border-b border-border py-1 text-center text-xs text-muted-foreground hover:bg-muted"
        >
          Load earlier messages ({allMessages.length - limit} more)
        </button>
      ) : null}
      <div className="min-h-0 flex-1">
        <Thread />
      </div>
    </Chat>
  );
}
