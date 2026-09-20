"""Shared plumbing for the playground: targets, the ingest-host tunnel, secrets
pulled from the UAT worker environment and from the repository-root .env.local,
and source-PDF lookup per target.

Nothing here writes to a database. Secrets stay in process memory.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
LOCAL = ROOT / "local"
CONFIGS = ROOT / "configs"
LAB = REPO / "bench/rag/fixtures/local/2026-09-09-odl-agentic"

INGEST_HOST = "159.195.61.195"
# CAPY_INGEST_SSH_KEY wins; otherwise the first of these that exists (the key
# was renamed when the host was rebuilt).
INGEST_KEYS = (
    Path.home() / ".ssh/id_ed25519_capy_ingest",
    Path.home() / ".ssh/capy_ingest_159_195_61_195",
)
UAT_WORKER = "capy-ingest-nonprod-worker-uat-1"
# Local port -> (host as seen from the ingest VM, port). The lab database is the
# frozen September 9 evaluation index; UAT Postgres and the shared knowledge
# library sit on the WireGuard net.
# Local ports stay below the Windows/Hyper-V reserved ranges (55370-55469 on
# this PC), matching the tunnel the developer already runs for the library.
LIBRARY_PORT = 15433
TUNNELS = {
    15435: ("127.0.0.1", 55435),
    15432: ("10.77.0.3", 5432),
    LIBRARY_PORT: ("10.77.0.2", 5433),
}
TARGETS = {
    "lab": {"dsn": "postgresql://postgres@127.0.0.1:15435/odl_eval"},
    "uat": {"dsn": "postgresql://capy:{pw}@127.0.0.1:15432/capy?sslmode=disable"},
    # The dev compose stack on this PC (deploy/docker-compose.yml); no tunnel.
    "local": {"dsn": "postgres://capy:capy@localhost:5432/capy?sslmode=disable"},
}
PROVIDER_KEYS = (
    "DEEPSEEK_API_KEY",
    "DEEPINFRA_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "TOKENHUB",
)
B2_KEYS = ("B2_ENDPOINT", "B2_REGION", "B2_BUCKET", "B2_KEY_ID", "B2_APP_KEY")
# The knowledge library and its private bucket are developer-local secrets: the
# retrieval service reads them from the environment when pipeline.config imports.
LIBRARY_KEYS = ("LIBRARY_DATABASE_URL", "CAPY_LIBRARY_TAG_MIN_CONFIDENCE")
KNOWLEDGE_B2_KEYS = (
    "KNOWLEDGE_BASE_B2_ENDPOINT",
    "KNOWLEDGE_BASE_B2_REGION",
    "KNOWLEDGE_BASE_B2_BUCKET",
    "KNOWLEDGE_BASE_B2_KEY_ID",
    "KNOWLEDGE_BASE_B2_APP_KEY",
)


def ingest_key() -> Path:
    override = os.environ.get("CAPY_INGEST_SSH_KEY")
    if override:
        return Path(override).expanduser()
    return next((key for key in INGEST_KEYS if key.exists()), INGEST_KEYS[-1])


def env_file(path: Path) -> dict[str, str]:
    from dotenv import dotenv_values

    if not path.exists():
        return {}
    return {key: value for key, value in dotenv_values(path).items() if value}


def on_tunnel(url: str, port: int) -> str:
    """The same connection string as seen from this PC through the tunnel."""
    parts = urlsplit(url)
    credentials = f"{parts.username}:{parts.password}@" if parts.username else ""
    return urlunsplit(parts._replace(netloc=f"{credentials}127.0.0.1:{port}"))


def ssh(*args: str) -> str:
    cmd = [
        "ssh",
        "-i",
        str(ingest_key()),
        "-o",
        "BatchMode=yes",
        f"root@{INGEST_HOST}",
        *args,
    ]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def worker_env() -> dict[str, str]:
    """UAT provider and bucket credentials, read from the running worker."""
    out = ssh("docker", "exec", UAT_WORKER, "env")
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_tunnel(ports: tuple[int, ...] = tuple(TUNNELS)) -> bool:
    """Open whatever forwards among `ports` are down; True when something had
    to be reopened. Called at start and before every request that reaches a
    database, because the tunnel dies with the network (sleep, Wi-Fi change)
    while this server keeps running, and a reopened tunnel means every pooled
    connection is dead. The knowledge builder passes the library port only."""
    # Forward only what is not already up, so an older tunnel of this host does
    # not make the new one fail on an address already in use.
    missing = {local: TUNNELS[local] for local in ports if not port_open(local)}
    if not missing:
        return False
    forwards = [f"-L{local}:{host}:{port}" for local, (host, port) in missing.items()]
    # Windows OpenSSH ignores -f, so the tunnel is a child we never wait on;
    # it dies with this process. Poll the forwards instead of trusting -f.
    tunnel = subprocess.Popen(
        [
            "ssh",
            "-i",
            str(ingest_key()),
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-N",
            *forwards,
            f"root@{INGEST_HOST}",
        ],
    )
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if all(port_open(p) for p in ports):
            return True
        if tunnel.poll() is not None:
            break
        time.sleep(0.5)
    raise RuntimeError("ssh tunnel to the ingest host did not open every port")


def prepare_environment(target: str) -> str:
    """Tunnel, pull secrets, point DATABASE_URL at the target. Call before importing pipeline."""
    if target not in TARGETS:
        raise ValueError(f"unknown target {target}; expected one of {sorted(TARGETS)}")
    if target == "local":
        env = env_file(REPO / "deploy/.env")
        dsn = env.get("DATABASE_URL") or TARGETS[target]["dsn"]
    else:
        ensure_tunnel()
        env = worker_env()
        dsn = TARGETS[target]["dsn"]
        if "{pw}" in dsn:
            remote = env["DATABASE_URL"]
            dsn = dsn.format(
                pw=remote.split("://", 1)[1].split("@", 1)[0].split(":", 1)[1]
            )
    for key in (*PROVIDER_KEYS, *B2_KEYS):
        if env.get(key):
            os.environ.setdefault(key, env[key])
    local_env = env_file(REPO / ".env.local")
    for key in (*PROVIDER_KEYS, *LIBRARY_KEYS, *KNOWLEDGE_B2_KEYS):
        if local_env.get(key):
            os.environ.setdefault(key, local_env[key])
    if not os.environ.get("LIBRARY_DATABASE_URL") and env.get("LIBRARY_DATABASE_URL"):
        # No developer copy: reach the deployed reader through our own tunnel.
        os.environ["LIBRARY_DATABASE_URL"] = on_tunnel(
            env["LIBRARY_DATABASE_URL"], LIBRARY_PORT
        )
    os.environ["DATABASE_URL"] = dsn
    os.environ.setdefault("CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S", "60")
    return dsn


class PdfResolver:
    """file_id -> local PDF path. Lab files map to the frozen corpus copies; UAT
    files are downloaded once from the UAT bucket."""

    def __init__(self, target: str):
        self.target = target
        self._lab: dict[str, Path] = {}
        if target == "lab":
            arms = json.loads((LAB / "workspaces.json").read_text())["arms"]
            sources = {
                s["source_id"]: s
                for s in json.loads((LAB / "sources.json").read_text())["sources"]
            }
            for arm in arms.values():
                for source_id, file_id in arm["files"].items():
                    self._lab[file_id] = LAB / sources[source_id]["pdf"]

    async def path(self, file_id: str) -> Path:
        if self.target == "lab":
            if file_id not in self._lab:
                raise KeyError(f"{file_id} is not in the frozen lab corpus")
            return self._lab[file_id]
        cache = LOCAL / "pdfs/uat" / f"{file_id}.pdf"
        if cache.exists():
            return cache
        from pipeline.retrieval import store
        from pipeline.store import blobstore

        pool = await store.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT blob_path, preview_blob_path, kind FROM files WHERE id=%s AND trashed_at IS NULL",
                (file_id,),
            )
            row = await cur.fetchone()
        if not row:
            raise KeyError(f"{file_id} is not an active file")
        # Office sources were parsed against their LibreOffice PDF, so that is the
        # coordinate space the chunk regions refer to.
        blob = row["preview_blob_path"] or row["blob_path"]
        if not blob or (row["kind"] != "pdf" and not row["preview_blob_path"]):
            raise KeyError(f"{file_id} has no page-addressable PDF")
        data = blobstore.read_bytes(blob)
        if not data:
            raise KeyError(f"{file_id}: bucket object {blob} is empty or missing")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(data)
        return cache
