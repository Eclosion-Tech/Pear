# Pear

**A self-hosted, relational-first Notion alternative built on SpacetimeDB.**

Pages and database rows are the same entity — a page viewed in a grid is a row, a row opened fully is a page. Real-time data syncs over SpacetimeDB subscriptions; the editor is Yjs-backed and local-first, with merged state persisted to the server.

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
| Editor | [BlockNote](https://blocknotejs.org) + Yjs (local-first; full state snapshot to SpacetimeDB) |
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

- **Rich text** — BlockNote with slash commands, inline **page links** (live title sync).
- **Blocks** — Images and audio (uploads to blob storage), tables, code blocks with language picker and copy shortcut.
- **Audio** — Record or upload; inline playback; transcript via Web Speech API where the browser supports it.
- **History** — Snapshot timeline, preview, one-click restore; optional snapshot with live editor content.
- **Local-first** — IndexedDB holds working state; SpacetimeDB stores merged Yjs blobs and metadata on a debounced schedule.

### Databases

- **Grid & list views** — Column resize persisted per view; **frozen first column**; filters and multi-column sorts.
- **Property types** — Text, Number, Date, Select (conditional options, per-option colors), Multi-select, Checkbox, URL, Relation, Person, and agent-oriented fields where enabled.
- **Editing** — Inline cells, fill handle, keyboard navigation (arrows, Tab, Enter), multi-row selection with bulk delete.
- **Rows** — Open any row as a full page (routable URL) with properties panel.

### Files

- **Attachments** — Presigned upload/download via the web app; metadata in SpacetimeDB (`Attachment` table).

### AI & extensions (optional)

- **AI users** — Configurable model providers; **conversations** attached to pages (human ↔ AI), persisted in SpacetimeDB.
- **Orcha** — Job/task coordination tables and reducers embedded in the same module (or point workers at an external Orcha DB). Page-scoped jobs from the in-app panel.
- **Extensions** — Install MCP servers and config bundles; permissioned tool execution with audit logging. Built-in workspace tools extension seeded for new databases.

For a finer-grained shipped vs planned list, see [`ROADMAP.md`](./ROADMAP.md).

---

## Project structure

```
Pear/
├── server/
│   ├── spacetimedb/
│   │   └── src/lib.rs       # Tables, reducers, types (source of truth for API surface)
│   ├── docker/
│   │   └── entrypoint.sh    # Starts SpacetimeDB, publishes WASM module
│   └── spacetime.json       # Module path, TS bindings output dir
├── web/                     # Next.js app (UI, API routes, embeddings, uploads)
├── worker/                  # Optional Node worker (AI / Orcha / tools)
├── desktop/                 # Desktop shell (workspace)
├── extensions/              # Example / built-in extension manifests
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
```

### Frontend

From the **repository root** (pnpm workspace — installs `web/`, `worker/`, `desktop/`, etc.):

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

Run this after any change to `server/spacetimedb/src/lib.rs`:

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

- **Source of truth:** `server/spacetimedb/src/lib.rs` — all `#[reducer]` functions and `#[table]` definitions.
- **High-level groups:** authentication (`register`, `login`, …), pages & Yjs (`save_yjs_state`, `update_page_content`, …), snapshots, attachments, embeddings (`set_page_embedding`), database schema & property values & views, **AI users & conversations** (`create_ai_user`, `send_message`, `record_compaction`, …), **Orcha** (`create_job`, `claim_task`, `submit_result`, …), **extensions** (`publish_extension`, `install_extension`, permission/audit reducers, …), and **HTTP API integrations** (endpoint CRUD reducers for inbound webhooks).

Client call sites use the generated bindings under `web/src/module_bindings/`.

---

## License

[AGPL-3.0](LICENSE)
