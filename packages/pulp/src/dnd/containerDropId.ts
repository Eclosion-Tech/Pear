import type { BlockId } from "../types";

/** Prefix for container `useDroppable` ids — distinct from block sortable ids. */
export const CONTAINER_DROP_PREFIX = "container:";

export function containerDropId(containerId: BlockId): string {
  return `${CONTAINER_DROP_PREFIX}${containerId}`;
}

export function parseContainerDropId(
  id: string | number,
): BlockId | null {
  const s = String(id);
  if (!s.startsWith(CONTAINER_DROP_PREFIX)) return null;
  try {
    return BigInt(s.slice(CONTAINER_DROP_PREFIX.length));
  } catch {
    return null;
  }
}

export function parseBlockSortableId(
  id: string | number,
): BlockId | null {
  const s = String(id);
  if (s.startsWith(CONTAINER_DROP_PREFIX)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
