# Pear Desktop

Tauri v2 desktop shell: an **agent engine manager** (spawn local agent CLIs —
Claude Code, Codex — as pear AI users with the pear MCP server injected) plus a
**workspace client** (embeds the pear web app).

## Architecture

- The main window opens on an app-origin **launcher** (`src/` — plain HTML/JS,
  workspace URL picker) and navigates to the chosen pear workspace URL.
- The **pear web app detects the Tauri runtime** (`web/src/lib/tauri`) and
  mounts the Engines panel (`web/src/components/engines/`), which drives the
  Rust engine manager over IPC.
- **Remote-origin IPC** is granted by
  `src-tauri/capabilities/remote-workspace.json`: only our own commands +
  `core:default`, for `http://localhost:*`, `http://127.0.0.1:*`, and
  `https://*.pear.pro`. Connecting to a self-hosted domain outside those
  patterns requires adding the URL to that capability and rebuilding —
  capabilities are compiled into the app.
- App commands must be declared in `src-tauri/build.rs` (`AppManifest.commands`)
  AND granted in the capability files, or the ACL rejects them
  ("not allowed. Plugin not found").

## Dev

```bash
# terminal 1: the web app the window will embed
cd web && pnpm dev          # http://localhost:3001

# terminal 2: the desktop app
cd desktop && pnpm tauri:dev
```

## Status

- M0 (scaffold, launcher, remote-origin IPC): ✅ verified 2026-07-04 — the web
  app at localhost:3001 successfully invoked `engines_detect` from inside the
  Tauri window (claude + codex detected); non-granted commands are denied.
- M1 (Claude engine sessions), M2 (Codex), M3 (transcripts), M4 (local
  workspace mode), M5 (bridge embed): see the roadmap plan.
