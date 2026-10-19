# Sentinel contracts

`@eclosion-tech/sentinel` is a dependency-free TypeScript package for the first
fixed mail workflow. It exports strict operation/snapshot validators, a pure
eligibility check, and canonical operation fingerprints. It uses Web Crypto
without Node-specific runtime imports.

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
Exact HTTPS endpoint matching does not enforce TLS, DNS, redirects, credentials,
or network isolation. Those checks belong to the constrained dispatcher.

No production runtime imports this package yet. It does not change existing
mail or assistant permissions. Public research and arbitrary tools remain
outside this contract. See [the implementation status](../../docs/SENTINEL.md).

Run `pnpm --filter @eclosion-tech/sentinel test` from the Pear root. Tests use
synthetic values and make no network, classifier, provider, or mailbox calls.
