import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mailEncryptionKey, decryptMailPassword } from "./credentials.js";
import { encryptMailPassword } from "../../../web/src/lib/mail/credentials.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const key = mailEncryptionKey(Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"));

test("browser encryption and worker decryption round-trip long Unicode app passwords", async () => {
  const password = "fixture-é-🔑".repeat(100);
  const first = await encryptMailPassword(password, key.publicKeyJwk, key.keyId);
  const second = await encryptMailPassword(password, key.publicKeyJwk, key.keyId);
  assert.equal(decryptMailPassword(first, key), password);
  assert.notEqual(first, second);
  assert(!first.includes(password));
  assert(!key.publicKeyJwk.includes('"d"'));
});

test("tampering and key mismatch fail closed", async () => {
  const data = JSON.parse(await encryptMailPassword("fixture", key.publicKeyJwk, key.keyId));
  assert.throws(() => decryptMailPassword(JSON.stringify({ ...data, keyId: "wrong" }), key));
  const bytes = Buffer.from(data.ciphertext, "base64"); bytes[0] ^= 1;
  assert.throws(() => decryptMailPassword(JSON.stringify({ ...data, ciphertext: bytes.toString("base64") }), key));
  await assert.rejects(encryptMailPassword("", key.publicKeyJwk, key.keyId));
  await assert.rejects(encryptMailPassword("a".repeat(4097), key.publicKeyJwk, key.keyId));
});
