import type { BlockId } from "../types";

/** Axis-aligned rectangle in viewport coordinates. */
export type Rect = { left: number; top: number; right: number; bottom: number };

/** Build a normalized rect from two drag points (handles any drag direction). */
export function rectFromPoints(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Rect {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  };
}

/** True when two rectangles overlap (touching edges count as overlap). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.left <= b.right &&
    a.right >= b.left &&
    a.top <= b.bottom &&
    a.bottom >= b.top
  );
}

/**
 * Block ids whose rect intersects the marquee, in the supplied (document)
 * order. `rects` maps each candidate block to its current bounding rect.
 */
export function blocksInMarquee(
  marquee: Rect,
  orderedIds: readonly BlockId[],
  rects: Map<BlockId, Rect>,
): BlockId[] {
  const out: BlockId[] = [];
  for (const id of orderedIds) {
    const rect = rects.get(id);
    if (rect && rectsIntersect(marquee, rect)) out.push(id);
  }
  return out;
}
