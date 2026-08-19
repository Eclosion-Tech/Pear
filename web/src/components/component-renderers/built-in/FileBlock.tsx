"use client";

import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import { usePulp, type BlockRendererProps } from "@eclosion-tech/pulp";
import { useAudioAttachment } from "@/src/components/AudioAttachmentContext";
import {
  uploadWorkspaceBlob,
  usePearWorkspaceSlug,
  workspaceBlobDownloadHref,
  workspaceBlobSrc,
} from "@/src/lib/blobUpload";
import { formatBytes } from "@/src/lib/formatBytes";

/**
 * Built-in `FileBlock` — generic file attachment (any content type).
 *
 * Prop schema (`prop_schemas::FILE_BLOCK` in components.rs):
 *   { storageKey?, externalUrl?, filename?, contentType?, sizeBytes?, caption? }
 *
 * Sibling of `ImageBlock` / `Audio`: same blob upload dance, same
 * `Attachment` registration, but renders as a download card instead of
 * inline media. Accepts a click-to-pick upload or a native file drop.
 */
type FileBlockProps = {
  storageKey?: string;
  /** Hotlinked file with no workspace blob (e.g. from imports). */
  externalUrl?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  caption?: string;
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function FileBlockRenderer({ node }: BlockRendererProps) {
  const props = useMemo<FileBlockProps>(() => safeParse(node.props), [node.props]);
  const { updateBlockProps } = usePulp();
  const slug = usePearWorkspaceSlug();
  const attachmentCtx = useAudioAttachment();
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const patch = useCallback(
    (next: Partial<FileBlockProps>) => {
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
    setError(null);
    try {
      const contentType = file.type || DEFAULT_CONTENT_TYPE;
      const up = await uploadWorkspaceBlob({ slug, body: file, contentType });
      if (!up) {
        setError("Upload failed — check storage quota and try again.");
        return;
      }
      const filename = file.name || "file";
      attachmentCtx.createAttachment({
        pageId: attachmentCtx.pageId,
        filename,
        contentType,
        storageKey: up.objectId,
        sizeBytes: BigInt(file.size),
      });
      patch({
        storageKey: up.objectId,
        externalUrl: "",
        filename,
        contentType,
        sizeBytes: file.size,
      });
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!attachmentCtx || uploading) return;
    const f = e.dataTransfer.files?.[0];
    if (f) void handleUpload(f);
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (!attachmentCtx || uploading) return;
    // Only claim drags that carry files; block-reorder drags are pointer-based
    // (dnd-kit) and never reach these handlers.
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }

  const storageKey = props.storageKey ?? "";
  // http(s)-only guard — externalUrl may come from imported (untrusted) content.
  const externalUrl = /^https?:\/\//i.test(props.externalUrl ?? "") ? props.externalUrl! : "";
  const filename = props.filename ?? "";
  const caption = props.caption ?? "";

  if (!storageKey && !externalUrl) {
    return (
      <figure
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          // Ignore leave events fired when moving between the figure's children.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOver(false);
        }}
        className={
          "my-3 flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors " +
          (dragOver
            ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/30"
            : "border-neutral-300 bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-900/50")
        }
      >
        <span className="text-sm text-neutral-400 dark:text-neutral-500">
          {uploading
            ? "Uploading…"
            : attachmentCtx
              ? "Drop a file here, or"
              : "No file attached"}
        </span>
        {attachmentCtx && (
          <>
            <button
              type="button"
              disabled={uploading || !slug}
              onClick={() => fileRef.current?.click()}
              className="rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-300 disabled:opacity-50 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600"
            >
              Upload file
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleUpload(f);
              }}
            />
          </>
        )}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </figure>
    );
  }

  const displayName = filename || (externalUrl ? lastPathSegment(externalUrl) : "file");
  const openHref = storageKey ? workspaceBlobSrc(slug, storageKey) : externalUrl;
  const downloadHref = storageKey
    ? workspaceBlobDownloadHref(slug, storageKey, displayName)
    : externalUrl;
  const sizeLabel = props.sizeBytes ? formatBytes(props.sizeBytes) : "";
  const typeLabel = shortTypeLabel(props.contentType, displayName);
  const meta = [sizeLabel, typeLabel].filter(Boolean).join(" · ");

  return (
    <figure className="my-3 group/file">
      <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-900">
        <span className="text-2xl leading-none" aria-hidden="true">
          {iconFor(props.contentType, displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <a
            href={openHref || undefined}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-sm font-medium text-neutral-800 hover:underline dark:text-neutral-100"
            title={displayName}
          >
            {displayName}
          </a>
          {meta && (
            <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">{meta}</div>
          )}
        </div>
        {downloadHref && (
          <a
            href={downloadHref}
            // Workspace blobs: the server presigns with Content-Disposition
            // attachment, so this navigates straight into a save dialog.
            // Hotlinked files are cross-origin — `download` is ignored there,
            // so open them in a new tab instead of leaving the page.
            download={displayName}
            target={storageKey ? undefined : "_blank"}
            rel={storageKey ? undefined : "noreferrer"}
            className="shrink-0 rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Download
          </a>
        )}
        {attachmentCtx && (
          <>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-100 hover:text-neutral-800 group-hover/file:opacity-100 focus:opacity-100 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              title="Replace file"
            >
              {uploading ? "Uploading…" : "Replace"}
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleUpload(f);
              }}
            />
          </>
        )}
      </div>
      {error && (
        <div className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div>
      )}
      <figcaption className="mt-1">
        <input
          type="text"
          value={caption}
          onChange={(e) => patch({ caption: e.target.value })}
          placeholder="Add a caption…"
          className="w-full bg-transparent text-sm text-neutral-500 dark:text-neutral-400 outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
        />
      </figcaption>
    </figure>
  );
}

function safeParse(s: string): FileBlockProps {
  try {
    return JSON.parse(s) as FileBlockProps;
  } catch {
    return {};
  }
}

function lastPathSegment(url: string): string {
  try {
    const path = new URL(url).pathname;
    const seg = path.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : url;
  } catch {
    return url;
  }
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toUpperCase() : "";
}

/** Human-friendly type label: file extension when known, else the MIME subtype. */
function shortTypeLabel(contentType: string | undefined, name: string): string {
  const ext = extensionOf(name);
  if (ext) return ext;
  if (!contentType || contentType === DEFAULT_CONTENT_TYPE) return "";
  const sub = contentType.split("/")[1] ?? "";
  return sub.replace(/^x-/, "").replace(/^vnd\./, "").toUpperCase();
}

function iconFor(contentType: string | undefined, name: string): string {
  const ct = (contentType ?? "").toLowerCase();
  const ext = extensionOf(name).toLowerCase();
  if (ct.startsWith("image/")) return "🖼️";
  if (ct.startsWith("audio/")) return "🎵";
  if (ct.startsWith("video/")) return "🎬";
  if (ct === "application/pdf" || ext === "pdf") return "📄";
  if (
    /zip|tar|gzip|x-7z|rar|compressed/.test(ct) ||
    ["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)
  ) {
    return "🗜️";
  }
  if (/spreadsheet|excel|csv/.test(ct) || ["csv", "xls", "xlsx", "tsv"].includes(ext)) {
    return "📊";
  }
  if (/presentation|powerpoint/.test(ct) || ["ppt", "pptx", "key"].includes(ext)) return "📽️";
  if (ct.startsWith("text/") || /json|xml|markdown/.test(ct)) return "📃";
  return "📎";
}
