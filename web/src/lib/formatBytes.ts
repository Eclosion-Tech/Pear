/**
 * Human-readable byte count: `512 B`, `48 KB`, `2.3 MB`, `1.1 GB`.
 * Non-finite or negative input yields an empty string so callers can
 * conditionally render the label.
 */
export function formatBytes(n: number | bigint | null | undefined): string {
  const v = typeof n === "bigint" ? Number(n) : n;
  if (v == null || !Number.isFinite(v) || v < 0) return "";
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${Math.round(v)} B`;
}
