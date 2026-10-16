/** Disposable local database test; never targets a deployed workspace. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { createPearMailSink } from "../src/mail/pear-sink.js";
import { parseMessage } from "../src/mail/message.js";
import type { FetchMessageObject } from "imapflow";
import { generateKeyPairSync } from "node:crypto";
import { mailEncryptionKey, decryptMailPassword } from "../src/mail/credentials.js";
import { encryptMailPassword } from "../../web/src/lib/mail/credentials.js";

const base = process.argv[2] || "http://127.0.0.1:3096";
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Localhost only");
const name = `pear-mail-e2e-${Date.now()}`;
const url = `${base}/v1/database/${name}`;
const sockets: WebSocket[] = [];
async function identity() {
  return await (await fetch(`${base}/v1/identity`, { method: "POST" })).json() as { identity: string; token: string };
}
const publisherIdentity = await identity();
const publisher = new HttpStdbTransport({ baseUrl: base, dbName: name, token: publisherIdentity.token });
async function actor() {
  const a = await identity();
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/subscribe?token=${encodeURIComponent(a.token)}`, "v1.json.spacetimedb");
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Connect timeout")), 10_000);
    socket.addEventListener("message", (e) => { if (JSON.parse(String(e.data)).IdentityToken) { clearTimeout(timer); resolve(); } });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("Connect failed")); });
  });
  return new HttpStdbTransport({ baseUrl: base, dbName: name, token: a.token });
}
try {
  const wasm = await readFile(new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
  const result = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: wasm });
  assert(result.ok, await result.text());
  const owner = await actor(), other = await actor();
  await owner.call("register", ["mail-owner@example.test", "Owner", "fixture-password"]);
  await owner.call("create_local_user", ["mail-other@example.test", "Other", "fixture-password"]);
  await other.call("login", ["mail-other@example.test", "fixture-password"]);
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const key = mailEncryptionKey(Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"));
  await publisher.call("publish_mail_encryption_key", [key.publicKeyJwk, key.keyId]);
  const encrypted = await encryptMailPassword("fixture-app-password", key.publicKeyJwk, key.keyId);
  await owner.call("create_mail_connection", ["Work", "mail.example.test", 993, "owner@example.test", encrypted, "INBOX", { none: [] }, { none: [] }, 50]);
  const [account] = await owner.sql<{ id: number; root_page_id: number }>("SELECT * FROM mail_connection");
  assert(account);
  assert.equal((await other.sql("SELECT * FROM mail_connection")).length, 0);
  await assert.rejects(owner.sql("SELECT * FROM mail_connection_secret"));
  await assert.rejects(other.call("set_mail_connection_enabled", [account.id, false]));
  assert.equal((await other.sql("SELECT * FROM page WHERE id = ?", [account.root_page_id])).length, 0);
  await assert.rejects(owner.call("claim_mail_sync", [account.id, "lease-a"]));
  await publisher.call("claim_mail_sync", [account.id, "lease-a"]);
  await assert.rejects(publisher.call("claim_mail_sync", [account.id, "lease-b"]));
  console.log("PASS: connection privacy, secret isolation, private destination, worker-only leases");

  const mail = await parseMessage({ uid: 1, envelope: { subject: "Test" } } as FetchMessageObject,
    Buffer.from("Subject: Test\r\n\r\nPlease reply by Friday."),
    { account: "owner@example.test", accountKey: "test", folder: "INBOX", direction: "received", uidValidity: "1" });
  const sink = createPearMailSink(publisher, BigInt(account.id), BigInt(account.root_page_id), "lease-a");
  await sink.deliver(mail);
  await sink.deliver(mail);
  assert.equal((await owner.sql("SELECT * FROM page WHERE parent_pk = ?", [account.root_page_id])).length, 1);
  assert.equal((await owner.sql("SELECT * FROM mail_import_receipt")).length, 1);
  assert.equal((await other.sql("SELECT * FROM mail_import_receipt")).length, 0);
  const [receipt] = await owner.sql<{ page_id: number }>("SELECT * FROM mail_import_receipt");
  assert((await owner.sql("SELECT * FROM component_node WHERE surface_id = ?", [receipt.page_id])).length >= 4);
  await publisher.call("checkpoint_mail_sync", [account.id, "lease-a", "INBOX", "1", 3]);
  await assert.rejects(publisher.call("checkpoint_mail_sync", [account.id, "lease-a", "INBOX", "1", 2]));
  await assert.rejects(publisher.call("checkpoint_mail_sync", [account.id, "lease-a", "INBOX", "2", 4]));
  console.log("PASS: atomic page/body import, duplicate retry, private receipts, monotonic checkpoints");

  await owner.call("set_mail_connection_enabled", [account.id, false]);
  await assert.rejects(sink.deliver({ ...mail, eventKey: "b".repeat(64) }));
  await owner.call("update_mail_connection_password", [account.id, await encryptMailPassword("rotated-fixture", key.publicKeyJwk, key.keyId)]);
  await assert.rejects(publisher.call("renew_mail_sync", [account.id, "lease-a"]));
  const stored = (await publisher.sql<{ encrypted_password: string }>("SELECT * FROM mail_connection_secret"))[0].encrypted_password;
  assert(!stored.includes("rotated-fixture"));
  assert.equal(decryptMailPassword(stored, key), "rotated-fixture");
  await owner.call("delete_mail_connection", [account.id]);
  assert.equal((await publisher.sql("SELECT * FROM mail_connection_secret")).length, 0);
  assert.equal((await publisher.sql("SELECT * FROM mail_sync_cursor")).length, 0);
  assert.equal((await owner.sql("SELECT * FROM page WHERE parent_pk = ?", [account.root_page_id])).length, 1);
  console.log("PASS: pause fences in-flight writes, credential rotation, disconnect removes secrets and preserves mail pages");
} finally {
  for (const socket of sockets) socket.close();
  if (process.env.PEAR_MAIL_KEEP_FIXTURE === "true") console.log(`UI fixture: ${name}`);
  else await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${publisherIdentity.token}` } });
}
