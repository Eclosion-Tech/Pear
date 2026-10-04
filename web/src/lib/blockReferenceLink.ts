import type { BlockReferenceTarget } from "@eclosion-tech/pulp";
import { parseReferenceProps } from "@eclosion-tech/pulp";

export function parseBlockReferenceLink(value: string, origin: string): BlockReferenceTarget | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin) return null;
    const match = /^\/workspace\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return null;
    const blockId = url.hash ? /^#c-([1-9]\d*)$/.exec(url.hash)?.[1] : url.searchParams.get("node") ?? undefined;
    if (url.hash && !blockId) return null;
    return parseReferenceProps(JSON.stringify({ surfaceId: match[1], blockId }));
  } catch { return null; }
}

export function blockReferenceHref(target: BlockReferenceTarget): string {
  return `/workspace/${target.surfaceId}${target.blockId == null ? "" : `#c-${target.blockId}`}`;
}
