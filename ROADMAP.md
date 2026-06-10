# Pear — Roadmap

> This document tracks what's shipped, what's actively being built, and what comes next.
> For architecture decisions and data model details, see `[PEAR_MVP.md](./PEAR_MVP.md)`.

---

## Legend

- ✅ Shipped
- 🔨 In progress / partially done
- 📋 Planned
- 💡 Exploratory / future

---

## Phase 0 — Foundation (MVP)

*Goal: A self-hostable Notion alternative with the core page + database loop working.*

### Core data layer

- ✅ SpacetimeDB module — all tables, types, reducers in Rust
- ✅ `Page` + `PageContent` tables — create page creates both atomically
- ✅ Soft deletes — `deleted_at` field, trash view, restore
- ✅ Page history — `PageSnapshot` table, history panel, one-click restore
- ✅ `PagePropertyValueHistory` — append-only audit trail for property changes
- ✅ Auth — SpacetimeAuth as default (email/password, zero config)

### Editor

- ✅ BlockNote integration — rich text editor with slash commands *(legacy — superseded by the component-tree editor; see [Rendering substrate](#rendering-substrate--componentnode-tree) below)*
- ✅ Local-first storage — IndexedDB primary, SpacetimeDB periodic backup (30s debounce) *(BlockNote pages only; component-tree pages sync block-level through SpacetimeDB directly)*
- ✅ PageLink block — inline page reference with live title sync
- ✅ Page history panel — timeline of snapshots, preview, restore

### Database / Grid

- ✅ Database page type with `DatabaseSchema`
- ✅ Property types — Text, Number, Date, Select, MultiSelect, Checkbox, URL, Relation
- ✅ Grid view — rows and columns, inline cell editing
- ✅ Conditional select options — formula syntax `this[Field]="Value"?"Label"`
- ✅ Select option colors — per-option color picker in options editor
- ✅ Filter bar — filter rows by any property
- ✅ Sort bar — sort rows by any property, multi-sort
- ✅ Fill handle — drag corner of selected cell to populate cells below
- ✅ Relation property — link rows across two databases
- ✅ Row detail modal — open any row as a full page with editor + properties
- ✅ Full-page view — navigate directly to any row's page (URL-routable)
- ✅ Properties panel in full-page view — edit database properties when viewing a page
- ✅ Column header menu — rename, change type, edit options, delete

### Self-hosting

- ✅ Docker + Docker Compose for SpacetimeDB + Next.js
- ✅ Deploy script — builds WASM module + web image, pushes to registry, SCPs to remote

---

## Phase 1 — Polish & Core Completeness

*Goal: Make what's built feel solid and fill obvious gaps before adding major new features.*

### Storage & attachments

*Foundation for image block, audio block, page covers, and future file-backed features.*

- ✅ Blob storage backend — MinIO in Docker Compose (S3-compatible); env defaults so web uses it; override `S3_`* for external (R2, S3)
  - MinIO service + `minio-init` creates `pear-attachments` bucket
  - Web service env: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` default to MinIO
  - Attachment metadata in SpacetimeDB — `Attachment` table + `create_attachment` / `delete_attachment` reducers
- ✅ Upload API — `POST /api/upload/request` (presigned PUT URL), `GET /api/upload/url?key=...` (presigned GET); hooks `usePageAttachments`, `useCreateAttachment`, `useDeleteAttachment`

### Database / Grid

- ✅ List view — simplified single-column view of database rows
- ✅ Column widths — drag to resize, persisted in `DatabaseView.config`
- 📋 Row reordering — drag rows to manually sort (when no active sort rule)
- ✅ Multi-select rows — bulk delete, shift-click range, Ctrl+A; bulk delete action bar
- ✅ Keyboard navigation — arrow keys between cells, Tab to move right, Enter to edit
- ✅ Frozen first column — Name column stays visible when scrolling right

### Editor

- ✅ Audio recording block — record or upload audio (S3/MinIO), inline player, live transcript via Web Speech API where available *(Chrome / Safari)*
  - Floating **meeting** banner when microphone permission is granted and an audio input device label looks like a conferencing app (Zoom, Meet, Teams, etc.) — best-effort; optional **Allow microphone** prompt first to unlock device labels
  - `/audio` slash command; paste/drop audio files
  - 📋 Whisper / OpenAI cloud transcription — not wired yet (`PEAR_TRANSCRIPTION_BACKEND` roadmap)
- ✅ Image block — paste, drop, or /Image to upload; stored in S3, block uses proxy URL; caption supported
- ✅ Table block — included in BlockNote default schema (distinct from database grid)
- ✅ Code block improvements — language picker (createCodeBlockSpec with supported languages), copy via ⌘⇧C / Ctrl+Shift+C when cursor in code block

### Navigation & UX

- ✅ Sidebar improvements — drag to reorder pages, collapse/expand subtrees
- ✅ Quick switcher — `⌘K` fuzzy-search across all pages by title
- ✅ Breadcrumb navigation — show page hierarchy in the header (Workspace / Parent / Current)
- ✅ Page emoji — per-page icon (emoji picker) in sidebar, Doc page header, and Database page header; `Page.icon` + `update_page_icon` reducer
- 📋 Cover image — per-page cover photo *(uses blob storage)*
- 📋 Trash improvements — 30-day countdown, purge all, bulk restore

### Settings

- ✅ Settings page — `/workspace/settings` with theme toggle, clear cached data, about; link in sidebar and "Open settings" in gear popover
- ✅ Clear local cache — "Clear cache for this page" and "Clear cache for workspace" in page ⋮ menu; "Clear cached data" in sidebar settings
- 📋 Custom OIDC — UI for entering `PEAR_OIDC_ISSUER` without editing env file manually

---

## Phase 2 — AI Integration

*Goal: Make Pear's relational data model useful to AI agents. AI as infrastructure, not a sidebar.*

### Semantic search

- ✅ Embedding pipeline — `POST /api/embed` runs `Xenova/all-MiniLM-L6-v2` (384-dim, quantized) in the Next.js server; `PearEditor` indexes the open page every 45s (or on first tick) and stores vectors in `Page.embedding` via `set_page_embedding`
  - *(Tier 2 Ollama / Tier 3 OpenAI not wired yet — same reducer expects 384-dim MiniLM only.)*
  - *(Ship notes: root `pnpm.overrides` pins `sharp` so the transformers stack resolves native binaries on darwin-arm64; embedding work is scheduled with `setTimeout` so markdown export does not run during React commit and avoids `flushSync` warnings.)*
- ✅ Semantic search UI — Quick Switcher (⌘K) merges title fuzzy-match with cosine similarity over `Page.embedding`; semantic hits show a small “semantic” badge when the query is 2+ chars; stable embedding index + query-scoped selection so hybrid ranking does not loop
- ✅ Audio transcript search — audio block transcripts are merged into semantic indexing (`collectAudioTranscripts` + markdown) and included in AI page context extraction

### Orcha integration

- ✅ Embed Orcha coordination layer in Pear's SpacetimeDB module — `OrchaJob`, `OrchaTask`, `OrchaAgent`, `OrchaSharedContext` tables + `create_job`, `claim_task`, `submit_result`, `fail_task`, `register_agent`, `set_shared_context` reducers. Jobs linked to Pear pages via `page_id`. External instance supported via `ORCHA_SPACETIMEDB_URI` / `ORCHA_SPACETIMEDB_DB_NAME` env vars.
- ✅ TypeScript module bindings regenerated — `orcha_job`, `orcha_task`, `orcha_agent`, `orcha_shared_context` tables + all 6 reducers available client-side
- ✅ `hooks/useOrcha.ts` — `useOrchaJobsForPage`, `useOrchaTasksForJob`, `useOrchaAgents`, `useCreateJob`, and all reducer hooks
- ✅ `AiPanel` component — star button in page header opens a right-side panel; shows all jobs for the page with task-level status; prompt textarea creates new jobs (⌘↵ to submit)
- ✅ `PreAgentEdit` / `PostAgentEdit` snapshots — the worker brackets every mutating tool call with before/after snapshots
- ✅ Pending-changes review — per-page panel lists agent edit brackets with accept / reject (rollback to pre-snapshot)
- 📋 Schema generation agent — describe what you want to track, agent generates `DatabaseSchema` + `PropertyDefinitions`
- 📋 Natural language filter — "show me all tasks due this week assigned to me" → filter config
- 📋 Workspace summarization — "summarize my open tasks" pulls from `PropertyValues`, not raw text
- 📋 Relation suggestions — agent notices structural patterns across databases, suggests relation columns
- 📋 Audio meeting summaries — after transcription, agent generates structured summary + action items as database rows

### AI conversation engine

- ✅ Token usage tracking — `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` columns on `ConversationMessage`; cost attribution per assistant turn persisted in SpacetimeDB
- ✅ `MessageSender::System` variant — synthetic system-role messages (e.g. compaction events) stored alongside human/AI messages
- ✅ `record_compaction` reducer — persists agent compaction summaries as floor-marker messages; session resume discards pre-floor messages and injects the summary into the system prompt
- ✅ `SystemPromptBuilder` — dynamic system prompt assembly: workspace context, instruction pages, compaction summary injection, mandatory prompt-injection defense block always appended last
- ✅ `WorkspaceContext` + `discover_instruction_pages` — walks page tree to find pages flagged with the `agent_instruction` checkbox property; `summarize_page_history` surfaces recent edits
- ✅ `reconstructSessionTail` — compaction floor detection; reconstructs `Session.messages` from the tail only, skips pre-compaction history
- ✅ `seed_agent_instruction_property` reducer — idempotent; seeds the `agent_instruction` checkbox `PropertyDefinition` for a given schema so instruction page discovery works out of the box

### Extensions & MCP tools

*Pear's plugin system — lets users and third-party developers extend the AI agent with custom tools via the Model Context Protocol.*

- ✅ Schema — `ExtensionManifest`, `InstalledExtension`, `ExtensionMcpServer`, `ExtensionPermission`, `ToolCallAuditLog` tables; `ExtensionType` (`ConfigBundle`, `McpServer`, `Hybrid`, `Builtin`), `AuthScheme`, `InstallStatus`, `PermissionScope`, `PermissionAction` enums
- ✅ Reducers — `publish_extension`, `install_extension`, `confirm_extension_install`, `cancel_extension_install`, `uninstall_extension`, `set_extension_enabled`, `grant_extension_permission`, `revoke_extension_permission`, `set_mcp_server_api_key`, `update_extension`
- ✅ Sensitive capability gate — extensions requesting `tool-bash`, `tool-http`, workspace-write permissions, etc. land in `PendingConfirmation` and require explicit human confirmation before sub-resources are created
- ✅ MCP client (`mcp-client.ts`) — SSE transport, connects to one `ExtensionMcpServer` endpoint, lists tools, executes tool calls, wraps results in trust-boundary marker
- ✅ `McpToolExecutor` — loads all enabled MCP servers on startup, routes tool calls by name, handles first-registered-wins collision
- ✅ `StaticToolExecutor` — wraps all 14 built-in native tools (`create_page`, `search_pages`, `web_search`, etc.) in the unified executor interface
- ✅ `CompositeToolExecutor` — unified tool dispatch: static wins over MCP on name collision, `PermissionChecker` enforces scope/action rules for MCP tools, `AuditLogger` records every call
- ✅ `PermissionChecker` — scope hierarchy (`Page ⊂ Subtree ⊂ Workspace`), domain allowlist for `HttpOutbound`, unconditional block of RFC 1918 + loopback hosts
- ✅ `AuditLogger` — SHA-256 hashes input/output, writes `ToolCallAuditLog` rows, never throws on failure
- ✅ Extensions UI — installed extensions list with enable/disable toggle, uninstall, upgrade badge; available manifests browser; install form (API key + endpoint override); sensitive-capability confirmation modal; "Publish manifest" form; "Install from URL" (fetches manifest JSON from any URL)
- ✅ Built-in extension — `ExtensionType::Builtin`; `extensions/pear-workspace-tools.json` in the repo is both the canonical manifest and the copyable template for users; auto-seeded in `init`; `seed_builtin_extensions` reducer for existing deployments; collapsible "Built-in" section in settings UI with indigo badge and no uninstall controls

---

## Phase 3 — Collaboration & Workspaces

*Goal: Make Pear useful for teams, not just individuals.*

### Real-time multi-user editing

- 🔨 Live block-level sync — component-tree pages sync per-block through SpacetimeDB subscriptions; per-block Yjs state merges server-side. Streaming awareness (presence, cursors) still open.
- 📋 Presence indicators — avatars on page title bar showing active collaborators
- 📋 Named cursors — per-user cursor positions in the editor (`y-protocols/awareness`)
- 📋 "Last edited by X" metadata on pages and properties

### Multi-workspace client

- ✅ Local workspace connection storage — workspace connections panel in settings; connection list stays local
- ✅ Workspace snapshot export / import — download a full-workspace JSON snapshot, import into an empty workspace
- 📋 Invite link generation and join flow — `pear://host:port?invite=token`
- 📋 One-time invite tokens with expiry

### Permissions

- ✅ Page & block access rules — `set_page_access_rule` / `set_block_access_rule` reducers with server-side enforcement
- ✅ Access requests — `request_page_access` / `resolve_page_access_request` flow
- 📋 Workspace roles — Owner, Admin, Member, Guest (today: admin flag + per-page rules)
- 📋 Personal views — `DatabaseView.owner_identity` already in schema, needs UI

---

## Phase 4 — Automations

*Goal: Let users connect Pear's data model to the outside world and to AI without writing code.*

- ✅ Automation substrate (v0) — typed trigger/action graphs in the module (`PageCreated`, `PageUpdated`, `PropertyChanged`, `Scheduled`, …), event queue, scheduled routines (interval / one-shot / cron), and **dry-run execution** so rules can be drafted, validated, and simulated safely
- 🔨 Live action execution — side effects stay behind the queue boundary in v0; live mode exists as a flag but actions are not yet executed for real
- 📋 Action types (live):
  - `HttpRequest` — webhooks, Zapier, n8n, Make
  - `SendEmail` — SMTP notification
  - `CreatePage` — auto-create rows in response to events
  - `UpdateProperty` — auto-set values
  - `OrchaJob` — delegate work to AI agent pool
- 📋 Automation worker — Orcha-based worker that subscribes to the event queue, executes action chains
- 📋 Automation run log — UI showing what ran, when, result per action
- 📋 Automation builder UI — create/edit rules and action chains

---

## Phase 5 — Views & Advanced Data

*Goal: More ways to look at the same data.*

- ✅ Kanban / board view — group rows by a Select property (`ViewType::Kanban` + `BoardView`)
- 📋 Calendar view — group rows by a Date property, month/week display *(`ViewType::Calendar` exists in schema; no renderer yet)*
- 📋 Gallery view — card grid, show a cover image property *(`ViewType::Gallery` exists in schema; no renderer yet)*
- ✅ Formula columns — client-evaluated expressions over sibling properties (`PropertyType::Formula`)
- ✅ Rollup columns — aggregate values from a related database (`PropertyType::Rollup`, client-evaluated)
- ✅ AI columns — model-computed values over row data (`PropertyType::Ai`, evaluated by the worker with cached evaluations)
- 📋 Timeline view — Gantt-style, requires date range properties
- 📋 Board status transitions — enforce allowed `Status` changes (state machine for Select)

---

## Phase 6 — Ecosystem

*Goal: Pear as a platform, not just a product.*

- ✅ Import from Notion — `import_notion` reducer rebuilds page tree, databases, properties, and content into an empty workspace; settings panel drives it via an external OAuth + transform service
- ✅ Pear snapshot export / import — full-workspace JSON snapshot for backup or migration between instances
- 💡 Import from Markdown — flat file import with front-matter as properties
- 💡 Export to Markdown — full workspace export
- 💡 Native desktop app — Tauri v2 (an earlier prototype lived in this repo; not currently maintained here)
- 💡 Mobile app — iOS/Android via Tauri v2 (read-first, then edit)
- 💡 Public Pear Cloud — managed hosting for users who don't want to self-host
- ✅ Plugin system — Extensions + MCP tools (see Phase 2 above)
- 💡 Canvas / Whiteboard — freeform visual workspace (deliberately out of scope until core is solid)
- 💡 `pear upgrade` CLI — automated schema migration + version upgrade tool

---

## Rendering substrate — `ComponentNode` tree

*Cross-cutting infrastructure replacement. Replaces BlockNote as Pear's document model with a typed component tree owned by SpacetimeDB.*

### Substrate layer (shipped)

- ✅ `ComponentNode`, `ComponentYjsState`, `ComponentTypeDefinition` tables
- ✅ Component-tree reducer surface — `create_component_tree_page`, `insert_component`, `update_component_props`, `move_component`, `delete_component`, `restore_component`, `save_component_yjs_state`, `register_component_type`, `update_component_type`, plus migration reducers
- ✅ Built-in registry — 18 idempotently-seeded types: `Container`, `RichText`, `Heading`, `Image`, `ImageBlock`, `Audio`, `Form`, `Input`, `Button`, `Table`, `Card`, `List`, `CodeRef`, `PageLink`, `Conversation`, `BulletListItem`, `NumberedListItem`, `ChecklistItem`
- ✅ Per-block Y.Doc storage via `ComponentYjsState` (legacy `PageYjsState` retained for unmigrated BlockNote pages)
- ✅ `PageSnapshot` payload extension — `component_tree_v1` JSON shape carries node tree + base64-encoded Yjs blobs; restore reassigns IDs and remaps parent refs
- ✅ Purge cascade — page purge cascades into `component_node` + `component_yjs_state`
- ✅ Integrity model — server-side reducers enforce tree-shape invariants (parent existence, no cycles, registered types, `accepts_children`, `has_yjs_state` consistency, leaf-only soft-delete, restore requires live ancestor chain, access control)
- ✅ Client-side prop-schema validator — dependency-free JSON Schema subset covering every built-in
- ✅ End-to-end smoke harness — `pnpm --filter web smoke` against a local stack
- ✅ [`@eclosion-tech/react-native-yjs-text` v0.1](https://www.npmjs.com/package/@eclosion-tech/react-native-yjs-text) — native RN rich-text editor primitive, MIT

### Editor & renderers

- ✅ **Web editor (`packages/pulp`)** — storage-agnostic component-tree editor: rendering against the registry, per-block ProseMirror rich text over Yjs, slash menu, drag handles, multi-block selection, turn-into, undo/redo. Wired to SpacetimeDB by the web app's component renderers.
- ✅ **BlockNote → `ComponentNode` migration** — new Doc pages default to the component tree; existing BlockNote pages migrate in place
- ✅ **AI authoring** — the worker authors component-tree content directly (markdown → component block specs → component reducers, with per-insert verification)
- 📋 **React Native renderer** — RN renderer over the `ComponentNode` tree; `react-native-yjs-text` provides the rich-text primitive
- 📋 **Custom-view runtime** — data-bound components (cursors, bindings, write-back) for building app-like views from the same primitives
- 📋 **Server-side prop-schema enforcement** — client-side validation is the authority today; promote to a reducer-side gate once `prop_schema` evolution patterns settle
- 📋 **Templates** — shareable custom views, type-based binding remap on install

---

## Deferred / Won't Do (v1)

These are explicitly not being built until the core is solid:

- Real-time multiplayer cursors / presence ← post-Phase 3
- Workspace roles (Owner/Admin/Member/Guest) ← post-Phase 3 *(per-page/block access rules already shipped)*
- Calendar / Gallery / Timeline views ← post-Phase 5 *(Kanban board shipped)*
- Mobile ← post-Phase 6
- Whiteboard / Canvas ← post-Phase 6

---

*Last updated: June 10, 2026 — component-tree editor (`packages/pulp`) is now the default document surface; BlockNote retained as legacy path with in-place migration. Also landed since May: page/block access rules + access requests, automations v0 substrate (dry-run), board view, formula/rollup/AI columns, Notion import, workspace snapshot export/import, custom REST API endpoints (`docs/API_ENDPOINTS.md`). Earlier — May 2026: rendering substrate layer (tables, reducers, registry, smoke harness). April 2026: Phase 2 semantic search; agent runtime + Extensions/MCP; Phase 6 plugin system ✅*