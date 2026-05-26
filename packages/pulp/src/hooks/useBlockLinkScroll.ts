"use client";

import { useEffect, useRef } from "react";
import { parseBlockLinkHash } from "../blockLink";
import { useSurfaceFocus } from "../focus/SurfaceFocusProvider";
import type { BlockTree } from "../types";

/** Scroll to and focus a block when the URL hash is `#c-{componentId}`. */
export function useBlockLinkScroll(tree: BlockTree): void {
  const focus = useSurfaceFocus();
  const initialDoneRef = useRef(false);

  useEffect(() => {
    function goToHash(hash: string, isInitial: boolean) {
      if (tree.loading) return;
      const id = parseBlockLinkHash(hash);
      if (id == null || !tree.byId.has(id)) return;
      if (isInitial && initialDoneRef.current) return;
      if (isInitial) initialDoneRef.current = true;

      requestAnimationFrame(() => {
        document.getElementById(`block-${id}`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        focus.requestFocus(id);
      });
    }

    goToHash(window.location.hash, true);

    function onHashChange() {
      goToHash(window.location.hash, false);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [tree.loading, tree.byId, focus]);
}
