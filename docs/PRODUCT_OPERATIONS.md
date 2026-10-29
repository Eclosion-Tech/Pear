# Optional product operations integration

Pear includes an optional interface for reviewing product initiatives, human
decisions and evidence, plus a bounded MCP contract for contributing work. It is
disabled by default. Pear does not bundle an operations service, database,
background controller or inference provider. An operator may connect a compatible
service of their choice; ordinary Pear workspaces do not require one.

## Self-hosted human interface

The workspace interface uses Pear's existing configurable OIDC provider. Set
both `NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID` and
`NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY` for your own identity provider. Despite the
historical variable names, the authority is operator-configured; this integration
has no default issuer or hosted login account. The compatible service must verify
the ID token's signature, issuer, intended client audience and expiry, then check
current workspace membership and initiative access. Browser display configuration
is not authorization.

Set these server environment variables only after that service and its trust
configuration are ready:

```dotenv
PRODUCT_OPERATIONS_SERVICE_URL=https://operations.example.test
PRODUCT_OPERATIONS_WORKSPACE_SLUG=workspace
PRODUCT_OPERATIONS_UI_PRODUCTS=[{"workspaceSlug":"workspace","productId":"demo-product","label":"Demo product","sources":[]}]
```

The URL must be an HTTPS origin without credentials, query, fragment or path. No
network request is made without explicit configuration. The workspace slug must
match the active Pear database name; changing workspaces does not change the
configured destination. `/workspace/operations` renders the panel and its browser
requests go through the same-origin `/api/product-operations` proxy. The proxy
requires matching browser origin, forwards only the explicit bearer ID token,
and supplies the server-configured workspace slug. It never forwards cookies or
accepts browser actor/workspace overrides. Authentication and authorization remain
mandatory at the receiving service; this proxy does not verify a bearer itself.

`sources` contains operator-registered `{ "resource": "...", "label": "..." }`
choices. Empty lists allow reviewing existing initiatives; the initial creation
form requires an available source. That form creates a bounded `pear.source.read`
delegation, not a running assignment. A service must explicitly implement and
authorize this capability before offering it. An optional `controllerActorId`
may identify an already-authorized `agent:<grant UUID>:<64-character identity>`.
Adding a display choice does not create a grant, credential, adapter or worker.

## Compatible service boundary

The human endpoint is `POST /v1/product-operations`, with JSON
`{ schemaVersion: 1, workspaceSlug, productId, ...actionFields }`. Responses use
`{ ok: true, result }` or `{ ok: false, error }`. The panel reads `whoami`, `list`,
`get` and `plan`; `whoami` supplies the verified actor and role, while `list`
returns participant-filtered summaries with bounded pagination. State/view fields
are defined in [`ui.ts`](../web/src/lib/product-operations/ui.ts).

Mutations use `action: "apply"`, `initiativeId`, and
`command: { id, expectedRevision, payload }`. A compatible service must bind the
command identity to its exact actor, scope and payload, enforce optimistic
revision checks and retain durable receipts. Human creation and decisions must
be authorized independently from agent contributions. Decision options are never
preselected by the panel. An interrupted request may have committed: the panel
retains the original command in account/product-scoped session storage and never
automatically resubmits it. An explicit check reuses the same identity and terms.

## Optional MCP host capability

The three tools are hidden unless a host supplies `McpContext.productOperations`.
Native worker-token chat does not acquire them. A host may implement the portable
[`ProductOperationsApi`](../web/src/lib/mcp/product-operations-contract.ts)
interface or use the bounded
[`createProductOperationsRelay`](../web/src/lib/mcp/product-operations-relay.ts)
helper with its own verified OAuth caller, HTTPS origin and independent signing
key. The helper has no default endpoint or credential and requires both settings.

| Tool | Required OAuth scopes |
| --- | --- |
| `product_operations_read` | `product-operations:read` |
| `product_operations_contribute` | read and `product-operations:write` |
| `product_operations_dispatch` | read, write and `product-operations:execute` |

Existing grants/default scopes are not widened. Before attaching the capability,
the host must verify token signature, issuer/audience, expiry and current grant
binding, then intersect token and grant scopes. The receiver must independently
recheck current grant/member authority. The tool contract rejects caller-supplied
actors, workers, workspace substitutions and adapter selection. Creation, human
decisions, stopping work, changing delegation and reporting/reconciling execution
are unavailable through these agent tools. Dispatch only queues an existing
authorized assignment; it does not claim that execution succeeded.

The optional relay posts `{ caller, request }` to
`/v1/product-operations/relay`. Its HMAC-SHA256 signature binds the exact body,
timestamp, HTTP method, path and `pear-product-operations-relay-v1` domain.
[`product-operations-signature.ts`](../web/src/lib/mcp/product-operations-signature.ts)
defines the interoperable message. Keys are independent 32-byte values encoded as
64 lowercase hexadecimal characters. The receiver must validate the signature
and timestamp freshness; the command receipt remains responsible for idempotency.
OAuth bearer tokens and source credentials are never included in relay bodies.
Unknown write outcomes retain command/operation identity and never trigger an
automatic retry or alternate provider.

## Verification

With the repository's declared dependencies installed:

```sh
pnpm --dir web exec vitest run src/lib/mcp/product-operations.test.ts src/lib/product-operations/proxy.test.ts src/components/ProductOperationsPanel.test.tsx src/components/ProductOperationsOidcPanel.test.tsx
pnpm --dir worker exec node --import tsx/esm --test src/mcp-parity-tools.test.ts
```

These tests use synthetic identities, example domains and in-memory responses.
They do not need any organization's account, service, grant, model or credentials.
