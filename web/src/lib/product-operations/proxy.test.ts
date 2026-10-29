import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../../app/api/product-operations/route';
import { operationsProducts } from './proxy';

function request(value: Record<string, unknown> = { productId: 'demo-product', action: 'list', limit: 20 }, headers: Record<string, string> = {}) {
  return new Request('https://workspace.example.test/api/product-operations', { method: 'POST',
    headers: { Origin: 'https://workspace.example.test', 'Content-Type': 'application/json', Authorization: 'Bearer example-id-token', ...headers }, body: JSON.stringify(value) });
}
beforeEach(() => {
  vi.stubEnv('PRODUCT_OPERATIONS_SERVICE_URL', 'https://operations.example.test');
  vi.stubEnv('PRODUCT_OPERATIONS_WORKSPACE_SLUG', 'example-workspace');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('optional self-hosted operations proxy', () => {
  it('stays disconnected without both server settings and never invents a workspace or service', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const [endpoint, slug] of [['', 'example-workspace'], ['https://operations.example.test', ''], ['https://operations.example.test', '../other']]) {
      vi.stubEnv('PRODUCT_OPERATIONS_SERVICE_URL', endpoint); vi.stubEnv('PRODUCT_OPERATIONS_WORKSPACE_SLUG', slug);
      expect((await POST(request())).status).toBe(503);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires same-origin intent and a bearer; refuses actor or workspace overrides before forwarding', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await POST(request(undefined, { Origin: 'https://other.example.test' }))).status).toBe(403);
    expect((await POST(request(undefined, { Authorization: '' }))).status).toBe(401);
    for (const override of [{ actor: { id: 'another-person' } }, { scope: {} }, { workspaceId: 'other' }, { workspaceSlug: 'other' }, { schemaVersion: 2 }]) {
      expect((await POST(request({ productId: 'demo-product', action: 'list', limit: 20, ...override }))).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the operator endpoint/workspace and explicit bearer without forwarding browser cookies', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, result: { items: [] } })); vi.stubGlobal('fetch', fetcher);
    const response = await POST(request(undefined, { Cookie: 'unrelated=private' }));
    expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://operations.example.test/v1/product-operations');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer example-id-token' });
    expect(JSON.parse(init.body)).toEqual({ schemaVersion: 1, workspaceSlug: 'example-workspace', productId: 'demo-product', action: 'list', limit: 20 });
    expect(init.redirect).toBe('error'); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('retains an unconfirmed mutation without retry or alternate destination', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('internal credential detail')); vi.stubGlobal('fetch', fetcher);
    const response = await POST(request({ productId: 'demo-product', action: 'apply', initiativeId: 'initiative', command: { id: 'stable-id', expectedRevision: 2, payload: { type: 'resolve_decision', decisionId: 'direction', optionId: 'continue', rationale: 'Supported by evidence' } } }));
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ ok: false, error: 'receipt_unconfirmed' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.parse(fetcher.mock.calls[0][1].body).command.id).toBe('stable-id');
  });
  it('isolates operator display choices by workspace and supports a product with no adapters', () => {
    const rows = JSON.stringify([{ workspaceSlug: 'example-workspace', productId: 'demo-product', label: 'Demo product', sources: [] },
      { workspaceSlug: 'other-workspace', productId: 'other-product', label: 'Other product', sources: [] }]);
    expect(operationsProducts(undefined, 'example-workspace')).toEqual([]);
    expect(operationsProducts(rows, 'example-workspace')).toEqual([{ productId: 'demo-product', label: 'Demo product', sources: [] }]);
    expect(operationsProducts(rows, 'unconfigured-workspace')).toEqual([]);
  });
});
