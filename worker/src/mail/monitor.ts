import { ImapFlow, type FetchMessageObject } from "imapflow";
import type { MailConfig } from "./config.js";
import { eventKey, parseMessage, type MailMessage } from "./message.js";
import type { Cursor } from "./config.js";
import { isIP } from "node:net";
import { isPrivateIp, publicSocketLookup } from "../ssrf.js";

export class MailMonitorError extends Error {
  constructor(public status: string) { super(status); }
}

export interface Checkpoints {
  get(folder: string): Cursor | undefined;
  set(folder: string, cursor: Cursor): Promise<void>;
}
export interface MailSink {
  has(eventKey: string): Promise<boolean>;
  deliver(message: MailMessage): Promise<void>;
}
export type MailClient = Pick<ImapFlow, "connect" | "logout" | "close" | "list" | "getMailboxLock" | "search" | "fetchAll" | "fetchOne" | "mailbox">;

export function createImapClient(config: MailConfig, allowPrivateHosts = false): ImapFlow {
  if (!allowPrivateHosts && isIP(config.host) && isPrivateIp(config.host)) {
    throw new MailMonitorError("Connection failed — check server and app password");
  }
  const client = new ImapFlow({
    host: config.host, port: config.port, secure: true,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", lookup: allowPrivateHosts ? undefined : publicSocketLookup() },
    logger: false, disableAutoIdle: true,
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
  // Raw protocol errors can contain addresses or server response text. The
  // caller reports a generic cycle failure and retries from the checkpoint.
  client.on("error", () => client.close());
  return client;
}

/** Bounded polling of Inbox + Sent. Read-only EXAMINE and BODY.PEEK leave
 * unread flags alone. Checkpoints advance only after the Pear transaction. */
export async function scanMail(
  config: MailConfig, state: Checkpoints, sink: MailSink, client: MailClient,
): Promise<{ imported: number; folders: number; hasMore: boolean }> {
  let imported = 0;
  let hasMore = false;
  try {
    try { await client.connect(); }
    catch { throw new MailMonitorError("Connection failed — check server and app password"); }
    const mailboxes = await client.list();
    const sent = config.sentFolder || mailboxes.find((m) => m.specialUse === "\\Sent")?.path;
    if (!sent || !mailboxes.some((m) => m.path === sent)) {
      throw new MailMonitorError("Sent folder not found — reconnect with its exact name");
    }
    const folders = [...new Set([config.inboxFolder, sent])];
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        if (!client.mailbox) throw new Error("IMAP mailbox did not open");
        const validity = String(client.mailbox.uidValidity);
        const upper = client.mailbox.uidNext - 1;
        let cursor = state.get(folder);
        if (cursor && cursor.uidValidity !== validity) {
          // A reset must be reviewed: silently replacing the UID epoch can
          // either miss mail or replay a large mailbox as new notifications.
          throw new MailMonitorError("Mailbox changed — reconnect to rescan recent mail");
        }
        if (!cursor) {
          let baseline = upper;
          if (config.backfill > 0 && client.mailbox.exists > 0) {
            const start = Math.max(1, client.mailbox.exists - config.backfill + 1);
            const tail = await client.fetchAll(`${start}:${client.mailbox.exists}`, { uid: true });
            const uids = tail.map((m) => m.uid).filter((uid) => uid <= upper);
            if (uids.length) baseline = Math.min(...uids) - 1;
          }
          cursor = { uidValidity: validity, lastUid: baseline };
          await state.set(folder, cursor);
        }
        if (cursor.lastUid >= upper) continue;
        // Never issue a reversed UID range (IMAP would return older mail).
        const found = await client.search({ uid: `${cursor.lastUid + 1}:${upper}` }, { uid: true });
        if (!found) throw new Error("IMAP UID search failed");
        const pending = found.filter((uid) => uid > cursor!.lastUid && uid <= upper).sort((a, b) => a - b);
        if (pending.length > config.batchSize) hasMore = true;
        for (const uid of pending.slice(0, config.batchSize)) {
          const key = eventKey(config.accountKey, folder, validity, uid);
          if (!await sink.has(key)) {
            const metadata = await client.fetchOne(String(uid), { uid: true, envelope: true, size: true, internalDate: true }, { uid: true });
            // A message may be expunged between SEARCH and FETCH.
            if (metadata) {
              let source: Buffer | undefined;
              if (typeof metadata.size === "number" && metadata.size <= config.maxMessageBytes) {
                const full = await client.fetchOne(String(uid), { source: { start: 0, maxLength: config.maxMessageBytes + 1 } }, { uid: true });
                if (!full) { await state.set(folder, { uidValidity: validity, lastUid: uid }); continue; }
                if (full.source && full.source.length <= config.maxMessageBytes) source = full.source;
              }
              const message = await parseMessage(metadata as FetchMessageObject, source, {
                accountKey: config.accountKey, account: config.user, folder,
                direction: folder === sent ? "sent" : "received", uidValidity: validity,
              });
              await sink.deliver(message);
              imported++;
            }
          }
          await state.set(folder, { uidValidity: validity, lastUid: uid });
        }
        if (pending.length <= config.batchSize) {
          await state.set(folder, { uidValidity: validity, lastUid: upper });
        }
      } finally { lock.release(); }
    }
    return { imported, folders: folders.length, hasMore };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}
