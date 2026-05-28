import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Inline slash menu — Notion / BlockNote style. Typing `/` at a word boundary
 * opens a session; the `/` and everything typed after it live in the document
 * and form the live filter query. The menu UI (`<InlineSlashMenu>`) is driven
 * by `onSessionChange`; arrow / enter / escape are claimed by the editor
 * keymap while a session is active.
 *
 * The session auto-closes when: the `/` is deleted, the caret moves before it,
 * the selection becomes non-empty, or a space is typed with an empty query
 * (`"/ "` is not a command). The caller closes it explicitly on commit/dismiss
 * via {@link closeSlashSession}.
 */

type SlashState = { active: boolean; from: number };

export type SlashSession = { from: number; query: string };

export const slashPluginKey = new PluginKey<SlashState>("pulpSlashMenu");

/** Active session derived from the live state, or null when inactive. */
export function getSlashSession(state: EditorState): SlashSession | null {
  const s = slashPluginKey.getState(state);
  if (!s || !s.active) return null;
  if (!state.selection.empty) return null;
  const head = state.selection.head;
  if (head < s.from + 1) return null;
  const query = state.doc.textBetween(s.from + 1, head, "\n", "");
  return { from: s.from, query };
}

/** True when `pos` sits at block start or just after whitespace. */
export function isSlashBoundary(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if ($pos.parentOffset === 0) return true;
  const before = state.doc.textBetween(pos - 1, pos, "\n", "");
  return before === "" || /\s/.test(before);
}

/** Explicitly end the active session (commit / dismiss). */
export function closeSlashSession(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(slashPluginKey, { type: "close" }));
}

export function slashMenuPlugin(opts: {
  onSessionChange: (session: (SlashSession & { view: EditorView }) | null) => void;
  /** Suppress in heading surfaces — headings don't host slash inserts. */
  isDisabled?: () => boolean;
}): Plugin<SlashState> {
  return new Plugin<SlashState>({
    key: slashPluginKey,
    state: {
      init: () => ({ active: false, from: -1 }),
      apply(tr, value, _oldState, newState) {
        const meta = tr.getMeta(slashPluginKey) as
          | { type: "open"; from: number }
          | { type: "close" }
          | undefined;
        if (meta?.type === "open") return { active: true, from: meta.from };
        if (meta?.type === "close") return { active: false, from: -1 };
        if (!value.active) return value;

        const from = tr.mapping.map(value.from, -1);
        const slashChar = newState.doc.textBetween(from, from + 1, "\n", "");
        if (slashChar !== "/") return { active: false, from: -1 };
        if (!newState.selection.empty || newState.selection.head < from + 1) {
          return { active: false, from: -1 };
        }
        return { active: true, from };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        const current = slashPluginKey.getState(view.state);
        // "/ " (space with an empty query) is not a command — close, let the
        // space type normally.
        if (text === " " && current?.active) {
          const session = getSlashSession(view.state);
          if (session && session.query.length === 0) {
            view.dispatch(
              view.state.tr.setMeta(slashPluginKey, { type: "close" }),
            );
          }
          return false;
        }
        if (text !== "/") return false;
        if (opts.isDisabled?.()) return false;
        if (!view.state.selection.empty) return false;
        if (!isSlashBoundary(view.state, from)) return false;

        const tr = view.state.tr.insertText("/", from, to);
        tr.setMeta(slashPluginKey, { type: "open", from });
        view.dispatch(tr);
        return true;
      },
    },
    view() {
      let last: SlashSession | null = null;
      return {
        update: (view) => {
          const session = getSlashSession(view.state);
          const changed =
            (session?.from ?? -1) !== (last?.from ?? -1) ||
            (session?.query ?? null) !== (last?.query ?? null);
          if (!changed) return;
          last = session;
          opts.onSessionChange(session ? { ...session, view } : null);
        },
        destroy: () => {
          if (last) opts.onSessionChange(null);
        },
      };
    },
  });
}
