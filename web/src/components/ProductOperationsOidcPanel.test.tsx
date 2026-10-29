import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const fixture = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), panel: vi.fn() }));
vi.mock('react-oidc-context', () => ({ useAuth: fixture.auth }));
vi.mock('@/src/providers/WorkspaceProvider', () => ({ useWorkspace: fixture.workspace }));
vi.mock('@/src/lib/workspaceConnections', () => ({ resolveWorkspaceDbName: (name: string) => name }));
vi.mock('./ProductOperationsPanel', () => ({ ProductOperationsPanel: (props: unknown) => { fixture.panel(props); return null; } }));
import { ProductOperationsOidcPanel } from './ProductOperationsOidcPanel';

function render() { return renderToStaticMarkup(createElement(ProductOperationsOidcPanel, { workspaceSlug: 'example-workspace', products: [] })); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID', 'example-client');
  vi.stubEnv('NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY', 'https://identity.example.test');
  fixture.workspace.mockReturnValue({ activeWorkspace: { dbName: 'example-workspace' } });
  fixture.auth.mockReturnValue({ isAuthenticated: true, user: { id_token: 'example-id-token', access_token: 'different-access-token' } });
});
afterEach(() => vi.unstubAllEnvs());
describe('operator-configured OIDC operations panel', () => {
  it('does not consume an absent auth context when either provider setting is missing', () => {
    fixture.auth.mockImplementation(() => { throw new Error('No OIDC provider'); });
    vi.stubEnv('NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY', '');
    expect(render()).toContain('identity-provider sign-in');
    vi.stubEnv('NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY', 'https://identity.example.test'); vi.stubEnv('NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID', '');
    expect(render()).toContain('identity-provider sign-in');
    expect(fixture.auth).not.toHaveBeenCalled(); expect(fixture.panel).not.toHaveBeenCalled();
  });
  it('requires a matching active workspace and authenticated ID proof', () => {
    fixture.workspace.mockReturnValueOnce({ activeWorkspace: { dbName: 'other-workspace' } });
    expect(render()).toContain('different workspace');
    fixture.auth.mockReturnValueOnce({ isAuthenticated: true, user: { access_token: 'access-only' } });
    expect(render()).toContain('Sign in'); expect(fixture.panel).not.toHaveBeenCalled();
  });
  it('accepts the operator provider and passes only the ID token to the same-origin panel', () => {
    render();
    expect(fixture.panel).toHaveBeenCalledExactlyOnceWith({ endpoint: '/api/product-operations', products: [], bearer: 'example-id-token' });
  });
});
