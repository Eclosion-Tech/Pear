"use client";

import "@eclosion-tech/chat/styles.css";

import { useCallback, useMemo, useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import {
  Chat,
  Thread,
  makeAssistantDataUI,
  useAuiState,
  useExternalRuntime,
  type AppendMessage,
} from "@eclosion-tech/chat";

import { useAiUserProfiles } from "@/src/hooks/useAiUsers";
import {
  useMessagesForConversation,
  useAttachmentsForConversation,
  useSendUserMessage,
  type ConversationMessageRow,
  type ConversationRow,
} from "@/src/hooks/useConversations";
import { useOrchaJobs } from "@/src/hooks/useOrcha";
import { useUsers } from "@/src/hooks/useUser";
import {
  conversationIsRunning,
  toThreadMessage,
  type AdapterContext,
  type AdapterMessage,
  type PearMessageMeta,
  type AdapterAttachment,
} from "@/src/lib/chatAdapter";
import {
  createChatAttachmentAdapter,
  parsePageDrop,
} from "@/src/lib/chatAttachmentAdapter";
import {
  PAGE_DRAG_MIME,
  uploadChatFile,
  chatImageSrc,
  chatFileHref,
} from "@/src/lib/chatAttachments";
import { usePearWorkspaceSlug } from "@/src/lib/blobUpload";
import type { AttachmentSpec } from "@/src/module_bindings/types";
import { OrchaJobCard } from "@/src/components/OrchaJobCard";
import { StaticComponentTree } from "@/src/components/component-renderers/StaticComponentTree";

/**
 * Conversation thread rendered by @eclosion-tech/chat over the SpacetimeDB
 * external store. Streaming is row replication: the worker updates
 * conversation_message and every subscriber re-renders from the row.
 *
 * Pear's attachment adapter enables the renderer's picker, previews and upload
 * states. Page and selection drops retain their structured reducer payloads.
 */

const ComponentTreeUI = makeAssistantDataUI<{
  json: string;
  messageId: bigint;
}>({
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

const AttachmentsUI = makeAssistantDataUI<{ attachments: AdapterAttachment[] }>(
  {
    name: "pear-attachments",
    render: function MessageAttachments({ data }) {
      const slug = usePearWorkspaceSlug();
      return (
        <div className="my-1 flex flex-wrap gap-2">
          {data.attachments.map((attachment: AdapterAttachment) => {
            const name = attachment.fileName || attachment.kind.tag;
            if (attachment.kind.tag === "Image" && attachment.objectKey) {
              return (
                <a
                  key={String(attachment.id)}
                  href={chatFileHref(slug, attachment.objectKey, name)}
                  title={`Download ${name}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={chatImageSrc(slug, attachment.objectKey)}
                    alt={name}
                    className="max-h-40 max-w-full rounded-lg"
                  />
                </a>
              );
            }
            const label = (
              <span className="inline-block max-w-full truncate rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
                {name}
              </span>
            );
            return attachment.objectKey ? (
              <a
                key={String(attachment.id)}
                href={chatFileHref(slug, attachment.objectKey, name)}
                title={`Download ${name}`}
              >
                {label}
              </a>
            ) : (
              <span
                key={String(attachment.id)}
                title={attachment.contentSnapshot?.slice(0, 500)}
              >
                {label}
              </span>
            );
          })}
        </div>
      );
    },
  },
);

/**
 * Author header above every non-self message. Group chats and DMs have
 * multiple senders (humans and AIs are both identities in Pear); without
 * this there is no indication of who is talking.
 */
function MessageAuthorHeader() {
  const meta = useAuiState(
    (s) => s.message.metadata?.custom as unknown as PearMessageMeta | undefined,
  );
  if (!meta) return null;
  const name = meta.isSystem
    ? "System"
    : (meta.senderName ?? meta.senderHex?.slice(0, 8) ?? "Unknown");
  return (
    <div className="flex items-center gap-1.5 px-2 pb-0.5 text-xs text-muted-foreground">
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white ${
          meta.isAi
            ? "bg-gradient-to-br from-violet-400 to-indigo-500"
            : "bg-neutral-400 dark:bg-neutral-600"
        }`}
      >
        {name[0]?.toUpperCase() ?? "?"}
      </span>
      <span className="font-medium">{name}</span>
      {meta.isAi ? (
        <span className="rounded bg-neutral-200 px-1 text-[9px] font-semibold uppercase text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">
          AI
        </span>
      ) : null}
    </div>
  );
}

/** Data-layer windowing: assistant-ui renders every message it is given. */
const MESSAGE_WINDOW = 60;
const MESSAGE_WINDOW_STEP = 120;

export function EclosionChatThread({
  conversation,
  activePageId,
}: {
  conversation: ConversationRow;
  activePageId?: bigint;
}) {
  const allMessages = useMessagesForConversation(conversation.id);
  const attachments = useAttachmentsForConversation(conversation.id);
  const { identity } = useSpacetimeDB();
  const { profiles } = useAiUserProfiles();
  const { users } = useUsers();
  const sendUserMessage = useSendUserMessage();
  const [limit, setLimit] = useState(MESSAGE_WINDOW);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const slug = usePearWorkspaceSlug();
  const attachmentStore = useMemo(
    () =>
      createChatAttachmentAdapter(
        (file) => uploadChatFile(slug, file, conversation.id),
        setError,
      ),
    [slug, conversation.id],
  );

  const ctx = useMemo<AdapterContext>(() => {
    const displayNames = new Map<string, string>();
    for (const u of users) {
      const label = u.name || u.email;
      if (label) displayNames.set(u.identity.toHexString(), label);
    }
    for (const p of profiles)
      displayNames.set(p.identity.toHexString(), p.displayName);
    const attachmentsByMessage = new Map<bigint, AdapterAttachment[]>();
    for (const attachment of attachments) {
      const bucket = attachmentsByMessage.get(attachment.messageId) ?? [];
      bucket.push(attachment);
      attachmentsByMessage.set(attachment.messageId, bucket);
    }
    return {
      myIdentityHex: identity?.toHexString(),
      aiIdentityHexes: new Set(profiles.map((p) => p.identity.toHexString())),
      displayNames,
      attachmentsByMessage,
    };
  }, [identity, profiles, users, attachments]);

  const windowed = useMemo(
    () =>
      allMessages.length <= limit
        ? allMessages
        : allMessages.slice(allMessages.length - limit),
    [allMessages, limit],
  );

  const convertMessage = useCallback(
    (m: ConversationMessageRow) =>
      toThreadMessage(m as unknown as AdapterMessage, ctx),
    [ctx],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .trim();
      const outgoingAttachments = message.attachments ?? [];
      if (!text && outgoingAttachments.length === 0) return;
      setError(null);
      try {
        await sendUserMessage({
          conversationId: conversation.id,
          content: text,
          attachments: attachmentStore.resolve(outgoingAttachments),
        });
        attachmentStore.release(outgoingAttachments);
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "Message could not be sent. Please try again.",
        );
        // The runtime restores the unsent draft, including its attachments.
        throw error;
      }
    },
    [sendUserMessage, conversation.id, attachmentStore],
  );

  const isRunning = conversationIsRunning(
    conversation.status.tag,
    allMessages as unknown as AdapterMessage[],
    ctx,
  );

  const runtime = useExternalRuntime<ConversationMessageRow>({
    messages: windowed,
    isRunning,
    convertMessage,
    onNew,
    adapters: { attachments: attachmentStore.adapter },
  });

  async function addContext(spec: AttachmentSpec) {
    const id =
      spec.kind.tag === "Page" ? `page-${spec.pageId}` : crypto.randomUUID();
    if (
      runtime.thread.composer
        .getState()
        .attachments.some((attachment) => attachment.id === id)
    )
      return;
    attachmentStore.register(id, spec);
    try {
      await runtime.thread.composer.addAttachment({
        id,
        type: spec.kind.tag,
        name: spec.fileName || "Selection",
        content: [],
      });
    } catch (error) {
      attachmentStore.release([{ id }]);
      setError(
        error instanceof Error ? error.message : "Could not attach context.",
      );
    }
  }

  const acceptsDrop = (types: readonly string[]) =>
    types.some((type) =>
      [PAGE_DRAG_MIME, "Files", "text/plain"].includes(type),
    );

  return (
    <div
      className="relative h-full"
      onDragOver={(event) => {
        if (!acceptsDrop(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragOver(false);
      }}
      onDropCapture={(event) => {
        if (!acceptsDrop(event.dataTransfer.types)) return;
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        const rawPage = event.dataTransfer.getData(PAGE_DRAG_MIME);
        if (rawPage) {
          const page = parsePageDrop(rawPage);
          if (!page) {
            setError("Could not read the dropped page.");
            return;
          }
          // The worker resolves page references against the current page body.
          void addContext({
            kind: { tag: "Page" },
            pageId: page.pageId,
            fileName: page.title,
            objectKey: undefined,
            mimeType: undefined,
            contentSnapshot: undefined,
          });
        } else if (event.dataTransfer.files.length) {
          for (const file of Array.from(event.dataTransfer.files))
            void runtime.thread.composer
              .addAttachment(file)
              .catch((error) => setError(String(error)));
        } else {
          const text = event.dataTransfer.getData("text/plain").trim();
          if (text)
            void addContext({
              kind: { tag: "Blocks" },
              pageId: activePageId,
              fileName: "Selection",
              contentSnapshot: text,
              objectKey: undefined,
              mimeType: undefined,
            });
        }
      }}
      onPasteCapture={(event) => {
        if (!event.clipboardData.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        for (const file of Array.from(event.clipboardData.files))
          void runtime.thread.composer
            .addAttachment(file)
            .catch((error) => setError(String(error)));
      }}
    >
      <Chat runtime={runtime} className="h-full">
        <ComponentTreeUI />
        <OrchaJobUI />
        <AttachmentsUI />
        {error ? (
          <div
            role="alert"
            className="flex items-center gap-2 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200"
          >
            <span className="flex-1">{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              ×
            </button>
          </div>
        ) : null}
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
          <Thread
            components={{ AssistantMessageHeader: MessageAuthorHeader }}
          />
        </div>
      </Chat>
      {dragOver ? (
        <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-violet-500 bg-violet-50/90 text-sm font-medium text-violet-700 dark:bg-neutral-900/90 dark:text-violet-300">
          Drop pages, files, images or selected text
        </div>
      ) : null}
    </div>
  );
}
