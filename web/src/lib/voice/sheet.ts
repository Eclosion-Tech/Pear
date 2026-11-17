import type { CallDecision, CallItem } from "@eclosion-tech/chat-voice";

/**
 * A call sheet is an ordinary Pear database. Each row is one thing to raise:
 * the row's title is the item, and text columns carry what to ask, the
 * recommendation and the background. Answers are written back to the row
 * during the call, so the sheet is also the record of it.
 *
 * Any database with a text column named "Say" is a call sheet. The other
 * columns are optional and matched by name, ignoring case.
 */

export const SHEET_COLUMNS = {
  say: "Say",
  recommendation: "Recommendation",
  detail: "Detail",
  source: "Source",
  decision: "Decision",
  quote: "Quote",
} as const;

export type SheetColumn = keyof typeof SHEET_COLUMNS;

/** The parts of a property definition this module reads. */
export interface SheetDefinition {
  id: bigint;
  schemaId: bigint;
  name: string;
  propertyType: { tag: string };
}

/** The parts of a row page this module reads. */
export interface SheetRow {
  id: bigint;
  title: string;
  sortOrder: number;
  deletedAt?: unknown;
}

/** The parts of a property value this module reads. */
export interface SheetValue {
  pageId: bigint;
  propertyDefinitionId: bigint;
  value: { tag: string; value?: unknown };
}

export interface CallSheet {
  items: CallItem[];
  /** Items that already carry a decision, by item id. A call can be resumed. */
  decisions: Record<string, CallDecision>;
  /** The row behind each item, by item id. */
  rowIds: Record<string, bigint>;
  /** The columns found, by role. `decision` is where answers are written. */
  columns: Partial<Record<SheetColumn, bigint>>;
}

/** The sheet's columns by role. Only text columns count. */
export function sheetColumns(definitions: readonly SheetDefinition[]): Partial<Record<SheetColumn, bigint>> {
  const columns: Partial<Record<SheetColumn, bigint>> = {};
  for (const role of Object.keys(SHEET_COLUMNS) as SheetColumn[]) {
    const wanted = SHEET_COLUMNS[role].toLowerCase();
    const found = definitions.find((d) => d.propertyType.tag === "Text" && d.name.trim().toLowerCase() === wanted);
    if (found) columns[role] = found.id;
  }
  return columns;
}

/** True when a database's columns make it a call sheet. */
export function isCallSheet(definitions: readonly SheetDefinition[]): boolean {
  return sheetColumns(definitions).say !== undefined;
}

/**
 * Builds the call from a database's rows. Rows keep the database's order.
 * A row with no title or nothing to say is skipped: there is nothing to ask.
 */
export function readCallSheet(args: {
  definitions: readonly SheetDefinition[];
  rows: readonly SheetRow[];
  values: readonly SheetValue[];
}): CallSheet {
  const columns = sheetColumns(args.definitions);
  const text = new Map<string, string>();
  for (const v of args.values) {
    if (v.value.tag === "Text" && typeof v.value.value === "string") text.set(`${v.pageId}:${v.propertyDefinitionId}`, v.value.value);
  }
  const cell = (row: SheetRow, role: SheetColumn): string => {
    const column = columns[role];
    return column === undefined ? "" : (text.get(`${row.id}:${column}`) ?? "").trim();
  };

  const sheet: CallSheet = { items: [], decisions: {}, rowIds: {}, columns };
  const rows = args.rows.filter((row) => row.deletedAt == null).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));
  for (const row of rows) {
    const title = row.title.trim();
    const say = cell(row, "say");
    if (!title || !say) continue;
    const id = `r${row.id}`;
    const source = cell(row, "source");
    sheet.items.push({ id, title, say, recommendation: cell(row, "recommendation") || "No recommendation.", detail: cell(row, "detail"), ...(source ? { source } : {}) });
    sheet.rowIds[id] = row.id;
    const decision = cell(row, "decision");
    if (decision) {
      const quote = cell(row, "quote");
      sheet.decisions[id] = { decision, ...(quote ? { quote } : {}) };
    }
  }
  return sheet;
}

/** The property writes that record one decision on its row. Empty when the sheet has no Decision column. */
export function decisionWrites(sheet: CallSheet, itemId: string, decision: CallDecision): Array<{ pageId: bigint; propertyDefinitionId: bigint; value: { tag: "Text"; value: string } }> {
  const pageId = sheet.rowIds[itemId];
  if (pageId === undefined || sheet.columns.decision === undefined) return [];
  const writes = [{ pageId, propertyDefinitionId: sheet.columns.decision, value: { tag: "Text" as const, value: decision.decision } }];
  if (sheet.columns.quote !== undefined && decision.quote) {
    writes.push({ pageId, propertyDefinitionId: sheet.columns.quote, value: { tag: "Text" as const, value: decision.quote } });
  }
  return writes;
}
