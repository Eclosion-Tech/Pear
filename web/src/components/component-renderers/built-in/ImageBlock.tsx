"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { usePulp, type BlockRendererProps } from "@eclosion-tech/pulp";
import { useAudioAttachment } from "@/src/components/AudioAttachmentContext";
import {
  uploadWorkspaceBlob,
  usePearWorkspaceSlug,
  workspaceBlobSrc,
} from "@/src/lib/blobUpload";

/**
 * Built-in `ImageBlock` — BlockNote-era image (storageKey + caption).
 *
 * Prop schema (`prop_schemas::IMAGE_BLOCK` in components.rs):
 *   { storageKey?: string, caption?: string }
 *
 * Distinct from v1 `Image` (attachmentId). Supports in-block upload.
 */
type ImageBlockProps = {
  storageKey?: string;
  /** Hotlinked image with no workspace blob (e.g. from imports). */
  externalUrl?: string;
  caption?: string;
};

export function ImageBlockRenderer({ node }: BlockRendererProps) {
  const props = useMemo<ImageBlockProps>(() => safeParse(node.props), [node.props]);
  const { updateBlockProps } = usePulp();
  const slug = usePearWorkspaceSlug();
  const attachmentCtx = useAudioAttachment();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const patch = useCallback(
    (next: Partial<ImageBlockProps>) => {
      updateBlockProps({
        componentId: node.id,
        propsJson: JSON.stringify({ ...props, ...next }),
      });
    },
    [node.id, props, updateBlockProps],
  );

  async function handleUpload(file: File) {
    if (!attachmentCtx) return;
    setUploading(true);
    try {
      const contentType = file.type || "image/png";
      const up = await uploadWorkspaceBlob({
        slug,
        body: file,
        contentType,
      });
      if (!up) return;
      attachmentCtx.createAttachment({
        pageId: attachmentCtx.pageId,
        filename: file.name || "image",
        contentType,
        storageKey: up.objectId,
        sizeBytes: BigInt(file.size),
      });
      patch({ storageKey: up.objectId });
    } finally {
      setUploading(false);
    }
  }

  const storageKey = props.storageKey ?? "";
  // http(s)-only guard — externalUrl may come from imported (untrusted) content.
  const externalUrl = /^https?:\/\//i.test(props.externalUrl ?? "") ? props.externalUrl! : "";

  if (!storageKey && !externalUrl) {
    return (
      <figure className="my-3 flex flex-col items-center gap-2 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900/50 p-8 text-center">
        <span className="text-sm text-neutral-400 dark:text-neutral-500">
          {uploading ? "Uploading…" : "No image yet"}
        </span>
        {attachmentCtx && (
          <>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-300 disabled:opacity-50 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600"
            >
              Upload image
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleUpload(f);
              }}
            />
          </>
        )}
      </figure>
    );
  }

  const src = storageKey ? workspaceBlobSrc(slug, storageKey) : externalUrl;
  const caption = props.caption ?? "";

  return (
    <figure className="my-3 group/image">
      <img
        src={src}
        alt={caption || "Uploaded image"}
        className="max-w-full h-auto rounded-lg border border-neutral-200 dark:border-neutral-700"
        loading="lazy"
      />
      <figcaption className="mt-1">
        <input
          type="text"
          value={caption}
          onChange={(e) => patch({ caption: e.target.value })}
          placeholder="Add a caption…"
          className="w-full bg-transparent text-sm text-neutral-500 dark:text-neutral-400 text-center outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
        />
      </figcaption>
    </figure>
  );
}

function safeParse(s: string): ImageBlockProps {
  try {
    return JSON.parse(s) as ImageBlockProps;
  } catch {
    return {};
  }
}
