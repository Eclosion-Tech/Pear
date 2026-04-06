/**
 * Default value resolution for database column properties.
 *
 * Supports static literals and formula functions:
 *   now()              → Date: current timestamp
 *   me()               → Person: current user identity
 *   uuid()             → Text: random UUID v4
 *   counter("PREFIX-") → Text: auto-incrementing "PREFIX-N"
 *   rand(1, 100)       → Number: random integer in range
 *   rand(["a","b"])    → Text/Select: random pick from array
 *   rand(select)       → Select: random pick from column's own options
 *   this[F]="V"?"R"    → Any: conditional ternary (reuses formulaEval)
 */

import { parseOptionFormula } from "./formulaEval";

export interface DefaultResolveContext {
  userIdentityHex: string;
  /** Sibling property values resolved so far (for ternary conditions). */
  siblingValues: Record<string, string>;
  /** All current string values in this column across existing rows (for counter). */
  existingColumnValues?: string[];
  /** Select/MultiSelect options from the property's own config (for rand(select)). */
  selectOptions?: string[];
}

type PropertyValue =
  | { tag: "Text"; value: string }
  | { tag: "Number"; value: number }
  | { tag: "Date"; value: bigint }
  | { tag: "Select"; value: string }
  | { tag: "MultiSelect"; value: string[] }
  | { tag: "Checkbox"; value: boolean }
  | { tag: "Url"; value: string }
  | { tag: "Person"; value: string[] }
  | { tag: "Relation"; value: bigint[] };

/**
 * Extract `defaultValue` from a config JSON string.
 * Returns null if not present or config is invalid.
 */
export function getDefaultExpr(config: string): string | null {
  try {
    const parsed = JSON.parse(config);
    return typeof parsed?.defaultValue === "string" && parsed.defaultValue.trim()
      ? parsed.defaultValue.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Merge a defaultValue into an existing config JSON string,
 * preserving all other keys (options, conditions, colors, targetPageId, etc).
 */
export function mergeDefaultIntoConfig(config: string, defaultValue: string | null): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(config);
  } catch {
    // invalid existing config, start fresh
  }
  if (defaultValue) {
    parsed.defaultValue = defaultValue;
  } else {
    delete parsed.defaultValue;
  }
  return JSON.stringify(parsed);
}

/**
 * Resolve a default value expression into a typed PropertyValue.
 * Returns null if no default, the expression is invalid for the type,
 * or resolution fails.
 */
export function resolveDefault(
  defaultExpr: string,
  propertyType: string,
  ctx: DefaultResolveContext,
): PropertyValue | null {
  const expr = defaultExpr.trim();
  if (!expr) return null;

  // --- Formula functions ---

  if (expr === "now()") {
    if (propertyType === "Date") return { tag: "Date", value: BigInt(Date.now()) };
    if (propertyType === "Text") return { tag: "Text", value: new Date().toLocaleDateString() };
    return null;
  }

  if (expr === "me()") {
    if (propertyType !== "Person") return null;
    return { tag: "Person", value: [ctx.userIdentityHex] };
  }

  if (expr === "uuid()") {
    if (propertyType !== "Text") return null;
    return { tag: "Text", value: crypto.randomUUID() };
  }

  // counter("PREFIX-")
  const counterMatch = expr.match(/^counter\(["'](.+?)["']\)$/);
  if (counterMatch) {
    if (propertyType !== "Text") return null;
    const prefix = counterMatch[1];
    return { tag: "Text", value: resolveCounter(prefix, ctx.existingColumnValues ?? []) };
  }

  // rand(select) — pick from column's select options
  if (expr === "rand(select)") {
    const opts = ctx.selectOptions ?? [];
    if (opts.length === 0) return null;
    const pick = opts[Math.floor(Math.random() * opts.length)];
    if (propertyType === "Select") return { tag: "Select", value: pick };
    if (propertyType === "MultiSelect") return { tag: "MultiSelect", value: [pick] };
    return { tag: "Text", value: pick };
  }

  // rand(["a", "b", "c"]) — pick from explicit array
  const randArrayMatch = expr.match(/^rand\(\[(.+)\]\)$/);
  if (randArrayMatch) {
    try {
      const items: string[] = JSON.parse(`[${randArrayMatch[1]}]`);
      if (items.length === 0) return null;
      const pick = items[Math.floor(Math.random() * items.length)];
      if (propertyType === "Select") return { tag: "Select", value: pick };
      if (propertyType === "MultiSelect") return { tag: "MultiSelect", value: [pick] };
      return { tag: "Text", value: pick };
    } catch {
      return null;
    }
  }

  // rand(min, max) — random integer in range
  const randRangeMatch = expr.match(/^rand\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/);
  if (randRangeMatch) {
    if (propertyType !== "Number") return null;
    const min = parseInt(randRangeMatch[1], 10);
    const max = parseInt(randRangeMatch[2], 10);
    if (min > max) return null;
    const value = Math.floor(Math.random() * (max - min + 1)) + min;
    return { tag: "Number", value };
  }

  // Ternary conditional: this[Field]="Value"?"Result"
  const formula = parseOptionFormula(expr);
  if (formula) {
    const sibVal = ctx.siblingValues[formula.condition.propName] ?? "";
    if (sibVal === formula.condition.value) {
      return coerceToType(formula.label, propertyType);
    }
    return null;
  }

  // --- Static literal fallback ---
  return coerceToType(expr, propertyType);
}

/** Resolve counter("PREFIX-") by scanning existing values. */
function resolveCounter(prefix: string, existingValues: string[]): string {
  let maxN = 0;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedPrefix}(\\d+)$`);

  for (const val of existingValues) {
    const m = val.match(pattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return `${prefix}${maxN + 1}`;
}

/** Coerce a string literal to the appropriate PropertyValue type. */
function coerceToType(raw: string, propertyType: string): PropertyValue | null {
  switch (propertyType) {
    case "Text":
      return { tag: "Text", value: raw };
    case "Url":
      return { tag: "Url", value: raw };
    case "Select":
      return { tag: "Select", value: raw };
    case "MultiSelect":
      return { tag: "MultiSelect", value: raw.split(",").map((s) => s.trim()).filter(Boolean) };
    case "Number": {
      const n = parseFloat(raw);
      return isNaN(n) ? null : { tag: "Number", value: n };
    }
    case "Checkbox":
      return { tag: "Checkbox", value: raw === "true" };
    case "Date": {
      const ms = Date.parse(raw);
      return isNaN(ms) ? null : { tag: "Date", value: BigInt(ms) };
    }
    default:
      return null;
  }
}

/**
 * Formula hint text for each property type, shown in the default value UI.
 */
export function getFormulaHints(propertyType: string): string[] {
  switch (propertyType) {
    case "Date":
      return ["now()"];
    case "Person":
      return ["me()"];
    case "Text":
      return ["now()", "uuid()", 'counter("PREFIX-")'];
    case "Number":
      return ["rand(1, 100)"];
    case "Select":
      return ["rand(select)", 'rand(["A", "B"])'];
    case "MultiSelect":
      return ["rand(select)"];
    default:
      return [];
  }
}
