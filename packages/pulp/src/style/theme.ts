/**
 * `Theme` — the page/workspace styling layer (PEAR_STYLE_VOCABULARY_ADR, S2).
 *
 * ## Why a second layer exists
 *
 * MySpace was overwhelmingly *whole-profile* theming — a background, a colour
 * scheme, a font — and it felt intensely personal. That is a very high ratio of
 * perceived expressiveness to token count, and therefore to the real budget:
 * two renderer mappings per token, forever. So Theme ships before the
 * fine-grained node tokens grow (D3).
 *
 * ## Theme establishes context; `style` tokens do not
 *
 * The Non-goals forbid a cascade, and that applies to `style` tokens: they
 * affect the node that declares them and nothing else. Theme is deliberately
 * the opposite — establishing page-level context *is* its entire job. The two
 * are different concepts, not one concept with an exception, which is why they
 * are separate types with separate parsers.
 *
 * Mechanically the web renderer leans on CSS's own inheritance (font family,
 * custom properties) rather than re-implementing a cascade, so there is no
 * second resolution system to reason about.
 *
 * ## Storage
 *
 * A page's Theme lives in its root `Container`'s props (D9), so it needs no new
 * column and serializes into `component_tree_v1` for free — meaning it travels
 * on export, fork, and federation with no additional code.
 */

import { parseStyleTokens } from "./tokens";

/**
 * Colour names. Deliberately the same eight already used by database select
 * options (`web/src/lib/formulaEval.ts` `COLOR_KEYS`) — one palette for the
 * workspace, not two that drift. The vocabulary lives here because pulp is
 * platform-agnostic; the light/dark class pairs live in each renderer.
 */
export const TONE_TOKENS = [
  "default", "blue", "green", "yellow", "orange", "red", "purple", "pink",
] as const;
export type ToneToken = (typeof TONE_TOKENS)[number];

/**
 * Named gradients. A closed set rather than user-specified colour stops —
 * "pick from twelve nice gradients" is most of the expressive value of
 * arbitrary gradients with none of the unbounded-value surface (D1).
 */
export const GRADIENT_TOKENS = [
  "dawn", "dusk", "ocean", "forest", "ember", "violet",
] as const;
export type GradientToken = (typeof GRADIENT_TOKENS)[number];

/**
 * Font families.
 *
 * S2 ships only the three that need no bundling decision — they map onto
 * generic families every platform already has. Decorative faces (display,
 * rounded) wait on the open question of *which* faces to bundle; adding them
 * later is purely additive, because stored themes carry names and the mapping
 * is renderer-owned (D2).
 */
export const FONT_TOKENS = ["system", "serif", "mono"] as const;
export type FontToken = (typeof FONT_TOKENS)[number];

export const DENSITY_TOKENS = ["compact", "normal", "comfortable"] as const;
export type DensityToken = (typeof DENSITY_TOKENS)[number];

export const RADIUS_TOKENS = ["none", "sm", "md", "lg", "full"] as const;
export type RadiusToken = (typeof RADIUS_TOKENS)[number];

/** How a background image fills its surface. */
export const FIT_TOKENS = ["cover", "contain", "tile", "center"] as const;
export type FitToken = (typeof FIT_TOKENS)[number];

export type ThemeBackground =
  | { kind: "none" }
  | { kind: "tone"; tone: ToneToken }
  | { kind: "gradient"; gradient: GradientToken }
  | {
      kind: "image";
      /**
       * Object-storage key. Named exactly `storageKey` on purpose (D10): the
       * snapshot exporter walks `component_node.props` recursively collecting
       * keys with this name into `blobManifest.storageKeys`, so a themed page's
       * background travels on export with no new export code. A differently
       * named field would be silently skipped, producing exports that look
       * complete and import without a background.
       */
      storageKey: string;
      /** Reference integrity; the renderer resolves through `storageKey`. */
      attachmentId?: string;
      fit: FitToken;
      /** 0–100, clamped. */
      opacity: number;
    };

export type Theme = {
  /**
   * Mandatory. Themes live in user-owned rows and are forever; evolution
   * happens by version, not mutation — the same discipline the custom-view
   * ADR's `dataSource` uses, for the same reason.
   */
  v: 1;
  background?: ThemeBackground;
  accent?: ToneToken;
  font?: FontToken;
  density?: DensityToken;
  radius?: RadiusToken;
};

const TONE_SET: ReadonlySet<string> = new Set(TONE_TOKENS);
const GRADIENT_SET: ReadonlySet<string> = new Set(GRADIENT_TOKENS);
const FONT_SET: ReadonlySet<string> = new Set(FONT_TOKENS);
const DENSITY_SET: ReadonlySet<string> = new Set(DENSITY_TOKENS);
const RADIUS_SET: ReadonlySet<string> = new Set(RADIUS_TOKENS);
const FIT_SET: ReadonlySet<string> = new Set(FIT_TOKENS);

function pick<T extends string>(
  v: unknown,
  allowed: ReadonlySet<string>,
): T | undefined {
  return typeof v === "string" && allowed.has(v) ? (v as T) : undefined;
}

function parseBackground(raw: unknown): ThemeBackground | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;

  switch (r.kind) {
    case "none":
      return { kind: "none" };
    case "tone": {
      const tone = pick<ToneToken>(r.tone, TONE_SET);
      return tone ? { kind: "tone", tone } : undefined;
    }
    case "gradient": {
      const gradient = pick<GradientToken>(r.gradient, GRADIENT_SET);
      return gradient ? { kind: "gradient", gradient } : undefined;
    }
    case "image": {
      // A storage key is an opaque object id, never a path or URL — the
      // renderer builds the URL, so nothing caller-supplied reaches the DOM.
      if (typeof r.storageKey !== "string" || r.storageKey === "") return undefined;
      if (r.storageKey.includes("/") || r.storageKey.includes(":")) return undefined;
      const fit = pick<FitToken>(r.fit, FIT_SET) ?? "cover";
      const rawOpacity = typeof r.opacity === "number" && Number.isFinite(r.opacity)
        ? r.opacity
        : 100;
      return {
        kind: "image",
        storageKey: r.storageKey,
        ...(typeof r.attachmentId === "string" ? { attachmentId: r.attachmentId } : {}),
        fit,
        opacity: Math.min(100, Math.max(0, Math.round(rawOpacity))),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Parse a `theme` value, dropping anything outside the closed sets.
 *
 * Same enforcement posture as `parseStyleTokens` (D5): prop schemas are
 * client-validated only, so this allowlist — not the schema — is what actually
 * keeps the vocabulary closed. Returns `null` when there is no usable theme, so
 * callers can skip work entirely.
 */
export function parseTheme(raw: unknown): Theme | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) {
    if (r.v !== undefined && typeof console !== "undefined") {
      console.warn(`[pulp/style] ignoring theme with unsupported version:`, r.v);
    }
    return null;
  }

  const theme: Theme = { v: 1 };
  const background = parseBackground(r.background);
  if (background) theme.background = background;

  const accent = pick<ToneToken>(r.accent, TONE_SET);
  if (accent) theme.accent = accent;
  const font = pick<FontToken>(r.font, FONT_SET);
  if (font) theme.font = font;
  const density = pick<DensityToken>(r.density, DENSITY_SET);
  if (density) theme.density = density;
  const radius = pick<RadiusToken>(r.radius, RADIUS_SET);
  if (radius) theme.radius = radius;

  return theme;
}

/** Read and parse `props.theme` from a node's props JSON. */
export function readTheme(propsJson: string): Theme | null {
  try {
    const parsed: unknown = JSON.parse(propsJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parseTheme((parsed as Record<string, unknown>).theme);
  } catch {
    return null;
  }
}

/**
 * Resolve a page Theme against a workspace Theme (D9).
 *
 * Page wins key-by-key, so a page can override the accent while inheriting the
 * workspace font. Order is node `style` → page → workspace → default; this
 * covers the two Theme levels, and `style` tokens are applied separately by
 * the component that declares them.
 */
export function resolveTheme(page: Theme | null, workspace: Theme | null): Theme | null {
  if (!page) return workspace;
  if (!workspace) return page;
  return { ...workspace, ...page, v: 1 };
}

/** Re-exported so callers can treat both halves of `style_v1` as one import. */
export { parseStyleTokens };
