# Coolify app-host WireGuard, firewall and SSH

This playbook configures an app host (the UAT Coolify host, or the production
one): the point-to-point WireGuard service link to the Netcup ingest host, the
host firewall and key-only SSH. It installs WireGuard and ufw, adds
source-restricted ufw rules, starts `wg-quick@wg0`, drops public connections to
Docker-published ports, and installs the shared SSH drop-in. It does not modify
Coolify, Docker, PostgreSQL, Redis, routing, or application services.

Each host has its own address on the link (`app_wireguard_address`, the app
side; `app_wireguard_peer_address`, the ingest host). `AllowedIPs` contains only
the peer address. The playbook does not add a default route, DNS setting,
forwarding, or NAT.

The firewall admits the Netcup peer to the Capy Notebook PostgreSQL port `5432`
and Redis port `6379` on `wg0`, and WireGuard itself only from the peer's
public address. Set `app_retire_native_postgresql: true` only on a host whose
native PostgreSQL databases are confirmed leftovers: the playbook then stops
and disables that native PostgreSQL cluster and removes its public ufw rule,
preserving the old database files under `/var/lib/postgresql` for manual
recovery.

ufw denies inbound traffic by default and keeps SSH on 22 open to all
(restricting it is not decided, and Coolify manages its own host over SSH).
Loopback and established traffic pass, so `cloudflared`, which only connects
out, still reaches the Coolify proxy on `localhost:80`. Docker-published ports
bypass ufw, so the playbook adds a `DOCKER-USER` drop to ufw's `after.rules`
(IPv4) and `after6.rules` (IPv6) for every new connection from the public
interface into a container, whatever the port or protocol. ufw reloads it at
boot and on every reload, and Docker keeps it across restarts. The WireGuard address's published
services are not on the public interface and stay reachable from the ingest
host.

1. Copy `inventory.example.yml` to the ignored `inventory.yml` and fill this
   host's address, key and WireGuard values.
2. Install the pinned collection with
   `ansible-galaxy collection install -r requirements.yml`.
3. Review with `ansible-playbook playbook.yml --check --diff`, then run
   `ansible-playbook playbook.yml` from this directory. Follow the lockout-safe
   order in [deployment runbook](../../../openwiki/deployment-runbook.md) §3.1
   the first time. `--tags firewall` or `--tags ssh` applies only that part.
4. Put the displayed app-host public key in the ingest host inventory as
   `ingest_wireguard_peer_public_key`, then apply the ingest-host playbook.
5. Verify the link by pinging each host's WireGuard address from the other
   before binding any database or parser service to it.
