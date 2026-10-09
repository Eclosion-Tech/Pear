# System One routing alongside Orcha

Status: advisory-only routing foundation, HTTP adapters, scoped discovery and
opt-in Orcha observer. Disabled in existing entry points; this change makes no
deployment, live classifier requests, execution assignment or grant changes.
Separate Bridge rollouts demonstrated bounded Claude/Codex execution under strict
auth guards and operator spending attestations. Those historical smoke tests do
not create fresh, identity/config-bound routing billing/readiness observations.

## Goal and ownership

One interface should make useful use of a user's subscription-backed Claude
Code and Codex workers. Route bounded work, not every conversation token. Keep
execution/session/results in Pear's existing infrastructure. Pi and other clients
consume that interface rather than owning another scheduler.

Shared contracts, eligibility rules and classifier adapters belong in OSS Pear.
Hosted credential storage, deployment and hosted consent wiring belong in the
hosting application. No hosted URLs or workspace-specific assumptions in defaults.

## Implemented foundation

worker/src/routing.ts provides ExecutionProfile, RoutingTask, RoutingPolicy,
eligibleProfiles, SystemOneClient and recommendRoute. The policy module has no
execution dependency or default network transport. DatabaseWorker can explicitly
opt into the observer described below; existing entry points do not do so.
No new package dependency was added. Existing test discovery includes the tests.

Trusted configuration supplies identity-scoped approved profile IDs, billing
attestations, grants and fresh observations. Subscription-only eligibility rejects
API billing, unknown/unverified billing and subscription tags on non-CLI backends.
A pinned session cannot silently switch to another profile. These are filters of
trusted observations, not implementations of CLI billing/usage discovery.

recommendRoute returns blocked, unavailable or advised. The default is disabled.
An explicitly supplied client gets exactly one call, only after destination,
separate hosted-spend consent and UTF-8 request size checks. Timeouts/cancellation
abort that call and settle locally even if the adapter ignores abort. This is not
a guarantee that upstream processing or billing stopped; no retry is issued.

The request contains approved task context, artifact flags and eligible candidate
descriptors mapped to ephemeral choice tokens. Principal IDs, job IDs, context
fingerprints and extra profile fields are not forwarded. Frozen request trees
prevent mutation of validation criteria. Responses require a model identifier,
valid choices and complete finite probability distributions. Advice retains copied
probabilities (not presumed calibrated), a snapshot/context/policy fingerprint and
model provenance. Worker config/permission payloads are never returned as advice.

The questions are candidate recommendation, activity (including other), readiness
and difficulty. These are a new production-oriented contract, not an exact replay
of the three-question coding benchmark; candidate preference quality is untested.

Implementing a client does not by itself enable routing: callers still need to
assemble authenticated inputs and opt in. Runtime execution must separately
confirm and reauthorize recommendations. Hosted adapters must enforce actual
configured destinations, privacy and budgets; the injected interface is not a
network sandbox or an account-wide spending counter.

## Adapters, discovery and observer

worker/src/system-one.ts exports createJevAdvisor and createNimbleAdvisor.
Both require an explicit endpoint, model, consent, bounds and finite maxCalls
attempt budget. Consent destinations match the exact canonical endpoint URL, not
just its hostname. Jev requires an explicit key and HTTPS; Nimble allows HTTP
only on explicitly approved loopback (e.g. an operator-created SSH tunnel).
No environment credentials, default URLs, redirects, retries or fallback.

Request bytes include the model field. Responses are stream-bounded, not read
unbounded into memory. HTTP/network failures do not echo upstream bodies or keys.
An attempt consumes the instance's budget even if it fails. Reuse the adapter to
preserve that budget; constructing another instance resets it. This is not a
monthly/account-wide or dollar budget. Hosts must enforce those separately.

worker/src/routing-discovery.ts reads the authenticated AI-user subscription cache:
- exact ai_user_config ID AND identity must match the requested scope;
- grants are filtered by ai_user_identity even if other rows are readable;
- absent grant tables do not expose workspace-wide devices;
- revoked/ungranted devices, unknown or duplicate provider reports are excluded;
- dormant cloud configuration behind a Bridge binding is not a candidate;
- only known advertised providers are described, with source detection timestamps;
- reading the cache never creates a fresh health/auth observation.

IDs are bridge_<device>_<provider> or configured_<AI user>. CLI/Ollama billing
remains unknown until a trusted BillingObservation matches identity, profile ID,
configuration fingerprint and freshness. Source versions, reports, advertised
model lists and active model/binding changes invalidate the observation. The
fingerprint is not a credential and is not forwarded to the model.

Current database rows do not establish subscription billing or extra-usage state.
Billing observations must come from an explicit trusted probe/host process.
BRIDGE_ROUTING_PREFLIGHT.md documents the new prompt-free native CLI producer and
optional Orcha collector. It verifies guard enforcement and login, retains the
operator-attested nature of extra-usage settings, and is disabled in entry points.
SUBSCRIPTION_CLI_GUARDS.md documents the separately merged launch guard. Direct API configs have unknown health. Active
harness bindings have unknown adapter readiness: inference advertisements do not
prove ACP or safe execution profiles. "llm"/"chat" here describe basic inference,
not repo-editing authority or full Pear tool support. Dedicated packet review is
described only when its dedicated claude-review provider is actually advertised.

worker/src/orcha-routing.ts exports observeOrchaPlan and OrchaAdvisoryHook.
DatabaseWorkerOptions.routingAdvisory is the opt-in injection point. Both normal
and fallback planning paths call it after serializing the final graph and before
publication. No claim, binding, permission or execution payload changes. It uses
only the job's own AI-user connection; missing workers never fall back to admin.

The host's prepare callback gets immutable plan metadata and discovered profile
references, NEVER worker keys. It must explicitly approve summary/artifact flags,
policy, candidate IDs and classifier consent for that task; returning undefined
means skip. The full page context is not automatically sent to the classifier.
Default limit is one entry per plan, maximum five. This is not a job-wide budget.

Advice is delivered through the host's onAdvice sink with a plan fingerprint,
parent orchestration ID and plan-local index. No new tasks' durable IDs exist at
this point. No default public-table persistence or UI was added. The host must
use an authorized destination for advice. Sink/config/classifier failures leave
the serialized executable graph unchanged; async sink failures are handled without
waiting or retries. An opted-in classifier can add bounded planning latency.

## Existing path, traced in source

1. worker/src/tools.ts, executeTool("delegate"): creates an Orcha job with an
   initial orchestrate task, a client nonce and the originating AI user/context.
2. worker/src/database-worker.ts, isClaimable/checkAndClaim/claimAndExecute:
   workers independently attempt to claim tasks whose capabilities they satisfy
   and whose dependencies are done. There is no central model-backed assignment.
3. server/spacetimedb/src/orcha.rs, claim_task: requires worker authority,
   verifies no current assignee, dependency completion, capability match and the
   configured AI-user monthly token cap; records the claiming agent atomically.
4. DatabaseWorker.handleOrchestrate resolves the job's configured provider,
   invokes llm.ts planTasks, applies depth/capability repairs and persists the
   new graph through addTasksToJob.
5. Ordinary llm execution resolves that same AI user's current provider and
   executes tools on its identity-scoped connection. Existing job-routing tests
   require failures instead of falling back to environment credentials/admin
   tool authority when an AI-attributed job's provider/connection is unavailable.
6. worker/src/providers.ts and bridge-inference.ts already support configured
   device inference/harness bindings. Bridge enqueue reducers check grants;
   device harness adapters execute the actual CLI sessions.

**An Orcha agent is not a CLI backend.** Today the DatabaseWorker is the agent;
Claude/Codex/Ollama are inference or execution transports behind bindings.
Subscription worker choices must not be fabricated by treating each advertised
Bridge provider as an independently claimable Orcha agent.

## Smallest integration boundary

First hook: in handleOrchestrate, AFTER a valid final task graph is prepared and
BEFORE addTasksToJob publishes it. Evaluate a bounded task against a trusted
catalog of authorized execution profiles. Initial operation is opt-in advisory:
return/persist a recommendation without changing existing task type, required
capabilities, provider binding or assignee. Explicitly submitted non-orchestrate
jobs need an equivalent admission hook later; this first hook is not universal.

A second, later boundary applies a confirmed task-scoped route immediately before
execution. It must use the same originating principal/AI user, not another AI
user's credentials. The claim reducer and Bridge enqueue remain authoritative.

Do NOT insert network classifier calls into claim_task: it is an atomic server
reducer. Do NOT query a classifier in every competing worker's claim loop: that
would duplicate spend and introduce races.

System One returns typed decisions, not a newly generated task graph. Keep
planTasks for decomposition initially. A later classify-before-planning fast
path could avoid unnecessary planning calls, but needs a separately evaluated
"needs decomposition" rubric; our coding benchmark does not establish that.

## Shared contract and future runtime integration

The modules implement the in-process advisory/discovery contract described above.
Native chat preflight evidence is now available through the explicit collector
in BRIDGE_ROUTING_PREFLIGHT.md, but provider billing/remaining quota and harness
readiness remain unverified. Live hosting wiring, durable execution routes,
external API endpoints, UI, deployment and execution confirmation remain future work.

Trusted input assembled from authenticated context:
- schema/policy version; job/task identity; origin and task/context fingerprint;
- bounded task summary plus actual artifact availability (repo, diff, logs);
- required capabilities, execution profile and permitted data destinations;
- worker billing policy: subscription-only unless API workers explicitly allowed;
- caller-approved candidate profile IDs, available adapter capabilities, grant
  state and fresh connection status;
- session affinity and known capacity state, with unknown represented honestly.

A profile is a trusted configuration reference, not model-authored argv, cwd,
permission mode, credentials or a free-form provider binding.

Pipeline:
1. Code filters profiles by identity, grant, permitted capabilities/profile,
   destination, billing policy and availability.
2. No eligible profiles => explain blocked state; do not degrade capabilities.
3. Jev or Nimble may classify activity/difficulty and recommend an eligible opaque
   profile ID. Readiness is advice, never an authorization or mandatory stop.
4. Validate every returned label, finite probability/distribution and candidate
   ID against the exact request; do not assume confidence is calibrated.
5. Return versioned advice with source/model revision, candidate snapshot,
   task/context fingerprint and unresolved questions. Keep model advice separate
   from human confirmation and executable configuration.
6. Before execution, recheck permissions, availability, route freshness and
   confirmation; admission-time checks alone are not sufficient.

Classifier adapter contract: injected SystemOneClient; explicit endpoint/model,
bounded request, timeout/abort, response validation. No default hosted endpoint,
inherited cloud key, redirect, automatic retry or provider fallback. Only send
caller-approved context. Never send worker credentials to the classifier.

Hosted classifier spending is separate from worker spending: choosing
subscription-only workers does not authorize Jev calls. Jev requires its own
explicit opt-in/credential/budget; a local Nimble adapter is interchangeable.

Initial advice must not be a bypass channel to enqueue arbitrary CLI work.
Persist only approved metadata on a caller-visible authorized surface; existing
shared-context tables are not automatically a private credential store. Binding
advice to actual new task IDs needs a deliberate schema/reducer contract; a
planner-local index is not a durable task identifier across retries/replanning.

## Existing behavior that must not become routing fallback

handleOrchestrate currently coerces tasks with unavailable capabilities to llm.
llm.ts validateTaskSpecs also coerces unknown task types to llm. Those are legacy
planner repairs, NOT permission or spending policy. A routed subscription-only
profile cannot pass through either repair as an implicit cloud-capable llm task.
Initially leave those paths unchanged; before enforcing routed execution add a
validated typed route envelope and explicit blocked outcomes for unsupported
profiles/capabilities. Do not introduce new CLI task strings into the legacy
planner coercion pipeline and assume they survive.

The server's configured monthly AI token cap is not the subscription's remaining
capacity. CLI login alone is also not proof a run cannot incur API/extra-usage
charges. Verify the supported authentication mode and billing configuration;
unknown capacity/billing state must stay unknown, not inferred from a plan name.

Pin a task/session's route once execution begins. A timeout is not proof the
worker stopped. Do not switch workers after possible edits without reconciling
execution state, edits and explicit approval. Reuse existing command correlation
and results; do not build another job queue. Cancellation must mean actual worker
cancellation, not merely stopped polling.

## Suggested implementation sequence

1. DONE: pure shared routing contract/eligibility tests and interchangeable
   mockable classifier interface. No runtime wiring or network calls by default.
2. DONE locally: adapters, scoped discovery and opt-in advisory hook with explicit
   context approval, observable advice and provenance. Existing execution retained;
   no entry point enables it and no live model/worker run was made.
3. Separate rollout demonstrated bounded direct Claude and Codex CLI runs with
   strict authentication guards and operator-confirmed spending settings. Now
   available locally: a prompt-free observation producer tied to exact identity,
   configuration and native chat profile (BRIDGE_ROUTING_PREFLIGHT.md). Live host
   wiring and deployment remain separate. This is not independent invoice/remaining
   quota verification, nor evidence of ACP/harness readiness.
4. Add durable task-scoped profiles plus reducer/worker enforcement, idempotency
   and explicit backend confirmation. Enforce before automatically selecting.
5. Evaluate real tasks before tuning candidate preferences, uncertainty thresholds
   or enabling any unattended policy. Synthetic work-type/difficulty agreement
   does not establish which CLI produces better work.

## Local verification

Routing foundation plus existing guardrail/compatibility tests executed
successfully (134 tests total: 102 routing-related, 32 existing compatibility).
Strict isolated TypeScript checking of foundation and HTTP adapter files passed.
Worker undefined-name checks passed. Full worker typechecking still reports
existing SDK/generated-binding/cross-package errors; a compiler-API before/after
comparison (original DatabaseWorker, excluding new module roots) found 1,903
diagnostics in both versions and no newly introduced diagnostics:

    cd worker
    node --import tsx/esm --test src/routing.test.ts src/system-one.test.ts \
      src/routing-discovery.test.ts src/orcha-routing.test.ts src/job-routing.test.ts \
      src/planner-validate.test.ts src/bridge-inference.test.ts
    ./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 \
      --module NodeNext --moduleResolution NodeNext src/routing.ts src/routing.test.ts \
      src/system-one.ts src/system-one.test.ts
    npm run typecheck:names

These are mocked/local foundation and compatibility tests, not live classifier,
subscription billing or deployment validation. The 134 tests and compiler checks
were rerun in an isolated worktree based on current main (fc009af), with the same
1,903 baseline/after diagnostics and no additional diagnostics. This PR is on
feat/orcha-routing-advisory; earlier review work and unrelated editor, hosting and
incident-document changes remain untouched outside this isolated worktree.
