"use client";

/**
 * FloatingPopup — a portal-based floating panel anchored below a trigger element.
 *
 * Renders children via React.createPortal into <body>, completely escaping any
 * overflow:hidden / overflow:auto ancestor. Position is calculated from the
 * anchor element's bounding rect and clamped to the viewport.
 */

import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

interface FloatingPopupProps {
  /** The element the popup anchors below. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Called when the popup should close (outside click, Escape, scroll). */
  onClose: () => void;
  children: ReactNode;
  /** Tailwind classes applied to the popup container (bg, border, rounded, shadow, width…). */
  className?: string;
}

export function FloatingPopup({
  anchorRef,
  onClose,
  children,
  className = "",
}: FloatingPopupProps) {
  const [mounted, setMounted] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  // Mount only on the client (avoids SSR/hydration mismatches with createPortal).
  useEffect(() => {
    setMounted(true);
  }, []);

  // Calculate and apply position synchronously before the first paint.
  useIsomorphicLayoutEffect(() => {
    if (!mounted) return;
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return;

    const rect = anchor.getBoundingClientRect();
    const GAP = 4; // px gap between anchor bottom and popup top

    let top = rect.bottom + GAP;
    let left = rect.left;

    const popupW = popup.offsetWidth || 240;
    const popupH = popup.offsetHeight;

    // Clamp horizontally so popup doesn't overflow the viewport.
    left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8));

    // Flip above anchor if popup would overflow the viewport bottom.
    if (top + popupH > window.innerHeight - 8) {
      top = Math.max(8, rect.top - GAP - popupH);
    }

    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
    popup.style.visibility = "visible";
  }, [mounted, anchorRef]);

  // Close on outside mousedown (excludes both popup and anchor).
  useEffect(() => {
    if (!mounted) return;
    function onMousedown(e: MouseEvent) {
      const t = e.target as Node;
      if (!popupRef.current?.contains(t) && !anchorRef.current?.contains(t)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onMousedown);
    return () => document.removeEventListener("mousedown", onMousedown);
  }, [mounted, onClose, anchorRef]);

  // Close on Escape.
  useEffect(() => {
    if (!mounted) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mounted, onClose]);

  // Close when the page scrolls — the anchor would shift but the popup wouldn't.
  useEffect(() => {
    if (!mounted) return;
    document.addEventListener("scroll", onClose, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onClose, { capture: true });
  }, [mounted, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={popupRef}
      // Start offscreen+invisible; useIsomorphicLayoutEffect moves it into place.
      style={{ position: "fixed", top: -9999, left: -9999, visibility: "hidden", zIndex: 9999 }}
      className={className}
      // Prevent portal click events from bubbling through React's virtual tree
      // to ancestor component handlers (e.g. a cell's toggle-open onClick).
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
