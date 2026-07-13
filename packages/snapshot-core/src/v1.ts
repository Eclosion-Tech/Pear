import { encodePearValue } from "./encodePearValue";

/** Pear portable snapshot format (JSON). Version 1. */
export const PEAR_SNAPSHOT_FORMAT = "pear-snapshot-v1" as const;

/**
 * Public tables included in a v1 client-side export (matches SpacetimeDB module bindings).
 * Order is not significant; import applies rows in server-defined dependency order.
 *
 * Frozen: this is the historical v1 list, kept only so old snapshot files stay importable.
 * New exports use the v2 format (see v2.ts / tablePolicy.ts).
 */
export const PEAR_SNAPSHOT_TABLES = [
  "user",
  "user_preference",
  "page",
  "page_content",
  "page_yjs_state",
  "page_snapshot",
  "database_schema",
  "property_definition",
  "database_view",
  "page_property_value",
  "page_property_value_history",
  "attachment",
  "page_access_rule",
  "block_access_rule",
  "ai_user_profile",
  "ai_user_memory",
  "conversation",
  "conversation_participant",
  "conversation_message",
  "harness_template",
  "review_agent_binding",
  "review_annotation",
  "auto_apply_binding",
  "extension_manifest",
  "installed_extension",
  "orcha_agent",
  "orcha_job",
  "orcha_task",
  "orcha_shared_context",
  "api_endpoint",
  "api_field_mapping",
  "api_endpoint_key",
] as const;

export type PearSnapshotTableName = (typeof PEAR_SNAPSHOT_TABLES)[number];

export type PearSnapshotV1 = {
  format: typeof PEAR_SNAPSHOT_FORMAT;
  exportedAt: string;
  workspace: { wsUri: string; dbName: string };
  tables: Record<PearSnapshotTableName, unknown[]>;
};

export function buildPearSnapshotV1(
  conn: { db: unknown },
  workspace: { wsUri: string; dbName: string }
): PearSnapshotV1 {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = conn.db as any;
  const tables = {} as Record<PearSnapshotTableName, unknown[]>;

  for (const name of PEAR_SNAPSHOT_TABLES) {
    const t = db[name];
    const rows: unknown[] = [];
    if (t && typeof t.iter === "function") {
      for (const row of t.iter()) {
        rows.push(encodePearValue(row));
      }
    }
    tables[name] = rows;
  }

  return {
    format: PEAR_SNAPSHOT_FORMAT,
    exportedAt: new Date().toISOString(),
    workspace,
    tables,
  };
}

export function parsePearSnapshotV1Json(text: string): PearSnapshotV1 {
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object") throw new Error("Invalid snapshot: expected object");
  const o = v as Record<string, unknown>;
  if (o.format !== PEAR_SNAPSHOT_FORMAT) {
    throw new Error(`Invalid snapshot format: ${String(o.format)}`);
  }
  if (!o.tables || typeof o.tables !== "object") {
    throw new Error("Invalid snapshot: missing tables");
  }
  return o as PearSnapshotV1;
}
