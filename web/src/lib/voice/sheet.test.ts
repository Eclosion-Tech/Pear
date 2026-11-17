import { describe, expect, it } from "vitest";
import { decisionWrites, isCallSheet, readCallSheet, type SheetDefinition, type SheetRow, type SheetValue } from "./sheet";

describe("a call sheet in a Pear database", () => {
  const text = { tag: "Text" };
  const definitions: SheetDefinition[] = [
    { id: 1n, schemaId: 9n, name: "say", propertyType: text },
    { id: 2n, schemaId: 9n, name: "Recommendation", propertyType: text },
    { id: 3n, schemaId: 9n, name: " Detail ", propertyType: text },
    { id: 4n, schemaId: 9n, name: "Source", propertyType: text },
    { id: 5n, schemaId: 9n, name: "Decision", propertyType: text },
    { id: 6n, schemaId: 9n, name: "Quote", propertyType: text },
    { id: 7n, schemaId: 9n, name: "Priority", propertyType: { tag: "Select" } },
  ];
  const rows: SheetRow[] = [
    { id: 20n, title: "Second", sortOrder: 2 },
    { id: 10n, title: "First", sortOrder: 1 },
    { id: 30n, title: "Deleted", sortOrder: 0, deletedAt: {} },
    { id: 40n, title: "Nothing to ask", sortOrder: 3 },
    { id: 50n, title: "  ", sortOrder: 4 },
  ];
  const value = (pageId: bigint, def: bigint, v: string): SheetValue => ({ pageId, propertyDefinitionId: def, value: { tag: "Text", value: v } });
  const values: SheetValue[] = [
    value(10n, 1n, "Is the first thing done?"), value(10n, 2n, "Say yes."), value(10n, 3n, "Background."), value(10n, 4n, "ask 12"),
    value(20n, 1n, "And the second?"), value(20n, 5n, "Parked."), value(20n, 6n, "Later."),
    value(30n, 1n, "Deleted row."), value(50n, 1n, "Untitled row."),
    { pageId: 10n, propertyDefinitionId: 7n, value: { tag: "Select", value: "High" } },
  ];

  it("reads rows in order as items, and existing decisions as already decided", () => {
    const sheet = readCallSheet({ definitions, rows, values });
    expect(sheet.items).toEqual([
      { id: "r10", title: "First", say: "Is the first thing done?", recommendation: "Say yes.", detail: "Background.", source: "ask 12" },
      { id: "r20", title: "Second", say: "And the second?", recommendation: "No recommendation.", detail: "" },
    ]);
    expect(sheet.decisions).toEqual({ r20: { decision: "Parked.", quote: "Later." } });
    expect(sheet.rowIds).toEqual({ r10: 10n, r20: 20n });
  });

  it("is any database with a text column named Say", () => {
    expect(isCallSheet(definitions)).toBe(true);
    expect(isCallSheet(definitions.filter((d) => d.id !== 1n))).toBe(false);
    expect(isCallSheet([{ id: 1n, schemaId: 9n, name: "Say", propertyType: { tag: "Select" } }])).toBe(false);
  });

  it("writes a decision and the caller's words back to the row", () => {
    const sheet = readCallSheet({ definitions, rows, values });
    expect(decisionWrites(sheet, "r10", { decision: "Done.", quote: "Yes it is." })).toEqual([
      { pageId: 10n, propertyDefinitionId: 5n, value: { tag: "Text", value: "Done." } },
      { pageId: 10n, propertyDefinitionId: 6n, value: { tag: "Text", value: "Yes it is." } },
    ]);
    expect(decisionWrites(sheet, "r99", { decision: "Done." })).toEqual([]);
    const noDecisionColumn = readCallSheet({ definitions: definitions.filter((d) => d.id !== 5n), rows, values });
    expect(decisionWrites(noDecisionColumn, "r10", { decision: "Done." })).toEqual([]);
  });
});
