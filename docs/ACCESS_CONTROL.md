# Page and conversation access control

Introduced in module `1.0.0-beta.35`, addressing Pear tasks 14437 and 333.

## Enforced boundary

A SpacetimeDB identity alone is not workspace membership. Page reads and writes
require an authenticated human, a provisioned AI identity, or the module
publisher. The first native account bootstraps the workspace; subsequent native
accounts must be created by an administrator. Logging out does not reopen
bootstrap registration. Only an administrator or publisher can provision AI
identities.

Page rules retain their existing semantics: no rule on the page or its ancestors
means open to workspace principals; otherwise an explicit ancestor/page grant
or an authenticated administrator is required. Write implies read. New child
pages inherit access dynamically, so revoking a parent's grant also affects its
children. Existing explicitly stored child grants are preserved: historical
copies are indistinguishable from deliberate grants and are not silently
removed during upgrade.

Private and participant conversations require active participation. Workspace
administrator status and access to the containing page do not confer private
conversation access. A page-inheriting thread is also visible to readers of its
page. A removed participant loses access unless the thread independently grants
it through page inheritance. Conversation mutation checks enforce the same
boundary; an unrelated administrator cannot self-add or expand a private thread.

The module publisher retains SpacetimeDB's administrative RLS bypass, as required
by backups and trusted worker operations. Do not give publisher credentials to
MCP clients or use them as a substitute for a caller's AI-user token.

## Implementation and compatibility

Four caller-scoped views compute readable page, component, schema, and
conversation IDs. Content tables join directly to these views. Page protection
includes component/Yjs content, attachment metadata, snapshots, schema/column
metadata, saved views, property values/history, evaluation output, memory-root
metadata, and API row markers. Conversation protection includes participants,
messages, attachments, and access-request records.

SpacetimeDB 2.0.3 accepts chained RLS joins for SQL reads but rejects their live
subscriptions. A tiny local fixture verified that joining a caller-scoped view
works for initial subscriptions and delivers removals when permissions change.
This follows the [RLS documentation](https://spacetimedb.com/docs/how-to/rls/),
with the actual query shapes verified against the pinned host.

An HTTP-only caller's first protected read must first evaluate the corresponding
view. `HttpStdbTransport` does this once per view per token-bound transport, using
a small `COUNT(*) AS count` query. View dependencies remain current after SQL
evaluation; raw SQL cannot reuse a revoked grant even without a WebSocket.
Initialization failures fail the requested read and can be retried. The transport
never falls back to an unscoped read. Direct SQL integrations should query the
appropriate `readable_*` view before their first protected-table read.

The views are derived state and excluded from snapshots. No existing content
rows are rewritten or deleted by this release. Views recompute from existing
identity, page, ACL, and participant rows. This is a page/conversation boundary
change, not a workspace-wide audit of unrelated operational tables.

## Validation

Run a separate local host (the suite refuses non-localhost URLs):

```sh
spacetime start --listen-addr 127.0.0.1:3098 --data-dir /tmp/pear-access-stdb --in-memory --non-interactive
```

From `server/spacetimedb`:

```sh
cargo build --locked --offline --target wasm32-unknown-unknown --release
cargo test --locked --offline
```

From `web`:

```sh
node --import tsx scripts/access-control-e2e.ts http://127.0.0.1:3098
pnpm test
pnpm exec tsc --noEmit
```

The live suite publishes to a unique disposable database, creates synthetic
human/AI identities, exercises SQL plus live WebSocket subscriptions, and removes
its database at the end. It does not use production credentials or data.

## Rollout

Deploy as a coordinated module, bindings, web, gateway, and worker release.
The HTTP transport requires the new views, so deploying it against an older
module fails protected reads. Prepare host artifacts first, publish beta.35,
then activate the matching HTTP hosts and restart long-lived workers. Run the
usual post-publish migrations and verify a canary workspace before promotion.

SpacetimeDB 2.0.3 classifies this upgrade as client-breaking. Use lifecycle's
existing `POST /pre_publish` migration-plan flow and its returned token with
`PUT ?policy=BreakClients&token=...`; do not clear the database. An in-place
upgrade of the local pre-fix fixture preserved every existing page field and
blocked the previously reproducible anonymous read/write immediately afterward.

Canary acceptance: native/OIDC login, page editing, an AI reading its own memory,
denial for a different AI, private chat isolation, inherited grant/revocation,
and a real MCP read/write/read-back using caller credentials. Verify backup
export under the publisher identity. Any rollback must account for the fact that
an older module restores the original access-control exposure.

Local tests do not certify the production deployment, legacy grant cleanup,
OIDC issuer configuration, blob-store authorization, or workspace-scale
performance. These require the matching canary/operational checks.
