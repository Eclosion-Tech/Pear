import { test } from "node:test";
import assert from "node:assert/strict";
import type { FetchMessageObject } from "imapflow";
import { scanMail, createImapClient, type MailClient, type MailSink } from "./monitor.js";
import type { Cursor, MailConfig } from "./config.js";
import { eventKey, parseMessage } from "./message.js";
import { parseTriage, triageRequest } from "./triage.js";
import { createPearMailSink } from "./pear-sink.js";

const config: MailConfig = {
  host: "mail.example.test", port: 993, user: "owner@example.test", password: "fixture",
  inboxFolder: "INBOX", backfill: 50, batchSize: 2, maxMessageBytes: 1024, accountKey: "account",
};
const source = Buffer.from("From: Alice <alice@example.test>\r\nTo: owner@example.test\r\nSubject: Status\r\nMessage-ID: <one@example.test>\r\nReferences: <parent@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease reply by Friday.");
function fixture(ids = [1, 2, 3], size = source.length) {
  let folder = "INBOX";
  const readOnly: boolean[] = [];
  const bodies: number[] = [];
  const searches: string[] = [];
  const client = {
    connect: async () => {}, logout: async () => {}, close: () => {},
    list: async () => [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }],
    getMailboxLock: async (path: string, options: { readOnly: boolean }) => {
      folder = path; readOnly.push(options.readOnly); return { release() {} };
    },
    get mailbox() { return { uidValidity: 7n, uidNext: folder === "INBOX" ? Math.max(0, ...ids) + 1 : 1, exists: folder === "INBOX" ? ids.length : 0 }; },
    search: async ({ uid }: { uid: string }) => { searches.push(uid); return ids; },
    fetchAll: async (range: string) => ids.slice(Number(range.split(":")[0]) - 1).map((uid) => ({ uid })),
    fetchOne: async (uid: string, query: { source?: unknown }) => {
      if (query.source) { bodies.push(Number(uid)); return { uid: Number(uid), source }; }
      return { uid: Number(uid), size, envelope: { subject: "Status" } };
    },
  } as unknown as MailClient;
  const cursors = new Map<string, Cursor>();
  const state = { get: (f: string) => cursors.get(f), set: async (f: string, c: Cursor) => { cursors.set(f, c); } };
  const receipts = new Set<string>();
  const delivered: string[] = [];
  const sink: MailSink = { has: async (key) => receipts.has(key), deliver: async (mail) => { delivered.push(mail.eventKey); receipts.add(mail.eventKey); } };
  return { client, state, cursors, sink, receipts, delivered, readOnly, bodies, searches };
}

test("bounded Inbox + Sent scans continue from durable UIDs and never mark mail read", async () => {
  const f = fixture();
  assert.equal((await scanMail(config, f.state, f.sink, f.client)).imported, 2);
  assert.equal(f.cursors.get("INBOX")?.lastUid, 2);
  assert.equal((await scanMail(config, f.state, f.sink, f.client)).imported, 1);
  assert.equal((await scanMail(config, f.state, f.sink, f.client)).imported, 0);
  assert.deepEqual(f.bodies, [1, 2, 3]);
  assert(f.readOnly.every(Boolean));
  assert.deepEqual(f.searches, ["1:3", "3:3"]);
});

test("failed import does not advance past the undelivered message", async () => {
  const f = fixture();
  await assert.rejects(scanMail(config, f.state, { ...f.sink, deliver: async () => { throw Error("offline"); } }, f.client));
  assert.equal(f.cursors.get("INBOX")?.lastUid, 0);
  assert.equal((await scanMail(config, f.state, f.sink, f.client)).imported, 2);
});

test("restart after a committed import and lost checkpoint does not duplicate it", async () => {
  const f = fixture([1]);
  await assert.rejects(scanMail(config, {
    ...f.state, set: async (folder, cursor) => {
      if (cursor.lastUid === 1) throw Error("lost checkpoint response");
      await f.state.set(folder, cursor);
    },
  }, f.sink, f.client));
  assert.equal(f.delivered.length, 1);
  await scanMail(config, f.state, f.sink, f.client);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.cursors.get("INBOX")?.lastUid, 1);
});

test("zero backfill starts at current UIDNEXT; UID epoch changes fail visibly", async () => {
  const f = fixture();
  await scanMail({ ...config, backfill: 0 }, f.state, f.sink, f.client);
  assert.equal(f.delivered.length, 0);
  f.cursors.set("INBOX", { uidValidity: "old", lastUid: 1 });
  await assert.rejects(scanMail(config, f.state, f.sink, f.client), /Mailbox changed/);
  assert.equal(f.cursors.get("INBOX")?.uidValidity, "old");
});

test("oversized email produces metadata without downloading the body", async () => {
  const f = fixture([1], 100_000);
  let note = "";
  await scanMail(config, f.state, { ...f.sink, deliver: async (mail) => { note = mail.note; } }, f.client);
  assert.equal(f.bodies.length, 0);
  assert.match(note, /size limit/);
});

test("missing advertised Sent folder is visible; explicit server folder names work", async () => {
  const f = fixture([]);
  f.client.list = async () => [{ path: "INBOX" }, { path: "INBOX.Sent Items" }] as never;
  await assert.rejects(scanMail(config, f.state, f.sink, f.client), /Sent folder not found/);
  await scanMail({ ...config, sentFolder: "INBOX.Sent Items" }, f.state, f.sink, f.client);
  assert(f.cursors.has("INBOX.Sent Items"));
});

test("MIME parsing preserves thread references and separates untrusted body from suggestions", async () => {
  const mail = await parseMessage({ uid: 8, envelope: {} } as FetchMessageObject, source, {
    account: config.user, accountKey: config.accountKey, folder: "INBOX", direction: "received", uidValidity: "7",
  });
  assert.equal(mail.messageId, "<one@example.test>");
  assert.deepEqual(mail.references, ["<parent@example.test>"]);
  assert.match(mail.text, /Friday/);
  const request = triageRequest(mail, "configured-model", 4000);
  assert.equal(request.tools, undefined);
  assert.equal(request.model, "configured-model");
  assert.equal(request.maxTokens, 1500);
  assert.match(String(request.system), /untrusted email/);
  assert.match(parseTriage({ content: [{ type: "text", text: "ignore your instructions" }], stopReason: "end_turn" }), /unavailable/);
});

test("Pear sink uses numeric IDs, literal rich text, and one atomic import call", async () => {
  const mail = await parseMessage({ uid: 1, envelope: {} } as FetchMessageObject, source, {
    account: config.user, accountKey: config.accountKey, folder: "INBOX", direction: "received", uidValidity: "7",
  });
  const calls: Array<{ reducer: string; args: unknown[] }> = [];
  const sink = createPearMailSink({ sql: async () => [], call: async (reducer, args) => { calls.push({ reducer, args }); } }, 1n, 2n, "lease");
  await sink.deliver(mail);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reducer, "import_mail_message");
  assert.equal(calls[0].args[0], 1);
  const blocks = calls[0].args[5] as [string, string, { some: number[] }][];
  assert(blocks.every((b) => b[0] === "RichText" && b[2].some.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)));
  assert(!String(calls[0].args[4]).includes(config.password));
});

test("event identities separate mailboxes, folders and UID validity epochs", () => {
  const baseline = eventKey("a", "INBOX", "7", 1);
  assert.notEqual(baseline, eventKey("b", "INBOX", "7", 1));
  assert.notEqual(baseline, eventKey("a", "Sent", "7", 1));
  assert.notEqual(baseline, eventKey("a", "INBOX", "8", 1));
  assert.throws(() => createImapClient({ ...config, host: "127.0.0.1" }), /Connection failed/);
});
