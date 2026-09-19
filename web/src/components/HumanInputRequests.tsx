"use client";

import { useState } from "react";
import { useReducer, useSpacetimeDB, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";
import type { HumanInputRequest } from "@/src/module_bindings/types";

function Question({ request }: { request: HumanInputRequest }) {
  const { identity } = useSpacetimeDB();
  const answerRequest = useReducer(reducers.answerHumanInput);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAnswer = identity?.toHexString() === request.recipient.toHexString() && !request.answeredAt;
  return <div className="rounded-md border border-amber-300 p-3 text-sm dark:border-amber-800">
    <p className="font-semibold">{request.answeredAt ? "Answered" : "Needs your input"}</p>
    <p className="mt-1 whitespace-pre-wrap">{request.question}</p>
    {request.answer && <p className="mt-2 whitespace-pre-wrap">{request.answer}</p>}
    {canAnswer && <form className="mt-2 space-y-2" onSubmit={async event => {
      event.preventDefault(); if (busy || !answer.trim()) return;
      setBusy(true); setError(null);
      try { await answerRequest({ requestId: request.id, answer }); setAnswer(""); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not send answer"); }
      finally { setBusy(false); }
    }}>
      <textarea aria-label="Your answer" className="w-full rounded border bg-transparent p-2" value={answer} onChange={e => setAnswer(e.target.value)} maxLength={16384} disabled={busy}/>
      <button type="submit" disabled={busy || !answer.trim()} className="rounded bg-emerald-700 px-3 py-1.5 text-white disabled:opacity-50">{busy ? "Sending…" : "Send answer"}</button>
      {error && <p role="alert" className="text-red-600">{error}</p>}
    </form>}
  </div>;
}

export function HumanInputRequests({ conversationId }: { conversationId: bigint }) {
  const [requests] = useTable(tables.human_input_request);
  return <>{requests.filter(r => r.conversationId === conversationId).map(r => <Question key={String(r.id)} request={r} />)}</>;
}
