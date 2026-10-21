/** Synthetic TLS-only IMAP fixture. Never use with a mailbox or credentials.
 * No transcript, authentication payload or body reaches diagnostics. */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { LookupFunction, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { promisify } from "node:util";

const run = promisify(execFile);
export const EXECUTOR_FIXTURE_HOST = "mail.example.test";
export const EXECUTOR_FIXTURE_MARKER = "EXECUTOR_PRIVATE_SYNTHETIC_";
export interface ExecutorFixtureCertificates {
  readonly directory: string;
  readonly ca: string;
  readonly close: () => Promise<void>;
}
const material = new WeakMap<ExecutorFixtureCertificates, { key: string; cert: string }>();
/** Fresh synthetic material, private even on a shared CI host. OpenSSL output
 * is captured and discarded, including failures; no key is embedded in source. */
export async function createExecutorFixtureCertificates(host = EXECUTOR_FIXTURE_HOST): Promise<ExecutorFixtureCertificates> {
  if (!/^[a-z0-9.-]+$/.test(host)) throw Error("executor_fixture_invalid_hostname");
  const directory = await mkdtemp(join(tmpdir(), "pear-protected-executor-"));
  await chmod(directory, 0o700);
  try {
    const caConfig = "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Pear Synthetic Executor CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n";
    const serverConfig = `[req]\nprompt=no\ndistinguished_name=dn\nreq_extensions=leaf\n[dn]\nCN=${host}\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host}\n`;
    await writeFile(join(directory, "ca.cnf"), caConfig, { mode: 0o600 });
    await writeFile(join(directory, "server.cnf"), serverConfig, { mode: 0o600 });
    const options = { cwd: directory, timeout: 20000, maxBuffer: 65536, windowsHide: true };
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-config", "ca.cnf", "-keyout", "ca.key", "-out", "ca.pem"], options);
    await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", "server.cnf", "-keyout", "server.key", "-out", "server.csr"], options);
    await run("openssl", ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "1", "-sha256", "-extfile", "server.cnf", "-extensions", "leaf"], options);
    for (const name of await readdir(directory)) await chmod(join(directory, name), 0o600);
    const value = Object.freeze({ directory, ca: await readFile(join(directory, "ca.pem"), "utf8"), close: async () => { material.delete(value); await rm(directory, { recursive: true, force: true }); } });
    material.set(value, { key: await readFile(join(directory, "server.key"), "utf8"), cert: await readFile(join(directory, "server.pem"), "utf8") }); return value;
  } catch { await rm(directory, { recursive: true, force: true }); throw Error("executor_fixture_certificate_failed"); }
}

export interface ExecutorFixtureFetch {
  readonly tag: string; readonly uid: number; readonly limit: number; readonly index: number;
}
export interface ExecutorFixtureSearch { readonly tag: string; readonly fromUid: number; readonly throughUid: number; readonly index: number }
export interface ExecutorFixtureReply { readonly bytes: Uint8Array; readonly split?: boolean; readonly close?: boolean; readonly hang?: boolean }
export interface ExecutorFixtureOptions {
  readonly mode?: "read" | "discovery";
  readonly certificates?: ExecutorFixtureCertificates;
  readonly username?: string;
  readonly password?: string;
  /** Already encoded quoted mailbox contents, independent from production's encoder. */
  readonly folderWire?: string;
  readonly uidValidity?: string;
  readonly uidNext?: number | string;
  readonly presentUids?: readonly number[];
  readonly searchReply?: (request: ExecutorFixtureSearch) => ExecutorFixtureReply;
  readonly readOnly?: boolean;
  readonly greeting?: string | null;
  readonly capabilities?: string;
  readonly authReject?: boolean;
  readonly authExtraChallenge?: boolean;
  readonly examineReply?: (tag: string) => ExecutorFixtureReply;
  readonly messages?: ReadonlyMap<number, Uint8Array>;
  readonly fetchReply?: (request: ExecutorFixtureFetch) => ExecutorFixtureReply;
  readonly split?: boolean;
}
export interface ExecutorFixtureStats {
  tcpConnections: number; connections: number; tlsFailures: number; authentications: number; authenticationMatched: boolean;
  tagsSequential: boolean; mailboxMatched: boolean; forbidden: boolean; closedConnections: number;
  commands: string[]; fetches: Array<{ uid: number; limit: number }>;
  searches: Array<{ fromUid: number; throughUid: number }>;
}
/** Build one strict response, allowing adversarial protocol fields in tests.
 * Raw buffers are private fixture inputs, never assertion/error messages. */
export function executorFetchReply(request: ExecutorFixtureFetch, body: Uint8Array, overrides: {
  uid?: number; size?: number; offset?: number; declaredLength?: number; sequence?: number; prefix?: string; suffix?: string; tag?: string;
} = {}): Buffer {
  const prefix = overrides.prefix ?? `* ${overrides.sequence ?? 1} FETCH (UID ${overrides.uid ?? request.uid} RFC822.SIZE ${overrides.size ?? body.byteLength} BODY[]<${overrides.offset ?? 0}> {${overrides.declaredLength ?? body.byteLength}}\r\n`;
  return Buffer.concat([Buffer.from(prefix), Buffer.from(body), Buffer.from(overrides.suffix ?? `)\r\n${overrides.tag ?? request.tag} OK fetched\r\n`)]);
}

export async function createExecutorFixture(options: ExecutorFixtureOptions = {}) {
  const certificates = options.certificates ?? await createExecutorFixtureCertificates(), ownCertificates = options.certificates === undefined;
  const secrets = material.get(certificates); if (!secrets) throw Error("executor_fixture_missing_material");
  const stats: ExecutorFixtureStats = { tcpConnections: 0, connections: 0, tlsFailures: 0, authentications: 0, authenticationMatched: true,
    tagsSequential: true, mailboxMatched: true, forbidden: false, closedConnections: 0, commands: [], fetches: [], searches: [] };
  const sockets = new Set<TLSSocket>(), tcpSockets = new Set<Socket>();
  async function reply(socket: TLSSocket, response: ExecutorFixtureReply): Promise<void> {
    if (response.hang || socket.destroyed) return;
    const bytes = Buffer.from(response.bytes), slices = response.split ? [1, 2, 3, 5, 8, 13, 21, 34, 55, 89] : [];
    let offset = 0;
    for (const size of [...slices, bytes.length]) {
      if (socket.destroyed || offset >= bytes.length) break;
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + size)); offset += chunk.length;
      await new Promise<void>(resolve => socket.write(chunk, () => resolve()));
      if (response.split) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (response.close && !socket.destroyed) socket.end();
  }
  const server = createServer({ key: secrets.key, cert: secrets.cert, minVersion: "TLSv1.2" }, socket => {
    sockets.add(socket); stats.connections++;
    let buffer = Buffer.alloc(0), nextTag = 1, phase = "capability", authTag = "", queue = Promise.resolve();
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); stats.closedConnections++; });
    const greeting = options.greeting === undefined ? "* OK synthetic ready\r\n" : options.greeting;
    if (greeting !== null) void reply(socket, { bytes: Buffer.from(greeting), split: options.split });
    async function line(value: Buffer): Promise<void> {
      if (phase === "plain") {
        stats.authentications++;
        const expected = Buffer.from(`\0${options.username ?? "fixture@example.test"}\0${options.password ?? `${EXECUTOR_FIXTURE_MARKER}password`}`).toString("base64");
        stats.authenticationMatched &&= value.toString("ascii") === expected;
        if (options.authExtraChallenge) { await reply(socket, { bytes: Buffer.from("+\r\n"), split: options.split }); return; }
        phase = "examine";
        await reply(socket, { bytes: Buffer.from(`${authTag} ${options.authReject || !stats.authenticationMatched ? "NO" : "OK"} authenticated\r\n`), split: options.split }); return;
      }
      const command = value.toString("utf8"), match = /^(C[1-9][0-9]*) (.+)$/.exec(command);
      if (!match) { stats.forbidden = true; socket.destroy(); return; }
      const [, tag, operation] = match;
      stats.tagsSequential &&= tag === `C${nextTag++}`;
      if (operation === "CAPABILITY" && phase === "capability") {
        stats.commands.push("CAPABILITY"); phase = "authenticate";
        await reply(socket, { bytes: Buffer.from(`* CAPABILITY ${options.capabilities ?? "IMAP4rev1 AUTH=PLAIN ID NAMESPACE ENABLE COMPRESS=DEFLATE IDLE QRESYNC UTF8=ACCEPT"}\r\n${tag} OK capability\r\n`), split: options.split }); return;
      }
      if (operation === "AUTHENTICATE PLAIN" && phase === "authenticate") {
        stats.commands.push("AUTHENTICATE_PLAIN"); authTag = tag; phase = "plain";
        await reply(socket, { bytes: Buffer.from("+\r\n"), split: options.split }); return;
      }
      if (operation.startsWith("EXAMINE ") && phase === "examine") {
        stats.commands.push("EXAMINE"); stats.mailboxMatched &&= operation === `EXAMINE "${options.folderWire ?? "INBOX"}"`; phase = options.mode === "discovery" ? "search" : "fetch";
        const next = options.mode === "discovery" ? `* OK [UIDNEXT ${options.uidNext ?? 10}] next\r\n` : "";
        const response = options.examineReply?.(tag) ?? { bytes: Buffer.from(`* FLAGS (\\Seen \\Answered)\r\n* 8 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${options.uidValidity ?? "7"}] stable\r\n${next}${tag} OK [${options.readOnly === false ? "READ-WRITE" : "READ-ONLY"}] examined\r\n`), split: options.split };
        await reply(socket, response); return;
      }
      const search = /^UID SEARCH UID ([1-9][0-9]*):([1-9][0-9]*)$/.exec(operation);
      if (search && phase === "search" && options.mode === "discovery") {
        const request = { tag, fromUid: Number(search[1]), throughUid: Number(search[2]), index: stats.searches.length };
        stats.commands.push("UID_SEARCH"); stats.searches.push({ fromUid: request.fromUid, throughUid: request.throughUid }); phase = "complete";
        const response = options.searchReply?.(request) ?? { bytes: Buffer.from(`* SEARCH${options.presentUids?.length ? ` ${options.presentUids.join(" ")}` : ""}\r\n${tag} OK searched\r\n`), split: options.split };
        await reply(socket, response); return;
      }
      const fetch = /^UID FETCH ([1-9][0-9]*) \(UID RFC822\.SIZE BODY\.PEEK\[\]<0\.([1-9][0-9]*)>\)$/.exec(operation);
      if (fetch && phase === "fetch") {
        const request = { tag, uid: Number(fetch[1]), limit: Number(fetch[2]), index: stats.fetches.length };
        stats.commands.push("UID_FETCH_PEEK"); stats.fetches.push({ uid: request.uid, limit: request.limit });
        const whole = options.messages?.get(request.uid), body = whole?.subarray(0, request.limit);
        const response = options.fetchReply?.(request) ?? (body === undefined ? { bytes: Buffer.from(`${tag} OK empty\r\n`) }
          : { bytes: executorFetchReply(request, body, { size: whole!.byteLength }), split: options.split });
        await reply(socket, response); return;
      }
      stats.commands.push("FORBIDDEN"); stats.forbidden = true; socket.destroy();
    }
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16384) { stats.forbidden = true; socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const command = Buffer.from(buffer.subarray(0, index)); buffer = Buffer.from(buffer.subarray(index + 2));
        queue = queue.then(() => line(command)).catch(() => { stats.forbidden = true; socket.destroy(); });
      }
    });
  });
  server.on("connection", socket => { stats.tcpConnections++; tcpSockets.add(socket); socket.on("error", () => {}); socket.once("close", () => tcpSockets.delete(socket)); });
  server.on("tlsClientError", () => { stats.tlsFailures++; }); server.on("error", () => {});
  await new Promise<void>((resolve, reject) => { server.once("error", () => reject(Error("executor_fixture_listen_failed"))); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("executor_fixture_address_failed");
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== EXECUTOR_FIXTURE_HOST) { callback(Error("executor_fixture_host_denied"), "", 4); return; }
    if (typeof options === "object" && options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };
  return Object.freeze({ port: address.port, ca: certificates.ca, directory: certificates.directory, lookup, stats,
    close: async () => { for (const socket of sockets) socket.destroy(); for (const socket of tcpSockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); if (ownCertificates) await certificates.close(); } });
}
