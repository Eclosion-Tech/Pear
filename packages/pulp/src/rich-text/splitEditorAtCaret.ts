import { splitBlock } from "prosemirror-commands";
import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import { PROSEMIRROR_FRAGMENT_KEY } from "./richTextSchema";

/**
 * Split the editor doc at the collapsed caret and return the **suffix** as a
 * standalone Y.Doc (marks intact), truncating this view's doc to the prefix.
 * The suffix Y.Doc is meant to seed a new sibling/child block via the focus
 * coordinator's `initialDoc` handoff. At-end is the degenerate case where the
 * returned doc is an empty paragraph.
 *
 * Shared by `RichText` (split into a sibling) and `Heading` (split the title
 * into a body RichText). Returns null when `splitBlock` can't apply or the
 * computed boundary is out of range — callers fall through to default Enter.
 *
 * **Position math.** `splitBlock` inserts a paragraph break at the caret;
 * afterwards the caret sits at the start of the new paragraph's content, doc
 * position `boundary + 1`. We capture `boundary` (the new paragraph's opening
 * tag), `cut` from there to end for the suffix, and `delete` the same range to
 * truncate. Both transforms run on the post-`splitBlock` state.
 */
export function splitEditorAtCaret(view: EditorView): Y.Doc | null {
  const splitWorked = splitBlock(view.state, view.dispatch);
  if (!splitWorked) return null;

  const afterState = view.state;
  const boundary = afterState.selection.from - 1;
  const docEnd = afterState.doc.content.size;
  if (boundary < 0 || boundary > docEnd) return null;

  const suffixDoc = afterState.doc.cut(boundary, docEnd);
  const initialDoc = prosemirrorToYDoc(suffixDoc, PROSEMIRROR_FRAGMENT_KEY);
  view.dispatch(afterState.tr.delete(boundary, docEnd));
  return initialDoc;
}
