"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";

import {
  VoiceCall,
  callRecordMessage,
  createBrowserCallAudio,
  createTurnDetector,
  encodeWav,
  type BrowserCallAudio,
  type CallRequest,
  type CallState,
  type CallStatus,
  type TurnDetector,
} from "@eclosion-tech/chat-voice";

import { useConversationMessages, useSendUserMessage } from "@/src/hooks/useConversations";
import { usePages, useSetPropertyValue } from "@/src/hooks/usePages";
import { tables } from "@/src/module_bindings";
import {
  decisionWrites,
  fetchVoiceAvailability,
  hostVoiceUpstream,
  isCallSheet,
  newestMessageId,
  readCallSheet,
  recentTurns,
  settleRequests,
  voiceRequestMessage,
  type CallSheet,
  type PendingRequest,
  type VoiceAvailability,
} from "@/src/lib/voice";

/** How long the AI user has to answer a request before the caller is told it is taking too long. */
const REQUEST_TIMEOUT_MS = 180_000;
const STATUS_LABEL: Record<CallStatus, string> = {
  idle: "Not started",
  connecting: "Connecting",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};
const REQUEST_LABEL: Record<CallRequest["status"], string> = { pending: "Working on it", answered: "Answered", failed: "Not done" };

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

interface Agenda {
  /** The database page the agenda was read from. */
  pageId: string;
  sheet: CallSheet;
  title: string;
}

/**
 * A voice call with an AI user, in place of the thread.
 *
 * The call is a conversation, and it starts as soon as the view opens. The
 * voice model answers fast and has no tools, so two things tie it to the AI
 * user's real work, both through this conversation: it is given the latest
 * messages going in, and anything the caller asks for that needs the workspace
 * is sent to the AI user as a message, whose answer is spoken when it arrives.
 *
 * An agenda can be attached at any point: any database with a text column
 * named "Say", one row per thing to ask. Answers are written to the row's
 * Decision column as they are given. When the call ends, its record is sent to
 * the conversation as an ordinary message.
 */
export function VoiceCallView({
  aiUserId,
  aiUserName,
  aiIdentityHex,
  conversationId,
  onClose,
}: {
  aiUserId: bigint;
  aiUserName: string;
  /** The AI user's identity, to tell its messages in the conversation from the caller's. */
  aiIdentityHex: string;
  conversationId: bigint;
  onClose: () => void;
}) {
  const { identity } = useSpacetimeDB();
  const callerIdentityHex = identity?.toHexString() ?? "";
  const { pages } = usePages();
  const [schemas] = useTable(tables.database_schema);
  const [definitions] = useTable(tables.property_definition);
  const [values] = useTable(tables.page_property_value);
  const messages = useConversationMessages();
  const setPropertyValue = useSetPropertyValue();
  const sendUserMessage = useSendUserMessage();

  const [availability, setAvailability] = useState<VoiceAvailability | null>(null);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [state, setState] = useState<CallState | null>(null);
  const [level, setLevel] = useState({ rms: 0, threshold: 0.012 });
  const [allowInterrupt, setAllowInterrupt] = useState(true);
  const [endpointMs, setEndpointMs] = useState(700);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const live = useRef<{ call: VoiceCall; audio: BrowserCallAudio } | null>(null);
  const detector = useRef<TurnDetector | null>(null);
  const opened = useRef(false);
  const waiting = useRef<Array<PendingRequest & { sentAt: number }>>([]);
  const claimed = useRef(new Set<bigint>());
  const agendaRef = useRef(agenda);
  const messagesRef = useRef(messages);
  const allowInterruptRef = useRef(allowInterrupt);
  const endpointRef = useRef(endpointMs);
  agendaRef.current = agenda;
  messagesRef.current = messages;
  allowInterruptRef.current = allowInterrupt;
  endpointRef.current = endpointMs;

  useEffect(() => {
    let current = true;
    void fetchVoiceAvailability(aiUserId).then((result) => {
      if (current) setAvailability(result);
    });
    return () => {
      current = false;
    };
  }, [aiUserId]);

  // Every database with a text column named "Say", most recently changed first.
  const sheets = useMemo(() => {
    const bySchema = new Map<bigint, Array<(typeof definitions)[number]>>();
    for (const definition of definitions) {
      const list = bySchema.get(definition.schemaId);
      if (list) list.push(definition);
      else bySchema.set(definition.schemaId, [definition]);
    }
    const schemaByPage = new Map(schemas.map((schema) => [schema.pageId, schema.id]));
    return pages
      .filter((page) => page.pageType.tag === "Database")
      .map((page) => ({ page, definitions: bySchema.get(schemaByPage.get(page.id) ?? -1n) ?? [] }))
      .filter((entry) => isCallSheet(entry.definitions))
      .sort((a, b) => (a.page.updatedAt.microsSinceUnixEpoch < b.page.updatedAt.microsSinceUnixEpoch ? 1 : -1));
  }, [pages, schemas, definitions]);

  /** Hands answers the AI user has written in the conversation back to the call. */
  const settle = useCallback(() => {
    const call = live.current?.call;
    if (!call || waiting.current.length === 0) return;
    const { rows, outcomes } = settleRequests({
      pending: waiting.current,
      messages: messagesRef.current,
      conversationId,
      callerIdentityHex,
      aiIdentityHex,
      claimed: claimed.current,
    });
    for (const row of rows) {
      const request = waiting.current.find((entry) => entry.id === row.id);
      if (request) request.rowId = row.rowId;
    }
    for (const outcome of outcomes) {
      claimed.current.add(outcome.replyId);
      waiting.current = waiting.current.filter((entry) => entry.id !== outcome.id);
      if (outcome.status === "answered") call.answerRequest(outcome.id, outcome.text);
      else call.failRequest(outcome.id, outcome.text);
    }
    const now = Date.now();
    for (const request of waiting.current.filter((entry) => now - entry.sentAt > REQUEST_TIMEOUT_MS)) {
      waiting.current = waiting.current.filter((entry) => entry.id !== request.id);
      call.failRequest(request.id, "no answer has come back yet; it will be in the chat when it does");
    }
  }, [conversationId, callerIdentityHex, aiIdentityHex]);

  useEffect(() => {
    settle();
  }, [messages, settle]);
  useEffect(() => {
    const timer = setInterval(settle, 3000);
    return () => clearInterval(timer);
  }, [settle]);

  const start = useCallback(async () => {
    if (live.current || !availability?.available || !availability.models) return;
    setError(null);
    setBusy(true);
    const audio = createBrowserCallAudio();
    const going = agendaRef.current;
    const call = new VoiceCall({
      upstream: hostVoiceUpstream(aiUserId, availability),
      models: availability.models,
      voice: availability.defaultVoice ?? "alloy",
      assistantName: aiUserName,
      items: going?.sheet.items,
      decisions: going?.sheet.decisions,
      context: { recent: recentTurns(messagesRef.current, { conversationId, aiIdentityHex }) },
      audio,
      onChange: setState,
      onDecision: async (itemId, decision) => {
        const current = agendaRef.current;
        if (!current) return;
        for (const write of decisionWrites(current.sheet, itemId, decision)) await setPropertyValue(write);
      },
      // The AI user does the work: the request goes to it as a message, and
      // `settle` hands its answer back when it has written one.
      onRequest: async (request) => {
        const message = voiceRequestMessage(request.text);
        const entry = { id: request.id, message, afterId: newestMessageId(messagesRef.current, conversationId), sentAt: Date.now() };
        waiting.current.push(entry);
        try {
          await sendUserMessage({ conversationId, content: message, attachments: [] });
        } catch (cause) {
          waiting.current = waiting.current.filter((other) => other !== entry);
          throw new Error(cause instanceof Error ? `it could not be sent to the chat: ${cause.message}` : "it could not be sent to the chat");
        }
      },
    });
    let blocks = 0;
    try {
      await audio.start((block) => {
        detector.current ??= createTurnDetector(audio.sampleRate, { endpointMs: endpointRef.current });
        const event = detector.current.push(block, { assistantAudible: audio.playing, allowInterrupt: allowInterruptRef.current });
        blocks += 1;
        if (blocks % 5 === 0) setLevel(detector.current.level);
        if (!event) return;
        if (event.type === "speech-start") call.callerStartedSpeaking();
        else if (event.type === "discarded") call.callerWentQuiet();
        else void call.submit(encodeWav(event.blocks, audio.sampleRate), event.quietMs);
      });
    } catch (cause) {
      await audio.close();
      setBusy(false);
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "The microphone is blocked for this site." : "Could not start the microphone.");
      return;
    }
    live.current = { call, audio };
    setBusy(false);
    await call.start();
  }, [availability, aiUserId, aiUserName, aiIdentityHex, conversationId, sendUserMessage, setPropertyValue]);

  // Pressing Call is the request to start: the call opens as soon as the host says it can.
  useEffect(() => {
    if (opened.current || !availability?.available) return;
    opened.current = true;
    void start();
  }, [availability, start]);

  const chooseAgenda = useCallback(
    (pageId: string) => {
      const entry = sheets.find((candidate) => candidate.page.id.toString() === pageId);
      const next: Agenda | null = entry
        ? {
            pageId,
            sheet: readCallSheet({ definitions: entry.definitions, rows: pages.filter((page) => page.parentId === entry.page.id), values }),
            title: entry.page.title,
          }
        : null;
      agendaRef.current = next;
      setAgenda(next);
      void live.current?.call.setAgenda(next?.sheet.items ?? [], next?.sheet.decisions ?? {});
    },
    [sheets, pages, values],
  );

  const end = useCallback(async () => {
    const current = live.current;
    if (!current) return onClose();
    live.current = null;
    detector.current = null;
    waiting.current = [];
    current.call.end();
    await current.audio.close();
    const finalState = current.call.state;
    // A call nobody spoke on leaves nothing for the AI user to read.
    if (finalState.turns.some((turn) => turn.role === "user")) {
      const withAgenda = agendaRef.current;
      try {
        await sendUserMessage({
          conversationId,
          content: callRecordMessage({ items: withAgenda?.sheet.items ?? [], state: finalState, sheetTitle: withAgenda?.title }),
          attachments: [],
        });
      } catch (cause) {
        setError(cause instanceof Error ? `The call ended, but its record could not be sent: ${cause.message}` : "The call ended, but its record could not be sent.");
        return;
      }
    }
    onClose();
  }, [conversationId, onClose, sendUserMessage]);

  // Leaving the view mid-call hangs up and releases the microphone.
  useEffect(
    () => () => {
      const current = live.current;
      live.current = null;
      if (current) {
        current.call.end();
        void current.audio.close();
      }
    },
    [],
  );

  useEffect(() => {
    detector.current?.setEndpointMs(endpointMs);
  }, [endpointMs]);

  const inCall = state !== null && state.status !== "idle" && state.status !== "ended";
  const items = agenda?.sheet.items ?? [];
  const decisions = state?.decisions ?? agenda?.sheet.decisions ?? {};
  const requests = state?.requests ?? [];
  const gap = median(state?.gapsMs ?? []);

  if (!availability) {
    return <p className="p-4 text-sm text-neutral-500">Checking whether {aiUserName} can take a call…</p>;
  }
  if (!availability.available) {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm">
        <p>{availability.reason ?? "Voice calls are unavailable."}</p>
        <button type="button" onClick={onClose} className="self-start rounded border border-neutral-200 px-3 py-1 dark:border-neutral-700">
          Back to the thread
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        {inCall ? (
          <button type="button" onClick={() => void end()} className="rounded border border-neutral-200 px-3 py-1 font-medium dark:border-neutral-700">
            End call
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className="rounded bg-neutral-900 px-3 py-1 font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Start call
          </button>
        )}
        <span role="status" aria-live="polite" className="font-medium">
          {state ? STATUS_LABEL[state.status] : busy ? "Starting" : `Call with ${aiUserName}`}
        </span>
        {inCall ? (
          <span aria-hidden="true" className="relative h-1.5 min-w-24 flex-1 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700">
            <span className="absolute inset-y-0 left-0 bg-green-500" style={{ width: `${Math.min(100, level.rms * 500)}%` }} />
            <span className="absolute inset-y-0 w-0.5 bg-neutral-900 dark:bg-neutral-100" style={{ left: `${Math.min(100, level.threshold * 500)}%` }} />
          </span>
        ) : (
          <button type="button" onClick={onClose} className="ml-auto text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
            Back to the thread
          </button>
        )}
      </div>

      {error ? (
        <p role="alert" className="px-3 py-2 text-red-600">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={allowInterrupt} onChange={(event) => setAllowInterrupt(event.target.checked)} />
          Let me interrupt
        </label>
        <label className="flex items-center gap-1.5">
          Wait after I stop
          <input type="range" min={400} max={1500} step={50} value={endpointMs} onChange={(event) => setEndpointMs(Number(event.target.value))} />
          <span className="tabular-nums">{endpointMs} ms</span>
        </label>
        {sheets.length > 0 ? (
          <label className="flex items-center gap-1.5">
            Agenda
            <select
              value={agenda?.pageId ?? ""}
              onChange={(event) => chooseAgenda(event.target.value)}
              className="max-w-44 rounded border border-neutral-200 bg-transparent p-0.5 dark:border-neutral-700"
            >
              <option value="">None, just talk</option>
              {sheets.map((entry) => (
                <option key={entry.page.id.toString()} value={entry.page.id.toString()}>
                  {entry.page.title || "Untitled"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {gap !== null ? <span className="tabular-nums">Reply after {gap} ms</span> : null}
      </div>

      <div className={`grid min-h-0 flex-1 gap-px overflow-hidden bg-neutral-200 dark:bg-neutral-800 ${items.length || requests.length ? "grid-rows-2" : "grid-rows-1"}`}>
        <ol className="min-h-0 overflow-y-auto bg-white p-3 dark:bg-neutral-950">
          {(state?.turns ?? []).length === 0 ? <li className="text-neutral-400">Talk when you are ready. Headphones work best.</li> : null}
          {(state?.turns ?? []).map((turn, index) => (
            <li key={index} className="mb-2">
              <span className="block text-xs text-neutral-400">{turn.role === "user" ? "You" : aiUserName}</span>
              <span className={turn.pending || turn.error ? "text-neutral-400" : undefined}>
                {turn.error ? `Something went wrong: ${turn.error}` : turn.text || (turn.role === "user" ? "Transcribing…" : "…")}
              </span>
              {turn.interrupted ? <span className="ml-1 text-xs text-neutral-400">(interrupted)</span> : null}
            </li>
          ))}
        </ol>
        {items.length || requests.length ? (
          <ul className="min-h-0 overflow-y-auto bg-white p-3 dark:bg-neutral-950">
            {requests.map((request) => (
              <li
                key={request.id}
                className={`mb-2 border-l-2 pl-2 ${request.status === "answered" ? "border-green-500" : request.status === "failed" ? "border-red-500" : "border-amber-500"}`}
              >
                <span className="block font-medium">{request.text}</span>
                <span className={request.status === "pending" ? "text-neutral-400" : undefined}>
                  {REQUEST_LABEL[request.status]}
                  {request.status === "failed" && request.answer ? `: ${request.answer}` : ""}
                </span>
              </li>
            ))}
            {items.map((item) => {
              const decision = decisions[item.id];
              const current = !decision && state?.currentItem === item.id;
              return (
                <li
                  key={item.id}
                  className={`mb-2 border-l-2 pl-2 ${decision ? "border-green-500" : current ? "border-amber-500" : "border-neutral-200 dark:border-neutral-700"}`}
                >
                  <span className="block font-medium">{item.title}</span>
                  <span className={decision ? undefined : "text-neutral-400"}>{decision ? decision.decision : "Open"}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
