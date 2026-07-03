/**
 * stdio-mode prelude. MUST be the first import of the stdio entrypoint.
 *
 * On the stdio transport, stdout carries the MCP protocol — a single stray
 * `console.log` from any imported module corrupts the stream. Redirect all
 * console output to stderr before anything else can evaluate.
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
