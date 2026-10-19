# Private reviewed instruction contract (S1c)

This staged store records exact instruction revisions and authenticated-owner
decisions. It is disconnected from prompt assembly, the mail runner and the
settings UI. It enables no model call or protected monitoring. See the
[storage contract](PROTECTED_MAIL_STORAGE.md) for source policy and ancestry,
and [Sentinel status](SENTINEL.md) for the remaining runtime gates.

## Scope and exact review

Each instruction belongs to one retained private mail collection and an opaque
instruction key of at most 128 ASCII bytes. Its fixed scope is `mail.summary`,
with format and scope version `1`. Collection ownership comes from stored state; callers cannot
choose an approver or destination owner. References bind the instruction ID,
revision and server-computed digest. All references are database-local; future
admission must also bind the authenticated workspace and transport.

Revisions retain at most 16 KiB of literal UTF-8 text without trimming,
normalization, HTML rendering or truncation. The owner review projection returns the complete
text, exact scope/reference, known source parents, origin and head generation.
No current mutable page or system prompt substitutes for those frozen bytes.
Digests and approval metadata are sensitive identifiers, not anonymization.

The private head, revision and decision tables are management records. Only
`my_protected_mail_instructions` exposes a review projection, and only to the
authenticated non-AI collection owner. Other humans, administrators, services,
either AI identity representation, authenticated human/AI hybrids and the
publisher receive no view rows or owner approval override. Raw publisher SQL
remains part of the trusted platform boundary.

## Drafts and retained ancestry

`draft_protected_mail_instruction` accepts a literal draft from the authenticated
owner. A new manual root has unknown provenance: authenticating the editor does
not prove that pasted text is original, safe or unrelated to other content.
There is no automatic promotion from page flags, mutable system prompts,
conversation answers, tool approvals or model claims such as `approved:true`.

`draft_protected_mail_instruction_from_derivation` is a publisher-only staging
adapter. It copies the exact stored body from a validated immutable S1b
derivation. The server resolves its complete source graph and retains the
derived source reference and all ancestors. Callers cannot substitute a body
or supply their own parent list.

Every edit retains the union of previously known ancestry and new source
inputs. Neither manual edits nor reversion can remove known parents.
Missing or inconsistent graph state fails rather than truncating ancestry.
New source-backed revisions, including manual edits with retained parents,
require every ancestor's current policy to allow owner storage. Instruction
approval never initializes, expands or overrides those source ceilings.

## Approval, edits and revocation

`approve_protected_mail_instruction` binds a decision to the exact current
revision, digest, scope/version and expected head generation. The server
derives the approver from the authenticated non-AI owner identity. Approval is
a scoped instruction decision; it grants no model disclosure, processor,
mailbox, storage, tool or external-effect permission.

Every edit appends an immutable revision, advances the head generation and
clears active approval in the same transaction. Identical text and reverting
to older bytes still create a draft requiring fresh approval.
`revoke_protected_mail_instruction` records a decision, advances the generation
and clears approval. A fresh owner decision may reapprove the current revision;
an old approval replay cannot do so. A new decision with a stale generation fails. Exact
historical event replay is effect-free: it cannot rewind a head or reactivate
an old approval. Reusing an event with changed arguments conflicts.

An active instruction decision is not an execution permit or proof that source
policy remains current. Future use must register the exact instruction
revision as a governed input, retain its parents, re-resolve current source
restrictions, default missing source policy to deny, and obtain independent
workflow authority and durable admission. It must recheck the current
head/decision generation and owner eligibility; a historical approved revision
can remain trackable data without being current instruction authority. No
runtime currently consumes these decisions.

Authentication establishes which owner credential submitted a decision. It
does not attest physical human presence or prove that a UI displayed the text.
The owner client and credential remain trusted; a reviewed human interface or
approved recipe is still required before protected runtime use. This slice
adds the decision substrate, not that interface.

## Isolation and verification

The owner projection is excluded from broad worker subscriptions, browser
export hydration and ordinary workspace snapshots. No instruction text or
decision is copied into ordinary pages, conversations or grant tables. The
existing private-collection restore fence remains in force. Disconnect retains
the collection and its owner management history. Protected backup/restore is
still required before a real-mail canary.

After building the module and regenerating both clients, run against a
disposable localhost SpacetimeDB 2.0.3 server:

```sh
cd worker
node --import tsx/esm scripts/protected-mail-instructions-e2e.ts http://127.0.0.1:3099
```

`PEAR_PROTECTED_MAIL_WASM` optionally selects the exact current artifact.
`PEAR_INSTRUCTION_BASELINE_WASM` adds a populated merged-S1b upgrade probe.
The harness uses only synthetic data, refuses non-local origins and deletes
its database in `finally`. It checks unchanged retained state, absent automatic
approval, private protocol boundaries, exact review, identity isolation,
edit/revoke/replay races, ancestry retention and ordinary export exclusions.
Cloud CI builds pinned pre-S1a, S1a, S1b and current modules in independent
target directories, rejects current/baseline identity and runs all three mail
harnesses. The release also tests its exact release WASM.
