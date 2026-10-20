# Private reviewed instruction and source contract (S1c/S2b1)

This staged store records exact instruction revisions and authenticated-owner
decisions. S2b1 also makes exact retained revisions available as governed source
references through explicit policy initialization. It is disconnected from prompt assembly, the mail runner and the
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

## Governed instruction sources (S2b1)

An exact instruction reference is also its source reference: instruction head
ID, immutable edit revision and content digest. Resolution validates the frozen
revision, collection, literal content and complete stored parents. It does not
require the revision to remain current, approved or backed by an active policy;
old inputs must remain trackable after edits, revocation, logout or disconnect.
There are no new tables, body copies, public views or automatic enrollments.

The publisher enrolls a revision with the existing
`initialize_protected_mail_source_policy` reducer. A **first** initialization
requires the exact current checked revision and an authenticated non-AI human
owner. Draft, approved and revoked decisions remain distinct from this data
ceiling. A historical revision with no policy cannot be enrolled after a later
edit. Exact initialization retries of already enrolled historical revisions
remain effect-free and cannot reset a narrowed or revoked ceiling.

Every new edit retains the previous instruction reference when that revision
has an enrolled policy, along with all previously known parents and any new
derivation ancestry. Intermediate unenrolled edits retain that floor. Thus
initialization before an edit makes the edit inherit it; initialization after
an edit rejects the old revision. Database transactions serialize both orders.
Current restrictions on every ancestor apply, including restrictions narrowed
after the child was drafted or enrolled. New enrollment cannot exceed that
intersection; denied owner storage or revocation prevents a new descendant.
The existing 256-source and depth-32 limits include the new instruction
revision itself. A failed wrapper check rolls back the new revision, head and
approval clearing atomically, without dropping links.

Exposure registration can retain a reference with missing or revoked policy
for conservative bookkeeping. It grants no processing permission: derivation
and future admission must re-resolve current policies. Approval/reapproval
cannot widen a ceiling. Manual text under a fresh instruction key still has
unknown provenance; this mechanism does not prove token lineage or detect
manual copies between unrelated keys.

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
policy remains current. Future use must include the exact governed instruction
revision and its parents, re-resolve current source
restrictions, default missing source policy to deny, and obtain independent
workflow authority and durable admission. It must recheck the current
head/decision generation and owner eligibility; a historical approved revision
can remain trackable data without being current instruction authority.
[Local summary admission](PROTECTED_MAIL_ADMISSION.md) now performs this binding
for an already-staged artifact. [Fixed inference](PROTECTED_MAIL_INFERENCE.md)
also binds the exact current decision and uses its literal body as the fixed
request system instruction. No general prompt builder or mail runtime consumes
either path.

Authentication establishes which owner credential submitted a decision. It
does not attest physical human presence or prove that a UI displayed the text.
The owner client and credential remain trusted; a reviewed human interface or
approved recipe is still required before protected runtime use. This slice
adds the decision substrate, not that interface.

## Isolation and verification

The owner projection is excluded from broad worker subscriptions, browser
export hydration and ordinary workspace snapshots. No instruction text or
decision is copied into ordinary pages, conversations or grant tables. The
private-state restore fence remains in force, including processor-only state
from [S2a](PROTECTED_MAIL_AUTHORITY.md). Disconnect retains
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
Alternatively, `PEAR_INSTRUCTION_INPUT_BASELINE_WASM` seeds populated merged-S2a
instruction decisions, epochs and processor history before upgrading. Do not
set both baseline options. The latter compares all 17 private tables and owner
views without enrolling instruction policies automatically.
The harness uses only synthetic data and refuses non-local origins. Normal
runs delete their database in `finally`; owned disk-backed runs use the
[authority fixture lifecycle](PROTECTED_MAIL_AUTHORITY.md) and remove retained
synthetic databases with the whole disposable server. It checks unchanged retained state, absent automatic
approval, private protocol boundaries, exact review, identity isolation,
edit/revoke/replay and enrollment/edit races, inherited instruction ceilings,
current-only first enrollment, ancestry bounds and ordinary export exclusions.
Cloud CI builds pinned pre-S1a, S1a, S1b, S1c, S2a and current modules in independent
target directories, rejects current/baseline identity and runs all four mail
harnesses, including retained authority/configuration restart verification. The release also tests its exact release WASM.
