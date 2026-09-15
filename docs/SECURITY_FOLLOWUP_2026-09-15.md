# Security follow-up — 15 September 2026

All five areas left open by the initial review now have local code changes and
regression coverage. **They have not been deployed.** Database migrations,
configuration, and a coordinated canary release remain necessary before these
protections can be treated as active in production.

## Changes

### 1. Attachments

New uploads reserve an immutable object ID and uploader before returning a
signed upload URL. The reservation stores the owning page or conversation.
Completion requires the original uploader; inventing a reference or completing
someone else's upload cannot claim it. Download, metadata, list and AI-reader
paths check the stored context against the reader's current, token-scoped page
or conversation access. Deletion requires the uploader.

Chat images now use the same authorized reader as files instead of fetching S3
objects directly. Page images, audio, files, database file cells and conversation
uploads send their context. Gateway and worker reads check authorization before
storage access, including after access revocation. Signed download URLs expire
after 60 seconds, bounding access through a previously issued link.

Migration 018 creates the reservation registry and makes existing objects
uploader-only. It does **not** infer authority from mutable attachment references.
The uploader can scope an unscoped legacy object once using
`PATCH /api/workspaces/{slug}/blobs/{objectId}` with
`{"resourceKind":"page","resourceId":"123"}` (or `conversation`). The target
must be accessible to that uploader; existing scope cannot be changed through
this endpoint.

Compatibility: previously shared unscoped files require this explicit scoping
before collaborators/AI can read them. Imported files whose recorded uploader
is a SpacetimeDB identity need a trusted operator to map ownership/context;
do not bulk-trust references created while the earlier flaw existed. Trusted
worker registration accepts an optional resource scope. Worker deployments
without lifecycle authorization now deny blob reads instead of falling back
to arbitrary storage keys. These restrictions are deliberate, not a silent
promise of backward-compatible sharing.

### 2. Token trust and revocation

The public lifecycle gate no longer exempts tokens based on their JWT algorithm.
It accepts verified OIDC credentials with current workspace membership, exact
matches to active workspace-scoped stored AI/MCP credentials, or the existing
workspace-specific service-token path. Native AI/MCP credentials also require
their creator's current membership; revoked MCP grants are excluded.

The browser's temporary WebSocket exchange records only a token hash and its
verified principal in Postgres. Tickets are workspace-bound, single-use and
expire after 30 seconds. Membership/grant validity is checked again on use and
every 30 seconds while the socket is open. The browser does not fall back to a
cached native token while OIDC refresh is pending. Manually provisioned native
credentials absent from the lifecycle registry must be enrolled or replaced
with an approved OAuth grant; an algorithm label cannot restore access.

The module additionally requires an explicit publisher-configured OIDC issuer
and audience before email/name claims can authenticate a new user. Lifecycle
requires `OIDC_EXPECTED_AUDIENCE` when workspace OIDC is enabled and configures
the module's trust policy on publish/upgrade. Missing configuration fails closed.

### 3. Operational data

Caller-scoped views protect automation definitions/actions, event payloads,
run logs and review annotations. Automation execution data is visible to its
effective principal or an authenticated administrator, with page checks for
page-associated events. Review visibility follows the snapshot's page access.
Only the actual reviewing AI (with page access) or publisher may record that
AI's annotation. Anonymous automation creation is rejected.

### 4. DNS rebinding

Outbound guarded fetches use an Undici dispatcher with a socket lookup that
validates and returns the exact addresses the connection uses. A second DNS
lookup can no longer switch the socket to a private address after preflight.
Each redirect is still checked; TLS verifies the original hostname. IPv6
transition/special-use ranges are denied conservatively.

### 5. Credential storage and native passwords

Hosted AI identity tokens use versioned AES-256-GCM envelopes with the existing
`API_TOKEN_ENCRYPTION_KEY`. The runtime refuses plaintext rows. The new
`encrypt_ai_tokens` operator binary converts old rows transactionally, validates
already-encrypted rows, and installs a database constraint preventing older
binaries from writing plaintext again. Old backups still need the existing
encrypted-backup controls; changing live rows does not erase historical copies.

Native passwords use a unique per-record salt and PBKDF2-HMAC-SHA256 with
600,000 rounds around the previous digest. This permits hardening old records
without obtaining plaintext passwords. Successful legacy logins also upgrade
their record. Native login permits ten failed attempts per account per
15-minute window; failures commit the counter and a caller-only `login_result`
row rather than returning an error that would roll the counter back. The login
UI displays that result. New passwords require 12–1024 bytes.

The work factor follows [OWASP's password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Validation

- Fresh localhost module: **117 live security checks passed**.
- In-place beta.35 → patched beta.36: **120 checks passed**, including preserving
  jobs, converting legacy password records and logging in afterward.
- Module Rust unit tests: **46 passed**.
- Worker suite and identifier check: **262 passed**.
- Lifecycle unit/integration suite: **90 passed**, two opt-in tests skipped in
  the ordinary run. The new Postgres test was then run explicitly and passed.
- Postgres credential/ticket test covers exact credential matching, foreign
  workspace rejection, replay, expiration and membership revocation.
- Real disposable Postgres migration test: SQL migrations 017/018 applied,
  legacy attachment ownership preserved, one token encrypted, second encryption
  run changed zero rows, and attempted plaintext downgrade rejected.
- Gateway suite: **11 passed**; gateway TypeScript check passed.
- Web attachment/transport/export tests: **31 passed**; cloud web TypeScript
  check passed.
- Full worker TypeScript compilation still reports existing cross-package
  `rootDir`/SDK/type issues; the project's supported identifier check and full
  runtime test suite pass. This is not a claim that full worker `tsc` is clean.

## Coordinated rollout

1. Take and verify the normal encrypted backups. Apply cloud SQL migrations
   `017_workspace_socket_tickets.sql` and `018_blob_access_bindings.sql`.
2. Confirm the correct OIDC issuer/audience and existing encryption key are
   present on lifecycle. Do not generate a replacement encryption key blindly:
   existing service/grant ciphertexts depend on it.
3. Coordinate AI-management traffic and worker restart while running
   `cargo run --release --bin encrypt_ai_tokens` against the intended Postgres
   database. Old lifecycle readers cannot use the new envelope as a token;
   old writers will correctly fail the new constraint. Immediately switch to
   the matching lifecycle binary. Test a canary before the wider fleet.
4. Publish the patched beta.36 module with the established `pre_publish` /
   `BreakClients` flow, without clearing data. Lifecycle sets OIDC trust and
   hardens legacy native passwords in batches before stamping a workspace
   current. For standalone/manual publishing, call `harden_local_passwords(10)`
   as publisher until all private credential rows have the versioned prefix.
   Configure `set_oidc_trust_policy(issuer,audience)` if OIDC is used. Restore
   targets also need this private trust policy configured before serving OIDC
   users; it is intentionally excluded from portable snapshots.
5. Activate matching generated bindings, web, gateway and worker builds. All
   new permission views must exist before HTTP clients begin querying them.
6. Verify browser OIDC login/reconnect, member removal, MCP consent/revocation,
   normal AI turns and delegation, automation runs, native login failure and
   success, upload/complete/read/delete, private conversation images, and
   inherited page-access revocation in the canary.
7. Scope legacy attachments through verified ownership or a reviewed operator
   migration. Until then, keep them restricted. Do not restore workspace-wide
   blob access as a workaround.

No production database, credentials, deployment or ticket status was changed by
this follow-up. Production canary results, legacy attachment ownership mapping,
and fleet rollout are operational work still outstanding. This targeted work
does not certify the entire codebase or infrastructure free of vulnerabilities.
