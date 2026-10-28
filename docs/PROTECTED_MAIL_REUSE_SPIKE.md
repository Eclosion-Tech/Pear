# Mail library reuse experiments

**Date:** 2026-10-24. Experimental evidence only; no runtime or authority change.

These explicitly invoked scripts examine the versions already installed by the
workspace lockfile. They use synthetic content and private loopback TLS fixtures;
no real mailbox, workspace, provider or production credential is accessed.

```bash
pnpm --dir worker exec node --import tsx/esm scripts/protected-mail-imap-reuse-spike.ts
pnpm --dir worker exec node --import tsx/esm scripts/protected-mail-mime-reuse-spike.ts
```

Run from the Pear root. Output is fixed case/status/counter metadata. Raw MIME,
headers, subjects, attachment names, passwords, authentication frames, transcripts
and body digests must not be printed. Expected unsafe/default behavior is captured
as a limitation, not silently treated as production conformance.

The installed ImapFlow parser already supplies size controls and a public custom
transport. The experiment compares automatic setup/retry behavior, exact UID
fetching, parser limits and transport-owned totals/deadlines with the current
protected profile. Passing library probes does not authorize its automatic
commands under existing frozen grants.

The MailParser experiment separates raw/structure/output rejection, attachment
discard and parent-controlled worker termination. Streaming attachment handling
does not mean streaming text or complete memory isolation. Parsing does not
sanitize HTML, remove authentication secrets or establish instruction authority.

The pinned probe matrix contains 18 ImapFlow cases and 26 MailParser/mailsplit
cases. It confirms reusable parsing/transport controls and records important
gaps: automatic IMAP setup/keepalive commands and throttle retries, convenience
FETCH duplicate merging, assembled MIME text before output rejection, tolerant
malformed MIME, and preserved authentication secrets/injected instructions.
The outbound second-FETCH veto is a pinned-writer experiment, not a general
command firewall. Worker controls are not OS isolation or external-Buffer bounds.

MailParser is upstream maintenance-mode software with security/critical fixes;
its maintainers recommend PostalMime for new projects. These probes establish
feasibility for the existing dependency and preserve a bounded corpus for engine
selection. They do not add or select a new production dependency.

The next integration needs two small explicit seams: bounded internal MIME
custody before c4 finishes the read, and an authenticated owner projection of
existing accepted result rows. A completed public executor cannot feed c4;
c7/c8 sparse IDs cannot masquerade as old StoredBatch reads. First prove a
truthful synthetic composition with existing contracts, then design any sparse
or recurring extension explicitly.

Existing Rust/WASM, all 61 private tables, generated clients, production mail
code and dependencies remain unchanged. Current [read](PROTECTED_MAIL_READ.md),
[ingestion](PROTECTED_MAIL_INGESTION.md), [sparse read](PROTECTED_MAIL_SPARSE_READ.md)
and [sparse executor](PROTECTED_MAIL_SPARSE_EXECUTOR.md) boundaries still apply.
Monitoring remains disabled.

Independent controller verification completed all 44 cases (18 IMAP, 26 MIME),
strict TypeScript and worker syntax checks, with clean temporary sockets,
certificates and workers. Production source/schema/dependencies and the release
module were verified unchanged. See the companion host review for the concrete
composition and migration plan; these scripts alone install no adapter.
