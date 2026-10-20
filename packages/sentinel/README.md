# Sentinel contracts

`@eclosion-tech/sentinel` is a dependency-free TypeScript package for the first
fixed mail workflow. It exports strict operation/snapshot validators, a pure
eligibility check, and canonical operation fingerprints. It uses Web Crypto
without Node-specific runtime imports.

`prepareOperation(proposal, serializedPayloadBytes)` makes a private copy of
the operation and the exact outgoing bytes before awaiting hashing. It rejects
a mismatched byte count or digest, deep-freezes the copied operation, and
returns fresh payload copies on request. Supply the complete serialized request,
including prompts and metadata; supplying only email text does not bind the
eventual provider request. `mail.read` has no outgoing payload argument.
The trusted adapter must construct a fixed request whose model, token limit,
tools and metadata agree with the operation. Preparation checks bytes, not the
meaning of a provider body. Bound payload size before calling it. Headers,
credentials, DNS and redirects remain separate adapter constraints.

The supported operations are `mail.read`, `content.screen`, `model.infer` for
mail summaries, and `mail.append`. Unknown operations and extra fields are
rejected. The policy checks exact scope, epoch, activation/expiry, mailbox,
processor revision, private destination, resource limits, and restrictions on
every exposed source revision and its transitive parents. Screening can hold
work; a clean verdict cannot grant permission.

```ts
import { evaluateEligibility } from '@eclosion-tech/sentinel';

const decision = evaluateEligibility(hostOwnedSnapshot, proposedOperation);
// { status: 'denied', reason: <fixed code> }
// or { status: 'eligible', requiresAdmission: true }
```

**Eligibility is not authorization to execute.** This package authenticates no
caller, reserves no budget, persists no state, mints no capability, and performs
no dispatch. Its inputs must come from a trusted host adapter; model output
cannot supply grants, exposure records, remaining budgets, clocks, or screening
state. Pass ordinary parsed JSON data, not executable objects or proxies.

The host must compute `payloadDigest` from frozen request bytes. Operation
fingerprints cover only the operation; a future admission also has to bind its
current grant, authority, source revisions, budgets, expiry, and replay state.
Preparation is neither eligibility nor admission. Its action fingerprint stays
the same if a grant is revoked or a source policy changes; fresh host state must
still be checked at admission and dispatch. IMAP selection/cursor bindings also
belong in the future admission envelope rather than this action hash alone.
`FrozenOperation` is a structural host interface, not an authenticated token.
Never accept a prepared object from a model or client; keep it in trusted code
and send its verified payload unchanged.
Exact HTTPS endpoint matching does not enforce TLS, DNS, redirects, credentials,
or network isolation. Those checks belong to the constrained dispatcher.

`canonicalAppendPayload` and `prepareMailAppend` define the closed local summary
envelope: literal body, contract version, kind, complete source closure including
the exact staged source, sanitization version and stage reference. References
use decimal u64 revision strings and sort by UTF-8 ID/numeric revision. The
builder measures and hashes the complete canonical UTF-8 envelope, constructs
the existing `mail.append` operation, and freezes it with `prepareOperation`.
It does not verify that an asserted closure is complete or that a model used an
instruction. The [local promotion reducer](../../docs/PROTECTED_MAIL_ADMISSION.md)
accepts identifiers only and independently reconstructs the envelope from
stored state before checking current authority and consuming its shared budget.
The portable helper itself still authenticates no caller and grants no permit.

`canonicalInferencePayload` and `prepareMailInference` define
the closed Anthropic Messages recipe documented in the
[inference contract](../../docs/PROTECTED_MAIL_INFERENCE.md). Full request bytes
include the literal approved system instruction and canonical mail JSON string,
with no tools/history/options. The server independently constructs those bytes
from stored inputs; portable preparation grants no disclosure permission.
`inferenceGrantId` computes the owner/collection-scoped ID for an issuance
nonce. The server derives it independently from the authenticated owner;
supplying an ID does not authenticate that owner or issue a grant.

No production mail runtime imports this package yet. It does not change existing
mail or assistant permissions. Public research and arbitrary tools remain
outside this contract. See [the implementation status](../../docs/SENTINEL.md).

Run `pnpm --filter @eclosion-tech/sentinel test` from the Pear root. Tests use
synthetic values and make no network, classifier, provider, or mailbox calls.
The containment harness in `test/support/` observes synthetic sink destinations
and bytes using an in-memory test authority. It is not exported as a runtime,
durable store, credential broker, or network boundary.
