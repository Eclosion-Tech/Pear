/** Host-owned policy input. Never deserialize these records from model output.
 * This package validates eligibility; it does not authenticate a host, mint a
 * capability, consume budgets, persist state, or authorize network dispatch. */
export const POLICY_VERSION = "sentinel-mail-v1" as const;

export interface RunScope {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly runtimeId: string;
  readonly runId: string;
  readonly parentRunId?: string;
}

export interface SourceRef {
  readonly id: string;
  readonly revision: string;
  readonly digest: string;
}

export interface Processor {
  readonly profileId: string;
  readonly revision: string;
  /** Exact canonical HTTPS endpoint, not a domain allowlist. DNS, redirects,
   * TLS and credential custody are the dispatcher's separate responsibility. */
  readonly endpoint: string;
  readonly model: string;
}

export interface PrivateStorage {
  readonly workspaceId: string;
  readonly rootId: string;
  readonly ownerId: string;
}

export interface SourceRevision {
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly origin: "external_mail" | "external_web" | "workspace" | "derived" | "unknown";
  readonly sanitizationVersion: string;
  readonly parents: readonly SourceRef[];
  /** Separate constraints for processors and human-visible storage. Neither
   * set is a grant. All exposed sources AND their parents must permit a sink. */
  readonly processors: readonly Processor[];
  readonly storage: readonly PrivateStorage[];
}

export interface Limits {
  readonly messages: number;
  readonly readBytes: number;
  readonly inputBytes: number;
  readonly outputTokens: number;
  readonly appendBytes: number;
}

/** An approved fixed recipe, supplied by a trusted authority-store adapter.
 * Each invocation still requires durable admission outside this package. */
export interface MailWorkflowGrant {
  readonly id: string;
  readonly policyVersion: typeof POLICY_VERSION;
  readonly scope: RunScope;
  readonly epoch: number;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly connectionId: string;
  readonly mailbox: { readonly host: string; readonly port: number; readonly folders: readonly string[] };
  readonly destination: PrivateStorage;
  readonly summaryProcessor?: Processor;
  readonly screeningProcessor?: Processor;
  readonly limits: Limits;
}

export interface PolicySnapshot {
  readonly policyVersion: typeof POLICY_VERSION;
  readonly scope: RunScope;
  readonly epoch: number;
  readonly nowMs: number;
  readonly grant: MailWorkflowGrant;
  /** Every source visible to this context, not model-selected citations.
   * Host adapters must include prior history, memory, compaction and errors. */
  readonly exposures: readonly SourceRef[];
  readonly sources: readonly SourceRevision[];
  /** Observed budget snapshot only. An eligible result does not reserve it. */
  readonly remaining: Limits & { readonly operations: number };
  readonly screening: "not_required" | "clean" | "hold" | "unavailable";
}

interface OperationBase {
  readonly scope: RunScope;
  readonly connectionId: string;
  readonly epoch: number;
}

export interface MailRead extends OperationBase {
  readonly kind: "mail.read";
  readonly contractVersion: 1;
  readonly mailbox: { readonly host: string; readonly port: number; readonly folders: readonly string[] };
  readonly messages: number;
  readonly bytes: number;
}

export interface ContentScreen extends OperationBase {
  readonly kind: "content.screen";
  readonly contractVersion: 1;
  readonly processor: Processor;
  readonly inputBytes: number;
  readonly payloadDigest: string;
}

export interface ModelInfer extends OperationBase {
  readonly kind: "model.infer";
  readonly contractVersion: 1;
  readonly purpose: "mail.summary";
  readonly processor: Processor;
  readonly inputBytes: number;
  readonly outputTokens: number;
  readonly payloadDigest: string;
}

export interface MailAppend extends OperationBase {
  readonly kind: "mail.append";
  readonly contractVersion: 1;
  readonly destination: PrivateStorage;
  readonly bytes: number;
  readonly payloadDigest: string;
}

/** No generic URL, shell, MCP, send, share, or arbitrary page write operation. */
export type Operation = MailRead | ContentScreen | ModelInfer | MailAppend;

export type DenialReason =
  | "invalid_snapshot" | "invalid_operation" | "unsupported_contract"
  | "scope_mismatch" | "stale_epoch" | "grant_not_active" | "connection_mismatch"
  | "destination_denied" | "source_missing" | "source_conflict" | "source_cycle"
  | "source_workspace_mismatch" | "source_disclosure_denied" | "source_required"
  | "budget_exceeded" | "screening_hold" | "screening_unavailable";

export type Eligibility =
  | { readonly status: "denied"; readonly reason: DenialReason }
  | { readonly status: "eligible"; readonly requiresAdmission: true };
