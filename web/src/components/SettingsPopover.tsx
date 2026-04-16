"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useReducer } from "spacetimedb/react";
import { useAuth } from "react-oidc-context";
import { reducers } from "@/src/module_bindings";
import { clearSavedToken, clearIdbCache } from "@/src/lib/spacetime";
import {
  useWorkspace,
} from "@/src/providers/WorkspaceProvider";
import { purgePearBrowserState } from "@/src/lib/workspaceConnections";
import { createLogger } from "@/src/lib/log";

const log = createLogger("settings");

const OIDC_CONFIGURED = !!process.env.NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID;

/**
 * When Pear is embedded inside a host app that owns authentication
 * (own session cookie, own IdP integration), the host can set this env
 * var to a URL that Pear should navigate to on sign-out. The host's
 * endpoint is responsible for clearing its session and redirecting to
 * the IdP / marketing site / wherever.
 *
 * Pear still purges its own browser state (localStorage + IndexedDB)
 * before handing off, so the next user on this browser profile doesn't
 * inherit the previous session's workspace list or editor snapshots.
 *
 * When unset, Pear falls back to its built-in flows (OIDC via
 * `react-oidc-context` if `NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID` is
 * configured, otherwise the native SpacetimeDB `logout` reducer).
 *
 * Example — host sets: NEXT_PUBLIC_PEAR_HOST_LOGOUT_URL="/auth/logout"
 */
const HOST_LOGOUT_URL =
  process.env.NEXT_PUBLIC_PEAR_HOST_LOGOUT_URL?.trim() || "";

/** Module-level latch so the selected sign-out mode is logged once per page load. */
let signOutModeLogged = false;

/**
 * Gear icon button that opens a small settings popover anchored to itself.
 * Lives in the Sidebar user widget.
 */
export function SettingsPopover() {
  const router = useRouter();
  const { idbNamespace } = useWorkspace();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Log the selected sign-out path once per page load so embedders can
  // verify their host-logout env var was baked in without sniffing the
  // network tab. Silent by default; enable with `localStorage.setItem(
  // "pear:log", "debug")` in devtools, then refresh.
  useEffect(() => {
    if (signOutModeLogged) return;
    signOutModeLogged = true;
    log.debug("sign-out path resolved:", {
      hostLogoutUrl: HOST_LOGOUT_URL || null,
      oidcConfigured: OIDC_CONFIGURED,
      mode: HOST_LOGOUT_URL ? "host" : OIDC_CONFIGURED ? "oidc" : "native",
    });
  }, []);

  function toggle() {
    setOpen((v) => !v);
  }

  async function handleClearCache() {
    setClearing(true);
    await clearIdbCache(idbNamespace);
    // Reload so the in-memory Y.Docs and active IndexeddbPersistence
    // connections are replaced with a clean slate.
    window.location.reload();
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={toggle}
        title="Settings"
        aria-label="Settings"
        className="shrink-0 p-1 rounded text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Popover */}
          <div className="absolute bottom-full left-0 mb-1 z-50 w-56 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg py-1 overflow-hidden">
            <div className="px-3 py-1.5">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">Settings</p>
            </div>

            <div className="border-t border-neutral-100 dark:border-neutral-800 my-1" />

            <button
              onClick={() => { setOpen(false); router.push("/workspace/settings"); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-neutral-400">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
              Open settings
            </button>

            <div className="border-t border-neutral-100 dark:border-neutral-800 my-1" />

            {/* Clear cached data */}
            <button
              onClick={handleClearCache}
              disabled={clearing}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-400">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
              </svg>
              {clearing ? "Clearing…" : "Clear cached data"}
            </button>

            <div className="border-t border-neutral-100 dark:border-neutral-800 my-1" />

            {/* Sign out */}
            {HOST_LOGOUT_URL ? (
              <HostSignOut url={HOST_LOGOUT_URL} />
            ) : OIDC_CONFIGURED ? (
              <OidcSignOut />
            ) : (
              <NativeSignOutWithWorkspace />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Host-delegated sign-out: purge all Pear-owned browser state
 * (localStorage + Yjs IndexedDB snapshots) so the next sign-in on this
 * browser profile doesn't inherit the previous account's workspace list
 * or editor state, then do a FULL-page navigation to the host app's
 * logout URL.
 *
 * Full nav (not `router.push`) matters because the host's logout
 * endpoint typically responds with a 302 to an IdP's end-session URL;
 * a Next.js RSC fetch would chase that redirect and CORS-fail on the
 * cross-origin hop. `window.location.href =` forces a document
 * navigation instead, which the browser follows natively.
 */
function HostSignOut({ url }: { url: string }) {
  async function handleClick() {
    // Fire-and-forget: the critical synchronous work (localStorage
    // wipe) is done before the async IndexedDB deletion resolves.
    void purgePearBrowserState().finally(() => {
      window.location.href = url;
    });
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left text-red-600 dark:text-red-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Sign out
    </button>
  );
}

function OidcSignOut() {
  const auth = useAuth();
  return (
    <button
      onClick={() => auth.signoutRedirect()}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left text-red-600 dark:text-red-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Sign out
    </button>
  );
}

function NativeSignOutWithWorkspace() {
  const logout = useReducer(reducers.logout);
  const { activeId } = useWorkspace();

  function handleLogout() {
    logout();
    if (activeId) clearSavedToken(activeId);
    window.location.reload();
  }

  return (
    <button
      onClick={handleLogout}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left text-red-600 dark:text-red-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Sign out
    </button>
  );
}
