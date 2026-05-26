"use client";

import { useMemo } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { usePearWorkspaceSlug, workspaceBlobSrc } from "@/src/lib/blobUpload";
import type { BlockRendererProps } from "@eclosion-tech/pulp";

/**
 * Built-in `Image` component. References an `Attachment` row by id; the
 * attachment carries the actual `storageKey` (object UUID) that the
 * workspace-scoped blob route knows how to sign.
 *
 * Prop schema (`prop_schemas::IMAGE` in components.rs):
 *   { attachmentId: integer (required),
 *     alt?: string,
 *     width?: number,
 *     height?: number }
 *
 * This is the v1 built-in. Sprint 4 introduces a richer image block from
 * the BlockNote-era `ImageBlock` (with captions, focal-point cropping,
 * etc.) — that lands as a separate component type rather than mutating
 * this one, to keep the migration path clean.
 */
type ImageProps = {
  attachmentId?: number | bigint;
  alt?: string;
  width?: number;
  height?: number;
};

export function ImageRenderer({ node }: BlockRendererProps) {
  const props = useMemo<ImageProps>(() => safeParse(node.props), [node.props]);
  const slug = usePearWorkspaceSlug();
  const [attachments] = useTable(tables.attachment);

  const attachmentId = normalizeId(props.attachmentId);
  const attachment = attachmentId != null
    ? attachments.find((a) => a.id === attachmentId)
    : undefined;

  if (!attachment) {
    return (
      <figure
        className="my-3 flex flex-col gap-1 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900/50 p-8 text-center"
      >
        <span className="text-sm text-neutral-400 dark:text-neutral-500">
          Image missing or deleted
        </span>
      </figure>
    );
  }

  const src = workspaceBlobSrc(slug, attachment.storageKey);
  const style: React.CSSProperties = {};
  if (typeof props.width === "number") style.width = `${props.width}px`;
  if (typeof props.height === "number") style.height = `${props.height}px`;

  return (
    <figure className="my-3">
      <img
        src={src}
        alt={props.alt ?? "Image"}
        style={style}
        className="max-w-full h-auto rounded-lg border border-neutral-200 dark:border-neutral-700"
        loading="lazy"
      />
    </figure>
  );
}

function normalizeId(raw: unknown): bigint | null {
  if (raw == null) return null;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(raw);
  if (typeof raw === "string") {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function safeParse(s: string): ImageProps {
  try {
    return JSON.parse(s) as ImageProps;
  } catch {
    return {};
  }
}
