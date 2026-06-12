# Custom API Endpoints

Pear lets you expose any database (Pear's tabular page type) as a versioned
REST API. Once you create an endpoint, every row in that database becomes
addressable over HTTP, with field-level mappings, per-property type
coercion, optional API-key authentication, and an auto-generated OpenAPI
3.1 spec for documentation and SDK generation.

This document describes:

1. The feature surface (what endpoints look like to a caller).
2. The configuration UI under **Workspace Settings → API Endpoints**.
3. The environment-variable contract that controls which HTTP handler
   actually serves traffic.
4. The override hook used by Pear-Cloud (and any operator who wants to
   front Pear with their own gateway).

If you're a self-hoster running Pear out of the box, the default Next.js
handler is enabled and routes live at `/api/e/{slug}` — there is nothing
else to configure.

---

## 1. What the API looks like

Each endpoint exposes a CRUD-shaped REST surface scoped to a single
database.

```
GET    /api/e/{slug}             # list rows
POST   /api/e/{slug}             # create a row (atomic)
GET    /api/e/{slug}/{rowId}     # read a row
PATCH  /api/e/{slug}/{rowId}     # partial update (atomic)
DELETE /api/e/{slug}/{rowId}     # soft delete

GET    /api/e/{slug}/_schema     # OpenAPI 3.1 spec for this endpoint
```

The set of methods exposed is configurable per endpoint — turning off
`POST` or `DELETE` is a hard 405, not a permission check.

### Request and response bodies

Bodies are JSON. The shape is driven entirely by the **Field Mappings**
configured for the endpoint:

- The mapping's `apiFieldName` is what shows up in the JSON.
- The property's type (`Text`, `Number`, `Date`, `Select`, `MultiSelect`,
  `Relation`, `Checkbox`, `Url`, `Person`) determines how Pear coerces
  the JSON value into a SpacetimeDB `PropertyValue`.
- Mappings flagged `requiredOnCreate` are required on `POST`.
- Mappings flagged `readOnly` are accepted on `GET` responses but
  rejected on `POST` / `PATCH`.

When an endpoint is created, `create_api_endpoint` auto-generates one
mapping per column of the database's **effective schema** — including
columns inherited through `DatabaseSchema.parent_schema_id` (see
`docs/FEATURE_schema_inheritance.md`). Inherited mappings reference the
parent's original `property_definition_id`.

The full encoding rules live in
[`pear/web/src/lib/api-endpoint/codec.ts`](../web/src/lib/api-endpoint/codec.ts).

### Atomicity

`POST`, `PATCH`, and `DELETE` use the dedicated reducers
`create_database_row`, `update_database_row`, and `delete_database_row`.
Each reducer commits the page mutation **and** all property-value
mutations in a single SpacetimeDB transaction. There is no partial-row
failure mode visible to API callers.

`POST` is also idempotent on the `Idempotency-Key` header — passing the
same key twice within the marker retention window returns the original
row instead of creating a second one. The handler implements this by
generating a UUID, passing it to the reducer as `client_request_id`, and
then resolving the resulting `page_id` from the `DatabaseRowMarker`
table.

### Authentication

Endpoints have a single boolean: **Auth required**. When on, callers must
present `Authorization: Bearer <key>`. Keys are minted in the UI and
stored as SHA-256 hashes (the plaintext is shown exactly once). Each
successful authenticated request bumps `last_used_at` via the
`touch_api_endpoint_key` reducer so abandoned keys are easy to find.

When **Auth required** is off, the endpoint is publicly callable. The UI
guards this transition behind a typed-confirmation modal because flipping
that switch on a write-enabled endpoint exposes mutations to the entire
internet.

### Who can manage endpoints and keys

Endpoints, field mappings, and API keys are **shared workspace
infrastructure**. The reducer family (`update_api_endpoint`,
`delete_api_endpoint`, `create_api_field_mapping`,
`update_api_field_mapping`, `delete_api_field_mapping`,
`create_api_endpoint_key`, `revoke_api_endpoint_key`) routes its
ownership check through `require_creator_or_admin`, so a mutation is
accepted from either:

- the original `created_by` identity, or
- any **workspace admin** (`User.is_admin = true`).

Pear's admin model lives entirely on the `User` table:

- The first user to authenticate on a fresh database is auto-promoted
  in `client_connected` / `register` / `login`, so a workspace can never
  start admin-less.
- Subsequent promotions/demotions go through the admin-only
  `set_user_admin(target_identity, is_admin)` reducer, which refuses to
  demote the last remaining admin so a workspace can never *become*
  admin-less either.
- The Members panel
  ([`pear/web/src/components/MembersSettings.tsx`](../web/src/components/MembersSettings.tsx))
  surfaces every authenticated member with an "Admin" badge and gives
  admins Promote/Demote controls.

This means an endpoint orphaned by a stale-tab/wipe accident or an
OIDC `sub` rotation can be deleted by any other admin in the workspace
without admin SQL — see `docs/SECURITY.md` §9 for the full failure
mode this resolves.

Extension and AI-user reducers deliberately **do not** honor `is_admin`
— those rows are per-installer / per-creator by design (see
`docs/PEAR_EXTENSIONS_SECURITY.MD`).

### Audit log

Every request — successful or not — is appended to the `ApiCallLog`
table by the `log_api_call` reducer. The endpoint detail view in the UI
surfaces the most recent 20 entries per endpoint (timestamp, method,
path, status, latency, caller IP).

### OpenAPI

`GET /api/e/{slug}/_schema` returns a freshly built OpenAPI 3.1 document
describing the endpoint's request/response schemas, allowed methods, and
auth requirements. The same URL is what the **Show API docs** button in
the UI hands to the lazy-loaded
[Stoplight Elements](https://github.com/stoplightio/elements) viewer.

---

## 2. UI: Workspace Settings → API Endpoints

The settings panel
([`pear/web/src/components/ApiEndpointsSettings.tsx`](../web/src/components/ApiEndpointsSettings.tsx))
covers the full lifecycle:

- **Create** — pick a database, choose a slug, choose allowed methods.
  `Auth required` defaults to `true`.
- **Edit** — toggle auth, manage field mappings, mint and revoke API
  keys, view recent calls, view live API docs.
- **Delete** — tears down the endpoint plus all of its mappings and
  keys.

Slugs are validated against a reserved list (`_schema`, `health`,
`docs`, …) and may not begin with `_`. The reserved list lives in
`pear/server/spacetimedb/src/lib.rs` next to `validate_slug`.

The URL displayed in the UI (the **Endpoint URL**, the **curl** example,
the **OpenAPI Schema** link, and the slug-prefix preview in the create
form) is rendered through the template resolver — see the next section.

---

## 3. Environment-variable contract

There is exactly **one** environment variable involved:

| Variable                            | Where read                       | Default                            | Effect                                                                                                                                                                       |
| ----------------------------------- | -------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PEAR_API_URL_TEMPLATE` | Browser **and** server (Next.js) | `{origin}/api/e/{endpointSlug}`    | Controls the URL the UI advertises, **and** whether the bundled `/api/e/...` Next.js handler serves traffic. When set to a non-default value the bundled handler self-disables (returns `410 Gone` with a `Location` header that points at the templated URL). |

Recognised placeholders inside the template:

| Placeholder        | Replaced with                                                       |
| ------------------ | ------------------------------------------------------------------- |
| `{origin}`         | `window.location.origin` (or the request origin on the server)      |
| `{workspaceSlug}`  | The current workspace slug, parsed from `/workspace/{slug}/...`     |
| `{endpointSlug}`   | The endpoint's `slug` column                                        |

### Examples

**Self-hosted Pear (default — leave unset):**

```
# unset → resolves to {origin}/api/e/{endpointSlug}
# e.g.  https://pear.example.com/api/e/fruit
```

**Subdomain-per-workspace gateway (Pear-Cloud's deployment):**

```bash
NEXT_PUBLIC_PEAR_API_URL_TEMPLATE='https://{workspaceSlug}.api.pear.pro/{endpointSlug}'
```

A workspace `acme` with an endpoint `fruit` resolves to
`https://acme.api.pear.pro/fruit`. The bundled Next.js handler stops
serving traffic and instead 410s with a `Location` header pointing at
the templated URL.

**Path-per-workspace gateway:**

```bash
NEXT_PUBLIC_PEAR_API_URL_TEMPLATE='https://api.example.com/{workspaceSlug}/{endpointSlug}'
```

**Custom origin, default path layout (e.g. moving APIs onto a CDN
hostname while keeping the bundled handler):**

```bash
NEXT_PUBLIC_PEAR_API_URL_TEMPLATE='https://api.example.com/api/e/{endpointSlug}'
# Note: this also disables the bundled handler because the template no
# longer matches the literal default.
```

---

## 4. The override hook

Operators who set a custom `NEXT_PUBLIC_PEAR_API_URL_TEMPLATE` are
expected to provide their own HTTP handler at the templated URL. To make
that easy, the implementation is split into:

- **A platform-agnostic library** at
  [`pear/web/src/lib/api-endpoint/`](../web/src/lib/api-endpoint/).
  Imports nothing from `next/server`, the file system, or any host
  runtime.
- **A default Next.js handler** at
  [`pear/web/app/api/e/`](../web/app/api/e/) that wires the library to
  Next's `Request`/`Response` model and reads `PEAR_STDB_*` env vars to
  talk to SpacetimeDB.

To bring your own handler, depend on `pear/web/src/lib/api-endpoint`
from your runtime of choice and call `dispatchApiEndpointRequest`. The
library accepts an injected `StdbTransport`, so you can either reuse
the bundled `HttpStdbTransport` (HTTP API client) or supply your own —
for example, calling SpacetimeDB over its WebSocket SDK from inside a
Cloudflare Worker.

The minimum a custom handler needs to do:

1. Resolve the workspace from the request (subdomain, header, JWT —
   whatever you've decided on at the gateway).
2. Look up the per-workspace STDB service identity / token.
3. Construct an `HttpStdbTransport` (or your own) targeting that
   workspace's database.
4. Authenticate the request (API key, session, mTLS — your call).
5. Call `dispatchApiEndpointRequest({ transport, auth, request, ... })`.
6. Return the resulting `Response`.

For a complete reference implementation, see the Pear-Cloud Cloudflare
Worker at `pear-cloud:workers/api/`.

### Why split it this way?

The split exists so that:

- Self-hosters get a working API surface with zero extra infrastructure.
- Hosted offerings (Pear-Cloud, vendor deployments, BYO gateways) can
  do the things you can't reasonably do in-process — wildcard
  subdomains, edge rate limiting, in-isolate caching, regional
  failover — without having to fork the OSS code path.
- Both code paths share the exact same endpoint configuration,
  type-coercion, OpenAPI generation, and atomic reducers, so behaviour
  stays consistent between deployments.

---

## File map

| Concern                          | File                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Schema, reducers, validation     | `pear/server/spacetimedb/src/lib.rs` (search `Custom API Endpoints`)                |
| Codec (JSON ↔ `PropertyValue`)   | `pear/web/src/lib/api-endpoint/codec.ts`                                            |
| Endpoint config cache            | `pear/web/src/lib/api-endpoint/cache.ts`                                            |
| OpenAPI builder                  | `pear/web/src/lib/api-endpoint/openapi.ts`                                          |
| Request dispatcher (host-agnostic) | `pear/web/src/lib/api-endpoint/dispatcher.ts`                                     |
| URL template resolver            | `pear/web/src/lib/api-endpoint/url-template.ts`                                     |
| HTTP STDB transport              | `pear/web/src/lib/api-endpoint/http-transport.ts`                                   |
| Default Next.js handler          | `pear/web/app/api/e/_shared.ts` + `[slug]/route.ts`, `[slug]/[id]/route.ts`, `[slug]/_schema/route.ts` |
| Settings UI                      | `pear/web/src/components/ApiEndpointsSettings.tsx`                                  |
| Lazy-loaded API docs viewer      | `pear/web/src/components/ApiEndpointsDocsPanel.tsx`                                 |
