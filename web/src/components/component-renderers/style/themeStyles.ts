/**
 * Web renderer mapping for `Theme` (PEAR_STYLE_VOCABULARY_ADR, S2).
 *
 * Like `spaceClasses.ts`, this is one of the only places Tailwind is permitted
 * to appear for styling, and every class is a **static literal** so the JIT
 * emits it. Nothing here ever travels back into stored props.
 *
 * Because mappings are renderer-owned (D2), everything in this file can be
 * retuned — or wholly re-skinned by a host — without touching a single stored
 * theme. That is the practical payoff of storing names instead of values, and
 * it is what makes the provisional choices below safe to make now.
 */

import type {
  DensityToken,
  FitToken,
  FontToken,
  GradientToken,
  RadiusToken,
  Theme,
  ToneToken,
} from "@eclosion-tech/pulp";
import { workspaceBlobSrc } from "@/src/lib/blobUpload";

/**
 * Tone → surface **and** foreground, light **and** dark, in one entry (D11).
 *
 * Pairing is the mechanism that makes contrast unbreakable: because callers
 * cannot set foreground and background independently, an illegible combination
 * is not expressible rather than merely discouraged. Mirrors the shape already
 * proven by `OPTION_CHIP_CLASSES` in `formulaEval.ts`.
 */
const TONE_SURFACE: Record<ToneToken, string> = {
  default: "bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100",
  blue:    "bg-blue-50 dark:bg-blue-950 text-blue-950 dark:text-blue-50",
  green:   "bg-green-50 dark:bg-green-950 text-green-950 dark:text-green-50",
  yellow:  "bg-yellow-50 dark:bg-yellow-950 text-yellow-950 dark:text-yellow-50",
  orange:  "bg-orange-50 dark:bg-orange-950 text-orange-950 dark:text-orange-50",
  red:     "bg-red-50 dark:bg-red-950 text-red-950 dark:text-red-50",
  purple:  "bg-purple-50 dark:bg-purple-950 text-purple-950 dark:text-purple-50",
  pink:    "bg-pink-50 dark:bg-pink-950 text-pink-950 dark:text-pink-50",
};

/** Named gradients — the closed set that replaces arbitrary colour stops. */
const GRADIENT: Record<GradientToken, string> = {
  dawn:   "bg-gradient-to-br from-rose-100 via-orange-50 to-amber-100 dark:from-rose-950 dark:via-orange-950 dark:to-amber-900",
  dusk:   "bg-gradient-to-br from-indigo-200 via-purple-100 to-rose-100 dark:from-indigo-950 dark:via-purple-950 dark:to-rose-950",
  ocean:  "bg-gradient-to-br from-cyan-100 via-sky-100 to-blue-200 dark:from-cyan-950 dark:via-sky-950 dark:to-blue-900",
  forest: "bg-gradient-to-br from-emerald-100 via-green-50 to-lime-100 dark:from-emerald-950 dark:via-green-950 dark:to-lime-900",
  ember:  "bg-gradient-to-br from-amber-200 via-orange-200 to-red-200 dark:from-amber-950 dark:via-orange-950 dark:to-red-950",
  violet: "bg-gradient-to-br from-violet-200 via-fuchsia-100 to-pink-100 dark:from-violet-950 dark:via-fuchsia-950 dark:to-pink-950",
};

/**
 * Generic families only in S2 — no bundled files, so no font-selection decision
 * is baked in yet. Adding display/rounded later is purely additive.
 */
const FONT: Record<FontToken, string> = {
  system: "font-sans",
  serif: "font-serif",
  mono: "font-mono",
};

/**
 * Provisional: the ADR leaves density semantics open (scale the space tokens
 * globally, versus select an alternate mapping table). This implements the
 * simpler second option — a base type scale — precisely because it is
 * reversible: the mapping is renderer-owned, so switching approaches later
 * rewrites this file and nothing stored.
 */
const DENSITY: Record<DensityToken, string> = {
  compact: "text-sm leading-snug",
  normal: "text-base leading-normal",
  comfortable: "text-lg leading-relaxed",
};

const RADIUS: Record<RadiusToken, string> = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-3xl",
};

/**
 * Accent as a CSS custom property pair, so descendants can opt in without a
 * React context and without a cascade of our own — CSS already inherits.
 * A pair, not a single hue, so D11 holds for anything painting on the accent.
 */
const ACCENT_VARS: Record<ToneToken, { accent: string; on: string }> = {
  default: { accent: "#525252", on: "#ffffff" },
  blue:    { accent: "#2563eb", on: "#ffffff" },
  green:   { accent: "#16a34a", on: "#ffffff" },
  yellow:  { accent: "#ca8a04", on: "#1c1917" },
  orange:  { accent: "#ea580c", on: "#ffffff" },
  red:     { accent: "#dc2626", on: "#ffffff" },
  purple:  { accent: "#9333ea", on: "#ffffff" },
  pink:    { accent: "#db2777", on: "#ffffff" },
};

const OBJECT_FIT: Record<FitToken, React.CSSProperties> = {
  cover: { backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
  contain: { backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
  tile: { backgroundRepeat: "repeat" },
  center: { backgroundSize: "auto", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
};

/** Tailwind classes a theme contributes to its surface. */
export function themeClasses(theme: Theme | null): string {
  if (!theme) return "";
  const out: string[] = [];

  if (theme.background?.kind === "tone") out.push(TONE_SURFACE[theme.background.tone]);
  if (theme.background?.kind === "gradient") out.push(GRADIENT[theme.background.gradient]);
  if (theme.font) out.push(FONT[theme.font]);
  if (theme.density) out.push(DENSITY[theme.density]);
  if (theme.radius) out.push(RADIUS[theme.radius]);

  return out.join(" ");
}

/**
 * Inline style a theme contributes — accent custom properties, plus the
 * background image when there is one.
 *
 * `slug` is needed only for image backgrounds; the URL is built by
 * `workspaceBlobSrc` from an opaque object id, so no caller-supplied string
 * ever becomes a URL. `workspaceBlobSrc` returns "" for unresolvable keys, and
 * a missing blob simply yields no background rather than a broken page (D10).
 */
export function themeStyle(theme: Theme | null, slug: string): React.CSSProperties {
  if (!theme) return {};
  const style: React.CSSProperties = {};

  if (theme.accent) {
    const vars = ACCENT_VARS[theme.accent];
    (style as Record<string, string>)["--pear-accent"] = vars.accent;
    (style as Record<string, string>)["--pear-accent-on"] = vars.on;
  }

  const bg = theme.background;
  if (bg?.kind === "image") {
    const src = workspaceBlobSrc(slug, bg.storageKey);
    if (src) {
      Object.assign(style, OBJECT_FIT[bg.fit]);
      style.backgroundImage = `url(${JSON.stringify(src)})`;
      if (bg.opacity < 100) style.opacity = bg.opacity / 100;
    }
  }

  return style;
}
