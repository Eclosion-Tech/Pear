/**
 * Deterministic id discovery for reducers (which return nothing).
 *
 * `Page.id`, `ComponentNode.id`, `DatabaseSchema.id`, and `PageSnapshot.id`
 * are allocated through the public, gap-free `id_counter` table
 * (server/spacetimedb/src/id_counters.rs): one row per counter name whose
 * `value` is the LAST allocated id. Reading the counter before and after a
 * sequential reducer call identifies the new row's id exactly; a concurrent
 * writer interleaving allocations shows up as `after > before + 1`, in which
 * case the caller's `fallback` re-selects candidates in `(before, after]`.
 */

import type { StdbTransport } from "../api-endpoint";

export type CounterName =
  | "page"
  | "component_node"
  | "database_schema"
  | "page_snapshot";

export async function readCounter(
  transport: StdbTransport,
  name: CounterName,
): Promise<number> {
  const rows = await transport.sql<{ value: number | string }>(
    "SELECT value FROM id_counter WHERE name = ?",
    [name],
  );
  const v = rows[0]?.value;
  return v === undefined || v === null ? 0 : Number(v);
}

/**
 * Resolve the id allocated by the reducer call that ran between the `before`
 * counter read and now. `fallback(lo, hi)` re-selects candidates when a
 * concurrent writer interleaved (ids in the half-open range `(lo, hi]`);
 * returning null means the write could not be attributed.
 */
export async function discoverAllocatedId(
  transport: StdbTransport,
  name: CounterName,
  before: number,
  fallback: (lo: number, hi: number) => Promise<number | null>,
): Promise<number | null> {
  const after = await readCounter(transport, name);
  if (after === before + 1) return after;
  if (after <= before) return null;
  return fallback(before, after);
}
