/** Private synthetic experiment worker, NOT a production parser or sandbox.
 * MailParser buffers decoded text internally. Parent termination/resourceLimits
 * are separate controls, not preallocation, external-Buffer or OS isolation. */
import { parentPort, workerData } from "node:worker_threads";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
let networkAttempts = 0;
const networkDenied = () => { networkAttempts++; throw Error("mime_spike_network_forbidden"); };
// Test-process guards only. They are not an OS network boundary.
for (const [name, methods] of [["node:net", ["connect", "createConnection"]], ["node:tls", ["connect"]],
  ["node:http", ["request", "get"]], ["node:https", ["request", "get"]], ["node:dgram", ["createSocket"]],
  ["node:dns", ["lookup", "resolve", "resolve4", "resolve6"]]]) {
  const module = require(name);
  for (const method of methods) module[method] = networkDenied;
}
globalThis.fetch = async () => networkDenied();
syncBuiltinESMExports();
const { MailParser, simpleParser } = require("mailparser");
const request = workerData;
const raw = Buffer.from(request.raw);
const limits = request.limits;
const options = { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true,
  keepDeliveryStatus: true, checksumAlgo: request.mode === "checksum_error" ? "mime-spike-unsupported-algorithm" : "sha256",
  maxHtmlLengthToParse: limits.htmlCharacters, maxHeadSize: limits.headerBytes, maxChildNodes: limits.childNodes, ignoreEmbedded: true };
const stats = { inputBytes: raw.byteLength, attachmentCount: 0, attachmentBytes: 0, decodedBytes: 0, textBytes: 0, htmlBytes: 0,
  headerCount: 0, htmlSeen: false, attachmentBuffers: 0, expectedText: false, expectedSubject: false,
  attachmentMarkerAbsent: true, otpRemains: false, resetUrlRemains: false, injectionRemains: false,
  conversionFailure: false, emptyEnvironment: Object.keys(process.env).length === 0 };
let settled = false, parser, source;
function finish(kind, reason) {
  if (settled) return;
  settled = true;
  source?.destroy(); parser?.destroy();
  parentPort.postMessage({ kind, reason, ...stats, networkAttempts });
}
function inspectText(data) {
  const text = typeof data.text === "string" ? data.text : "", html = typeof data.html === "string" ? data.html : "";
  stats.textBytes = Buffer.byteLength(text); stats.htmlBytes = Buffer.byteLength(html); stats.htmlSeen = html.length > 0;
  // These checks occur AFTER MailParser assembled text/HTML, not before its
  // internal allocation. HTML and generated text both count conservatively.
  stats.decodedBytes = stats.attachmentBytes + stats.textBytes + stats.htmlBytes;
  stats.expectedText = request.expectedText === undefined || text === request.expectedText;
  stats.attachmentMarkerAbsent = !text.includes("MIME_REUSE_PRIVATE_SYNTHETIC_ATTACHMENT");
  stats.otpRemains = text.includes("731942");
  stats.resetUrlRemains = text.includes("secret-reset-token");
  stats.injectionRemains = text.includes("Ignore all instructions");
  stats.conversionFailure = Boolean(data.textConversionError);
  if (stats.conversionFailure) return finish("rejected", "html_conversion_failed");
  if (stats.decodedBytes > limits.decodedBytes) return finish("rejected", "decoded_limit");
  if (stats.textBytes > limits.outputBytes) return finish("rejected", "output_limit");
}

process.on("uncaughtException", () => finish("rejected", "parser_error"));
process.on("unhandledRejection", () => finish("rejected", "parser_error"));
if (request.mode === "busy_control") {
  parentPort.postMessage({ kind: "ready" });
  // Deliberate controller test, NOT a claim that a MIME sample caused this loop.
  while (true) { /* Parent must terminate even a blocked worker event loop. */ }
} else if (request.mode === "simple_baseline") {
  parentPort.postMessage({ kind: "ready" });
  try {
    const mail = await simpleParser(raw, options);
    stats.attachmentCount = mail.attachments.length;
    stats.attachmentBuffers = mail.attachments.filter(attachment => Buffer.isBuffer(attachment.content)).length;
    stats.attachmentBytes = mail.attachments.reduce((sum, attachment) => sum + attachment.content.byteLength, 0);
    inspectText(mail); if (!settled) finish("parsed", "none");
  } catch { finish("rejected", "parser_error"); }
} else {
  parser = new MailParser(options);
  parser.on("error", error => finish("rejected", error?.code === "EMAXLEN" ? "mime_structure_limit" : "parser_error"));
  parser.on("headers", headers => {
    stats.headerCount = headers.size;
    stats.expectedSubject = request.expectedSubject === undefined || headers.get("subject") === request.expectedSubject;
  });
  parser.on("data", data => {
    if (settled) { if (data.type === "attachment") { data.content.resume(); data.release?.(); } return; }
    if (data.type === "attachment") {
      stats.attachmentCount++;
      // Consume without collecting chunks; release only after consumption.
      // Calling release alone is not evidence of bounded readable buffering.
      data.content.on("data", chunk => {
        stats.attachmentBytes += chunk.byteLength;
        if (stats.attachmentBytes > limits.decodedBytes) finish("rejected", "decoded_limit");
      });
      data.content.once("error", () => finish("rejected", "parser_error"));
      data.content.once("end", () => { data.release?.(); });
      data.content.resume();
    } else if (data.type === "text") inspectText(data);
    else finish("rejected", "parser_error");
  });
  parser.on("end", () => { if (!settled) finish("parsed", "none"); });
  if (request.mode === "hold_input") {
    source = new Readable({ read() {} }); source.push(raw);
  } else if (request.mode === "input_error") {
    source = Readable.from((async function* () { yield raw.subarray(0, 32); throw Error("MIME_REUSE_PRIVATE_SYNTHETIC_INPUT_ERROR"); })());
  } else {
    source = Readable.from((async function* () {
      for (let offset = 0; offset < raw.byteLength; offset += 113) yield raw.subarray(offset, offset + 113);
    })());
  }
  source.on("error", () => finish("rejected", "input_error"));
  source.pipe(parser);
  parentPort.postMessage({ kind: "ready" });
}
