# Ingest host provisioning

This playbook owns one Debian ingest host. It installs Docker, WireGuard,
nftables, log rotation, unattended security updates, the ingest systemd unit,
and an unprivileged service account. Re-running it is the normal update path.

The service network is point-to-point. WireGuard carries only the app host and
ingest host addresses; it does not change the VM default route, configure NAT, or
enable IP forwarding. Parser HTTP, Postgres, and Redis bind only to those
private addresses.

## First run

1. Copy `inventory.example.yml` to the ignored `inventory.yml` and run
   `chmod 600 inventory.yml`. The file is intentionally plain YAML. Never
   commit, upload, or paste it because `ingest_env` contains service secrets.
2. Add the app host WireGuard public key and public `host:51820` endpoint.
3. Put `ingest_env` in the ignored inventory using the keys from
   `deploy/ingest-host.env.example`. Set `ingest_repo_version` to the exact full
   release SHA; the playbook writes the matching non-secret `release.env` and
   rejects branch names or a duplicate `RELEASE_SHA` secret. Do not put the
   root password in a file.
4. Install the pinned collection and run the first pass with SSH password
   authentication:

   ```sh
   ansible-galaxy collection install -r requirements.yml
   ansible-playbook --ask-pass playbook.yml
   ```

5. Verify a second terminal can log in as `evo-ingest` with the configured key.
   Password and root SSH login remain enabled for now. This is simple, but it
   leaves the public SSH endpoint exposed to password guessing. Fail2ban limits
   repeated attempts; it does not make a reusable password safe. Move to
   key-only login when the operational workflow is settled.

If the app host peer is not ready, a safe bootstrap pass may set
`ingest_configure_wireguard: false`, leave `ingest_repo_url: CHANGE_ME`, and omit
`ingest_env`. This installs the base host without starting the
production stack. Restore `ingest_configure_wireguard: true` once the peer
values are present; the production service will not start before then.

The playbook intentionally does not delete host samples: `ingest_host_samples`
is permanent. If storage ever becomes material, downsample or partition it as a
separate, explicit decision rather than silently deleting operational history.

## Release promotion

Configure the production GitHub environment with `INGEST_HOST`, optional
`INGEST_HOST_USER` / `INGEST_HOST_SSH_PORT`, and the secrets
`INGEST_HOST_SSH_PRIVATE_KEY` and `INGEST_HOST_KNOWN_HOSTS`. The deployment
workflow checks out and warms the parser at the approved SHA while ingest is
paused, runs the matching app migration/deployment, then activates worker and
sampler images carrying that same revision label. `/healthz.release_sha` is
checked before the application deployment begins.

The playbook also enables `evo-ingest-watchdog.service`. It skips release
cutovers while `/opt/evo-ingest/release.pending` exists. Outside a cutover, it
restarts the parser after three failed health checks. The parser's per-slice
deadline owns stuck-work detection.

## Rollback

Promote the previous known-good exact SHA through the same release workflow.
This keeps the app, migration, worker, sampler, and parser on one revision.
Artifact schemas, parser versions, and modes all participate in cache identity.
