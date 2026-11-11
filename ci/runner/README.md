# Pear CI on the Forgejo mirror

Codeberg remains the source repository for commits and pull requests. Its push
mirror sends branch commits to `https://forge.syntropy.chat/Eclosion-Tech/Pear`.
Forgejo runs `.forgejo/workflows/pear-ci.yml` on the existing `synops` runner;
no Codeberg runner or separate Pear machine is needed.

## Mirror setup

1. Keep Codeberg's push mirror pointed at
   `https://forge.syntropy.chat/Eclosion-Tech/Pear.git` with sync on commit
   enabled and SSH authentication disabled. Use the Forgejo username and a
   separate mirror token with repository write access in the password field.
   This token is distinct from Cloud's read-only CI evidence token below.
   HTTPS uses port 443; port 2222 is restricted to operator IPs by the hosting
   firewall and Codeberg's SSH mirror connections time out there.
2. Enable Actions on the Forgejo Pear repository and ensure the existing
   `synops` runner is available to it. Do not add deployment secrets to Pear.
3. Sync the mirror and compare the Codeberg commit with Forgejo's branch SHA.
   Inspect both `unit` and `protected-mail` jobs on Forgejo. The existing runner
   supplies Docker access and loopback networking for disposable mail fixtures.
   Its single-slot queue is shared with Cloud; this moves ownership and avoids
   repeated source checks for Cloud pins, but does not add compute capacity.

Branch pushes and manual dispatches trigger Pear CI. Pull requests, approvals,
and status checks do not mirror. Same-repository Codeberg PR branches can get
Forgejo push runs; fork-only branches require a reviewed branch in the source
repository before they reach this runner. Consult the Forgejo run for the exact
commit; this setup does not post statuses back to Codeberg.

A manual `pear-ci.yml` dispatch forces full mail conformance. Record the exact
commit and successful run URL, then repeat a full run to verify warm cache hits.
If Actions was enabled after a push, dispatch on the mirrored branch manually.
Do not make source edits directly in the destination; the push mirror owns its
Git refs. Runner registrations and instance settings are managed on Forgejo.

## Cloud cutover

Cloud's `verify-pear-ci.mjs` checks the latest matching `pear-ci.yml` run on
`Eclosion-Tech/Pear` at `forge.syntropy.chat` for its exact Codeberg Pear pin.
Its `PEAR_CI_READ_TOKEN` secret authenticates API requests with only
`public-only,read:repository` scope (Forgejo 12 groups Actions reads under
repository access; it has no separate `read:actions` scope). Automatic job tokens
cannot read another repository's CI. No manually posted status substitutes for
run evidence. Missing, unavailable, pending, failed, skipped, unapproved or
wrong-revision runs stop release. Mirror lag therefore stops the gate until the
exact revision has arrived and passed.

Keep Cloud main's existing checks until the mirrored workflow has passed full
cold and warm conformance. After merging a Pear PR, wait for its exact merge
revision to mirror and pass, update the Cloud pin, and require green Cloud PR
checks before merging the cutover. Codeberg Actions can remain disabled.

Pear owns source tests, generated-binding parity and protected-mail upgrade and
restart conformance. Cloud retains exact release-artifact conformance, hosting,
gateway, Orcha, backup integration and deployment checks.

Historical-build caching and the conservative presentation/documentation scope
rule are unchanged. Unknown paths, workflow changes and missing diff history
run the full mail suite; the current module always builds separately. See
`scripts/ci/protected-mail-scope.mjs` and its regression tests.
