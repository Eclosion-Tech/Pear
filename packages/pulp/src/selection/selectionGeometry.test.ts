import { describe, expect, it } from "vitest";
import {
  blocksInMarquee,
  rectFromPoints,
  rectsIntersect,
  type Rect,
} from "./selectionGeometry";

describe("rectFromPoints", () => {
  it("normalizes regardless of drag direction", () => {
    expect(rectFromPoints(10, 20, 0, 5)).toEqual({
      left: 0,
      top: 5,
      right: 10,
      bottom: 20,
    });
  });
});

describe("rectsIntersect", () => {
  const base: Rect = { left: 0, top: 0, right: 10, bottom: 10 };
  it("detects overlap", () => {
    expect(rectsIntersect(base, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(true);
  });
  it("rejects disjoint rects", () => {
    expect(rectsIntersect(base, { left: 20, top: 20, right: 30, bottom: 30 })).toBe(false);
  });
});

describe("blocksInMarquee", () => {
  it("returns intersecting blocks in document order", () => {
    const rects = new Map<bigint, Rect>([
      [1n, { left: 0, top: 0, right: 100, bottom: 20 }],
      [2n, { left: 0, top: 30, right: 100, bottom: 50 }],
      [3n, { left: 0, top: 60, right: 100, bottom: 80 }],
    ]);
    const marquee: Rect = { left: 10, top: 25, right: 40, bottom: 65 };
    expect(blocksInMarquee(marquee, [1n, 2n, 3n], rects)).toEqual([2n, 3n]);
  });

  it("ignores blocks without a registered rect", () => {
    const rects = new Map<bigint, Rect>([
      [2n, { left: 0, top: 0, right: 10, bottom: 10 }],
    ]);
    expect(
      blocksInMarquee({ left: 0, top: 0, right: 10, bottom: 10 }, [1n, 2n], rects),
    ).toEqual([2n]);
  });
});
