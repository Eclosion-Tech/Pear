import type { BlockId } from "../types";

/**
 * Surface-scoped block selection. Character selection inside a block stays
 * with ProseMirror; this tracks **whole-block** selection (Notion / BlockNote)
 * — the state a drag flips into once it crosses a block boundary, plus marquee
 * and keyboard selection. Pure + framework-agnostic: the React provider
 * subscribes; document order for range math is supplied by the caller.
 */
export class SurfaceSelectionController {
  private selected = new Set<BlockId>();
  private anchorId: BlockId | null = null;
  private listeners = new Set<() => void>();
  /** Snapshot reused while selection is unchanged (stable for useSyncExternalStore). */
  private snapshot: readonly BlockId[] = [];

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Stable array snapshot of the current selection (document-order agnostic). */
  getSnapshot = (): readonly BlockId[] => this.snapshot;

  isSelected(id: BlockId): boolean {
    return this.selected.has(id);
  }

  get size(): number {
    return this.selected.size;
  }

  /** Select exactly one block (becomes the range anchor). */
  selectOnly(id: BlockId): void {
    this.selected = new Set([id]);
    this.anchorId = id;
    this.commit();
  }

  /** Cmd/Ctrl-click — add or remove a single block; updates the anchor. */
  toggle(id: BlockId): void {
    const next = new Set(this.selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.selected = next;
    this.anchorId = next.has(id) ? id : this.anchorId;
    this.commit();
  }

  /**
   * Shift-click / Shift-drag — select the inclusive range from the anchor to
   * `focusId` in document order. With no anchor yet, behaves like `selectOnly`.
   */
  selectRange(focusId: BlockId, orderedIds: readonly BlockId[]): void {
    if (this.anchorId == null || !orderedIds.includes(this.anchorId)) {
      this.selectOnly(focusId);
      return;
    }
    const a = orderedIds.indexOf(this.anchorId);
    const b = orderedIds.indexOf(focusId);
    if (b < 0) {
      this.selectOnly(focusId);
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.selected = new Set(orderedIds.slice(lo, hi + 1));
    this.commit();
  }

  /**
   * Select the inclusive document-order range between two endpoints (a
   * cross-block text drag that crossed a boundary). The first endpoint becomes
   * the anchor so a follow-up Shift extends from there.
   */
  selectBetween(
    aId: BlockId,
    fId: BlockId,
    orderedIds: readonly BlockId[],
  ): void {
    const a = orderedIds.indexOf(aId);
    const b = orderedIds.indexOf(fId);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.selected = new Set(orderedIds.slice(lo, hi + 1));
    this.anchorId = aId;
    this.commit();
  }

  /** Replace the selection with an explicit set (marquee result). */
  selectMany(ids: readonly BlockId[]): void {
    this.selected = new Set(ids);
    this.anchorId = ids.length > 0 ? ids[ids.length - 1]! : null;
    this.commit();
  }

  clear(): void {
    if (this.selected.size === 0 && this.anchorId == null) return;
    this.selected = new Set();
    this.anchorId = null;
    this.commit();
  }

  private commit(): void {
    this.snapshot = Array.from(this.selected);
    for (const fn of this.listeners) fn();
  }
}
