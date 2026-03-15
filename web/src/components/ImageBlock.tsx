"use client";

import { createReactBlockSpec } from "@blocknote/react";

/**
 * Image block that stores a storageKey (S3/MinIO). Renders via the proxy URL
 * so the img src is stable and doesn't expire.
 */
export const ImageBlockSpec = createReactBlockSpec(
  {
    type: "image" as const,
    propSchema: {
      storageKey: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const key = block.props.storageKey as string;
      const caption = (block.props.caption as string) || "";

      if (!key) {
        return (
          <figure
            contentEditable={false}
            className="my-3 flex flex-col gap-1 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900/50 p-8 text-center"
          >
            <span className="text-sm text-neutral-400 dark:text-neutral-500">Image missing or deleted</span>
          </figure>
        );
      }

      const src = `/api/upload/proxy?key=${encodeURIComponent(key)}`;

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
    },
  }
);
