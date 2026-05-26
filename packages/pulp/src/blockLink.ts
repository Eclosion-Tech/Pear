import type { BlockId } from "./types";

/** URL hash prefix for deep links to a block on a page. */
export const BLOCK_LINK_HASH_PREFIX = "c-";

export function blockLinkHash(componentId: BlockId): string {
  return `#${BLOCK_LINK_HASH_PREFIX}${componentId}`;
}

export function buildBlockLink(componentId: BlockId): string {
  if (typeof window === "undefined") return blockLinkHash(componentId);
  return `${window.location.origin}${window.location.pathname}${blockLinkHash(componentId)}`;
}

export async function copyBlockLink(componentId: BlockId): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(buildBlockLink(componentId));
    return true;
  } catch {
    return false;
  }
}

export function parseBlockLinkHash(hash: string): BlockId | null {
  const s = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!s.startsWith(BLOCK_LINK_HASH_PREFIX)) return null;
  try {
    return BigInt(s.slice(BLOCK_LINK_HASH_PREFIX.length));
  } catch {
    return null;
  }
}
