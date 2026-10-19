# IMAP mail monitor

This page describes the existing page-based monitor. The separate
[private mail storage substrate](PROTECTED_MAIL_STORAGE.md) is staged and has
no settings activation or runner integration yet. Sentinel's protected profile
remains disabled; see [implementation status](SENTINEL.md).

Mail monitoring is configured in **Workspace settings → Mail**. Each connection
belongs to its creator in the currently selected Pear workspace. No provider,
mailbox, domain, or workspace is built into the connector. Mailu and other IMAP
servers with implicit TLS are supported; the usual port is 993.

## Host setup

Deploy the updated SpacetimeDB module, web client, and worker together. The
existing `DatabaseWorker` runs a monitor for each workspace it serves, including
Pear Cloud's managed workers. For Pear Cloud, set the key on the Orcha manager
service; the workspace settings route uses the same Mail panel. It requires the module publisher token already
used by the worker and a dedicated encryption key:

```sh
# Store the result directly in your worker secret manager. Do not commit it.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 | openssl base64 -A
```

Set that value as `PEAR_MAIL_PRIVATE_KEY_B64`. All workers serving a workspace
must use the same key. The worker publishes only the public key to the workspace;
the settings form encrypts app passwords in the browser before sending them to
a reducer. Password ciphertext is held in a private table. The private key stays
in worker configuration, outside database snapshots and reducer arguments.

The Compose worker passes through this setting and `SPACETIMEDB_TOKEN`. A missing
key leaves the monitor disabled and the settings page explains that the host
has not enabled mail connections. Back up this key in the host's secret store.
To change the key, disconnect the workspace's mail connections, update every
worker, and reconnect with app passwords. Existing mail pages are retained.

Public IMAP destinations are allowed by default; TLS certificates are verified.
Self-hosted operators can set `PEAR_MAIL_ALLOW_PRIVATE_HOSTS=true` to reach their
own private-network mail servers. Do not enable this on untrusted shared hosting.
STARTTLS-only servers are not supported in this first version.

## Connect a mailbox

1. Open the desired workspace, then **Settings → Mail → Connect mailbox**.
2. Enter a label, IMAP hostname, TLS port, mailbox username, and an app password.
3. Keep `INBOX` or supply its exact folder path. Leave Sent blank to detect the
   server's `\\Sent` folder, or enter its exact path.
4. Select **Import only**, or an AI user you manage. The AI user must be running
   with a direct model provider (including Ollama/OpenAI-compatible endpoints).
   Bridge-backed coding harnesses are intentionally not used for email triage.
5. Choose how much recent history to import per folder (default: last 50).
6. Connect. The card shows worker status, imported count, last successful sync,
   and a link to the generated mail page. Pause/resume, rotate the app password,
   or disconnect there. Host/folder/assistant changes currently use disconnect
   and reconnect; imported pages remain in the workspace.

The generated destination is restricted to its owner and selected AI user,
subject to Pear's normal workspace administrator access. Imported messages
inherit that access. Sharing the destination changes who can read its mail.

## Current behavior

- The worker checks enabled connections sequentially, waits 60 seconds after a
  sweep, and repeats. This is polling, not IMAP IDLE; slow model calls/backfills
  extend the interval. Each pass processes at most 10 messages per folder.
- Both Inbox and Sent are opened read-only; body fetches use IMAP's peek path.
  Mailbox read/unread flags, folders, and messages are not changed.
- UIDs and UIDVALIDITY are checkpointed in the workspace database. A checkpoint
  advances after an atomic page/body/receipt import; retries after a lost reply
  do not duplicate the import. Leases fence overlapping worker processes.
- Messages larger than 5 MiB produce a metadata-only record. Other bodies are
  reduced to plain text and capped at 40,000 characters. Attachments are omitted
  with a visible note. Remote images and links are not fetched.
- Optional AI triage produces a summary, priority, reply suggestion, and explicit
  commitments for each message. It uses the selected AI user's model, checks its
  monthly cap, and records usage. No action tools are supplied. An unavailable
  provider leaves the checkpoint pending for retry; malformed model output
  imports the message with a visible note instead of blocking the whole folder.
- These are **per-message suggestions**, not a complete thread-state tracker.
  Automatic follow-up scheduling, morning digests, task creation, sending,
  thread-level resolution, and mobile alerts remain follow-up work. Message-ID,
  In-Reply-To, and References are retained for that next slice.
- A UIDVALIDITY reset stops that connection with a visible status; reconnect
  explicitly to rebaseline recent mail. Folder moves/deletions and historical
  mailbox flags are not mirrored into Pear. Reconnecting creates a new mail page.

Workspace JSON exports include the imported pages but exclude live mailbox
connections, encryption keys, and receipts. Reconnect after a JSON restore.
Whole-database backups retain ciphertext and cursors and also need the original
worker key to resume monitoring.

## Verification

```sh
cd worker
pnpm run typecheck
node --import tsx/esm --test src/mail/*.test.ts
# Start a disposable local SpacetimeDB on 127.0.0.1:3096, then:
node --import tsx/esm scripts/mail-e2e.ts
```

The integration script only accepts localhost, publishes a uniquely named test
database from the built WASM, uses synthetic credentials and mail, and deletes
that database afterward. It exercises real reducer encoding, access isolation,
credential encryption, leases, duplicate imports, checkpoint ordering, pausing,
rotation, and disconnection.
