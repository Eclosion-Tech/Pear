"use client";

/**
 * Tiny leveled logger for the Pear editor. Replaces ad-hoc `console.log`
 * calls so:
 *   1. We can keep diagnostic lines checked in without spamming the
 *      console in production.
 *   2. Anyone embedding Pear (or Pear running standalone) can flip on
 *      verbose output without rebuilding — either at build time with
 *      an env var, or live in the browser for the current tab only.
 *
 * Levels (high = chatty):
 *   silent < error < warn < info < debug
 *
 * How to enable debug output:
 *   - Build-time:  set `NEXT_PUBLIC_PEAR_LOG_LEVEL=debug` in the host
 *                  app's env config. NEXT_PUBLIC_* is baked at build
 *                  time, so this requires a redeploy.
 *   - Runtime:     in devtools console, run
 *                    sessionStorage.setItem("pear:log", "debug")
 *                  then refresh. Session storage (NOT localStorage) is
 *                  deliberate: the override auto-expires when the tab
 *                  closes, so "turned on debug months ago and forgot"
 *                  doesn't become a data-leak surface if the user later
 *                  shares their screen. Runtime override wins over the
 *                  env var so devs can toggle without a redeploy.
 *
 * Whenever the effective level is more verbose than `warn`, the logger
 * prints a one-time banner announcing that so the user is aware.
 *
 * Default level is "warn" — errors + warnings surface, routine info/
 * debug is silent.
 *
 * ──────────────────────────────────────────────────────────────────
 * RULE: never log secrets or PII, even at `debug`.
 * ──────────────────────────────────────────────────────────────────
 *
 *   BAD:   log.debug("request token:", bearer);
 *          log.debug("user:", userObject);  // may contain email
 *          log.debug("page content:", editor.document);
 *          log.debug("presigned url:", signedUrl);
 *
 *   OK:    log.debug("auth header set", { hasToken: !!bearer });
 *          log.debug("user loaded", { id: user.id });
 *          log.debug("page saved", { blockCount: editor.document.length });
 *          log.debug("presigned ok", { kind: "upload", ttlSeconds: 900 });
 *
 * Stick to metadata (counts, enum tags, booleans, non-sensitive IDs)
 * so that even if a user accidentally leaves debug on and shares their
 * screen, the console can't exfiltrate anything an attacker couldn't
 * already see in the UI.
 *
 * Usage:
 *   import { createLogger } from "@/src/lib/log";
 *   const log = createLogger("settings"); // scope is optional
 *   log.debug("picked sign-out path:", { mode });
 *   log.warn("SpacetimeDB reconnecting", { attempt });
 */

type Level = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<Level, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** sessionStorage key for the runtime override. */
const STORAGE_KEY = "pear:log";

/** NEXT_PUBLIC_ env var consulted at build time. */
const BUILD_LEVEL = (() => {
  const raw = process.env.NEXT_PUBLIC_PEAR_LOG_LEVEL?.trim().toLowerCase();
  return raw && raw in LEVEL_ORDER ? (raw as Level) : null;
})();

function readRuntimeLevel(): Level | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)?.trim().toLowerCase();
    if (raw && raw in LEVEL_ORDER) return raw as Level;
  } catch {
    // sessionStorage blocked — fall through.
  }
  return null;
}

/**
 * Resolve the active log level. Runtime override wins so devs can
 * toggle in a live tab without a rebuild.
 */
function currentLevel(): Level {
  return readRuntimeLevel() ?? BUILD_LEVEL ?? "warn";
}

function gate(level: Level): boolean {
  return LEVEL_ORDER[currentLevel()] >= LEVEL_ORDER[level];
}

/**
 * One-time banner shown when the effective level is more verbose than
 * `warn`. Makes forgotten debug mode impossible to miss if devtools is
 * open (e.g. during a screen-share).
 */
let bannerShown = false;
function maybeShowBanner(): void {
  if (bannerShown || typeof window === "undefined") return;
  const effective = currentLevel();
  if (LEVEL_ORDER[effective] <= LEVEL_ORDER.warn) return;
  bannerShown = true;

  const runtimeActive = readRuntimeLevel() !== null;
  const disableHint = runtimeActive
    ? `sessionStorage.removeItem("${STORAGE_KEY}"); location.reload()`
    : "unset NEXT_PUBLIC_PEAR_LOG_LEVEL in the host env config and redeploy";

  // Use console.warn directly rather than `log.warn` so the banner
  // always surfaces regardless of whether other scopes exist, and
  // can't recurse through `maybeShowBanner`.
  console.warn(
    `[pear] verbose logging is ON (level=${effective}). ` +
      `Console output may include workspace / UI state. Disable with: ${disableHint}`
  );
}

type LogFn = (...args: unknown[]) => void;

export interface Logger {
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
  /** Returns true if the given level would currently be emitted. */
  enabled: (level: Exclude<Level, "silent">) => boolean;
}

/**
 * Build a logger tagged with an optional scope. The scope appears in
 * every message as `[pear/<scope>]` so it's greppable in a busy
 * console.
 */
export function createLogger(scope?: string): Logger {
  const tag = scope ? `[pear/${scope}]` : "[pear]";
  return {
    error: (...args) => { if (gate("error")) { maybeShowBanner(); console.error(tag, ...args); } },
    warn:  (...args) => { if (gate("warn"))  { maybeShowBanner(); console.warn(tag, ...args); } },
    info:  (...args) => { if (gate("info"))  { maybeShowBanner(); console.info(tag, ...args); } },
    debug: (...args) => { if (gate("debug")) { maybeShowBanner(); console.debug(tag, ...args); } },
    enabled: (level) => gate(level),
  };
}
