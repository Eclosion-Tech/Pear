"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { actionDescription, operationsRequest, safeEvidenceLink, type InitiativeCard, type InitiativeView } from '@/src/lib/product-operations/ui';
import type { OperationsProductChoice } from '@/src/lib/product-operations/proxy';

const field = 'mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900';
const button = 'rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900';
const secondary = 'rounded-lg border border-neutral-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-neutral-700';
type Pending = { request: Record<string, unknown>; initiativeId: string };
type Choice = { optionId: string; rationale: string };
const initialForm = { purpose: '', audience: '', problem: '', outcome: '', hypothesis: '', success: '', constraints: '', resource: '', executions: '1', hours: '24' };

export function ProductOperationsPanel({ endpoint, products, bearer }: {
  endpoint: string; products: OperationsProductChoice[]; bearer?: string;
}) {
  const [productId, setProductId] = useState(products[0]?.productId ?? '');
  const [cards, setCards] = useState<InitiativeCard[]>([]);
  const [afterId, setAfterId] = useState<string | undefined>();
  const [selected, setSelected] = useState<InitiativeView | null>(null);
  const [actions, setActions] = useState<{ type: string; reason?: string }[]>([]);
  const [actorId, setActorId] = useState('');
  const [canCreate, setCanCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [form, setForm] = useState(initialForm);
  const generation = useRef(0);
  const verifiedActor = useRef('');
  const product = products.find(item => item.productId === productId);
  const pendingKey = actorId ? `pear-operations-pending:${endpoint}:${productId}:${actorId}` : '';
  const send = useCallback(<T,>(request: Record<string, unknown>) => operationsRequest<T>(endpoint, { ...request, productId }, { bearer }), [endpoint, productId, bearer]);

  const readInitiative = useCallback(async (id: string, version = generation.current) => {
    const [initiative, plan] = await Promise.all([
      send<InitiativeView>({ action: 'get', initiativeId: id }),
      send<{ actions: { type: string; reason?: string }[] }>({ action: 'plan', initiativeId: id }),
    ]);
    if (version !== generation.current) return;
    setSelected(initiative); setActions(plan.actions);
  }, [send]);

  const refresh = useCallback(async (id?: string, appendAfter?: string) => {
    let version = generation.current;
    setBusy(true); setError('');
    try {
      const [identity, listing] = await Promise.all([
        send<{ actor: { id: string; kind: string }; role: string }>({ action: 'whoami' }),
        send<{ items: InitiativeCard[]; nextAfterId?: string }>({ action: 'list', limit: 20, ...(appendAfter ? { afterId: appendAfter } : {}) }),
      ]);
      if (version !== generation.current) return;
      if (verifiedActor.current && verifiedActor.current !== identity.actor.id) {
        version = ++generation.current; id = undefined; appendAfter = undefined;
        setSelected(null); setActions([]); setPending(null); setChoices({}); setForm(initialForm); setShowCreate(false);
      }
      verifiedActor.current = identity.actor.id;
      setActorId(identity.actor.id); setCanCreate(identity.actor.kind === 'human' && ['owner', 'admin'].includes(identity.role));
      setCards(previous => appendAfter ? [...previous, ...listing.items.filter(item => !previous.some(p => p.id === item.id))] : listing.items);
      setAfterId(listing.nextAfterId);
      if (id) await readInitiative(id, version);
    } catch (cause) { if (version === generation.current) { setSelected(null); setCards([]); setActorId(''); verifiedActor.current = ''; setCanCreate(false); setPending(null); setChoices({}); setActions([]); setForm(initialForm); setShowCreate(false); setError(cause instanceof Error ? cause.message : 'Could not load product operations.'); } }
    finally { if (version === generation.current) setBusy(false); }
  }, [send, readInitiative]);

  useEffect(() => {
    generation.current++; verifiedActor.current = ''; setActorId(''); setCanCreate(false); setForm(initialForm); setSelected(null); setCards([]); setActions([]); setPending(null); setChoices({}); setShowCreate(false);
    if (productId) void refresh();
    return () => { generation.current++; };
  }, [productId, refresh]);

  useEffect(() => {
    setPending(null);
    if (!pendingKey) return;
    try {
      const raw = sessionStorage.getItem(pendingKey);
      if (raw && raw.length <= 1_048_576) {
        const saved = JSON.parse(raw) as Pending;
        if (typeof saved.initiativeId === 'string' && saved.request && typeof saved.request === 'object' && saved.request.productId === productId) setPending(saved);
      }
    } catch { /* A draft is never replayed automatically. */ }
  }, [pendingKey, productId]);

  async function submit(payload: Record<string, unknown>, initiativeId: string, revision: number) {
    if (pending || busy) return;
    const draft: Pending = { initiativeId, request: { productId, action: 'apply', initiativeId, command: { id: crypto.randomUUID(), expectedRevision: revision, payload } } };
    try { sessionStorage.setItem(pendingKey, JSON.stringify(draft)); }
    catch { setError('This browser could not retain your submission. Enable session storage before submitting.'); return; }
    setPending(draft); await sendPending(draft);
  }
  async function sendPending(draft: Pending) {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      await send(draft.request);
      if (version !== generation.current) return;
      sessionStorage.removeItem(pendingKey); setPending(null); setShowCreate(false);
      await refresh(draft.initiativeId);
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : 'The result is not confirmed. Refresh before continuing.'); }
    finally { if (version === generation.current) setBusy(false); }
  }
  function create() {
    if (!product || !form.resource) return;
    const executions = Number(form.executions), hours = Number(form.hours);
    if (!Number.isInteger(executions) || executions < 1 || executions > 20 || !Number.isInteger(hours) || hours < 1 || hours > 168) { setError('Choose 1–20 source reads and 1–168 hours.'); return; }
    void submit({ type: 'create', context: { purpose: form.purpose, audience: form.audience, problem: form.problem, intendedOutcome: form.outcome,
      constraints: form.constraints.split('\n').map(s => s.trim()).filter(Boolean) }, contributors: product.controllerActorId ? [product.controllerActorId] : [],
      delegation: { capabilities: ['pear.source.read'], resources: [form.resource], maxExecutions: executions, maxUnits: executions, unit: 'source read', expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString() },
      successCriteria: form.success.split('\n').map(s => s.trim()).filter(Boolean), requiredMetricIds: [], minimumObservationMs: 0,
      hypotheses: [{ id: 'initial-hypothesis', statement: form.hypothesis }],
    }, crypto.randomUUID(), 0);
  }

  if (!products.length) return <div className="p-8 text-sm text-neutral-500">Product operations is not connected for this workspace yet.</div>;
  const isOwner = selected?.ownerId === actorId;
  const terminal = selected && ['completed', 'stopped'].includes(selected.status);
  return <div className="h-full overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <div className="mx-auto max-w-6xl space-y-7 p-6 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-xs uppercase tracking-widest text-neutral-500">Product operations</p><h1 className="mt-2 text-2xl font-semibold">Direction, decisions, and evidence</h1><p className="mt-2 text-sm text-neutral-500">Review what is moving, what needs your judgment, and what we are learning.</p></div>
        <div className="flex items-center gap-2"><label className="text-sm">Product<select aria-label="Product" className={field} value={productId} disabled={busy || !!pending} onChange={e => setProductId(e.target.value)}>{products.map(item => <option key={item.productId} value={item.productId}>{item.label}</option>)}</select></label><button className={secondary} disabled={busy} onClick={() => void refresh(selected?.id)}>Refresh</button></div>
      </header>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</p>}
      {pending && <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"><p>A submission is awaiting confirmation. Check that same submission or review the saved initiative before making another change. Dismissing this reminder does not cancel any saved work.</p><div className="flex flex-wrap gap-2"><button className={secondary} disabled={busy} onClick={() => void sendPending(pending)}>Check submission</button><button className={secondary} disabled={busy} onClick={() => void refresh(pending.initiativeId)}>Review saved state</button><button className={secondary} disabled={busy} onClick={() => { sessionStorage.removeItem(pendingKey); setPending(null); }}>Dismiss submission reminder</button></div></div>}
      <div className="grid items-start gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-3"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Initiatives</h2>{canCreate && <button className="text-sm underline underline-offset-4 disabled:opacity-40" disabled={busy || !!pending} onClick={() => { setShowCreate(true); setForm(v => ({ ...v, resource: product?.sources[0]?.resource ?? '' })); }}>New initiative</button>}</div>
          {!cards.length && !busy && <p className="py-4 text-sm text-neutral-500">No initiatives are visible to your account yet.</p>}
          {cards.map(card => <button key={card.id} onClick={() => { setShowCreate(false); setChoices({}); void refresh(card.id); }} disabled={busy} className={`w-full rounded-xl border p-4 text-left ${selected?.id === card.id ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-neutral-200 dark:border-neutral-800'}`}><span className="block text-sm font-medium">{card.purpose}</span><span className="mt-2 block text-xs text-neutral-500">{card.status}{card.pendingDecisions ? ` · ${card.pendingDecisions} decision${card.pendingDecisions === 1 ? '' : 's'} waiting` : ''}</span></button>)}
          {afterId && <button className={secondary} disabled={busy} onClick={() => void refresh(undefined, afterId)}>Show more</button>}
        </aside>
        <main className="min-w-0 space-y-6">
          {showCreate ? <form className="space-y-4 rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800" onSubmit={e => { e.preventDefault(); create(); }}><h2 className="text-xl font-semibold">Set the direction</h2>
            {([['purpose', 'What are we trying to learn or achieve?'], ['audience', 'Who is this for?'], ['problem', 'What problem are they facing?'], ['outcome', 'What change would matter?'], ['hypothesis', 'What do we believe, and need to test?'], ['success', 'What evidence would count as success?'], ['constraints', 'Constraints (one per line)']] as const).map(([name, label]) => <label key={name} className="block text-sm">{label}<textarea className={field} rows={name === 'purpose' || name === 'audience' ? 1 : 2} required={name !== 'constraints'} maxLength={4000} value={form[name]} onChange={e => setForm(v => ({ ...v, [name]: e.target.value }))} disabled={busy || !!pending} /></label>)}
            <div className="rounded-xl bg-neutral-50 p-4 dark:bg-neutral-900"><h3 className="text-sm font-medium">Initial delegated work</h3><p className="mt-1 text-xs text-neutral-500">Allow source collection within these bounds. Assignments still need to be proposed; this creates the initiative only.</p><label className="mt-3 block text-sm">Permitted source<select className={field} value={form.resource} onChange={e => setForm(v => ({ ...v, resource: e.target.value }))} required disabled={busy || !!pending}>{product?.sources.map(source => <option key={source.resource} value={source.resource}>{source.label}</option>)}</select></label><div className="mt-3 grid grid-cols-2 gap-4"><label className="text-sm">Maximum source reads<input className={field} type="number" min="1" max="20" disabled={busy || !!pending} value={form.executions} onChange={e => setForm(v => ({ ...v, executions: e.target.value }))} required /></label><label className="text-sm">Expires after (hours)<input className={field} type="number" min="1" max="168" disabled={busy || !!pending} value={form.hours} onChange={e => setForm(v => ({ ...v, hours: e.target.value }))} required /></label></div><p className="mt-3 text-xs text-neutral-500">{product?.controllerActorId ? 'The configured workspace controller can perform eligible source reads.' : 'No background controller is connected for this product yet.'}</p></div>
            <button className={button} disabled={busy || !!pending || !product?.sources.length}>Create initiative</button></form>
          : selected ? <>
            <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800"><div className="flex items-center justify-between gap-4"><h2 className="text-xl font-semibold">{selected.context.purpose}</h2><span className="text-xs text-neutral-500">{selected.status}</span></div><dl className="mt-5 space-y-4 text-sm">{[['Audience', selected.context.audience], ['Problem', selected.context.problem], ['Intended outcome', selected.context.intendedOutcome]].map(([label, value]) => <div key={label}><dt className="font-medium text-neutral-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap">{value}</dd></div>)}</dl><p className="mt-5 text-xs text-neutral-500">{selected.executions.length} of {selected.delegation.maxExecutions} delegated executions used · authority expires {new Date(selected.delegation.expiresAt).toLocaleString()}</p></section>
            {!!actions.length && <section><h3 className="text-sm font-semibold">What happens next</h3><ul className="mt-2 space-y-2 text-sm text-neutral-600 dark:text-neutral-300">{actions.map((action, index) => <li key={index}>• {actionDescription(action)}{action.reason ? ` — ${action.reason}` : ''}</li>)}</ul></section>}
            {selected.decisions.map(decision => <section key={decision.id} className="rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800"><p className="text-xs uppercase tracking-wide text-neutral-500">{decision.category} decision</p><h3 className="mt-2 font-medium">{decision.question}</h3>{decision.resolution ? <p className="mt-3 whitespace-pre-wrap text-sm">{decision.options.find(option => option.id === decision.resolution!.optionId)?.description}<span className="mt-2 block text-neutral-500">{decision.resolution.rationale}</span></p> : <form onSubmit={e => { e.preventDefault(); const choice = choices[decision.id]; if (choice?.optionId) void submit({ type: 'resolve_decision', decisionId: decision.id, optionId: choice.optionId, rationale: choice.rationale }, selected.id, selected.revision); }}><div className="mt-4 space-y-2">{decision.options.map(option => <label key={option.id} className="flex items-start gap-2 rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-900"><input type="radio" name={decision.id} value={option.id} checked={choices[decision.id]?.optionId === option.id} disabled={!isOwner || busy || !!pending || !!terminal} required onChange={() => setChoices(v => ({ ...v, [decision.id]: { optionId: option.id, rationale: v[decision.id]?.rationale ?? '' } }))} /><span>{option.description}{decision.recommendedOptionId === option.id && <span className="ml-2 text-xs text-neutral-500">Recommended</span>}</span></label>)}</div><label className="mt-3 block text-sm">Your reasoning<textarea className={field} rows={2} required maxLength={4000} value={choices[decision.id]?.rationale ?? ''} disabled={!isOwner || busy || !!pending || !!terminal} onChange={e => setChoices(v => ({ ...v, [decision.id]: { optionId: v[decision.id]?.optionId ?? '', rationale: e.target.value } }))} /></label><button className={`${button} mt-3`} disabled={!isOwner || busy || !!pending || !!terminal}>Record decision</button>{!isOwner && <p className="mt-2 text-xs text-neutral-500">The initiative owner makes this decision.</p>}</form>}</section>)}
            <section><h3 className="text-sm font-semibold">Work and results</h3>{!selected.assignments.length && <p className="mt-2 text-sm text-neutral-500">No assignments have been proposed yet.</p>}<div className="mt-3 space-y-3">{selected.assignments.map(assignment => <div key={assignment.id} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"><p className="text-sm font-medium">{assignment.objective}</p><p className="mt-1 text-xs text-neutral-500">{assignment.status}</p>{selected.executions.filter(execution => execution.assignmentId === assignment.id).map(execution => <p key={execution.id} className="mt-2 text-sm text-neutral-500">{execution.explanation ?? 'Execution is in progress.'}</p>)}</div>)}</div></section>
            <section><h3 className="text-sm font-semibold">Evidence</h3><div className="mt-3 space-y-3">{selected.evidence.map(evidence => { const href = safeEvidenceLink(evidence.source.uri); return <div key={evidence.id} className="rounded-xl bg-neutral-50 p-4 dark:bg-neutral-900"><p className="whitespace-pre-wrap text-sm">{evidence.summary}</p><p className="mt-2 text-xs text-neutral-500">{evidence.kind} · {evidence.source.owner} · {new Date(evidence.capturedAt).toLocaleString()}</p>{href && <a href={href} target="_blank" rel="noreferrer noopener" className="mt-2 inline-block text-xs underline underline-offset-4">View source</a>}</div>; })}{!selected.evidence.length && <p className="text-sm text-neutral-500">No evidence has been recorded yet.</p>}</div></section>
            {!!selected.evaluations.length && <section><h3 className="text-sm font-semibold">Outcome assessments</h3>{selected.evaluations.map(evaluation => <div key={evaluation.id} className="mt-3 text-sm"><p className="font-medium">{evaluation.verdict.replaceAll('_', ' ')}</p><p className="mt-1 whitespace-pre-wrap text-neutral-500">{evaluation.rationale}</p></div>)}</section>}
          </> : <p className="py-12 text-sm text-neutral-500">{busy ? 'Loading product operations…' : 'Choose an initiative to review its direction, decisions, and evidence.'}</p>}
        </main>
      </div>
    </div>
  </div>;
}
