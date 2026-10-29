import { describe, it, expect } from 'vitest';
import { productOperationsTools } from './product-operations';
import { validProductOperationsInput } from './product-operations-contract';
import { createProductOperationsRelay } from './product-operations-relay';
import { DEFAULT_SCOPE, toolFilterForScopes } from '../mcp-oauth/scopes';
import { createPearMcpServer } from './server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpContext } from './types';

const now = Date.parse('2026-10-27T12:00:00.000Z');
const caller = { grantId: '11111111-1111-4111-a111-111111111111', principalId: 'a'.repeat(64), aiUserId: '7', clientId: 'example-client',
  tokenScopes: ['product-operations:read', 'product-operations:write', 'product-operations:execute'], accessExpiresAtMs: now + 60_000 };
const config = { serviceUrl: 'https://operations.example.test', relaySecret: 'b'.repeat(64), workspaceSlug: 'workspace', caller, clock: () => now };
const dispatch = { productId: 'demo-product', initiativeId: 'audience', commandId: 'dispatch-1', expectedRevision: 7, assignmentId: 'research', executionId: 'execution-1' };
const contribute = { productId: 'demo-product', initiativeId: 'audience', commandId: 'propose-1', expectedRevision: 6,
  payload: { type: 'propose_assignment', assignment: { id: 'research', objective: 'Read audience evidence', capability: 'pear.source.read', resource: 'pear:brief', acceptanceCriteria: ['Complete source'], reservedUnits: 1, dependencies: [], decisionRequirements: [] } } };

describe('product operations MCP capability boundary', () => {
  it('keeps memory defaults and requires the complete scope combination', () => {
    expect(DEFAULT_SCOPE).toEqual(['memory']);
    for (const scope of ['memory', 'pages:write', 'execution:read', 'execution:answer']) for (const tool of productOperationsTools()) expect(toolFilterForScopes([scope])(tool.name)).toBe(false);
    expect(toolFilterForScopes(['product-operations:read'])('product_operations_read')).toBe(true);
    expect(toolFilterForScopes(['product-operations:write'])('product_operations_contribute')).toBe(false);
    expect(toolFilterForScopes(['product-operations:execute'])('product_operations_dispatch')).toBe(false);
    expect(toolFilterForScopes(['product-operations:read', 'product-operations:execute'])('product_operations_dispatch')).toBe(false);
    expect(toolFilterForScopes(caller.tokenScopes)('product_operations_dispatch')).toBe(true);
  });
  it('hides the unavailable capability from the actual MCP server registry', async () => {
    const handler = createMcpHandler(() => createPearMcpServer({ aiUserId: 7n } as McpContext));
    const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }));
    const text = await response.text();
    expect(response.ok).toBe(true);
    expect(text).toContain('get_page');
    expect(text).not.toContain('product_operations_read');
  });
  it('rejects actor/workspace/adapter substitution and human/runtime-only operations before forwarding', async () => {
    let calls = 0;
    const ctx = { productOperations: { invoke: async () => { calls++; return { ok: true }; } } } as unknown as McpContext;
    const write = productOperationsTools().find(tool => tool.name === 'product_operations_contribute')!;
    const run = productOperationsTools().find(tool => tool.name === 'product_operations_dispatch')!;
    for (const payload of ['create', 'resolve_decision', 'stop', 'report_execution', 'reconcile_execution', 'dispatch', 'renew_delegation']) {
      expect(JSON.parse(await write.execute(ctx, { ...contribute, payload: { type: payload } })).ok).toBe(false);
    }
    for (const extra of [{ actor: { kind: 'human', id: 'owner' } }, { workspaceSlug: 'foreign' }, { workerId: 'owner' }, { adapterId: 'shell' }]) {
      expect(JSON.parse(await run.execute(ctx, { ...dispatch, ...extra })).ok).toBe(false);
    }
    expect(JSON.parse(await write.execute(ctx, { ...contribute, payload: { ...contribute.payload, assignment: { ...contribute.payload.assignment, status: 'succeeded' } } })).ok).toBe(false);
    expect(calls).toBe(0);
    expect(JSON.parse(await write.execute(ctx, contribute)).ok).toBe(true);
    expect(calls).toBe(1);
  });
  it('bounds object depth, bytes, array size, revision and read identifiers', () => {
    expect(validProductOperationsInput('read', { productId: 'demo-product', action: 'whoami' })).toBe(true);
    expect(validProductOperationsInput('read', { productId: 'demo-product', action: 'list', limit: 50, afterId: 'last-seen' })).toBe(true);
    for (const limit of [0, 51, 1.5]) expect(validProductOperationsInput('read', { productId: 'demo-product', action: 'list', limit })).toBe(false);
    for (const input of [{ productId: 'demo-product', action: 'get' }, { productId: 'demo-product', action: 'execution_status', initiativeId: 'one' }, { ...dispatch, expectedRevision: 1.5 }]) expect(validProductOperationsInput('read', input)).toBe(false);
    expect(validProductOperationsInput('dispatch', { ...dispatch, expectedRevision: -1 })).toBe(false);
    expect(validProductOperationsInput('contribute', { ...contribute, payload: { type: 'record_evidence', evidence: { summary: 'é'.repeat(40_000) } } })).toBe(false);
    expect(validProductOperationsInput('contribute', { ...contribute, payload: { type: 'begin_observation', evidenceIds: Array(257).fill('e') } })).toBe(false);
    const deep: Record<string, unknown> = {}; deep.cycle = deep;
    expect(validProductOperationsInput('contribute', { ...contribute, payload: { type: 'record_evidence', evidence: deep } })).toBe(false);
  });
});

describe('bounded product operations relay', () => {
  it('is disabled without both settings and rejects token-bearing or insecure destinations', () => {
    expect(createProductOperationsRelay({ ...config, serviceUrl: undefined })).toBeUndefined();
    expect(createProductOperationsRelay({ ...config, relaySecret: undefined })).toBeUndefined();
    for (const serviceUrl of ['http://example.test', 'https://user:secret@example.test', 'https://example.test?token=secret', 'https://example.test/other']) expect(() => createProductOperationsRelay({ ...config, serviceUrl })).toThrow();
  });
  it('forwards exact scoped commands with immutable host identity, no credential passthrough and no dispatch retry', async () => {
    const boundCaller = structuredClone(caller);
    const bodies: string[] = [];
    const api = createProductOperationsRelay({ ...config, caller: boundCaller, fetch: async (url, init) => {
      expect(String(url)).toBe('https://operations.example.test/v1/product-operations/relay');
      expect(init?.redirect).toBe('error'); expect(init?.signal).toBeDefined();
      const headers = new Headers(init?.headers); expect(headers.has('authorization')).toBe(false);
      expect(headers.get('X-Pear-Product-Operations-Signature')).toMatch(/^[a-f0-9]{64}$/);
      bodies.push(String(init?.body)); return Response.json({ ok: true, result: { status: 'ready' } });
    } })!;
    boundCaller.principalId = 'c'.repeat(64);
    await api.invoke('dispatch', dispatch);
    const sent = JSON.parse(bodies[0]);
    expect(sent.caller).toEqual(caller);
    expect(sent.request).toEqual({ schemaVersion: 1, workspaceSlug: 'workspace', productId: 'demo-product', action: 'apply', initiativeId: 'audience',
      command: { id: 'dispatch-1', expectedRevision: 7, payload: { type: 'dispatch', assignmentId: 'research', executionId: 'execution-1', workerId: `agent:${caller.grantId}:${caller.principalId}` } } });
    // Only a new explicit caller invocation can send an exact replay; no generated replacement identity.
    expect(bodies).toHaveLength(1); await api.invoke('dispatch', dispatch); expect(bodies[1]).toBe(bodies[0]);
  });
  it('checks expiration and scope before any request', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({ ok: true, result: {} }); };
    const expired = createProductOperationsRelay({ ...config, caller: { ...caller, accessExpiresAtMs: now }, fetch: fetcher })!;
    expect(await expired.invoke('dispatch', dispatch)).toEqual({ ok: false, error: 'unauthorized' });
    const read = createProductOperationsRelay({ ...config, caller: { ...caller, tokenScopes: ['product-operations:read'] }, fetch: fetcher })!;
    expect(await read.invoke('dispatch', dispatch)).toEqual({ ok: false, error: 'forbidden' });
    expect(calls).toBe(0);
  });
  it.each(['disconnect', 'server', 'invalid_json', 'oversized'])('retains operation identity on %s uncertainty and never echoes diagnostics', async mode => {
    let calls = 0;
    const api = createProductOperationsRelay({ ...config, fetch: async () => {
      calls++;
      if (mode === 'disconnect') throw new Error('SECRET backend diagnostic');
      if (mode === 'server') return Response.json({ ok: false, error: 'operation_unavailable', message: 'SECRET' }, { status: 503 });
      return new Response(mode === 'oversized' ? 'x'.repeat(8_388_609) : 'SECRET invalid JSON');
    } })!;
    const result = await api.invoke('dispatch', dispatch);
    expect(result).toMatchObject({ ok: false, error: 'product_operations_outcome_unknown_no_retry', commandId: 'dispatch-1', operationId: 'dispatch-1' });
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(calls).toBe(1);
  });
  it('reports a definitive conflict safely and reads never dispatch', async () => {
    let payload: unknown;
    const api = createProductOperationsRelay({ ...config, fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body)).request;
      return Response.json({ ok: false, error: 'conflict', message: 'PRIVATE upstream diagnostic' }, { status: 409 });
    } })!;
    expect(await api.invoke('read', { productId: 'demo-product', action: 'execution_status', initiativeId: 'audience', operationId: 'dispatch-1' })).toEqual({ ok: false, error: 'conflict', status: 409 });
    expect(payload).toEqual({ schemaVersion: 1, workspaceSlug: 'workspace', productId: 'demo-product', action: 'execution_status', initiativeId: 'audience', operationId: 'dispatch-1' });
    await api.invoke('read', { productId: 'demo-product', action: 'list', limit: 25, afterId: 'previous' });
    expect(payload).toEqual({ schemaVersion: 1, workspaceSlug: 'workspace', productId: 'demo-product', action: 'list', limit: 25, afterId: 'previous' });
  });
  it.each([401, 403])('preserves dispatch uncertainty when post-commit authorization returns %i', async status => {
    const api = createProductOperationsRelay({ ...config, fetch: async () => Response.json({ ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' }, { status }) })!;
    expect(await api.invoke('dispatch', dispatch)).toMatchObject({ ok: false, error: 'product_operations_outcome_unknown_no_retry', operationId: 'dispatch-1', status });
  });
});
