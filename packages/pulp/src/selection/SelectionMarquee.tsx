"use client";

import type { Rect } from "./selectionGeometry";

/** Translucent drag-select rectangle (fixed-positioned, viewport coords). */
export function SelectionMarquee({ rect }: { rect: Rect }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-40 rounded-sm border border-blue-400/70 bg-blue-400/10"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }}
    />
  );
}
