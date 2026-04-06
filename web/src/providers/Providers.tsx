"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "react-oidc-context";
import { SpacetimeDBProvider, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { buildConnectionBuilder } from "@/src/lib/spacetime";
import { resolveWorkspaceWsUri, validateResolvedSpacetimeUri } from "@/src/lib/workspaceConnections";
import { AuthGate } from "@/src/components/AuthGate";
import { OidcLoginGate } from "@/src/components/OidcLoginGate";
import { WorkspaceProvider, useWorkspace } from "@/src/providers/WorkspaceProvider";
import { reducers } from "@/src/module_bindings";

// ── OIDC config (optional) ────────────────────────────────────────────────────
// Set NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID + NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY
// to enable OIDC. Leave unset to use the built-in native auth (email + password).
const OIDC_CLIENT_ID = process.env.NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID;
const OIDC_AUTHORITY = process.env.NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY;

const oidcConfig = OIDC_CLIENT_ID
  ? {
      authority: OIDC_AUTHORITY!,
      client_id: OIDC_CLIENT_ID,
      redirect_uri:
        typeof window !== "undefined" ? `${window.location.origin}/callback` : "",
      post_logout_redirect_uri:
        typeof window !== "undefined" ? window.location.origin : "",
      scope: "openid profile email",
      response_type: "code",
      automaticSilentRenew: true,
    }
  : null;

// ── ProfileSync ───────────────────────────────────────────────────────────────
/** Pushes OIDC profile claims to SpacetimeDB after the connection is active. */
function ProfileSync({ name, email }: { name: string; email: string }) {
  const { isActive } = useSpacetimeDB();
  const setUserProfile = useReducer(reducers.setUserProfile);

  useEffect(() => {
    if (!isActive || (!name && !email)) return;
    setUserProfile({ name, email });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, name, email]);

  return null;
}

// ── PostAuthRedirect ──────────────────────────────────────────────────────────
/** After a successful OIDC callback, redirects to /workspace via Next.js router. */
function PostAuthRedirect() {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!auth.isLoading && auth.isAuthenticated) {
      if (typeof window !== "undefined" && window.location.pathname === "/callback") {
        router.replace("/workspace");
      }
    }
  }, [auth.isLoading, auth.isAuthenticated, router]);

  return null;
}

// ── Invalid workspace (bad URL / can’t build client) ──────────────────────────
function CantConnectWorkspace({
  title,
  detail,
  workspaceName,
}: {
  title: string;
  detail: string;
  workspaceName: string;
}) {
  const router = useRouter();

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-neutral-950 px-6">
      <p className="text-lg font-medium text-neutral-100">{title}</p>
      <p className="mt-3 max-w-md text-center text-sm text-neutral-400">{detail}</p>
      <p className="mt-2 text-xs text-neutral-500">
        Workspace: <span className="text-neutral-300">{workspaceName}</span>
      </p>
      <button
        type="button"
        onClick={() => router.push("/workspace/settings")}
        className="mt-8 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
      >
        Fix in Settings
      </button>
    </div>
  );
}

// ── SpacetimeConnector ────────────────────────────────────────────────────────
function SpacetimeConnector({ children }: { children: React.ReactNode }) {
  const { ready, activeWorkspace } = useWorkspace();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const auth = oidcConfig ? useAuth() : null;
  const oidcToken = auth?.user?.id_token;

  const resolvedWsUri = activeWorkspace ? resolveWorkspaceWsUri(activeWorkspace.wsUri) : "";
  const uriCheck = activeWorkspace ? validateResolvedSpacetimeUri(resolvedWsUri) : { ok: true as const };

  // useRef guarantees a stable reference for the lifetime of this component.
  // useMemo is explicitly NOT guaranteed to be stable in React Concurrent Mode
  // (Next.js App Router uses it), so React can discard and recompute the value
  // between renders even when deps haven't changed. A new connectionBuilder
  // object reference causes SpacetimeDBProvider to reconnect, which remounts
  // AuthGate and sends users back to "Connecting…" mid-flow.
  const connectionBuilderRef = useRef<ReturnType<typeof buildConnectionBuilder> | null>(null);
  const prevOidcTokenRef = useRef<string | undefined>(undefined);
  const prevWorkspaceKeyRef = useRef<string>("");
  const workspaceKey = activeWorkspace
    ? `${activeWorkspace.id}\0${activeWorkspace.wsUri}\0${activeWorkspace.dbName}`
    : "";
  if (
    !connectionBuilderRef.current ||
    !Object.is(prevOidcTokenRef.current, oidcToken) ||
    prevWorkspaceKeyRef.current !== workspaceKey
  ) {
    if (activeWorkspace && uriCheck.ok) {
      connectionBuilderRef.current = buildConnectionBuilder(oidcToken, activeWorkspace);
      prevWorkspaceKeyRef.current = workspaceKey;
    } else {
      connectionBuilderRef.current = null;
      prevWorkspaceKeyRef.current = workspaceKey;
    }
    prevOidcTokenRef.current = oidcToken;
  }
  const connectionBuilder = connectionBuilderRef.current;

  if (!ready || !activeWorkspace) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950">
        <p className="text-neutral-500 text-sm">Loading workspace…</p>
      </div>
    );
  }

  if (!uriCheck.ok) {
    return (
      <CantConnectWorkspace
        title="Can’t connect to this workspace"
        detail={uriCheck.message}
        workspaceName={activeWorkspace.name}
      />
    );
  }

  if (!connectionBuilder) {
    return (
      <CantConnectWorkspace
        title="Can’t connect to this workspace"
        detail="The address couldn’t be used to open a connection. Check for typos, port, and ws:// vs wss://."
        workspaceName={activeWorkspace.name}
      />
    );
  }

  // OIDC mode: gate on OIDC auth state before touching SpacetimeDB
  if (oidcConfig && auth) {
    if (auth.isLoading) {
      return (
        <div className="flex h-screen items-center justify-center bg-neutral-950">
          <p className="text-neutral-500 text-sm">Loading…</p>
        </div>
      );
    }
    if (!auth.isAuthenticated) {
      return <OidcLoginGate />;
    }
  }

  const name = auth?.user?.profile?.name ?? "";
  const email = auth?.user?.profile?.email ?? "";

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      {oidcToken && <ProfileSync name={name} email={email} />}
      <AuthGate>{children}</AuthGate>
    </SpacetimeDBProvider>
  );
}

// ── Providers (root) ──────────────────────────────────────────────────────────
export function Providers({ children }: { children: React.ReactNode }) {
  const inner = <SpacetimeConnector>{children}</SpacetimeConnector>;

  if (!oidcConfig) {
    return <WorkspaceProvider>{inner}</WorkspaceProvider>;
  }

  return (
    <WorkspaceProvider>
      <AuthProvider {...oidcConfig}>
        <PostAuthRedirect />
        {inner}
      </AuthProvider>
    </WorkspaceProvider>
  );
}
