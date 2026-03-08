# Pear

**A self-hosted, relational-first Notion alternative built on SpacetimeDB.**

Pages and database rows are the same entity — a page viewed in a grid is a row, a row opened fully is a page. Real-time collaboration is built in at the data layer, not bolted on.

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
| Frontend | Next.js 15 · React 19 · Tailwind CSS v4 |
| Editor | [BlockNote](https://blocknotejs.org) + Yjs (CRDT collaborative editing) |
| Auth | Native SpacetimeDB email/password (default) · Any OIDC provider (optional) |
| Containerisation | Docker Compose |

---

## Features

- **Documents** — Rich-text pages with collaborative editing powered by Yjs CRDTs. No typing jitter between collaborators.
- **Databases** — Spreadsheet-style grid view. New databases are seeded with default columns and rows.
- **Property types** — Text, Number, Date, Select, Multi-select, Checkbox, URL, Relation.
- **Relation columns** — Link rows across any two databases. Pick linked rows from a search dropdown.
- **Cell selection** — Click to select, Cmd/Ctrl+click for multi-select, Delete/Backspace to clear, Escape to deselect.
- **Inline editing** — Double-click any cell to edit in place. Select/Multi-select show a live-filtered option list with "Create X" for new options.
- **Row detail modal** — Open any database row as a full page with a property panel and rich-text editor.
- **Light / dark mode** — System-aware with a manual toggle.
- **Soft delete** — Pages are soft-deleted and can be restored.
- **Snapshots** — Point-in-time content snapshots with restore.
- **Real-time** — All state is streamed over a SpacetimeDB WebSocket subscription. No polling.

---

## Project structure

```
Pear.pro/
├── server/                  # SpacetimeDB backend
│   ├── spacetimedb/
│   │   └── src/lib.rs       # All tables, reducers, and types
│   ├── docker/
│   │   └── entrypoint.sh    # Container startup: starts SpacetimeDB, publishes module
│   └── spacetime.json       # CLI config (module path, TS bindings output dir)
├── web/                     # Next.js frontend
│   ├── app/                 # Next.js App Router pages & layouts
│   ├── src/
│   │   ├── components/      # UI components (GridView, DocPage, PropertyCell, …)
│   │   ├── hooks/           # SpacetimeDB data hooks (usePages, useDatabase, …)
│   │   ├── lib/             # SpacetimeDB connection, Yjs provider
│   │   └── module_bindings/ # Auto-generated TypeScript bindings (do not edit)
│   └── Dockerfile
├── docker-compose.yml
└── pnpm-workspace.yaml
```

---

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

That's it for the Docker path. Rust, the SpacetimeDB CLI, and pnpm are only needed for [local development](#development-without-docker).

### 1. Start the stack

```bash
docker compose up -d
```

Docker builds everything — the Next.js client and the SpacetimeDB WASM module — and the entrypoint script publishes the module automatically once SpacetimeDB is ready.

| Service | URL |
|---|---|
| SpacetimeDB | `http://localhost:3000` |
| Web client | `http://localhost:3001` |

### 2. Create an account

Open `http://localhost:3001` and register with any email and password. Authentication is handled natively by the SpacetimeDB module — no external auth service required.

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

# Build the module and publish it
cd server/spacetimedb
cargo build --release --target wasm32-unknown-unknown
cd ..
spacetime publish -s local pear-dev
```

### Frontend

```bash
pnpm install
cd web
pnpm dev        # starts Next.js on http://localhost:3001
```

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

---

## Backend reducers

The SpacetimeDB module exposes the following reducers:

| Reducer | Description |
|---|---|
| `register` / `login` / `logout` | Native auth |
| `set_user_profile` | Update display name / avatar |
| `create_page` | Create a doc or database page |
| `update_page_title` | Rename a page |
| `update_page_content` | Set legacy JSON content |
| `apply_yjs_update` | Apply a Yjs CRDT binary update |
| `delete_page` / `restore_page` | Soft delete and restore |
| `create_database_schema` | Initialise a database's column schema |
| `add_property` / `delete_property` | Add or remove a column |
| `rename_property` | Rename a column |
| `reorder_property` | Change column order |
| `update_property_type` | Change a column's type |
| `update_property_config` | Update a column's config (options, relation target, etc.) |
| `set_property_value` / `clear_property_value` | Write or clear a cell value |
| `create_view` / `rename_view` / `delete_view` | Manage database views |
| `update_view_config` / `set_default_view` | Configure views |
| `take_snapshot` / `restore_page_to_snapshot` | Content versioning |

---

## License

[AGPL-3.0](LICENSE)
