# Dedicated Pear CI runner

Prepared configuration only: no machine is provisioned, runner registered,
Codeberg setting changed or Cloud gate removed by these files.

Use a fresh Linux VM dedicated to this public repository. Start with 4 vCPU,
8 GiB RAM and 60 GiB disk, then measure resource use on the first cold run.
The Docker socket lets fixture code control this VM. Do not attach production
credentials, private workspace data, deployment services or a private-network
route to it. Keep maintainer approval for external contributors' workflow runs.
Register at repository scope, `Eclosion-Tech/pear`, not organization scope.
Capacity is one; fixture ports and host resources are not shared with Cloud CI.

## Install on the new VM

Install Docker Engine and Git using the distribution/vendor instructions.
Install the official [Forgejo Runner v13.2.1](https://code.forgejo.org/forgejo/runner/releases/tag/v13.2.1)
binary for the VM architecture, checking its published SHA-256 and signature
before placing it at `/usr/local/bin/forgejo-runner`. These files match that
version's configuration schema. Do not use the old Cloud runner registration.

From a reviewed checkout of this branch:

```sh
sudo useradd --system --create-home --home-dir /var/lib/pear-ci --shell /usr/sbin/nologin pear-ci
sudo usermod -aG docker pear-ci
sudo install -d -m 0755 /etc/pear-ci
sudo install -m 0644 ci/runner/config.yml /etc/pear-ci/config.yml
sudo install -m 0644 ci/runner/pear-ci.service /etc/systemd/system/pear-ci.service
sudo docker build -t pear-ci-job:node22 ci/runner
sudo -Hu pear-ci /usr/local/bin/forgejo-runner --version
```

In the Pear repository settings, enable Actions under Units, then create a
repository runner. Register interactively so its token is not in shell history:

```sh
sudo -Hu pear-ci /usr/local/bin/forgejo-runner register --config /etc/pear-ci/config.yml
```

Use `https://codeberg.org`, the repository registration token, a dedicated runner
name and the label `pear-ci:docker://pear-ci-job:node22`. The `.runner` file is
local credential state, never a repository file. Keep it readable only by the
service user. The cache proxy and test databases need loopback access from job
containers; no inbound public port is required. Keep the inbound firewall closed
except for administrative SSH. Permit outbound access for
Codeberg, the official Actions mirrors, Node/pnpm/Rust registries and Docker Hub.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pear-ci
sudo systemctl status pear-ci
```

Confirm Codeberg shows an online runner with the `pear-ci` label. Then trigger
the Pear PR again (for example, reopen it after enabling Actions) and inspect
both `unit` and `protected-mail`. A manual `pear-ci.yml` dispatch forces full
mail conformance. Record the exact commit and run URL; repeat a full run to
verify warm cache hits. Local unit tests do not establish runner readiness.

## Cutover

1. Keep the existing Cloud main checks active while preparing this runner.
2. Obtain a successful `pear-ci.yml` run for the reviewed Pear revision, then
   merge the Pear change and verify main's exact merge revision too.
3. Pin the verified Pear revision in the companion Cloud PR. Its new gate reads
   Codeberg Actions, verifies repository/workflow/commit and rejects missing,
   pending, failed, skipped or unapproved results. It accepts no manual status
   substitute and has no bypass flag.
4. Merge the Cloud cutover only after that gate and the remaining Cloud checks
   pass. If Codeberg is unavailable, release stops; do not remove the gate.

Pear owns source tests, generated-binding parity and protected-mail upgrade and
restart conformance. Cloud still builds and tests the exact release artifact,
checks hosting/gateway/Orcha/backup integration and controls deployment.

The cache holds only compiled historical WASM and integrity receipts. Its key
includes source commit, toolchain, configuration and builder implementation.
Missing or invalid entries rebuild; the current module always builds separately.
Scope decisions skip mail conformance only for an explicit audited presentation
allowlist and documentation. Unknown files, workflow changes or missing history
run the full suite. See `scripts/ci/protected-mail-scope.mjs` and its tests.

References: [Codeberg setup](https://docs.codeberg.org/ci/actions/),
[Forgejo runner configuration](https://forgejo.org/docs/latest/admin/actions/configuration/).
