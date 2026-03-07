"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "react-oidc-context";
import { SpacetimeDBProvider, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { buildConnectionBuilder } from "@/src/lib/spacetime";
import { AuthGate } from "@/src/components/AuthGate";
import { OidcLoginGate } from "@/src/components/OidcLoginGate";
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

// ── SpacetimeConnector ────────────────────────────────────────────────────────
function SpacetimeConnector({ children }: { children: React.ReactNode }) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const auth = oidcConfig ? useAuth() : null;
  const oidcToken = auth?.user?.id_token;

  // useRef guarantees a stable reference for the lifetime of this component.
  // useMemo is explicitly NOT guaranteed to be stable in React Concurrent Mode
  // (Next.js App Router uses it), so React can discard and recompute the value
  // between renders even when deps haven't changed. A new connectionBuilder
  // object reference causes SpacetimeDBProvider to reconnect, which remounts
  // AuthGate and sends users back to "Connecting…" mid-flow.
  const connectionBuilderRef = useRef<ReturnType<typeof buildConnectionBuilder> | null>(null);
  const prevOidcTokenRef = useRef<string | undefined>(undefined);
  if (!connectionBuilderRef.current || !Object.is(prevOidcTokenRef.current, oidcToken)) {
    connectionBuilderRef.current = buildConnectionBuilder(oidcToken);
    prevOidcTokenRef.current = oidcToken;
  }
  const connectionBuilder = connectionBuilderRef.current;

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
  if (!oidcConfig) {
    return <SpacetimeConnector>{children}</SpacetimeConnector>;
  }

  return (
    <AuthProvider {...oidcConfig}>
      <PostAuthRedirect />
      <SpacetimeConnector>{children}</SpacetimeConnector>
    </AuthProvider>
  );
}
