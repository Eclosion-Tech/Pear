import { Plugin } from "prosemirror-state";
import type { SlashMenuItem } from "../SlashMenu";

/**
 * Markdown shortcuts — typing a prefix + space at the start of a block
 * converts the **block's type** (Notion / BlockNote). Unlike ProseMirror's
 * built-in input rules these don't transform the doc: lists and headings are
 * separate `ComponentNode` rows, so a match fires a host turn-into instead.
 *
 *   `- ` / `* `  → BulletListItem
 *   `1. `        → NumberedListItem
 *   `[] ` / `[ ] ` → ChecklistItem
 *   `# ` `## ` `### ` → Heading levels 1-3
 *
 * Quote / code-block / divider are deferred until those block types exist in
 * the registry — add a spec below once they do.
 */

export type MarkdownShortcut = { regex: RegExp; item: SlashMenuItem };

type ShortcutSpec = { regex: RegExp; componentType: string; level?: number };

const SHORTCUT_SPECS: ShortcutSpec[] = [
  { regex: /^[-*]$/, componentType: "BulletListItem" },
  { regex: /^\d+\.$/, componentType: "NumberedListItem" },
  { regex: /^\[\s?\]$/, componentType: "ChecklistItem" },
  { regex: /^#$/, componentType: "Heading", level: 1 },
  { regex: /^##$/, componentType: "Heading", level: 2 },
  { regex: /^###$/, componentType: "Heading", level: 3 },
];

/**
 * Resolve each shortcut spec to a concrete menu item from the available
 * turn-into set, skipping any whose target type isn't registered in this
 * workspace. `items` should be the same curated list used by the slash /
 * turn-into menus (`turnIntoToolbarItems`).
 */
export function buildMarkdownShortcuts(items: SlashMenuItem[]): MarkdownShortcut[] {
  const out: MarkdownShortcut[] = [];
  for (const spec of SHORTCUT_SPECS) {
    const item = items.find(
      (i) =>
        i.componentType === spec.componentType &&
        (spec.level == null || i.defaultProps.level === spec.level),
    );
    if (item) out.push({ regex: spec.regex, item });
  }
  return out;
}

/** First shortcut whose pattern matches the text before the caret, else null. */
export function matchMarkdownShortcut(
  textBefore: string,
  shortcuts: MarkdownShortcut[],
): SlashMenuItem | null {
  for (const shortcut of shortcuts) {
    if (shortcut.regex.test(textBefore)) return shortcut.item;
  }
  return null;
}

/**
 * ProseMirror plugin firing markdown block conversions on space input. The
 * typed prefix is cleared before `onConvert` runs so the converted block
 * starts empty (no `-` / `#` carried into the new block).
 */
export function markdownShortcutPlugin(opts: {
  getShortcuts: () => MarkdownShortcut[];
  onConvert: (item: SlashMenuItem) => void;
  /** Suppress in heading surfaces — typing `- ` in a heading must not re-list it. */
  isDisabled?: () => boolean;
}): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, _to, text) {
        if (text !== " ") return false;
        if (opts.isDisabled?.()) return false;

        const { state } = view;
        if (!state.selection.empty) return false;
        // Single-paragraph block only — never convert a multi-paragraph
        // RichText from its second line.
        if (state.doc.childCount !== 1) return false;

        const blockStart = state.selection.$from.start();
        const before = state.doc.textBetween(blockStart, from);
        const item = matchMarkdownShortcut(before, opts.getShortcuts());
        if (!item) return false;

        view.dispatch(state.tr.delete(blockStart, from));
        opts.onConvert(item);
        return true;
      },
    },
  });
}
