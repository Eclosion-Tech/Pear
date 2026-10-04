"use client";

import { createContext, useContext } from "react";
import type { BlockNode } from "../types";

export type BlockOccurrence = {
  prefix: string;
  referenceDepth: number;
  ancestors: readonly string[];
};
export const BlockOccurrenceContext = createContext<BlockOccurrence>({
  prefix: "", referenceDepth: 0, ancestors: [],
});
export const useBlockOccurrence = () => useContext(BlockOccurrenceContext);
export const sourceKey = (node: BlockNode) => `${node.surfaceId}:${node.id}`;
export function useBlockDomId() {
  const { prefix } = useBlockOccurrence();
  return (id: bigint) => `${prefix}block-${id}`;
}
