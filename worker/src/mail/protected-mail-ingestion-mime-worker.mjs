/** Private bounded parser worker. No credentials or inherited environment.
 * This is not an OS sandbox or a preallocation/external-Buffer bound. */
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
const { MailParser } = createRequire(import.meta.url)("mailparser");
const raw = Buffer.from(workerData.raw.buffer, workerData.raw.byteOffset, workerData.raw.byteLength);
let settled = false, attachmentCount = 0, decoded = 0, text, headers, parser, source;
const finish = value => {
  if (settled) return;
  settled = true; source?.destroy(); parser?.destroy(); raw.fill(0); parentPort.postMessage(value);
};
const failure = () => finish({ kind: "failed" });
const held = () => finish({ kind: "held", reason: "unsupported_content" });
function scalar(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
const bounded = (value, max, multiline = false) => typeof value === "string" && scalar(value) && Buffer.byteLength(value) <= max
  && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value);
const addresses = value => value === undefined ? "" : Array.isArray(value) ? value.map(item => item.text).join(", ") : value.text;
process.on("uncaughtException", failure); process.on("unhandledRejection", failure);
try {
  if (raw.length > 524288 || Object.keys(process.env).length) failure();
  else {
    parser = new MailParser({ skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true,
      keepDeliveryStatus: true, ignoreEmbedded: true, maxHeadSize: 16384, maxChildNodes: 64, maxHtmlLengthToParse: 65536 });
    parser.on("error", failure);
    parser.on("headers", value => { headers = value; });
    parser.on("data", data => {
      if (data.type === "attachment") {
        attachmentCount++;
        data.content.on("data", bytes => { decoded += bytes.length; if (decoded > 262144) failure(); });
        data.content.once("error", failure); data.content.once("end", () => data.release()); data.content.resume();
      } else if (data.type === "text") {
        if (text !== undefined) { failure(); return; }
        text = data;
        decoded += Buffer.byteLength(data.text ?? "") + Buffer.byteLength(typeof data.html === "string" ? data.html : "");
        if (decoded > 262144) failure();
      } else failure();
    });
    parser.on("end", () => {
      if (settled) return;
      if (!headers || !text || typeof text.text !== "string" || !text.text.length || text.textConversionError) { held(); return; }
      const date = headers.get("date"), messageDate = date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
      const result = { kind: "prepared", messageDate, from: addresses(headers.get("from")), to: addresses(headers.get("to")),
        cc: addresses(headers.get("cc")), subject: headers.get("subject") ?? "", body: text.text, note: attachmentCount ? "Attachments omitted." : "" };
      if (!bounded(result.subject, 1024) || !bounded(result.from, 2048) || !bounded(result.to, 2048) || !bounded(result.cc, 2048)
        || !bounded(result.messageDate, 64) || !bounded(result.body, 65536, true)) { held(); return; }
      finish(result);
    });
    source = Readable.from((async function* () { for (let i = 0; i < raw.length; i += 4096) yield raw.subarray(i, i + 4096); })());
    source.on("error", failure); source.pipe(parser);
  }
} catch { failure(); }
