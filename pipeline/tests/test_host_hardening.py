"""The host playbooks lock both hosts down: key-only SSH on both, ufw denying
inbound by default on the app host with every new connection from its public
interface into a container dropped (IPv4 and IPv6), and the ingest host's
nftables input and forward chains denying by default. SSH and WireGuard stay
open on both. The app host's CI deploy key runs only its deploy command. The
ingest host's Docker build cache stays bounded."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

ANSIBLE = Path(__file__).resolve().parents[2] / "deploy" / "ansible"
HOSTS = ("app-host", "ingest-host")


def _play(host: str) -> dict:
    return yaml.safe_load((ANSIBLE / host / "playbook.yml").read_text())[0]


def _tasks(play: dict, module: str) -> list[dict]:
    return [task for task in play["tasks"] if module in task]


def _ufw(play: dict) -> list[dict]:
    return [
        task["community.general.ufw"] for task in _tasks(play, "community.general.ufw")
    ]


@pytest.mark.parametrize("host", HOSTS)
def test_ssh_takes_keys_only(host: str) -> None:
    play = _play(host)
    (task,) = [
        task
        for task in _tasks(play, "ansible.builtin.copy")
        if task["ansible.builtin.copy"]["dest"].startswith("/etc/ssh/sshd_config.d/")
    ]
    drop_in = task["ansible.builtin.copy"]
    source = ANSIBLE / host / drop_in["src"].replace("{{ playbook_dir }}/", "")
    settings = dict(
        line.split(None, 1)
        for line in source.read_text().splitlines()
        if line and not line.startswith("#")
    )

    assert settings["PasswordAuthentication"] == "no"
    assert settings["KbdInteractiveAuthentication"] == "no"
    assert settings["PermitRootLogin"] == "prohibit-password"
    # sshd keeps the first value it reads: the drop-in must sort before a cloud
    # image's own drop-in.
    assert Path(drop_in["dest"]).name < "50-cloud-init.conf"
    assert drop_in["validate"] == "/usr/sbin/sshd -t -f %s"
    # The whole configuration passes `sshd -t` before sshd reloads it.
    assert task["notify"] == "Reload SSH"
    handlers = [h for h in play["handlers"] if h.get("listen") == "Reload SSH"]
    assert [h.get("ansible.builtin.command") for h in handlers] == [
        "/usr/sbin/sshd -t",
        None,
    ]
    assert handlers[1]["ansible.builtin.systemd_service"] == {
        "name": "ssh",
        "state": "reloaded",
    }


def test_the_app_host_denies_inbound_by_default() -> None:
    rules = _ufw(_play("app-host"))

    assert {"default": "deny", "direction": "incoming"} in rules
    assert {"state": "enabled"} in rules


def test_the_app_host_opens_ssh_and_wireguard_before_enabling_ufw() -> None:
    rules = _ufw(_play("app-host"))
    ssh = next(i for i, r in enumerate(rules) if r.get("port") == "22")
    wireguard = next(
        i
        for i, r in enumerate(rules)
        if r.get("to_port") == "{{ app_wireguard_listen_port }}"
    )
    enable = rules.index({"state": "enabled"})

    assert rules[ssh] == {
        "rule": "allow",
        "port": "22",
        "proto": "tcp",
        "comment": "SSH, key-only",
    }
    assert rules[wireguard]["rule"] == "allow"
    assert rules[wireguard]["proto"] == "udp"
    assert max(ssh, wireguard) < enable


def test_the_app_host_allows_only_ssh_wireguard_and_the_ingest_host_in() -> None:
    """Security regression (Coolify removal): no rule lets Docker networks or
    anything else reach the host; Coolify's Docker-networks rule is deleted
    for both of its networks (review L8)."""
    play = _play("app-host")
    allowed = [
        rule.get("comment")
        for rule in _ufw(play)
        if rule.get("rule") == "allow" and not rule.get("delete")
    ]
    networks = [
        task.get("loop")
        for task in _tasks(play, "community.general.ufw")
        if task["community.general.ufw"]
        == {"rule": "allow", "direction": "in", "from_ip": "{{ item }}", "delete": True}
    ]

    assert allowed == [
        "SSH, key-only",
        "Capy Notebook ingest-host private service link",
        "Capy Notebook ingest-host private app service",
    ]
    assert networks == [["10.0.0.0/16", "fdda:ad28:f840::/64"]]


def _copied(play: dict, dest: str) -> dict:
    (task,) = [
        task["ansible.builtin.copy"]
        for task in _tasks(play, "ansible.builtin.copy")
        if task["ansible.builtin.copy"]["dest"] == dest
    ]
    return task


def test_the_ci_deploy_key_runs_only_the_deploy_command_through_the_tunnel() -> None:
    """Security regression (Coolify removal, Epo 2026-10-23): the key is
    restricted (no forwarding, PTY or agent), works only from loopback, where
    cloudflared's Access tunnel connects, and can only run the deploy command
    through sudo; the inventory value can add neither options nor lines."""
    play = _play("app-host")
    keys = _copied(play, "/var/lib/capy-deploy/.ssh/authorized_keys")
    (assertion,) = [
        task["ansible.builtin.assert"]
        for task in play["pre_tasks"]
        if "app_deploy_ssh_public_key" in str(task)
    ]

    assert keys["content"] == (
        'restrict,from="127.0.0.1,::1",'
        'command="/usr/bin/sudo -n /usr/local/sbin/capy-app-deploy" '
        "{{ app_deploy_ssh_public_key }}\n"
    )
    assert (keys["owner"], keys["mode"]) == ("root", "0644")
    assert assertion["that"] == [
        (
            "app_deploy_ssh_public_key | default('') is match("
            "'^ssh-ed25519 [A-Za-z0-9+/]+=* [A-Za-z0-9._@-]+$')"
        )
    ]


def test_the_deploy_user_may_run_one_root_script_and_has_no_docker_access() -> None:
    """Security regression (Coolify removal, Epo 2026-10-23): sudoers names
    exactly one root-owned script, with no arguments, keeping only
    SSH_ORIGINAL_COMMAND; the user is in no group (so not docker) and owns
    nothing it could change."""
    play = _play("app-host")
    sudoers = _copied(play, "/etc/sudoers.d/capy-deploy")
    script = _copied(play, "/usr/local/sbin/capy-app-deploy")
    (user,) = [
        task["ansible.builtin.user"] for task in _tasks(play, "ansible.builtin.user")
    ]
    folders = [
        task["ansible.builtin.file"] for task in _tasks(play, "ansible.builtin.file")
    ]

    assert sudoers["content"].splitlines() == [
        'Defaults!/usr/local/sbin/capy-app-deploy env_keep = "SSH_ORIGINAL_COMMAND"',
        'capy-deploy ALL=(root) NOPASSWD: /usr/local/sbin/capy-app-deploy ""',
    ]
    assert sudoers["validate"] == "/usr/sbin/visudo -cf %s"
    assert (sudoers["owner"], sudoers["mode"]) == ("root", "0440")
    assert script["src"].endswith("/scripts/deploy/app-host-deploy.sh")
    assert (script["owner"], script["mode"]) == ("root", "0755")
    assert user["name"] == "capy-deploy"
    assert user["groups"] == ""
    assert {"path": "/opt/capy", "mode": "0700", "owner": "root"}.items() <= next(
        folder for folder in folders if folder["path"] == "/opt/capy"
    ).items()


def test_the_app_host_drops_every_new_public_connection_into_containers() -> None:
    # Human decision (Epo 2026-10-20, human/deployment-runbook.md): every port
    # and protocol, not a list of published ports.
    play = _play("app-host")
    (task,) = [
        task
        for task in _tasks(play, "ansible.builtin.blockinfile")
        if "DOCKER-USER" in task["ansible.builtin.blockinfile"]["block"]
    ]
    lines = task["ansible.builtin.blockinfile"]["block"].splitlines()

    # after.rules is ufw's IPv4 file, after6.rules its IPv6 one; ufw loads both
    # at boot and on reload.
    assert task["loop"] == ["after.rules", "after6.rules"]
    assert lines == [
        "*filter",
        ":DOCKER-USER - [0:0]",
        "-A DOCKER-USER -i {{ app_public_interface }} -m conntrack --ctstate NEW -j DROP",
        "COMMIT",
    ]
    assert (
        play["vars"]["app_public_interface"] == "{{ ansible_default_ipv4.interface }}"
    )


def _chain(template: str, name: str) -> list[str]:
    body = re.search(rf"chain {name} \{{(.*?)\n  \}}", template, re.DOTALL)
    assert body, name
    return [line.strip() for line in body.group(1).splitlines() if line.strip()]


def test_the_ingest_host_denies_inbound_and_published_ports_by_default() -> None:
    template = (ANSIBLE / "ingest-host" / "templates" / "nftables.conf.j2").read_text()
    inbound = _chain(template, "input")
    forward = _chain(template, "forward")

    assert inbound[0] == "type filter hook input priority filter; policy drop;"
    assert "tcp dport 22 accept" in inbound
    assert "udp dport {{ ingest_wireguard_listen_port }} accept" in inbound
    assert 'iifname "{{ ingest_wireguard_interface }}" accept' in inbound
    # The forward chain drops every new connection into a container that is
    # not the containers' own egress, so a published port stays closed.
    assert forward[0] == "type filter hook forward priority filter; policy drop;"
    assert all(
        rule == "ct state established,related accept"
        or re.match(r'iifname "(docker0|br-\*)" ', rule)
        for rule in forward[1:]
    )


def test_the_ingest_host_bounds_the_docker_build_cache() -> None:
    (task,) = [
        task
        for task in _tasks(_play("ingest-host"), "ansible.builtin.copy")
        if task["ansible.builtin.copy"]["dest"] == "/etc/docker/daemon.json"
    ]
    daemon = json.loads(task["ansible.builtin.copy"]["content"])

    assert daemon["builder"]["gc"] == {"enabled": True, "defaultKeepStorage": "20GB"}


@pytest.mark.parametrize("host", HOSTS)
def test_ptrace_is_limited_to_descendants(host: str) -> None:
    # Human decision (Epo 2026-10-20): both hosts set scope 1.
    (task,) = [
        task["ansible.posix.sysctl"]
        for task in _tasks(_play(host), "ansible.posix.sysctl")
        if task["ansible.posix.sysctl"]["name"] == "kernel.yama.ptrace_scope"
    ]

    assert task["value"] == "1"
    assert task["sysctl_file"] == "/etc/sysctl.d/60-capy-ptrace.conf"
    assert task["state"] == "present"
