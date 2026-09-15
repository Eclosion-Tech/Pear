import type { StdbTransport } from "./types";

export interface BlobAccessBinding {
  created_by: string;
  resource_kind: "page" | "conversation" | null;
  resource_id: string | null;
}

/** Authority comes from the upload reservation, never a supplied attachment
 * reference. The transport MUST carry the reader's credential, not publisher. */
export async function canReadBlob(
  binding: BlobAccessBinding | null,
  transport: StdbTransport,
  ownerId?: string,
): Promise<boolean> {
  if (!binding) return false;
  if (!binding.resource_kind || !binding.resource_id) {
    return !!ownerId && binding.created_by === ownerId;
  }
  if (!/^[0-9]+$/.test(binding.resource_id)) return false;
  if (binding.resource_kind !== "page" && binding.resource_kind !== "conversation") return false;
  const rows = await transport.sql(`SELECT id FROM ${binding.resource_kind} WHERE id = ${binding.resource_id}`);
  return rows.length === 1;
}
