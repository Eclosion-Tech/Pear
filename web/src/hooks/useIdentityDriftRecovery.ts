"use client";

import { useCallback } from "react";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import {
  isIdentityOwnershipError,
  triggerIdentityDriftRecovery,
} from "@/src/lib/identityRecovery";

/**
 * Returns a callback that components should invoke from a reducer's `catch`
 * block whenever an identity-mismatch error would otherwise be silently
 * shown as "couldn't perform action". On match, the user is signed out and
 * sent back to the login screen with an explanation banner.
 *
 * Returns `true` if recovery was triggered, `false` if the error wasn't an
 * identity-drift signal and the caller should surface it normally.
 *
 * Usage:
 *
 *   const checkDrift = useIdentityDriftRecovery();
 *   try {
 *     await someReducer(...);
 *   } catch (err) {
 *     if (checkDrift(err, "create API key")) return;
 *     setLocalError(String(err));
 *   }
 *
 * The `actionLabel` is woven into the user-facing banner ("…while trying to
 * <actionLabel>"), so phrase it as the object of "while trying to …".
 *
 * In both auth modes recovery is the same shape: drop the persisted
 * SpacetimeDB token for the active workspace and reload. In native mode
 * that lands on `LoginGate`; in OIDC mode `AuthGate`/`OidcLoginGate` will
 * re-evaluate the OIDC session and either silently re-derive the same
 * identity (which surfaces the issue cleanly the next time the user tries)
 * or send them through `signinRedirect`. We deliberately don't call
 * `signoutRedirect()` from here because tearing down the IdP session is
 * destructive for the wipe-orphan case where the user's OIDC identity is
 * actually correct — the bug is server-side stale data, not the user.
 */
export function useIdentityDriftRecovery() {
  const { activeId } = useWorkspace();

  return useCallback(
    (err: unknown, actionLabel: string): boolean => {
      if (!isIdentityOwnershipError(err)) return false;

      const reason = `Pear noticed your local session was out of sync with the workspace while trying to ${actionLabel}. You've been signed out so the connection can be re-established.`;

      triggerIdentityDriftRecovery({
        workspaceId: activeId ?? undefined,
        reason,
      });
      return true;
    },
    [activeId]
  );
}
