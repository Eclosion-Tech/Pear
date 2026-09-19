# Security review — 15 September 2026

Status: local fixes, pending coordinated deployment. This is a targeted source
review and regression suite, not a certification of the whole application.

Reviewed Pear source at `b8c5c8bd6b9bdac337fc5d438b2329c8be052ea3`, with
cloud source at `daa232449c24af92e199494c381e359dcd55d0bd`. All attack fixtures
used synthetic accounts, keys and data in disposable localhost databases.
No production attack, credential extraction, or production deployment was performed.

## Fixed in this working tree

| Severity | Finding | Fix |
| --- | --- | --- |
| High | AI configuration reducers accepted unrelated callers, including anonymous identities. Changing a provider endpoint while retaining its key could redirect authenticated inference requests. | Require an authenticated creator, workspace administrator, or module publisher for profile, model, endpoint, keys, worker token, tool secrets, inference binding and deletion. |
| High | Job execution accepted caller-supplied worker names; job prompts, tasks and context were public. | Publisher-only worker operations; requester/executing-AI visibility, additionally constrained by page access. |
| High | Jobs could select another AI's credentials or omit the AI identity to execute tools with the worker's publisher connection. | Authenticate the actual principal; constrain AI selection to self, creator or administrator; reserve unassigned jobs for administrators/publisher. Apply these checks inside the shared job constructor so automations cannot bypass them. Attribute automated jobs to their effective run-as identity. |
| High | Cloud proxy authenticated a workspace Host but forwarded arbitrary pool paths. | Bind allowed database operations to the Host's exact workspace slug; reject other tenants, traversal, and control-plane operations. Cloud change is in `pear-cloud/lifecycle/src/handlers.rs`. |
| High | Cloud file reader used caller-supplied storage keys if workspace lookup failed. | Deny reads when lifecycle is configured and workspace resolution fails. Preserve standalone behavior when lifecycle is absent. |
| High | IPv4-mapped IPv6 became hexadecimal after URL parsing and bypassed private-address checks. | Normalize IPv6 before classification; deny mapped, local and transition addresses. |
| Medium | Schema instruction-column seeding bypassed schema write permission. | Require the normal schema write guard. |
| Medium | Endpoint creation did not check access to its target database. | Require write access to the database page. |

The local pre-patch fixture reproduced unauthorized AI configuration mutations.
The patched live suite exercises anonymous, member, AI, creator/admin and
publisher paths, including successful authorized operations. The proxy and
network fixes have focused unit regressions. Endpoint creation has a source-level
guard; it does not yet have a dedicated live regression case.

## Validation

- Release WASM builds successfully, module version `1.0.0-beta.36`.
- Module Rust unit tests: 44 passed.
- Worker suite, including identifier checks: 260 passed.
- Cloud lifecycle suite: 89 passed, 1 ignored. Tests requiring localhost listeners
  were rerun outside the socket-restricted sandbox.
- Web HTTP transport/dispatcher: 7 passed.
- Fresh-database access-control regression: 97 passed.
- In-place beta.35 → beta.36 upgrade: 98 passed, including preservation of an
  existing job. A plain PUT was correctly rejected as client-breaking; the
  established pre-publish/token flow succeeded without clearing data.
- Generated web and worker TypeScript bindings include `readable_jobs`.

Run `web/scripts/access-control-e2e.ts` against a disposable local host after
building the module. Optional `PEAR_UPGRADE_FROM_WASM=/path/to/old.wasm` seeds an
old-module job before upgrading with lifecycle's non-destructive pre-publish
flow, then runs the same security checks. Never use database clearing to install
this security update.

## Deployment and compatibility

Publish beta.36 with lifecycle's `pre_publish` migration plan and returned
`BreakClients` token. The new caller-scoped view/index is considered a client
change by SpacetimeDB 2.0.3. Coordinate module, generated bindings, HTTP gateway,
web and worker rollout; new HTTP transports must not run against older modules.
Restart long-lived workers and confirm they use the module publisher for queue
execution and individual AI identities for governed tools.

Unassigned jobs from ordinary members now fail deliberately: their old path ran
tools as publisher. Use an AI identity the caller is allowed to manage instead.
Automation rules naming an unrelated AI will also fail rather than borrow its
credentials. Test real automation workflows in the canary workspace.

The lifecycle proxy now permits only workspace data operations and identity
token exchange. Provisioning/migration must continue using the trusted direct
pool path. Verify browser login, websocket subscriptions, MCP reads/writes,
delegation, automation execution, blob reads, and backup export in a canary
before promotion. Rolling back restores the corresponding exposures.

## Unresolved findings and review boundaries

The following were unresolved at the end of the first pass. The subsequent
implementation and current deployment requirements are recorded in
[the follow-up](SECURITY_FOLLOWUP_2026-09-15.md). Do not use this historical list
to infer the current working-tree status or deployed fleet status.

1. **Attachment authorization:** cloud blob routes and MCP readers enforce
   workspace membership/prefixes, but not page/conversation permissions. A
   workspace member can enumerate workspace blobs. An authoritative attachment
   ownership/sharing model is needed across upload, attachment creation, read,
   list and delete; checking a caller-created reference alone is bypassable.
2. **Login-token trust:** lifecycle applies membership checks to RS256 tokens
   but passes other algorithms to SpacetimeDB. Verify native-token issuer,
   audience, workspace binding and membership revocation end to end. The module's
   email/name-derived OIDC authentication also needs an explicit trusted-issuer
   review. No live bypass was tested.
3. **Other operational data:** automation queues/run logs and review annotations
   remain outside the new job-table visibility rules. Review their payload
   disclosure and write authorization; a job result copied to an automation log
   does not inherit job RLS automatically.
4. **DNS rebinding:** the network guard resolves and checks DNS before fetch,
   which resolves again. Pin a validated address at connection time to close
   that race. The IPv6 patch does not solve it.
5. **Credential storage and local login:** hosted AI identity secrets remain
   plaintext in the lifecycle storage path; local passwords use a fast SHA-256
   construction. Encryption/key management and password migration/rate limiting
   require separate changes and rollout tests.

Dependency advisories, infrastructure configuration, large-workspace query
performance and incident history were not exhaustively assessed. Passing local
tests does not establish that the deployed fleet contains these fixes.
