# Subscription-auth CLI workers through Pear Bridge

Status: local implementation and mock tests, not deployed or enabled. No real CLI
login/status, model, paid API, credential-store or account-setting calls were made.
PR branch: feat/bridge-subscription-auth-guards. Earlier local review/routing work
is intentionally excluded from this standalone change.

## Audit findings

- providers.rs already launches official Claude Code via `claude -p` and Codex
  via `codex exec`.
- harness.rs supports resumable Claude CLI turns, both batch and streaming. Codex
  harness sessions currently require the separate opt-in ACP path.
- All those paths previously inherited daemon auth/provider environment/config.
  In particular, Claude print mode can select an inherited ANTHROPIC_API_KEY
  instead of the user's claude.ai login. `--bare` also skips subscription OAuth.
- Codex supports ChatGPT login, but custom provider/profile/base-URL configuration
  can change the execution route. CLI installation is not billing verification.
- ACP launches independently configured wrappers (npx defaults), not necessarily
  the same executable/configuration that an official CLI status probe checks.
- Subscription login does not prove extra usage/credits are disabled, nor expose
  reliable remaining monthly/rolling subscription capacity.

## Implemented device-local policy

New module: crates/pear-bridge/src/cli_auth.rs. It is used by one-shot Claude,
one-shot Codex, and batch/streaming native Claude harness launches.
ACP checks the same policy and refuses strict mode before spawning an adapter.

The policy is read from the Bridge process environment, NOT command payloads:

    PEAR_BRIDGE_CLI_AUTH_POLICY=subscription-only

Unset or `configured` preserves existing auth behavior (including API billing).
Any other value, including an empty/typo value, refuses CLI execution. This is
backward compatibility, not a claim that existing providers are subscription-only.
Existing daemon entry points/configuration were not changed to enable the policy.

Strict mode additionally requires:

    PEAR_BRIDGE_SUBSCRIPTION_EXTRA_USAGE_DISABLED=1

**This is an operator attestation, not a switch that disables provider billing.**
Only set it after actually disabling/confirming extra usage or credit spending for
both accounts used by this Bridge. The implementation cannot query those settings
or guarantee they remain unchanged. Never automatically set this flag for users.

The first strict checks reject known auth/gateway/cloud/bare environment overrides.
They do not silently unset keys or replace a user's deliberately selected auth.
Claude opaque OAuth environment tokens are also refused: this initial strict
profile accepts a CLI-managed claude.ai login, not externally supplied tokens.
Config homes remain local; HOME/CLAUDE_CONFIG_DIR/CODEX_HOME are preserved.

Before each actual CLI launch:
1. Snapshot the environment. The probe and execution child use the SAME snapshot.
2. Verify through bounded read-only `auth --help` / `login --help` that `status`
   exists. Do not guess an auth subcommand on an old CLI that might interpret it
   as a prompt or begin interactive login.
3. Run the official CLI's auth/status command in the same working directory.
   No prompt is supplied; stdin is null. Each preflight has a 10-second timeout,
   a 16 KiB limit per output stream and kill-on-drop. No raw output is logged,
   persisted, sent to Pear, streamed as a chunk, or included in an error.
4. Accept only the known subscription-auth response shape; unknown, malformed,
   oversized, failed or timed-out status refuses the inference/harness launch.

Two preflights can add up to 20 seconds before the existing inference timeout.
The limits apply to preflight capture, not to the existing inference-output
capture implementation. No login/logout/setup-token command is invoked.

## Claude launch controls

Strict probes and execution use explicit empty setting sources and settings that
disable hooks and pin forceLoginMethod=claudeai. Strict execution also uses an
empty, strict MCP config; inherited MCP tools are not loaded. No --bare flag.
Existing built-in tool and permission-mode arguments remain in force. This means
strict harness runs deliberately do not inherit user/project MCP or hooks.

The status response must have loggedIn=true, authMethod=claude.ai,
apiProvider=firstParty and subscriptionType=pro or max. Other account types or
unknown CLI schemas are refused until deliberately supported. Email/org and
other fields are discarded. The auth command does not get variadic --mcp-config,
which could otherwise swallow the auth/status subcommand words.

## Codex launch controls

Strict Codex uses the same config pins for status and exec:

    -c 'forced_login_method="chatgpt"' -c 'model_provider="openai"'

It checks bounded TOML configuration in CODEX_HOME (or HOME/.codex), project
.codex/config.toml ancestors, and known Unix system/managed/requirements paths.
Custom providers, profiles, base-URL/auth changes, malformed/unreadable/oversized
configs and conflicting forced-login settings are refused, even if unused.
Config contents/parser errors are never returned. Non-auth model/sandbox settings
remain supported. This inspection is intentionally conservative and is not a
complete replica of every future vendor-managed configuration layer.

Only the exact known `Logged in using ChatGPT` status is accepted. API keys,
access tokens, workload identities, unknown status formats and additional warnings
are not accepted as subscription proof. This does not identify a ChatGPT plan or
remaining capacity. Windows strict Codex inspection is explicitly unsupported
in this slice; configured mode remains unchanged.

Strict Codex currently covers one-shot `codex exec`, not resumable ACP sessions.
Both Claude and Codex ACP are blocked in strict mode because their separate
wrapper/SDK authentication configuration has not been verified.

## What this does NOT guarantee

- Not a provider invoice/extra-usage guarantee or quota meter. Local confirmation
  can be stale; provider behavior and account settings can change.
- Not an atomic lock on the CLI credential store between status and execution.
  The environment is pinned, but parallel logins/config/credential edits remain
  an operational risk. Do not change accounts while a task/session runs.
- Not an OS sandbox or a general spending guard for arbitrary Bash/MCP tools or
  separate tool-bash commands. Existing permissions and containment still matter.
- Not authentication enforcement against a malicious device owner, executable,
  launcher or modified official CLI. Device configuration is trusted.
- Not a new per-request billing contract: payload labels cannot enable this mode.
  Older daemons do not enforce the new environment policy; verify the deployed
  Bridge version rather than assuming the flag alone proves anything.
- Not an automatic source of Orcha BillingObservation records. Provider discovery
  still reports installed/available CLIs, not verified subscription billing.
  Routing billing/readiness remains unknown until the verification integration
  actually supplies trustworthy, fresh observations.

## Verification and next step

84 local tests passed, including 16 new guard tests (4 unit, 12 mock-CLI tests).
One existing real ACP test remained ignored. Tests cover accepted/unknown auth,
key/cloud/bare overrides, local confirmation, help/status existence, sanitized and
bounded failures, configuration overrides, repeated checks, batch/streaming,
ACP refusal and compatibility with configured/API mode.

    cargo test --offline -p pear-bridge --lib --test cli_auth_tests \
      --test providers_tests --test harness_tests

Next inspect the installed CLIs on the chosen device using harmless read-only
status commands, confirm account extra-usage settings locally, and explicitly
approve a bounded smoke test through an UPDATED Bridge with strict mode enabled.
Do not export raw login JSON, tokens or auth.json. No live test/rollout was done.

## Sources checked

- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://developers.openai.com/codex/auth/
- https://developers.openai.com/codex/config-basic
- Official Codex source: codex-rs/cli/src/login.rs and
  codex-rs/model-provider-info/src/lib.rs (OpenAI GitHub repository).

These describe provider interfaces, not a guarantee of installed-version behavior
or permission for every third-party integration. Credentials stay with official
user-owned CLIs; no SDK token proxy or hosted subscription login was introduced.
