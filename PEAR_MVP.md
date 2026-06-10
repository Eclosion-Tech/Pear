# Pear — Project Bible
## A Self-Hosted, Relational-First Notion Alternative

**Domain:** pear.pro

> **Historical document.** This is the original design document for Pear's MVP. The philosophy and data model still hold, but many implementation details have evolved — most notably, the document model is now a typed `ComponentNode` tree (not BlockNote), and several features described here as planned have shipped. For current shipped/planned status, see [`ROADMAP.md`](./ROADMAP.md); for current setup and features, see [`README.md`](./README.md).

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

| Layer | Choice | Rationale |
|---|---|---|
| Backend / Sync | SpacetimeDB | Handles real-time sync, subscriptions, and state via reducers. Eliminates the hardest engineering problem. |
| AI Orchestration | Orcha | Open protocol for coordinating multiple AI agents via SpacetimeDB. Agents read/write the same data layer as humans. |
| Editor | BlockNote | Built on Tiptap. Embeddable, has slash commands out of the box, looks good, not tightly coupled to any framework. |
| Frontend | React + Next.js | Standard, well-supported, good ecosystem. |
| Language (DB module) | Rust | SpacetimeDB modules are written in Rust. |
| Styling | Tailwind CSS | Utility-first, fast to iterate. |
| Auth (default) | SpacetimeAuth | Managed OIDC provider by SpacetimeDB. Handles email/password out of the box. Zero config required. |
| Auth (self-hosted) | Any OIDC provider (Authentik, Keycloak, etc.) | Point Pear at your own provider via one env var. Pear stays auth-agnostic. |
| Embeddings (enhanced) | nomic-embed-text via Ollama | 274MB, higher quality. Optional upgrade — user points Pear at a local Ollama instance via one env var. |
| Embeddings (cloud) | OpenAI text-embedding-3-small | Best quality. Optional — for users who don't care about full local and just want maximum accuracy. |

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



#### `AutomationRule`
A user-defined automation — a trigger condition paired with one or more actions. When the trigger fires, the Orcha automation worker picks it up from the queue and executes the action chain.

```rust
#[spacetimedb::table]
pub struct AutomationRule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub enabled: bool,
    pub trigger: AutomationTrigger,
    pub created_by: Identity,
    pub created_at: u64,
}
```

#### `AutomationAction`
Actions are chained — a single rule can have multiple actions executed in order.

```rust
#[spacetimedb::table]
pub struct AutomationAction {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub automation_id: u64,
    pub order: u32,                   // execution order within the rule
    pub action_type: ActionType,      // HttpRequest | SendEmail | CreatePage | UpdateProperty | OrchaAgent
    pub config: String,               // JSON, type-specific config per ActionType
}
```

#### `AutomationEventQueue`
Mutations enqueue events here. Fast, non-blocking — the reducer just writes a row and moves on. The Orcha automation worker subscribes to this table and processes events asynchronously.

```rust
#[spacetimedb::table]
pub struct AutomationEventQueue {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub automation_id: u64,
    pub trigger_payload: String,      // JSON snapshot of what triggered it
    pub status: AutomationStatus,     // Pending | Running | Completed | Failed
    pub created_at: u64,
}
```

#### `AutomationRunLog`
Per-action execution log. The automation worker writes results back here after each action executes. Visible to users in the UI — they can see what ran, when, and whether it succeeded.

```rust
#[spacetimedb::table]
pub struct AutomationRunLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub queue_id: u64,
    pub action_id: u64,
    pub success: bool,
    pub result: Option<String>,       // response body, error message, created page ID, etc.
    pub attempts: u32,
    pub executed_at: u64,
}
```

#### `AutomationTrigger`
```rust
#[derive(SpacetimeType)]
pub enum AutomationTrigger {
    PageCreated { database_id: Option<u64> },              // optionally scoped to a specific database
    PageUpdated { page_id: Option<u64> },                  // optionally scoped to a specific page
    PageDeleted { database_id: Option<u64> },
    PropertyChanged {
        property_definition_id: u64,
        to_value: Option<PropertyValue>,                   // None = any change, Some = specific value
    },
    UserJoined,
}
```

#### `ActionType`
```rust
#[derive(SpacetimeType)]
pub enum ActionType {
    HttpRequest,       // fire an HTTP POST to an external URL (webhooks, Zapier, n8n, etc.)
    SendEmail,         // notify a user or external address
    CreatePage,        // create a new page/row in a database
    UpdateProperty,    // set a property value on a page
    OrchaJob,          // submit a Job + Task graph to Orcha, let AI agents handle execution
}
```

#### `AutomationStatus`
```rust
#[derive(SpacetimeType)]
pub enum AutomationStatus {
    Pending,
    Running,
    Completed,
    Failed,
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

// Automations
create_automation(name: String, trigger: AutomationTrigger)
add_automation_action(automation_id: u64, order: u32, action_type: ActionType, config: String)
update_automation_action(action_id: u64, config: String)
reorder_automation_action(action_id: u64, new_order: u32)
delete_automation_action(action_id: u64)
enable_automation(automation_id: u64)
disable_automation(automation_id: u64)
delete_automation(automation_id: u64)
// Note: enqueue_automation_event is called internally by other reducers — not exposed to clients directly
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
- [ ] SpacetimeDB module with all tables and core reducers
- [ ] `Page` + `PageContent` tables wired up — create_page creates both atomically
- [ ] Create / nest pages
- [ ] Create a database page with a schema
- [ ] Add/remove/reorder property columns
- [ ] Grid view — display child pages as rows with property values
- [ ] Inline editing of property values in the grid
- [ ] Open any row as a full page with BlockNote editor
- [ ] Relation property type — link rows across two databases
- [ ] Basic filtering in grid view
- [ ] Soft deletes + trash with restore
- [ ] `PageSnapshot` table + `PreAgentEdit` / `Periodic` snapshot types
- [ ] Basic page history panel — list snapshots, one-click restore
- [ ] `embedding` and `created_by` fields on Page (populated later, schema correct from day one)
- [ ] Self-hostable via Docker

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

## 10. Automations

### 10.1 The Philosophy

Automations are the general-purpose event-action layer built into Pear's core. They are not a cloud-only feature, not a webhook-specific system — they are a first-class primitive available to every self-hoster and cloud user alike. The mental model is simple: when X happens in your workspace, do Y.

Webhooks are one action type. Invoking an AI agent is another. Creating a page, updating a property, sending an email — all the same model. This makes Pear competitive with Notion's automations while being fully self-hosted and extensible.

### 10.2 Architecture

The system has three parts:

**1. Trigger detection (inside reducers)**
Mutations check whether any enabled `AutomationRule` has a trigger matching the event. If yes, they insert a row into `AutomationEventQueue` — a single non-blocking table write. The reducer commits and returns immediately. No HTTP calls, no latency, no coupling.

**2. Queue table**
`AutomationEventQueue` is the decoupling layer. It holds pending automation events waiting to be processed. Fast to write, fast to read. The Orcha automation worker subscribes to this table via SpacetimeDB's real-time subscription mechanism — it does not poll.

**3. Orcha automation worker**
A proper Orcha worker with the `automation` capability that ships in the default docker compose. Per the Orcha protocol, it:
- Registers with the coordination layer (SpacetimeDB) with `capabilities: ["automation"]`
- Authenticates via OIDC client credentials — same identity path as all Orcha agents
- Subscribes to `AutomationEventQueue` — reacts instantly on insert, no polling
- Claims events atomically (prevents duplicate processing if multiple worker instances run)
- Holds an in-memory cache of `AutomationRule` and `AutomationAction` configs, invalidated on table change
- Executes action chains in order, publishing each result back to `AutomationRunLog`
- On failure: retries with exponential backoff per Orcha fault tolerance model
- Marks tasks done, updating queue row status

```
Reducer commits mutation
  → inserts row to AutomationEventQueue (non-blocking)

Orcha automation worker (capability: "automation")
  → sees insert immediately via SpacetimeDB subscription
  → claims event atomically
  → looks up AutomationRule + AutomationAction chain (in-memory cache)
  → executes actions in order:
      HttpRequest    → fire HTTP POST with HMAC signature, log response
      SendEmail      → send via configured SMTP
      CreatePage     → call create_page reducer on Pear's SpacetimeDB module
      UpdateProperty → call set_property_value reducer
      OrchaJob       → write a Job + Task graph to Orcha coordination layer,
                       letting AI agents claim and execute the work
  → writes per-action result to AutomationRunLog
  → marks queue event Completed or Failed
```

### 10.3 Action Types

**HttpRequest** — fire an HTTP POST to any external URL. Config includes URL, headers, and HMAC secret for signature verification. This is the webhook use case — works with Zapier, n8n, Make, or any custom endpoint.

**SendEmail** — send a notification email. Config includes recipient, subject template, and body template. Variables substituted from trigger payload (e.g. `{{page.title}}`). Requires SMTP configured via env var.

**CreatePage** — create a new page or row in a specified database. Config includes target database ID and initial property values. Useful for "when a form is submitted, create a task."

**UpdateProperty** — set a property value on a page. Config includes target property definition ID and new value. Useful for "when a page is created in this database, set Status to 'New'."

**OrchaJob** — submit a `Job` to the Orcha coordination layer with a generated `Task` graph. The automation worker writes to Orcha's SpacetimeDB tables (`jobs`, `tasks`) and AI agents with matching capabilities claim and execute the work independently. This is the bridge between deterministic automations and AI — e.g. "when a page is created, have an agent summarize it and fill in the Summary property." Importantly, the automation worker does not execute the AI work itself — it delegates to Orcha's agent pool, which handles decomposition, parallel execution, and result synthesis per the Orcha protocol.

### 10.4 Relationship to Orcha's Task Model

The Orcha automation worker is a first-class Orcha agent. It uses the standard Orcha agent lifecycle:

```
1. Register with coordination layer — capabilities: ["automation"]
2. Subscribe to AutomationEventQueue (Pear's tables) + Orcha task tables
3. Claim automation events atomically
4. Execute action chain
5. For OrchaJob actions: write Job + Tasks to Orcha coordination layer,
   let AI agents handle execution independently
6. Publish results, mark done
7. Repeat or idle
```

This means the automation worker can be scaled horizontally — run multiple instances and events are claimed atomically with no duplicate processing, exactly as Orcha's protocol defines for any worker.

### 10.5 Zero Overhead When Unused

If `AutomationRule` table is empty:
- Reducers do one indexed lookup, find nothing, move on — negligible cost
- Automation worker sits idle with open subscriptions and does nothing
- No timers, no polling, no background work

The worker only does real work when automations are configured and triggered.

### 10.6 Docker Compose

The automation worker ships as a separate container in the default compose:

```yaml
services:
  spacetimedb: ...
  pear-auth: ...
  pear: ...
  pear-automation-worker:
    image: ghcr.io/pearpro/pear-automation-worker
    environment:
      - SPACETIMEDB_URL=ws://spacetimedb:3000
      - OIDC_CLIENT_ID=${AUTOMATION_WORKER_CLIENT_ID}
      - OIDC_CLIENT_SECRET=${AUTOMATION_WORKER_CLIENT_SECRET}
      - SMTP_URL=${SMTP_URL}          # optional, only needed for SendEmail actions
```

### 10.7 Competitive Advantage

Notion automations are cloud-only, limited to Notion-defined action types, and paywalled. AFFiNE and AppFlowy have nothing equivalent. Pear ships a general-purpose, self-hosted automation engine — with AI agent invocation via Orcha as a native action type — free and open source, running entirely on your own infrastructure.

---

## 11. Authentication

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

## 12. Workspace Architecture

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
13. **Automations** — `AutomationRule`, `AutomationAction`, `AutomationEventQueue`, `AutomationRunLog` tables. Enqueue calls in relevant reducers. Build the Orcha automation worker. UI for creating and managing rules.
14. **Orcha integration** — connect Orcha orchestration layer. Wire up `PreAgentEdit` / `PostAgentEdit` snapshots. Configure agent client credentials. Implement schema generation agent as the first Orcha-powered feature. Wire `OrchaAgent` action type into automation worker.
15. **offline access** - allow for cached changes that get stored locally until network reconnect
---

## 14. Open Questions

- **Auth** — ✅ Resolved: SpacetimeAuth as default (email/password, zero config). Custom OIDC providers supported via `PEAR_OIDC_ISSUER` env var — Authentik, Keycloak, or anything OIDC-compliant drops straight in. Social logins configured at the provider level, not in Pear. See section 10.
- **Content storage** — ✅ Resolved: content lives in a separate `PageContent` table (1:1 with Page) from day one. Page table stays lean for list/filter queries. Content only fetched when a page is opened. If scale ever demands it, `PageContent` can be migrated to external blob storage without touching the rest of the schema.
- **View persistence** — ✅ Resolved: `DatabaseView` table in SpacetimeDB. Syncs across devices. Supports shared views (`owner_identity = None`) and personal views (`owner_identity = Some(identity)`). Config stored as JSON string, deserialized client-side.
- **Snapshot retention** — ✅ Resolved: all Manual snapshots kept forever, all PreAgentEdit/PostAgentEdit kept forever, Periodic snapshots pruned to one per hour after 7 days and one per day after 30 days.
- **Embedding backend** — ✅ Resolved: tiered approach. all-MiniLM-L6-v2 baked in via ONNX Runtime as default (zero config), Ollama/nomic-embed-text as optional upgrade, OpenAI as optional cloud tier. See section 9.5.
- **Orcha agent identity** — ✅ Resolved: agents use OIDC client credentials flow via whichever provider is configured. SpacetimeAuth default requires creating a machine client in the dashboard. Custom OIDC providers (Authentik etc.) require creating an OAuth2 application. Same token validation path as human users. See section 10.4.

---

## 15. Schema Migrations & Upgrade Path

### 15.1 The Problem

SpacetimeDB does not currently support automatic schema migrations. Publishing a module with breaking schema changes (removed columns, renamed columns, changed types, new non-nullable columns) requires `--clear-database`, which wipes all data. For self-hosted production instances this is a non-starter — users cannot lose their workspace every time they upgrade Pear.

### 15.2 What "Breaking" vs "Safe" Means

**Safe (publish without `--clear-database`):**
- Adding a new reducer
- Changing reducer logic
- Adding a new table
- Adding a new column with a default value that SpacetimeDB can backfill (TBD — depends on SpacetimeDB version)

**Breaking (requires a migration strategy):**
- Adding a non-nullable column without a default to an existing table (e.g. `sort_order: u32` on `Page`)
- Removing or renaming a column
- Changing a column's type
- Removing a table

### 15.3 The Migration Strategy (To Be Designed)

The upgrade path needs to be defined before the first production release. Key questions to resolve:

1. **Export/import tooling** — Does `spacetime dump` produce a format we can transform and re-import? What does that pipeline look like for a breaking change?
2. **Versioned migration reducers** — Ship a `migrate_vN` reducer per breaking release. On upgrade: publish new schema with `--clear-database`, then run the migration reducer which re-inserts data from a pre-export. Requires a reliable export format.
3. **Schema versioning table** — A `SchemaVersion { version: u32 }` table lets the module detect its current version and run pending migrations automatically on `init`. The module would carry all historical migration logic and apply only the ones needed.
4. **SpacetimeDB roadmap** — SpacetimeDB is actively developing migration support. Track their progress — native migration tooling may eliminate this problem entirely before Pear hits prod.
5. **Upgrade documentation** — Every release that includes a breaking schema change must ship a migration guide. Minimum: a shell script that exports, clears, republishes, and re-imports. Ideally: a `pear upgrade` CLI command that handles the full flow.

### 15.4 Interim Rule (Pre-Migration Tooling)

Until the migration story is nailed down:
- **Schema changes must be additive only** for any release intended for production use.
- New columns must have sensible defaults so existing rows remain valid.
- Breaking changes are batched and released only when the migration tooling is ready.
- Dev instances use `--clear-database` freely. Prod instances never do without a migration script.

---

## 16. Content Storage Architecture (Simplified)

### 16.1 The Problem (Pre-Simplification)

The original architecture used `PageYjsUpdate` as an append-only log of every Yjs binary update, creating several problems:
- Per-keystroke writes to SpacetimeDB → high row counts, frequent echoes
- Echo suppression required non-trivial `Y.diffUpdate` logic in every subscriber
- `appliedIdsRef` deduplication grew unbounded across reconnections → OOM crashes in deeply nested docs
- Content "pop-in" delay: editor waited for all historical updates to replay before rendering

### 16.2 Implemented Architecture

```
┌─────────────────────────────────────────────┐
│  BlockNote (ProseMirror + Yjs XML)          │
└───────────────┬─────────────────────────────┘
                │  Y.Doc (in-memory CRDT)
       ┌────────┴──────────┐
       │                   │
  IndexedDB           SpacetimeDB
  (y-indexeddb)       (PageYjsState)
  Primary store       Periodic backup
  Instant load        One blob per page
  Always works        Background sync
```

**IndexedDB (`y-indexeddb`)**: Every Yjs op is persisted immediately by `IndexeddbPersistence`. On page load, content restores from IndexedDB in milliseconds — zero server round-trips, no "connecting" flash, works fully offline.

**SpacetimeDB (`PageYjsState` table)**: Stores a single merged Yjs state blob per page. Updated periodically (debounced ~30s, on blur, on unmount) via `save_yjs_state` reducer. This is the source of truth for cross-device sync and is used to bootstrap a fresh device/browser where IndexedDB is empty.

**`PageContent` (JSON)**: Still maintained for human-readable snapshots and page history. Updated alongside `PageYjsState` on periodic saves.

### 16.3 What Was Removed

- `PageYjsUpdate` table — eliminated entirely; no more per-keystroke writes
- `apply_yjs_update` reducer — no longer needed
- `SpacetimeYjsProvider`'s per-update send logic — replaced by periodic full-state save
- `appliedIdsRef` deduplication — eliminated; IndexedDB is the CRDT and there are no echoes

### 16.4 Save / Load Flow

**Load (page open):**
1. `IndexeddbPersistence` restores Y.Doc from local IndexedDB → editor renders instantly
2. If IndexedDB is empty (new device/browser), apply `PageYjsState.data` from SpacetimeDB to the Y.Doc

**Save (periodic / on blur / on unmount):**
1. `Y.encodeStateAsUpdate(doc)` → bytes
2. Call `save_yjs_state(page_id, bytes)` → updates `PageYjsState` in SpacetimeDB
3. Call `update_page_content(page_id, json)` with `editor.document` JSON → updates `PageContent` (for snapshots/history)

### 16.5 Offline Queue (Future)

When offline, edits accumulate in IndexedDB. On reconnect:
1. Compute `Y.encodeStateAsUpdate(doc)` (full current state)
2. Call `save_yjs_state` — SpacetimeDB gets the merged result
3. Apply `PageYjsState` from any other devices (Yjs CRDT merges cleanly)

No explicit pending queue is needed because the periodic save always sends the *full current state*, which implicitly includes all offline changes.

### 16.6 Trade-offs

| Aspect | Old (PageYjsUpdate) | New (PageYjsState) |
|---|---|---|
| SpacetimeDB writes | Per keystroke | Every ~30s |
| Echo suppression | Required (Y.diffUpdate) | Not needed |
| Multi-user real-time | Supported | ❌ Not yet (see §17) |
| OOM risk | High (unbounded replay) | None |
| Pop-in on return | Yes | No (IndexedDB instant) |
| Offline editing | Partial | Full |

---

## 17. Real-Time Multi-User Collaboration

> **Status: Deferred post-MVP.** The current architecture (§16) is intentionally single-user-first to eliminate complexity. This section documents how we'll add collaborative editing when the time comes.

### 17.1 What We're Deferring

Live concurrent editing within the same page by multiple users simultaneously. The current setup syncs state periodically, so two people editing the same page at the same time will have their changes merged on the next save cycle (last-write-wins at the SpacetimeDB level), not in real-time.

### 17.2 Why Yjs Still Sets Us Up Well

Even though `PageYjsUpdate` was removed, the entire document is still stored as a **Yjs state** (a CRDT). This means:
- Multiple users' changes can always be merged without conflicts (CRDT semantics)
- No custom merge logic is needed — Yjs handles it
- The Y.Doc is the single source of truth at the CRDT level

### 17.3 Implementation Path (When Ready)

1. **Re-introduce a real-time transport layer.** Options:
   - SpacetimeDB: bring back a streaming update table (`PageYjsUpdate`) but scoped to *active sessions only* (TTL, not permanent history). Use the existing per-page subscription pattern.
   - WebSocket relay (e.g. Hocuspocus server): purpose-built for Yjs real-time sync; slots in as a standard Yjs provider alongside `y-indexeddb`.
   - PartyKit / Liveblocks: managed Yjs collaboration infrastructure.

2. **Restore `SpacetimeYjsProvider` send logic** (or add a second provider) to broadcast incremental updates to active collaborators.

3. **Awareness / cursors**: `y-protocols/awareness` is already wired into the provider stub. Cursor positions and user presence can be added without schema changes.

4. **Conflict resolution**: Yjs handles structural conflicts. Application-level conflicts (e.g. two users deleting the same page) need reducer-level idempotency (already the case for existing reducers).

### 17.4 UX Considerations

- Presence indicators (avatars on the page title bar) showing active collaborators
- Named cursors within the editor (Yjs awareness)
- "Last edited by X" metadata on pages
- Conflict notification when a periodic save detects a divergence (unlikely with CRDT but possible at the SpacetimeDB reducer level)

---

## 18. Custom Block Types

BlockNote's block system is extensible. Beyond the standard text/heading/list/code blocks, Pear ships purpose-built block types that integrate directly with the data layer.

### 18.1 PageLink Block

Already implemented. A custom block that embeds a reference to another Pear page inline in a document — renders as a linked page chip with the page title. Created via `/page` slash command. When the referenced page title changes in SpacetimeDB, the chip updates in real time.

### 18.2 Audio Recording Block

A native in-document audio recorder for capturing and transcribing voice — designed primarily for meeting recordings, voice notes, and interview captures.

**Block behavior:**
- Inserting an `Audio` block (via `/audio` slash command) starts a recording session immediately
- MediaRecorder API captures microphone input; waveform visualization renders during recording
- On stop, the audio blob is stored (base64 or external blob storage reference) in the block's content JSON
- The block renders a persistent audio player on any future view of the document

**Transcription strategy (tiered, matching the embeddings philosophy):**

| Tier | Method | When Used |
|---|---|---|
| **On-device (Apple)** | `webkitSpeechRecognition` / Web Speech API | Default on Safari/macOS/iOS — uses Apple's on-device model, zero cost, fully private |
| **Local Whisper** | [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) via Ollama or standalone binary | Set `PEAR_TRANSCRIPTION_BACKEND=whisper` — self-hosted, GPU-optional, excellent quality |
| **Cloud** | OpenAI Whisper API | Set `PEAR_TRANSCRIPTION_BACKEND=openai` — for users who don't need local and want fastest turnaround |

**Output:**
- Real-time partial transcripts appear inline while recording (where Web Speech API supports it)
- Final transcript appended as plain text blocks below the audio player after recording stops
- Transcript is fully editable — it's just regular Pear blocks, nothing special
- Speaker diarization (future): "Speaker A:", "Speaker B:" labels inserted when using Whisper models that support it
- Because the transcript lives in `PageContent` as normal blocks, it's immediately indexed for semantic search and available to Orcha agents — "summarize this meeting" just works

**Meeting recording mode:**
Users can also drag-and-drop an existing audio file (`.m4a`, `.mp3`, `.wav`) onto an Audio block to trigger transcription of a pre-recorded file rather than a live session. Same transcription pipeline, same output format.

---

*Last updated: March 2026*