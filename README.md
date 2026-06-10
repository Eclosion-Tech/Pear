# Pear

**A self-hosted, relational-first Notion alternative built on SpacetimeDB.**

Pages and database rows are the same entity — a page viewed in a grid is a row, a row opened fully is a page. Real-time data syncs over SpacetimeDB subscriptions; documents are typed component trees with Yjs-backed rich text, synced live through the database.

---

## Philosophy

- **Pages are database entries.** No distinction between a "page" and a "row". Same entity, different lens.
- **Relations are first-class.** Linking two databases is a core primitive, not a power-user feature.
- **Self-hostable by default.** Your data lives where you put it. No vendor lock-in.
- **The client is sovereign.** A workspace is just a server you connect to. No central registry, no platform that can enumerate or revoke your access.

---

## Stack

| Layer | Technology |
|---|---|
| Backend / sync | [SpacetimeDB](https://spacetimedb.com) (Rust module) |
| Frontend | Next.js · React 19 · Tailwind CSS 3 |
| Editor | Component-tree editor (`packages/pulp`) — typed `ComponentNode` rows in SpacetimeDB, per-block Yjs rich text via ProseMirror. [BlockNote](https://blocknotejs.org) retained as a legacy read path for unmigrated pages. |
| Worker | Node (optional) — AI conversations, Orcha task execution, tool runtime |
| Auth | Native SpacetimeDB email/password (default) · Any OIDC provider (optional) |
| Attachments | S3-compatible storage (MinIO in Docker Compose by default) |
| Containerisation | Docker Compose |

---

## Features

### Workspace & navigation

- **Sidebar** — Drag to reorder pages, collapse/expand subtrees, soft delete & restore from trash.
- **Quick switcher** — `⌘K` / `Ctrl+K` fuzzy search by title, plus **semantic search** over page embeddings when the query is long enough.
- **Breadcrumbs** — Hierarchy in the header (workspace → parent → current).
- **Page icons** — Emoji per page in the sidebar and headers.

### Documents

- **Component-tree editor** — every block is a typed `ComponentNode` row in SpacetimeDB. Slash commands, drag handles, multi-block selection, turn-into, undo/redo.
- **Rich text** — per-block Yjs documents (ProseMirror), merged through the server; inline **page links** (live title sync).
- **Blocks** — Headings, images and audio (uploads to blob storage), code, markdown, forms (inputs, buttons, selects), embedded AI conversations.
- **Audio** — Record or upload; inline playback; transcript via Web Speech API where the browser supports it.
- **History** — Snapshot timeline, preview, one-click restore; snapshots capture the full component tree.
- **Legacy pages** — pages created before the component tree still render via BlockNote and migrate in place.

### Databases

- **Grid, list & board views** — Column resize persisted per view; **frozen first column**; filters and multi-column sorts; board view grouped by a Select property.
- **Property types** — Text, Number, Date, Select (conditional options, per-option colors), Multi-select, Checkbox, URL, Relation, Person, Formula (client-evaluated expressions), Rollup, and AI columns (model-computed values).
- **Editing** — Inline cells, fill handle, keyboard navigation (arrows, Tab, Enter), multi-row selection with bulk delete.
- **Rows** — Open any row as a full page (routable URL) with properties panel.

### Files

- **Attachments** — Presigned upload/download via the web app; metadata in SpacetimeDB (`Attachment` table).

### Import & API

- **Custom API endpoints** — Expose any database as a versioned REST API (`/api/e/{slug}`) with field-level mappings, per-property type coercion, optional API-key auth, and an auto-generated OpenAPI 3.1 spec. See [`docs/API_ENDPOINTS.md`](./docs/API_ENDPOINTS.md).
- **Notion import** — The `import_notion` reducer rebuilds a Notion workspace (pages, databases, properties, content) into an empty workspace; the bundled settings panel drives it through an external OAuth + transform service.

### AI & extensions (optional)

- **AI users** — Configurable model providers; **conversations** attached to pages or anchored to individual blocks (@mention a block to start a thread), persisted in SpacetimeDB.
- **Agent edit review** — AI edits are bracketed with before/after snapshots; review and accept/reject them per page.
- **Orcha** — Job/task coordination tables and reducers embedded in the same module (or point workers at an external Orcha DB). Page-scoped jobs from the in-app panel.
- **Extensions** — Install MCP servers and config bundles; permissioned tool execution with audit logging. Built-in workspace tools extension seeded for new databases.

For a finer-grained shipped vs planned list, see [`ROADMAP.md`](./ROADMAP.md).

---

## Project structure

```
Pear/
├── server/
│   ├── spacetimedb/
│   │   └── src/             # Tables, reducers, types (lib.rs + modules; source of truth for API surface)
│   ├── docker/
│   │   └── entrypoint.sh    # Starts SpacetimeDB, publishes WASM module
│   └── spacetime.json       # Module path, TS bindings output dir
├── web/                     # Next.js app (UI, API routes, embeddings, uploads)
├── worker/                  # Optional Node worker (AI / Orcha / tools)
├── packages/
│   └── pulp/                # Storage-agnostic component-tree editor library
├── extensions/              # Example / built-in extension manifests
├── docs/                    # Public feature docs (e.g. API endpoints)
├── docker-compose.yml
└── pnpm-workspace.yaml
```

---

**Standalone OSS:** this repository is self-contained. Install dependencies with `pnpm` from the repo root (see [below](#development-without-docker)). It does not rely on the Pear Cloud app’s `node_modules` or any package from a parent monorepo.

---

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

That's it for the Docker path. Rust, the SpacetimeDB CLI, and pnpm are only needed for [local development](#development-without-docker).

### 1. Start the stack

```bash
docker compose up -d
```

Docker builds the Next.js client and the SpacetimeDB WASM module; the entrypoint publishes the module once SpacetimeDB is ready.

| Service | URL |
|---|---|
| SpacetimeDB | `http://localhost:3000` |
| Web client | `http://localhost:3001` |

Compose also brings up **MinIO** (or your configured S3-compatible backend) for attachment uploads — see `docker-compose.yml` and `.env.example` for variables.

### 2. Create an account

Open `http://localhost:3001` and register with any email and password. Authentication is handled natively by the SpacetimeDB module — no external auth service required.

### 3. Optional: AI worker

If you use AI users, conversations, or Orcha task execution, run the worker from the repo root:

```bash
pnpm worker
```

Copy and adjust variables from [`.env.example`](./.env.example) (and `web/.env.local` as needed).

---

## Development (without Docker)

### Prerequisites

- [Rust](https://rustup.rs/) with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- [SpacetimeDB CLI](https://spacetimedb.com/install)
- [pnpm](https://pnpm.io/installation)

### Backend

```bash
# Start a local SpacetimeDB instance
spacetime start

# Build the module and publish
cd server/spacetimedb
cargo build --release --target wasm32-unknown-unknown
cd ..
spacetime publish -s local pear-dev
spacetime call -s local --yes pear-dev run_pending_migrations
```

### Frontend

From the **repository root** (pnpm workspace — installs `web/`, `worker/`, `packages/pulp`, etc.):

```bash
pnpm install
pnpm --filter @pear/web dev   # or: cd web && pnpm dev  →  http://localhost:3001
```

Do not symlink another project’s `node_modules` into `web/`; the lockfile in this repo is the source of truth.

Set the SpacetimeDB URI in `web/.env.local` if it differs from the default:

```env
NEXT_PUBLIC_SPACETIMEDB_URI=ws://localhost:3000
NEXT_PUBLIC_SPACETIMEDB_DB_NAME=pear-dev
```

### Regenerate TypeScript bindings

Run this after any change to the module source under `server/spacetimedb/src/`:

```bash
cd server
spacetime generate
```

Output is written to `web/src/module_bindings/` (tracked in git).

---

## Authentication

### Default — native SpacetimeDB auth

Register and log in via the built-in email/password flow. No additional services required.

### Optional — OIDC

Point Pear at any OpenID Connect provider (Authentik, Keycloak, Auth0, etc.) by setting these environment variables on the web service:

```env
NEXT_PUBLIC_AUTH_MODE=oidc
NEXT_PUBLIC_OIDC_AUTHORITY=https://your-provider.example.com
NEXT_PUBLIC_OIDC_CLIENT_ID=pear
```

#### IdP requirements

For the Pear module to populate the workspace `User` row and auto-promote the first authenticated user to admin, the **ID token** (not the `userinfo` endpoint) must contain at minimum one of `email`, `name`, or `preferred_username`. SpacetimeDB validates the JWT against your provider's JWKS and the `client_connected` reducer reads the profile claims directly off the JWT payload — there is no userinfo round-trip from the module.

Both placements are valid per OIDC Core §5, but many IdPs default to the minimal-ID-token configuration (claims live in `userinfo` only). If your IdP does this, configure it to also emit the claims in the ID token when the corresponding scopes are granted:

| Scope | ID-token claims |
|------|-----------------|
| `email` | `email`, `email_verified` |
| `profile` | `name`, `preferred_username` (others optional: `given_name`, `family_name`, `picture`, `updated_at`) |

Provider-specific notes:

- **Keycloak** — Client → *Client scopes* → `email`/`profile` → *Mappers* → ensure each mapper has *"Add to ID token"* enabled.
- **Authentik** — Provider → *Property mappings* → make sure `email` and `profile` scope mappings have `userinfo: true` **and** `id_token: true`.
- **Auth0** — Action triggered on Post-Login: `api.idToken.setCustomClaim('email', event.user.email)` (built-in claims are normally already in the ID token by default for `openid email profile` scopes).
- **Cognito** — User pool → App integration → App client → ensure `email` and `name` are checked under *"Allowed read attributes"* and the corresponding scopes are requested.

#### Verifying the ID token

After login, decode the ID token (JWT) at <https://jwt.io> or with `jq`:

```bash
echo "$ID_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

The payload should include `email`, `name`, and/or `preferred_username` alongside the standard `iss`/`sub`/`aud`/`iat`/`exp`. If only the standard claims are present, the User row will land `is_authenticated=false` and the **Members** section in workspace settings will appear empty — that's the smoke test.

#### Custom auth bridges

If you're wiring a non-standard auth provider (or building Pear into another product), pass the JWT to SpacetimeDB at connect time:

```ts
import { DbConnection } from "./module_bindings";

const conn = DbConnection.builder()
  .withUri(wsUri)
  .withDatabaseName(dbName)
  .withToken(idToken)  // your IdP's ID token (RS256 JWT, validated by your IdP's JWKS)
  .onConnect((c, identity) => { /* ... */ })
  .build();
```

The identity SpacetimeDB derives is `SHA-256(iss ‖ sub)`, so the same user from the same IdP always maps to the same `Identity` across browsers/devices. The first authenticated user on a fresh database is auto-promoted to admin; subsequent admin changes go through `set_user_admin` and are gated on the caller already being admin.

---

## Backend API surface

The SpacetimeDB module is large and evolving. Rather than duplicating every reducer here:

- **Source of truth:** `server/spacetimedb/src/` — all `#[reducer]` functions and `#[table]` definitions (entry point `lib.rs`, grouped into modules).
- **High-level groups:** authentication (`register`, `login`, …), pages & Yjs (`save_yjs_state`, `update_page_content`, …), **component tree** (`insert_component`, `update_component_props`, `move_component`, …), snapshots, attachments, embeddings (`set_page_embedding`), database schema & property values & views, **AI users & conversations** (`create_ai_user`, `send_message`, `record_compaction`, …), **Orcha** (`create_job`, `claim_task`, `submit_result`, …), **extensions** (`publish_extension`, `install_extension`, permission/audit reducers, …), **HTTP API endpoints** (endpoint CRUD reducers), and **import** (`import_notion`, …).

Client call sites use the generated bindings under `web/src/module_bindings/`.

---

## License

[AGPL-3.0](LICENSE)
