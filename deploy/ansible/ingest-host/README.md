# Ingest host provisioning

This playbook installs Docker, WireGuard, nftables, bounded logs, unattended
updates, the `capy-ingest` service account and selected parser watchdogs.
GitHub deployment workflows own application configuration and release checkouts.

Copy `inventory.example.yml` to ignored `inventory.yml`, mode `0600`. Fill the
WireGuard peer and administrator public key. Set `ingest_watchdog_stacks` to
`[nonprod]` for UAT, `[production]` for an authorized production setup, both when
both are provisioned, or `[]` for host-only setup. `ingest_configure_wireguard:
false` permits base provisioning before the peer is ready.

```sh
ansible-galaxy collection install -r requirements.yml
ansible-playbook --ask-pass playbook.yml
```

Verify SSH access as `capy-ingest` in a second terminal. Existing root/password
SSH behavior is retained. The service network carries only private app/ingest
addresses; it does not change the default route, configure NAT or forwarding.

Fill and upload the environment's complete `deploy/.env.uat` or `.env.prod`
using `pnpm env:push`. See [deployment runbook](../../../openwiki/deployment-runbook.md).
The first coordinated app deployment selects `bootstrap_ingest`; standalone
**Deploy ingest** selects `bootstrap` and requires an already matching backend.
Bootstrap clones only into an absent/empty checkout, initializes the parser
spool, and activates consumers only after backend verification. It does not
invent credentials or overwrite an existing running stack.

Production uses `/opt/capy-ingest/app` and `releases/production`. UAT uses
`/opt/capy-ingest/app-nonprod` and `releases/nonprod`. Under each state directory,
`active` holds the SHA, `current` points to an immutable config snapshot, and
`pending` plus `operation.lock` protect release transitions. Local consumers
keep `/opt/capy-ingest/local.queue.env`; UAT never rewrites it.

Docker's `unless-stopped` policy retains the deployed container images and
configuration across reboots, including deliberately stopped consumers during
a release. The retired stack-launching systemd unit is removed only while
inactive; Ansible refuses to replace a running legacy launcher.

`capy-ingest-watchdog@nonprod.service` and its production instance inspect only
that Compose project's existing parser. Three unhealthy Docker observations
trigger a restart only if its revision matches `active`, no release is pending,
and the watchdog acquires the release operation lock. Stopped containers stay
stopped. The parser's per-slice deadline owns stuck-work detection.

After failed or canceled deployment, verify the exact Coolify deployment is
terminal and identify the live backend SHA before recovery. Unknown provider
state retains pending evidence and paused consumers. Do not delete pending
state or restore old ingest while the new backend is running. Promote a
previous compatible revision through the full workflow for a later rollback.
No workflow prunes unrelated images, volumes, lab data or permanent host samples.
