"""Shared plumbing for the playground: targets, the ingest-host tunnel, secrets
pulled from the UAT worker environment, and source-PDF lookup per target.

Nothing here writes to a database. Secrets stay in process memory.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
LOCAL = ROOT / "local"
CONFIGS = ROOT / "configs"
LAB = REPO / "bench/rag/fixtures/local/2026-09-09-odl-agentic"

INGEST_HOST = "159.195.61.195"
INGEST_KEY = Path.home() / ".ssh/id_ed25519_capy_ingest"
UAT_WORKER = "capy-ingest-nonprod-worker-uat-1"
# Local port -> (host as seen from the ingest VM, port). The lab database is the
# frozen September 9 evaluation index; UAT Postgres sits on the WireGuard net.
TUNNELS = {55435: ("127.0.0.1", 55435), 55432: ("10.77.0.3", 5432)}
TARGETS = {
    "lab": {"port": 55435, "dsn": "postgresql://postgres@127.0.0.1:55435/odl_eval"},
    "uat": {"port": 55432, "dsn": "postgresql://capy:{pw}@127.0.0.1:55432/capy?sslmode=disable"},
}
PROVIDER_KEYS = ("DEEPSEEK_API_KEY", "DEEPINFRA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY")
B2_KEYS = ("B2_ENDPOINT", "B2_REGION", "B2_BUCKET", "B2_KEY_ID", "B2_APP_KEY")


def ssh(*args: str) -> str:
    cmd = ["ssh", "-i", str(INGEST_KEY), "-o", "BatchMode=yes", f"root@{INGEST_HOST}", *args]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def worker_env() -> dict[str, str]:
    """UAT provider and bucket credentials, read from the running worker."""
    out = ssh("docker", "exec", UAT_WORKER, "env")
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_tunnel() -> None:
    if all(port_open(p) for p in TUNNELS):
        return
    forwards = [f"-L{local}:{host}:{port}" for local, (host, port) in TUNNELS.items()]
    subprocess.run(
        ["ssh", "-i", str(INGEST_KEY), "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
         "-fN", *forwards, f"root@{INGEST_HOST}"],
        check=True,
    )
    if not all(port_open(p) for p in TUNNELS):
        raise RuntimeError("ssh tunnel to the ingest host did not open both ports")


def prepare_environment(target: str) -> str:
    """Tunnel, pull secrets, point DATABASE_URL at the target. Call before importing pipeline."""
    if target not in TARGETS:
        raise ValueError(f"unknown target {target}; expected one of {sorted(TARGETS)}")
    ensure_tunnel()
    env = worker_env()
    for key in (*PROVIDER_KEYS, *B2_KEYS):
        if env.get(key):
            os.environ.setdefault(key, env[key])
    dsn = TARGETS[target]["dsn"]
    if "{pw}" in dsn:
        remote = env["DATABASE_URL"]
        dsn = dsn.format(pw=remote.split("://", 1)[1].split("@", 1)[0].split(":", 1)[1])
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
            sources = {s["source_id"]: s for s in json.loads((LAB / "sources.json").read_text())["sources"]}
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
