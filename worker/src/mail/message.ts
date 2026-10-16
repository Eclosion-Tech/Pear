import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import type { FetchMessageObject } from "imapflow";

export interface MailMessage {
  eventKey: string;
  account: string;
  folder: string;
  direction: "sent" | "received";
  uidValidity: string;
  uid: number;
  messageId: string;
  inReplyTo: string;
  references: string[];
  date: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  note: string;
}

export function eventKey(accountKey: string, folder: string, validity: string, uid: number): string {
  return createHash("sha256").update(JSON.stringify([accountKey, folder, validity, uid])).digest("hex");
}
export function cap(value: string | undefined, limit: number): string {
  return (value ?? "").replace(/\u0000/g, "").slice(0, limit);
}
export async function parseMessage(
  metadata: FetchMessageObject, source: Buffer | undefined,
  context: Pick<MailMessage, "account" | "folder" | "direction" | "uidValidity"> & { accountKey: string },
): Promise<MailMessage> {
  const envelope = metadata.envelope;
  const address = (items: unknown): string =>
    Array.isArray(items) ? items.map((a: { name?: string; address?: string }) =>
      a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? "").join(", ") : "";
  const result: MailMessage = {
    eventKey: eventKey(context.accountKey, context.folder, context.uidValidity, metadata.uid),
    account: context.account, folder: context.folder, direction: context.direction,
    uidValidity: context.uidValidity, uid: metadata.uid,
    messageId: cap(envelope?.messageId, 1000), inReplyTo: cap(envelope?.inReplyTo, 1000), references: [],
    date: metadata.internalDate instanceof Date ? metadata.internalDate.toISOString() :
      envelope?.date instanceof Date ? envelope.date.toISOString() : "",
    from: cap(address(envelope?.from), 2000), to: cap(address(envelope?.to), 2000), cc: cap(address(envelope?.cc), 2000),
    subject: cap(envelope?.subject || "(no subject)", 200), text: "",
    note: source ? "" : "Body not imported: message exceeds the configured size limit or is unavailable.",
  };
  if (!source) return result;
  try {
    const mail = await simpleParser(source, {
      skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true,
      maxHtmlLengthToParse: 100_000,
    });
    const addresses = (v: typeof mail.to) => Array.isArray(v) ? v.map((a) => a.text).join(", ") : v?.text;
    result.subject = cap(mail.subject || result.subject, 200);
    result.from = cap(mail.from?.text || result.from, 2000);
    result.to = cap(addresses(mail.to) || result.to, 2000);
    result.cc = cap(addresses(mail.cc) || result.cc, 2000);
    result.messageId = cap(mail.messageId || result.messageId, 1000);
    result.inReplyTo = cap(mail.inReplyTo || result.inReplyTo, 1000);
    result.references = (Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])
      .slice(-20).map((r) => cap(r, 300));
    const body = mail.text || "";
    result.text = cap(body, 40_000);
    const notes = [
      body.length > 40_000 ? "Body truncated to 40,000 characters." : "",
      !body && mail.html ? "HTML body could not be converted to text." : "",
      mail.attachments.length ? `${mail.attachments.length} attachment(s) omitted; open the original email to read them.` : "",
    ];
    result.note = notes.filter(Boolean).join(" ");
  } catch {
    result.note = "Body could not be parsed. Open the original email; this record contains envelope metadata only.";
  }
  return result;
}
