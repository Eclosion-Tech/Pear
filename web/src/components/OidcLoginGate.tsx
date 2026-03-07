"use client";

import { useAuth } from "react-oidc-context";

/** Full-screen OIDC sign-in screen. Rendered outside SpacetimeDBProvider. */
export function OidcLoginGate() {
  const auth = useAuth();

  if (auth.error) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950">
        <div className="w-full max-w-sm px-6 text-center space-y-3">
          <p className="text-sm text-red-400">Authentication error</p>
          <p className="text-xs text-neutral-600">{auth.error.message}</p>
          <button
            onClick={() => auth.signinRedirect()}
            className="px-4 py-2 bg-white hover:bg-neutral-100 text-neutral-900 text-sm font-medium rounded-lg transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950">
      <div className="w-full max-w-sm px-6">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">Pear</h1>
          <p className="mt-1 text-sm text-neutral-500">Sign in to your workspace</p>
        </div>
        <button
          onClick={() => auth.signinRedirect()}
          className="w-full px-4 py-2.5 bg-white hover:bg-neutral-100 text-neutral-900 text-sm font-medium rounded-lg transition-colors"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
