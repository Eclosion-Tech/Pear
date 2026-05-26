"use client";

import { createContext, useContext, type HTMLAttributes } from "react";

/** Drag activator props forwarded to a layout block's header grip. */
export type BlockChromeGripProps = Pick<
  HTMLAttributes<HTMLButtonElement>,
  "role" | "tabIndex" | "aria-roledescription" | "aria-describedby" | "aria-disabled"
> & Record<string, unknown>;

export type BlockChromeHandles = {
  bindGrip: (el: HTMLButtonElement | null) => void;
  gripProps: BlockChromeGripProps;
  insertSiblingBelow: () => void;
  openMenu: () => void;
};

const BlockChromeHandlesContext = createContext<BlockChromeHandles | null>(null);

export function useBlockChromeHandles(): BlockChromeHandles | null {
  return useContext(BlockChromeHandlesContext);
}

export const BlockChromeHandlesProvider = BlockChromeHandlesContext.Provider;
