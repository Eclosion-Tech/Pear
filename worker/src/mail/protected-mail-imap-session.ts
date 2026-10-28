/** Internal fixed-profile session. Its sole production caller must first
 * consume a fresh authority claim. A plan object is never a reusable permit. */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { connect, checkServerIdentity, type ConnectionOptions, type TLSSocket } from "node:tls";
import { prepareConnectorRead } from "../../../packages/sentinel/src/index.js";
import { isPrivateIp, publicSocketLookup } from "../ssrf.js";
import { ProtectedMailIngestionCustody } from "./protected-mail-ingestion-custody.js";
import { ProtectedMailImapError, type ProtectedMailImapReason, type ProtectedMailImapSessionOptions,
  type ProtectedMailImapSessionResult, type ProtectedMailReadMessageMetadata } from "./protected-mail-read-types.js";

const MAX_LINE = 8192, MAX_CONTROL = 65536, MAX_RESPONSES = 128;
const fail = (reason: ProtectedMailImapReason): never => { throw new ProtectedMailImapError(reason); };

function scalar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function safePassword(value: unknown): value is string {
  return typeof value === "string" && scalar(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= 4096;
}

/** Pure internal encoder, exported for protocol vectors. No normalization. */
export function encodeProtectedMailImapFolder(value: string): string {
  if (typeof value !== "string" || !scalar(value) || !value || Buffer.byteLength(value, "utf8") > 512
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return fail("protocol_failure");
  let encoded = "", shifted = "";
  const flush = () => {
    if (!shifted) return;
    const bytes = Buffer.alloc(shifted.length * 2);
    for (let i = 0; i < shifted.length; i++) bytes.writeUInt16BE(shifted.charCodeAt(i), i * 2);
    encoded += `&${bytes.toString("base64").replace(/\//g, ",").replace(/=+$/, "")}-`;
    shifted = "";
  };
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) { flush(); encoded += character === "&" ? "&-" : character; }
    else shifted += character;
  }
  flush();
  return `"${encoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface FetchHeader { readonly literalLength: number; }
/** Closed, effect-free header validation. Literal bytes have not been copied. */
export function parseProtectedMailFetchHeader(line: string, uid: number, cap: number): FetchHeader {
  if (!Number.isInteger(uid) || uid < 1 || uid > 0xffffffff || !Number.isSafeInteger(cap) || cap < 1 || cap > 524288)
    return fail("protocol_failure");
  const match = /^\* ([1-9][0-9]*) FETCH \((?:UID ([0-9]+) RFC822\.SIZE ([0-9]+)|RFC822\.SIZE ([0-9]+) UID ([0-9]+)) BODY\[\]<0> \{([0-9]+)\}$/i.exec(line);
  if (!match || line.length > MAX_LINE || BigInt(match[1]) > 0xffffffffn) return fail("protocol_failure");
  const returnedUid = BigInt(match[2] ?? match[5]), size = BigInt(match[3] ?? match[4]), literal = BigInt(match[6]);
  if (returnedUid !== BigInt(uid)) return fail("uid_mismatch");
  if (literal >= BigInt(cap)) return fail("limit_reached"); // An exact cap is always ambiguous/incomplete.
  if (size !== literal) return fail("incomplete_read");
  return Object.freeze({ literalLength: Number(literal) });
}

/** Buffer-only incremental input. No raw literal is decoded or returned. */
class Input {
  private chunks: Buffer[] = [];
  private head = 0;
  private offset = 0;
  private buffered = 0;
  private wake?: () => void;
  private failure?: ProtectedMailImapReason;
  private ended?: ProtectedMailImapReason;
  private secure = false;
  private finished = false;
  private received = 0;
  private control = 0;
  private responses = 0;

  constructor(private readonly socket: TLSSocket, private readonly maxSession: number,
    private readonly guard: () => void) {
    socket.on("secureConnect", () => {
      if (!socket.authorized) { this.stop("tls_failure"); return; }
      this.secure = true; this.notify();
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.finished || this.failure) return;
      try { this.guard(); } catch (error) { this.stop(fixedReason(error)); return; }
      if (!Buffer.isBuffer(chunk)) { this.stop("protocol_failure"); return; }
      this.received += chunk.length;
      if (this.received > this.maxSession) { this.stop("limit_reached"); return; }
      this.chunks.push(chunk); this.buffered += chunk.length;
      if (this.buffered > MAX_CONTROL) socket.pause();
      this.notify();
    });
    socket.on("error", () => this.stop(this.secure ? "transport_closed" : "tls_failure"));
    const ended = () => { this.ended ??= this.secure ? "transport_closed" : "tls_failure"; this.notify(); };
    socket.on("end", ended);
    socket.on("close", ended);
  }
  private notify(): void { const wake = this.wake; this.wake = undefined; wake?.(); }
  stop(reason: ProtectedMailImapReason): void {
    if (this.finished || this.failure) return;
    this.failure = reason; this.chunks = []; this.buffered = 0; this.socket.destroy(); this.notify();
  }
  private check(): void { this.guard(); if (this.failure) fail(this.failure); }
  private async changed(): Promise<void> { await new Promise<void>(resolve => { this.wake = resolve; }); }
  async verified(): Promise<void> {
    this.check();
    while (!this.secure) { if (this.ended) fail(this.ended); await this.changed(); this.check(); }
  }
  private async take(max: number): Promise<Buffer> {
    this.check();
    while (!this.buffered) { if (this.ended) fail(this.ended); await this.changed(); this.check(); }
    const chunk = this.chunks[this.head], size = Math.min(max, chunk.length - this.offset);
    const bytes = chunk.subarray(this.offset, this.offset + size);
    this.offset += size; this.buffered -= size;
    if (this.offset === chunk.length) { this.chunks[this.head] = Buffer.alloc(0); this.head++; this.offset = 0; }
    if (this.head >= 64) { this.chunks.splice(0, this.head); this.head = 0; }
    if (this.buffered < MAX_CONTROL / 2) this.socket.resume();
    return bytes;
  }
  async line(): Promise<string> {
    if (++this.responses > MAX_RESPONSES) return fail("limit_reached");
    const line = Buffer.alloc(MAX_LINE);
    let length = 0;
    while (true) {
      const byte = (await this.take(1))[0];
      if (++this.control > MAX_CONTROL || length >= MAX_LINE) return fail("limit_reached");
      line[length++] = byte;
      if (byte === 0x0a) {
        if (length < 2 || line[length - 2] !== 0x0d) return fail("protocol_failure");
        break;
      }
      if (length >= 2 && line[length - 2] === 0x0d) return fail("protocol_failure");
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0d || byte === 0x7f) return fail("protocol_failure");
    }
    const value = line.subarray(0, length - 2).toString("latin1");
    if (/\[REFERRAL(?:\s|\])/i.test(value)) return fail("protocol_failure");
    return value;
  }
  async literal(length: number, captured?: Buffer): Promise<string> {
    const hash = createHash("sha256");
    let remaining = length, offset = 0;
    while (remaining) {
      const bytes = await this.take(remaining); hash.update(bytes);
      captured?.set(bytes, offset); offset += bytes.length; remaining -= bytes.length;
    }
    return hash.digest("hex");
  }
  write(command: string): void {
    this.check();
    if (this.ended) fail(this.ended);
    try { this.socket.write(command); } catch { fail("transport_closed"); }
  }
  boundary(): void {
    this.check();
    if (this.buffered !== 0) fail("protocol_failure");
  }
  close(): void { this.finished = true; this.chunks = []; this.buffered = 0; this.notify(); this.socket.destroy(); }
}

function fixedReason(error: unknown): ProtectedMailImapReason {
  return error instanceof ProtectedMailImapError ? error.reason : "protocol_failure";
}
function taggedOk(line: string, tag: string): boolean { return line.startsWith(`${tag} `) && /^OK(?: |$)/i.test(line.slice(tag.length + 1)); }
function capabilities(value: string, requirePlain: boolean): void {
  const tokens = value.split(" ");
  if (!tokens.length || tokens.some(token => !/^[A-Za-z0-9=+._-]+$/.test(token))) fail("protocol_failure");
  const caps = new Set(tokens.map(token => token.toUpperCase()));
  if (!caps.has("IMAP4REV1") || caps.has("UTF8=ONLY")) fail("protocol_failure");
  if (requirePlain && !caps.has("AUTH=PLAIN")) fail("authentication_failed");
}
function uint(value: string, positive: boolean, max = 0xffffffffn): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= max && (!positive || value !== "0");
}
function flags(value: string): boolean {
  return value === "" || value.split(" ").every(flag => /^(?:\\(?:[A-Za-z]+|\*)|[A-Za-z0-9$._-]+)$/.test(flag));
}

async function session(input: Input, plan: ProtectedMailImapSessionOptions["plan"], password: string,
  custody?: ProtectedMailIngestionCustody): Promise<ProtectedMailImapSessionResult> {
  const greeting = await input.line();
  if (!/^\* OK(?: |$)/i.test(greeting)) return fail("protocol_failure");
  input.boundary();
  input.write("C1 CAPABILITY\r\n");
  const capability = await input.line();
  if (!/^\* CAPABILITY /i.test(capability)) return fail("protocol_failure");
  capabilities(capability.slice(13), true);
  if (!taggedOk(await input.line(), "C1")) return fail("protocol_failure");
  input.boundary();
  input.write("C2 AUTHENTICATE PLAIN\r\n");
  if (!/^\+ ?$/.test(await input.line())) return fail("authentication_failed");
  const username = plan.selection.mailbox.username;
  const auth = Buffer.alloc(Buffer.byteLength(username, "utf8") + Buffer.byteLength(password, "utf8") + 2);
  let offset = 1; offset += auth.write(username, offset, "utf8"); offset++; auth.write(password, offset, "utf8");
  try { input.write(`${auth.toString("base64")}\r\n`); } finally { auth.fill(0); }
  const authenticated = await input.line();
  if (!taggedOk(authenticated, "C2")) return fail("authentication_failed");
  const refreshed = /\[CAPABILITY ([^\]]+)\]/i.exec(authenticated);
  if (refreshed) capabilities(refreshed[1], false);
  input.boundary();
  input.write(`C3 EXAMINE ${encodeProtectedMailImapFolder(plan.selection.mailbox.folder)}\r\n`);
  let validity: string | undefined;
  while (true) {
    const line = await input.line();
    if (taggedOk(line, "C3")) {
      if (!/^C3 OK \[READ-ONLY\](?: |$)/i.test(line)) return fail("read_only_required");
      if (validity !== plan.selection.selection.uidValidity) return fail("uid_validity_mismatch");
      input.boundary();
      break;
    }
    const uidv = /^\* OK \[UIDVALIDITY ([0-9]+)\](?: |$)/i.exec(line);
    if (uidv) {
      if (validity !== undefined || !uint(uidv[1], true)) return fail("protocol_failure");
      validity = uidv[1];
      if (validity !== plan.selection.selection.uidValidity) return fail("uid_validity_mismatch");
      continue;
    }
    const flagList = /^\* FLAGS \(([^()]*)\)$/i.exec(line);
    if (flagList && flags(flagList[1])) continue;
    const count = /^\* ([0-9]+) (?:EXISTS|RECENT)$/i.exec(line);
    if (count && uint(count[1], false)) continue;
    const numeric = /^\* OK \[(UIDNEXT|UNSEEN|HIGHESTMODSEQ) ([0-9]+)\](?: |$)/i.exec(line);
    if (numeric && uint(numeric[2], true, numeric[1].toUpperCase() === "HIGHESTMODSEQ" ? 0xffffffffffffffffn : 0xffffffffn)) continue;
    const permanent = /^\* OK \[PERMANENTFLAGS \(([^()]*)\)\](?: |$)/i.exec(line);
    if (permanent && flags(permanent[1])) continue;
    if (/^\* OK \[(?:NOMODSEQ|READ-ONLY|ALERT)\](?: |$)/i.test(line)) continue;
    return fail("protocol_failure");
  }
  const messages: ProtectedMailReadMessageMetadata[] = [];
  let bodyBytes = 0, tagNumber = 4;
  for (const uid of plan.selection.selection.uids) {
    const cap = Math.min(plan.limits.maxMessageBytes, plan.limits.maxTotalBytes - bodyBytes);
    if (cap <= 0) return fail("limit_reached");
    const tag = `C${tagNumber++}`;
    input.write(`${tag} UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[]<0.${cap}>)\r\n`);
    const header = await input.line();
    if (taggedOk(header, tag)) return fail("missing_uid");
    const { literalLength } = parseProtectedMailFetchHeader(header, uid, cap);
    // Allocate only after the same strict UID/SIZE/exact-cap checks. The fixed
    // internal custody has no caller-selected sink and publishes nothing yet.
    const captured = custody?.allocate(uid, literalLength);
    const digest = await input.literal(literalLength, captured);
    if (await input.line() !== ")" || !taggedOk(await input.line(), tag)) return fail("protocol_failure");
    input.boundary();
    bodyBytes += literalLength;
    messages.push(Object.freeze({ uid, bytes: literalLength, digest }));
  }
  return Object.freeze({ messages: Object.freeze(messages), bodyBytes });
}

async function runSession(options: ProtectedMailImapSessionOptions, capture: boolean):
  Promise<{ session: ProtectedMailImapSessionResult; custody?: ProtectedMailIngestionCustody }> {
  const { password, signal, deadlineAtMs, ca, lookup } = options;
  if (!safePassword(password)) return fail("authentication_failed");
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) return fail("deadline_exceeded");
  if (signal.aborted) return fail("aborted");
  const prepared = await prepareConnectorRead(options.plan);
  if (prepared.status !== "prepared") return fail("protocol_failure");
  const plan = prepared.read.manifest, expires = plan.selection.expiresAtMs;
  const custody = capture ? new ProtectedMailIngestionCustody(plan) : undefined;
  let completed = false;
  const deadline = Math.min(deadlineAtMs, expires, Date.now() + 60_000);
  let input: Input | undefined, socket: TLSSocket | undefined, stopped: ProtectedMailImapReason | undefined;
  const guard = () => {
    if (stopped) fail(stopped);
    if (signal.aborted) fail("aborted");
    const now = Date.now();
    if (now >= expires) fail("read_expired");
    if (now >= deadline) fail("deadline_exceeded");
    if (now < plan.selection.notBeforeMs) fail("protocol_failure");
  };
  const stop = (reason: ProtectedMailImapReason) => { stopped ??= reason; input?.stop(reason); socket?.destroy(); };
  const onAbort = () => stop("aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    guard();
    const host = plan.selection.mailbox.host;
    if (isIP(host) && isPrivateIp(host)) return fail("tls_failure");
    timer = setTimeout(() => stop(Date.now() >= expires ? "read_expired" : "deadline_exceeded"), Math.max(1, deadline - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
    guard();
    try {
      const connectionOptions: ConnectionOptions & { autoSelectFamily: false } = { host, port: plan.selection.mailbox.port, servername: isIP(host) ? undefined : host,
        rejectUnauthorized: true, minVersion: "TLSv1.2", autoSelectFamily: false, ca,
        lookup: lookup ?? publicSocketLookup(), checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate) };
      socket = connect(connectionOptions);
    } catch { return fail("tls_failure"); }
    input = new Input(socket, plan.limits.maxTotalBytes + MAX_CONTROL, guard);
    await input.verified();
    const result = await session(input, plan, password, custody);
    guard();
    custody?.seal(result.messages);
    guard();
    completed = true;
    return { session: result, custody };
  } catch (error) { throw new ProtectedMailImapError(fixedReason(error)); }
  finally {
    if (timer !== undefined) clearTimeout(timer); signal.removeEventListener("abort", onAbort); input?.close(); socket?.destroy();
    if (!completed) custody?.discard();
  }
}

export async function runProtectedMailImapSession(options: ProtectedMailImapSessionOptions): Promise<ProtectedMailImapSessionResult> {
  return (await runSession(options, false)).session;
}

/** Internal composition only. Not exported through any runner/tool/route.
 * No raw bytes or general callback are returned; only sealed fixed custody. */
export async function runProtectedMailImapIngestionSession(options: ProtectedMailImapSessionOptions):
  Promise<{ session: ProtectedMailImapSessionResult; custody: ProtectedMailIngestionCustody }> {
  const result = await runSession(options, true);
  return { session: result.session, custody: result.custody! };
}
