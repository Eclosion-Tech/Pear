/** Private, one-use literal custody for the dormant contiguous composition.
 * No raw getter/callback exists. This is application custody, not host isolation. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { parseMailIngestionEntries, type ConnectorReadV1, type MailIngestionEntry } from "../../../packages/sentinel/src/index.js";
import type { ProtectedMailReadMessageMetadata } from "./protected-mail-read-types.js";

const preparationReasons = Object.freeze(["mime_failure", "mime_limit", "mime_timeout", "aborted", "read_expired"] as const);
export type ProtectedMailPreparationReason = typeof preparationReasons[number];
export class ProtectedMailPreparationError extends Error {
  readonly reason: ProtectedMailPreparationReason;
  constructor(reason: ProtectedMailPreparationReason) {
    const fixed = (preparationReasons as readonly unknown[]).includes(reason) ? reason : "mime_failure";
    super(fixed); this.reason = fixed; this.name = "ProtectedMailPreparationError"; Object.freeze(this);
  }
}
const fail = (reason: ProtectedMailPreparationReason): never => { throw new ProtectedMailPreparationError(reason); };
const profile = "mailparser-plain-v1";

function check(signal: AbortSignal, deadline: number): void {
  if (signal.aborted) fail("aborted");
  if (Date.now() >= deadline) fail("read_expired");
}
function pinnedParser(): void {
  // Static metadata only; parsing and its dependencies load only in the worker.
  const path = createRequire(import.meta.url).resolve("mailparser/package.json");
  const splitter = createRequire(path).resolve("@zone-eu/mailsplit/package.json");
  if (JSON.parse(readFileSync(path, "utf8")).version !== "3.9.40"
    || JSON.parse(readFileSync(splitter, "utf8")).version !== "5.4.23") fail("mime_failure");
}
type Parsed = { kind: "prepared"; messageDate: string; from: string; to: string; cc: string; subject: string; body: string; note: string }
  | { kind: "held"; reason: "unsupported_content" };
function parsed(value: unknown): Parsed | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return;
  const row = value as Record<string, unknown>;
  if (row.kind === "held" && row.reason === "unsupported_content" && Object.keys(row).length === 2) return row as Parsed;
  const keys = ["kind", "messageDate", "from", "to", "cc", "subject", "body", "note"];
  if (row.kind !== "prepared" || Object.keys(row).length !== keys.length || keys.some(key => typeof row[key] !== "string")) return;
  return row as Parsed;
}

async function parseLiteral(raw: Buffer, signal: AbortSignal, deadline: number): Promise<Parsed> {
  check(signal, deadline); pinnedParser();
  const worker = new Worker(new URL("./protected-mail-ingestion-mime-worker.mjs", import.meta.url), {
    workerData: { raw }, env: {}, execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined, diagnostic = false;
  const capture = (bytes: Buffer) => { if (bytes.byteLength) diagnostic = true; };
  worker.stdout!.on("data", capture); worker.stderr!.on("data", capture);
  try {
    const result = await new Promise<Parsed>((resolve, reject) => {
      let settled = false;
      const stop = (reason: ProtectedMailPreparationReason) => { if (!settled) { settled = true; reject(new ProtectedMailPreparationError(reason)); } };
      abort = () => stop("aborted"); signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop("mime_timeout"), Math.max(1, Math.min(3000, deadline - Date.now())));
      worker.on("message", (value: unknown) => {
        if (settled) return;
        try { check(signal, deadline); } catch { stop(signal.aborted ? "aborted" : "read_expired"); return; }
        const result = parsed(value);
        if (!result) { stop("mime_failure"); return; }
        settled = true; resolve(result);
      });
      worker.on("error", () => stop("mime_failure"));
      worker.on("exit", () => stop("mime_failure"));
      if (signal.aborted) abort();
    });
    check(signal, deadline);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort);
    // MailParser text is assembled internally. Heap limits exclude external
    // Buffers; worker termination is not OS filesystem/network isolation.
    await worker.terminate();
    if (diagnostic) fail("mime_failure");
  }
}

/** Only the fixed IMAP session writes here; only fixed MIME preparation reads
 * it. No partial batch can be prepared. Retained raw buffers are zeroed finally,
 * which does not promise erasure of all runtime/library copies or strings. */
export class ProtectedMailIngestionCustody {
  #raw: { uid: number; bytes: Buffer }[] = [];
  #total = 0;
  #sealed = false;
  #used = false;
  constructor(private readonly plan: ConnectorReadV1) {}
  allocate(uid: number, length: number): Buffer {
    const expected = this.plan.selection.selection.uids[this.#raw.length];
    const cap = Math.min(this.plan.limits.maxMessageBytes, this.plan.limits.maxTotalBytes - this.#total);
    if (this.#sealed || this.#used || uid !== expected || !Number.isSafeInteger(length) || length < 0 || length >= cap) fail("mime_limit");
    const bytes = Buffer.alloc(length); this.#raw.push({ uid, bytes }); this.#total += length; return bytes;
  }
  seal(messages: readonly ProtectedMailReadMessageMetadata[]): void {
    if (this.#sealed || this.#used || messages.length !== this.plan.selection.selection.uids.length || messages.length !== this.#raw.length
      || messages.some((message, index) => message.uid !== this.#raw[index].uid || message.bytes !== this.#raw[index].bytes.length
        || message.digest !== createHash("sha256").update(this.#raw[index].bytes).digest("hex"))) fail("mime_failure");
    this.#sealed = true;
  }
  discard(): void { this.#used = true; for (const entry of this.#raw) entry.bytes.fill(0); this.#raw = []; }
  async prepare(signal: AbortSignal, deadline: number): Promise<readonly MailIngestionEntry[]> {
    if (!this.#sealed || this.#used) fail("mime_failure");
    this.#used = true;
    try {
      const entries: MailIngestionEntry[] = [];
      for (const entry of this.#raw) {
        const result = await parseLiteral(entry.bytes, signal, deadline);
        if (result.kind === "held") entries.push({ kind: "held", uid: entry.uid, reason: result.reason });
        else entries.push({ kind: "imported", uid: entry.uid, message: {
          messageDate: result.messageDate, from: result.from, to: result.to, cc: result.cc,
          subject: result.subject, body: result.body, note: result.note,
          folder: this.plan.selection.mailbox.folder, uidValidity: this.plan.selection.selection.uidValidity,
          uid: entry.uid, direction: this.plan.selection.mailbox.direction, sanitizationVersion: profile } });
      }
      const copied = parseMailIngestionEntries(entries);
      if (!copied) return fail("mime_failure");
      check(signal, deadline); return copied;
    } finally { this.discard(); }
  }
}
