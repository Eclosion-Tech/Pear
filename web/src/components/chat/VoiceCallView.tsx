"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTable } from "spacetimedb/react";

import { useSendUserMessage } from "@/src/hooks/useConversations";
import { usePages, useSetPropertyValue } from "@/src/hooks/usePages";
import { tables } from "@/src/module_bindings";
import {
  VoiceCall,
  callRecordMessage,
  createBrowserCallAudio,
  createTurnDetector,
  decisionWrites,
  encodeWav,
  fetchVoiceAvailability,
  hostVoiceUpstream,
  isCallSheet,
  readCallSheet,
  type BrowserCallAudio,
  type CallSheet,
  type CallState,
  type CallStatus,
  type TurnDetector,
  type VoiceAvailability,
} from "@/src/lib/voice";

const SHEET_KEY = "pear.voice.callSheet";
const STATUS_LABEL: Record<CallStatus, string> = {
  idle: "Not started",
  connecting: "Connecting",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * A voice call with an AI user, in place of the thread.
 *
 * The call walks through a call sheet: any database with a text column named
 * "Say". Each row is one thing to ask. Answers are written to the row's
 * Decision column as they are given, and when the call ends its record is
 * sent to the conversation as an ordinary message, for the AI user to act on.
 */
export function VoiceCallView({
  aiUserId,
  aiUserName,
  conversationId,
  onClose,
}: {
  aiUserId: bigint;
  aiUserName: string;
  conversationId: bigint;
  onClose: () => void;
}) {
  const { pages } = usePages();
  const [schemas] = useTable(tables.database_schema);
  const [definitions] = useTable(tables.property_definition);
  const [values] = useTable(tables.page_property_value);
  const setPropertyValue = useSetPropertyValue();
  const sendUserMessage = useSendUserMessage();

  const [availability, setAvailability] = useState<VoiceAvailability | null>(null);
  const [sheetId, setSheetId] = useState<string>("");
  const [state, setState] = useState<CallState | null>(null);
  const [level, setLevel] = useState({ rms: 0, threshold: 0.012 });
  const [allowInterrupt, setAllowInterrupt] = useState(true);
  const [endpointMs, setEndpointMs] = useState(700);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const live = useRef<{ call: VoiceCall; audio: BrowserCallAudio; sheet: CallSheet; title: string } | null>(null);
  const detector = useRef<TurnDetector | null>(null);
  const allowInterruptRef = useRef(allowInterrupt);
  const endpointRef = useRef(endpointMs);
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

  useEffect(() => {
    if (sheetId || sheets.length === 0) return;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(SHEET_KEY);
    } catch {
      // Storage can be unavailable; the first sheet is a fine default.
    }
    const pick = sheets.find((entry) => entry.page.id.toString() === remembered) ?? sheets[0];
    setSheetId(pick.page.id.toString());
  }, [sheets, sheetId]);

  const selected = sheets.find((entry) => entry.page.id.toString() === sheetId);
  const preview = useMemo(
    () => (selected ? readCallSheet({ definitions: selected.definitions, rows: pages.filter((page) => page.parentId === selected.page.id), values }) : null),
    [selected, pages, values],
  );
  const openCount = preview ? preview.items.filter((item) => !preview.decisions[item.id]).length : 0;

  const start = useCallback(async () => {
    if (!selected || !preview || !availability?.available || !availability.models) return;
    setError(null);
    setBusy(true);
    const sheet = preview;
    const audio = createBrowserCallAudio();
    const call = new VoiceCall({
      upstream: hostVoiceUpstream(aiUserId, availability),
      models: availability.models,
      voice: availability.defaultVoice ?? "alloy",
      assistantName: aiUserName,
      items: sheet.items,
      decisions: sheet.decisions,
      audio,
      onChange: setState,
      onDecision: async (itemId, decision) => {
        for (const write of decisionWrites(sheet, itemId, decision)) await setPropertyValue(write);
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
    try {
      window.localStorage.setItem(SHEET_KEY, selected.page.id.toString());
    } catch {
      // Not remembering the choice is harmless.
    }
    live.current = { call, audio, sheet, title: selected.page.title };
    setBusy(false);
    await call.start();
  }, [selected, preview, availability, aiUserId, aiUserName, setPropertyValue]);

  const end = useCallback(async () => {
    const current = live.current;
    if (!current) return onClose();
    live.current = null;
    detector.current = null;
    current.call.end();
    await current.audio.close();
    const finalState = current.call.state;
    // A call nobody spoke on leaves nothing for the AI user to act on.
    if (finalState.turns.some((turn) => turn.role === "user")) {
      try {
        await sendUserMessage({
          conversationId,
          content: callRecordMessage({ items: current.sheet.items, state: finalState, sheetTitle: current.title }),
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

  const inCall = state !== null && state.status !== "idle";
  const items = live.current?.sheet.items ?? preview?.items ?? [];
  const decisions = state?.decisions ?? preview?.decisions ?? {};
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
            disabled={busy || !preview || openCount === 0}
            className="rounded bg-neutral-900 px-3 py-1 font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Start call
          </button>
        )}
        <span role="status" aria-live="polite" className="font-medium">
          {state ? STATUS_LABEL[state.status] : `Call with ${aiUserName}`}
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

      {!inCall ? (
        <div className="flex flex-col gap-3 p-3">
          {sheets.length === 0 ? (
            <p className="text-neutral-500">
              No call sheet yet. A call sheet is any database with a text column named “Say”: one row per thing to ask, with optional
              “Recommendation”, “Detail”, “Source”, “Decision” and “Quote” columns.
            </p>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">Call sheet</span>
              <select
                value={sheetId}
                onChange={(event) => setSheetId(event.target.value)}
                className="rounded border border-neutral-200 bg-transparent p-1 dark:border-neutral-700"
              >
                {sheets.map((entry) => (
                  <option key={entry.page.id.toString()} value={entry.page.id.toString()}>
                    {entry.page.title || "Untitled"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {preview ? (
            <p className="text-neutral-500">
              {openCount === 0
                ? "Every row on this sheet already has a decision."
                : `${openCount} of ${preview.items.length} item${preview.items.length === 1 ? "" : "s"} to go through. Answer out loud; headphones work best.`}
            </p>
          ) : null}
        </div>
      ) : (
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
          {gap !== null ? <span className="tabular-nums">Reply after {gap} ms</span> : null}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-2 gap-px overflow-hidden bg-neutral-200 dark:bg-neutral-800">
        <ol className="min-h-0 overflow-y-auto bg-white p-3 dark:bg-neutral-950">
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
        <ul className="min-h-0 overflow-y-auto bg-white p-3 dark:bg-neutral-950">
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
      </div>
    </div>
  );
}
