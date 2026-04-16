"use client";

/**
 * Workspace-scoped blob upload/download helpers.
 *
 * Pear Cloud exposes blobs under `/api/workspaces/{slug}/blobs/*`:
 *   1. POST /upload-url     → presigned PUT URL + objectId
 *   2. PUT  <uploadUrl>     → actual bytes (client → S3)
 *   3. POST /complete       → server HEAD-confirms and registers the row
 *
 * The returned `objectId` (a UUID) is stored as the attachment's
 * `storageKey` on the SpacetimeDB side. Display URLs are constructed via
 * `workspaceBlobSrc(slug, objectId)` which hits a server route that
 * 302-redirects to a short-lived presigned GET URL (safe for `<img src>`).
 */

export type UploadWorkspaceBlobParams = {
  /** Workspace slug (== SpacetimeDB module name in cloud mode). */
  slug: string;
  /** The raw file/blob to upload. */
  body: Blob;
  /** MIME type to store alongside the object. */
  contentType: string;
};

export type UploadWorkspaceBlobResult = {
  objectId: string;
  byteSize: number;
};

async function jsonOr<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Full upload dance: presign → PUT → complete. Returns the objectId on
 * success, null on any failure (already logged).
 */
export async function uploadWorkspaceBlob(
  params: UploadWorkspaceBlobParams
): Promise<UploadWorkspaceBlobResult | null> {
  const { slug, body, contentType } = params;
  if (!slug) {
    console.error("[blobUpload] missing workspace slug");
    return null;
  }

  const presignRes = await fetch(
    `/api/workspaces/${encodeURIComponent(slug)}/blobs/upload-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType,
        contentLength: body.size,
      }),
    }
  );
  if (!presignRes.ok) {
    const err = await jsonOr<{ error?: string }>(presignRes);
    console.error("[blobUpload] presign failed", presignRes.status, err);
    return null;
  }
  const presign = (await presignRes.json()) as {
    method: "PUT";
    uploadUrl: string;
    objectId: string;
    headers?: Record<string, string>;
  };

  const putRes = await fetch(presign.uploadUrl, {
    method: "PUT",
    body,
    // Must echo the exact headers that were bound into the presigned URL,
    // or S3 will reject with SignatureDoesNotMatch.
    headers: presign.headers ?? { "Content-Type": contentType },
  });
  if (!putRes.ok) {
    console.error("[blobUpload] PUT failed", putRes.status, await putRes.text().catch(() => ""));
    return null;
  }

  const completeRes = await fetch(
    `/api/workspaces/${encodeURIComponent(slug)}/blobs/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectId: presign.objectId }),
    }
  );
  if (!completeRes.ok) {
    const err = await jsonOr<{ error?: string }>(completeRes);
    console.error("[blobUpload] complete failed", completeRes.status, err);
    return null;
  }
  const done = (await completeRes.json()) as { byteSize: number };

  return { objectId: presign.objectId, byteSize: done.byteSize };
}

/**
 * Stable `<img src>` / `<audio src>` URL for a stored blob. Points at a
 * server route that validates membership and 302-redirects to a
 * short-lived presigned GET URL.
 *
 * `storageKey` here is expected to be a bare UUID (an objectId). Legacy
 * Pear storageKeys shaped like `pages/<pageId>/<uuid>.ext` are handled by
 * returning an empty string (so the caller renders a placeholder).
 */
export function workspaceBlobSrc(slug: string, storageKey: string): string {
  if (!slug || !storageKey) return "";
  // Legacy standalone-Pear keys aren't resolvable on the cloud API.
  if (storageKey.includes("/")) return "";
  return `/api/workspaces/${encodeURIComponent(slug)}/blobs/${encodeURIComponent(
    storageKey
  )}/raw`;
}
