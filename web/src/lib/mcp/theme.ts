/**
 * `set_page_theme` — the agent authoring path for page themes
 * (PEAR_STYLE_VOCABULARY_ADR, S5).
 *
 * `PEAR_EXPRESSIVE_SURFACES.md` § 16 makes the AI a UI author, not just a text
 * author, "through the same reducers humans use". That is literally what
 * happens here: this writes the theme onto the page's root `Container` props
 * via `update_component_props`, the same reducer the editor calls, so page
 * write-access and every other guard apply unchanged.
 *
 * ## Why the write path validates too
 *
 * D5 puts enforcement in the renderer, because prop schemas are advisory and
 * the renderer is the last line. That stays true. Validating here as well is
 * not redundant: it stops malformed themes being *stored* (where they would sit
 * in exports and forks forever), and it lets an agent see a real error instead
 * of a silent no-op — the difference between "your theme was rejected, here are
 * the valid tones" and a page that just never changes.
 */

import { parseTheme, type Theme } from "@eclosion-tech/pulp";
import type { StdbTransport } from "../api-endpoint";
import { selectSurfaceNodes } from "./component-tree";
import { encodeU64 } from "./encode";

export type SetPageThemeResult =
  | { ok: true; page_id: number; theme: Theme | null; root_component_id: number }
  | { ok: false; error: string };

function reducerErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Merge `theme` into the root container's props.
 *
 * Merge rather than replace, because the root container also carries `layout`
 * and may carry `style` tokens; a wholesale overwrite would silently drop them.
 */
export async function setPageTheme(
  transport: StdbTransport,
  pageId: number,
  rawTheme: unknown,
): Promise<SetPageThemeResult> {
  const nodes = await selectSurfaceNodes(transport, pageId);
  const root = nodes.find((n) => n.parentId === null && !n.deleted);
  if (!root) {
    return {
      ok: false,
      error:
        "Page has no component tree root — only ComponentTree pages can carry a theme.",
    };
  }

  // `null` clears the theme; anything else must survive the allowlist.
  let theme: Theme | null = null;
  if (rawTheme !== null && rawTheme !== undefined) {
    theme = parseTheme(rawTheme);
    if (!theme) {
      return {
        ok: false,
        error:
          "Invalid theme. Requires { v: 1 } plus optional accent/font/density/radius/background " +
          "drawn from the documented token sets. Values outside those sets are refused rather " +
          "than stored.",
      };
    }
  }

  let props: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(root.props || "{}");
    props = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    props = {};
  }

  if (theme) props.theme = theme;
  else delete props.theme;

  try {
    await transport.call("update_component_props", [
      encodeU64(root.id),
      JSON.stringify(props),
    ]);
  } catch (err) {
    return { ok: false, error: reducerErrorMessage(err) };
  }

  return { ok: true, page_id: pageId, theme, root_component_id: root.id };
}

/** Read the theme currently stored on a page, if any. */
export async function getPageTheme(
  transport: StdbTransport,
  pageId: number,
): Promise<Theme | null> {
  const nodes = await selectSurfaceNodes(transport, pageId);
  const root = nodes.find((n) => n.parentId === null && !n.deleted);
  if (!root) return null;
  try {
    const parsed: unknown = JSON.parse(root.props || "{}");
    if (typeof parsed !== "object" || parsed === null) return null;
    return parseTheme((parsed as Record<string, unknown>).theme);
  } catch {
    return null;
  }
}
