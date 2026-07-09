/**
 * `/sql` row decoding for the MCP core — thin domain layer over the
 * battle-tested wire-shape decoders exported by `../api-endpoint`.
 *
 * Enum columns come back as positional sums `[variantIndex, payload]` (or
 * `{variant: payload}` / bare strings on other paths); the index→name arrays
 * below MUST match the Rust enum declaration order:
 *   PageType           (pages/mod.rs)      : Doc = 0, Database = 1
 *   PageContentFormat  (components.rs)     : BlockNote = 0, ComponentTree = 1
 * `decodeEnumVariant` upper-cases names, so tags are stored upper-case and
 * mapped back to canonical casing here.
 */

import {
  decodeEnumVariant,
  decodeOptionSome,
  isOptionNone,
  normaliseTs,
  unwrapScalar,
} from "../api-endpoint";

export { decodeEnumVariant, decodeOptionSome, isOptionNone, normaliseTs, unwrapScalar };

const PAGE_TYPE_TAGS = ["DOC", "DATABASE"] as const;
const CONTENT_FORMAT_TAGS = ["BLOCKNOTE", "COMPONENTTREE"] as const;

export function decodePageType(raw: unknown): "Doc" | "Database" {
  return decodeEnumVariant(raw, PAGE_TYPE_TAGS) === "DATABASE" ? "Database" : "Doc";
}

export function decodeContentFormat(raw: unknown): "BlockNote" | "ComponentTree" {
  return decodeEnumVariant(raw, CONTENT_FORMAT_TAGS) === "COMPONENTTREE"
    ? "ComponentTree"
    : "BlockNote";
}

/** Scalar (possibly Option-wrapped) → number, or null when None/absent. */
export function toNumberOrNull(raw: unknown): number | null {
  const v = unwrapScalar(raw);
  if (v === null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * `Vec<u8>` column from `/sql` → bytes. Observed wire shape is a HEX STRING
 * (e.g. "0107c3bf…"); tolerate an int array too for forward-compat.
 */
export function decodeBytesColumn(raw: unknown): Uint8Array {
  if (typeof raw === "string") {
    const pairs = raw.match(/.{1,2}/g) ?? [];
    return new Uint8Array(pairs.map((h) => parseInt(h, 16)));
  }
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  return new Uint8Array(0);
}

/** SpacetimeDB SQL has no `IN (...)` — expand to an indexed OR chain. */
export function orChain(column: string, count: number): string {
  return Array.from({ length: count }, () => `${column} = ?`).join(" OR ");
}
