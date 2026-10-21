/** One metadata-only terminal report. An unknown reply never changes the chosen
 * outcome and must never trigger another mailbox read or an automatic retry. */
import type { ProtectedMailReadProcedureOptions } from "./protected-mail-read-dispatch.js";
import type { ProtectedMailReadOutcome, ProtectedMailReadReport } from "./protected-mail-read-types.js";

const outcomes: readonly ProtectedMailReadOutcome[] = ["ReadReported", "Failed", "Unknown", "CancelledBeforeDispatch"];
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safe = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;

export async function finishProtectedMailReadDispatch(options: ProtectedMailReadProcedureOptions,
  readId: string, outcome: ProtectedMailReadOutcome, eventNonce: string): Promise<ProtectedMailReadReport> {
  if (!hex(readId) || !hex(eventNonce) || !outcomes.includes(outcome)) {
    return Object.freeze({ kind: "unknown", eventNonce: "", outcome: "Unknown" });
  }
  const result = (kind: "recorded" | "unknown"): ProtectedMailReadReport => Object.freeze({ kind, eventNonce, outcome });
  let target: string, token: string, fetchImpl: typeof fetch, timeout: number;
  try {
    const url = new URL(options.baseUrl);
    if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(options.token)) return result("unknown");
    timeout = Math.min(options.timeoutMs ?? 5000, 5000);
    if (!safe(timeout, 5000)) return result("unknown");
    target = `${url.origin}/v1/database/${encodeURIComponent(options.dbName)}/call/finish_protected_mail_read_dispatch`;
    token = options.token; fetchImpl = options.fetchImpl ?? fetch;
  } catch { return result("unknown"); }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = (async (): Promise<ProtectedMailReadReport> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([readId, [outcomes.indexOf(outcome), []], eventNonce]), signal: controller.signal });
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return result("unknown"); }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 4096)) throw Error("invalid_response");
      // Reducer success has no application payload. Drain a bounded body so
      // server diagnostics and errors never become caller-visible content.
      if (response.body) {
        const reader = response.body.getReader(); let bytes = 0;
        const abort = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener("abort", abort, { once: true });
        try {
          while (true) {
            if (controller.signal.aborted) throw Error("report_timeout");
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength; if (bytes > 4096) throw Error("invalid_response");
          }
        } finally {
          controller.signal.removeEventListener("abort", abort);
          void reader.cancel().catch(() => {}); reader.releaseLock();
        }
      }
      return result("recorded");
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("report_timeout")); }, timeout); });
    return await Promise.race([sent, expired]);
  } catch { return result("unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
