/**
 * `style_v1` — the style token vocabulary.
 *
 * Implements S1 of `docs/PEAR_STYLE_VOCABULARY_ADR.md`: the spacing scale plus
 * the parsing contract every later stage reuses.
 *
 * ## Why tokens rather than values (D1, D2)
 *
 * Every leaf here is an enum member. That is the security boundary, not the
 * vocabulary's *size*: two hundred enum-valued knobs are exactly as safe as
 * five, because the failure modes of free-form styling (URL exfiltration,
 * embedded script, layout escape) come from unbounded values, never from
 * abundant options. So this file is expected to grow, and growing it is a
 * maintenance decision — every token costs a web mapping and an RN mapping,
 * forever — not a safety one.
 *
 * Storing names rather than values is what keeps theming, host re-skinning,
 * dark mode, and portable/forkable trees possible later without rewriting a
 * single stored tree.
 *
 * ## Why this file has no CSS in it (D4)
 *
 * Pulp is renderer-agnostic and ships an RN renderer alongside the web one, so
 * the vocabulary lives here and the *mappings* live per-renderer. The web
 * mapping happens to be Tailwind classes; that is an implementation detail of
 * one renderer and must never leak into stored props.
 */

/**
 * Spacing scale. Values are names; the web renderer maps them onto Tailwind's
 * 4px steps (which the codebase already used implicitly via
 * `Container.gap: n × 0.25rem`), and the RN renderer maps them to dp.
 */
export const SPACE_TOKENS = ["none", "xs", "sm", "md", "lg", "xl"] as const;
export type SpaceToken = (typeof SPACE_TOKENS)[number];

/**
 * The `style` object a component may declare it honours.
 *
 * Nested under a single `style` key rather than flat-prefixed (`styleGap`) so
 * that it namespaces cleanly against domain props, versions as a unit, and can
 * be handed to one shared resolver. Components ignore keys they do not
 * support; there is deliberately no cascade (§ Non-goals) — tokens apply to the
 * node that declares them.
 */
export type StyleTokens = {
  padding?: SpaceToken;
  paddingX?: SpaceToken;
  paddingY?: SpaceToken;
  gap?: SpaceToken;
  /** Leading-edge inset. Distinct from `padding`, which applies to all sides. */
  indent?: SpaceToken;
};

const SPACE_SET: ReadonlySet<string> = new Set(SPACE_TOKENS);

const SPACE_KEYS = ["padding", "paddingX", "paddingY", "gap", "indent"] as const;

/**
 * Parse a `style` value into known tokens, dropping anything unrecognized.
 *
 * This is the actual enforcement point (D5). Prop schemas are validated on the
 * client only — `components.rs:112` is explicit that server-side enforcement is
 * post-v1 — so an agent writing over MCP can put arbitrary JSON in props today.
 * A closed set that only a schema checks is closed by convention; an allowlist
 * in the renderer path is closed in fact.
 *
 * Unknown keys and unknown values resolve to *unset*, which is the documented
 * default. Nothing is ever passed through to the DOM, so a hostile or merely
 * mistaken value cannot become a CSS declaration.
 */
export function parseStyleTokens(raw: unknown): StyleTokens {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: StyleTokens = {};

  for (const key of SPACE_KEYS) {
    const v = r[key];
    if (typeof v === "string" && SPACE_SET.has(v)) {
      out[key] = v as SpaceToken;
    } else if (v !== undefined && typeof console !== "undefined") {
      // Visible in dev, harmless in prod — matches the fail-soft posture of
      // `UnregisteredComponentFallback`: degrade, but say so.
      console.warn(`[pulp/style] ignoring unsupported ${key} value:`, v);
    }
  }

  return out;
}

/** Read and parse `props.style` straight from a node's props JSON. */
export function readStyleTokens(propsJson: string): StyleTokens {
  try {
    const parsed: unknown = JSON.parse(propsJson);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parseStyleTokens((parsed as Record<string, unknown>).style);
  } catch {
    return {};
  }
}

/** True when no token is set — lets renderers skip work entirely. */
export function isEmptyStyle(style: StyleTokens): boolean {
  return Object.keys(style).length === 0;
}
