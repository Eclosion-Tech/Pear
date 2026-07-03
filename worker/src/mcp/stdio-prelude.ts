/**
 * stdio-mode prelude. MUST be the first import of the stdio entrypoint.
 *
 * On the stdio transport, stdout carries the MCP protocol — a single stray
 * `console.log` from worker code (tools.ts, subscriptions.ts, …) corrupts the
 * stream. Redirect all console output to stderr before any worker module can
 * evaluate. Also installs the WebSocket polyfill required before any
 * `spacetimedb` import (see worker/src/index.ts).
 */

/* eslint-disable no-console */
const toStderr =
  (level: string) =>
  (...args: unknown[]) => {
    const text = args
      .map((a) => (typeof a === "string" ? a : (() => {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })()))
      .join(" ");
    process.stderr.write(`${level} ${text}\n`);
  };

console.log = toStderr("[log]");
console.info = toStderr("[info]");
console.debug = toStderr("[debug]");
console.warn = toStderr("[warn]");
// console.error already writes to stderr — leave it alone.

import { WebSocket } from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}
