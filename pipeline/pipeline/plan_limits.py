"""Immutable subscription-plan limits loaded once when the worker starts."""

from __future__ import annotations

import threading
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    storage_bytes: int
    credit_micros: int
    source_file_bytes: int
    material_revisions: int
    owned_workspaces: int | None
    files_per_workspace: int
    files_per_upload: int


@dataclass(frozen=True)
class Catalog:
    free: Limits
    pro: Limits

    def for_tier(self, tier: str) -> Limits:
        if tier == "free":
            return self.free
        if tier == "pro":
            return self.pro
        raise RuntimeError(f"unknown plan tier {tier!r}")


_catalog: Catalog | None = None
_catalog_lock = threading.Lock()


def _validate(tier: str, limits: Limits) -> None:
    required = (
        limits.storage_bytes,
        limits.credit_micros,
        limits.source_file_bytes,
        limits.material_revisions,
        limits.files_per_workspace,
        limits.files_per_upload,
    )
    if any(value <= 0 for value in required):
        raise RuntimeError(f"plan {tier!r} contains a non-positive limit")
    if limits.owned_workspaces is not None and limits.owned_workspaces <= 0:
        raise RuntimeError(f"plan {tier!r} contains an invalid workspace limit")
    if limits.files_per_upload > limits.files_per_workspace:
        raise RuntimeError(f"plan {tier!r} files per upload exceeds workspace limit")


def _catalog_from_rows(rows: Iterable[tuple]) -> Catalog:
    plans: dict[str, Limits] = {}
    for row in rows:
        tier = str(row[0])
        if tier not in {"free", "pro"}:
            raise RuntimeError(f"unknown plan tier {tier!r}")
        if tier in plans:
            raise RuntimeError(f"duplicate plan tier {tier!r}")
        limits = Limits(
            storage_bytes=int(row[1]),
            credit_micros=int(row[2]),
            source_file_bytes=int(row[3]),
            material_revisions=int(row[4]),
            owned_workspaces=None if row[5] is None else int(row[5]),
            files_per_workspace=int(row[6]),
            files_per_upload=int(row[7]),
        )
        _validate(tier, limits)
        plans[tier] = limits
    if set(plans) != {"free", "pro"}:
        raise RuntimeError("plan limits must contain exactly free and pro")
    free = plans["free"]
    pro = plans["pro"]
    if (
        pro.storage_bytes < free.storage_bytes
        or pro.credit_micros < free.credit_micros
        or pro.source_file_bytes < free.source_file_bytes
        or pro.material_revisions < free.material_revisions
        or pro.files_per_workspace < free.files_per_workspace
        or pro.files_per_upload < free.files_per_upload
    ):
        raise RuntimeError("pro plan limits cannot be lower than free plan limits")
    if free.owned_workspaces is None and pro.owned_workspaces is not None:
        raise RuntimeError("pro workspaces cannot be finite when free is unlimited")
    if (
        free.owned_workspaces is not None
        and pro.owned_workspaces is not None
        and pro.owned_workspaces < free.owned_workspaces
    ):
        raise RuntimeError("pro workspace limit cannot be lower than free")
    return Catalog(free=free, pro=pro)


def load_once() -> Catalog:
    """Read the entire table once; later calls return the same snapshot."""
    global _catalog
    if _catalog is not None:
        return _catalog
    with _catalog_lock:
        if _catalog is not None:
            return _catalog
        # Delayed import avoids making the database helper's module import open
        # a connection and keeps its test-time DSN replacement intact.
        from .store import db

        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT plan_tier, storage_limit_bytes, credit_limit_micros,
                       source_file_max_bytes, material_revision_limit,
                       owned_workspace_limit, files_per_workspace,
                       files_per_upload
                  FROM plan_limits
                 ORDER BY plan_tier
                """
            )
            loaded = _catalog_from_rows(cur.fetchall())
        _catalog = loaded
        return loaded


def for_tier(tier: str) -> Limits:
    if _catalog is None:
        raise RuntimeError("plan limits catalog not loaded")
    return _catalog.for_tier(tier)
