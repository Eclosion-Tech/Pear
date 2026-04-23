"use client";

/** Pear portable snapshot format (JSON). Version 1. */
export const PEAR_SNAPSHOT_FORMAT = "pear-snapshot-v1" as const;

/**
 * Public tables included in a client-side export (matches SpacetimeDB module bindings).
 * Order is not significant; import applies rows in server-defined dependency order.
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

function uint8ToBase64(u8: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(u8).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Lossless JSON-friendly encoding for SpacetimeDB row values (bigint, bytes, Identity, Timestamp).
 */
export function encodePearValue(v: unknown): unknown {
  if (v == null) return v;
  const t = typeof v;
  if (t === "bigint") return { __pear: "bigint", v: v.toString() };
  if (t === "number" || t === "boolean" || t === "string") return v;
  if (v instanceof Uint8Array) return { __pear: "bytes", v: uint8ToBase64(v) };
  if (Array.isArray(v)) return v.map(encodePearValue);
  if (t === "object") {
    const o = v as Record<string, unknown>;
    if (typeof (o as { toHexString?: () => string }).toHexString === "function") {
      return { __pear: "identity", v: (o as { toHexString: () => string }).toHexString() };
    }
    if (
      "microsSinceUnixEpoch" in o &&
      typeof (o as { microsSinceUnixEpoch: unknown }).microsSinceUnixEpoch === "bigint"
    ) {
      return {
        __pear: "timestamp",
        v: (o as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch.toString(),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      out[k] = encodePearValue(val);
    }
    return out;
  }
  return v;
}

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

export function downloadPearSnapshotJson(snapshot: PearSnapshotV1, filenameHint?: string): void {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameHint ?? `pear-snapshot-${snapshot.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
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
