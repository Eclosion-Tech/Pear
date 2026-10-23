/** One metadata-only terminal report. An unknown reply never changes the chosen
 * outcome and must never trigger another mailbox read or an automatic retry. */
import type { ProtectedMailSparseReadProcedureOptions } from "./protected-mail-sparse-read-dispatch.js";
import { sparseReadAuthority, type ProtectedMailSparseReadOutcome, type ProtectedMailSparseReadReport } from "./protected-mail-sparse-read-types.js";

const outcomes: readonly ProtectedMailSparseReadOutcome[] = ["ReadReported", "Failed", "Unknown", "CancelledBeforeDispatch"];
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function finishProtectedMailSparseReadDispatch(options: ProtectedMailSparseReadProcedureOptions,
  readId: string, outcome: ProtectedMailSparseReadOutcome, eventNonce: string): Promise<ProtectedMailSparseReadReport> {
  if (!hex(readId) || !hex(eventNonce) || !outcomes.includes(outcome)) {
    return Object.freeze({ kind: "unknown", eventNonce: "", outcome: "Unknown" });
  }
  const result = (kind: "recorded" | "unknown"): ProtectedMailSparseReadReport => Object.freeze({ kind, eventNonce, outcome });
  const configured = sparseReadAuthority(options, true); if (!configured) return result("unknown");
  const { target, token, timeout, fetchImpl } = configured;
  const body = JSON.stringify([readId, [outcomes.indexOf(outcome), []], eventNonce]);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = (async (): Promise<ProtectedMailSparseReadReport> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body, signal: controller.signal });
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return result("unknown"); }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 4096)) {
        void response.body?.cancel().catch(() => {}); throw Error("invalid_response");
      }
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
