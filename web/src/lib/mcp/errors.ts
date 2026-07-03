/**
 * Error-message normalization for reducer failures.
 *
 * `HttpStdbTransport.call` wraps a non-2xx response as an ApiEndpointError
 * with message "SpacetimeDB reducer '<name>' failed (<status>): <body>".
 * The body is the Rust `Err(String)` text — the part the model should see.
 */

const REDUCER_ERR_RE = /^SpacetimeDB reducer '[^']*' failed \(\d+\):\s*/;

export function reducerErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(REDUCER_ERR_RE, "").trim() || message;
}
