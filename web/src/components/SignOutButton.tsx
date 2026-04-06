"use client";

import { useReducer } from "spacetimedb/react";
import { useAuth } from "react-oidc-context";
import { reducers } from "@/src/module_bindings";
import { clearSavedToken } from "@/src/lib/spacetime";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";

const OIDC_CONFIGURED = !!process.env.NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID;

/** Used in OIDC mode — must be rendered inside AuthProvider. */
function OidcSignOutButton() {
  const auth = useAuth();
  return (
    <button
      onClick={() => auth.signoutRedirect()}
      title="Sign out"
      className="text-neutral-600 hover:text-neutral-300 transition-colors text-xs"
    >
      ↪
    </button>
  );
}

/** Used in native mode — must be rendered inside SpacetimeDBProvider. */
function NativeSignOutButton() {
  const logout = useReducer(reducers.logout);
  const { activeId } = useWorkspace();

  const handleLogout = () => {
    logout(); // best-effort: mark server-side as logged out
    if (activeId) clearSavedToken(activeId); // remove identity token for this workspace
    window.location.reload(); // reload to clean login screen
  };

  return (
    <button
      onClick={handleLogout}
      title="Sign out"
      className="text-neutral-600 hover:text-neutral-300 transition-colors text-xs"
    >
      ↪
    </button>
  );
}

export function SignOutButton() {
  return OIDC_CONFIGURED ? <OidcSignOutButton /> : <NativeSignOutButton />;
}
