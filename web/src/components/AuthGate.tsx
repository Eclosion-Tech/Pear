"use client";

import { useRef } from "react";
import { useCurrentUser } from "@/src/hooks/useUser";
import { LoginGate } from "./LoginGate";

/**
 * Rendered inside SpacetimeDBProvider. Blocks the app until the user has
 * completed login/register (user.is_authenticated === true).
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isReady } = useCurrentUser();
  // Once the subscription has been ready at least once, don't re-show the
  // "Connecting…" spinner on brief isReady=false blips (e.g. during reducer updates).
  const wasReadyRef = useRef(false);
  if (isReady) wasReadyRef.current = true;

  if (!wasReadyRef.current) {
    return (
      <div className="flex h-screen items-center justify-center bg-white dark:bg-neutral-950">
        <p className="text-neutral-400 dark:text-neutral-500 text-sm">Connecting…</p>
      </div>
    );
  }

  if (!user?.isAuthenticated) {
    return <LoginGate />;
  }

  return <>{children}</>;
}
