"use client";

// Pear portable snapshot formats now live in the shared workspace package
// @eclosion-tech/snapshot-core (packages/snapshot-core). This module re-exports
// them and keeps only the browser-specific download helper.

export {
  // v1 (kept for the import path — old snapshot files stay importable)
  PEAR_SNAPSHOT_FORMAT,
  PEAR_SNAPSHOT_TABLES,
  buildPearSnapshotV1,
  parsePearSnapshotV1Json,
  // shared encoding
  encodePearValue,
  // v2
  PEAR_SNAPSHOT_FORMAT_V2,
  SNAPSHOT_TABLE_POLICY_V2,
  SNAPSHOT_TABLES_V2,
  SNAPSHOT_EXCLUDED_TABLES_V2,
  buildPearSnapshotV2,
  chunkSnapshotV2,
  resolveSnapshotTableAccessors,
  parsePearSnapshotJson,
} from "@eclosion-tech/snapshot-core";
export type {
  PearSnapshotTableName,
  PearSnapshotV1,
  PearSnapshotV2,
  PearSnapshotV2Chunk,
  PearSnapshotV2Header,
  PearSnapshotV2Manifest,
  PearSnapshotV2Meta,
  ChunkedPearSnapshotV2,
  ParsedPearSnapshot,
  SnapshotTableRegistry,
  SnapshotTableRegistryEntry,
} from "@eclosion-tech/snapshot-core";

import type { PearSnapshotV1, PearSnapshotV2 } from "@eclosion-tech/snapshot-core";

/** Browser-only: serialize a snapshot and trigger a file download. */
export function downloadPearSnapshotJson(
  snapshot: PearSnapshotV1 | PearSnapshotV2,
  filenameHint?: string
): void {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameHint ?? `pear-snapshot-${snapshot.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
