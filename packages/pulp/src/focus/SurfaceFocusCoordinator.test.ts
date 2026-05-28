import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { SurfaceFocusCoordinator } from "./SurfaceFocusCoordinator";
import { plainTextToYDoc } from "../rich-text/richTextFormatting";
import { yDocToPlainText } from "../rich-text/yjsToHtml";
import type { BlockInsertEvent } from "../types";

const SURFACE = 1n;

function row(id: bigint, parentId: bigint): BlockInsertEvent {
  return { id, surfaceId: SURFACE, parentId };
}

describe("SurfaceFocusCoordinator — batch insert (paste)", () => {
  it("stashes each block's doc against the resolved row and focuses only the last", () => {
    const coord = new SurfaceFocusCoordinator();
    const api = coord.getApi();

    const focusedIds: bigint[] = [];
    // Register focusables so focusTarget can invoke them.
    api.registerFocusable(101n, () => focusedIds.push(101n));
    api.registerFocusable(102n, () => focusedIds.push(102n));
    api.registerFocusable(103n, () => focusedIds.push(103n));

    // Document order D1,D2,D3 → focus D3. insertBlocksAfter arms in REVERSE
    // (arrival order): D3, D2, D1. Only the D3 entry (head) claims focus.
    api.armForInsertBatch([
      { parentId: 1n, initialDoc: plainTextToYDoc("D3"), shouldFocus: true, focusAt: "end" },
      { parentId: 1n, initialDoc: plainTextToYDoc("D2") },
      { parentId: 1n, initialDoc: plainTextToYDoc("D1") },
    ]);

    const saveYjs = vi.fn();
    // Rows arrive in insertion order: D3 (id 103), D2 (102), D1 (101).
    coord.handleNodeInsert(row(103n, 1n), SURFACE, saveYjs);
    coord.handleNodeInsert(row(102n, 1n), SURFACE, saveYjs);
    coord.handleNodeInsert(row(101n, 1n), SURFACE, saveYjs);

    // Each row got its own doc, in arrival order.
    expect(yDocToPlainText(api.consumeInitialDoc(103n)!)).toBe("D3");
    expect(yDocToPlainText(api.consumeInitialDoc(102n)!)).toBe("D2");
    expect(yDocToPlainText(api.consumeInitialDoc(101n)!)).toBe("D1");

    // Content persisted for every block.
    expect(saveYjs).toHaveBeenCalledTimes(3);

    // Only the last document block (D3 = first arrival) claimed focus.
    expect(focusedIds).toEqual([103n]);
  });

  it("ignores rows already known at arm time", () => {
    const coord = new SurfaceFocusCoordinator();
    const api = coord.getApi();
    api.armForInsertBatch([
      { parentId: 1n, initialDoc: plainTextToYDoc("new"), knownSiblingIds: [99n] },
    ]);

    coord.handleNodeInsert(row(99n, 1n), SURFACE, vi.fn());
    expect(api.consumeInitialDoc(99n)).toBeUndefined();

    coord.handleNodeInsert(row(50n, 1n), SURFACE, vi.fn());
    expect(yDocToPlainText(api.consumeInitialDoc(50n)!)).toBe("new");
  });

  it("does not disturb the single-insert path when no batch is armed", () => {
    const coord = new SurfaceFocusCoordinator();
    const api = coord.getApi();
    const focused: bigint[] = [];
    api.registerFocusable(7n, () => focused.push(7n));

    api.armForInsert(1n, undefined, {
      initialDoc: plainTextToYDoc("single"),
      focusAt: "start",
    });
    coord.handleNodeInsert(row(7n, 1n), SURFACE, vi.fn());

    expect(yDocToPlainText(api.consumeInitialDoc(7n)!)).toBe("single");
    expect(focused).toEqual([7n]);
  });
});
