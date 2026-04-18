"use client";

/**
 * Identity-drift recovery.
 *
 * Background: every reducer that mutates a row owned by a specific identity
 * (`api_endpoint`, `api_endpoint_key`, `api_field_mapping`, etc.) gates the
 * mutation on `ctx.sender() == row.created_by`. When the SDK's connected
 * identity diverges from what the user expects to be — e.g. a stale tab that
 * connected before a database wipe got an ephemeral identity, or the
 * persisted SpacetimeDB token in localStorage outlived the OIDC session that
 * minted it — those reducers correctly reject with messages like
 * `"Only the endpoint creator can manage API keys"`.
 *
 * The user is shown UI for resources they can't actually touch, every
 * mutation 401s, and the only escape is "open DevTools and figure out what
 * happened". That's a footgun, especially after rare events like a server
 * wipe or OIDC re-issuance.
 *
 * Defense: when the UI catches one of these "you don't own this" errors on
 * an action the user *should* have been able to perform (the UI wouldn't
 * have rendered the button otherwise), we treat that as a signal that the
 * local SDK identity is out of sync. We:
 *
 *   1. Stash a human-readable reason in sessionStorage so the login screen
 *      can explain why we kicked them.
 *   2. Drop the persisted SpacetimeDB token for this workspace so the next
 *      connection starts from the OIDC token (or native login) rather than
 *      the stale identity token.
 *   3. Sign out of OIDC if configured (forces a full re-auth round-trip),
 *      otherwise reload — `AuthGate` will surface `LoginGate` and the user
 *      logs back in fresh.
 *
 * See `docs/SECURITY.md` §10 for the threat model and rationale.
 */

import { clearSavedToken } from "@/src/lib/spacetime";

const REASON_KEY = "pear_identity_drift_reason";
const TRIGGERED_KEY = "pear_identity_drift_in_progress";

/**
 * Reducer rejection messages emitted by Pear's `created_by` ownership
 * checks. New reducers that gate on `ctx.sender() == row.created_by` should
 * either reuse one of these phrasings or extend this list.
 *
 * Matched as case-insensitive substrings so prefix/suffix punctuation
 * differences across reducers don't break detection.
 */
const IDENTITY_OWNERSHIP_PATTERNS = [
  /only the .* (creator|owner) can /i,
  /not the (creator|owner) of /i,
  /you are not authorized to (modify|manage|delete) /i,
];

/** True iff the error looks like a `created_by`-style ownership rejection. */
export function isIdentityOwnershipError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (!msg) return false;
  return IDENTITY_OWNERSHIP_PATTERNS.some((p) => p.test(msg));
}

/**
 * Pop the most recent identity-drift reason for display on the login screen.
 * Returns `null` if no recovery happened in this session.
 */
export function consumeIdentityDriftReason(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const reason = sessionStorage.getItem(REASON_KEY);
    if (reason) sessionStorage.removeItem(REASON_KEY);
    return reason;
  } catch {
    return null;
  }
}

interface RecoveryOptions {
  /** Workspace whose persisted STDB token should be cleared. */
  workspaceId?: string;
  /** Short, user-facing explanation. Shown verbatim on the login screen. */
  reason: string;
  /**
   * If provided, called instead of `window.location.reload()` to terminate
   * the OIDC session. Pass `auth.signoutRedirect` from `react-oidc-context`
   * so the user is forced through the IdP for a fresh `id_token`.
   */
  oidcSignoutRedirect?: () => Promise<unknown> | void;
}

/**
 * Hard-resets local auth state and bounces the user to the login surface.
 *
 * Idempotent within a tab: if recovery is already in flight (e.g. multiple
 * concurrent reducer rejections), subsequent calls are no-ops so we don't
 * stack `signoutRedirect()` calls or trigger reload races.
 */
export function triggerIdentityDriftRecovery(opts: RecoveryOptions): void {
  if (typeof window === "undefined") return;

  try {
    if (sessionStorage.getItem(TRIGGERED_KEY) === "1") return;
    sessionStorage.setItem(TRIGGERED_KEY, "1");
    sessionStorage.setItem(REASON_KEY, opts.reason);
  } catch {
    // sessionStorage can throw in private-mode Safari etc; recovery should
    // still proceed without the explainer banner.
  }

  if (opts.workspaceId) {
    try {
      clearSavedToken(opts.workspaceId);
    } catch {
      /* swallow — best-effort cleanup */
    }
  }

  if (opts.oidcSignoutRedirect) {
    // OIDC mode: force a full IdP round-trip. The redirect itself navigates
    // away from the app, so no explicit reload is needed. If signout fails
    // for any reason we still fall back to a reload below.
    try {
      const result = opts.oidcSignoutRedirect();
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => window.location.reload());
      }
      return;
    } catch {
      /* fall through to reload */
    }
  }

  window.location.reload();
}
