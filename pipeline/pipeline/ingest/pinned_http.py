"""Fetch a provider download URL without letting DNS steer the connection.

The gateway hands the import worker URLs it did not build itself: Microsoft's
preauthenticated download URL and any redirect either provider answers. Each
hop checks the hostname against the configured provider families, resolves it,
refuses every non-public address, then connects to that exact address with the
hostname as SNI so a second lookup cannot swap in another target. A redirect
that changes origin drops the bearer token.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import certifi
import urllib3

MAX_REDIRECTS = 5
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}


class DownloadRefused(ValueError):
    """The URL, its host, or its resolved address is outside the allowlist."""


def host_allowed(host: str, allowed: tuple[str, ...]) -> bool:
    return any(host == suffix or host.endswith("." + suffix) for suffix in allowed)


def validated_url(raw: str, allowed: tuple[str, ...]) -> tuple[str, str]:
    """Return ``(request_target, host)`` for an https URL on an allowed host."""
    parts = urlsplit(raw)
    host = (parts.hostname or "").lower()
    if (
        parts.scheme != "https"
        or parts.username
        or parts.password
        or parts.port not in (None, 443)
        or not host
        or host.endswith(".")
        or not host_allowed(host, allowed)
    ):
        raise DownloadRefused(f"download host refused: {host or raw!r}")
    target = parts.path or "/"
    if parts.query:
        target += "?" + parts.query
    return target, host


def public_address(host: str) -> str:
    """Resolve ``host`` and return one address only if every answer is public."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise DownloadRefused(f"download host did not resolve: {host}") from exc
    addresses: list[str] = []
    for _family, _type, _proto, _name, sockaddr in infos:
        address = ipaddress.ip_address(sockaddr[0])
        candidate = getattr(address, "ipv4_mapped", None) or address
        if not candidate.is_global:
            raise DownloadRefused(
                f"download host resolves to a non-public address: {host}"
            )
        addresses.append(sockaddr[0])
    if not addresses:
        raise DownloadRefused(f"download host has no address: {host}")
    return addresses[0]


@dataclass
class Download:
    response: urllib3.BaseHTTPResponse
    pool: urllib3.HTTPSConnectionPool

    def close(self) -> None:
        try:
            self.response.release_conn()
        finally:
            self.pool.close()


def open_download(
    url: str,
    *,
    headers: dict[str, str],
    allowed_hosts: tuple[str, ...],
    timeout: float,
) -> Download:
    """Open a streaming GET, following at most ``MAX_REDIRECTS`` checked hops."""
    current = url
    request_headers = dict(headers)
    for _ in range(MAX_REDIRECTS + 1):
        target, host = validated_url(current, allowed_hosts)
        pool = urllib3.HTTPSConnectionPool(
            public_address(host),
            443,
            server_hostname=host,
            assert_hostname=host,
            cert_reqs="CERT_REQUIRED",
            ca_certs=certifi.where(),
            timeout=urllib3.Timeout(connect=10, read=timeout),
            maxsize=1,
        )
        response = pool.urlopen(
            "GET",
            target,
            headers={**request_headers, "Host": host},
            preload_content=False,
            redirect=False,
            retries=False,
        )
        if response.status not in _REDIRECT_STATUSES:
            return Download(response, pool)
        location = response.headers.get("Location")
        response.drain_conn()
        response.release_conn()
        pool.close()
        if not location:
            raise DownloadRefused("redirect without a location")
        following = urljoin(current, location)
        if urlsplit(following).netloc.lower() != urlsplit(current).netloc.lower():
            request_headers.pop("Authorization", None)
        current = following
    raise DownloadRefused("too many redirects")
