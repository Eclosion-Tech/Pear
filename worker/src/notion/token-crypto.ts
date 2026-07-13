/**
 * Decrypt the Notion OAuth token ciphertext carried on a NotionImportJob row.
 *
 * Wire format: [12-byte nonce][ciphertext][16-byte auth tag], AES-256-GCM —
 * produced by the web app's notion-token-crypto.ts with the same
 * NOTION_TOKEN_ENCRYPTION_KEY (base64-encoded 32 bytes). The key lives only
 * in server-side env (Vercel + worker); the job row never sees plaintext.
 */
import { createDecipheriv } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function decryptNotionTokenB64(ciphertextB64: string): string {
  const raw = process.env.NOTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("NOTION_TOKEN_ENCRYPTION_KEY is not set on the worker");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`NOTION_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`);
  }
  const buf = Buffer.from(ciphertextB64, "base64");
  if (buf.length <= NONCE_BYTES + TAG_BYTES) {
    throw new Error("Notion token ciphertext is too short");
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const encrypted = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
