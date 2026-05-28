import { describe, expect, it } from "vitest";
import {
  buildMarkdownShortcuts,
  matchMarkdownShortcut,
} from "./markdownInputRules";
import type { SlashMenuItem } from "../SlashMenu";

function item(
  componentType: string,
  defaultProps: Record<string, unknown> = {},
): SlashMenuItem {
  return {
    id: `${componentType}:${JSON.stringify(defaultProps)}`,
    label: componentType,
    description: "",
    componentType,
    defaultProps,
    searchTokens: [],
  };
}

const FULL_ITEMS: SlashMenuItem[] = [
  item("RichText"),
  item("Heading", { level: 1 }),
  item("Heading", { level: 2 }),
  item("Heading", { level: 3 }),
  item("BulletListItem"),
  item("NumberedListItem"),
  item("ChecklistItem", { checked: false }),
];

describe("buildMarkdownShortcuts", () => {
  it("resolves a shortcut for each registered target type", () => {
    const shortcuts = buildMarkdownShortcuts(FULL_ITEMS);
    const types = shortcuts.map((s) => s.item.componentType);
    expect(types).toContain("BulletListItem");
    expect(types).toContain("NumberedListItem");
    expect(types).toContain("ChecklistItem");
    expect(types.filter((t) => t === "Heading")).toHaveLength(3);
  });

  it("skips shortcuts whose target type is not registered", () => {
    // Only headings available — no list types in the curated set.
    const headingOnly = FULL_ITEMS.filter((i) => i.componentType !== "BulletListItem" &&
      i.componentType !== "NumberedListItem" &&
      i.componentType !== "ChecklistItem");
    const shortcuts = buildMarkdownShortcuts(headingOnly);
    const types = shortcuts.map((s) => s.item.componentType);
    expect(types).not.toContain("BulletListItem");
    expect(types.filter((t) => t === "Heading")).toHaveLength(3);
  });
});

describe("matchMarkdownShortcut", () => {
  const shortcuts = buildMarkdownShortcuts(FULL_ITEMS);

  const cases: Array<[string, string | null, number | undefined]> = [
    ["-", "BulletListItem", undefined],
    ["*", "BulletListItem", undefined],
    ["1.", "NumberedListItem", undefined],
    ["42.", "NumberedListItem", undefined],
    ["[]", "ChecklistItem", undefined],
    ["[ ]", "ChecklistItem", undefined],
    ["#", "Heading", 1],
    ["##", "Heading", 2],
    ["###", "Heading", 3],
    ["####", null, undefined],
    ["foo", null, undefined],
    ["", null, undefined],
    ["- ", null, undefined], // trailing space means it was already consumed
  ];

  it.each(cases)("matches %j → %s", (input, type, level) => {
    const match = matchMarkdownShortcut(input, shortcuts);
    expect(match?.componentType ?? null).toBe(type);
    if (level != null) expect(match?.defaultProps.level).toBe(level);
  });
});
