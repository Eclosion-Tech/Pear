# Pear — Project Bible

## A Self-Hosted, Relational-First Notion Alternative

**Domain:** pear.pro

---

## 1. The Problem

Every serious Notion alternative (AFFiNE, AppFlowy, Anytype) treats databases and relational data as secondary features bolted onto a document editor. Notion got this right — pages and database rows are the same thing — but Notion is closed-source, cloud-only, and subscription-based. This project exists to fill that gap: a self-hosted, free, relational-first workspace where the data model is the product.

---

## 2. Core Philosophy

- **Pages are database entries.** There is no distinction between a "page" and a "row". A page viewed in a grid is a row. A row opened fully is a page. Same entity, different lens.
- **Relations are first-class.** Linking two databases together is not a power-user feature. It is a core primitive.
- **Self-hostable by default.** No vendor lock-in. Your data lives where you put it.
- **The client is sovereign.** A workspace is just a server. The client decides which servers to connect to. No central registry, no platform that can enumerate your workspaces or revoke your access. You own your connections.
- **Scope discipline.** Do fewer things better. No canvas mode, no whiteboard in v1. Just documents + databases + relations, done properly.
- **AI as infrastructure, not a feature.** AI is not a sidebar or a gimmick. The data model is designed from day one to be AI-readable and AI-writable. Agents operate on the same data layer as humans.

---

## 3. Tech Stack


| Layer                 | Choice                                        | Rationale                                                                                                           |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Backend / Sync        | SpacetimeDB                                   | Handles real-time sync, subscriptions, and state via reducers. Eliminates the hardest engineering problem.          |
| AI Orchestration      | Orcha                                         | Open protocol for coordinating multiple AI agents via SpacetimeDB. Agents read/write the same data layer as humans. |
| Editor                | BlockNote                                     | Built on Tiptap. Embeddable, has slash commands out of the box, looks good, not tightly coupled to any framework.   |
| Frontend              | React + Next.js                               | Standard, well-supported, good ecosystem.                                                                           |
| Language (DB module)  | Rust                                          | SpacetimeDB modules are written in Rust.                                                                            |
| Styling               | Tailwind CSS                                  | Utility-first, fast to iterate.                                                                                     |
| Auth (default)        | SpacetimeAuth                                 | Managed OIDC provider by SpacetimeDB. Handles email/password out of the box. Zero config required.                  |
| Auth (self-hosted)    | Any OIDC provider (Authentik, Keycloak, etc.) | Point Pear at your own provider via one env var. Pear stays auth-agnostic.                                          |
| Embeddings (enhanced) | nomic-embed-text via Ollama                   | 274MB, higher quality. Optional upgrade — user points Pear at a local Ollama instance via one env var.              |
| Embeddings (cloud)    | OpenAI text-embedding-3-small                 | Best quality. Optional — for users who don't care about full local and just want maximum accuracy.                  |


---

## 4. Data Model

### 4.1 Tables

#### `Page`

The universal atom. Every piece of content is a Page.

```rust
#[spacetimedb::table]
pub struct Page {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub parent_id: Option<u64>,      // nullable — root pages have no parent
    pub page_type: PageType,          // Doc | Database | Canvas (future)
    pub title: String,
    pub embedding: Option<Vec<f32>>,  // 1536-dim vector, populated async after content changes
    pub created_by: ActorType,        // Human | Agent(agent_id) — audit trail
    pub created_at: u64,
    pub updated_at: u64,
    pub deleted_at: Option<u64>,      // None = active, Some = soft deleted. Hard purge after 30 days.
}
// Note: content lives in PageContent table (1:1), fetched separately when a page is opened.
```

#### `DatabaseSchema`

Defines the column structure for a page of type `Database`.

```rust
#[spacetimedb::table]
pub struct DatabaseSchema {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub page_id: u64,   // the Database page this schema belongs to
    pub name: String,
}
```

#### `PropertyDefinition`

Each column in a database schema.

```rust
#[spacetimedb::table]
pub struct PropertyDefinition {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub schema_id: u64,
    pub name: String,
    pub property_type: PropertyType,  // tagged enum
    pub config: String,               // JSON for type-specific config
    pub order: u32,
}
```

#### `PagePropertyValue`

The actual data stored for each property on each page (row).

```rust
#[spacetimedb::table]
pub struct PagePropertyValue {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub page_id: u64,
    pub property_definition_id: u64,
    pub value: PropertyValue,   // tagged union — see below
}
```

#### `PageContent`

Content is stored in its own table, separate from `Page`, so that queries over pages (listing, filtering, searching titles and properties) never load content blobs into memory. Content is only fetched when a page is actually opened.

```rust
#[spacetimedb::table]
pub struct PageContent {
    #[primary_key]
    pub page_id: u64,       // 1:1 with Page
    pub content: String,    // BlockNote JSON block tree
    pub updated_at: u64,
}
```

#### `PageSnapshot`

A point-in-time capture of a page's content and title. Taken automatically before/after agent edits, periodically during active editing, and on manual save. This is the backbone of version history and recovery.

```rust
#[spacetimedb::table]
pub struct PageSnapshot {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub page_id: u64,
    pub title: String,
    pub content: String,          // full BlockNote JSON at this point in time (copied from PageContent)
    pub snapshot_at: u64,
    pub created_by: ActorType,    // who/what triggered this snapshot
    pub snapshot_type: SnapshotType,
}
```

#### `PagePropertyValueHistory`

Append-only history of property value changes. Instead of updating in place, each change appends a new row with `is_current` flipped. Gives a full audit trail of every property mutation with zero extra work.

```rust
#[spacetimedb::table]
pub struct PagePropertyValueHistory {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub page_id: u64,
    pub property_definition_id: u64,
    pub value: PropertyValue,
    pub is_current: bool,
    pub changed_at: u64,
    pub changed_by: ActorType,
}
```

#### `DatabaseView`

A saved view config on a database page. Stores display type, filters, sorts, column visibility and widths. Persisted in SpacetimeDB so views sync across devices. Supports both shared views (visible to all users of a workspace) and personal views (visible only to the creator).

```rust
#[spacetimedb::table]
pub struct DatabaseView {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub page_id: u64,                    // the Database page this view belongs to
    pub name: String,
    pub view_type: ViewType,
    pub config: String,                  // JSON — filters, sorts, column visibility, widths
    pub is_default: bool,                // which view opens when the database is opened
    pub owner_identity: Option<String>,  // None = shared view, Some(identity) = personal view
    pub created_by: ActorType,
    pub created_at: u64,
    pub updated_at: u64,
}
```

#### `ActorType`

Tracks whether an action was taken by a human or an Orcha agent. Enables audit trails and lets the UI surface AI-generated content differently.

```rust
#[derive(SpacetimeType)]
pub enum ActorType {
    Human,
    Agent(String),   // agent_id from Orcha
}
```

#### `ViewType`

```rust
#[derive(SpacetimeType)]
pub enum ViewType {
    Grid,
    List,
    Kanban,    // v2
    Calendar,  // v2
    Gallery,   // v2
}
```

#### `SnapshotType`

Why a snapshot was taken. Used to display history in the UI with useful context ("Before AI edit", "Auto-saved", etc.) and to power one-click AI revert.

```rust
#[derive(SpacetimeType)]
pub enum SnapshotType {
    Manual,          // user explicitly saved a named version
    Periodic,        // background job, every N minutes during active editing
    PreAgentEdit,    // automatically taken before any Orcha agent mutates a page
    PostAgentEdit,   // automatically taken after agent completes
}
```

#### `PageType`

```rust
#[derive(SpacetimeType)]
pub enum PageType {
    Doc,
    Database,
}
```

#### `PropertyType`

```rust
#[derive(SpacetimeType)]
pub enum PropertyType {
    Text,
    Number,
    Date,
    Select,
    MultiSelect,
    Relation,
    Checkbox,
    Url,
}
```

#### `PropertyValue` (tagged union)

The key design decision. Instead of a wide nullable table or stringly-typed JSON, values are a typed enum. SpacetimeDB handles this natively.

```rust
#[derive(SpacetimeType)]
pub enum PropertyValue {
    Text(String),
    Number(f64),
    Date(u64),              // unix timestamp
    Select(String),
    MultiSelect(Vec<String>),
    Relation(Vec<u64>),     // vec of Page IDs
    Checkbox(bool),
    Url(String),
}
```

---

### 4.3 How it fits together

```
Page (type=Database)
  └── DatabaseSchema
        └── PropertyDefinition (Text: "Name")
        └── PropertyDefinition (Relation: "Assignee" → People DB)
        └── PropertyDefinition (Select: "Status")

Page (type=Doc, parent_id = Database page)   ← this is a "row"
  └── PagePropertyValue (property_definition_id=1, value=Text("Task A"))
  └── PagePropertyValue (property_definition_id=2, value=Relation([page_id_42]))
  └── PagePropertyValue (property_definition_id=3, value=Select("In Progress"))
  └── content: "{ ...BlockNote JSON... }"    ← open this row and it's a full doc
```

A relation column is just a `PropertyValue::Relation(Vec<u64>)` — a list of page IDs pointing into another database. Simple foreign keys, nothing magic.

---

## 5. Core Reducers

SpacetimeDB mutations happen through reducers. These are the core ones to implement first:

```rust
// Pages
create_page(parent_id: Option<u64>, page_type: PageType, title: String)  // also creates PageContent row
update_page_title(page_id: u64, title: String)
update_page_content(page_id: u64, content: String)  // updates PageContent, not Page
delete_page(page_id: u64)        // soft delete — sets deleted_at, never hard deletes
restore_page(page_id: u64)       // clears deleted_at

// Schema
create_database_schema(page_id: u64, name: String)
add_property(schema_id: u64, name: String, property_type: PropertyType, config: String)
reorder_property(property_definition_id: u64, new_order: u32)
delete_property(property_definition_id: u64)

// Values
set_property_value(page_id: u64, property_definition_id: u64, value: PropertyValue)
clear_property_value(page_id: u64, property_definition_id: u64)

// Version control
take_snapshot(page_id: u64, snapshot_type: SnapshotType)
restore_page_to_snapshot(page_id: u64, snapshot_id: u64)  // rolls content + title back

// Views
create_view(page_id: u64, name: String, view_type: ViewType, owner_identity: Option<String>)
update_view_config(view_id: u64, config: String)
rename_view(view_id: u64, name: String)
set_default_view(view_id: u64)
delete_view(view_id: u64)
```

---

## 6. Views

A view is a named, saved config on top of a database page — display type, filters, sorts, column visibility, column widths. Views are persisted in the `DatabaseView` table so they sync across all devices. No localStorage.

**Shared views** (`owner_identity = None`) are visible to everyone with access to the workspace. **Personal views** (`owner_identity = Some(identity)`) are visible only to their creator — useful for personal filter configs that shouldn't pollute everyone else's workspace.

A database always has at least one view. The default view (`is_default = true`) is what opens when you navigate to a database page. Users can create as many views as they want and switch between them freely.

The `config` field is a JSON string containing filters, sorts, column order and visibility, and column widths. It's deserialized on the client — never queried into server-side — so keeping it as JSON is fine indefinitely.

### v1 Views

- **Grid / Table** — rows and columns, sortable, filterable
- **List** — simplified single-column row view

### v2 Views (post-MVP)

- **Kanban** — group rows by a Select property
- **Calendar** — group rows by a Date property
- **Gallery** — card grid, show a cover image property

---

## 7. MVP Scope

The goal of the MVP is to validate the data model and get the core loop working: create a database, define columns, add rows, open a row as a full page.

### In scope

- SpacetimeDB module with all tables and core reducers
- `Page` + `PageContent` tables wired up — create_page creates both atomically
- Create / nest pages
- Create a database page with a schema
- Add/remove/reorder property columns
- Grid view — display child pages as rows with property values
- Inline editing of property values in the grid
- Open any row as a full page with BlockNote editor
- Relation property type — link rows across two databases
- Basic filtering in grid view
- Soft deletes + trash with restore
- `PageSnapshot` table + `PreAgentEdit` / `Periodic` snapshot types
- Basic page history panel — list snapshots, one-click restore
- `embedding` and `created_by` fields on Page (populated later, schema correct from day one)
- Self-hostable via Docker

### Out of scope (v1)

- Kanban / Calendar / Gallery views
- Formula columns
- Rollups
- Real-time multiplayer cursors
- Permissions / sharing
- Mobile
- Orcha agent features (schema generation, NL querying) — data model supports it, UI comes later
- Import from Notion

---

## 8. Version Control & Recovery

### 8.1 The Two Problems

Version control and recovery feel like one problem but are actually two:

1. **Short-term recovery** — "I just deleted that page by accident" or "the AI rewrote my content and it's wrong." Needs to be fast, frictionless, and UI-facing. One click, no ceremony.
2. **Long-term version history** — "What did this page look like 3 weeks ago?" or "Show me everything an AI agent changed yesterday." More of an audit/snapshot story.

Both are solved by the same underlying system: `PageSnapshot` + append-only `PagePropertyValueHistory` + soft deletes on `Page`.

### 8.2 How Snapshots Work

Snapshots are taken automatically at key moments — no user action required:

- **PreAgentEdit** — fired automatically inside any reducer that an Orcha agent calls before mutating a page. Recovery from a bad AI edit is always "restore to the snapshot taken right before this agent ran."
- **PostAgentEdit** — fired after an agent completes, so you can see exactly what it changed by diffing pre/post.
- **Periodic** — background job takes a snapshot every few minutes while a page is being actively edited. Covers accidental human edits.
- **Manual** — user explicitly saves a named version ("v1 draft", "before restructure"). Shown prominently in the history panel.

### 8.3 Property Value History

Property values use an append-only pattern rather than in-place updates. Every `set_property_value` call inserts a new `PagePropertyValueHistory` row and flips `is_current` on the previous one. This gives a complete audit trail of every property change — who changed it, when, and from what — with no extra work at query time.

### 8.4 Soft Deletes — Decision Made

**Soft deletes are mandatory.** Hard deleting a page would orphan all its snapshots and break the recovery story. The `deleted_at` field on `Page` resolves this open question:

- `deleted_at = None` → active
- `deleted_at = Some(timestamp)` → soft deleted, shown in trash, recoverable
- Hard purge after 30 days via a background reducer — same as most tools

All queries filter `WHERE deleted_at IS NULL` by default. The trash view inverts this.

### 8.5 What This Looks Like in the UI

- **Page history panel** — timeline of snapshots with actor (Human / Agent name), timestamp, and snapshot type. Click any snapshot to preview. One-click restore.
- **Trash** — soft-deleted pages with restore and permanent delete options. 30-day countdown shown.
- **AI edit badge** — when an agent modifies a page, the UI shows a subtle "edited by AI" indicator with a one-click revert back to the PreAgentEdit snapshot.
- **Property history** — in a row's detail view, each property can show its full change history inline.

### 8.6 Competitive Advantage

Notion's page history is paywalled — 30 days on free, unlimited only on paid plans. AFFiNE and AppFlowy have essentially nothing. Pear ships full version history, agent-aware snapshots, and one-click revert **free and self-hosted**. This is a meaningful differentiator especially for users who want to trust an AI workspace but need a safety net.

---

## 9. AI Integration

### 9.1 The Philosophy

Most tools treat AI as a chat sidebar that can read your documents. That's shallow. Pear's advantage is that the entire workspace is a typed, relational, structured graph — pages, properties, schemas, relations. An AI agent in Pear doesn't just read text, it understands *structure*. It knows what a DatabaseSchema is. It knows how PropertyValues relate to Pages. It can operate on the data model directly.

The goal: AI that understands your structure, not just your content.

### 9.2 Orcha Integration

[Orcha](https://codeberg.org/Orcha/orcha) is an open protocol for coordinating multiple AI agents in real-time, built on SpacetimeDB. Since Pear is also built on SpacetimeDB, agents and humans share the exact same data layer. An Orcha agent writing a reducer call is indistinguishable at the data layer from a human clicking a button — which means agents are first-class participants in the workspace, not external API calls.

**How it works:**

```
User: "set up a project tracker for a film production"
  ↓
Orcha Orchestrator decomposes → Task Graph
  ↓
Tasks written to SpacetimeDB coordination layer
  ↓
Agents subscribe, claim tasks matching their capabilities
  ↓
Agents execute: create_database_schema(), add_property(), create_page()...
  ↓
Pear UI reacts to SpacetimeDB subscription updates in real time
  ↓
Pages and columns appear live — no page refresh, no loading state
```

Because Orcha is an open protocol, any agent built for Orcha can operate inside Pear. This is the opposite of Notion AI — closed, proprietary, one vendor. Pear's AI layer is open by design.

### 9.3 Concrete AI Features

**Schema generation** — describe what you want to track in plain language, an agent generates the DatabaseSchema and PropertyDefinitions. Killer for onboarding, zero setup friction.

**Natural language querying** — "show me all tasks assigned to me that are in progress and due this week" translates to a filter config on a grid view. No query language required.

**Semantic search** — each Page has an `embedding` field (1536-dim vector). Content changes queue an async embedding job. Search finds pages by meaning, not just keywords.

**Relation suggestions** — as data is filled in, an agent notices structural patterns and suggests "hey, these two databases probably want a relation column."

**Workspace summarization** — because the data is structured, summarization is precise. "Summarize my open tasks" pulls from PropertyValues, not just raw text.

### 9.4 Schema Additions for AI

Only two additions needed to the core schema, both already included in section 4:

- `Page.embedding: Option<Vec<f32>>` — populated async by a background agent after `PageContent` changes
- `Page.created_by: ActorType` — `Human` or `Agent(agent_id)`, audit trail for all mutations

Everything else (schemas, reducers, property values) is already the right shape for agents to operate on.

### 9.5 Tiered Embedding Strategy

Embedding quality matters for semantic search, but requiring users to run a large model defeats the self-hosted promise. Pear uses a tiered approach — fully functional out of the box, upgradeable for power users:

**Tier 1 — Default, zero config (ships baked in)**
`all-MiniLM-L6-v2` loaded via ONNX Runtime directly in the Rust server process. Only 80MB. Runs fast on CPU. No Ollama, no API keys, no extra installs. Semantic search just works the moment you spin up Pear.

**Tier 2 — Better quality, still fully local**
Point Pear at a local [Ollama](https://ollama.com) instance running `nomic-embed-text` (274MB). Set one env var: `PEAR_EMBEDDING_BACKEND=ollama`. Consistently benchmarks close to OpenAI quality. Good choice for users who already run Ollama for other things.

**Tier 3 — Cloud, maximum quality**
Set `PEAR_EMBEDDING_BACKEND=openai` and provide an OpenAI API key. `text-embedding-3-small` (1536 dims). For users who don't care about the full local story and want the best results.

The default experience is completely self-contained — no external dependencies whatsoever. This is a story no competitor can currently tell.

### 9.6 What Competitors Can't Easily Copy

The tools bolting AI on after the fact are always at a disadvantage — their data models weren't designed with agents in mind. AFFiNE, AppFlowy, and Notion all have AI features that are essentially text generation on top of unstructured content. Pear's AI operates on a relational graph with typed properties and explicit relations. That's a fundamentally richer surface area, and it's baked in from day one.

---

## 10. Authentication

### 10.1 The Design Principle

Pear doesn't own auth. SpacetimeDB is OIDC-native — every connection arrives with an OIDC token regardless of how the user authenticated. Pear just validates tokens via SpacetimeDB and never has to think about sessions, passwords, or OAuth flows directly. All of that is delegated to whichever OIDC provider is configured.

### 10.2 How It Works

```
Default (SpacetimeAuth):
  Human user   → email/password → SpacetimeAuth → OIDC token → SpacetimeDB
  Orcha agent  → client credentials → SpacetimeAuth → OIDC token → SpacetimeDB

Custom OIDC (Authentik, Keycloak, etc.):
  Human user   → however your provider handles login → OIDC token → SpacetimeDB
  Orcha agent  → client credentials → your provider → OIDC token → SpacetimeDB
```

In both cases the flow is identical from SpacetimeDB's perspective — it just validates the token. Pear doesn't need to know or care which provider issued it.

### 10.3 Tiered Auth — Same Philosophy as Embeddings

**Tier 1 — Default, zero config**
SpacetimeAuth handles everything. Email/password works out of the box, no setup required. SpacetimeAuth also supports social logins (Google, GitHub, etc.) if the user wants to configure them in the SpacetimeAuth dashboard. This is the right default for most self-hosters — simple, fast, just works.

**Tier 2 — Bring your own OIDC provider**
Set one env var:

```
PEAR_OIDC_ISSUER=https://authentik.yourdomain.com/application/o/pear/
```

Any standards-compliant OIDC provider works — Authentik, Keycloak, Auth0, Okta, whatever you already run. Pear stays completely auth-agnostic. This is the killer feature for homelab users and small teams who already have an identity provider running — Pear just joins the SSO setup they have.

### 10.4 Orcha Agent Identity — Resolved

Orcha agents authenticate using the **OIDC client credentials flow** — no user interaction, just a client ID and secret exchanged for a token. This works identically in both tiers:

- **SpacetimeAuth default** — create a machine client in the SpacetimeAuth dashboard, copy the client ID and secret into Pear's Orcha config.
- **Custom OIDC** — create an OAuth2 application in your provider (in Authentik this is ~5 clicks), copy credentials into config.

From SpacetimeDB's perspective an agent connection is indistinguishable from a human connection — same token validation, same identity system, same reducer access. The `created_by: ActorType` field on mutations is what distinguishes human vs agent actions at the application layer, not the auth layer.

### 10.5 Social Logins

Social logins (Google, GitHub, etc.) are configured at the OIDC provider level, not in Pear. With SpacetimeAuth you enable them in the SpacetimeAuth dashboard. With a custom provider like Authentik you configure the OAuth2 source there. Either way Pear sees an OIDC token and doesn't care how it was obtained.

---

## 11. Workspace Architecture

### 11.1 The Mental Model

The closest analogy is email clients. Thunderbird doesn't care who runs your mail server — you add an account pointing at any IMAP server and it works. The client owns the relationship, not a central registry. Pear works exactly the same way.

A **workspace** is just a running Pear server — a SpacetimeDB module deployed at some URL. Your **Pear client** maintains a list of workspaces you've connected to. Nobody else knows that list exists. No central authority can enumerate your workspaces, revoke your access, or go down and take your data with it.

This is philosophically similar to Mastodon's federation model, but cleaner: servers don't need to talk to each other at all. The client is the hub. Servers are just endpoints.

### 11.2 How Workspaces Map to SpacetimeDB

Each workspace is its own SpacetimeDB module deployment. The module boundary **is** the workspace boundary — you get data isolation, auth isolation, and permission isolation for free. No `workspace_id` column needed on every table. No cross-tenant leakage possible. One module = one workspace = one team or personal instance.

This also means scaling a workspace is just scaling a SpacetimeDB instance. Different workspaces are completely independent and don't affect each other.

### 11.3 Joining a Workspace

Workspaces are joined via invite links:

```
pear://company.internal:3000?invite=abc123
```

The invite flow:

1. A workspace admin generates a one-time invite link from the workspace settings
2. User clicks the link — Pear client opens an "Add Workspace" dialog pre-filled with the server URL
3. User authenticates against that workspace's configured OIDC provider
4. On success, the connection is saved locally and the workspace appears in the client sidebar

The invite token is one-time-use and expires. It grants initial access but the actual ongoing auth is the OIDC token — the invite is just the handshake.

### 11.4 Client-Side Workspace Storage

Connected workspaces are stored locally in the Pear client. Never on any server. Never synced anywhere. The client is in full control.

```typescript
type WorkspaceConnection = {
  id: string                // local UUID
  name: string              // display name, user can rename locally
  url: string               // wss://company.internal:3000
  token: string             // OIDC token for this workspace
  lastConnected: Date
  isDefault: boolean        // which workspace opens on launch
}
```

### 11.5 Multi-Workspace Client UX

The sidebar shows all connected workspaces. Switching between them is instant — the client already has active SpacetimeDB subscriptions open for each. Each workspace has its own pages, databases, views, and users. There is no cross-workspace data — a relation column in Workspace A cannot point to a page in Workspace B.

### 11.6 What This Enables

- **Personal instance** — spin up Pear at home, connect your client, use it as a private knowledge base
- **Team workspace** — company runs a Pear server, shares invite links with employees, everyone connects their client
- **Multiple workspaces** — user connects to their personal instance AND their work instance simultaneously, switches between them in the sidebar
- **Community workspaces** — open source projects, clubs, communities can run a Pear server and share public invite links
- **No platform risk** — Pear (the project) going away doesn't affect anyone's workspaces. Servers keep running. Clients keep connecting.

### 11.7 What We Deliberately Don't Build

- No workspace discovery or directory — workspaces are private by default, found only via invite
- No cross-workspace search or relations — each workspace is fully isolated
- No central account — there is no "Pear account", only workspace-specific identities
- No telemetry — Pear has no visibility into what workspaces exist or how many users they have

---

## 13. Build Order

1. **SpacetimeDB module** — define tables, types, reducers in Rust. Get it running locally.
2. **Auth** — wire up SpacetimeAuth as the default OIDC provider. Email/password login working. `client_connected` reducer validates token and rejects unauthenticated connections.
3. **Client connection** — Next.js app connects to SpacetimeDB with auth token, subscribes to Page table, can create and list pages.
4. **Grid view** — render child pages of a Database as a table. Hardcode a couple property types first (Text, Select).
5. **BlockNote integration** — open a page/row, render its content in BlockNote, save on change.
6. **Property system** — implement all PropertyValue types, wire up inline editing in the grid.
7. **Relations** — implement Relation property type. Picker UI to select pages from another database.
8. **Filtering** — basic filter bar on grid view.
9. **Version control** — soft deletes + trash, `PageSnapshot` table, periodic snapshots, page history panel, one-click restore.
10. **Docker** — containerize SpacetimeDB module + Next.js app for self-hosting. Wire up `PEAR_OIDC_ISSUER` env var for custom OIDC providers.
11. **Multi-workspace client** — local workspace connection storage, workspace switcher in sidebar, invite link generation and join flow.
12. **Embeddings** — background job that generates and stores embeddings on PageContent changes. Wire up semantic search.
13. **Orcha integration** — connect Orcha orchestration layer. Wire up `PreAgentEdit` / `PostAgentEdit` snapshots. Configure agent client credentials. Implement schema generation agent as the first Orcha-powered feature.

---

## 14. Open Questions

- **Auth** — ✅ Resolved: SpacetimeAuth as default (email/password, zero config). Custom OIDC providers supported via `PEAR_OIDC_ISSUER` env var — Authentik, Keycloak, or anything OIDC-compliant drops straight in. Social logins configured at the provider level, not in Pear. See section 10.
- **Content storage** — ✅ Resolved: content lives in a separate `PageContent` table (1:1 with Page) from day one. Page table stays lean for list/filter queries. Content only fetched when a page is opened. If scale ever demands it, `PageContent` can be migrated to external blob storage without touching the rest of the schema.
- **View persistence** — ✅ Resolved: `DatabaseView` table in SpacetimeDB. Syncs across devices. Supports shared views (`owner_identity = None`) and personal views (`owner_identity = Some(identity)`). Config stored as JSON string, deserialized client-side.
- **Snapshot retention** — ✅ Resolved: all Manual snapshots kept forever, all PreAgentEdit/PostAgentEdit kept forever, Periodic snapshots pruned to one per hour after 7 days and one per day after 30 days.
- **Embedding backend** — ✅ Resolved: tiered approach. all-MiniLM-L6-v2 baked in via ONNX Runtime as default (zero config), Ollama/nomic-embed-text as optional upgrade, OpenAI as optional cloud tier. See section 9.5.
- **Orcha agent identity** — ✅ Resolved: agents use OIDC client credentials flow via whichever provider is configured. SpacetimeAuth default requires creating a machine client in the dashboard. Custom OIDC providers (Authentik etc.) require creating an OAuth2 application. Same token validation path as human users. See section 10.4.

---

*Last updated: March 2026*