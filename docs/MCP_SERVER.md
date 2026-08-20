# Pear MCP Server

Pear ships an [MCP](https://modelcontextprotocol.io) server so external AI models — Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP — can use your Pear workspace as a **persistent memory store** and **notes backend**.

Every MCP client connects **as a Pear AI user** (via that AI user's worker token):

- It gets its own **private memory subtree** — hidden from workspace navigation, writable only by that AI user, readable by its creator.
- Its page writes are **attributed** to the AI user and governed by the same page access rules as everything else (`page_access_rule`, open-by-default).
- Two clients with different tokens see **disjoint memories**.

The implementation is **stateless**: tools run over SpacetimeDB's HTTP `/sql`
(reads, RLS-scoped by the caller's token) and `/call` (reducer writes,
synchronous success/failure) endpoints — no WebSocket subscription is held.
The shared core lives at `web/src/lib/mcp/` and is mounted by three hosts:
the worker's stdio and HTTP entrypoints below, and (on Pear Cloud) the API
gateway at `https://{workspace}.api.pear.pro/mcp`.

## 1. Provision an AI user + token

The worker token is only displayed at creation time, so use the CLI (it prints the token plus ready-to-paste client configs):

```bash
# PEAR_ADMIN_TOKEN = your own SpacetimeDB token for this workspace.
# In the web app: localStorage.getItem('pear:token:<workspace>') in the browser console.
PEAR_ADMIN_TOKEN=<your-token> pnpm mcp:provision -- --name "Claude Code"
```

Options: `--no-memory` skips provisioning the private memory subtree.
Env: `SPACETIMEDB_URI` (default `ws://localhost:3000`), `SPACETIMEDB_DB_NAME` (default `pear-dev`).

## 2a. Connect over stdio (local)

The MCP host spawns the server as a child process. From the pear repo:

```bash
claude mcp add pear \
  --env SPACETIMEDB_URI=ws://localhost:3000 \
  --env SPACETIMEDB_DB_NAME=pear-dev \
  --env PEAR_MCP_TOKEN=<worker token> \
  -- pnpm --filter @pear/worker mcp:stdio
```

Or in `.mcp.json` / Claude Desktop / Cursor config (set `cwd` to the pear checkout, or use an absolute `--dir` filter):

```json
{
  "mcpServers": {
    "pear": {
      "command": "pnpm",
      "args": ["--filter", "@pear/worker", "mcp:stdio"],
      "env": {
        "SPACETIMEDB_URI": "ws://localhost:3000",
        "SPACETIMEDB_DB_NAME": "pear-dev",
        "PEAR_MCP_TOKEN": "<worker token>"
      }
    }
  }
}
```

## 2b. Connect over HTTP — Pear Cloud

Hosted workspaces expose MCP through the API gateway; nothing to run:

```bash
claude mcp add --transport http pear https://<workspace>.api.pear.pro/mcp \
  --header "Authorization: Bearer <worker token>"
```

The bearer token is the AI user's worker token, validated by the workspace's
own SpacetimeDB (invalid/foreign tokens → 401). Requests are rate-limited at
the edge per workspace + client IP.

## 2c. Connect over HTTP (self-hosted)

Run the streamable-HTTP server (bearer token = worker token):

```bash
pnpm mcp                              # binds 127.0.0.1:3888
# or as part of the stack:
docker compose --profile mcp up -d    # binds 0.0.0.0:3888 inside the pear network
```

```bash
claude mcp add --transport http pear http://localhost:3888/mcp \
  --header "Authorization: Bearer <worker token>"
```

`GET /healthz` reports liveness. Env vars:

| Var | Default | Meaning |
|---|---|---|
| `SPACETIMEDB_URI` | `ws://localhost:3000` | SpacetimeDB URI (ws:// or http:// — tools use the HTTP surface) |
| `SPACETIMEDB_DB_NAME` | `pear-dev` | Workspace database name |
| `PEAR_MCP_HTTP_HOST` / `PEAR_MCP_HTTP_PORT` | `127.0.0.1` / `3888` | Listener |
| `PEAR_MCP_ALLOWED_HOSTS` | `localhost:<port>,127.0.0.1:<port>` when bound to loopback | Host-header allowlist (DNS-rebinding protection). Set to your public `host:port` when exposing the server; TLS via a reverse proxy. |

## Tools

Memory (private to the connected AI user):

| Tool | Purpose |
|---|---|
| `remember` | Save a memory — new page (`title` + `content` markdown) or append/replace an existing one (`memory_page_id`, `mode`) |
| `list_memory` | Index of all memory pages (id, title, snippet, size, last updated) |
| `search_memory` | Scored term search over memory titles + bodies |
| `read_memory` | Full body of one memory page |

Workspace pages (governed by page access rules):

| Tool | Purpose |
|---|---|
| `create_page` | Create a Doc or Database page (`parent_id: 0` = workspace root) |
| `get_page` | Title, type, parent, and content of a page. Headings, nested lists and checklists come back as markdown; attached files/images/audio appear as `[File: "name" (size, type) storage_key=…]` descriptors |
| `read_file` | Contents of a workspace file by `storage_key` (from `get_page`, `get_page_components` props, or a chat attachment). Text-like files, PDF and DOCX return text (windowed with `offset`/`next_offset`); other binaries return metadata. Needs blob storage on the host: the worker's `S3_*` env, or `HETZNER_S3_*` secrets on the Pear Cloud gateway — otherwise the tool reports itself unavailable |
| `update_page_content` | Replace a Doc page's body with markdown |
| `update_page_title` | Rename a page |
| `list_child_pages` | Children of a page |
| `search_pages` | Case-insensitive title search |
| `move_page` | Reparent a page |
| `delete_page` | Soft-delete (restorable from trash) |

## Security notes

- **A worker token is a credential with the AI user's full authority.** Treat it like a password; rotate by re-provisioning if it leaks.
- Page writes are checked server-side (`require_page_write`) — restricting a page/subtree with access rules restricts MCP clients too.
- The memory subtree is created with an AI-user-only write rule and a creator read rule; other workspace members can't read it.
- The HTTP server has no TLS — front it with a reverse proxy for anything beyond localhost.

## Follow-ups (not yet implemented)

Semantic (embedding) search over pages; database-row tools (`query_database`, `create_row`, properties); MCP resources (`pear://page/{id}`); a "copy MCP token" button in the AI Users settings UI.
