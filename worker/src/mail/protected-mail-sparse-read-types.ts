import type { ProtectedInferenceProcedureOptions } from "./protected-inference-claim.js";

/** Metadata-only service declarations, never evidence of actual mailbox reads. */
export type ProtectedMailSparseReadOutcome = "ReadReported" | "Failed" | "Unknown" | "CancelledBeforeDispatch";
export interface ProtectedMailSparseReadReport {
  readonly kind: "recorded" | "unknown";
  readonly eventNonce: string;
  readonly outcome: ProtectedMailSparseReadOutcome;
}

/** Internal configuration capture for this closed pair of routes only. No
 * caller-supplied method or payload is accepted. Authority options are host
 * configuration; they must never originate from mail or model output. */
export function sparseReadAuthority(options: ProtectedInferenceProcedureOptions, report: boolean):
  { readonly target: string; readonly token: string; readonly timeout: number; readonly fetchImpl: typeof fetch } | undefined {
  try {
    if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) return;
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const required = ["baseUrl", "dbName", "token"], allowed = [...required, "timeoutMs", "fetchImpl"];
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !allowed.includes(key))
      || required.some(key => !descriptors[key])) return;
    const copied: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors)) {
      const field = descriptors[key]; if (!("value" in field) || !field.enumerable) return;
      copied[key] = field.value;
    }
    if (typeof copied.baseUrl !== "string" || typeof copied.dbName !== "string" || typeof copied.token !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(copied.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(copied.token)
      || copied.fetchImpl !== undefined && typeof copied.fetchImpl !== "function") return;
    const url = new URL(copied.baseUrl);
    if (url.origin !== copied.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return;
    const requested = copied.timeoutMs ?? (report ? 5000 : 15000);
    if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1 || requested > 60000) return;
    const method = report ? "finish_protected_mail_sparse_read_dispatch" : "begin_protected_mail_sparse_read_dispatch";
    return Object.freeze({ target: `${url.origin}/v1/database/${encodeURIComponent(copied.dbName)}/call/${method}`,
      token: copied.token, timeout: report ? Math.min(requested, 5000) : requested, fetchImpl: (copied.fetchImpl ?? fetch) as typeof fetch });
  } catch { return undefined; }
}
