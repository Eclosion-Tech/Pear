"use client";

// react-oidc-context processes the authorization code exchange at the AuthProvider
// level automatically when it detects ?code=&state= in the URL.
// PostAuthRedirect (in Providers.tsx) handles the redirect to /workspace once done.
// This page is only reached in OIDC mode.
export default function CallbackPage() {
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950">
      <p className="text-sm text-neutral-500">Signing in…</p>
    </div>
  );
}
