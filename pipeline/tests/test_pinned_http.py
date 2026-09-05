"""Provider download URL checks: host allowlist, public-address pinning, redirects."""

from __future__ import annotations

import socket

import pytest

from pipeline.ingest import pinned_http

HOSTS = ("sharepoint.com", "googleapis.com")


def _resolver(answers: dict[str, list[str]]):
    def fake(host, port, proto=0):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, proto, "", (ip, port))
            for ip in answers[host]
        ]

    return fake


@pytest.mark.parametrize(
    "url",
    [
        "http://tenant.sharepoint.com/file",
        "https://user:pw@tenant.sharepoint.com/file",
        "https://tenant.sharepoint.com:8443/file",
        "https://evilsharepoint.com/file",
        "https://sharepoint.com.attacker.example/file",
        "https://10.77.0.1/file",
    ],
)
def test_validated_url_refuses_off_allowlist(url):
    with pytest.raises(pinned_http.DownloadRefused):
        pinned_http.validated_url(url, HOSTS)


def test_validated_url_keeps_query_and_matches_suffix():
    target, host = pinned_http.validated_url(
        "https://Tenant.SharePoint.com/download?x=1", HOSTS
    )
    assert (target, host) == ("/download?x=1", "tenant.sharepoint.com")


def test_public_address_refuses_any_private_answer(monkeypatch):
    monkeypatch.setattr(
        pinned_http.socket,
        "getaddrinfo",
        _resolver({"a.sharepoint.com": ["13.107.136.10", "10.77.0.1"]}),
    )
    with pytest.raises(pinned_http.DownloadRefused):
        pinned_http.public_address("a.sharepoint.com")


@pytest.mark.parametrize(
    "ip", ["169.254.169.254", "127.0.0.1", "100.64.1.1", "::ffff:10.0.0.5"]
)
def test_public_address_refuses_special_ranges(monkeypatch, ip):
    monkeypatch.setattr(
        pinned_http.socket, "getaddrinfo", _resolver({"h.googleapis.com": [ip]})
    )
    with pytest.raises(pinned_http.DownloadRefused):
        pinned_http.public_address("h.googleapis.com")


def test_public_address_returns_validated_ip(monkeypatch):
    monkeypatch.setattr(
        pinned_http.socket,
        "getaddrinfo",
        _resolver({"h.googleapis.com": ["142.250.1.1"]}),
    )
    assert pinned_http.public_address("h.googleapis.com") == "142.250.1.1"


class _Response:
    def __init__(self, status, location=None):
        self.status = status
        self.headers = {"Location": location} if location else {}

    def drain_conn(self):
        pass

    def release_conn(self):
        pass


def test_redirect_pins_each_hop_and_drops_bearer_cross_origin(monkeypatch):
    seen: list[tuple[str, str, dict]] = []
    answers = iter(
        [
            _Response(302, "https://cdn.googleapis.com/blob"),
            _Response(200),
        ]
    )

    class Pool:
        def __init__(self, host, port, server_hostname, **_kwargs):
            self.host, self.server_hostname = host, server_hostname

        def urlopen(self, _method, target, headers, **_kwargs):
            seen.append((self.host, self.server_hostname, headers))
            return next(answers)

        def close(self):
            pass

    monkeypatch.setattr(pinned_http.urllib3, "HTTPSConnectionPool", Pool)
    monkeypatch.setattr(
        pinned_http.socket,
        "getaddrinfo",
        _resolver(
            {
                "www.googleapis.com": ["142.250.1.1"],
                "cdn.googleapis.com": ["142.250.2.2"],
            }
        ),
    )
    download = pinned_http.open_download(
        "https://www.googleapis.com/drive/v3/files/x?alt=media",
        headers={"Authorization": "Bearer t"},
        allowed_hosts=HOSTS,
        timeout=5,
    )
    assert download.response.status == 200
    assert seen[0][0] == "142.250.1.1" and seen[0][1] == "www.googleapis.com"
    assert seen[0][2]["Host"] == "www.googleapis.com"
    assert "Authorization" in seen[0][2]
    assert seen[1][0] == "142.250.2.2" and "Authorization" not in seen[1][2]


def test_redirect_to_private_host_is_refused(monkeypatch):
    class Pool:
        def __init__(self, *_args, **_kwargs):
            pass

        def urlopen(self, *_args, **_kwargs):
            return _Response(302, "https://internal.sharepoint.com/x")

        def close(self):
            pass

    monkeypatch.setattr(pinned_http.urllib3, "HTTPSConnectionPool", Pool)
    monkeypatch.setattr(
        pinned_http.socket,
        "getaddrinfo",
        _resolver(
            {
                "a.sharepoint.com": ["13.107.136.10"],
                "internal.sharepoint.com": ["10.77.0.1"],
            }
        ),
    )
    with pytest.raises(pinned_http.DownloadRefused):
        pinned_http.open_download(
            "https://a.sharepoint.com/x", headers={}, allowed_hosts=HOSTS, timeout=5
        )
