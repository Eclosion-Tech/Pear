/**
 * Formula evaluation for conditional select/multi-select options.
 *
 * Syntax (typed in the option name field when creating an option):
 *   this[PropName]="CondValue"?"Label"
 *
 * Examples:
 *   this[Type]="Video"?"Ready for Filming"   → show only when Type = "Video"
 *   this[Type]="Video"?"Editing"             → show only when Type = "Video"
 *   Draft                                    → always visible (plain label)
 *
 * The formula is only parsed on creation — the stored option label is the
 * plain `Label` string, and the condition lives separately in the config's
 * `conditions` map. Row property values always store the plain label string.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Equality condition that gates a select option's visibility. */
export interface SelectOptionCondition {
  /** Name of the sibling property to evaluate. */
  propName: string;
  /** The value that property must equal for the option to be visible. */
  value: string;
}

// ─── Color palette ────────────────────────────────────────────────────────────

export const COLOR_KEYS = [
  "default", "blue", "green", "yellow", "orange", "red", "purple", "pink",
] as const;
export type OptionColorKey = typeof COLOR_KEYS[number];

/** Tailwind classes for option chips (pill badges). */
export const OPTION_CHIP_CLASSES: Record<OptionColorKey, string> = {
  default: "bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200",
  blue:    "bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-200",
  green:   "bg-green-100 dark:bg-green-900/60 text-green-700 dark:text-green-200",
  yellow:  "bg-yellow-100 dark:bg-yellow-900/60 text-yellow-700 dark:text-yellow-200",
  orange:  "bg-orange-100 dark:bg-orange-900/60 text-orange-700 dark:text-orange-200",
  red:     "bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-200",
  purple:  "bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-200",
  pink:    "bg-pink-100 dark:bg-pink-900/60 text-pink-700 dark:text-pink-200",
};

/** Tailwind background classes for color-picker swatch dots. */
export const SWATCH_BG_CLASSES: Record<OptionColorKey, string> = {
  default: "bg-neutral-400 dark:bg-neutral-500",
  blue:    "bg-blue-400 dark:bg-blue-500",
  green:   "bg-green-400 dark:bg-green-500",
  yellow:  "bg-yellow-400 dark:bg-yellow-500",
  orange:  "bg-orange-400 dark:bg-orange-500",
  red:     "bg-red-400 dark:bg-red-500",
  purple:  "bg-purple-400 dark:bg-purple-500",
  pink:    "bg-pink-400 dark:bg-pink-500",
};

/**
 * Returns Tailwind chip classes for an option, respecting any stored color
 * override in the config and falling back to the index-based palette.
 */
export function getOptionColorClass(opt: string, cfg: SelectConfig): string {
  const stored = cfg.colors?.[opt] as OptionColorKey | undefined;
  if (stored && OPTION_CHIP_CLASSES[stored]) {
    return OPTION_CHIP_CLASSES[stored];
  }
  const idx = cfg.options.indexOf(opt);
  const key = COLOR_KEYS[(idx < 0 ? 0 : idx) % COLOR_KEYS.length];
  return OPTION_CHIP_CLASSES[key];
}

/**
 * Select / MultiSelect config shape stored as JSON in
 * `PropertyDefinition.config`.
 *
 * Backward-compatible with the old `{ options: string[] }` format — the
 * `conditions` key simply wasn't present before.
 */
export interface SelectConfig {
  /** All option labels as plain strings. This is also what gets persisted in
   *  `PagePropertyValue` when the user picks an option. */
  options: string[];
  /**
   * Optional visibility conditions keyed by option label.
   * An option without an entry is always visible.
   */
  conditions?: Record<string, SelectOptionCondition>;
  /** Optional per-option color overrides keyed by option label. */
  colors?: Record<string, OptionColorKey>;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse the `this[PropName]="CondValue"?"Label"` formula syntax.
 *
 * Returns `{ label, condition }` on a successful match, or `null` if the
 * input is just a plain option name.
 */
export function parseOptionFormula(
  input: string
): { label: string; condition: SelectOptionCondition } | null {
  // this[PropName]="CondValue"?"Label"
  const match = input.match(/^this\[([^\]]+)\]="([^"]*)"\?"(.+)"$/);
  if (!match) return null;
  return {
    condition: { propName: match[1], value: match[2] },
    label: match[3],
  };
}

/** Parse a JSON config string into a `SelectConfig`. Handles legacy plain-string arrays. */
export function parseSelectConfig(config: string): SelectConfig {
  try {
    const parsed = JSON.parse(config) as {
      options?: unknown;
      conditions?: unknown;
      colors?: unknown;
    };
    const options = Array.isArray(parsed.options)
      ? (parsed.options as string[])
      : [];
    const conditions =
      parsed.conditions && typeof parsed.conditions === "object"
        ? (parsed.conditions as Record<string, SelectOptionCondition>)
        : undefined;
    const colors =
      parsed.colors && typeof parsed.colors === "object"
        ? (parsed.colors as Record<string, OptionColorKey>)
        : undefined;
    return { options, conditions, colors };
  } catch {
    return { options: [] };
  }
}

/** Serialize a `SelectConfig` back to a JSON string for storage. */
export function serializeSelectConfig(cfg: SelectConfig): string {
  return JSON.stringify(cfg);
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Evaluate whether an option should be visible given the row's current sibling
 * property values (`propName → current string value`).
 *
 * Returns the label string if the option is visible, `null` if it should be
 * hidden because its condition does not pass.
 */
export function evaluateOption(
  label: string,
  cfg: SelectConfig,
  siblingValues: Record<string, string>
): string | null {
  const cond = cfg.conditions?.[label];
  if (!cond) return label; // no condition → always visible
  return (siblingValues[cond.propName] ?? "") === cond.value ? label : null;
}

/**
 * Returns `true` if the currently-selected value is valid for the row's
 * current sibling values (i.e., its condition passes, or it has no condition).
 *
 * An empty value is always considered valid.
 */
export function isOptionValid(
  value: string,
  cfg: SelectConfig,
  siblingValues: Record<string, string>
): boolean {
  if (!value) return true;
  return evaluateOption(value, cfg, siblingValues) !== null;
}

// ─── Sibling value extraction ─────────────────────────────────────────────────

/**
 * Build a `{ propName → stringValue }` map from a row's property values.
 * Only types that make sense in conditions (scalars) are included.
 *
 * Used by GridRow and PropertiesPanel to produce the `siblingValues` prop
 * that's passed down to PropertyCell.
 */
export function buildSiblingValues(
  values: ReadonlyArray<{
    propertyDefinitionId: bigint;
    value: { tag: string; value: unknown };
  }>,
  properties: ReadonlyArray<{ id: bigint; name: string }>
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of values) {
    const prop = properties.find((p) => p.id === v.propertyDefinitionId);
    if (!prop) continue;
    const val = v.value;
    if (
      val.tag === "Select" ||
      val.tag === "Text" ||
      val.tag === "Url"
    ) {
      map[prop.name] = val.value as string;
    } else if (val.tag === "Number") {
      map[prop.name] = String(val.value);
    } else if (val.tag === "Checkbox") {
      map[prop.name] = String(val.value);
    }
  }
  return map;
}
