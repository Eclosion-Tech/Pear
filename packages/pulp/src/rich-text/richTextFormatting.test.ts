import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { prosemirrorToYDoc } from "y-prosemirror";
import {
  getSelectionTextAlign,
  headingPropsJson,
  normalizeTextAlign,
  plainTextToYDoc,
  setParagraphTextAlign,
} from "./richTextFormatting";
import { richTextSchema, PROSEMIRROR_FRAGMENT_KEY } from "./richTextSchema";
import { yDocToHtml, yDocToPlainText } from "./yjsToHtml";

describe("normalizeTextAlign", () => {
  it("defaults unknown values to left", () => {
    expect(normalizeTextAlign(undefined)).toBe("left");
    expect(normalizeTextAlign("center")).toBe("center");
    expect(normalizeTextAlign("bogus")).toBe("left");
  });
});

describe("headingPropsJson", () => {
  it("omits left alignment and false collapsed", () => {
    expect(JSON.parse(headingPropsJson(2))).toEqual({ level: 2 });
  });

  it("includes non-default alignment and collapsed", () => {
    expect(JSON.parse(headingPropsJson(1, { textAlign: "right", collapsed: true }))).toEqual({
      level: 1,
      textAlign: "right",
      collapsed: true,
    });
  });
});

describe("plainTextToYDoc", () => {
  it("round-trips through yDocToPlainText", () => {
    const doc = plainTextToYDoc("Section title");
    expect(yDocToPlainText(doc)).toBe("Section title");
  });

  it("renders static html for a single paragraph", () => {
    const html = yDocToHtml(plainTextToYDoc("Hello"));
    expect(html).toContain("Hello");
    expect(html).toMatch(/<p[^>]*>/);
  });
});

describe("setParagraphTextAlign / getSelectionTextAlign", () => {
  it("sets center alignment on selected paragraph", () => {
    const host = document.createElement("div");
    const doc = richTextSchema.node("doc", null, [
      richTextSchema.node("paragraph", null, [richTextSchema.text("Aligned")]),
    ]);
    const state = EditorState.create({ schema: richTextSchema, doc });
    const view = new EditorView(host, { state });

    setParagraphTextAlign(view, "center");

    expect(getSelectionTextAlign(view.state)).toBe("center");
    view.destroy();
  });
});

describe("yDocToHtml alignment", () => {
  it("renders paragraph text-align style", () => {
    const para = richTextSchema.node(
      "paragraph",
      { textAlign: "center" },
      [richTextSchema.text("Centered")],
    );
    const pmDoc = richTextSchema.node("doc", null, [para]);
    const ydoc = prosemirrorToYDoc(pmDoc, PROSEMIRROR_FRAGMENT_KEY);
    const html = yDocToHtml(ydoc);
    expect(html).toContain("text-align:center");
    expect(html).toContain("Centered");
  });
});
