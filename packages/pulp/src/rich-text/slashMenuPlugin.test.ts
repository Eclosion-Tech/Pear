import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { richTextSchema } from "./richTextSchema";
import {
  getSlashSession,
  isSlashBoundary,
  slashMenuPlugin,
  slashPluginKey,
} from "./slashMenuPlugin";
import { filterSlashItems, type SlashMenuItem } from "../SlashMenu";

function stateWith(text: string): EditorState {
  const doc = richTextSchema.node("doc", null, [
    richTextSchema.node(
      "paragraph",
      null,
      text ? [richTextSchema.text(text)] : undefined,
    ),
  ]);
  return EditorState.create({
    schema: richTextSchema,
    doc,
    plugins: [slashMenuPlugin({ onSessionChange: () => {} })],
  });
}

/** Open a session at `from` by inserting "/" with the open meta. */
function openSlash(state: EditorState, from: number): EditorState {
  const tr = state.tr
    .insertText("/", from)
    .setMeta(slashPluginKey, { type: "open", from });
  return state.apply(tr);
}

describe("isSlashBoundary", () => {
  it("is true at the start of a block", () => {
    expect(isSlashBoundary(stateWith(""), 1)).toBe(true);
  });

  it("is true right after whitespace", () => {
    const state = stateWith("hi ");
    expect(isSlashBoundary(state, 4)).toBe(true);
  });

  it("is false in the middle of a word", () => {
    const state = stateWith("hi");
    expect(isSlashBoundary(state, 3)).toBe(false);
  });
});

describe("slash session lifecycle", () => {
  it("opens with an empty query and tracks typed text", () => {
    let state = openSlash(stateWith(""), 1);
    expect(getSlashSession(state)).toEqual({ from: 1, query: "" });

    state = state.apply(state.tr.insertText("head", 2));
    expect(getSlashSession(state)?.query).toBe("head");
  });

  it("closes when the slash character is deleted", () => {
    let state = openSlash(stateWith(""), 1);
    state = state.apply(state.tr.insertText("h", 2));
    state = state.apply(state.tr.delete(1, 2)); // remove the "/"
    expect(getSlashSession(state)).toBeNull();
  });

  it("closes when the caret moves to or before the slash", () => {
    let state = openSlash(stateWith(""), 1);
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );
    expect(getSlashSession(state)).toBeNull();
  });

  it("closes on an explicit close meta", () => {
    let state = openSlash(stateWith(""), 1);
    state = state.apply(state.tr.setMeta(slashPluginKey, { type: "close" }));
    expect(getSlashSession(state)).toBeNull();
  });
});

describe("filterSlashItems", () => {
  const items: SlashMenuItem[] = [
    {
      id: "text",
      label: "Text",
      description: "",
      componentType: "RichText",
      defaultProps: {},
      searchTokens: ["paragraph", "p"],
    },
    {
      id: "h1",
      label: "Heading 1",
      description: "",
      componentType: "Heading",
      defaultProps: { level: 1 },
      searchTokens: ["h1", "title"],
    },
  ];

  it("returns all items for an empty query", () => {
    expect(filterSlashItems(items, "")).toHaveLength(2);
  });

  it("matches on label, case-insensitively", () => {
    expect(filterSlashItems(items, "head").map((i) => i.id)).toEqual(["h1"]);
  });

  it("matches on search tokens", () => {
    expect(filterSlashItems(items, "paragraph").map((i) => i.id)).toEqual([
      "text",
    ]);
  });
});
