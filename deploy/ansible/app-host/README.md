# Coolify app-host WireGuard

This playbook configures only the point-to-point service link between the
Hetzner Coolify host and the Netcup parser VM. It installs WireGuard, adds
source-restricted UFW rules, and starts `wg-quick@wg0`. It does not modify
Coolify, Docker, PostgreSQL, Redis, SSH, routing, or application services.

The link uses `10.77.0.1/32` on the app host and `10.77.0.2/32` on the parser
VM. `AllowedIPs` contains only the peer address. The playbook does not add a
default route, DNS setting, forwarding, or NAT.

The firewall admits the Netcup peer to the future Evo PostgreSQL host port
`55432` and Redis port `6379` on `wg0`. PostgreSQL uses a non-default host port
because an unrelated native PostgreSQL service already owns host port `5432`.

1. Copy `inventory.example.yml` to the ignored `inventory.yml`.
2. Install the pinned collection with
   `ansible-galaxy collection install -r requirements.yml`.
3. Run `ansible-playbook playbook.yml` from this directory.
4. Put the displayed app-host public key in the parser VM inventory as
   `parser_wireguard_peer_public_key`, then apply the parser playbook.
5. Verify `ping 10.77.0.2` from the app host and `ping 10.77.0.1` from the
   parser VM before binding any database or parser service to the link.

Public PostgreSQL exposure is deliberately outside this playbook. Restricting
port 5432 requires a separate change after confirming the existing
`private-gallery` and `scout` clients no longer need public access.
