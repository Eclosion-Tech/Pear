import { createPrivateKey, createPublicKey, createHash, privateDecrypt, createDecipheriv, constants, type KeyObject } from "node:crypto";

export function mailEncryptionKey(encoded: string): { privateKey: KeyObject; publicKeyJwk: string; keyId: string } {
  const privateKey = createPrivateKey(Buffer.from(encoded, "base64"));
  if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new Error("Mail credential key must be RSA, at least 3072 bits");
  }
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey, publicKeyJwk: JSON.stringify(publicKey.export({ format: "jwk" })),
    keyId: createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex"),
  };
}

export function decryptMailPassword(envelope: string, config: ReturnType<typeof mailEncryptionKey>): string {
  if (envelope.length > 16384) throw new Error("Invalid mail credential envelope");
  const data = JSON.parse(envelope);
  if (data.v !== 1 || data.keyId !== config.keyId) throw new Error("Mail credential key mismatch");
  const key = privateDecrypt({ key: config.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(data.key, "base64"));
  const encrypted = Buffer.from(data.ciphertext, "base64");
  const nonce = Buffer.from(data.nonce, "base64");
  if (key.length !== 32 || nonce.length !== 12 || encrypted.length < 17 || encrypted.length > 4112) throw new Error("Invalid mail credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(config.keyId));
  decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
}
