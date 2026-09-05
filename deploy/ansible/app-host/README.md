# Coolify app-host WireGuard

This playbook configures only the point-to-point service link between the
Hetzner Coolify host and the Netcup ingest host. It installs WireGuard, adds
source-restricted UFW rules, and starts `wg-quick@wg0`. It does not modify
Coolify, Docker, PostgreSQL, Redis, SSH, routing, or application services.

The link uses `10.77.0.1/32` on the app host and `10.77.0.2/32` on the ingest
host. `AllowedIPs` contains only the peer address. The playbook does not add a
default route, DNS setting, forwarding, or NAT.

The firewall admits the Netcup peer to the future Capy Notebook PostgreSQL port `5432`
and Redis port `6379` on `wg0`. This host sets
`app_retire_native_postgresql: true` because its old `private-gallery` and
`scout` databases are confirmed leftovers. The playbook stops and disables
that native PostgreSQL cluster and removes its public UFW rule. It preserves
the old database files under `/var/lib/postgresql` for manual recovery.

1. Copy `inventory.example.yml` to the ignored `inventory.yml`.
2. Install the pinned collection with
   `ansible-galaxy collection install -r requirements.yml`.
3. Run `ansible-playbook playbook.yml` from this directory.
4. Put the displayed app-host public key in the ingest host inventory as
   `ingest_wireguard_peer_public_key`, then apply the ingest-host playbook.
5. Verify `ping 10.77.0.2` from the app host and `ping 10.77.0.1` from the
   ingest host before binding any database or parser service to the link.

Keep `app_retire_native_postgresql` false on hosts where native PostgreSQL is
still in use.
