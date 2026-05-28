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
  it("navigates at doc boundaries only (position fallback without a live view)", () => {
    const onNavigatePrev = vi.fn(() => true);
    const onNavigateNext = vi.fn(() => true);
    const start = docState("Hi", "start");
    const end = docState("Hi", "end");

    expect(
      handleRichTextArrowUp(start, mockEditorView(start), { onNavigatePrev }),
    ).toBe(true);
    expect(
      handleRichTextArrowDown(end, mockEditorView(end), { onNavigateNext }),
    ).toBe(true);
    expect(
      handleRichTextArrowUp(end, mockEditorView(end), { onNavigatePrev }),
    ).toBe(false);
    expect(
      handleRichTextArrowDown(start, mockEditorView(start), { onNavigateNext }),
    ).toBe(false);
  });

  it("uses endOfTextblock for visual-line detection when a live view supports it", () => {
    const onNavigatePrev = vi.fn(() => true);
    // Caret at doc end, but endOfTextblock("up") reports first visual line.
    const end = docState("multi line wrapped", "end");
    const view = {
      ...mockEditorView(end),
      endOfTextblock: (dir: string) => dir === "up",
      coordsAtPos: () => ({ left: 42, top: 0, bottom: 10, right: 42 }),
    } as unknown as Parameters<typeof handleRichTextArrowUp>[1];

    expect(handleRichTextArrowUp(end, view, { onNavigatePrev })).toBe(true);
    expect(onNavigatePrev).toHaveBeenCalledWith(42);
  });
});

describe("handleRichTextTab", () => {
  it("always delegates indent/outdent regardless of caret position", () => {
    const onIndent = vi.fn(() => false);
    const onOutdent = vi.fn(() => false);
    const mid = docState("Hello", "end");

    expect(handleRichTextTab({ onIndent })).toBe(true);
    expect(handleRichTextShiftTab({ onOutdent })).toBe(true);
    expect(onIndent).toHaveBeenCalledOnce();
    expect(onOutdent).toHaveBeenCalledOnce();

    // Still consumes Tab even when nest/unnest is a no-op (prevents focus escape).
    expect(handleRichTextTab({ onIndent: () => false })).toBe(true);
    expect(handleRichTextTab({})).toBe(false);
    expect(handleRichTextEnter(mid, mockEditorView(mid), {})).toBe(false);
  });
});

describe("inlineMarksDisabled", () => {
  it("is true for heading surface mode", () => {
    expect(inlineMarksDisabled({ kind: "heading", level: 1 })).toBe(true);
    expect(inlineMarksDisabled({ kind: "body" })).toBe(false);
  });
});
