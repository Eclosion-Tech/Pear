/** Internal metadata-only fixed-profile session. A host closure must consume
 * fresh discovery authority before invoking it. No body consumer or callback. */
import { isIP } from "node:net";
import { connect, checkServerIdentity, type ConnectionOptions, type TLSSocket } from "node:tls";
import { prepareConnectorDiscovery } from "../../../packages/sentinel/src/index.js";
import { isPrivateIp, publicSocketLookup } from "../ssrf.js";
import { encodeProtectedMailImapFolder } from "./protected-mail-imap-session.js";
import { ProtectedMailDiscoveryError, type ProtectedMailDiscoveryReason, type ProtectedMailDiscoverySessionOptions,
  type ProtectedMailDiscoverySessionResult } from "./protected-mail-discovery-types.js";

const MAX_LINE = 8192, MAX_CONTROL = 65536, MAX_RESPONSES = 128;
const fail = (reason: ProtectedMailDiscoveryReason): never => { throw new ProtectedMailDiscoveryError(reason); };
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

/** Bounded metadata-only input. No literal/body consumer exists. */
class Input {
  private chunks: Buffer[] = [];
  private head = 0;
  private offset = 0;
  private buffered = 0;
  private wake?: () => void;
  private failure?: ProtectedMailDiscoveryReason;
  private ended?: ProtectedMailDiscoveryReason;
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
  stop(reason: ProtectedMailDiscoveryReason): void {
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
    if (/\[REFERRAL(?:\s|\])/i.test(value) || /\{[0-9]+\+?\}/.test(value)) return fail("protocol_failure");
    return value;
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

function fixedReason(error: unknown): ProtectedMailDiscoveryReason {
  return error instanceof ProtectedMailDiscoveryError ? error.reason : "protocol_failure";
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


async function session(input: Input, plan: ProtectedMailDiscoverySessionOptions["plan"], password: string): Promise<ProtectedMailDiscoverySessionResult> {
  if (!/^\* OK(?: |$)/i.test(await input.line())) return fail("protocol_failure");
  input.boundary(); input.write("C1 CAPABILITY\r\n");
  const capability = await input.line(); if (!/^\* CAPABILITY /i.test(capability)) return fail("protocol_failure");
  capabilities(capability.slice(13), true); if (!taggedOk(await input.line(), "C1")) return fail("protocol_failure");
  input.boundary(); input.write("C2 AUTHENTICATE PLAIN\r\n");
  if (!/^\+ ?$/.test(await input.line())) return fail("authentication_failed");
  const auth = Buffer.alloc(Buffer.byteLength(plan.mailbox.username, "utf8") + Buffer.byteLength(password, "utf8") + 2);
  let offset = 1; offset += auth.write(plan.mailbox.username, offset, "utf8"); offset++; auth.write(password, offset, "utf8");
  try { input.write(`${auth.toString("base64")}\r\n`); } finally { auth.fill(0); }
  const authenticated = await input.line(); if (!taggedOk(authenticated, "C2")) return fail("authentication_failed");
  const refreshed = /\[CAPABILITY ([^\]]+)\]/i.exec(authenticated); if (refreshed) capabilities(refreshed[1], false);
  input.boundary(); input.write(`C3 EXAMINE ${encodeProtectedMailImapFolder(plan.mailbox.folder)}\r\n`);
  let uidValidity: string | undefined, uidNext: number | undefined;
  while (true) {
    const line = await input.line();
    if (taggedOk(line, "C3")) {
      if (!/^C3 OK \[READ-ONLY\](?: |$)/i.test(line)) return fail("read_only_required");
      if (uidValidity === undefined || uidNext === undefined) return fail("protocol_failure"); input.boundary(); break;
    }
    const validity = /^\* OK \[UIDVALIDITY ([0-9]+)\](?: |$)/i.exec(line);
    if (validity) { if (uidValidity !== undefined || !uint(validity[1], true)) return fail("protocol_failure"); uidValidity = validity[1]; continue; }
    const next = /^\* OK \[UIDNEXT ([0-9]+)\](?: |$)/i.exec(line);
    if (next) { if (uidNext !== undefined || !uint(next[1], true)) return fail("protocol_failure"); uidNext = Number(next[1]); continue; }
    const flagList = /^\* FLAGS \(([^()]*)\)$/i.exec(line); if (flagList && flags(flagList[1])) continue;
    const count = /^\* ([0-9]+) (?:EXISTS|RECENT)$/i.exec(line); if (count && uint(count[1], false)) continue;
    const numeric = /^\* OK \[(UNSEEN|HIGHESTMODSEQ) ([0-9]+)\](?: |$)/i.exec(line);
    if (numeric && uint(numeric[2], true, numeric[1].toUpperCase() === "HIGHESTMODSEQ" ? 0xffffffffffffffffn : 0xffffffffn)) continue;
    const permanent = /^\* OK \[PERMANENTFLAGS \(([^()]*)\)\](?: |$)/i.exec(line); if (permanent && flags(permanent[1])) continue;
    if (/^\* OK \[(?:NOMODSEQ|READ-ONLY|ALERT)\](?: |$)/i.test(line)) continue;
    return fail("protocol_failure");
  }
  if (plan.cursor && plan.cursor.uidValidity !== uidValidity || plan.head && plan.head.uidValidity !== uidValidity) return fail("uid_validity_mismatch");
  if (plan.head && uidNext < plan.head.uidNext || plan.cursor && uidNext <= plan.cursor.lastUid) return fail("uid_next_rollback");
  const presentUids: number[] = [];
  if (plan.window.mode === "next_window") {
    const from = plan.window.fromUid, through = Math.min(plan.window.maxThroughUid!, uidNext - 1);
    if (from === null) return fail("protocol_failure");
    if (through >= from) {
      input.write(`C4 UID SEARCH UID ${from}:${through}\r\n`);
      const response = /^\* SEARCH(?: ([1-9][0-9]*(?: [1-9][0-9]*)*))?$/i.exec(await input.line()); if (!response) return fail("protocol_failure");
      const tokens = response[1]?.split(" ") ?? []; if (tokens.length > plan.window.maxSlots || tokens.length > through - from + 1) return fail("limit_reached");
      let previous = 0;
      for (const token of tokens) { if (!uint(token, true)) return fail("protocol_failure"); const uid = Number(token); if (uid <= previous || uid < from || uid > through) return fail("protocol_failure"); presentUids.push(uid); previous = uid; }
      if (!taggedOk(await input.line(), "C4")) return fail("protocol_failure"); input.boundary();
    }
  }
  return Object.freeze({ uidValidity, uidNext, presentUids: Object.freeze(presentUids) });
}
export async function runProtectedMailDiscoverySession(options: ProtectedMailDiscoverySessionOptions): Promise<ProtectedMailDiscoverySessionResult> {
  const { password, signal, deadlineAtMs, ca, lookup } = options;
  if (!(signal instanceof AbortSignal)) return fail("protocol_failure");
  if (!safePassword(password)) return fail("authentication_failed");
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) return fail("deadline_exceeded");
  if (signal.aborted) return fail("aborted");
  const prepared = await prepareConnectorDiscovery(options.plan);
  if (prepared.status !== "prepared") return fail("protocol_failure");
  const plan = prepared.discovery.manifest, expires = plan.expiresAtMs;
  const deadline = Math.min(deadlineAtMs, expires, Date.now() + 60_000);
  let input: Input | undefined, socket: TLSSocket | undefined, stopped: ProtectedMailDiscoveryReason | undefined;
  const guard = () => {
    if (stopped) fail(stopped);
    if (signal.aborted) fail("aborted");
    const now = Date.now();
    if (now >= expires) fail("discovery_expired");
    if (now >= deadline) fail("deadline_exceeded");
    if (now < plan.notBeforeMs) fail("protocol_failure");
  };
  const stop = (reason: ProtectedMailDiscoveryReason) => { stopped ??= reason; input?.stop(reason); socket?.destroy(); };
  const onAbort = () => stop("aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    guard();
    const host = plan.mailbox.host;
    if (isIP(host) && isPrivateIp(host)) return fail("tls_failure");
    timer = setTimeout(() => stop(Date.now() >= expires ? "discovery_expired" : "deadline_exceeded"), Math.max(1, deadline - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
    guard();
    try {
      const connectionOptions: ConnectionOptions & { autoSelectFamily: false } = { host, port: plan.mailbox.port, servername: isIP(host) ? undefined : host,
        rejectUnauthorized: true, minVersion: "TLSv1.2", autoSelectFamily: false, ca,
        lookup: lookup ?? publicSocketLookup(), checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate) };
      socket = connect(connectionOptions);
    } catch { return fail("tls_failure"); }
    input = new Input(socket, MAX_CONTROL, guard);
    await input.verified();
    return await session(input, plan, password);
  } catch (error) { throw new ProtectedMailDiscoveryError(fixedReason(error)); }
  finally { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener("abort", onAbort); input?.close(); socket?.destroy(); }
}
