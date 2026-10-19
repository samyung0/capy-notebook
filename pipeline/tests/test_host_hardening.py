"""The host playbooks lock both hosts down: key-only SSH on both, ufw denying
inbound by default on the app host with Docker's published ports dropped on
its public interface (TCP and UDP, IPv4 and IPv6), and the ingest host's
nftables input and forward chains denying by default. SSH and WireGuard stay
open on both."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ANSIBLE = Path(__file__).resolve().parents[2] / "deploy" / "ansible"
HOSTS = ("app-host", "ingest-host")
# The UAT origin lockdown's public ports (human/deployment-runbook.md).
PUBLIC_DOCKER_PORTS = [80, 443, 8000, 6001, 6002, 8080]


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


def test_the_app_host_lets_docker_networks_reach_it_but_not_all_of_10_8() -> None:
    play = _play("app-host")
    networks = play["vars"]["app_docker_host_networks"]
    rules = _ufw(play)

    assert {
        "rule": "allow",
        "direction": "in",
        "from_ip": "{{ item }}",
        "comment": "Docker networks to the host",
    } in rules
    assert "10.0.0.0/16" in networks
    # The WireGuard link also lives in 10/8: never open the whole pool.
    assert "10.0.0.0/8" not in networks


def test_the_app_host_drops_public_docker_ports_over_tcp_and_udp_on_ipv4_and_ipv6() -> (
    None
):
    play = _play("app-host")
    (task,) = [
        task
        for task in _tasks(play, "ansible.builtin.blockinfile")
        if "DOCKER-USER" in task["ansible.builtin.blockinfile"]["block"]
    ]
    lines = task["ansible.builtin.blockinfile"]["block"].splitlines()
    drops = {
        proto: f"-A DOCKER-USER -i {{{{ app_public_interface }}}} -p {proto} -m multiport"
        " --dports {{ app_public_docker_ports | join(',') }} -j DROP"
        for proto in ("tcp", "udp")
    }

    # after.rules is ufw's IPv4 file, after6.rules its IPv6 one; ufw loads both
    # at boot and on reload.
    assert task["loop"] == ["after.rules", "after6.rules"]
    assert lines[:2] == ["*filter", ":DOCKER-USER - [0:0]"]
    assert drops["tcp"] in lines
    assert drops["udp"] in lines
    assert lines[-1] == "COMMIT"
    assert play["vars"]["app_public_docker_ports"] == PUBLIC_DOCKER_PORTS
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
