"use client";

// Pear Bridge — device pairing page.
//
// Runs inside the logged-in app (so it has the live SpacetimeDB connection +
// OIDC session). It does the workspace-authenticated half of pairing that the
// standalone daemon cannot do itself:
//   1. mint a per-device STDB identity via the lifecycle service
//      (`POST /api/bridge/device-credentials`, OIDC-gated), then
//   2. call `pair_bridge_device` over the user's own connection (owner = user),
//      seeding the device's allowlist with the chosen directory, then
//   3. hand the freshly-generated device token back to the daemon's localhost
//      callback (the daemon opened this page with `?callback=`).
//
// The device token is generated here and never leaves the machine except to the
// daemon's loopback listener; only its SHA-256 hash is stored server-side.
//
// Deferred (see docs/PEAR_BRIDGE.md § UX: pairing flow): 6-digit codes, QR,
// install.sh, token-delivery-over-relay. This is the minimal flow that unblocks
// real use.

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Identity } from "spacetimedb";
import { useReducer, useSpacetimeDB } from "spacetimedb/react";
import { useAuth } from "react-oidc-context";
import { reducers } from "@/src/module_bindings";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { resolveWorkspaceWsUri } from "@/src/lib/workspaceConnections";

/** ws(s):// workspace URI → the lifecycle HTTP base (http(s)://host). */
function lifecycleBase(wsUri: string | undefined): string {
  return resolveWorkspaceWsUri(wsUri ?? "")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/$/, "");
}

function randomTokenHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}

type Phase = "idle" | "working" | "done" | "error";

function PairInner() {
  const params = useSearchParams();
  const callback = params.get("callback") ?? "";

  const { isActive } = useSpacetimeDB();
  const pairDevice = useReducer(reducers.pairBridgeDevice);
  const auth = useAuth();
  const { activeWorkspace } = useWorkspace();

  const [deviceName, setDeviceName] = useState("My device");
  const [dirsText, setDirsText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [shownToken, setShownToken] = useState("");

  async function onPair() {
    setPhase("working");
    setMessage("");
    setShownToken("");
    try {
      const allowedDirectories = dirsText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowedDirectories.length === 0) {
        throw new Error("Add at least one allowed directory (e.g. /Users/you/project).");
      }
      const oidcToken = auth.user?.id_token ?? auth.user?.access_token;
      if (!oidcToken) {
        throw new Error("No OIDC session found — sign in to the workspace, then retry.");
      }

      const token = randomTokenHex();
      const tokenHash = await sha256Hex(token);

      // 1. Mint the per-device STDB identity (option B) via lifecycle.
      const base = lifecycleBase(activeWorkspace?.wsUri);
      const res = await fetch(`${base}/api/bridge/device-credentials`, {
        method: "POST",
        headers: { Authorization: `Bearer ${oidcToken}` },
      });
      if (!res.ok) {
        throw new Error(`device-credentials failed (${res.status}): ${await res.text()}`);
      }
      const creds = (await res.json()) as {
        device_identity: string;
        device_stdb_token_ciphertext: string;
      };

      // 2. Create the device row as the signed-in user (owner = user).
      await pairDevice({
        deviceName: deviceName.trim() || "My device",
        deviceTokenHash: tokenHash,
        platform: navigator.platform || "unknown",
        bridgeVersion: "web-pair",
        deviceIdentity: Identity.fromString(creds.device_identity.replace(/^0x/i, "")),
        deviceStdbTokenCiphertext: creds.device_stdb_token_ciphertext,
        allowedDirectories,
      });

      // 3. Hand the raw token to the daemon's loopback listener. no-cors: we
      //    don't need to read the response, only deliver the token locally.
      if (callback) {
        try {
          const u = new URL(callback);
          u.searchParams.set("token", token);
          await fetch(u.toString(), { method: "GET", mode: "no-cors" });
        } catch {
          // Loopback delivery failed — fall back to showing the token.
          setShownToken(token);
        }
      } else {
        setShownToken(token);
      }

      setPhase("done");
      setMessage(
        callback
          ? "Paired. Return to your terminal — the bridge should connect momentarily."
          : "Paired. Copy the device token below into your bridge."
      );
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
        Connect a local terminal
      </h1>
      <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        Pair the <code>pear-bridge</code> daemon on this machine so your AI users can run
        allowlisted shell commands here.
      </p>

      {!isActive && (
        <p className="mt-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Connecting to your workspace… open this page from inside your signed-in Pear session.
        </p>
      )}

      <label className="mt-8 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Device name
        <input
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          disabled={phase === "working"}
          className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
      </label>

      <label className="mt-4 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Allowed directories (one per line)
        <textarea
          value={dirsText}
          onChange={(e) => setDirsText(e.target.value)}
          disabled={phase === "working"}
          rows={3}
          placeholder={"/Users/you/Projects/myapp"}
          className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <span className="mt-1 block text-xs text-neutral-500">
          Commands may only run inside these. Required — the bridge fails closed without a jail.
        </span>
      </label>

      <button
        type="button"
        onClick={onPair}
        disabled={!isActive || phase === "working" || phase === "done"}
        className="mt-6 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {phase === "working" ? "Pairing…" : phase === "done" ? "Paired ✓" : "Pair this device"}
      </button>

      {message && (
        <p
          className={`mt-4 text-sm ${
            phase === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-emerald-600 dark:text-emerald-400"
          }`}
        >
          {message}
        </p>
      )}

      {shownToken && (
        <div className="mt-4">
          <p className="text-xs text-neutral-500">Device token (paste into the bridge):</p>
          <code className="mt-1 block break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
            {shownToken}
          </code>
        </div>
      )}
    </div>
  );
}

export default function BridgePairPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <PairInner />
    </Suspense>
  );
}
