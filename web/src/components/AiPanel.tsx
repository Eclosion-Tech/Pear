"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSpacetimeDB } from "spacetimedb/react";
import Markdown from "react-markdown";
import {
  useOrchaTasksForJob,
  type OrchaJobRow,
} from "@/src/hooks/useOrcha";
import {
  useConversations,
  useInboxConversations,
  useCreateConversation,
  useFindOrCreateAiDm,
  useFindOrCreateDm,
  useDmConversation,
  useAddConversationParticipant,
  useMessagesForConversation,
  useSendMessage,
  useCloseConversation,
  useParticipantsForConversation,
  identitiesEqual,
  type ConversationRow,
  type ConversationMessageRow,
} from "@/src/hooks/useConversations";
import { useUsers } from "@/src/hooks/useUser";
import {
  useAiUserProfiles,
  useAiUserProfileByIdentity,
  useAiUserInConversation,
  type AiUserProfileRow,
} from "@/src/hooks/useAiUsers";
import { ContextBar } from "@/src/components/ContextBar";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type { Identity } from "spacetimedb";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    executing: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
    complete:  "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
    failed:    "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
    pending:   "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
    claimed:   "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
    done:      "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  };
  return (
    <span
      className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${
        colors[status] ?? colors.pending
      }`}
    >
      {status}
    </span>
  );
}

function JobCard({ job }: { job: OrchaJobRow }) {
  const tasks = useOrchaTasksForJob(job.id);
  const [expanded, setExpanded] = useState(job.status === "executing");

  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-start gap-2 p-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-800 dark:text-neutral-200 line-clamp-2 leading-snug">
            {job.prompt}
          </p>
          <div className="flex items-center gap-2 mt-1.5">
            <StatusBadge status={job.status} />
            <span className="text-xs text-neutral-400">
              {tasks.length} task{tasks.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 mt-1 text-neutral-400 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && tasks.length > 0 && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-100 dark:divide-neutral-800/60">
          {tasks.map((task) => (
            <div key={String(task.id)} className="px-3 py-2.5 flex items-start gap-2">
              <StatusBadge status={task.status} />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed">
                  {task.description}
                </p>
                {task.result && task.status === "done" && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1.5 line-clamp-4 leading-relaxed">
                    {task.result}
                  </p>
                )}
                {task.result && task.status === "failed" && (
                  <p className="text-xs text-red-500 mt-1.5 leading-relaxed">
                    {task.result}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A delegated Orcha job rendered inline in the conversation thread as a
 * subagent-style card — the full expandable task breakdown (`JobCard`) framed
 * so it reads as "this message spawned a background subagent."
 */
function InlineJobCard({ jobId }: { jobId: bigint }) {
  const [jobs] = useTable(tables.orcha_job);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return null;
  return (
    <div className="mt-2 pl-2.5 border-l-2 border-violet-300/60 dark:border-violet-600/40">
      <div className="flex items-center gap-1.5 mb-1.5">
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-500">
          <rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4M8 16h.01M16 16h.01" />
        </svg>
        <span className="text-[10px] font-medium uppercase tracking-wide text-violet-500/90">
          Delegated subagent
        </span>
      </div>
      <JobCard job={job} />
    </div>
  );
}

// ── Thinking block (collapsible) ──────────────────────────────────────────────

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(isStreaming);

  // Expand live while the model is thinking, then auto-collapse once the answer
  // lands so completed messages stay tidy. Manual toggles persist until the
  // streaming state next flips.
  useEffect(() => {
    setExpanded(isStreaming);
  }, [isStreaming]);

  return (
    <div className="mt-1.5 mb-1.5">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
      >
        {isStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse shrink-0" />
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>Thinking{isStreaming ? "…" : ""}</span>
      </button>
      {expanded && (
        <div className="mt-1 pl-3 border-l-2 border-violet-300/40 dark:border-violet-600/30">
          <p className="text-xs text-neutral-400 dark:text-neutral-500 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
            {thinking}
            {isStreaming && <span className="animate-pulse">|</span>}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Tool call display ─────────────────────────────────────────────────────────

/** Concrete entities a mutating tool touched (mirror of worker AffectedEntities, #32). */
interface AffectedEntities {
  pageId?: number;
  createdNodeIds?: number[];
  propertyDefinitionId?: number;
  jobId?: number;
}

/** Unified persisted tool-call shape; `result` kept for legacy rows. */
interface ToolCallInfo {
  name: string;
  status: "executing" | "done" | "error";
  output?: string;
  affected?: AffectedEntities;
  /** Legacy field (pre-unified shape). */
  result?: string;
}

/** Short human summary of what a tool call touched, for the chat receipt (#32). */
function affectedSummary(a: AffectedEntities | undefined): string | null {
  if (!a) return null;
  const bits: string[] = [];
  if (a.pageId !== undefined) bits.push(`page ${a.pageId}`);
  if (a.createdNodeIds?.length) bits.push(`${a.createdNodeIds.length} block${a.createdNodeIds.length === 1 ? "" : "s"}`);
  if (a.propertyDefinitionId !== undefined) bits.push(`property ${a.propertyDefinitionId}`);
  if (a.jobId !== undefined) bits.push(`job ${a.jobId}`);
  return bits.length > 0 ? bits.join(", ") : null;
}

const TOOL_ICONS: Record<string, string> = {
  web_search: "search",
  fetch_url: "globe",
};

function ToolCallsDisplay({
  toolCallsJson,
  conversationId,
}: {
  toolCallsJson: string;
  conversationId: bigint;
}) {
  const router = useRouter();
  let calls: ToolCallInfo[] = [];
  try {
    calls = JSON.parse(toolCallsJson);
  } catch {
    return null;
  }
  if (calls.length === 0) return null;

  return (
    <div className="mt-1.5 mb-1.5 space-y-1">
      {calls.map((tc, i) => {
        const summary = affectedSummary(tc.affected) ?? (tc.status === "done" ? tc.result : undefined);
        const node = tc.affected?.createdNodeIds?.[0];
        // Jump-to-change deep link: open the affected page (and the changed
        // block, if any), keeping this conversation open (#32).
        const href = tc.affected?.pageId !== undefined
          ? `/workspace/${tc.affected.pageId}?conversation=${conversationId}${node !== undefined ? `&node=${node}` : ""}`
          : null;
        return (
          <div key={i} className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            {tc.status === "executing" ? (
              <span className="w-3 h-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin shrink-0" />
            ) : tc.status === "done" ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500 shrink-0">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-500 shrink-0">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
            <span className="font-medium">{tc.name.replace(/_/g, " ")}</span>
            {href ? (
              <button
                type="button"
                onClick={() => router.push(href)}
                className="text-violet-500 hover:text-violet-600 hover:underline truncate max-w-[160px]"
                title={`Jump to change — ${summary ?? "open page"}`}
              >
                → {summary ?? "open page"}
              </button>
            ) : (
              summary && (
                <span className="text-neutral-400 truncate max-w-[160px]" title={summary}>
                  — {summary}
                </span>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── AI message content with status-aware rendering ────────────────────────────

function AiMessageContent({ msg, aiName }: { msg: ConversationMessageRow; aiName: string }) {
  const status = msg.status?.tag ?? "Complete";
  const thinking = msg.thinking;
  const toolCallsJson = msg.toolCallsJson;

  return (
    <>
      {/* Thinking block */}
      {thinking && (
        <ThinkingBlock
          thinking={thinking}
          isStreaming={status === "Thinking"}
        />
      )}

      {/* Tool calls */}
      {toolCallsJson && (
        <ToolCallsDisplay toolCallsJson={toolCallsJson} conversationId={msg.conversationId} />
      )}

      {/* Thinking indicator (no thinking text yet) */}
      {status === "Thinking" && !thinking && !msg.content && (
        <div className="flex items-center gap-1.5 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 dark:bg-violet-500 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 dark:bg-violet-500 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 dark:bg-violet-500 animate-bounce [animation-delay:300ms]" />
        </div>
      )}

      {/* Message content */}
      {msg.content && (
        <div className="ai-message-md text-sm leading-relaxed prose prose-sm prose-neutral dark:prose-invert max-w-none">
          <Markdown>{msg.content}</Markdown>
          {status === "Streaming" && <span className="animate-pulse">|</span>}
        </div>
      )}

      {/* Error state */}
      {status === "Error" && !msg.content && (
        <p className="text-xs text-red-500 italic">Failed to generate response</p>
      )}
    </>
  );
}

// ── Linked conversation card ─────────────────────────────────────────────────

function LinkedConversationCard({ linkedConversationId }: { linkedConversationId: bigint }) {
  const router = useRouter();
  const { conversations } = useConversations();
  const conv = conversations.find((c) => c.id === linkedConversationId);
  const aiUser = useAiUserInConversation(linkedConversationId);
  if (!conv) return null;
  return (
    <button
      onClick={() => router.push(`/workspace/${conv.pageId}?conversation=${conv.id}`)}
      className="mt-1.5 flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400 shrink-0">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
        Thread: {aiUser?.displayName ?? "Context thread"} → Open
      </span>
    </button>
  );
}

// ── Conversation thread ──────────────────────────────────────────────────────

function ConversationThread({ conversation, onBack, activePageId }: { conversation: ConversationRow; onBack: () => void; activePageId?: bigint }) {
  const aiUser = useAiUserInConversation(conversation.id);
  const messages = useMessagesForConversation(conversation.id);
  const { profiles: allAiProfiles } = useAiUserProfiles();
  const aiIdentityHexes = new Set(allAiProfiles.map((p) => p.identity.toHexString()));
  const sendMessage = useSendMessage();
  const closeConversation = useCloseConversation();
  const createConversation = useCreateConversation();
  const router = useRouter();
  const { identity } = useSpacetimeDB();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isActive = conversation.status.tag === "Active";
  const aiName = aiUser?.displayName ?? "AI";

  const lastMessage = messages[messages.length - 1];
  // After the identity refactor, both human and AI senders are tagged "User";
  // we tell them apart by Identity lookup against ai_user_profile.
  const lastSenderIdentity =
    lastMessage?.sender.tag === "User" ? lastMessage.sender.value : undefined;
  const lastSenderAiUser = useAiUserProfileByIdentity(lastSenderIdentity);
  const lastSenderIsHuman =
    lastMessage?.sender.tag === "User" && !lastSenderAiUser;
  const isAiActive =
    isActive &&
    lastMessage != null &&
    (lastSenderIsHuman ||
      (!!lastSenderAiUser &&
        lastMessage.status?.tag !== "Complete" &&
        lastMessage.status?.tag !== "Error"));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, isAiActive, lastMessage?.content, lastMessage?.thinking, lastMessage?.status?.tag]);

  async function handleSend() {
    if (!input.trim() || sending || !isActive) return;
    setSending(true);
    try {
      await sendMessage({
        conversationId: conversation.id,
        content: input.trim(),
        jobId: undefined,
        status: undefined,
        thinking: undefined,
        toolCallsJson: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheCreationInputTokens: undefined,
        cacheReadInputTokens: undefined,
        linkedConversationId: undefined,
      });
      setInput("");
    } catch (err) {
      console.error("[AiPanel] Failed to send message", err);
    } finally {
      setSending(false);
    }
  }

  async function handleFork() {
    if (!activePageId || !aiUser) return;
    try {
      await createConversation({
        pageId: activePageId,
        participantIdentities: [aiUser.identity],
        blockAnchor: undefined,
      });
      router.push(`/workspace/${activePageId}`);
      onBack();
    } catch (err) {
      console.error("[AiPanel] Fork failed", err);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex-shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-200 truncate">
            {aiName}
          </p>
          {aiUser && (
            <p className="text-xs text-neutral-400 truncate">
              {aiUser.providerName} · {aiUser.modelName}
            </p>
          )}
        </div>
        {isActive && (
          <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Active" />
        )}
        {!isActive && (
          <span className="text-xs text-neutral-400">Closed</span>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        {messages.length === 0 && (
          <p className="text-xs text-neutral-400 text-center py-8">
            Conversation started — waiting for response…
          </p>
        )}
        {messages.map((msg) => {
          // System messages render as their own thing; for User-tagged messages
          // we tell humans from AI users by membership in ai_user_profile.
          const senderIdentity = msg.sender.tag === "User" ? msg.sender.value : undefined;
          const isHuman =
            msg.sender.tag === "User" &&
            !aiIdentityHexes.has(senderIdentity!.toHexString());
          const isMe =
            isHuman &&
            identity &&
            senderIdentity!.toHexString() === identity.toHexString();

          return (
            <div key={String(msg.id)} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 ${
                  isMe
                    ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                    : msg.status?.tag === "Error"
                      ? "bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800/50"
                      : "bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
                }`}
              >
                {!isMe && (
                  <p className="text-xs font-medium mb-0.5 opacity-60">
                    {isHuman ? "User" : aiName}
                  </p>
                )}
                {isHuman ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                ) : (
                  <AiMessageContent msg={msg} aiName={aiName} />
                )}
                {msg.jobId != null && <InlineJobCard jobId={msg.jobId} />}
              </div>
              {msg.linkedConversationId != null && (
                <LinkedConversationCard linkedConversationId={msg.linkedConversationId} />
              )}
            </div>
          );
        })}
      </div>

      {/* Context bar — shows what the AI user can see, plus pending
          write-access requests (which also arise in page-less AI DMs). */}
      {aiUser && (
        <ContextBar
          pageId={conversation.pageId}
          aiUserIdentity={aiUser.identity}
          conversationId={conversation.id}
          activePageId={activePageId}
          onFork={() => void handleFork()}
        />
      )}

      {/* Input */}
      {isActive ? (
        <div className="flex-shrink-0 border-t border-neutral-200 dark:border-neutral-800 p-3">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Message ${aiName}…`}
              rows={2}
              className="flex-1 text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 resize-none outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() || sending}
              className="self-end p-2 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 transition-colors"
              title="Send (↵)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-neutral-400">↵ send · ⇧↵ newline</span>
            <div className="flex items-center gap-3">
              <HandoffPanel
                conversation={conversation}
                activePageId={activePageId}
                messages={messages}
                aiName={aiName}
                onNewConversation={(id) => { /* navigated externally via onBack + inbox */ void id; }}
              />
              <button
                onClick={() => closeConversation({ conversationId: conversation.id })}
                className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-shrink-0 border-t border-neutral-200 dark:border-neutral-800 px-4 py-3">
          <p className="text-xs text-neutral-400 text-center">This conversation is closed</p>
        </div>
      )}
    </div>
  );
}

// ── Handoff panel ────────────────────────────────────────────────────────────

type HandoffMode = "dm" | "invite" | "branch";

function HandoffPanel({
  conversation,
  activePageId,
  messages,
  aiName,
  onNewConversation,
}: {
  conversation: ConversationRow;
  activePageId?: bigint;
  messages: ConversationMessageRow[];
  aiName: string;
  onNewConversation: (id: bigint) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<HandoffMode | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteWarning, setInviteWarning] = useState(false);

  const { users } = useUsers();
  const { identity: myIdentity } = useSpacetimeDB();
  const { conversations: allConversations } = useConversations();
  const participants = useParticipantsForConversation(conversation.id);
  const findOrCreateDm = useFindOrCreateDm();
  const sendMessage = useSendMessage();
  const addParticipant = useAddConversationParticipant();
  const createConversation = useCreateConversation();

  const alreadyInThread = new Set(participants.map((p) => p.identity.toHexString()));
  const candidates = users.filter(
    (u) =>
      (!myIdentity || u.identity.toHexString() !== myIdentity.toHexString()) &&
      (u.name?.toLowerCase().includes(search.toLowerCase()) ||
        u.email?.toLowerCase().includes(search.toLowerCase()) ||
        !search),
  );

  function dmKey(a: string, b: string) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  function findExistingDm(otherIdentity: string) {
    if (!myIdentity) return undefined;
    const key = dmKey(myIdentity.toHexString(), otherIdentity);
    return allConversations.find((c) => c.canonicalKey === key);
  }

  async function handleSendToDm(user: (typeof users)[number]) {
    if (!myIdentity) return;
    setBusy(true);
    try {
      const lastAiMsg = [...messages].reverse().find(
        (m) => m.sender.tag === "User" && m.sender.value.toHexString() !== myIdentity.toHexString(),
      );
      const summary = lastAiMsg?.content ?? `Shared from conversation with ${aiName}`;
      const truncated = summary.length > 500 ? summary.slice(0, 497) + "…" : summary;
      const body = `From conversation with ${aiName}:\n\n${truncated}`;

      let dm = findExistingDm(user.identity.toHexString());
      if (!dm) {
        await findOrCreateDm({ otherIdentity: user.identity });
        // Wait for the DM to appear in subscription
        let tries = 0;
        while (!dm && tries < 20) {
          await new Promise((r) => setTimeout(r, 150));
          dm = findExistingDm(user.identity.toHexString());
          tries++;
        }
      }
      if (!dm) throw new Error("DM not found after creation");

      await sendMessage({
        conversationId: dm.id,
        content: body,
        jobId: undefined,
        status: undefined,
        thinking: undefined,
        toolCallsJson: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheCreationInputTokens: undefined,
        cacheReadInputTokens: undefined,
        linkedConversationId: conversation.id,
      });
      setOpen(false);
      setMode(null);
    } catch (err) {
      console.error("[HandoffPanel] Send to DM failed", err);
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(user: (typeof users)[number]) {
    if (!inviteWarning) { setInviteWarning(true); return; }
    setBusy(true);
    try {
      await addParticipant({
        conversationId: conversation.id,
        identity: user.identity,
      });
      setOpen(false);
      setMode(null);
      setInviteWarning(false);
    } catch (err) {
      console.error("[HandoffPanel] Invite failed", err);
    } finally {
      setBusy(false);
    }
  }

  async function handleBranch(user: (typeof users)[number]) {
    const pageId = activePageId ?? conversation.pageId;
    if (!pageId) return;
    setBusy(true);
    try {
      await createConversation({
        pageId,
        participantIdentities: [user.identity],
        blockAnchor: undefined,
      });
      setOpen(false);
      setMode(null);
    } catch (err) {
      console.error("[HandoffPanel] Branch failed", err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
      >
        Share →
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          {mode === "dm" && "Send summary to…"}
          {mode === "invite" && "Invite to this thread…"}
          {mode === "branch" && "Start new thread with…"}
          {!mode && "Share with a person"}
        </span>
        <button
          onClick={() => { setOpen(false); setMode(null); setInviteWarning(false); }}
          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          ×
        </button>
      </div>

      {!mode && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setMode("dm")}
            className="text-left text-xs px-2 py-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
          >
            <span className="font-medium">→ Send summary to DM</span>
            <span className="block text-neutral-400 text-[10px]">Shares the last AI reply as a message</span>
          </button>
          <button
            onClick={() => setMode("invite")}
            className="text-left text-xs px-2 py-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
          >
            <span className="font-medium">+ Invite to this thread</span>
            <span className="block text-neutral-400 text-[10px]">They'll see all prior messages</span>
          </button>
          <button
            onClick={() => setMode("branch")}
            className="text-left text-xs px-2 py-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
          >
            <span className="font-medium">↗ New thread with…</span>
            <span className="block text-neutral-400 text-[10px]">Fresh conversation on this page</span>
          </button>
        </div>
      )}

      {mode && (
        <>
          {mode === "invite" && inviteWarning && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded px-2 py-1.5">
              This person will see all prior messages in this thread.
            </p>
          )}
          <input
            autoFocus
            value={search}
            onChange={(e) => { setSearch(e.target.value); setInviteWarning(false); }}
            placeholder="Search members…"
            className="text-xs bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400"
          />
          <div className="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
            {candidates.length === 0 && (
              <p className="text-xs text-neutral-400 py-2 text-center">No members found</p>
            )}
            {candidates.map((user) => {
              const displayName = user.name || user.email || user.identity.toHexString().slice(0, 8);
              const alreadyIn = alreadyInThread.has(user.identity.toHexString());
              return (
                <button
                  key={user.identity.toHexString()}
                  disabled={busy || (mode === "invite" && alreadyIn)}
                  onClick={() => {
                    if (mode === "dm") void handleSendToDm(user);
                    else if (mode === "invite") void handleInvite(user);
                    else if (mode === "branch") void handleBranch(user);
                  }}
                  className="text-left text-xs px-2 py-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 text-neutral-700 dark:text-neutral-300 flex items-center justify-between"
                >
                  <span className="truncate">{displayName}</span>
                  {mode === "invite" && alreadyIn && (
                    <span className="text-[10px] text-neutral-400 shrink-0 ml-2">already here</span>
                  )}
                  {mode === "invite" && !alreadyIn && inviteWarning && (
                    <span className="text-[10px] text-amber-600 shrink-0 ml-2">confirm ↵</span>
                  )}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => { setMode(null); setInviteWarning(false); }}
            className="text-[10px] text-neutral-400 hover:text-neutral-600 text-left"
          >
            ← back
          </button>
        </>
      )}
    </div>
  );
}

function ConversationListItem({
  conversation,
  onClick,
}: {
  conversation: ConversationRow;
  onClick: () => void;
}) {
  const aiUser = useAiUserInConversation(conversation.id);
  const messages = useMessagesForConversation(conversation.id);
  const { profiles: allAiProfiles } = useAiUserProfiles();
  const aiIdentityHexes = new Set(allAiProfiles.map((p) => p.identity.toHexString()));
  const lastMessage = messages[messages.length - 1];
  const isActive = conversation.status.tag === "Active";
  const lastSenderIsHuman =
    lastMessage?.sender.tag === "User" &&
    !aiIdentityHexes.has(lastMessage.sender.value.toHexString());

  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 p-3 text-left rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
    >
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-400 to-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">
        {(aiUser?.displayName ?? "?")[0].toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
            {aiUser?.displayName ?? "AI User"}
          </span>
          {conversation.kind.tag !== "ContextThread" && (
            <span className="text-[9px] font-semibold uppercase px-1 py-px rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 shrink-0">
              {conversation.kind.tag === "Dm" ? "DM"
                : conversation.kind.tag === "AiDm" ? "AI DM"
                : conversation.kind.tag === "GroupDm" ? "Group DM"
                : "Shared"}
            </span>
          )}
          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />}
        </div>
        {lastMessage && (
          <p className="text-xs text-neutral-400 truncate mt-0.5">
            {lastSenderIsHuman ? "You: " : ""}
            {lastMessage.content}
          </p>
        )}
        {!lastMessage && (
          <p className="text-xs text-neutral-400 italic mt-0.5">No messages yet</p>
        )}
      </div>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 mt-1.5 text-neutral-300 dark:text-neutral-600"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}

// ── Tab type ─────────────────────────────────────────────────────────────────

type PanelTab = "conversations" | "members";

/**
 * AI Users surfaced inside the right panel. This is the Phase A "Members"
 * tab — distinct from the workspace-wide MembersSettings (humans + admin
 * role) since AI users have their own provenance / harness story. Hosts a
 * compact directory that links to the full editor in Settings; the diff
 * review surface, auto-apply scope picker, and harness template selector
 * land here in subsequent phases.
 */
function MembersTab({ onOpenConversation }: { onOpenConversation: (id: bigint) => void }) {
  const { profiles } = useAiUserProfiles();
  const { users } = useUsers();
  const { identity: myIdentity } = useSpacetimeDB();
  const otherHumans = users.filter(
    (u) => !myIdentity || u.identity.toHexString() !== myIdentity.toHexString(),
  );

  return (
    <div className="px-2 py-2 space-y-1">
      {otherHumans.length > 0 && (
        <>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500 px-2 py-1">
            People
          </p>
          {otherHumans.map((user) => (
            <HumanMemberRow
              key={user.identity.toHexString()}
              user={user}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </>
      )}
      {profiles.length > 0 && (
        <>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500 px-2 py-1 mt-2">
            AI Users
          </p>
          {profiles.map((profile) => (
            <AiMemberRow
              key={profile.identity.toHexString()}
              profile={profile}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </>
      )}
      {profiles.length === 0 && otherHumans.length === 0 && (
        <div className="text-center py-10">
          <p className="text-sm text-neutral-400 dark:text-neutral-500">No members yet</p>
          <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-1">
            Create AI users in Settings → AI Users
          </p>
        </div>
      )}
    </div>
  );
}

function HumanMemberRow({
  user,
  onOpenConversation,
}: {
  user: ReturnType<typeof useUsers>["users"][number];
  onOpenConversation: (id: bigint) => void;
}) {
  const { identity: myIdentity } = useSpacetimeDB();
  const findOrCreate = useFindOrCreateDm();
  const dm = useDmConversation(myIdentity, user.identity);
  const [pending, setPending] = useState(false);
  const displayName = user.name || user.email || user.identity.toHexString().slice(0, 8);

  useEffect(() => {
    if (pending && dm) {
      onOpenConversation(dm.id);
      setPending(false);
    }
  }, [pending, dm, onOpenConversation]);

  async function handleDm() {
    if (dm) { onOpenConversation(dm.id); return; }
    setPending(true);
    await findOrCreate({ otherIdentity: user.identity });
  }

  return (
    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
      <div className="w-8 h-8 rounded-full bg-neutral-300 dark:bg-neutral-600 flex items-center justify-center text-neutral-700 dark:text-neutral-200 text-xs font-bold shrink-0">
        {displayName[0]?.toUpperCase() ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
          {displayName}
        </p>
        {user.email && user.name && (
          <p className="text-xs text-neutral-400 truncate">{user.email}</p>
        )}
      </div>
      <button
        onClick={() => void handleDm()}
        disabled={pending}
        className="shrink-0 text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40 transition-colors"
      >
        {pending ? "…" : "Message"}
      </button>
    </div>
  );
}

function AiMemberRow({
  profile,
  onOpenConversation,
}: {
  profile: AiUserProfileRow;
  onOpenConversation: (id: bigint) => void;
}) {
  const { identity: myIdentity } = useSpacetimeDB();
  const findOrCreate = useFindOrCreateAiDm();
  const dm = useDmConversation(myIdentity, profile.identity);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (pending && dm) {
      onOpenConversation(dm.id);
      setPending(false);
    }
  }, [pending, dm, onOpenConversation]);

  async function handleDm() {
    if (dm) { onOpenConversation(dm.id); return; }
    setPending(true);
    await findOrCreate({ aiIdentity: profile.identity });
  }

  return (
    <div className="flex flex-col gap-1 p-2 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-400 to-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5">
          {profile.displayName[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
            {profile.displayName}
          </p>
          <p className="text-xs text-neutral-400 truncate">
            {profile.providerName} · {profile.modelName}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void handleDm()}
            disabled={pending}
            className="shrink-0 text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40 transition-colors"
          >
            {pending ? "…" : "Message"}
          </button>
          <CostBadge aiUserId={profile.aiUserId} />
        </div>
      </div>
      <RetrospectiveRow aiUserIdentity={profile.identity} />
    </div>
  );
}

/**
 * Steering loop retrospective. Shows last-7-day activity for an AI user:
 *   - Edits proposed (PostAgentEdit snapshots whose author is this AI user)
 *   - Edits rejected (PostAgentEdit snapshots whose author is this AI user
 *     AND a later snapshot of the same page exists with the same `pre`
 *     content — i.e. someone hit Reject)
 *   - Open denied tool call findings for this AI user
 * The numbers are deliberately conservative: we only count what we can
 * derive from the relational substrate without instrumentation that
 * doesn't exist yet (no explicit "rejected" flag on snapshots).
 */
function RetrospectiveRow({ aiUserIdentity }: { aiUserIdentity: Identity }) {
  const [snapshots] = useTable(tables.page_snapshot);
  const [findings] = useTable(tables.structural_sensor_finding);
  const meHex = aiUserIdentity.toHexString();
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 3600 * 1000;
  const proposed = snapshots.filter((s) => {
    if (s.snapshotType.tag !== "PostAgentEdit") return false;
    if (s.createdBy.tag !== "Agent") return false;
    if (Number(s.snapshotAt.microsSinceUnixEpoch / BigInt(1000)) < sevenDaysAgoMs)
      return false;
    return (s.createdBy.value as string).includes(meHex.slice(0, 8));
  }).length;
  const denied = findings.filter((f) => {
    if (f.resolvedAt) return false;
    if (f.sensorKind !== "denied_tool_calls") return false;
    return f.detailsJson.includes(meHex.slice(0, 8));
  }).length;
  if (proposed === 0 && denied === 0) return null;
  return (
    <div className="flex items-center gap-2 pl-11 text-[10px] text-neutral-400 dark:text-neutral-500">
      {proposed > 0 && <span>{proposed} edits this week</span>}
      {denied > 0 && (
        <span className="text-amber-500">{denied} permission gaps</span>
      )}
    </div>
  );
}

/**
 * Compact monthly cost / budget badge for an AI user (Phase A cost surface).
 *
 * Sums `orcha_usage_event` rows for the current calendar month, joins with
 * `ai_user_config.monthly_token_cap` to render `used / cap` with color
 * thresholds:
 *   - <80% → muted neutral
 *   - 80-99% → amber warning
 *   - >=100% → rose hard-stop indication (the worker should also refuse new tasks)
 *
 * The cell hover, column header rolling spend, pre-bulk confirmation, and
 * workspace dashboard surfaces the doc lists all consume this same data
 * shape; they are out of scope for the panel-level surface and land
 * incrementally as their host UIs ship.
 */
function CostBadge({ aiUserId }: { aiUserId: bigint }) {
  const [usage] = useTable(tables.orcha_usage_event);
  const [configs] = useTable(tables.ai_user_config);
  const config = configs.find((c) => c.id === aiUserId);
  const cap = config?.monthlyTokenCap ?? null;

  // Calendar-month rollover. Worker / billing might want a fiscal month
  // override later; for now align to UTC for determinism.
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const usedTokens = usage.reduce((sum, e) => {
    if (e.aiUserId !== aiUserId) return sum;
    const eventMs = Number(e.createdAt.microsSinceUnixEpoch / 1000n);
    if (eventMs < monthStart) return sum;
    return sum + Number(e.tokensIn) + Number(e.tokensOut);
  }, 0);

  if (cap == null) {
    return (
      <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">
        {formatTokens(usedTokens)} this month
      </span>
    );
  }

  const capN = Number(cap);
  const ratio = capN > 0 ? usedTokens / capN : 0;
  const cls =
    ratio >= 1
      ? "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300"
      : ratio >= 0.8
        ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
        : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400";
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium ${cls}`}
      title={`${usedTokens.toLocaleString()} / ${capN.toLocaleString()} tokens this month`}
    >
      {formatTokens(usedTokens)} / {formatTokens(capN)}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── Main panel ───────────────────────────────────────────────────────────────

interface AiPanelProps {
  pageId: bigint;
  onClose: () => void;
  /** If set, auto-open this conversation on mount. */
  openConversationId?: bigint;
}

/**
 * "+ New" — starts a fresh conversation with a chosen AI user and opens it.
 * Reducers don't return ids, so we snapshot the existing conversation ids, call
 * `createConversation`, then open the new one initiated by us once it arrives.
 */
function NewConversationButton({ onOpen }: { onOpen: (id: bigint) => void }) {
  const { identity } = useSpacetimeDB();
  const profiles = useAiUserProfiles();
  const { conversations } = useConversations();
  const createConversation = useCreateConversation();
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<Set<string> | null>(null);

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

  async function startWith(aiIdentity: Identity) {
    pendingRef.current = new Set(conversations.map((c) => String(c.id)));
    await createConversation({
      pageId: undefined,
      participantIdentities: [aiIdentity],
      blockAnchor: undefined,
    });
  }

  if (profiles.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="New conversation"
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-20 w-56 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1">
            <p className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-neutral-400">
              Start a conversation with
            </p>
            {profiles.map((p) => (
              <button
                key={String(p.aiUserId)}
                onClick={() => void startWith(p.identity)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                <span className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-400 to-indigo-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                  {p.displayName[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-neutral-800 dark:text-neutral-200 truncate">{p.displayName}</span>
                  <span className="block text-[11px] text-neutral-400 truncate">{p.modelName}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AiPanel({ pageId, onClose, openConversationId }: AiPanelProps) {
  const { identity } = useSpacetimeDB();
  const { conversations: allConversations } = useConversations();
  const conversations = useInboxConversations(identity ?? undefined);

  const [tab, setTab] = useState<PanelTab>("conversations");
  const [selectedConvId, setSelectedConvId] = useState<bigint | null>(
    openConversationId ?? null
  );

  useEffect(() => {
    if (openConversationId == null) return;
    setTab("conversations");
    setSelectedConvId(openConversationId);
  }, [openConversationId]);

  const selectedConv = selectedConvId
    ? allConversations.find((c) => c.id === selectedConvId)
    : null;

  const hasActiveConv = conversations.some((c) => c.status.tag === "Active");

  if (selectedConv) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-neutral-950">
        <ConversationThread
          conversation={selectedConv}
          onBack={() => setSelectedConvId(null)}
          activePageId={pageId}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-neutral-950">
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex-shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab("conversations")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "conversations"
                ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
                : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            }`}
          >
            Conversations
            {hasActiveConv && (
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
            )}
          </button>
          <button
            onClick={() => setTab("members")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "members"
                ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
                : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            }`}
          >
            Members
          </button>
        </div>
        <div className="flex items-center gap-1">
        <NewConversationButton
          onOpen={(id) => {
            setTab("conversations");
            setSelectedConvId(id);
          }}
        />
        <button
          onClick={onClose}
          className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "conversations" && (
          <div className="px-2 py-2">
            {conversations.length === 0 && (
              <div className="text-center py-10">
                <p className="text-sm text-neutral-400 dark:text-neutral-500">
                  No conversations yet
                </p>
                <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-1">
                  Type <span className="font-mono">@</span> in the editor to mention an AI user
                </p>
              </div>
            )}
            {conversations.map((conv) => (
              <ConversationListItem
                key={String(conv.id)}
                conversation={conv}
                onClick={() => setSelectedConvId(conv.id)}
              />
            ))}
          </div>
        )}

        {tab === "members" && <MembersTab onOpenConversation={(id) => { setTab("conversations"); setSelectedConvId(id); }} />}
      </div>
    </div>
  );
}
