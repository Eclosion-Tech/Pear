// The canonical table policy lives next to the Rust module so both sides of the
// snapshot format (this exporter and the import reducers in
// pear/server/spacetimedb/src/import/pear_v2.rs) are driven by the same file.
// It is imported directly — there is no copied/duplicated list to drift.
import tablePolicy from "../../../server/spacetimedb/snapshot_tables_v2.json";

/** The full canonical policy document (include list + documented exclusions). */
export const SNAPSHOT_TABLE_POLICY_V2: {
  format: string;
  include: string[];
  exclude: Record<string, string>;
} = tablePolicy;

/** Public module tables included in a pear-snapshot-v2 export (snake_case sourceNames). */
export const SNAPSHOT_TABLES_V2: readonly string[] = tablePolicy.include;

/** Public module tables deliberately excluded from export (snake_case sourceNames). */
export const SNAPSHOT_EXCLUDED_TABLES_V2: readonly string[] = Object.keys(tablePolicy.exclude);
