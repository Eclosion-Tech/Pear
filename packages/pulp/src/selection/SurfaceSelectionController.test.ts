import { describe, expect, it, vi } from "vitest";
import { SurfaceSelectionController } from "./SurfaceSelectionController";

const ORDER = [1n, 2n, 3n, 4n, 5n];

describe("SurfaceSelectionController", () => {
  it("selectOnly replaces the selection and sets the anchor", () => {
    const c = new SurfaceSelectionController();
    c.selectOnly(3n);
    expect(c.getSnapshot()).toEqual([3n]);
    expect(c.isSelected(3n)).toBe(true);
    c.selectOnly(4n);
    expect(c.getSnapshot()).toEqual([4n]);
  });

  it("toggle adds and removes", () => {
    const c = new SurfaceSelectionController();
    c.toggle(2n);
    c.toggle(4n);
    expect(new Set(c.getSnapshot())).toEqual(new Set([2n, 4n]));
    c.toggle(2n);
    expect(c.getSnapshot()).toEqual([4n]);
  });

  it("selectRange selects the inclusive document-order range from the anchor", () => {
    const c = new SurfaceSelectionController();
    c.selectOnly(2n); // anchor
    c.selectRange(4n, ORDER);
    expect(c.getSnapshot()).toEqual([2n, 3n, 4n]);
  });

  it("selectRange works regardless of direction", () => {
    const c = new SurfaceSelectionController();
    c.selectOnly(4n);
    c.selectRange(2n, ORDER);
    expect(c.getSnapshot()).toEqual([2n, 3n, 4n]);
  });

  it("selectBetween selects an explicit endpoint range", () => {
    const c = new SurfaceSelectionController();
    c.selectBetween(5n, 3n, ORDER);
    expect(c.getSnapshot()).toEqual([3n, 4n, 5n]);
  });

  it("selectMany replaces with an explicit set", () => {
    const c = new SurfaceSelectionController();
    c.selectMany([1n, 5n]);
    expect(new Set(c.getSnapshot())).toEqual(new Set([1n, 5n]));
  });

  it("clear empties the selection and notifies once", () => {
    const c = new SurfaceSelectionController();
    const fn = vi.fn();
    c.subscribe(fn);
    c.selectOnly(1n);
    c.clear();
    expect(c.getSnapshot()).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
    fn.mockClear();
    c.clear(); // no-op when already empty
    expect(fn).not.toHaveBeenCalled();
  });

  it("getSnapshot returns a stable reference until selection changes", () => {
    const c = new SurfaceSelectionController();
    c.selectOnly(1n);
    const snap = c.getSnapshot();
    expect(c.getSnapshot()).toBe(snap);
  });
});
