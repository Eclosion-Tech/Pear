import { describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { richTextSchema } from "../rich-text/richTextSchema";
import {
  handleRichTextArrowDown,
  handleRichTextArrowUp,
  handleRichTextBackspace,
  handleRichTextEnter,
  handleRichTextShiftTab,
  handleRichTextTab,
  inlineMarksDisabled,
} from "../rich-text/richTextKeymap";
import { mockEditorView } from "../test/fixtures";

function docState(text: string, cursorAt: "start" | "end" = "end") {
  const doc = richTextSchema.node("doc", null, [
    richTextSchema.node(
      "paragraph",
      null,
      text ? [richTextSchema.text(text)] : undefined,
    ),
  ]);
  const pos = cursorAt === "start" ? 1 : doc.content.size - 1;
  return EditorState.create({
    schema: richTextSchema,
    doc,
    selection: TextSelection.create(doc, pos),
  });
}

describe("handleRichTextEnter", () => {
  it("calls onSplit for collapsed caret at end", () => {
    const onSplit = vi.fn(() => true);
    const state = docState("Hello", "end");
    const view = mockEditorView(state);

    expect(handleRichTextEnter(state, view, { onSplit })).toBe(true);
    expect(onSplit).toHaveBeenCalledWith(view);
  });

  it("ignores non-empty selections", () => {
    const state = docState("Hello");
    const from = 1;
    const to = 4;
    const selected = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, from, to)),
    );
    const onSplit = vi.fn();

    expect(handleRichTextEnter(selected, mockEditorView(selected), { onSplit })).toBe(
      false,
    );
    expect(onSplit).not.toHaveBeenCalled();
  });
});

describe("handleRichTextBackspace", () => {
  it("deletes empty block at doc start", () => {
    const onDeleteSelf = vi.fn();
    const state = docState("", "start");

    expect(
      handleRichTextBackspace(state, mockEditorView(state), { onDeleteSelf }),
    ).toBe(true);
    expect(onDeleteSelf).toHaveBeenCalledOnce();
  });

  it("merges non-empty block at doc start", () => {
    const onMergeWithPrev = vi.fn(() => true);
    const state = docState("Join me", "start");
    const view = mockEditorView(state);

    expect(
      handleRichTextBackspace(state, view, { onMergeWithPrev }),
    ).toBe(true);
    expect(onMergeWithPrev).toHaveBeenCalledWith(view);
  });

  it("does nothing mid-paragraph", () => {
    const onMergeWithPrev = vi.fn();
    const state = docState("Hello", "end");

    expect(
      handleRichTextBackspace(state, mockEditorView(state), { onMergeWithPrev }),
    ).toBe(false);
  });
});

describe("handleRichTextArrowUp / ArrowDown", () => {
  it("navigates at doc boundaries only", () => {
    const onNavigatePrev = vi.fn(() => true);
    const onNavigateNext = vi.fn(() => true);
    const start = docState("Hi", "start");
    const end = docState("Hi", "end");

    expect(handleRichTextArrowUp(start, { onNavigatePrev })).toBe(true);
    expect(handleRichTextArrowDown(end, { onNavigateNext })).toBe(true);
    expect(handleRichTextArrowUp(end, { onNavigatePrev })).toBe(false);
    expect(handleRichTextArrowDown(start, { onNavigateNext })).toBe(false);
  });
});

describe("handleRichTextTab", () => {
  it("delegates indent/outdent handlers", () => {
    const onIndent = vi.fn(() => true);
    const onOutdent = vi.fn(() => true);
    expect(handleRichTextTab({ onIndent })).toBe(true);
    expect(handleRichTextShiftTab({ onOutdent })).toBe(true);
  });
});

describe("inlineMarksDisabled", () => {
  it("is true for heading surface mode", () => {
    expect(inlineMarksDisabled({ kind: "heading", level: 1 })).toBe(true);
    expect(inlineMarksDisabled({ kind: "body" })).toBe(false);
  });
});
