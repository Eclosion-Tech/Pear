"use client";

import { useState, useRef, useEffect } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import Markdown from "react-markdown";
import {
  useOrchaJobsForPage,
  useOrchaTasksForJob,
  useCreateJob,
  type OrchaJobRow,
} from "@/src/hooks/useOrcha";
import {
  useConversationsForPage,
  useMessagesForConversation,
  useSendMessage,
  useCloseConversation,
  useParticipantsForConversation,
  identitiesEqual,
  type ConversationRow,
  type ConversationMessageRow,
} from "@/src/hooks/useConversations";
import {
  useAiUserProfiles,
  useAiUserProfileByIdentity,
  useAiUserInConversation,
  type AiUserProfileRow,
} from "@/src/hooks/useAiUsers";

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

function InlineJobStatus({ jobId }: { jobId: bigint }) {
  const tasks = useOrchaTasksForJob(jobId);
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length;
  const isRunning = tasks.some((t) => t.status === "claimed" || t.status === "pending");

  return (
    <div className="mt-1.5 flex items-center gap-2 text-xs">
      {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />}
      <span className="text-neutral-400">
        {done}/{total} tasks done
        {failed > 0 && <span className="text-red-400 ml-1">({failed} failed)</span>}
      </span>
    </div>
  );
}

// ── Thinking block (collapsible) ──────────────────────────────────────────────

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) setExpanded(true);
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

interface ToolCallInfo {
  name: string;
  status: "executing" | "done" | "error";
  result?: string;
}

const TOOL_ICONS: Record<string, string> = {
  web_search: "search",
  fetch_url: "globe",
};

function ToolCallsDisplay({ toolCallsJson }: { toolCallsJson: string }) {
  let calls: ToolCallInfo[] = [];
  try {
    calls = JSON.parse(toolCallsJson);
  } catch {
    return null;
  }
  if (calls.length === 0) return null;

  return (
    <div className="mt-1.5 mb-1.5 space-y-1">
      {calls.map((tc, i) => (
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
          {tc.result && tc.status === "done" && (
            <span className="text-neutral-400 truncate max-w-[150px]" title={tc.result}>
              — {tc.result}
            </span>
          )}
        </div>
      ))}
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
      {toolCallsJson && <ToolCallsDisplay toolCallsJson={toolCallsJson} />}

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

// ── Conversation thread ──────────────────────────────────────────────────────

function ConversationThread({ conversation, onBack }: { conversation: ConversationRow; onBack: () => void }) {
  const aiUser = useAiUserInConversation(conversation.id);
  const messages = useMessagesForConversation(conversation.id);
  const { profiles: allAiProfiles } = useAiUserProfiles();
  const aiIdentityHexes = new Set(allAiProfiles.map((p) => p.identity.toHexString()));
  const sendMessage = useSendMessage();
  const closeConversation = useCloseConversation();
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
      });
      setInput("");
    } catch (err) {
      console.error("[AiPanel] Failed to send message", err);
    } finally {
      setSending(false);
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
                {msg.jobId != null && <InlineJobStatus jobId={msg.jobId} />}
              </div>
            </div>
          );
        })}
      </div>

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
            <button
              onClick={() => closeConversation({ conversationId: conversation.id })}
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
            >
              Close conversation
            </button>
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

type PanelTab = "conversations" | "jobs";

// ── Main panel ───────────────────────────────────────────────────────────────

interface AiPanelProps {
  pageId: bigint;
  onClose: () => void;
  /** If set, auto-open this conversation on mount. */
  openConversationId?: bigint;
}

export function AiPanel({ pageId, onClose, openConversationId }: AiPanelProps) {
  const { identity } = useSpacetimeDB();
  const { conversations } = useConversationsForPage(pageId);
  const { jobs } = useOrchaJobsForPage(pageId);
  const createJob = useCreateJob();

  const [tab, setTab] = useState<PanelTab>("conversations");
  const [selectedConvId, setSelectedConvId] = useState<bigint | null>(
    openConversationId ?? null
  );
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedConv = selectedConvId
    ? conversations.find((c) => c.id === selectedConvId)
    : null;

  const hasActiveJob = jobs.some((j) => j.status === "executing");
  const hasActiveConv = conversations.some((c) => c.status.tag === "Active");

  async function handleSubmitJob(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const taskGraphJson = JSON.stringify([
        {
          description: prompt.trim(),
          task_type: "orchestrate",
          depends_on: [],
          required_capabilities: ["orchestrate"],
        },
      ]);
      await createJob({
        userId: identity?.toHexString() ?? "",
        prompt: prompt.trim(),
        pageId,
        taskGraphJson,
      });
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (selectedConv) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-neutral-950">
        <ConversationThread
          conversation={selectedConv}
          onBack={() => setSelectedConvId(null)}
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
            onClick={() => setTab("jobs")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === "jobs"
                ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
                : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            }`}
          >
            Jobs
            {hasActiveJob && (
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse inline-block" />
            )}
          </button>
        </div>
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

        {tab === "jobs" && (
          <div className="px-4 py-3 space-y-2">
            {jobs.length === 0 && (
              <div className="text-center py-10">
                <p className="text-sm text-neutral-400 dark:text-neutral-500">No AI jobs yet</p>
                <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-1">
                  Use the prompt below to create one
                </p>
              </div>
            )}
            {jobs.map((job) => (
              <JobCard key={String(job.id)} job={job} />
            ))}
          </div>
        )}
      </div>

      {/* Job prompt — only on jobs tab */}
      {tab === "jobs" && (
        <form
          onSubmit={handleSubmitJob}
          className="flex-shrink-0 border-t border-neutral-200 dark:border-neutral-800 p-3 space-y-2"
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you want AI to do…"
            rows={3}
            className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 resize-none outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleSubmitJob(e as unknown as React.FormEvent);
              }
            }}
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={!prompt.trim() || submitting}
            className="w-full py-1.5 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 transition-colors"
          >
            {submitting ? "Creating…" : "Create job  ⌘↵"}
          </button>
        </form>
      )}
    </div>
  );
}
