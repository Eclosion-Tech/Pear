/** Encrypt before calling a reducer: reducer arguments can appear in transaction
 * events, so a private credential table alone is not a secrecy boundary. */
export async function encryptMailPassword(password: string, publicKeyJwk: string, keyId: string): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  if (!bytes.length || bytes.length > 4096) throw new Error("App password must be 1–4096 bytes");
  const publicKey = await crypto.subtle.importKey("jwk", JSON.parse(publicKeyJwk),
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(keyId) }, key, bytes);
  const raw = await crypto.subtle.exportKey("raw", key);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, raw);
  const b64 = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value)));
  return JSON.stringify({ v: 1, keyId, key: b64(wrapped), nonce: b64(nonce), ciphertext: b64(ciphertext) });
}
