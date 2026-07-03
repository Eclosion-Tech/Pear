/**
 * Reducer-argument encoders for STDB's HTTP `/v1/database/{db}/call/{reducer}`
 * endpoint (positional SATS-JSON array body).
 *
 * Wire shapes verified live against SpacetimeDB 2.0 (spike, 2026-07-03):
 *   • Unit enum variants use lowerCamel names with an empty-array payload:
 *       PageType::Doc            → {"doc": []}          ({"Doc": []} is REJECTED)
 *       PageContentFormat::…     → {"blockNote": []} / {"componentTree": []}
 *       SnapshotType::PreAgentEdit → {"preAgentEdit": []}
 *   • Option<T>: {"none": []} / {"some": <value>}   (same as codec.encodeOption)
 *   • u64: a JSON *number* — a JSON string is rejected
 *       ("invalid type: string \"1310\", expected u64"), so ids must stay
 *       within Number.MAX_SAFE_INTEGER (they do; the id_counter is gap-free).
 *   • Vec<u8>: a plain JSON array of integers 0–255. NOTE the asymmetry:
 *       `/sql` returns the same column as a HEX STRING (see decode.ts).
 *   • Reducer failures are SYNCHRONOUS: non-2xx (observed 530) with the Rust
 *       `Err(String)` text as the response body — no read-back verification
 *       is needed anywhere in this library.
 */

export { encodeOption } from "../api-endpoint";

export function encodePageType(t: "Doc" | "Database"): Record<string, []> {
  return t === "Database" ? { database: [] } : { doc: [] };
}

export function encodeSnapshotTypePreAgentEdit(): Record<string, []> {
  return { preAgentEdit: [] };
}

/** u64 reducer arg — must be a JSON number (strings are rejected). */
export function encodeU64(v: number | bigint): number {
  const n = typeof v === "bigint" ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`u64 arg out of safe JS number range: ${v}`);
  }
  return n;
}

/** Vec<u8> reducer arg — plain int array. */
export function encodeBytes(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}
