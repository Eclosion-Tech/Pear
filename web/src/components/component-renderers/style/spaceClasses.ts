/**
 * Web renderer mapping for `style_v1` tokens (PEAR_STYLE_VOCABULARY_ADR, D4).
 *
 * **This is the only place Tailwind is allowed to appear for styling.** The
 * document stores names (`indent: "md"`); this file turns them into classes.
 * Class strings never travel the other way into stored props, for three
 * reasons the ADR records: Tailwind's JIT only scans source files, so a class
 * living in a database row is never generated (and fails *silently and
 * inconsistently*, working only when some unrelated file happens to use the
 * same class); `pl-4` is meaningless to the RN renderer, which policy requires
 * every v1 component to have; and a class is a value, so it could never be
 * re-skinned or themed.
 *
 * Every entry below is a **static literal**, which is precisely why the JIT
 * emits them — the same reason `OPTION_CHIP_CLASSES` works today. Never
 * construct these by interpolation.
 *
 * The steps are Tailwind's own 4px scale, which the codebase already used
 * implicitly (`Container.gap: n × 0.25rem`). Borrowing the scale is deliberate;
 * borrowing the storage format is what we refuse.
 */

import type { SpaceToken, StyleTokens } from "@eclosion-tech/pulp";

const PADDING: Record<SpaceToken, string> = {
  none: "p-0", xs: "p-1", sm: "p-2", md: "p-4", lg: "p-8", xl: "p-12",
};

const PADDING_X: Record<SpaceToken, string> = {
  none: "px-0", xs: "px-1", sm: "px-2", md: "px-4", lg: "px-8", xl: "px-12",
};

const PADDING_Y: Record<SpaceToken, string> = {
  none: "py-0", xs: "py-1", sm: "py-2", md: "py-4", lg: "py-8", xl: "py-12",
};

const GAP: Record<SpaceToken, string> = {
  none: "gap-0", xs: "gap-1", sm: "gap-2", md: "gap-4", lg: "gap-8", xl: "gap-12",
};

/**
 * Leading-edge inset. Logical (`ps-`) rather than physical (`pl-`) so RTL
 * workspaces indent from the correct side without a second token.
 */
const INDENT: Record<SpaceToken, string> = {
  none: "ps-0", xs: "ps-1", sm: "ps-2", md: "ps-4", lg: "ps-8", xl: "ps-12",
};

/**
 * Compose the class string for a node's style tokens.
 *
 * Returns "" when nothing is set, so callers can concatenate unconditionally
 * without emitting stray whitespace-only classes.
 */
export function styleClasses(style: StyleTokens): string {
  const out: string[] = [];
  if (style.padding) out.push(PADDING[style.padding]);
  if (style.paddingX) out.push(PADDING_X[style.paddingX]);
  if (style.paddingY) out.push(PADDING_Y[style.paddingY]);
  if (style.gap) out.push(GAP[style.gap]);
  if (style.indent) out.push(INDENT[style.indent]);
  return out.join(" ");
}
