# Parser VM provisioning

This playbook owns one Debian parser VM. It installs Docker, WireGuard,
nftables, log rotation, unattended security updates, the parser systemd unit,
and an unprivileged service account. Re-running it is the normal update path.

The service network is point-to-point. WireGuard carries only the app host and
parser VM addresses; it does not change the VM default route, configure NAT, or
enable IP forwarding. Parser HTTP, Postgres, and Redis bind only to those
private addresses.

## First run

1. Copy `inventory.example.yml` to `inventory.yml` and encrypt it with
   `ansible-vault encrypt inventory.yml`.
2. Add the app host WireGuard public key and public `host:51820` endpoint.
3. Put `parser_env` in the encrypted inventory using the keys from
   `deploy/parser-vm.env.example`. Set `parser_repo_version` to the exact full
   release SHA; the playbook writes the matching non-secret `release.env` and
   rejects branch names or a duplicate `RELEASE_SHA` secret. Do not put the
   root password in a file.
4. Install the pinned collection and run the first pass with SSH password
   authentication:

   ```sh
   ansible-galaxy collection install -r requirements.yml
   ansible-playbook --ask-pass --ask-vault-pass playbook.yml
   ```

5. Verify a second terminal can log in as `evo-parser` with the configured key.
   Only then set `parser_harden_ssh: true` and rerun the playbook. The second pass
   disables password login and root SSH login without a key.

If the app host peer is not ready, a safe bootstrap pass may set
`parser_configure_wireguard: false`, leave `parser_repo_url: CHANGE_ME`, and omit
`parser_env`. This installs and hardens the base host without starting the
production stack. Restore `parser_configure_wireguard: true` once the peer
values are present; the production service will not start before then.

The playbook intentionally does not retain host samples: `parse_host_samples`
is permanent. If storage ever becomes material, downsample or partition it as a
separate, explicit decision rather than silently deleting operational history.

## Release promotion

Configure the production GitHub environment with `PARSER_VM_HOST`, optional
`PARSER_VM_USER` / `PARSER_VM_SSH_PORT`, and the secrets
`PARSER_VM_SSH_PRIVATE_KEY` and `PARSER_VM_KNOWN_HOSTS`. The deployment workflow
checks out and warms the parser at the approved SHA while ingest is paused,
runs the matching app migration/deployment, then activates worker and sampler
images carrying that same revision label. `/healthz.release_sha` is checked
before the application deployment begins.

## Rollback

Promote the previous known-good exact SHA through the same release workflow.
This keeps the app, migration, worker, sampler, and parser on one revision.
Artifact schemas, parser versions, and modes all participate in cache identity.
