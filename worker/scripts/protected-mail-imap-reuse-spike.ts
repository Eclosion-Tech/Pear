/** PRIVATE SYNTHETIC experiment. This is not a production IMAP adapter.
 * No external endpoints, environment credentials, raw diagnostics or transcripts.
 * ImapFlow public APIs/options only; the optional transport is an explicit probe.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LookupFunction, Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { connect, createServer, type ConnectionOptions } from "node:tls";
import { performance } from "node:perf_hooks";
import { ImapFlow, type ImapFlowOptions, type ImapTransport, type ImapTransportSocket } from "imapflow";
import { createExecutorFixtureCertificates, EXECUTOR_FIXTURE_HOST } from "./protected-mail-executor-fixture.ts";

type Mode = "normal" | "cap" | "duplicate" | "wrong_uid" | "uid_after_body" | "throttle" | "line" | "literal" | "response" | "aggregate" | "hang";
type Label = "CAPABILITY" | "ID" | "AUTHENTICATE" | "NAMESPACE" | "LIST" | "LSUB" | "EXAMINE" | "UID_FETCH" | "NOOP" | "OTHER";
type Code = "ok" | "LineTooLarge" | "LiteralTooLarge" | "ResponseTooLarge" | "ETHROTTLE" | "adapter_rejected" | "adapter_limit" | "adapter_deadline" | "closed" | "unexpected";
interface Stats {
  tcp: number; tls: number; closed: number; auth: number; authMatched: boolean;
  commands: Partial<Record<Label, number>>; fetches: number; exactUidPeek: boolean; extraEmailId: boolean;
}
const USER = "reuse-fixture@example.test", PASS = "PRIVATE_SYNTHETIC_REUSE_PASSWORD";
const RAW = Buffer.from([0x00, 0xff, 0x61]);
let currentCase = "setup";
let completed = 0;
const stopAt = Date.now() + 50000;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const fixed = (code: Code) => Object.assign(new Error("imap_reuse_probe_failure"), { code });
function check(condition: unknown): asserts condition { if (!condition) throw fixed("unexpected"); }
function code(error: unknown): Code {
  const c = error && typeof error === "object" && "code" in error ? error.code : "";
  return ["LineTooLarge", "LiteralTooLarge", "ResponseTooLarge", "ETHROTTLE", "adapter_rejected", "adapter_limit", "adapter_deadline", "unexpected"].includes(String(c)) ? c as Code : "closed";
}

async function fixture(certificates: Awaited<ReturnType<typeof createExecutorFixtureCertificates>>, options: { mode?: Mode; namespace?: boolean; objectId?: boolean; greeting?: boolean } = {}) {
  const stats: Stats = { tcp: 0, tls: 0, closed: 0, auth: 0, authMatched: true, commands: {}, fetches: 0, exactUidPeek: true, extraEmailId: false };
  const sockets = new Set<Socket>(), secureSockets = new Set<Socket>();
  const server = createServer({ key: await readFile(join(certificates.directory, "server.key")), cert: await readFile(join(certificates.directory, "server.pem")), minVersion: "TLSv1.2" }, socket => {
    secureSockets.add(socket); socket.on("close", () => secureSockets.delete(socket));
    stats.tls++;
    let input = Buffer.alloc(0), authTag: string | undefined;
    socket.on("error", () => {});
    const write = (value: string | Buffer) => { if (!socket.destroyed) socket.write(value); };
    if (options.greeting !== false) write("* OK synthetic ready\r\n");
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 8192) { socket.destroy(); return; }
      for (;;) {
        const end = input.indexOf("\r\n"); if (end < 0) return;
        const bytes = input.subarray(0, end); input = input.subarray(end + 2);
        if (authTag !== undefined) {
          stats.auth++; stats.authMatched &&= bytes.equals(Buffer.from(Buffer.from(`\0${USER}\0${PASS}`).toString("base64")));
          write(`${authTag} ${stats.authMatched ? "OK" : "NO"} authenticated\r\n`); authTag = undefined; continue;
        }
        const match = /^([^\s]+) (.+)$/.exec(bytes.toString("ascii"));
        if (!match) { socket.destroy(); return; }
        const [, tag, operation] = match;
        const label: Label = operation.startsWith("UID FETCH ") ? "UID_FETCH" : (["CAPABILITY", "ID", "AUTHENTICATE", "NAMESPACE", "LIST", "LSUB", "EXAMINE", "NOOP"].includes(operation.split(" ")[0]) ? operation.split(" ")[0] as Label : "OTHER");
        stats.commands[label] = (stats.commands[label] ?? 0) + 1;
        if (label === "CAPABILITY") write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN ID${options.namespace === false ? "" : " NAMESPACE"}${options.objectId ? " OBJECTID" : ""}\r\n${tag} OK capabilities\r\n`);
        else if (label === "ID") write(`* ID ("name" "synthetic" "version" "1")\r\n${tag} OK identified\r\n`);
        else if (operation === "AUTHENTICATE PLAIN") { authTag = tag; write("+\r\n"); }
        else if (label === "NAMESPACE") write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK namespaces\r\n`);
        else if (label === "LIST") write(`* LIST () "/" "${operation === 'LIST "" ""' ? "" : "INBOX"}"\r\n${tag} OK listed\r\n`);
        else if (label === "LSUB") write(`* LSUB () "/" "INBOX"\r\n${tag} OK subscribed\r\n`);
        else if (label === "EXAMINE") write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT 10] next\r\n${tag} OK [READ-ONLY] examined\r\n`);
        else if (label === "NOOP") write(`${tag} OK still ready\r\n`);
        else if (label === "UID_FETCH") {
          stats.fetches++;
          const fetch = /^UID FETCH 9 \((.*)\)$/.exec(operation);
          const limit = /BODY\.PEEK\[\]<0\.([1-9][0-9]*)>/.exec(operation);
          stats.exactUidPeek &&= Boolean(fetch && limit && operation.includes("RFC822.SIZE") && operation.includes("UID ") && !operation.includes(":"));
          stats.extraEmailId ||= operation.includes("EMAILID");
          const n = Number(limit?.[1] ?? 16), mode = options.mode ?? "normal";
          if (mode === "hang") continue;
          if (mode === "throttle") { write(`${tag} BAD Request is throttled. Suggested Backoff Time: 1 milliseconds\r\n`); continue; }
          if (mode === "line") { write(`* OK ${"x".repeat(256)}\r\n`); continue; }
          if (mode === "literal") { write("* 1 FETCH (UID 9 RFC822.SIZE 65 BODY[]<0> {65}\r\n"); continue; }
          if (mode === "response") { write(Buffer.concat([Buffer.from("* 1 FETCH (UID 9 BODY[] {64}\r\n"), Buffer.alloc(64), Buffer.from(" BODY[HEADER] {64}\r\n"), Buffer.alloc(64), Buffer.from(")\r\n")])); continue; }
          if (mode === "aggregate") { for (let i = 0; i < 80; i++) write(`* OK ${"x".repeat(50)}\r\n`); continue; }
          const body = mode === "cap" ? Buffer.alloc(n, 0x61) : RAW;
          const uid = mode === "wrong_uid" ? 8 : 9;
          const row = mode === "uid_after_body"
            ? Buffer.concat([Buffer.from(`* 1 FETCH (BODY[]<0> {${body.length}}\r\n`), body, Buffer.from(` UID ${uid} RFC822.SIZE ${body.length})\r\n`)])
            : Buffer.concat([Buffer.from(`* 1 FETCH (UID ${uid} RFC822.SIZE ${body.length} BODY[]<0> {${body.length}}\r\n`), body, Buffer.from(")\r\n")]);
          write(Buffer.concat([row, ...(mode === "duplicate" ? [row] : []), Buffer.from(`${tag} OK fetched\r\n`)]));
        } else { write(`${tag} BAD unsupported\r\n`); }
      }
    });
  });
  server.on("connection", socket => { stats.tcp++; sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); stats.closed++; }); });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address(); check(address && typeof address === "object");
  return { stats, port: address.port, close: async () => { for (const s of secureSockets) s.destroy(); for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); for (let i = 0; i < 50 && (sockets.size || secureSockets.size); i++) await wait(10); check(sockets.size === 0 && secureSockets.size === 0); } };
}

/** Explicit PUBLIC transport experiment, not an installed runtime adapter.
 * Limits accepted decrypted bytes before parser delivery. This is not an OS/TLS
 * receive-memory bound. Policy rejects a second outbound FETCH before socket.write.
 */
function boundedTransport(options: { maxBytes?: number; oneFetch?: boolean; deadlineMs?: number }, stats: { received: number; delivered: number; blocked: number }): ImapTransport {
  return { connect(input, ready) {
    check(input.secure && input.host === EXECUTOR_FIXTURE_HOST);
    const tlsOptions: ConnectionOptions & { autoSelectFamily: false } = { ...input.tls, host: "127.0.0.1", port: input.port, servername: EXECUTOR_FIXTURE_HOST, rejectUnauthorized: true, minVersion: "TLSv1.2", autoSelectFamily: false };
    const raw = connect(tlsOptions);
    let fetches = 0;
    const stream = new Duplex({
      read() { raw.resume(); },
      write(chunk: Buffer, _encoding, done) {
        // Pinned compiler-generated frames only: this demonstrates a seam, not a
        // complete production outbound-command allowlist. No raw frames retained.
        if (options.oneFetch && / UID FETCH /.test(chunk.toString("ascii")) && ++fetches > 1) { stats.blocked++; done(fixed("adapter_rejected")); return; }
        raw.write(chunk, done);
      },
      destroy(error, done) { clearTimeout(timer); raw.destroy(); done(error); }
    }) as ImapTransportSocket;
    stream.setTimeout = ms => { raw.setTimeout(ms); return stream; };
    stream.getCipher = () => raw.getCipher();
    const timer = setTimeout(() => stream.destroy(fixed("adapter_deadline")), options.deadlineMs ?? 15000);
    raw.on("secureConnect", () => { stream.authorized = raw.authorized; ready(); });
    raw.on("data", (chunk: Buffer) => {
      stats.received += chunk.length;
      if (stats.received > (options.maxBytes ?? 65536)) { stream.destroy(fixed("adapter_limit")); return; }
      stats.delivered += chunk.length; if (!stream.push(chunk)) raw.pause();
    });
    raw.on("timeout", () => stream.emit("timeout"));
    raw.on("error", error => stream.destroy(error)); raw.on("end", () => stream.push(null)); raw.on("close", () => stream.destroy());
    return stream;
  } };
}

interface CaseOptions {
  mode?: Mode; namespace?: boolean; objectId?: boolean; greeting?: boolean;
  limits?: Pick<ImapFlowOptions, "maxLineLength" | "maxLiteralSize" | "maxResponseSize">;
  transport?: { maxBytes?: number; oneFetch?: boolean; deadlineMs?: number };
  iterator?: boolean; closeAfterMs?: number; delayedDns?: boolean;
}
async function probe(certificates: Awaited<ReturnType<typeof createExecutorFixtureCertificates>>, name: string, options: CaseOptions, assert: (result: { outcome: Code; rows: number; bytes: number; stats: Stats; transport: { received: number; delivered: number; blocked: number } }) => void) {
  currentCase = name;
  check(Date.now() < stopAt);
  const start = performance.now(), f = await fixture(certificates, options), transportStats = { received: 0, delivered: 0, blocked: 0 };
  let client: ImapFlow | undefined, timer: ReturnType<typeof setTimeout> | undefined, cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let outcome: Code = "ok", rows = 0, bytes = 0;
  const asyncCodes: Code[] = [];
  try {
    const lookup: LookupFunction = (_host, _options, done) => {
      if (options.delayedDns) setTimeout(() => done(null, "127.0.0.1", 4), 100);
      else done(null, "127.0.0.1", 4);
    };
    client = new ImapFlow({ host: EXECUTOR_FIXTURE_HOST, port: f.port, secure: true,
      auth: { user: USER, pass: PASS, loginMethod: "AUTH=PLAIN" }, logger: false, logRaw: false, emitLogs: false,
      disableAutoIdle: true, disableAutoEnable: true, disableCompression: true, disableBinary: true, disableIMAP4rev2: true,
      tls: { ca: certificates.ca, rejectUnauthorized: true, minVersion: "TLSv1.2", lookup, autoSelectFamily: false } as ImapFlowOptions["tls"],
      maxLineLength: 8192, maxLiteralSize: 1024, maxResponseSize: 8192, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000,
      ...options.limits,
      ...(options.transport ? { transport: boundedTransport(options.transport, transportStats) } : {})
    });
    client.on("error", error => { asyncCodes.push(code(error)); });
    // External one-attempt absolute deadline is required even with socketTimeout.
    timer = setTimeout(() => client?.close(), Math.min(12000, stopAt - Date.now()));
    if (options.closeAfterMs !== undefined) cancelTimer = setTimeout(() => client?.close(), options.closeAfterMs);
    try {
      await client.connect();
      await client.mailboxOpen("INBOX", { readOnly: true });
      const query = { uid: true, size: true, source: { start: 0, maxLength: 16 } };
      const validate = (row: { uid: number; size?: number; source?: Buffer }) => {
        rows++; bytes += row.source?.length ?? 0;
        if (row.uid !== 9 || !row.source || row.source.length >= 16 || row.size !== row.source.length || rows !== 1) throw fixed("adapter_rejected");
        if (!createHash("sha256").update(row.source).digest().equals(createHash("sha256").update(RAW).digest())) throw fixed("adapter_rejected");
      };
      if (options.iterator) { for await (const row of client.fetch("9", query, { uid: true })) validate(row); }
      else { const row = await client.fetchOne("9", query, { uid: true }); if (row) validate(row); }
    } catch (error) { outcome = code(error); }
    if (outcome === "closed" && asyncCodes.length) outcome = asyncCodes.find(c => c !== "closed") ?? outcome;
  } finally {
    clearTimeout(timer); clearTimeout(cancelTimer); client?.close();
    if (options.delayedDns) await wait(150);
    await f.close();
  }
  check(f.stats.authMatched);
  const result = { outcome, rows, bytes, stats: f.stats, transport: transportStats };
  // Only allowlisted labels/counters/fixed codes. Never serialize an Error/client/row.
  console.log(JSON.stringify({ case: name, status: "observed", outcome, commands: f.stats.commands, tcpConnections: f.stats.tcp,
    fetchAttempts: f.stats.fetches, exactUidPeek: f.stats.exactUidPeek, extraEmailId: f.stats.extraEmailId,
    rows, capturedBytes: bytes, transportDeliveredBytes: transportStats.delivered, blockedWrites: transportStats.blocked,
    cleanup: "complete", durationMs: Math.round(performance.now() - start) }));
  assert(result);
  completed++;
}

async function main() {
  check(process.argv.length === 2);
  check(ImapFlow.version === "2.5.2");
  const start = performance.now(), certificates = await createExecutorFixtureCertificates();
  try {
    await probe(certificates, "public_setup_namespace", {}, r => { check(r.outcome === "ok" && r.rows === 1 && r.stats.commands.ID === 1 && r.stats.commands.NAMESPACE === 1 && (r.stats.commands.LIST ?? 0) >= 1 && r.stats.exactUidPeek); });
    await probe(certificates, "public_setup_list_fallback", { namespace: false }, r => { check(r.outcome === "ok" && !r.stats.commands.NAMESPACE && (r.stats.commands.LIST ?? 0) >= 2); });
    await probe(certificates, "public_fetch_objectid", { objectId: true }, r => { check(r.outcome === "ok" && r.stats.extraEmailId); });
    await probe(certificates, "public_valid_uid_after_literal", { mode: "uid_after_body", iterator: true }, r => { check(r.outcome === "ok" && r.bytes === RAW.length); });
    await probe(certificates, "adapter_exact_cap_incomplete", { mode: "cap", iterator: true }, r => { check(r.outcome === "adapter_rejected" && r.bytes === 16); });
    await probe(certificates, "public_fetchone_merges_duplicate", { mode: "duplicate" }, r => { check(r.outcome === "ok" && r.rows === 1); });
    await probe(certificates, "adapter_iterator_rejects_duplicate", { mode: "duplicate", iterator: true }, r => { check(r.outcome === "adapter_rejected" && r.rows === 2); });
    await probe(certificates, "adapter_iterator_rejects_wrong_uid", { mode: "wrong_uid", iterator: true }, r => { check(r.outcome === "adapter_rejected" && r.rows === 1); });
    await probe(certificates, "public_throttle_four_attempts", { mode: "throttle" }, r => { check(r.outcome === "ETHROTTLE" && r.stats.fetches === 4 && r.stats.tcp === 1); });
    await probe(certificates, "public_close_aborts_throttle_wait", { mode: "throttle", closeAfterMs: 100 }, r => { check(r.outcome === "closed" && r.stats.fetches === 1 && r.stats.tcp === 1); });
    await probe(certificates, "transport_blocks_second_fetch", { mode: "throttle", transport: { oneFetch: true } }, r => { check(r.stats.fetches === 1 && r.transport.blocked === 1 && r.outcome !== "ok"); });
    await probe(certificates, "public_parser_line_cap", { mode: "line", limits: { maxLineLength: 128 } }, r => { check(r.outcome === "LineTooLarge"); });
    await probe(certificates, "public_parser_literal_cap", { mode: "literal", limits: { maxLiteralSize: 64 } }, r => { check(r.outcome === "LiteralTooLarge" && r.bytes === 0); });
    await probe(certificates, "public_parser_response_cap", { mode: "response", limits: { maxLineLength: 128, maxLiteralSize: 64, maxResponseSize: 128 } }, r => { check(r.outcome === "ResponseTooLarge" && r.bytes === 0); });
    await probe(certificates, "transport_total_accepted_byte_cap", { mode: "aggregate", transport: { maxBytes: 1024 } }, r => { check(r.outcome === "adapter_limit" && r.transport.delivered <= 1024); });
    await probe(certificates, "transport_absolute_deadline", { mode: "hang", transport: { deadlineMs: 200 } }, r => { check(r.outcome === "adapter_deadline" && r.stats.tcp === 1); });
    await probe(certificates, "public_close_pending_greeting", { greeting: false, closeAfterMs: 100 }, r => { check(r.outcome === "closed" && r.stats.auth === 0 && r.stats.tcp === 1); });
    await probe(certificates, "public_close_before_delayed_dns", { delayedDns: true, closeAfterMs: 20 }, r => { check(r.outcome === "closed" && r.stats.tcp === 0); });
  } finally { await certificates.close(); }
  check(performance.now() - start < 60000);
  console.log(JSON.stringify({ case: "summary", status: "complete", library: "imapflow", version: "2.5.2", cases: completed, cleanup: "complete", durationMs: Math.round(performance.now() - start) }));
}
main().catch(error => { console.error(JSON.stringify({ case: currentCase, status: "failed", code: "imap_reuse_probe_failed", reason: code(error) })); process.exitCode = 1; });
