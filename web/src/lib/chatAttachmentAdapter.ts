import type { ExternalStoreAdapter } from "@eclosion-tech/chat";
import type { AttachmentSpec } from "../module_bindings/types";

type AttachmentAdapter = NonNullable<
  NonNullable<ExternalStoreAdapter<unknown>["adapters"]>["attachments"]
>;

/** Keep Pear's reducer payload separate from the renderer's attachment content. */
export function createChatAttachmentAdapter(
  upload: (file: File) => Promise<string | null>,
  onError: (message: string) => void,
) {
  const specs = new Map<string, AttachmentSpec>();
  const removed = new Set<string>();
  const adapter: AttachmentAdapter = {
    accept: "*",
    async *add({ file }) {
      const id = crypto.randomUUID();
      const image = file.type.startsWith("image/");
      const base = {
        id,
        file,
        type: image ? "image" : "file",
        name: file.name || "Attachment",
        contentType: file.type,
      };
      yield {
        ...base,
        status: { type: "running", reason: "uploading", progress: 0 },
      };
      try {
        const objectKey = await upload(file);
        if (removed.delete(id)) return;
        if (!objectKey)
          throw new Error(
            `Could not upload ${base.name}. Remove it and try again.`,
          );
        specs.set(id, {
          kind: { tag: image ? "Image" : "File" },
          objectKey,
          mimeType: file.type || "application/octet-stream",
          fileName: base.name,
          pageId: undefined,
          contentSnapshot: undefined,
        });
        yield {
          ...base,
          status: { type: "requires-action", reason: "composer-send" },
        };
      } catch (error) {
        if (removed.delete(id)) return;
        const message =
          error instanceof Error
            ? error.message
            : "Upload failed. Remove the attachment and try again.";
        onError(message);
        yield {
          ...base,
          status: { type: "incomplete", reason: "error", message },
        };
      }
    },
    async send(attachment) {
      if (!specs.has(attachment.id))
        throw new Error(
          "This attachment is not ready. Remove it and try again.",
        );
      return { ...attachment, status: { type: "complete" }, content: [] };
    },
    async remove(attachment) {
      if (attachment.status.type === "running") removed.add(attachment.id);
      specs.delete(attachment.id);
    },
  };
  return {
    adapter,
    register(id: string, spec: AttachmentSpec) {
      specs.set(id, spec);
    },
    resolve(attachments: readonly { id: string }[]) {
      return attachments.map(({ id }) => {
        const spec = specs.get(id);
        if (!spec)
          throw new Error(
            "An attachment is unavailable. Remove it and attach it again.",
          );
        return spec;
      });
    },
    release(attachments: readonly { id: string }[]) {
      for (const { id } of attachments) specs.delete(id);
    },
  };
}

/** Only accept sidebar payloads with an unsigned SpacetimeDB page id. */
export function parsePageDrop(
  raw: string,
): { pageId: bigint; title: string } | null {
  try {
    const payload = JSON.parse(raw);
    if (
      !payload ||
      typeof payload.pageId !== "string" ||
      !/^\d+$/.test(payload.pageId)
    )
      return null;
    const pageId = BigInt(payload.pageId);
    if (pageId > 18446744073709551615n) return null;
    return {
      pageId,
      title: typeof payload.title === "string" ? payload.title : "Untitled",
    };
  } catch {
    return null;
  }
}
