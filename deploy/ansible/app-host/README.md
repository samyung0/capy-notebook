# App-host WireGuard, firewall, SSH and deploy command

This playbook configures an app host (UAT's or production's): the
point-to-point WireGuard service link to the Netcup ingest host, the host
firewall, key-only SSH and the deploy command CI runs. It installs WireGuard
and ufw, adds source-restricted ufw rules, starts `wg-quick@wg0`, drops public
connections to Docker-published ports, installs the shared SSH drop-in, and
(tag `deploy`) sets up the deploy user. It does not install Docker,
cloudflared or the application services, and does not run a deploy.

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
(restricting it is not decided). Loopback and established traffic pass, so
`cloudflared`, which only connects out, still reaches sshd and the stack's
ports published on `127.0.0.1` (gateway 8080, collaboration 1234, Ops 8082).
The playbook deletes the rule that let Docker networks reach the host, which
only Coolify's Sentinel needed. Docker-published ports
bypass ufw, so the playbook adds a `DOCKER-USER` drop to ufw's `after.rules`
(IPv4) and `after6.rules` (IPv6) for every new connection from the public
interface into a container, whatever the port or protocol. ufw reloads it at
boot and on every reload, and Docker keeps it across restarts. The WireGuard address's published
services are not on the public interface and stay reachable from the ingest
host.

The `deploy` tag creates the system user `capy-deploy` (no password, no
groups, so not `docker`), whose only `authorized_keys` line is the CI deploy
key (`app_deploy_ssh_public_key`) with `restrict`, `from="127.0.0.1,::1"`
(only through the Cloudflare Access tunnel, which connects on loopback) and
the forced command `sudo -n /usr/local/sbin/capy-app-deploy`. Sudoers lets it
run exactly that root-owned script, a copy of
`scripts/deploy/app-host-deploy.sh`, with no arguments; `/opt/capy`, where
releases and their env files live, is root `0700`. Changing the script means
running `--tags deploy` again.

1. Copy `inventory.example.yml` to the ignored `inventory.yml` and fill this
   host's address, key, WireGuard values and deploy key.
2. Install the pinned collection with
   `ansible-galaxy collection install -r requirements.yml`.
3. Review with `ansible-playbook playbook.yml --check --diff`, then run
   `ansible-playbook playbook.yml` from this directory. Follow the lockout-safe
   order in [deployment runbook](../../../openwiki/deployment-runbook.md) §3.1
   the first time. `--tags firewall`, `--tags ssh` or `--tags deploy`
   applies only that part.
4. Put the displayed app-host public key in the ingest host inventory as
   `ingest_wireguard_peer_public_key`, then apply the ingest-host playbook.
5. Verify the link by pinging each host's WireGuard address from the other
   before binding any database or parser service to it.
