# Pear — Roadmap

> This document tracks what's shipped, what's actively being built, and what comes next.
> For architecture decisions and data model details, see [`PEAR_MVP.md`](./PEAR_MVP.md).

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
- ✅ BlockNote integration — rich text editor with slash commands
- ✅ Local-first storage — IndexedDB primary, SpacetimeDB periodic backup (30s debounce)
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

- ✅ Blob storage backend — MinIO in Docker Compose (S3-compatible); env defaults so web uses it; override `S3_*` for external (R2, S3)
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
- 📋 Audio recording block — record or drop audio files, inline player, auto-transcription *(uses blob storage for audio files)*
  - On-device transcription via `webkitSpeechRecognition` (Apple, zero config)
  - Local Whisper via Ollama (`PEAR_TRANSCRIPTION_BACKEND=whisper`)
  - Cloud fallback via OpenAI Whisper API
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
- 📋 Embedding pipeline — background job generates embeddings on `PageContent` changes
  - Tier 1: `all-MiniLM-L6-v2` via ONNX Runtime (baked in, zero config, 80MB)
  - Tier 2: `nomic-embed-text` via Ollama (`PEAR_EMBEDDING_BACKEND=ollama`)
  - Tier 3: OpenAI `text-embedding-3-small` (`PEAR_EMBEDDING_BACKEND=openai`)
- 📋 Semantic search UI — search by meaning, not just title keywords
- 📋 Audio transcript search — transcripts indexed as normal page content, searchable immediately

### Orcha integration
- 📋 Connect Orcha orchestration layer to Pear's SpacetimeDB module
- 📋 `PreAgentEdit` / `PostAgentEdit` snapshots — auto-snapshot before and after agent edits
- 📋 Agent edit badge in history — "edited by [agent name]" with one-click revert
- 📋 Schema generation agent — describe what you want to track, agent generates `DatabaseSchema` + `PropertyDefinitions`
- 📋 Natural language filter — "show me all tasks due this week assigned to me" → filter config
- 📋 Workspace summarization — "summarize my open tasks" pulls from `PropertyValues`, not raw text
- 📋 Relation suggestions — agent notices structural patterns across databases, suggests relation columns
- 📋 Audio meeting summaries — after transcription, agent generates structured summary + action items as database rows

---

## Phase 3 — Collaboration & Workspaces
*Goal: Make Pear useful for teams, not just individuals.*

### Real-time multi-user editing
- 📋 Re-introduce streaming Yjs updates for active sessions (see `PEAR_MVP.md §17`)
- 📋 Presence indicators — avatars on page title bar showing active collaborators
- 📋 Named cursors — per-user cursor positions in the editor (`y-protocols/awareness`)
- 📋 "Last edited by X" metadata on pages and properties

### Multi-workspace client
- 📋 Local workspace connection storage — list of `WorkspaceConnection` entries, never synced
- 📋 Workspace switcher in sidebar
- 📋 Invite link generation and join flow — `pear://host:port?invite=token`
- 📋 One-time invite tokens with expiry

### Permissions
- 📋 Workspace roles — Owner, Admin, Member, Guest
- 📋 Page-level sharing — make specific pages readable without workspace membership
- 📋 Personal views — `DatabaseView.owner_identity` already in schema, needs UI

---

## Phase 4 — Automations
*Goal: Let users connect Pear's data model to the outside world and to AI without writing code.*

- 📋 Automation rules — trigger on page/property events, chain actions
- 📋 Action types:
  - `HttpRequest` — webhooks, Zapier, n8n, Make
  - `SendEmail` — SMTP notification
  - `CreatePage` — auto-create rows in response to events
  - `UpdateProperty` — auto-set values
  - `OrchaJob` — delegate work to AI agent pool
- 📋 Automation worker — Orcha-based worker that subscribes to `AutomationEventQueue`, executes action chains
- 📋 Automation run log — UI showing what ran, when, result per action
- 📋 Automation builder UI — create/edit rules and action chains

---

## Phase 5 — Views & Advanced Data
*Goal: More ways to look at the same data.*

- 📋 Kanban view — group rows by a Select property, drag between columns
- 📋 Calendar view — group rows by a Date property, month/week display
- 📋 Gallery view — card grid, show a cover image property
- 📋 Formula columns — computed values derived from other properties
- 📋 Rollup columns — aggregate values from a related database
- 📋 Timeline view — Gantt-style, requires date range properties
- 📋 Board status transitions — enforce allowed `Status` changes (state machine for Select)

---

## Phase 6 — Ecosystem
*Goal: Pear as a platform, not just a product.*

- 💡 Import from Notion — page tree, databases, properties, content
- 💡 Import from Markdown — flat file import with front-matter as properties
- 💡 Export to Markdown — full workspace export for backup or migration
- 💡 Native desktop app — Electron or Tauri wrapper for macOS/Windows/Linux
- 💡 Mobile app — iOS/Android (read-first, then edit)
- 💡 Public Pear Cloud — managed hosting for users who don't want to self-host
- 💡 Plugin system — third-party block types and integrations
- 💡 Canvas / Whiteboard — freeform visual workspace (deliberately out of scope until core is solid)
- 💡 `pear upgrade` CLI — automated schema migration + version upgrade tool

---

## Deferred / Won't Do (v1)
These are explicitly not being built until the core is solid:

- Real-time multiplayer cursors ← post-Phase 3
- Permissions / sharing ← post-Phase 3
- Formula columns ← post-Phase 5
- Rollups ← post-Phase 5
- Kanban / Calendar / Gallery ← post-Phase 5
- Mobile ← post-Phase 6
- Notion import ← post-Phase 6
- Whiteboard / Canvas ← post-Phase 6

---

*Last updated: March 2026*
