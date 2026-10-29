"use client";
import { useAuth } from 'react-oidc-context';
import { useWorkspace } from '@/src/providers/WorkspaceProvider';
import { resolveWorkspaceDbName } from '@/src/lib/workspaceConnections';
import { ProductOperationsPanel } from './ProductOperationsPanel';
import type { OperationsProductChoice } from '@/src/lib/product-operations/proxy';

function SignedInPanel({ workspaceSlug, products }: { workspaceSlug: string; products: OperationsProductChoice[] }) {
  const auth = useAuth();
  const { activeWorkspace } = useWorkspace();
  if (resolveWorkspaceDbName(activeWorkspace?.dbName) !== workspaceSlug) return <p className="p-8 text-sm text-neutral-500">Product operations is configured for a different workspace.</p>;
  if (!auth.isAuthenticated || !auth.user?.id_token) return <p className="p-8 text-sm text-neutral-500">Sign in with your workspace account to open product operations.</p>;
  return <ProductOperationsPanel endpoint="/api/product-operations" products={products} bearer={auth.user.id_token} />;
}
export function ProductOperationsOidcPanel(props: { workspaceSlug: string; products: OperationsProductChoice[] }) {
  if (!process.env.NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID || !process.env.NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY) return <p className="p-8 text-sm text-neutral-500">Product operations requires the workspace’s identity-provider sign-in.</p>;
  return <SignedInPanel {...props} />;
}
