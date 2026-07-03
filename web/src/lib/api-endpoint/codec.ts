/**
 * Codec between API-caller JSON values and SpacetimeDB SATS-JSON
 * `PropertyValue` representations.
 *
 * Encoding rules (caller JSON → SATS):
 *   Text         string                              → { Text: string }
 *   Number       number | numeric string             → { Number: number }
 *   Date         number | ISO-8601 string | Date     → { Date: number }   (ms since epoch)
 *   Select       string                              → { Select: string }  (must be in options)
 *   MultiSelect  string[]                            → { MultiSelect: string[] }
 *   Relation     (number | string)[]                 → { Relation: (number | string)[] }
 *   Checkbox     boolean | "true" | "false"          → { Checkbox: boolean }
 *   Url          string                              → { Url: string }
 *   Person       string[] | string                   → { Person: string[] }
 *
 * Decoding rules invert the above so the SATS shape never leaks into the
 * external API contract.
 */

import { ApiEndpointError } from "./types";
import type { PropertyTypeName, SatsPropertyValue } from "./types";

interface PropertyConfigShape {
  options?: string[];
  defaultValue?: string;
  // ...other forwarded keys are ignored by the codec.
  [key: string]: unknown;
}

function parseConfig(config: string): PropertyConfigShape {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config) as PropertyConfigShape;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function fail(fieldName: string, message: string, details?: unknown): never {
  throw new ApiEndpointError(
    400,
    "invalid_field",
    `Field '${fieldName}': ${message}`,
    details,
  );
}

/**
 * Convert an external API JSON value into the SATS-JSON tagged
 * `PropertyValue` expected by SpacetimeDB reducers.
 */
export function encodePropertyValue(
  fieldName: string,
  propertyType: PropertyTypeName,
  config: string,
  raw: unknown,
): SatsPropertyValue {
  const cfg = parseConfig(config);

  switch (propertyType) {
    case "Text": {
      if (typeof raw !== "string") fail(fieldName, "must be a string");
      return { Text: raw as string };
    }
    case "Url": {
      if (typeof raw !== "string") fail(fieldName, "must be a string URL");
      return { Url: raw as string };
    }
    case "Number": {
      const num =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim() !== ""
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(num)) fail(fieldName, "must be a finite number");
      return { Number: num };
    }
    case "Checkbox": {
      if (typeof raw === "boolean") return { Checkbox: raw };
      if (raw === "true") return { Checkbox: true };
      if (raw === "false") return { Checkbox: false };
      return fail(fieldName, "must be a boolean");
    }
    case "Date": {
      if (raw instanceof Date) return { Date: raw.getTime() };
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return { Date: Math.trunc(raw) };
      }
      if (typeof raw === "string") {
        const ms = Date.parse(raw);
        if (!Number.isFinite(ms))
          fail(fieldName, "must be an ISO-8601 date or epoch millis");
        return { Date: ms };
      }
      return fail(fieldName, "must be an ISO-8601 date or epoch millis");
    }
    case "Select": {
      if (typeof raw !== "string") fail(fieldName, "must be a string");
      const opts = cfg.options ?? [];
      if (opts.length > 0 && !opts.includes(raw as string)) {
        fail(
          fieldName,
          `value '${raw}' is not in the allowed options`,
          { allowed: opts },
        );
      }
      return { Select: raw as string };
    }
    case "MultiSelect": {
      const arr = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw.split(",").map((s) => s.trim()).filter(Boolean)
          : null;
      if (!arr) fail(fieldName, "must be an array of strings");
      if (!arr!.every((v) => typeof v === "string")) {
        fail(fieldName, "must be an array of strings");
      }
      const opts = cfg.options ?? [];
      if (opts.length > 0) {
        const bad = (arr as string[]).filter((v) => !opts.includes(v));
        if (bad.length > 0) {
          fail(
            fieldName,
            `values [${bad.join(", ")}] are not in the allowed options`,
            { allowed: opts },
          );
        }
      }
      return { MultiSelect: arr as string[] };
    }
    case "Person": {
      const arr = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? [raw]
          : null;
      if (!arr || !arr.every((v) => typeof v === "string")) {
        fail(fieldName, "must be an identity hex string or array of strings");
      }
      return { Person: arr as string[] };
    }
    case "Relation": {
      if (!Array.isArray(raw)) {
        fail(fieldName, "must be an array of page ids");
      }
      const ids = (raw as unknown[]).map((v) => {
        if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
          return v;
        }
        if (typeof v === "string" && /^\d+$/.test(v)) {
          return v;
        }
        return fail(fieldName, "page ids must be non-negative integers");
      });
      return { Relation: ids as Array<number | string> };
    }
  }
}

/**
 * Variant ordering for the Rust enum `PropertyValue` in
 * `pear/server/spacetimedb/src/lib.rs`. STDB's HTTP `/sql` endpoint
 * encodes sum-type values positionally as `[variantIndex, payload]`, so we
 * need a stable tag → name map. If you reorder the Rust enum, this list
 * must move with it.
 */
const PROPERTY_VALUE_TAGS = [
  "Text", // 0
  "Number", // 1
  "Date", // 2
  "Select", // 3
  "MultiSelect", // 4
  "Relation", // 5
  "Checkbox", // 6
  "Url", // 7
  "Person", // 8
] as const;

type PropertyValueTag = (typeof PROPERTY_VALUE_TAGS)[number];

/**
 * Normalize the three wire shapes STDB produces for a sum-type cell into a
 * `{ tag, payload }` pair:
 *   • `{ Text: "x" }`         — object form (BSATN-shaped / SDK)
 *   • `[0, "x"]`              — positional sum (HTTP /sql)
 *   • `"Text"`                — bare string for unit-only variants (rare)
 *
 * Returns null if `raw` doesn't match any known PropertyValue variant —
 * which manifests externally as a `null` value for that field, the same
 * fallback the previous all-object decoder used.
 */
function normalisePropertyValue(
  raw: unknown,
): { tag: PropertyValueTag; payload: unknown } | null {
  if (raw == null) return null;

  // Positional `[index, payload]`.
  if (Array.isArray(raw) && raw.length >= 1 && typeof raw[0] === "number") {
    const tag = PROPERTY_VALUE_TAGS[raw[0]];
    if (!tag) return null;
    return { tag, payload: raw.length > 1 ? raw[1] : undefined };
  }

  // Object `{ Tag: payload }` — first matching key wins.
  if (typeof raw === "object") {
    for (const tag of PROPERTY_VALUE_TAGS) {
      if (tag in (raw as Record<string, unknown>)) {
        return { tag, payload: (raw as Record<string, unknown>)[tag] };
      }
    }
  }

  // Bare string — unit variants only; PropertyValue has no unit variants
  // today but accept it for forward-compat.
  if (typeof raw === "string") {
    if ((PROPERTY_VALUE_TAGS as readonly string[]).includes(raw)) {
      return { tag: raw as PropertyValueTag, payload: undefined };
    }
  }

  return null;
}

/**
 * Convert a `PropertyValue` (in any wire shape) into a plain JSON value
 * for the external API response. Dates are emitted as ISO-8601 strings to
 * keep the contract self-describing.
 */
export function decodePropertyValue(value: SatsPropertyValue | unknown): unknown {
  const norm = normalisePropertyValue(value);
  if (!norm) return null;

  switch (norm.tag) {
    case "Text":
    case "Url":
    case "Select":
      return typeof norm.payload === "string" ? norm.payload : null;
    case "MultiSelect":
    case "Person":
      return Array.isArray(norm.payload)
        ? (norm.payload as unknown[]).filter((v) => typeof v === "string")
        : [];
    case "Relation":
      return Array.isArray(norm.payload)
        ? (norm.payload as unknown[]).map((v) =>
            typeof v === "string" ? v : String(v),
          )
        : [];
    case "Number":
      return typeof norm.payload === "number"
        ? norm.payload
        : typeof norm.payload === "string"
          ? Number(norm.payload)
          : null;
    case "Checkbox":
      return Boolean(norm.payload);
    case "Date": {
      const raw = norm.payload;
      const ms =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(ms)) return null;
      return new Date(ms).toISOString();
    }
  }
}

/** Encode an `HttpMethod` enum for SATS-JSON reducer args. */
export function encodeHttpMethod(
  method: "GET" | "POST" | "PATCH" | "DELETE",
): { Get: [] } | { Post: [] } | { Patch: [] } | { Delete: [] } {
  switch (method) {
    case "GET":
      return { Get: [] };
    case "POST":
      return { Post: [] };
    case "PATCH":
      return { Patch: [] };
    case "DELETE":
      return { Delete: [] };
  }
}

/** Encode an `Option<T>` for SATS-JSON (`{ some: T }` / `{ none: [] }`). */
export function encodeOption<T>(value: T | null | undefined):
  | { some: T }
  | { none: [] } {
  if (value === null || value === undefined) return { none: [] };
  return { some: value };
}

// ── Generic STDB `/sql` wire-shape decoders ────────────────────────────────────
// Relocated from dispatcher.ts so other shared libs (e.g. `../mcp`) can reuse
// them — they encode hard-won lessons about STDB's HTTP wire shapes.

/**
 * Generic decoder for STDB sum-type variants. Returns the upper-cased
 * variant name if it matches one of the provided tags, otherwise null.
 */
export function decodeEnumVariant<T extends readonly string[]>(
  v: unknown,
  tags: T,
): T[number] | null {
  if (typeof v === "string") {
    const upper = v.toUpperCase();
    return (tags as readonly string[]).includes(upper)
      ? (upper as T[number])
      : null;
  }
  if (typeof v === "number") {
    return (tags[v] ?? null) as T[number] | null;
  }
  if (Array.isArray(v) && v.length >= 1) {
    return decodeEnumVariant(v[0], tags);
  }
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    if ("tag" in obj) {
      return decodeEnumVariant(obj.tag, tags);
    }
    const firstKey = Object.keys(obj)[0];
    if (firstKey !== undefined) {
      const upper = firstKey.toUpperCase();
      return (tags as readonly string[]).includes(upper)
        ? (upper as T[number])
        : null;
    }
  }
  return null;
}

/**
 * Wire shapes for `Option<T>` observed from STDB's HTTP `/sql` endpoint:
 *   • `null`            — absence (rare; SDK-shaped paths only)
 *   • `{ none: [] }`    — object form for None
 *   • `{ some: <T> }`   — object form for Some
 *   • `[1, []]`         — positional sum, variant 1 = None
 *   • `[0, <T>]`        — positional sum, variant 0 = Some
 *
 * `decodeOptionSome` returns the inner value if the option is Some, or
 * `undefined` if it's None / absent. `isOptionNone` is the dual.
 *
 * These exist because earlier code compared option columns directly to JS
 * `null` (e.g. `deleted_at === null`), which silently mis-classified every
 * row as deleted once STDB started returning `[1, []]` for None — every
 * list/get/update would 404 or come back with `data: []`.
 */
export function decodeOptionSome(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length >= 2 && raw[0] === 0) return raw[1];
    return undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("some" in obj) return obj.some;
    if ("none" in obj) return undefined;
  }
  // Bare value (some non-Option SQL projections fall here) — treat as Some.
  return raw;
}

export function isOptionNone(raw: unknown): boolean {
  return decodeOptionSome(raw) === undefined;
}

/**
 * Coerce a STDB-returned scalar that *might* be wrapped in an Option or a
 * single-element Product (Timestamp's wire form is `[micros]`) down to a
 * primitive comparable value. Used for parent_id / page_id checks where we
 * only need string equality, not the structured shape.
 */
export function unwrapScalar(raw: unknown): string | number | null {
  // A single-element array is a bare Product (e.g. a non-Option Timestamp's
  // wire form `[micros]`), NOT an Option — Options are always 2-element
  // positional sums (`[0, v]` / `[1, []]`). Peel it before Option decoding,
  // otherwise `[micros]` is mis-read as "not Some" and dropped.
  if (Array.isArray(raw) && raw.length === 1) return unwrapScalar(raw[0]);
  const some = decodeOptionSome(raw);
  if (some === undefined) return null;
  if (Array.isArray(some)) {
    if (some.length === 1) return unwrapScalar(some[0]);
    return null;
  }
  if (typeof some === "object" && some !== null) {
    const obj = some as Record<string, unknown>;
    // Timestamp / TimeDuration object shape.
    const v =
      obj.__timestamp_micros_since_unix_epoch__ ??
      obj.__time_duration_micros__ ??
      obj.microsSinceUnixEpoch;
    if (typeof v === "number" || typeof v === "string") return v;
    return null;
  }
  if (typeof some === "string" || typeof some === "number") return some;
  return null;
}

/**
 * STDB's HTTP `/sql` returns Timestamp columns as a single-element Product
 * `[<i64 micros>]` (the wire shape of `Timestamp { __timestamp_micros... }`),
 * not a millisecond number. Earlier code did `new Date(Number(raw))` which:
 *   • only worked accidentally when `raw` was already a number (it isn't), and
 *   • interpreted micros as ms — producing year ~58294 ISO strings.
 * Use `unwrapScalar` to peel both Option<Timestamp> and bare Timestamp into
 * a numeric micros value, then divide.
 */
export function normaliseTs(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const v = unwrapScalar(raw);
  if (v == null) return undefined;
  const micros = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(micros)) return undefined;
  return new Date(micros / 1000).toISOString();
}
