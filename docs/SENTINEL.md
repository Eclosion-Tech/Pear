# Sentinel implementation status

**Updated:** 2026-10-19

**Status:** S0 foundation only. The shared policy package is not connected to a
runtime. Protected mail, durable admissions, source storage, credential brokers,
and host egress enforcement are not enabled by this change.

Sentinel will enforce authority and disclosure rules outside the model. Email,
webpages, workspace content, tool output, and derived summaries cannot grant
permissions. A compromised model may still produce false or harmful text;
containment must prevent its forbidden effects independently of detection.

## Implemented foundation

[`packages/sentinel`](../packages/sentinel/README.md) defines four fixed mail
operations, host-owned grants and exposure snapshots, strict runtime validation,
and a pure eligibility check. It binds the workspace, principal, runtime, run and
parent run, connection epoch, exact mailbox/folders, processor configuration,
private storage destination, expiry and resource ceilings. Every exposed source
revision and ancestor must permit the actual processor or storage destination.
Multiple revisions retain their separate restrictions. Missing or cyclic source
graphs fail closed.

There is no generic tool, URL, shell, send, share, or arbitrary page-write
operation. A screening result can hold processing but cannot authorize it.
Denials use fixed codes without echoing arguments or source identifiers.
Canonical SHA-256 operation fingerprints include exact action fields and the
host-computed payload digest. They do not authenticate authority or represent a
dispatch permit.

An eligible result explicitly requires a later durable admission. The package
does not authenticate snapshots, consume a budget, store an admission, prevent
replay, recheck live ACLs, or enforce network routing. Those remain separate
requirements. Model output must never provide host-owned policy state.

## Diagnostic privacy

The worker now uses fixed event codes, counts, numeric record IDs and opaque
instance labels in the covered paths. Full tool arguments/results, search
queries, fetch URLs, workspace/display labels, and raw error objects/stacks were
removed from these diagnostics:

| Paths | Covered behavior |
|---|---|
| `tools.ts`, `llm.ts` | Native-tool diagnostics and model tool-call logging |
| `conversation.ts` | Conversation tool loops, message flushes and turn/stream failure diagnostics |
| `composite-tool-executor.ts`, `mcp-tool-executor.ts`, `audit-logger.ts` | Dispatch/collision/snapshot/handshake failures and fixed audit outcome details |
| `database-worker.ts`, `ai-user-worker.ts`, `index.ts` | Workspace/AI worker lifecycle and global failure handlers |
| `attachments.ts`, `workspace-files.ts`, `subscriptions.ts` | Attachment/blob and subscription failure diagnostics |

This is not a worker-wide privacy guarantee. Notion import/fetch,
structural-sensor, standalone MCP HTTP/stdio, scribe, and operator provisioning
CLI diagnostics still need review before participating in a protected profile.
Functional private conversation traces and task failure outputs remain content
records; tool audit hashes remain identifiers rather than anonymized telemetry.
Their storage/read boundaries require later substrate enforcement. The current
audit writer's failure behavior is unchanged and is not a durable admission log.

## Coverage inventory and release gates

| Surface | Current implementation | Required before protected use |
|---|---|---|
| Fixed mail operations | Offline validation and eligibility contracts | Trusted adapter, authenticated approval, durable atomic admission |
| Source/exposure graph | In-memory policy inputs with ancestral constraints | Substrate-owned revisions, atomic imports and complete host-observed exposure tracking |
| Mail destination/readers | Existing mail/page ACL behavior unchanged | Owner-only protected resources; deny ordinary AI and publisher-backed projections through SQL, subscriptions, search, snapshots, blobs, API and MCP |
| Authority/dispatch | Exact operation fingerprint only | Current epoch/rights and shared budgets checked transactionally; one-use admission, dispatch-time recheck, conservative unknown outcomes |
| IMAP, model and classifier credentials | Existing worker custody unchanged | Isolated roles with minimal environment/mounts, authenticated RPC and host-enforced network policy |
| Mail settings/lifecycle | Existing monitor unchanged | Draft/test/preview/enable, frozen processor approval, authentication-message suppression, cancellation and accurate terminal/backoff states |
| Normal chat, APIs, MCP and output streams | Existing controls unchanged | Shared authorization across reads, writes, inference, responses, exports, notifications and sharing |
| Memory, compaction, delegation and schedules | Graph tested with synthetic derived records | Automatic exposure persistence and narrowed authority across resume/children |
| Public research, Bridge, harness and browsers | No Sentinel contract or integration | Separate reviewed effects, constrained execution and destination enforcement |

The first protected mail workflow will use a fixed private destination and no
ordinary assistant page grant. The assistant selector will reference a reviewed
model profile only. General assistants must not receive protected mail until
their outgoing paths are governed. Existing configurable IMAP support remains
available; this foundation does not upgrade it to the protected profile.

S0's fixed mail contracts, offline policy attacks and covered logging regression
tests are implemented. The planned public-research recipe, synthetic transport
sinks, full entry-point closure, and actual model/host attack evaluation remain
later work. Do not interpret an offline policy test as a network containment
test or a classifier accuracy result.

## Validation

- `pnpm --filter @eclosion-tech/sentinel test`: strict TypeScript check and
  synthetic policy/validation/fingerprint attacks; no external services.
- `pnpm --filter @pear/worker test`: worker TypeScript check and full unit suite,
  including 18 diagnostic privacy regressions with synthetic secret markers.

Tests cover forged approvals, unknown effects, scope/epoch/time mismatches,
destination substitution, changed processors, malformed JSON-like objects,
resource limits, missing/cyclic source graphs, and restrictions preserved
through summaries, memory, compaction and child-context derivation. A real host
must still prove that it records every exposure and sends every effect through
the enforced boundary.
