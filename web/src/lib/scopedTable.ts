/**
 * Pure helpers for `useScopedTable` (src/hooks/useScopedTable.ts).
 *
 * Kept in `src/lib` so the row-membership + fallback-SQL semantics are
 * unit-testable under the node-env vitest config, which only includes
 * `src/lib/**` (see vitest.config.ts).
 */

/** How an updated row moved relative to a client-side scope filter. */
export type RowMembershipChange = "enter" | "leave" | "stayIn" | "stayOut";

/**
 * Classify an update event against a scope filter, mirroring the SDK's
 * `classifyMembership` for query-builder where-clauses
 * (spacetimedb/src/react/useTable.ts) but over a plain predicate:
 *
 * - `leave`  → surface as a delete of `oldRow`
 * - `enter`  → surface as an insert of `newRow`
 * - `stayIn` → surface as an update
 * - `stayOut`→ ignore entirely
 */
export function classifyRowMembership<Row>(
  filter: (row: Row) => boolean,
  oldRow: Row,
  newRow: Row,
): RowMembershipChange {
  const oldIn = filter(oldRow);
  const newIn = filter(newRow);
  if (oldIn && !newIn) return "leave";
  if (!oldIn && newIn) return "enter";
  return oldIn ? "stayIn" : "stayOut";
}

/**
 * The unscoped subscription for a table — the pre-scoping behavior we degrade
 * to when the server rejects a scoped query. `sourceName` is the server-side
 * (snake_case) table name, e.g. `tables.component_node.sourceName`.
 */
export function unscopedFallbackSql(sourceName: string): string {
  return `SELECT * FROM ${sourceName}`;
}
