// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProductOperationsPanel } from './ProductOperationsPanel';
import type { InitiativeView } from '@/src/lib/product-operations/ui';
import type { OperationsProductChoice } from '@/src/lib/product-operations/proxy';

const endpoint = '/api/product-operations';
const products: OperationsProductChoice[] = [
  { productId: 'alpha', label: 'Notebook', sources: [{ resource: 'alpha:brief', label: 'Notebook brief' }] },
  { productId: 'beta', label: 'Planner', sources: [{ resource: 'beta:brief', label: 'Planner brief' }] },
];
function initiative(productId = 'alpha'): InitiativeView {
  return { id: productId + '-initiative', revision: 17, ownerId: 'human:owner', status: 'investigating',
    context: { purpose: productId === 'alpha' ? 'Understand Notebook audience' : 'Understand Planner audience', audience: 'Editors', problem: 'An uncertain workflow', intendedOutcome: 'An evidenced direction', constraints: [] },
    successCriteria: ['Evidence'], delegation: { resources: [productId + ':brief'], capabilities: ['pear.source.read'], maxExecutions: 1, maxUnits: 1, expiresAt: '2026-10-28T12:00:00.000Z' },
    decisions: [{ id: 'direction', category: 'direction', question: 'Which audience should we study?', recommendedOptionId: 'editors', evidenceIds: ['source'],
      options: [{ id: 'editors', description: 'Study editors first' }, { id: 'reviewers', description: 'Study reviewers instead' }] }],
    assignments: [], executions: [], observations: [], evaluations: [],
    evidence: [{ id: 'source', kind: 'research', summary: 'Audience notes are available.', source: { owner: 'alpha', uri: 'https://evidence.example.test/brief' }, capturedAt: '2026-10-27T12:00:00.000Z' }],
  };
}
type RequestBody = Record<string, unknown> & { action: string; productId: string; initiativeId?: string; command?: { id: string; expectedRevision: number; payload: Record<string, unknown> } };
type Seen = { body: RequestBody; headers: Headers; init: RequestInit; endpoint: string };
let root: Root | undefined, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  container.remove(); sessionStorage.clear(); vi.unstubAllGlobals();
});
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === text || item.textContent?.startsWith(text));
  expect(found, `button ${text}`).toBeDefined(); return found!;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function change(element: HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function render(bearer = 'human-id-token', path = endpoint) {
  root ??= createRoot(container);
  await act(async () => { root!.render(createElement(ProductOperationsPanel, { endpoint: path, products, bearer })); });
}
function harness() {
  const views = { alpha: initiative(), beta: initiative('beta') };
  const seen: Seen[] = [];
  const identity = { id: 'human:owner', kind: 'human', role: 'owner' };
  let intercept: ((request: RequestBody) => Response | Promise<Response> | undefined) | undefined;
  const reply = (body: RequestBody): Response => {
    const view = views[body.productId as keyof typeof views];
    if (body.action === 'whoami') return Response.json({ ok: true, result: { actor: { id: identity.id, kind: identity.kind }, role: identity.role } });
    if (body.action === 'list') return Response.json({ ok: true, result: { items: [{ id: view.id, revision: view.revision, status: view.status, purpose: view.context.purpose,
      audience: view.context.audience, intendedOutcome: view.context.intendedOutcome, pendingDecisions: view.decisions.filter(item => !item.resolution).length, updatedAt: '2026-10-27T12:00:00.000Z' }] } });
    if (body.action === 'get') return Response.json({ ok: true, result: view });
    if (body.action === 'plan') return Response.json({ ok: true, result: { actions: [{ type: 'await_decision' }] } });
    if (body.action === 'apply') {
      const payload = body.command!.payload;
      if (payload.type === 'resolve_decision') view.decisions[0].resolution = { optionId: String(payload.optionId), rationale: String(payload.rationale) };
      return Response.json({ ok: true, result: { commandId: body.command!.id, revision: ++view.revision, initiative: view } });
    }
    throw new Error('Unexpected fixture action: ' + body.action);
  };
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as RequestBody;
    seen.push({ body, headers: new Headers(init.headers), init, endpoint: String(url) });
    return intercept?.(body) ?? reply(body);
  });
  return { views, seen, identity, reply, intercept(callback: typeof intercept) { intercept = callback; } };
}
async function chooseAlternative() {
  await click(container.querySelector<HTMLInputElement>('input[type="radio"][value="reviewers"]')!);
  await change(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Reviewers experience the more urgent problem.');
}

describe('ProductOperationsPanel human flow', () => {
  it('loads authenticated summaries, selects the initiative, and leaves the recommended decision unselected', async () => {
    const h = harness(); await render();
    expect(h.seen.map(item => item.body.action)).toEqual(['whoami', 'list']);
    for (const request of h.seen) {
      expect(request.headers.get('authorization')).toBe('Bearer human-id-token');
      expect(request.init.credentials).toBe('same-origin'); expect(request.init.redirect).toBe('error');
      expect(request.body.productId).toBe('alpha'); expect(request.endpoint).toBe(endpoint);
    }
    await click(button('Understand Notebook audience'));
    expect(container.textContent).toContain('Which audience should we study?');
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(input => !input.checked)).toBe(true);
    expect(container.textContent).toContain('Recommended');
    expect(h.seen.filter(item => item.body.action === 'apply')).toHaveLength(0);
  });
  it('submits the chosen alternative with the displayed revision and no supplied actor', async () => {
    const h = harness(); await render(); await click(button('Understand Notebook audience')); await chooseAlternative();
    await click(button('Record decision'));
    const writes = h.seen.filter(item => item.body.action === 'apply'); expect(writes).toHaveLength(1);
    expect(writes[0].body.command).toEqual({ id: expect.any(String), expectedRevision: 17,
      payload: { type: 'resolve_decision', decisionId: 'direction', optionId: 'reviewers', rationale: 'Reviewers experience the more urgent problem.' } });
    expect(writes[0].body).not.toHaveProperty('actor'); expect(writes[0].body).not.toHaveProperty('scope');
    expect(container.textContent).toContain('Reviewers experience the more urgent problem.');
    expect(container.querySelector('input[type="radio"]')).toBeNull();
  });
  it('keeps unresolved choices owner-only for a human contributor', async () => {
    const h = harness(); h.identity.id = 'human:contributor'; h.identity.role = 'member'; await render(); await click(button('Understand Notebook audience'));
    expect(button('Record decision').disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(input => input.disabled)).toBe(true);
    expect(container.textContent).toContain('The initiative owner makes this decision.');
    expect([...container.querySelectorAll('button')].some(item => item.textContent === 'New initiative')).toBe(false);
    await click(button('Record decision')); expect(h.seen.filter(item => item.body.action === 'apply')).toHaveLength(0);
  });
  it('retains the exact uncertain command across remount and only checks it on an explicit click', async () => {
    const h = harness(); let attempts = 0;
    h.intercept(body => { if (body.action !== 'apply') return; attempts++; if (attempts === 1) return Promise.reject(new Error('Connection was lost.')); });
    await render(); await click(button('Understand Notebook audience')); await chooseAlternative(); await click(button('Record decision'));
    expect(attempts).toBe(1); expect(container.textContent).toContain('A submission is awaiting confirmation');
    const original = structuredClone(h.seen.find(item => item.body.action === 'apply')!.body);
    const key = `pear-operations-pending:${endpoint}:alpha:human:owner`;
    expect(JSON.parse(sessionStorage.getItem(key)!).request).toEqual(original);
    await act(async () => root!.unmount()); root = undefined; await render();
    expect(attempts).toBe(1); expect(container.textContent).toContain('A submission is awaiting confirmation');
    await click(button('Review saved state')); expect(attempts).toBe(1);
    await click(button('Check submission')); expect(attempts).toBe(2);
    expect(h.seen.filter(item => item.body.action === 'apply').map(item => item.body)).toEqual([original, original]);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('ignores an old product response after the product generation changes', async () => {
    const h = harness(); let completeOld!: (response: Response) => void;
    h.intercept(body => body.productId === 'alpha' && body.action === 'get' ? new Promise<Response>(resolve => { completeOld = resolve; }) : undefined);
    await render(); await click(button('Understand Notebook audience'));
    // Stress the response generation guard independently of the select's busy affordance.
    await change(container.querySelector<HTMLSelectElement>('select[aria-label="Product"]')!, 'beta');
    await click(button('Understand Planner audience'));
    expect(container.querySelector('main')?.textContent).toContain('Understand Planner audience');
    await act(async () => completeOld(Response.json({ ok: true, result: { ...h.views.alpha, context: { ...h.views.alpha.context, purpose: 'STALE PRIVATE NOTEBOOK RESPONSE' } } })));
    expect(container.textContent).not.toContain('STALE PRIVATE NOTEBOOK RESPONSE');
    expect(container.querySelector('main')?.textContent).toContain('Understand Planner audience');
  });
  it('clears a private creation draft when switching products or bearer identity', async () => {
    harness(); await render(); await click(button('New initiative'));
    await change(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Private Notebook strategy');
    await change(container.querySelector<HTMLSelectElement>('select[aria-label="Product"]')!, 'beta');
    await click(button('New initiative')); expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    await change(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Private Planner strategy');
    await render('different-human-token'); await click(button('New initiative'));
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
  });
  it('clears selected data and another account’s saved submission on an identity-changing refresh', async () => {
    const h = harness(); await render(); await click(button('Understand Notebook audience'));
    h.intercept(body => body.action === 'apply' ? Promise.reject(new Error('Connection lost')) : undefined);
    await chooseAlternative(); await click(button('Record decision'));
    const ownerDraft = sessionStorage.getItem(`pear-operations-pending:${endpoint}:alpha:human:owner`); expect(ownerDraft).toBeTruthy();
    h.identity.id = 'human:new-owner'; h.views.alpha.context.purpose = 'New account initiative'; h.views.alpha.ownerId = h.identity.id;
    await click(button('Refresh'));
    expect(container.textContent).not.toContain('Which audience should we study?');
    expect(container.textContent).not.toContain('A submission is awaiting confirmation');
    expect(container.textContent).toContain('New account initiative');
    expect(sessionStorage.getItem(`pear-operations-pending:${endpoint}:alpha:human:owner`)).toBe(ownerDraft);
    expect(h.seen.filter(item => item.body.action === 'apply')).toHaveLength(1);
  });
  it('renders only safe source links and keeps unsafe evidence readable as text', async () => {
    const h = harness(); h.views.alpha.evidence.push(...['javascript:alert(1)', 'data:text/html,private', 'https://user:secret@example.test'].map((uri, index) => ({
      id: `unsafe-${index}`, kind: 'research', summary: `Unsafe source ${index}`, source: { owner: 'fixture', uri }, capturedAt: '2026-10-27T12:00:00.000Z',
    })));
    await render(); await click(button('Understand Notebook audience'));
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a')]; expect(links).toHaveLength(1);
    expect(links[0].href).toBe('https://evidence.example.test/brief'); expect(links[0].rel).toContain('noopener');
    expect(container.textContent).toContain('Unsafe source 0'); expect(container.textContent).toContain('Unsafe source 2');
    expect(container.innerHTML).not.toContain('user:secret'); expect(container.innerHTML).not.toContain('javascript:');
  });
});
