"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { usePearWorkspaceSlug, workspaceBlobSrc } from "@/src/lib/blobUpload";

function ImageBlockView({
  storageKey,
  externalUrl,
  caption,
}: {
  storageKey: string;
  externalUrl: string;
  caption: string;
}) {
  const slug = usePearWorkspaceSlug();

  // http(s)-only guard — externalUrl may come from imported (untrusted) content.
  const safeExternal = /^https?:\/\//i.test(externalUrl) ? externalUrl : "";

  if (!storageKey && !safeExternal) {
    return (
      <figure
        contentEditable={false}
        className="my-3 flex flex-col gap-1 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900/50 p-8 text-center"
      >
        <span className="text-sm text-neutral-400 dark:text-neutral-500">Image missing or deleted</span>
      </figure>
    );
  }

  const src = storageKey ? workspaceBlobSrc(slug, storageKey) : safeExternal;

  return (
    <figure contentEditable={false} className="my-3">
      <img
        src={src}
        alt={caption || "Uploaded image"}
        className="max-w-full h-auto rounded-lg border border-neutral-200 dark:border-neutral-700"
        loading="lazy"
      />
      {caption && (
        <figcaption className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 text-center">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * Image block that stores a `storageKey` (an objectId UUID). Renders via a
 * workspace-scoped server route that 302-redirects to a presigned GET URL.
 * The presigned URL is short-lived (15m) but the `<img src>` itself is
 * stable — the server re-signs on each request.
 */
export const ImageBlockSpec = createReactBlockSpec(
  {
    type: "image" as const,
    propSchema: {
      storageKey: { default: "" },
      // Hotlinked images (e.g. from imports) that have no workspace blob.
      externalUrl: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => (
      <ImageBlockView
        storageKey={block.props.storageKey as string}
        externalUrl={(block.props.externalUrl as string) || ""}
        caption={(block.props.caption as string) || ""}
      />
    ),
  }
);
