/**
 * Platform-agnostic helpers for workspace file content.
 *
 * Two consumers:
 *   - Hosts implementing {@link WorkspaceFileReader} (worker, CF gateway)
 *     use the type sniffing + UTF-8 decoding here so "what counts as text"
 *     is decided once, not per host.
 *   - The core's `get_page` rendering uses {@link describeMediaNode} to show
 *     agents what a file/image/audio block IS (name, size, storage key)
 *     instead of the bare `[FileBlock]` placeholder — the storage key is the
 *     handle `read_file` takes.
 *
 * No `node:*` imports, no `process.env`: this runs in Cloudflare Workers too.
 */

import type { ComponentNodeRow } from "./types";

/**
 * Human-readable byte count (`512 B`, `48 KB`, `2.3 MB`). Kept local rather
 * than importing `../formatBytes`: this directory is an ESM package consumed
 * by Node hosts as source, and files outside it resolve as CJS there.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

/** MIME types that are text despite not being `text/*`. */
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/graphql",
  "application/x-sh",
  "application/x-httpd-php",
  "application/rtf",
  "image/svg+xml",
]);

/** Extensions treated as text when the MIME type is missing or generic. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "adoc", "org", "log", "csv", "tsv",
  "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "xml", "html", "htm", "svg", "css", "scss", "less",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "rs", "go", "java", "kt",
  "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh",
  "sql", "graphql", "gql", "tex", "bib", "srt", "vtt", "ics", "eml", "diff", "patch",
]);

export type TextExtractor = "utf8" | "pdf" | "docx" | "none";

/** Lower-cased extension of a filename, without the dot; "" when absent. */
export function extensionOf(filename: string | undefined): string {
  if (!filename) return "";
  const m = /\.([a-z0-9]{1,12})$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Normalise a MIME type: lower-case, parameters stripped. */
export function baseMime(contentType: string | undefined): string {
  if (!contentType) return "";
  return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * Which extractor a host should run for this file. Decided from the MIME
 * type first, then the extension (uploads frequently arrive as
 * `application/octet-stream`). `utf8` still needs {@link looksLikeUtf8Text}
 * on the bytes before trusting it.
 */
export function extractorFor(contentType: string | undefined, filename?: string): TextExtractor {
  const mime = baseMime(contentType);
  const ext = extensionOf(filename);
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return "docx";
  }
  if (isTextLikeType(contentType, filename)) return "utf8";
  return "none";
}

/** True when MIME type or extension says this is a text format. */
export function isTextLikeType(contentType: string | undefined, filename?: string): boolean {
  const mime = baseMime(contentType);
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIME_EXACT.has(mime)) return true;
  if (mime.endsWith("+json") || mime.endsWith("+xml")) return true;
  return TEXT_EXTENSIONS.has(extensionOf(filename));
}

/**
 * Cheap binary sniff: a NUL byte in the first 8 KiB, or bytes that fail
 * strict UTF-8 decoding, means "not text" regardless of the declared type.
 */
export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // Only when the sample was cut at the window boundary can a trailing
    // multi-byte sequence be split; retry on a slightly shorter sample then.
    // A whole-file sample that fails strict decoding is simply not UTF-8.
    if (sample.length < bytes.length && sample.length > 4) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - 4));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/** Decode bytes as UTF-8, dropping a leading BOM. */
export function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Cap text at `max` chars; returns the slice and whether anything was cut. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

// ── get_page rendering of media blocks ────────────────────────────────────────

type MediaProps = {
  storageKey?: unknown;
  externalUrl?: unknown;
  filename?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
  caption?: unknown;
  transcript?: unknown;
  durationSec?: unknown;
  attachmentId?: unknown;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseProps(props: string | undefined): MediaProps {
  if (!props) return {};
  try {
    const parsed = JSON.parse(props) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as MediaProps) : {};
  } catch {
    return {};
  }
}

function refOf(p: MediaProps): string {
  const key = str(p.storageKey);
  if (key) return `storage_key=${key}`;
  const url = str(p.externalUrl);
  if (url) return `url=${url}`;
  return "";
}

/**
 * One-line description of a media node for reconstructed page text, or
 * `undefined` for non-media types. Surfaces the storage key so the agent
 * can pass it to `read_file`; captions/transcripts follow on their own
 * lines because they are real page text, not metadata.
 */
export function describeMediaNode(node: Pick<ComponentNodeRow, "componentType" | "props">): string | undefined {
  switch (node.componentType) {
    case "FileBlock": {
      const p = parseProps(node.props);
      const name = str(p.filename);
      const meta = [
        typeof p.sizeBytes === "number" && p.sizeBytes > 0 ? formatBytes(p.sizeBytes) : "",
        str(p.contentType),
      ]
        .filter(Boolean)
        .join(", ");
      const head = [`File:`, name ? `"${name}"` : "", meta ? `(${meta})` : "", refOf(p)]
        .filter(Boolean)
        .join(" ");
      const caption = str(p.caption).trim();
      return caption ? `[${head}]\n${caption}` : `[${head}]`;
    }
    case "ImageBlock": {
      const p = parseProps(node.props);
      const caption = str(p.caption).trim();
      const head = [`Image:`, caption ? `"${caption}"` : "", refOf(p)].filter(Boolean).join(" ");
      return `[${head}]`;
    }
    case "Audio": {
      const p = parseProps(node.props);
      const dur =
        typeof p.durationSec === "number" && p.durationSec > 0
          ? `${Math.round(p.durationSec)}s`
          : "";
      const head = [`Audio:`, dur ? `(${dur})` : "", refOf(p)].filter(Boolean).join(" ");
      const transcript = str(p.transcript).trim();
      return transcript ? `[${head}]\nTranscript: ${transcript}` : `[${head}]`;
    }
    case "Image": {
      const p = parseProps(node.props);
      const id = p.attachmentId != null ? String(p.attachmentId) : "";
      return id ? `[Image attachment_id=${id}]` : `[Image]`;
    }
    default:
      return undefined;
  }
}
