"""Integration tests for the retrieval SQL, against the gateway's real schema.

Docker but no cassette: embeddings are synthetic unit vectors, so every query
below is a pure test of the statements in ``retrieval/store.py`` and of the
schema they assume. That separation matters because a column rename in
``0001_init.sql`` breaks these silently at runtime and nowhere at import time.

Vectors live in a per-pin side table, so these exercise the seeded qwen-embed
row the fixture workspace is pinned to. ``store.vector_table`` is what keeps
the interpolated table name inside the set the schema actually defines.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import pytest

from pipeline.config import cfg
from pipeline.retrieval import store
from pipeline.retrieval.chunking import search_query_terms, tokenize_for_search
from pipeline.retrieval.usage_extract import NormalizedUsage
from pipeline.store import db

pytestmark = pytest.mark.integration


def _install_running_pipeline_claim(
    conn,
    *,
    workspace_id: str,
    file_id: str,
    actor_user_id: str,
    source_etag: str = "etag-a",
) -> tuple[str, int, str]:
    reservation_id = f"cr_{secrets.token_hex(6)}"
    job_id = f"job_{secrets.token_hex(6)}"
    conn.execute(
        """
        INSERT INTO provider_sessions
          (id, actor_user_id, workspace_id, surface, expires_at)
        VALUES (%s,%s,%s,'ingest',now()+interval '1 hour')
        """,
        (reservation_id, actor_user_id, workspace_id),
    )
    conn.execute(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'ingest', %s::jsonb, 'running', 1, now()+interval '3 minutes')
        """,
        (
            job_id,
            json.dumps(
                {
                    "actorUserId": actor_user_id,
                    "fileId": file_id,
                    "reservationId": reservation_id,
                    "sourceETag": source_etag,
                    "sourceRevision": 1,
                    "workspaceId": workspace_id,
                }
            ),
        ),
    )
    attempt_id = conn.execute(
        """
        INSERT INTO ingest_job_attempts
          (job_id, operation_id, attempt, job_type, environment, host_id,
           worker_instance_id, trace_id, queued_at)
        VALUES (%s,%s,1,'ingest','test','test-host','test-worker',%s,now())
        RETURNING id
        """,
        (job_id, f"op_{secrets.token_hex(6)}", f"trace_{secrets.token_hex(6)}"),
    ).fetchone()[0]
    return job_id, int(attempt_id), reservation_id


def _commit_lifecycle_while_job_is_locked(
    dsn: str,
    job_id: str,
    lifecycle: Callable[[object], None],
) -> None:
    import psycopg

    def commit_lifecycle() -> None:
        with psycopg.connect(dsn) as conn:
            lifecycle(conn)

    with psycopg.connect(dsn) as worker_conn:
        worker_conn.execute("SELECT id FROM jobs WHERE id=%s FOR UPDATE", (job_id,))
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.submit(commit_lifecycle).result(timeout=5)
        worker_conn.rollback()


def _assert_heartbeat_cancelled_claim(
    conn,
    *,
    job_id: str,
    attempt_id: int,
    reservation_id: str,
    attempt_status: str,
    error_code: str,
) -> None:
    with conn.cursor() as cur:
        assert not db.heartbeat_job(cur, job_id, 180, 1)
    state = conn.execute(
        """
        SELECT j.status, j.lease_expires_at, a.status, a.error_code, ps.status
        FROM jobs j
        JOIN ingest_job_attempts a ON a.id=%s
        JOIN provider_sessions ps ON ps.id=%s
        WHERE j.id=%s
        """,
        (attempt_id, reservation_id, job_id),
    ).fetchone()
    assert state == ("failed", None, attempt_status, error_code, "released")


def test_provider_capacity_leases_enforce_weighted_limit(workspace):
    import psycopg

    first = f"pcl_{secrets.token_hex(6)}"
    second = f"pcl_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        assert db.acquire_provider_capacity(
            cur,
            lease_id=first,
            provider="elevenlabs:scribe_v2",
            units=4,
            capacity=4,
            lease_seconds=60,
        )
        assert not db.acquire_provider_capacity(
            cur,
            lease_id=second,
            provider="elevenlabs:scribe_v2",
            units=1,
            capacity=4,
            lease_seconds=60,
        )
        before = cur.execute(
            "SELECT expires_at FROM provider_capacity_leases WHERE id=%s", (first,)
        ).fetchone()[0]
        assert db.renew_provider_capacity(cur, first, 120)
        after = cur.execute(
            "SELECT expires_at FROM provider_capacity_leases WHERE id=%s", (first,)
        ).fetchone()[0]
        assert after > before
        db.release_provider_capacity(cur, first)
        assert not db.renew_provider_capacity(cur, first, 120)
        assert db.acquire_provider_capacity(
            cur,
            lease_id=second,
            provider="elevenlabs:scribe_v2",
            units=1,
            capacity=4,
            lease_seconds=60,
        )


def test_ingest_provider_call_links_context_and_usage_atomically(workspace):
    import psycopg

    call_id = f"pc_{secrets.token_hex(6)}"
    file_id = workspace.add_file("provider-context.txt")
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute("UPDATE files SET source_etag='etag-a' WHERE id=%s", (file_id,))
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        with pytest.raises(RuntimeError, match="requires a job attempt"):
            db.open_provider_call(
                cur,
                reservation_id,
                f"pc_{secrets.token_hex(6)}",
                "llm",
                "ingest_summary",
                "instant",
            )
        db.open_provider_call(
            cur,
            reservation_id,
            call_id,
            "llm",
            "ingest_summary",
            "instant",
            job_attempt_id=attempt_id,
            context_system_tokens=11,
            context_tool_tokens=7,
            context_conversation_tokens=23,
            context_total_tokens=41,
            context_window_tokens=128_000,
            context_counting_method="test_estimator",
            context_counting_version=1,
        )
        db.release_credit_reservation(cur, reservation_id)
        db.settle_ingest_provider_call(
            cur,
            session_id=reservation_id,
            call_id=call_id,
            kind="llm",
            purpose="ingest_summary",
            thinking="instant",
            provider="deepseek",
            model="deepseek/flash",
            catalog_provider_slug="deepseek",
            catalog_model_slug="flash",
            model_version=1,
            usage=NormalizedUsage(input_tokens=44, output_tokens=5),
            credit_micros=0,
        )

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        row = conn.execute(
            """
            SELECT pc.status, pc.context_total_tokens, ue.input_tokens,
                   ue.provider_call_id, ps.status
            FROM provider_calls pc
            JOIN provider_sessions ps ON ps.id = pc.reservation_id
            JOIN usage_events ue
              ON ue.reservation_id = pc.reservation_id
             AND ue.provider_call_id = pc.id
            WHERE pc.id = %s
            """,
            (call_id,),
        ).fetchone()
        assert row == ("applied", 41, 44, call_id, "settled")
        conn.execute("DELETE FROM usage_events WHERE provider_call_id = %s", (call_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id = %s", (reservation_id,))
        conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


def test_ingest_provider_call_rejects_a_closed_exact_attempt(workspace):
    import psycopg

    file_id = workspace.add_file("provider-closed-attempt.txt")
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute("UPDATE files SET source_etag='etag-a' WHERE id=%s", (file_id,))
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        cur.execute(
            "UPDATE ingest_job_attempts SET status='lease_expired' WHERE id=%s",
            (attempt_id,),
        )
        cur.execute(
            "UPDATE jobs SET status='pending', lease_expires_at=NULL WHERE id=%s",
            (job_id,),
        )
        with pytest.raises(RuntimeError, match="claim is no longer current"):
            db.open_provider_call(
                cur,
                reservation_id,
                f"pc_{secrets.token_hex(6)}",
                "embedding",
                "indexing",
                "",
                job_attempt_id=attempt_id,
            )

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM provider_sessions WHERE id = %s", (reservation_id,))
        conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


def test_ingest_provider_admission_serializes_with_lease_reclaim(workspace):
    import psycopg

    file_id = workspace.add_file("provider-reclaim-race.txt")
    call_id = f"pc_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn) as setup_conn:
        setup_conn.execute(
            "UPDATE files SET source_etag='etag-a' WHERE id=%s", (file_id,)
        )
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            setup_conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        setup_conn.execute(
            "UPDATE jobs SET lease_expires_at=now()+interval '500 milliseconds' WHERE id=%s",
            (job_id,),
        )

    def reclaim() -> list[dict]:
        with psycopg.connect(workspace.dsn) as reaper_conn, reaper_conn.cursor() as cur:
            reclaimed = db.reclaim_expired_leases(
                cur,
                max_attempts={"ingest": 2},
                backoff_base_s={"ingest": 0},
            )
            reaper_conn.commit()
            return reclaimed

    with psycopg.connect(workspace.dsn) as worker_conn, worker_conn.cursor() as cur:
        db.open_provider_call(
            cur,
            reservation_id,
            call_id,
            "embedding",
            "indexing",
            "",
            job_attempt_id=attempt_id,
        )
        time.sleep(0.8)
        with ThreadPoolExecutor(max_workers=1) as executor:
            # Admission holds the job before the attempt. The reaper's
            # SKIP LOCKED scan must skip it instead of changing the job and
            # then waiting behind the attempt lock.
            assert executor.submit(reclaim).result(timeout=2) == []
        worker_conn.commit()

    reclaimed = reclaim()
    assert len(reclaimed) == 1
    assert reclaimed[0]["id"] == job_id
    assert reclaimed[0]["outcome"] == "pending"

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        state = conn.execute(
            """
            SELECT j.status, a.status
            FROM jobs j
            JOIN ingest_job_attempts a ON a.id=%s
            WHERE j.id=%s
            """,
            (attempt_id, job_id),
        ).fetchone()
        assert state == ("pending", "lease_expired")
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))


def test_stale_donor_cleanup_leaves_successor_preview(workspace):
    import psycopg

    from pipeline.ingest import worker

    file_id = workspace.add_file("successor-preview.docx")
    successor_preview = "previews/successor/preview.pdf"
    with psycopg.connect(workspace.dsn) as conn:
        conn.execute(
            """
            UPDATE files
            SET source_etag='etag-a', status='processing', preview_blob_path=%s
            WHERE id=%s
            """,
            (successor_preview, file_id),
        )
        job_id, old_attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        conn.execute(
            "UPDATE ingest_job_attempts SET status='lease_expired' WHERE id=%s",
            (old_attempt_id,),
        )
        conn.execute(
            """
            UPDATE jobs
            SET status='running', attempts=2,
                lease_expires_at=now()+interval '3 minutes'
            WHERE id=%s
            """,
            (job_id,),
        )
        conn.execute(
            """
            INSERT INTO ingest_job_attempts
              (job_id, operation_id, attempt, job_type, environment, host_id,
               worker_instance_id, trace_id, queued_at)
            VALUES (%s,%s,2,'ingest','test','test-host','successor',%s,now())
            """,
            (job_id, f"op_{secrets.token_hex(6)}", f"trace_{secrets.token_hex(6)}"),
        )

    assert not worker._clear_preview_blob(
        file_id,
        1,
        "etag-a",
        workspace.user_id,
        job_id=job_id,
        attempt=1,
        workspace_id=workspace.id,
        reservation_id=reservation_id,
    )

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        assert (
            conn.execute(
                "SELECT preview_blob_path FROM files WHERE id=%s", (file_id,)
            ).fetchone()[0]
            == successor_preview
        )
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))


def test_applied_ingest_provider_receipt_exact_replay_is_duplicate(workspace):
    import psycopg

    reservation_id = ""
    call_id = f"pc_{secrets.token_hex(6)}"
    file_id = workspace.add_file("provider-replay.txt")
    receipt = {
        "session_id": reservation_id,
        "call_id": call_id,
        "kind": "llm",
        "purpose": "ingest_summary",
        "thinking": "high",
        "provider": "openai",
        "model": "gpt-test",
        "catalog_provider_slug": "openai",
        "catalog_model_slug": "gpt-test",
        "model_version": 7,
        "usage": NormalizedUsage(
            input_tokens=101,
            output_tokens=29,
            cached_read_tokens=17,
            cache_write_tokens=3,
            reasoning_tokens=11,
            anomaly="test_anomaly",
        ),
        "credit_micros": 123_456,
        "units": 130,
        "unit": "tokens",
    }
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute("UPDATE files SET source_etag='etag-a' WHERE id=%s", (file_id,))
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        receipt["session_id"] = reservation_id
        db.open_provider_call(
            cur,
            reservation_id,
            call_id,
            "llm",
            "ingest_summary",
            "high",
            job_attempt_id=attempt_id,
        )
        assert db.settle_ingest_provider_call(cur, **receipt) == "applied"
        db.release_credit_reservation(cur, reservation_id)
        assert db.settle_ingest_provider_call(cur, **receipt) == "duplicate"
        count = cur.execute(
            "SELECT count(*) FROM usage_events WHERE provider_call_id = %s",
            (call_id,),
        ).fetchone()[0]
        assert count == 1

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM usage_events WHERE provider_call_id = %s", (call_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id = %s", (reservation_id,))
        conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


def test_applied_ingest_provider_receipt_conflicting_replays_are_rejected(workspace):
    import psycopg

    reservation_id = ""
    other_reservation_id = f"cr_{secrets.token_hex(6)}"
    call_id = f"pc_{secrets.token_hex(6)}"
    file_id = workspace.add_file("provider-conflict.txt")
    usage = NormalizedUsage(
        input_tokens=101,
        output_tokens=29,
        cached_read_tokens=17,
        cache_write_tokens=3,
        reasoning_tokens=11,
        anomaly="test_anomaly",
    )
    receipt = {
        "session_id": reservation_id,
        "call_id": call_id,
        "kind": "llm",
        "purpose": "ingest_summary",
        "thinking": "high",
        "provider": "openai",
        "model": "gpt-test",
        "catalog_provider_slug": "openai",
        "catalog_model_slug": "gpt-test",
        "model_version": 7,
        "usage": usage,
        "credit_micros": 123_456,
        "units": 130,
        "unit": "tokens",
    }
    changed_usage = {
        field: NormalizedUsage(
            **{
                **usage.__dict__,
                field: "other_anomaly"
                if field == "anomaly"
                else getattr(usage, field) + 1,
            }
        )
        for field in usage.__dict__
    }
    conflicts = [
        {"session_id": other_reservation_id},
        {"call_id": f"pc_{secrets.token_hex(6)}"},
        {"kind": "embedding"},
        {"purpose": "different_purpose"},
        {"thinking": "instant"},
        {"provider": "anthropic"},
        {"model": "different-model"},
        {"catalog_provider_slug": "different-provider"},
        {"catalog_model_slug": "different-model"},
        {"model_version": 8},
        *({"usage": changed} for changed in changed_usage.values()),
        {"credit_micros": 123_457},
        {"units": 131},
        {"unit": "seconds"},
    ]

    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute("UPDATE files SET source_etag='etag-a' WHERE id=%s", (file_id,))
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        receipt["session_id"] = reservation_id
        cur.execute(
            """
            INSERT INTO provider_sessions (
              id, actor_user_id, workspace_id, surface, reserved_micros,
              expires_at
            ) VALUES (%s, %s, %s, 'ingest', 0, now() + interval '30 minutes')
            """,
            (other_reservation_id, workspace.user_id, workspace.id),
        )
        db.open_provider_call(
            cur,
            reservation_id,
            call_id,
            "llm",
            "ingest_summary",
            "high",
            job_attempt_id=attempt_id,
        )
        assert db.settle_ingest_provider_call(cur, **receipt) == "applied"
        for conflict in conflicts:
            replay = {**receipt, **conflict}
            with pytest.raises(db.ProviderSettlementRejected, match="(conflicts|stub)"):
                db.settle_ingest_provider_call(cur, **replay)

        count = cur.execute(
            "SELECT count(*) FROM usage_events WHERE provider_call_id = %s",
            (call_id,),
        ).fetchone()[0]
        assert count == 1

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM usage_events WHERE provider_call_id = %s", (call_id,))
        conn.execute(
            "DELETE FROM provider_sessions WHERE id = ANY(%s)",
            ([reservation_id, other_reservation_id],),
        )
        conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


def test_ingest_provider_receipt_expires_even_before_sweeper(workspace):
    import psycopg

    call_id = f"pc_{secrets.token_hex(6)}"
    file_id = workspace.add_file("provider-expiry.txt")
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute("UPDATE files SET source_etag='etag-a' WHERE id=%s", (file_id,))
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        db.open_provider_call(
            cur,
            reservation_id,
            call_id,
            "audio",
            "transcription",
            "",
            job_attempt_id=attempt_id,
            receipt_timeout_seconds=1,
        )
        cur.execute(
            """UPDATE provider_calls
               SET opened_at=now()-interval '2 seconds',
                   receipt_deadline_at=now()-interval '1 second'
               WHERE id=%s""",
            (call_id,),
        )
        result = db.settle_ingest_provider_call(
            cur,
            session_id=reservation_id,
            call_id=call_id,
            kind="audio",
            purpose="transcription",
            thinking="",
            provider="elevenlabs",
            model="scribe_v2",
            catalog_provider_slug="",
            catalog_model_slug="",
            model_version=0,
            usage=NormalizedUsage(),
            credit_micros=0,
            units=10,
            unit="seconds",
        )
        assert result == "expired"

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        row = conn.execute(
            """SELECT status, error_code FROM provider_calls WHERE id=%s""",
            (call_id,),
        ).fetchone()
        assert row == ("abandoned", "receipt_timeout")
        count = conn.execute(
            """SELECT count(*) FROM usage_events WHERE provider_call_id=%s""",
            (call_id,),
        ).fetchone()[0]
        assert count == 0
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))


def test_provider_call_open_enforces_terminal_slot_and_idempotency(workspace):
    import psycopg

    reservation_id = f"cr_{secrets.token_hex(6)}"
    terminal_call_id = f"pc_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO provider_sessions (
              id, actor_user_id, workspace_id, surface, reserved_micros,
              expires_at
            ) VALUES (%s, %s, %s, 'chat', 0, now() + interval '30 minutes')
            """,
            (reservation_id, workspace.user_id, workspace.id),
        )
        with pytest.raises(RuntimeError, match="terminal provider call is not allowed"):
            db.open_provider_call(
                cur, reservation_id, terminal_call_id, "llm", "terminal", "instant"
            )

        cur.execute(
            "UPDATE provider_sessions SET credits_exhausted_at = now() WHERE id = %s",
            (reservation_id,),
        )
        with pytest.raises(RuntimeError, match="only a terminal provider call"):
            db.open_provider_call(
                cur,
                reservation_id,
                f"pc_{secrets.token_hex(6)}",
                "llm",
                "agent",
                "instant",
            )

        db.open_provider_call(
            cur,
            reservation_id,
            terminal_call_id,
            "llm",
            "terminal",
            "instant",
            receipt_timeout_seconds=60,
        )
        db.open_provider_call(
            cur,
            reservation_id,
            terminal_call_id,
            "llm",
            "terminal",
            "instant",
            receipt_timeout_seconds=60,
        )
        receipt_window = cur.execute(
            """
            SELECT extract(epoch FROM receipt_deadline_at - opened_at)
              FROM provider_calls WHERE id = %s
            """,
            (terminal_call_id,),
        ).fetchone()[0]
        assert receipt_window == 60
        with pytest.raises(
            RuntimeError, match="terminal provider call was already used"
        ):
            db.open_provider_call(
                cur,
                reservation_id,
                f"pc_{secrets.token_hex(6)}",
                "llm",
                "terminal",
                "instant",
            )
        with pytest.raises(RuntimeError, match="conflicts with an existing call"):
            db.open_provider_call(
                cur, reservation_id, terminal_call_id, "llm", "terminal", "high"
            )

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM provider_sessions WHERE id = %s", (reservation_id,))


def test_parse_attempt_page_charge_is_idempotent_and_settles_session(workspace):
    import psycopg

    reservation_id = f"cr_{secrets.token_hex(6)}"
    idempotency_key = f"parse:job_{secrets.token_hex(4)}:1"
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT used_micros FROM user_credits WHERE user_id = %s",
            (workspace.user_id,),
        )
        row = cur.fetchone()
        used_before = int(row[0]) if row else 0
        cur.execute(
            """
            INSERT INTO provider_sessions (
              id, actor_user_id, workspace_id, trace_id, surface,
              reserved_micros, expires_at
            ) VALUES (%s, %s, %s, 'trace-parse', 'ingest', 0,
                      now() + interval '30 minutes')
            """,
            (reservation_id, workspace.user_id, workspace.id),
        )
        for _ in range(2):
            db.record_usage_event(
                cur,
                actor_user_id=workspace.user_id,
                workspace_id=workspace.id,
                kind="parse",
                surface="ingest",
                provider="ingest-host",
                units=2,
                unit="pages",
                parse_pages=2,
                parse_ocr_pages=1,
                parse_cpu_milliseconds=1200,
                parse_elapsed_milliseconds=2000,
                credit_micros=db.credits_for_parse_pages(
                    2, 1, digital_rate=31_000_000, ocr_rate=52_000_000
                ),
                reservation_id=reservation_id,
                idempotency_key=idempotency_key,
            )
        db.close_credit_reservation(cur, reservation_id)

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        event = conn.execute(
            """
            SELECT count(*), max(parse_pages), max(parse_ocr_pages),
                   max(parse_cpu_milliseconds), max(credit_micros)
              FROM usage_events WHERE idempotency_key = %s
            """,
            (idempotency_key,),
        ).fetchone()
        status = conn.execute(
            "SELECT status FROM provider_sessions WHERE id = %s",
            (reservation_id,),
        ).fetchone()[0]
        used_after = conn.execute(
            "SELECT used_micros FROM user_credits WHERE user_id = %s",
            (workspace.user_id,),
        ).fetchone()[0]
        assert event == (1, 2, 1, 1200, 83_000_000)
        assert status == "settled"
        assert used_after - used_before == 83_000_000
        conn.execute(
            "DELETE FROM usage_events WHERE idempotency_key = %s",
            (idempotency_key,),
        )
        conn.execute("DELETE FROM provider_sessions WHERE id = %s", (reservation_id,))
        conn.execute(
            "UPDATE user_credits SET used_micros = %s WHERE user_id = %s",
            (used_before, workspace.user_id),
        )


def _unit_vector(axis: int) -> list[float]:
    """A one-hot vector, so cosine distance between two of them is predictable."""
    vector = [0.0] * cfg.embedding_dim
    vector[axis % cfg.embedding_dim] = 1.0
    return vector


async def _write(
    ws, file_id: str, texts: list[str], *, axis_base: int = 0, lang: str = "en"
) -> None:
    content_hash = hashlib.sha256("\x00".join(texts).encode()).hexdigest()
    association = await store.attach_file_content(
        workspace_id=ws.id, file_id=file_id, content_hash=content_hash
    )
    rows = [
        {
            "id": f"{file_id}_c{i}",
            "chunk_idx": i,
            "section_path": "Ch 1 › Section",
            "text": text,
            "indexed_text": text,
            "token_count": len(text) // 4,
            "page_start": i + 1,
            "page_end": i + 1,
            "regions": [
                {"page": i + 1, "bbox": [1, 2, 3, 4], "space": "page-1000-topleft"}
            ],
            "lang": lang,
            "search_text": tokenize_for_search(text),
            "embedding": store.vector_literal(_unit_vector(axis_base + i)),
        }
        for i, text in enumerate(texts)
    ]
    await store.replace_content_chunks(
        workspace_id=ws.id, content_id=association["content_id"], rows=rows
    )
    await store.mark_content_ready(association["content_id"])


# ------------------------------------------------------------------- search


async def test_lexical_half_matches_without_a_useful_vector(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(
        workspace, file_id, ["Chlorophyll absorbs red light", "Unrelated text"]
    )

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(999),
        terms=search_query_terms("chlorophyll absorbs"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == "Chlorophyll absorbs red light"
    assert rows[0]["file_name"] == "bio.txt"


async def test_lexical_half_stems_and_ignores_stopwords(workspace):
    """A question's function words must not decide the lexical ranking, and an
    inflected query word must still reach the passage that uses another form."""
    file_id = workspace.add_file("bio.txt")
    await _write(
        workspace,
        file_id,
        [
            "The the the a of of of and and an and the the a",
            "Chlorophyll absorbs red light",
        ],
    )

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(999),
        terms=search_query_terms("what does the chlorophyll absorb?"),
        file_ids=None,
        candidates=10,
    )

    # The stopword chunk still arrives through the vector leg (every chunk is
    # a vector candidate here); it must not lead on lexical grounds.
    assert rows[0]["text"] == "Chlorophyll absorbs red light"


async def test_a_passage_matching_every_term_outranks_frequent_partial_matches(
    workspace,
):
    """'Figure 3.20': by OR alone every passage that says 'figure' many times
    outranks the one passage that says '3.20', because ts_rank_cd rewards
    frequency and the rare token adds little. All-terms matches go first, and
    for a two- or three-term query they count at full weight.

    The vector leg is made to prefer the three 'figure' passages, in order,
    over the target. At half weight a lexical rank could only lift the target
    over the weakest of them; the full-weight exact tier puts it first.
    """
    file_id = workspace.add_file("bio.txt")
    spam = "Figure figure figure figure figure figure figure figure figure"
    target = "Figure 3.20 shows the rate of photosynthesis against light intensity"
    await _write(workspace, file_id, [spam, spam + " again", spam + " more", target])
    query = [0.0] * cfg.embedding_dim
    for axis, weight in enumerate((0.9, 0.8, 0.7, 0.6)):
        query[axis] = weight

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=query,
        terms=search_query_terms("Figure 3.20"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == target


async def test_a_long_question_does_not_get_the_exact_match_boost(workspace):
    """A passage that repeats every word of a four-term question echoes its
    phrasing, not its answer; only two- and three-term lookups count at full
    weight. Here the vector leg prefers the answer and the echo must not win."""
    file_id = workspace.add_file("bio.txt")
    answer = (
        "Bats and insects evolved wings independently; this is convergent evolution"
    )
    echo = "Give an example of convergent evolution in this exercise"
    await _write(workspace, file_id, [answer, echo])
    query = [0.0] * cfg.embedding_dim
    query[0], query[1] = 0.9, 0.8

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=query,
        terms=search_query_terms("convergent evolution give example"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == answer


async def test_a_short_question_with_function_words_is_not_a_lookup(workspace):
    """'What is CIL-LLM?' is three words as typed. Under the english
    configuration 'what' and 'is' are stopwords, so counting after stopword
    removal made it a one-identifier lookup and the tier promoted every
    English caption and reference row that named the model over the abstract.
    A lookup is content only; a query that carries a function word of the
    chunk's language is a question and its all-terms echo stays at half weight."""
    file_id = workspace.add_file("paper.txt")
    answer = "CIL-LLM learns classes incrementally by prompting a frozen model"
    echo = "[12] What is CIL-LLM? What is CIL-LLM? What is CIL-LLM? See ref."
    await _write(workspace, file_id, [answer, echo])
    query = [0.0] * cfg.embedding_dim
    query[0], query[1] = 0.9, 0.8

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=query,
        terms=search_query_terms("What is CIL-LLM?"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == answer
    assert all(row["score"] == row["flat_score"] for row in rows)


async def test_vector_half_matches_without_shared_vocabulary(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["alpha", "beta"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(1),
        terms=search_query_terms("nothing matches this"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == "beta"


async def test_cjk_is_retrievable_through_the_bigram_tokenizer(workspace):
    """Postgres' built-in configurations make one token of a Chinese sentence;
    the application-side bigrams are what make this query possible at all."""
    file_id = workspace.add_file("zh.txt")
    await _write(
        workspace, file_id, ["光合作用把光能转化为化学能", "无关内容"], lang="zh"
    )

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(999),
        terms=search_query_terms("光合作用"),
        file_ids=None,
        candidates=10,
    )

    assert rows and rows[0]["text"].startswith("光合作用")


async def test_a_french_chunk_is_stemmed_and_destopped_in_french(workspace):
    """'english' on French text keeps 'les', 'des', 'du' as index terms and
    never matches 'plante' to 'plantes'. Each chunk is indexed with its own
    language's configuration, and the query is parsed the same way for it."""
    file_id = workspace.add_file("bio-fr.txt")
    await _write(
        workspace,
        file_id,
        [
            "Les les les des des du et et la la une une",
            "Les plantes absorbent la lumière rouge",
        ],
        lang="fr",
    )

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(999),
        terms=search_query_terms("des plante du lumière"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == "Les plantes absorbent la lumière rouge"
    assert rows[0]["lang"] == "fr"
    # 'des' and 'du' are French stopwords, so the stopword-only chunk has
    # nothing to match and only the vector leg places it.
    assert [row["lex_rank"] for row in rows] == [1, None]


async def test_a_single_cjk_term_does_not_get_the_exact_match_boost(workspace):
    """'光合作用' is one term to a reader and three bigrams to the tokenizer.
    Counting bigrams made every two-character-plus CJK word a 'lookup'; the
    tier counts runs, so this behaves like the single Latin word it is."""
    file_id = workspace.add_file("zh.txt")
    # The vector leg prefers the answer; both match lexically (the answer on
    # one bigram, the echo on all three). Only the tier's full weight would
    # let the echo's lexical rank overturn the vector order.
    answer = "叶绿素吸收光能，光合速率随光强上升"
    echo = "光合作用 光合作用 光合作用 光合作用 光合作用"
    await _write(workspace, file_id, [answer, echo], lang="zh")
    query = [0.0] * cfg.embedding_dim
    query[0], query[1] = 0.9, 0.8

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=query,
        terms=search_query_terms("光合作用"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == answer


async def test_two_cjk_terms_are_a_lookup(workspace):
    file_id = workspace.add_file("zh.txt")
    spam = "标准 标准 标准 标准 标准 标准 标准 标准 标准 标准"
    target = "标准差的计算方法见附录"
    await _write(
        workspace, file_id, [spam, spam + " 再", spam + " 又", target], lang="zh"
    )
    query = [0.0] * cfg.embedding_dim
    for axis, weight in enumerate((0.9, 0.8, 0.7, 0.6)):
        query[axis] = weight

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=query,
        terms=search_query_terms("标准差 计算"),
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == target


async def test_search_rows_carry_the_evidence_from_each_leg(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["Chlorophyll absorbs red light", "alpha"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(1),
        terms=search_query_terms("chlorophyll"),
        file_ids=None,
        candidates=10,
    )

    by_text = {row["text"]: row for row in rows}
    lexical = by_text["Chlorophyll absorbs red light"]
    vector_only = by_text["alpha"]
    assert lexical["lex_rank"] == 1 and lexical["vec_rank"] == 2
    assert vector_only["lex_rank"] is None and vector_only["vec_rank"] == 1
    assert vector_only["vec_dist"] < lexical["vec_dist"]
    # No exact tier fired (one term), so the flat fusion is the real one.
    assert all(row["score"] == row["flat_score"] for row in rows)


async def test_search_events_store_features_and_ids_only(workspace):
    event = {
        "trace_id": "t" * 32,
        "workspace_id": workspace.id,
        "actor_user_id": None,
        "message_id": "m_1",
        "search_index": 1,
        "hits_lang": "en",
        "query_terms": 2,
        "cjk_runs": 0,
        "scope_files": 1,
        "embed_ms": 12,
        "sql_ms": 3,
        "hits": 2,
        "prior_overlap": 0,
        "chunk_ids": ["c1", "c2"],
        "file_ids": ["f1", "f1"],
        "chunk_langs": ["en", "und"],
        "vec_ranks": [1, None],
        "lex_ranks": [None, 1],
        "vec_dists": [0.31, None],
        "tier_only": [False, True],
        "cited": [True, False],
    }

    await store.record_search_events([event])

    stored = workspace.scalar(
        "SELECT ARRAY[vec_ranks::text, lex_ranks::text, tier_only::text, cited::text] "
        "FROM rag_search_events WHERE workspace_id = %s",
        (workspace.id,),
    )
    assert stored == ["{1,NULL}", "{NULL,1}", "{f,t}", "{t,f}"]
    columns = workspace.scalar(
        "SELECT array_agg(column_name::text) FROM information_schema.columns "
        "WHERE table_name = 'rag_search_events'"
    )
    assert not {"query", "text", "passages"} & set(columns)


async def test_search_is_scoped_to_the_workspace_and_the_file_filter(workspace):
    keep = workspace.add_file("keep.txt")
    drop = workspace.add_file("drop.txt")
    await _write(workspace, keep, ["Chlorophyll absorbs red light"])
    await _write(workspace, drop, ["Chlorophyll absorbs blue light"], axis_base=10)

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(0),
        terms=search_query_terms("chlorophyll"),
        file_ids=[keep],
        candidates=10,
    )

    assert {row["file_id"] for row in rows} == {keep}


async def test_chunks_carry_the_provenance_a_citation_needs(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["Chlorophyll absorbs red light"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(0),
        terms=search_query_terms("chlorophyll"),
        file_ids=None,
        candidates=10,
    )

    row = rows[0]
    assert (row["page_start"], row["page_end"]) == (1, 1)
    assert store.decode_regions(row["regions"])[0]["space"] == "page-1000-topleft"
    assert row["section_path"] == "Ch 1 › Section"


async def test_reindexing_removes_the_tail_of_the_previous_run(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["one", "two", "three"])
    await _write(workspace, file_id, ["one"])

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks c JOIN rag_file_contents fc "
            "ON fc.content_id = c.content_id WHERE fc.file_id = %s",
            (file_id,),
        )
        == 1
    )


# --------------------------------------------------------- structure & tree


async def test_workspace_outline_groups_files_under_chapters(workspace):
    chapter = workspace.add_chapter("Biology")
    filed = workspace.add_file("filed.txt", chapter)
    unfiled = workspace.add_file("unfiled.txt")
    await _write(workspace, filed, ["alpha"])
    content_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (filed,)
    )
    await store.upsert_content_summary(
        workspace_id=workspace.id,
        content_id=content_id,
        fingerprint="fp",
        descriptor="A short descriptor.",
        summary="A summary.",
    )

    outline = await store.workspace_outline(workspace.id)

    assert [c["name"] for c in outline["chapters"]] == ["Biology"]
    by_id = {f["id"]: f for f in outline["files"]}
    assert by_id[filed]["chapter_id"] == chapter and by_id[filed]["chunks"] == 1
    assert by_id[filed]["descriptor"] == "A short descriptor."
    assert by_id[filed]["summary"] == "A summary."
    assert by_id[unfiled]["chapter_id"] is None and by_id[unfiled]["chunks"] == 0


async def test_deleting_a_chapter_does_not_break_its_files(workspace):
    """The chapter FK is ON DELETE SET NULL, so deleting a chapter unfiles its
    files rather than deleting them."""
    chapter = workspace.add_chapter("Doomed")
    file_id = workspace.add_file("a.txt", chapter)

    workspace.scalar("DELETE FROM chapters WHERE id = %s RETURNING id", (chapter,))

    assert (
        workspace.scalar("SELECT chapter_id FROM files WHERE id = %s", (file_id,))
        is None
    )


async def test_duplicate_alias_survives_deleting_first_file(workspace):
    first = workspace.add_file("a.txt")
    second = workspace.add_file("b.txt")
    await _write(workspace, first, ["Chlorophyll absorbs red light"])
    content_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (first,)
    )
    content_hash = workspace.scalar(
        "SELECT content_hash FROM rag_contents WHERE id = %s", (content_id,)
    )
    duplicate = await store.attach_file_content(
        workspace_id=workspace.id, file_id=second, content_hash=content_hash
    )

    assert duplicate["ready"]
    workspace.scalar("DELETE FROM files WHERE id = %s RETURNING id", (first,))

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(0),
        terms=search_query_terms("chlorophyll"),
        file_ids=[second],
        candidates=10,
    )
    read = await store.read_file_range(
        workspace_id=workspace.id, file_id=second, start=0, count=1
    )

    assert rows and rows[0]["file_id"] == second and rows[0]["file_name"] == "b.txt"
    assert read and read[0]["file_id"] == second
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_contents WHERE id = %s", (content_id,)
        )
        == 1
    )


async def test_deleting_a_file_takes_its_index_with_it(workspace):
    file_id = workspace.add_file("a.txt")
    await _write(workspace, file_id, ["alpha"])
    content_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (file_id,)
    )

    workspace.scalar("DELETE FROM files WHERE id = %s RETURNING id", (file_id,))

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks WHERE content_id = %s", (content_id,)
        )
        == 0
    )


# --------------------------------------------------------- jobs & donor copy


def _claim_ids(ws) -> tuple[str, str]:
    """Creator/waiter job ids for a contended-content test.

    jobs rows have no workspace foreign key, so they outlive the fixture's
    teardown and a literal id would collide with the next test in the session.
    """
    suffix = ws.id[-8:]
    return f"job_creator_{suffix}", f"job_waiter_{suffix}"


def _isolate_job(cur, job_id: str) -> None:
    """The shared test DB has seed pending jobs; claim_job sees the whole queue."""
    cur.execute(
        """
        UPDATE jobs
        SET not_before = now() + interval '7 days'
        WHERE status = 'pending' AND id <> %s
        """,
        (job_id,),
    )


def test_claim_honours_not_before(workspace):
    from pipeline.store import db

    job_id = f"job_{workspace.id[-8:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, not_before)
        VALUES (%s, 'ingest', '{}'::jsonb, now() + interval '1 hour')
        RETURNING id
        """,
        (job_id,),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        _isolate_job(cur, job_id)
        claimed = db.claim_job(cur, "ingest", 180)
        conn.commit()
    assert claimed is None
    assert (
        workspace.scalar("SELECT status FROM jobs WHERE id = %s", (job_id,))
        == "pending"
    )


def test_claim_selects_only_the_requested_stage(workspace):
    from pipeline.store import db

    suffix = workspace.id[-8:]
    parse_job = f"job_parse_{suffix}"
    ingest_job = f"job_ingest_{suffix}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload)
        VALUES (%s, 'parse', '{}'::jsonb), (%s, 'ingest', '{}'::jsonb)
        RETURNING id
        """,
        (parse_job, ingest_job),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE jobs SET not_before = now() + interval '7 days'
            WHERE status = 'pending' AND id NOT IN (%s, %s)
            """,
            (parse_job, ingest_job),
        )
        claimed = db.claim_job(cur, "parse", 180)
        conn.commit()

    assert claimed is not None
    assert claimed["id"] == parse_job
    assert claimed["type"] == "parse"
    assert (
        workspace.scalar("SELECT status FROM jobs WHERE id = %s", (ingest_job,))
        == "pending"
    )


def test_requeue_then_claim(workspace):
    from pipeline.store import db

    job_id = f"job_{workspace.id[-8:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'ingest', '{}'::jsonb, 'running', 1)
        RETURNING id
        """,
        (job_id,),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        assert (
            db.requeue_job(
                cur,
                job_id=job_id,
                job_type="ingest",
                workspace_id=workspace.id,
                error="provider blip",
                backoff_s=0,
            )
            == "pending"
        )
        _isolate_job(cur, job_id)
        claimed = db.claim_job(cur, "ingest", 180)
        conn.commit()
    assert claimed is not None
    assert claimed["id"] == job_id
    assert claimed["attempts"] == 2


def test_capacity_yield_does_not_spend_an_attempt(workspace):
    from pipeline.store import db

    job_id = f"job_{workspace.id[-8:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'ingest', '{}'::jsonb, 'running', 1)
        RETURNING id
        """,
        (job_id,),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        db.release_job_for_capacity(cur, job_id, 1, backoff_s=0)
        _isolate_job(cur, job_id)
        claimed = db.claim_job(cur, "ingest", 180)
        conn.commit()
    assert claimed is not None
    assert claimed["id"] == job_id
    assert claimed["attempts"] == 1


def test_job_attempt_records_claim_metrics_and_terminal_outcome(workspace):
    from pipeline.store import db

    job_id = f"job_telemetry_{workspace.id[-8:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload)
        VALUES (%s, 'parse', %s::jsonb)
        RETURNING id
        """,
        (
            job_id,
            '{"reservationId":"op-1","processingPlan":{"route":"mineru","format":"pdf"}}',
        ),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        _isolate_job(cur, job_id)
        claimed = db.claim_job(cur, "parse", 180)
        assert claimed is not None
        attempt_id = db.start_job_attempt(
            cur,
            job=claimed,
            trace_id="trace-1",
            environment="uat",
            host_id="ingest-1",
            worker_instance_id="parse-1",
            release_sha="a" * 40,
        )
        db.record_job_parse_metrics(
            cur,
            attempt_id=attempt_id,
            pages=40,
            ocr_pages=7,
            slices=2,
            queue_milliseconds=120,
            execution_milliseconds=900,
        )
        db.finish_job_attempt(
            cur,
            attempt_id=attempt_id,
            outcome="succeeded",
            snapshot={
                "stage": "parse_handoff",
                "stage_timings": {"mineru_parse": 900},
                "stats": {"artifact_bytes": 2048},
            },
        )
        conn.commit()

    with workspace._connect() as conn:
        row = conn.execute(
            """
            SELECT environment, route, source_format, status, stage,
                   parse_pages, parse_ocr_pages, parse_slices,
                   parser_queue_milliseconds, parser_execution_milliseconds,
                   artifact_bytes, stage_timings->>'mineru_parse'
            FROM ingest_job_attempts WHERE id=%s
            """,
            (attempt_id,),
        ).fetchone()
    assert row == (
        "uat",
        "mineru",
        "pdf",
        "succeeded",
        "parse_handoff",
        40,
        7,
        2,
        120,
        900,
        2048,
        "900",
    )


def test_terminal_reclaim_commits_file_claim_and_credit_cleanup(workspace):
    file_id = workspace.add_file("terminal-reclaim.txt")
    content_id = f"rgc_{secrets.token_hex(8)}"
    with workspace._connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE files
            SET source_etag='etag-a', status='processing', indexed=true
            WHERE id=%s
            """,
            (file_id,),
        )
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        cur.execute(
            """
            UPDATE jobs
            SET lease_expires_at=now()-interval '1 minute'
            WHERE id=%s
            """,
            (job_id,),
        )
        cur.execute(
            "UPDATE provider_sessions SET reserved_micros=500 WHERE id=%s",
            (reservation_id,),
        )
        cur.execute(
            """
            INSERT INTO user_credits (user_id, reserved_micros)
            VALUES (%s, 500)
            ON CONFLICT (user_id) DO UPDATE SET reserved_micros=500
            """,
            (workspace.user_id,),
        )
        cur.execute(
            """
            INSERT INTO rag_contents
              (id, workspace_id, content_hash, status, claim_job_id)
            VALUES (%s, %s, %s, 'processing', %s)
            """,
            (content_id, workspace.id, secrets.token_hex(32), job_id),
        )
        reclaimed = db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 1}, backoff_base_s={"ingest": 30}
        )
        conn.commit()

    assert len(reclaimed) == 1
    assert reclaimed[0] == {
        "id": job_id,
        "type": "ingest",
        "payload": reclaimed[0]["payload"],
        "attempts": 1,
        "outcome": "failed",
        "file_failed": True,
    }
    with workspace._connect() as conn:
        state = conn.execute(
            """
            SELECT j.status, f.status, f.indexed, a.status, ps.status,
                   uc.reserved_micros,
                   EXISTS(SELECT 1 FROM rag_contents WHERE id=%s)
            FROM jobs j
            JOIN files f ON f.id=%s
            JOIN ingest_job_attempts a ON a.id=%s
            JOIN provider_sessions ps ON ps.id=%s
            JOIN user_credits uc ON uc.user_id=%s
            WHERE j.id=%s
            """,
            (
                content_id,
                file_id,
                attempt_id,
                reservation_id,
                workspace.user_id,
                job_id,
            ),
        ).fetchone()
    # No post-commit worker callback runs here. The reaper commit is enough.
    assert state == ("failed", "failed", False, "lease_expired", "released", 0, False)


def test_terminal_parse_reclaim_drops_its_processing_content_claim(workspace):
    job_id = f"job_parse_{workspace.id[-8:]}"
    content_id = f"rgc_{secrets.token_hex(8)}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'parse', '{}'::jsonb, 'running', 2, now() - interval '1 minute')
        RETURNING id
        """,
        (job_id,),
    )
    workspace.scalar(
        """
        INSERT INTO rag_contents
          (id, workspace_id, content_hash, status, claim_job_id)
        VALUES (%s, %s, %s, 'processing', %s)
        RETURNING id
        """,
        (content_id, workspace.id, secrets.token_hex(32), job_id),
    )

    with workspace._connect() as conn, conn.cursor() as cur:
        db.reclaim_expired_leases(
            cur, max_attempts={"parse": 2}, backoff_base_s={"parse": 30}
        )
        conn.commit()

    assert not workspace.scalar(
        "SELECT count(*) FROM rag_contents WHERE id=%s", (content_id,)
    )


@pytest.mark.parametrize(
    ("current_revision", "current_etag", "file_failed"),
    [(1, "", True), (2, "etag-b", False)],
    ids=["legacy-empty-etag", "replaced-source"],
)
def test_terminal_reclaim_respects_exact_source_fence(
    workspace, current_revision: int, current_etag: str, file_failed: bool
):
    file_id = workspace.add_file("terminal-reclaim-fence.txt")
    with workspace._connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE files
            SET revision=%s, source_etag=%s, status='pending'
            WHERE id=%s
            """,
            (current_revision, current_etag, file_id),
        )
        job_id, _attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
            source_etag="",
        )
        cur.execute(
            """
            UPDATE jobs
            SET lease_expires_at=now()-interval '1 minute'
            WHERE id=%s
            """,
            (job_id,),
        )
        reclaimed = db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 1}, backoff_base_s={"ingest": 30}
        )
        conn.commit()

    assert reclaimed[0]["file_failed"] is file_failed
    assert workspace.scalar("SELECT status FROM files WHERE id=%s", (file_id,)) == (
        "failed" if file_failed else "pending"
    )
    assert (
        workspace.scalar(
            "SELECT status FROM provider_sessions WHERE id=%s", (reservation_id,)
        )
        == "released"
    )


def test_cancelled_pipeline_file_write_is_revision_and_etag_fenced(workspace):
    file_id = workspace.add_file("cancel-fence.txt")
    workspace.scalar(
        """
        UPDATE files
        SET revision=2, source_etag='etag-b', status='pending'
        WHERE id=%s RETURNING id
        """,
        (file_id,),
    )
    old_payload = {
        "fileId": file_id,
        "sourceRevision": 1,
        "sourceETag": "etag-a",
    }
    with workspace._connect() as conn, conn.cursor() as cur:
        assert not db.fail_pipeline_file_if_current(cur, old_payload)
        conn.commit()
    assert (
        workspace.scalar("SELECT status FROM files WHERE id=%s", (file_id,))
        == "pending"
    )

    current_payload = {
        "fileId": file_id,
        "sourceRevision": 2,
        "sourceETag": "etag-b",
    }
    with workspace._connect() as conn, conn.cursor() as cur:
        assert db.fail_pipeline_file_if_current(cur, current_payload)
        conn.commit()
    assert (
        workspace.scalar("SELECT status FROM files WHERE id=%s", (file_id,)) == "failed"
    )


def test_cancelled_legacy_multipart_file_uses_empty_etag_fence(workspace):
    file_id = workspace.add_file("legacy-multipart.txt")
    workspace.scalar(
        "UPDATE files SET source_etag='', status='processing' WHERE id=%s RETURNING id",
        (file_id,),
    )
    with workspace._connect() as conn, conn.cursor() as cur:
        assert db.fail_pipeline_file_if_current(
            cur,
            {"fileId": file_id, "sourceRevision": 1, "sourceETag": ""},
        )
        conn.commit()
    assert workspace.scalar("SELECT status FROM files WHERE id=%s", (file_id,)) == (
        "failed"
    )


def test_account_cancellation_fails_legacy_multipart_file(workspace):
    import psycopg

    file_id = workspace.add_file("legacy-account-delete.txt")
    with psycopg.connect(workspace.dsn) as conn:
        conn.execute(
            "UPDATE files SET source_etag='', status='processing' WHERE id=%s",
            (file_id,),
        )
        job_id, _attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
            source_etag="",
        )
        conn.execute("SELECT cancel_user_async_work(%s)", (workspace.user_id,))
        assert (
            conn.execute("SELECT status FROM files WHERE id=%s", (file_id,)).fetchone()[
                0
            ]
            == "failed"
        )
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))


async def test_donor_copy_reuses_chunks_across_workspaces(workspace):
    import secrets

    import psycopg

    workspace.scalar(
        "UPDATE workspaces SET privacy='link' WHERE id=%s RETURNING id", (workspace.id,)
    )
    src_file = workspace.add_file("lecture.txt")
    await _write(workspace, src_file, ["donor passage about osmosis"])
    donor_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (src_file,)
    )
    sha = "ab" * 32
    identity = "auto:direct:none:none:v1"
    workspace.scalar(
        """
        UPDATE rag_contents
        SET source_sha256 = %s, pipeline_identity = %s
        WHERE id = %s
        RETURNING id
        """,
        (sha, identity, donor_id),
    )
    preview_path = "previews/donor.pdf"
    workspace.scalar(
        """UPDATE files
        SET preview_blob_path = %s, source_sha256 = %s
        WHERE id = %s RETURNING id""",
        (preview_path, sha, src_file),
    )
    mismatched_file = workspace.add_file("other-layout.txt")
    mismatched_preview = "previews/other-layout.pdf"
    workspace.scalar(
        """UPDATE files
        SET preview_blob_path = %s, source_sha256 = %s, added_at = now() + interval '1 hour'
        WHERE id = %s RETURNING id""",
        (mismatched_preview, "cd" * 32, mismatched_file),
    )
    workspace.scalar(
        """INSERT INTO rag_file_contents (file_id, workspace_id, content_id)
        VALUES (%s, %s, %s) RETURNING file_id""",
        (mismatched_file, workspace.id, donor_id),
    )
    await store.upsert_content_summary(
        workspace_id=workspace.id,
        content_id=donor_id,
        fingerprint="fp",
        descriptor="Osmosis in brief.",
        summary="Osmosis.",
    )

    other_id = f"ws_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name, color) VALUES (%s, %s, %s, 'blue')",
            (other_id, workspace.user_id, "Other"),
        )
    other = type(workspace)(workspace.dsn, other_id)
    dest_file = other.add_file("copy.txt")
    pin = await store.workspace_embedding_pin(other.id)
    donor = await store.find_ready_donor(
        workspace_id=other.id,
        source_sha256=sha,
        pipeline_identity=identity,
        embedding_provider_slug=pin["embedding_provider_slug"],
        embedding_model_slug=pin["embedding_model_slug"],
        embedding_model_version=pin["embedding_model_version"],
        embedding_dim=pin["embedding_dim"],
    )
    assert donor is not None
    assert donor["id"] == donor_id
    assert donor["preview_blob_path"] == preview_path
    association = await store.attach_file_content(
        workspace_id=other.id,
        file_id=dest_file,
        content_hash=donor["content_hash"],
        source_sha256=sha,
        pipeline_identity=identity,
    )
    copied = await store.copy_content_from_donor(
        donor_id=donor["id"],
        dest_content_id=association["content_id"],
        dest_workspace_id=other.id,
        dest_file_id=dest_file,
        copy_vectors=True,
    )
    assert copied
    await store.mark_content_ready(association["content_id"])
    assert (
        other.scalar(
            "SELECT count(*) FROM rag_chunks WHERE content_id = %s",
            (association["content_id"],),
        )
        == 1
    )
    table = store.vector_table_for_pin(pin)
    assert (
        other.scalar(
            f"SELECT count(*) FROM {table} v JOIN rag_chunks c ON c.id = v.chunk_id "
            "WHERE c.content_id = %s",
            (association["content_id"],),
        )
        == 1
    )
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM workspaces WHERE id = %s", (other_id,))


async def test_donor_copy_skips_vectors_when_pins_differ(workspace):
    import secrets

    import psycopg

    workspace.scalar(
        "UPDATE workspaces SET privacy='link' WHERE id=%s RETURNING id", (workspace.id,)
    )
    src_file = workspace.add_file("lecture.txt")
    await _write(workspace, src_file, ["donor passage about osmosis"])
    donor_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (src_file,)
    )
    sha = "ef" * 32
    identity = "auto:direct:none:none:v1"
    workspace.scalar(
        """
        UPDATE rag_contents
        SET source_sha256 = %s, pipeline_identity = %s
        WHERE id = %s
        RETURNING id
        """,
        (sha, identity, donor_id),
    )

    other_id = f"ws_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name, color) VALUES (%s, %s, %s, 'blue')",
            (other_id, workspace.user_id, "Other"),
        )
    other = type(workspace)(workspace.dsn, other_id)
    dest_file = other.add_file("copy.txt")
    pin = await store.workspace_embedding_pin(other.id)
    donor = await store.find_ready_donor(
        workspace_id=other.id,
        source_sha256=sha,
        pipeline_identity=identity,
        embedding_provider_slug=pin["embedding_provider_slug"],
        embedding_model_slug=pin["embedding_model_slug"],
        embedding_model_version=pin["embedding_model_version"],
        embedding_dim=pin["embedding_dim"],
    )
    association = await store.attach_file_content(
        workspace_id=other.id,
        file_id=dest_file,
        content_hash=donor["content_hash"],
        source_sha256=sha,
        pipeline_identity=identity,
    )
    copied = await store.copy_content_from_donor(
        donor_id=donor["id"],
        dest_content_id=association["content_id"],
        dest_workspace_id=other.id,
        dest_file_id=dest_file,
        copy_vectors=False,
    )
    assert copied
    assert (
        other.scalar(
            "SELECT count(*) FROM rag_chunks WHERE content_id = %s",
            (association["content_id"],),
        )
        == 1
    )
    table = store.vector_table_for_pin(pin)
    assert (
        other.scalar(
            f"SELECT count(*) FROM {table} v JOIN rag_chunks c ON c.id = v.chunk_id "
            "WHERE c.content_id = %s",
            (association["content_id"],),
        )
        == 0
    )
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM workspaces WHERE id = %s", (other_id,))


async def test_donor_lookup_prefers_matching_pin(workspace):
    """A newer donor in another space must not steal reuse from the old pin."""
    import secrets

    import psycopg

    src_file = workspace.add_file("lecture.txt")
    await _write(workspace, src_file, ["donor passage about osmosis"])
    matching_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (src_file,)
    )
    sha = "ab" * 32
    identity = "auto:direct:none:none:v1"
    workspace.scalar(
        """
        UPDATE rag_contents
        SET source_sha256 = %s, pipeline_identity = %s, updated_at = now() - interval '1 hour'
        WHERE id = %s
        RETURNING id
        """,
        (sha, identity, matching_id),
    )

    other_id = f"ws_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name, color) VALUES (%s, %s, %s, 'blue')",
            (other_id, workspace.user_id, "Other"),
        )
    workspace.scalar(
        "UPDATE workspaces SET privacy='link' WHERE id=%s RETURNING id", (other_id,)
    )
    other = type(workspace)(workspace.dsn, other_id)
    dest_file = other.add_file("newer.txt")
    await _write(other, dest_file, ["donor passage about osmosis"])
    newer_id = other.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (dest_file,)
    )
    other.scalar(
        """
        UPDATE rag_contents
        SET source_sha256 = %s, pipeline_identity = %s,
            embedding_provider_slug = 'other', embedding_model_slug = 'other-embed',
            embedding_model_version = 1,
            updated_at = now()
        WHERE id = %s
        RETURNING id
        """,
        (sha, identity, newer_id),
    )

    pin = await store.workspace_embedding_pin(workspace.id)
    donor = await store.find_ready_donor(
        workspace_id=workspace.id,
        source_sha256=sha,
        pipeline_identity=identity,
        embedding_provider_slug=pin["embedding_provider_slug"],
        embedding_model_slug=pin["embedding_model_slug"],
        embedding_model_version=pin["embedding_model_version"],
        embedding_dim=pin["embedding_dim"],
    )
    assert donor is not None
    assert donor["id"] == matching_id

    other_space = await store.find_ready_donor(
        workspace_id=workspace.id,
        source_sha256=sha,
        pipeline_identity=identity,
        embedding_provider_slug="other",
        embedding_model_slug="other-embed",
        embedding_model_version=1,
        embedding_dim=pin["embedding_dim"],
    )
    assert other_space is not None
    assert other_space["id"] == newer_id

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM workspaces WHERE id = %s", (other_id,))


def test_only_the_claiming_attempt_may_write_its_outcome(workspace):
    """A worker whose lease was reclaimed must not overwrite its successor.

    The scenario is a live worker that lost its lease (heartbeat failure, long
    remote parse) while the reaper re-pended the row and a second worker took it.
    """
    from pipeline.store import db

    job_id = f"job_{workspace.id[-8:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'ingest', '{}'::jsonb, 'running', 1, now() - interval '1 minute')
        RETURNING id
        """,
        (job_id,),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 3}, backoff_base_s={"ingest": 30}
        )
        # Skip the retry backoff the reclaim just applied.
        cur.execute(
            "UPDATE jobs SET not_before = now() - interval '1 second' WHERE id = %s",
            (job_id,),
        )
        _isolate_job(cur, job_id)
        successor = db.claim_job(cur, "ingest", 180)
        # The reclaimed worker still believes it holds attempt 1.
        stale = db.claim_is_current(cur, job_id, 1)
        current = db.claim_is_current(cur, job_id, successor["attempts"])
        conn.commit()

    assert successor["id"] == job_id
    assert successor["attempts"] == 2
    assert stale is False
    assert current is True


def test_expired_pipeline_claim_cannot_heartbeat_or_cross_final_boundary(workspace):
    """Lease expiry fences an attempt before the reaper changes its status."""
    file_id = workspace.add_file("expired-claim.txt")
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE files SET source_etag='etag-a', status='processing' WHERE id=%s",
            (file_id,),
        )
        job_id, _attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        conn.execute(
            "UPDATE jobs SET lease_expires_at=now()-interval '1 minute' WHERE id=%s",
            (job_id,),
        )
        expired_at = conn.execute(
            "SELECT lease_expires_at FROM jobs WHERE id=%s", (job_id,)
        ).fetchone()[0]
        payload = {
            "actorUserId": workspace.user_id,
            "fileId": file_id,
            "reservationId": reservation_id,
            "sourceETag": "etag-a",
            "sourceRevision": 1,
            "workspaceId": workspace.id,
        }

        with conn.cursor() as cur:
            assert not db.heartbeat_job(cur, job_id, 180, 1)
            assert not db.claim_is_current(cur, job_id, 1)
            assert (
                db.lock_pipeline_claim_boundary(
                    cur,
                    job_id=job_id,
                    attempt=1,
                    payload=payload,
                )
                == "lost"
            )
        assert (
            conn.execute(
                "SELECT lease_expires_at FROM jobs WHERE id=%s", (job_id,)
            ).fetchone()[0]
            == expired_at
        )


def test_a_stale_worker_does_not_finish_the_successors_job(workspace):
    from pipeline.ingest import worker

    file_id = workspace.add_file("late.txt")
    job_id = f"job_{workspace.id[-8:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'ingest', '{}'::jsonb, 'running', 2)
        RETURNING id
        """,
        (job_id,),
    )
    workspace.scalar(
        "UPDATE files SET status='processing' WHERE id=%s RETURNING id", (file_id,)
    )

    worker._finish_ok(file_id, "late.txt", job_id, attempt=1)

    assert (
        workspace.scalar("SELECT status FROM jobs WHERE id=%s", (job_id,)) == "running"
    )
    assert workspace.scalar("SELECT status FROM files WHERE id=%s", (file_id,)) == (
        "processing"
    )
    assert (
        workspace.scalar(
            "SELECT count(*) FROM notifications WHERE workspace_id=%s", (workspace.id,)
        )
        == 0
    )


def test_lost_attempt_does_not_close_the_successors_reservation(workspace):
    """Lease fencing is not source supersession; both attempts share billing."""
    import json

    from pipeline.ingest import worker

    file_id = workspace.add_file("retry.txt")
    job_id = f"job_retry_{workspace.id[-6:]}"
    reservation_id = f"cr_retry_{workspace.id[-6:]}"
    workspace.scalar(
        "UPDATE files SET source_etag='etag-a', status='processing' WHERE id=%s RETURNING id",
        (file_id,),
    )
    workspace.scalar(
        """
        INSERT INTO provider_sessions
          (id, actor_user_id, workspace_id, surface, expires_at)
        VALUES (%s,%s,%s,'ingest',now()+interval '1 hour')
        RETURNING id
        """,
        (reservation_id, workspace.user_id, workspace.id),
    )
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s,'ingest',%s::jsonb,'running',2,now()+interval '3 minutes')
        RETURNING id
        """,
        (
            job_id,
            json.dumps(
                {
                    "actorUserId": workspace.user_id,
                    "fileId": file_id,
                    "workspaceId": workspace.id,
                    "sourceRevision": 1,
                    "sourceETag": "etag-a",
                    "reservationId": reservation_id,
                }
            ),
        ),
    )

    # Attempt 1 resumes after the reaper and successor claim. It must not close
    # the reservation shared with attempt 2 or change the successor's job.
    worker._finish_ok(
        file_id,
        "retry.txt",
        job_id,
        "attempt-one",
        attempt=1,
        actor_user_id=workspace.user_id,
        workspace_id=workspace.id,
        reservation_id=reservation_id,
        source_revision=1,
        source_etag="etag-a",
    )
    assert workspace.scalar("SELECT status FROM jobs WHERE id=%s", (job_id,)) == (
        "running"
    )
    assert workspace.scalar(
        "SELECT status FROM provider_sessions WHERE id=%s", (reservation_id,)
    ) == ("open")

    worker._finish_ok(
        file_id,
        "retry.txt",
        job_id,
        "attempt-two",
        attempt=2,
        actor_user_id=workspace.user_id,
        workspace_id=workspace.id,
        reservation_id=reservation_id,
        source_revision=1,
        source_etag="etag-a",
    )
    assert workspace.scalar("SELECT status FROM jobs WHERE id=%s", (job_id,)) == (
        "done"
    )
    assert workspace.scalar(
        "SELECT status FROM provider_sessions WHERE id=%s", (reservation_id,)
    ) == ("settled")


async def test_replaced_source_rejects_a_paused_ingests_stale_writes(workspace):
    """An A worker resumed after A->B cannot attach A's result to logical file B."""
    import json

    from pipeline.ingest import worker
    from pipeline.jobs import TerminalError

    file_id = workspace.add_file("replacement.docx")
    job_id = f"job_replace_{workspace.id[-6:]}"
    reservation_id = f"cr_replace_{workspace.id[-6:]}"
    old_revision = 1
    old_etag = "etag-a"
    workspace.scalar(
        """
        UPDATE files SET source_etag=%s, status='processing'
        WHERE id=%s RETURNING id
        """,
        (old_etag, file_id),
    )
    workspace.scalar(
        """
        INSERT INTO provider_sessions
          (id, actor_user_id, workspace_id, surface, expires_at)
        VALUES (%s,%s,%s,'ingest',now()+interval '1 hour')
        RETURNING id
        """,
        (reservation_id, workspace.user_id, workspace.id),
    )
    job_payload = {
        "actorUserId": workspace.user_id,
        "fileId": file_id,
        "workspaceId": workspace.id,
        "sourceRevision": old_revision,
        "sourceETag": old_etag,
        "reservationId": reservation_id,
    }
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'ingest', %s::jsonb, 'running', 1, now()+interval '3 minutes')
        RETURNING id
        """,
        (
            job_id,
            json.dumps(job_payload),
        ),
    )

    # Replacement B commits while the A worker is paused outside a DB
    # transaction. This is the state FinalizeReplacementUploadSession creates.
    workspace.scalar(
        """
        UPDATE files SET revision=2, source_etag='etag-b', status='pending',
          indexed=false, source_sha256=NULL, content_hash=NULL,
          preview_blob_path=NULL, parsed_blob_path=NULL
        WHERE id=%s RETURNING id
        """,
        (file_id,),
    )

    with pytest.raises(TerminalError, match="superseded"):
        worker._record_source_sha(
            file_id, "a" * 64, old_revision, old_etag, workspace.user_id
        )
    with pytest.raises(TerminalError, match="superseded"):
        worker._record_preview_blob(
            file_id, "previews/a.pdf", old_revision, old_etag, workspace.user_id
        )
    with pytest.raises(TerminalError, match="superseded"):
        await store.attach_file_content(
            workspace_id=workspace.id,
            file_id=file_id,
            content_hash="content-a",
            source_sha256="a" * 64,
            pipeline_identity="pipeline-a",
            claim_job_id=job_id,
            source_revision=old_revision,
            source_etag=old_etag,
        )
    assert not worker._finish_ok(
        file_id,
        "replacement.docx",
        job_id,
        "content-a",
        attempt=1,
        actor_user_id=workspace.user_id,
        workspace_id=workspace.id,
        reservation_id=reservation_id,
        source_revision=old_revision,
        source_etag=old_etag,
    )
    await worker._handle_job_failure(
        {"id": job_id, "type": "ingest", "attempts": 1, "payload": job_payload},
        db.SourceSupersededError("ingest source was superseded"),
    )

    with workspace._connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT revision, source_etag, status, indexed, source_sha256,
                   content_hash, preview_blob_path, parsed_blob_path
            FROM files WHERE id=%s
            """,
            (file_id,),
        )
        state = cur.fetchone()
        cur.execute(
            "SELECT count(*) FROM rag_file_contents WHERE file_id=%s", (file_id,)
        )
        associations = cur.fetchone()[0]
        cur.execute("SELECT status FROM jobs WHERE id=%s", (job_id,))
        job_status = cur.fetchone()[0]
        cur.execute(
            "SELECT status FROM provider_sessions WHERE id=%s", (reservation_id,)
        )
        reservation_status = cur.fetchone()[0]

    assert state == (2, "etag-b", "pending", False, None, None, None, None)
    assert associations == 0
    assert job_status == "failed"
    assert reservation_status == "released"


def test_heartbeat_cancels_replacement_job_skipped_while_locked(workspace):
    import psycopg

    file_id = workspace.add_file("heartbeat-replacement.txt")
    with psycopg.connect(workspace.dsn) as conn:
        conn.execute(
            "UPDATE files SET source_etag='etag-a', status='processing' WHERE id=%s",
            (file_id,),
        )
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )

    def replace_source(conn) -> None:
        conn.execute(
            "UPDATE files SET revision=2, source_etag='etag-b' WHERE id=%s",
            (file_id,),
        )
        conn.execute(
            """
            WITH candidates AS MATERIALIZED (
              SELECT id FROM jobs
              WHERE type IN ('parse','ingest') AND payload->>'fileId'=%s
                AND status IN ('pending','running')
                AND (payload->>'sourceRevision')::bigint < 2
              FOR UPDATE SKIP LOCKED
            )
            SELECT cancel_pipeline_jobs(
              COALESCE(array_agg(id), ARRAY[]::text[]),
              'superseded', 'superseded', 'source_superseded',
              'superseded by file replacement'
            ) FROM candidates
            """,
            (file_id,),
        )

    _commit_lifecycle_while_job_is_locked(workspace.dsn, job_id, replace_source)

    with psycopg.connect(workspace.dsn) as conn:
        with (
            conn.cursor() as cur,
            pytest.raises(RuntimeError, match="superseded by file replacement"),
        ):
            db.open_provider_call(
                cur,
                reservation_id,
                f"pc_{secrets.token_hex(6)}",
                "embedding",
                "indexing",
                "",
                job_attempt_id=attempt_id,
            )
        _assert_heartbeat_cancelled_claim(
            conn,
            job_id=job_id,
            attempt_id=attempt_id,
            reservation_id=reservation_id,
            attempt_status="superseded",
            error_code="source_superseded",
        )
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))


def test_heartbeat_cancels_deleted_file_job_skipped_while_locked(workspace):
    import psycopg

    file_id = workspace.add_file("heartbeat-deleted.txt")
    with psycopg.connect(workspace.dsn) as conn:
        conn.execute(
            "UPDATE files SET source_etag='etag-a', status='processing' WHERE id=%s",
            (file_id,),
        )
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )

    def delete_file(conn) -> None:
        conn.execute("DELETE FROM files WHERE id=%s", (file_id,))

    _commit_lifecycle_while_job_is_locked(workspace.dsn, job_id, delete_file)

    with psycopg.connect(workspace.dsn) as conn:
        with (
            conn.cursor() as cur,
            pytest.raises(RuntimeError, match="source deleted"),
        ):
            db.open_provider_call(
                cur,
                reservation_id,
                f"pc_{secrets.token_hex(6)}",
                "embedding",
                "indexing",
                "",
                job_attempt_id=attempt_id,
            )
        _assert_heartbeat_cancelled_claim(
            conn,
            job_id=job_id,
            attempt_id=attempt_id,
            reservation_id=reservation_id,
            attempt_status="failed",
            error_code="source_deleted",
        )
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))


@pytest.mark.parametrize("source_etag", ["etag-a", ""])
def test_heartbeat_cancels_collaborator_job_after_owner_deletion_skip(
    workspace, source_etag: str
):
    import psycopg

    owner_id = f"u_{secrets.token_hex(6)}"
    actor_id = f"u_{secrets.token_hex(6)}"
    workspace_id = f"ws_{secrets.token_hex(6)}"
    file_id = f"f_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn) as conn:
        conn.execute(
            "INSERT INTO users (id, name, email) VALUES (%s,%s,%s)",
            (owner_id, "Lifecycle owner", f"{owner_id}@example.com"),
        )
        conn.execute(
            "INSERT INTO users (id, name, email) VALUES (%s,%s,%s)",
            (actor_id, "Lifecycle actor", f"{actor_id}@example.com"),
        )
        conn.execute(
            "INSERT INTO workspaces (id,user_id,name,color) VALUES (%s,%s,'Lifecycle','green')",
            (workspace_id, owner_id),
        )
        conn.execute(
            "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (%s,%s,'editor')",
            (workspace_id, actor_id),
        )
        conn.execute(
            """
            INSERT INTO files
              (id,workspace_id,user_id,created_by,name,kind,blob_path,
               source_etag,revision,status)
            VALUES (%s,%s,%s,%s,'owned.txt','txt',%s,%s,1,'processing')
            """,
            (
                file_id,
                workspace_id,
                owner_id,
                actor_id,
                f"sources/{file_id}",
                source_etag,
            ),
        )
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace_id,
            file_id=file_id,
            actor_user_id=actor_id,
            source_etag=source_etag,
        )

    def request_owner_deletion(conn) -> None:
        conn.execute(
            "UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=%s",
            (owner_id,),
        )
        conn.execute("SELECT cancel_user_async_work(%s)", (owner_id,))

    _commit_lifecycle_while_job_is_locked(workspace.dsn, job_id, request_owner_deletion)

    with psycopg.connect(workspace.dsn) as conn:
        assert (
            conn.execute(
                "SELECT status FROM provider_sessions WHERE id=%s", (reservation_id,)
            ).fetchone()[0]
            == "open"
        )
        _assert_heartbeat_cancelled_claim(
            conn,
            job_id=job_id,
            attempt_id=attempt_id,
            reservation_id=reservation_id,
            attempt_status="failed",
            error_code="account_deletion",
        )
        assert conn.execute(
            "SELECT deletion_requested_at IS NULL FROM users WHERE id=%s", (actor_id,)
        ).fetchone()[0]
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))
        conn.execute("DELETE FROM workspaces WHERE id=%s", (workspace_id,))
        conn.execute("DELETE FROM users WHERE id=ANY(%s)", ([owner_id, actor_id],))


@pytest.mark.parametrize("revocation", ["demote", "remove"])
def test_ingest_boundaries_cancel_after_editor_membership_is_revoked(
    workspace, revocation: str
):
    import psycopg

    from pipeline.ingest import worker

    actor_id = f"u_{secrets.token_hex(6)}"
    file_id = f"f_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn) as conn:
        conn.execute(
            "INSERT INTO users (id, name, email) VALUES (%s, 'Actor', %s)",
            (actor_id, f"{actor_id}@example.com"),
        )
        conn.execute(
            "INSERT INTO workspace_members (workspace_id,user_id,role) "
            "VALUES (%s,%s,'editor')",
            (workspace.id, actor_id),
        )
        conn.execute(
            """
            INSERT INTO files
              (id,workspace_id,user_id,created_by,name,kind,blob_path,
               source_etag,revision,status)
            VALUES (%s,%s,%s,%s,'member.txt','txt',%s,'etag-a',1,'processing')
            """,
            (
                file_id,
                workspace.id,
                workspace.user_id,
                actor_id,
                f"sources/{file_id}",
            ),
        )
        job_id, attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=actor_id,
        )
        if revocation == "demote":
            conn.execute(
                "UPDATE workspace_members SET role='viewer' "
                "WHERE workspace_id=%s AND user_id=%s",
                (workspace.id, actor_id),
            )
        else:
            conn.execute(
                "DELETE FROM workspace_members WHERE workspace_id=%s AND user_id=%s",
                (workspace.id, actor_id),
            )

    assert not worker._account_allows_ingest(
        file_id,
        {
            "actorUserId": actor_id,
            "sourceETag": "etag-a",
            "sourceRevision": 1,
            "workspaceId": workspace.id,
        },
    )
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        with pytest.raises(RuntimeError, match="editor access was revoked"):
            db.open_provider_call(
                cur,
                reservation_id,
                f"pc_{secrets.token_hex(6)}",
                "embedding",
                "indexing",
                "",
                job_attempt_id=attempt_id,
            )
        assert not db.heartbeat_job(cur, job_id, 180, 1)
        state = conn.execute(
            """
            SELECT j.status, a.status, a.error_category, a.error_code, ps.status
            FROM jobs j
            JOIN ingest_job_attempts a ON a.id=%s
            JOIN provider_sessions ps ON ps.id=%s
            WHERE j.id=%s
            """,
            (attempt_id, reservation_id, job_id),
        ).fetchone()
        assert state == (
            "failed",
            "failed",
            "authorization",
            "workspace_access_revoked",
            "released",
        )
        assert (
            conn.execute("SELECT status FROM files WHERE id=%s", (file_id,)).fetchone()[
                0
            ]
            == "failed"
        )
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))
        conn.execute("DELETE FROM users WHERE id=%s", (actor_id,))


@pytest.mark.parametrize("boundary", ["heartbeat", "final", "reaper"])
@pytest.mark.parametrize("mutation", ["delete", "replace"])
def test_pipeline_lock_order_serializes_with_file_lifecycle(
    workspace, boundary: str, mutation: str
):
    """A pipeline boundary waiting on workspace never blocks lifecycle locks."""
    import psycopg

    file_id = workspace.add_file(f"lock-order-{boundary}-{mutation}.txt")
    with psycopg.connect(workspace.dsn) as conn:
        conn.execute(
            "UPDATE files SET source_etag='etag-a', status='processing' WHERE id=%s",
            (file_id,),
        )
        job_id, _attempt_id, reservation_id = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        if boundary == "reaper":
            conn.execute(
                """
                UPDATE jobs
                SET lease_expires_at=now()-interval '1 minute'
                WHERE id=%s
                """,
                (job_id,),
            )
    payload = {
        "actorUserId": workspace.user_id,
        "fileId": file_id,
        "reservationId": reservation_id,
        "sourceETag": "etag-a",
        "sourceRevision": 1,
        "workspaceId": workspace.id,
    }
    started = threading.Event()

    def run_worker_boundary() -> bool:
        with (
            psycopg.connect(
                workspace.dsn, application_name="pipeline-lock-order-test"
            ) as worker_conn,
            worker_conn.cursor() as cur,
        ):
            started.set()
            if boundary == "heartbeat":
                return db.heartbeat_job(cur, job_id, 180, 1)
            if boundary == "reaper":
                return bool(
                    db.reclaim_expired_leases(
                        cur,
                        max_attempts={"ingest": 1},
                        backoff_base_s={"ingest": 30},
                    )
                )
            return (
                db.lock_pipeline_claim_boundary(
                    cur,
                    job_id=job_id,
                    attempt=1,
                    payload=payload,
                )
                == "current"
            )

    with psycopg.connect(workspace.dsn) as lifecycle_conn:
        lifecycle_conn.execute(
            "SELECT id FROM workspaces WHERE id=%s FOR UPDATE", (workspace.id,)
        )
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(run_worker_boundary)
            assert started.wait(timeout=2)
            time.sleep(0.1)
            if mutation == "delete":
                lifecycle_conn.execute("DELETE FROM files WHERE id=%s", (file_id,))
            else:
                lifecycle_conn.execute(
                    "UPDATE files SET revision=2, source_etag='etag-b' WHERE id=%s",
                    (file_id,),
                )
                lifecycle_conn.execute(
                    """
                    SELECT cancel_pipeline_jobs(
                      ARRAY[%s]::text[], 'superseded', 'superseded',
                      'source_superseded', 'superseded by file replacement'
                    )
                    """,
                    (job_id,),
                )
            lifecycle_conn.commit()
            assert future.result(timeout=5) is False

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id=%s", (reservation_id,))


def test_suspended_collaborator_cannot_persist_ingest_metadata(workspace):
    import psycopg

    from pipeline.ingest import worker
    from pipeline.jobs import TerminalError

    actor_id = f"u_{secrets.token_hex(6)}"
    file_id = f"f_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO users (id, name, email) VALUES (%s, 'Actor', %s)",
            (actor_id, f"{actor_id}@example.com"),
        )
        conn.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role) "
            "VALUES (%s, %s, 'editor')",
            (workspace.id, actor_id),
        )
        conn.execute(
            """
            INSERT INTO files (
              id, workspace_id, user_id, created_by, name, kind, blob_path,
              source_etag, revision, status
            ) VALUES (%s,%s,%s,%s,'actor.txt','txt','sources/actor','etag-a',1,'pending')
            """,
            (file_id, workspace.id, workspace.user_id, actor_id),
        )
        conn.execute(
            "UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=%s",
            (actor_id,),
        )

    with pytest.raises(TerminalError, match="suspended or deleting"):
        worker._record_source_sha(file_id, "a" * 64, 1, "etag-a", actor_id)

    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        assert (
            conn.execute(
                "SELECT source_sha256 FROM files WHERE id=%s", (file_id,)
            ).fetchone()[0]
            is None
        )
        conn.execute("DELETE FROM users WHERE id=%s", (actor_id,))


async def test_a_waiter_cannot_keep_the_creators_claim_alive(workspace):
    """Heartbeats refresh only the claim their own job created.

    A second upload of identical content attaches to the creator's row, so a
    heartbeat keyed on the file would let a waiter mask a dead creator forever
    and the stale-claim steal could never fire.
    """
    import json

    from pipeline.store import db

    creator_job, waiter_job = _claim_ids(workspace)
    creator_file = workspace.add_file("first.txt")
    waiter_file = workspace.add_file("second.txt")
    content_hash = hashlib.sha256(b"shared bytes").hexdigest()
    created = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=creator_file,
        content_hash=content_hash,
        claim_job_id=creator_job,
    )
    waiting = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=waiter_file,
        content_hash=content_hash,
        claim_job_id=waiter_job,
    )
    assert created["created"] is True
    assert waiting["created"] is False
    assert waiting["content_id"] == created["content_id"]
    workspace.scalar(
        "UPDATE rag_contents SET updated_at = now() - interval '1 hour' "
        "WHERE id = %s RETURNING id",
        (created["content_id"],),
    )
    # The waiter's own job row: its file resolves to the creator's content, so a
    # heartbeat that walked rag_file_contents would refresh that claim.
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'ingest', %s::jsonb, 'running', 1)
        RETURNING id
        """,
        (
            waiter_job,
            json.dumps(
                {
                    "actorUserId": workspace.user_id,
                    "fileId": waiter_file,
                    "sourceETag": "",
                    "sourceRevision": 1,
                    "workspaceId": workspace.id,
                }
            ),
        ),
    )

    with workspace._connect() as conn:
        cur = conn.cursor()
        db.heartbeat_job(cur, waiter_job, 180, 1)
        conn.commit()
    assert await store.steal_stale_content(
        workspace_id=workspace.id,
        content_hash=content_hash,
        stale_s=60,
    )


async def test_a_dead_waiter_does_not_drop_a_live_ingest(workspace):
    """The reaper drops the claim the dead job created, not the file's claim."""
    import json

    from pipeline.store import db

    creator_job, waiter_job = _claim_ids(workspace)
    creator_file = workspace.add_file("first.txt")
    waiter_file = workspace.add_file("second.txt")
    content_hash = hashlib.sha256(b"contended bytes").hexdigest()
    created = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=creator_file,
        content_hash=content_hash,
        claim_job_id=creator_job,
    )
    await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=waiter_file,
        content_hash=content_hash,
        claim_job_id=waiter_job,
    )
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'ingest', %s::jsonb, 'running', 1, now() - interval '1 minute')
        RETURNING id
        """,
        (waiter_job, json.dumps({"fileId": waiter_file, "workspaceId": workspace.id})),
    )

    with workspace._connect() as conn:
        cur = conn.cursor()
        db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 3}, backoff_base_s={"ingest": 30}
        )
        conn.commit()

    assert (
        workspace.scalar(
            "SELECT status FROM rag_contents WHERE id = %s", (created["content_id"],)
        )
        == "processing"
    )
    assert (
        workspace.scalar(
            "SELECT claim_job_id FROM rag_contents WHERE id = %s",
            (created["content_id"],),
        )
        == creator_job
    )


async def test_waiting_never_returns_a_claim_another_job_holds(workspace, monkeypatch):
    """The caller indexes into whatever this returns, so it must own it."""
    import asyncio

    from pipeline.config import cfg as live_cfg
    from pipeline.ingest import worker

    monkeypatch.setattr(live_cfg, "poll_interval", 0.01)
    creator_job, waiter_job = _claim_ids(workspace)
    creator_file = workspace.add_file("first.txt")
    waiter_file = workspace.add_file("second.txt")
    content_hash = hashlib.sha256(b"waited-on bytes").hexdigest()
    await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=creator_file,
        content_hash=content_hash,
        claim_job_id=creator_job,
    )
    association = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=waiter_file,
        content_hash=content_hash,
        claim_job_id=waiter_job,
    )

    async def wait() -> dict:
        return await worker._wait_for_content(
            dict(association),
            workspace_id=workspace.id,
            file_id=waiter_file,
            content_hash=content_hash,
            claim_job_id=waiter_job,
        )

    # A live creator holds the claim: the waiter has nothing it may write to.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(wait(), timeout=0.2)

    # Once that claim goes stale the waiter takes it over and owns what it gets.
    monkeypatch.setattr(worker, "CONTENT_CLAIM_WAIT_S", 0)
    workspace.scalar(
        "UPDATE rag_contents SET updated_at = now() - interval '1 hour' "
        "WHERE id = %s RETURNING id",
        (association["content_id"],),
    )
    stolen = await asyncio.wait_for(wait(), timeout=5)
    assert stolen["created"] is True
    assert (
        workspace.scalar(
            "SELECT claim_job_id FROM rag_contents WHERE id = %s",
            (stolen["content_id"],),
        )
        == waiter_job
    )


async def test_artifact_gc_skips_in_flight_jobs(workspace):
    import json

    from pipeline.store import db

    sha = "cd" * 32
    file_id = workspace.add_file("a.txt")
    workspace.scalar(
        "UPDATE files SET source_sha256 = %s WHERE id = %s RETURNING id",
        (sha, file_id),
    )
    workspace.scalar(
        """
        INSERT INTO artifact_cache (object_path, kind, source_sha256, last_used_at)
        VALUES (%s, 'captions', %s, now() - interval '200 days')
        RETURNING object_path
        """,
        (f"captions/{sha}/v1.json", sha),
    )
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status)
        VALUES (%s, 'ingest', %s::jsonb, 'running')
        RETURNING id
        """,
        (f"job_{file_id}", json.dumps({"fileId": file_id})),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        deleted = db.sweep_artifact_cache(cur, caption_ttl_days=90)
        conn.commit()
    assert deleted == 0
    assert workspace.scalar(
        "SELECT count(*) FROM artifact_cache WHERE source_sha256 = %s", (sha,)
    )


async def test_artifact_gc_owns_cold_durable_parse_bundles(workspace):
    from pipeline.store import db

    sha = "ce" * 32
    key = f"parse-bundles/{sha}.zip"
    workspace.scalar(
        """
        INSERT INTO artifact_cache
            (object_path, kind, source_sha256, size_bytes, last_used_at)
        VALUES (%s, 'parse_bundle', %s, 128, now() - interval '200 days')
        RETURNING object_path
        """,
        (key, sha),
    )

    with workspace._connect() as conn:
        cur = conn.cursor()
        deleted = db.sweep_artifact_cache(cur, caption_ttl_days=90)
        conn.commit()

    assert deleted >= 1
    assert not workspace.scalar(
        "SELECT count(*) FROM artifact_cache WHERE object_path = %s", (key,)
    )


async def test_steal_refuses_a_creator_whose_lease_is_still_live(workspace):
    import json

    creator_job, _waiter = _claim_ids(workspace)
    file_id = workspace.add_file("leased.txt")
    content_hash = hashlib.sha256(b"leased bytes").hexdigest()
    created = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=content_hash,
        claim_job_id=creator_job,
    )
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'ingest', %s::jsonb, 'running', 1, now() + interval '3 minutes')
        RETURNING id
        """,
        (creator_job, json.dumps({"fileId": file_id, "workspaceId": workspace.id})),
    )
    workspace.scalar(
        "UPDATE rag_contents SET updated_at = now() - interval '1 hour' "
        "WHERE id = %s RETURNING id",
        (created["content_id"],),
    )
    assert not await store.steal_stale_content(
        workspace_id=workspace.id, content_hash=content_hash, stale_s=60
    )

    workspace.scalar(
        "UPDATE jobs SET lease_expires_at = now() - interval '1 minute' "
        "WHERE id = %s RETURNING id",
        (creator_job,),
    )
    assert await store.steal_stale_content(
        workspace_id=workspace.id, content_hash=content_hash, stale_s=60
    )


async def test_steal_succeeds_once_the_owner_job_is_done(workspace):
    import json

    creator_job, _waiter = _claim_ids(workspace)
    file_id = workspace.add_file("done.txt")
    content_hash = hashlib.sha256(b"done bytes").hexdigest()
    created = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=content_hash,
        claim_job_id=creator_job,
    )
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'ingest', %s::jsonb, 'done', 1, NULL)
        RETURNING id
        """,
        (creator_job, json.dumps({"fileId": file_id, "workspaceId": workspace.id})),
    )
    workspace.scalar(
        "UPDATE rag_contents SET updated_at = now() - interval '1 hour' "
        "WHERE id = %s RETURNING id",
        (created["content_id"],),
    )
    assert await store.steal_stale_content(
        workspace_id=workspace.id, content_hash=content_hash, stale_s=60
    )


async def test_replace_content_chunks_refuses_a_taken_over_claim(workspace):
    from pipeline.jobs import RetryableError

    creator_job, waiter_job = _claim_ids(workspace)
    file_id = workspace.add_file("notes.txt")
    content_hash = hashlib.sha256(b"fenced bytes").hexdigest()
    created = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=content_hash,
        claim_job_id=creator_job,
    )
    workspace.scalar(
        "UPDATE rag_contents SET claim_job_id = %s WHERE id = %s RETURNING id",
        (waiter_job, created["content_id"]),
    )
    with pytest.raises(RetryableError, match="content claim taken over"):
        await store.replace_content_chunks(
            workspace_id=workspace.id,
            content_id=created["content_id"],
            rows=[],
            claim_job_id=creator_job,
        )


def test_deleting_a_file_fences_its_inflight_job(workspace):
    import json

    from pipeline.ingest import worker

    file_id = workspace.add_file("gone.txt")
    job_id = f"job_fin_{workspace.id[-6:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'ingest', %s::jsonb, 'running', 1)
        RETURNING id
        """,
        (job_id, json.dumps({"fileId": file_id, "workspaceId": workspace.id})),
    )
    workspace.scalar("DELETE FROM files WHERE id = %s RETURNING id", (file_id,))
    worker._finish_ok(file_id, "gone.txt", job_id, attempt=1)
    assert (
        workspace.scalar("SELECT status FROM jobs WHERE id=%s", (job_id,)) == "failed"
    )
    assert (
        workspace.scalar(
            "SELECT count(*) FROM notifications WHERE workspace_id=%s",
            (workspace.id,),
        )
        == 0
    )


def test_provider_busy_repend_hands_the_attempt_back_and_counts_the_wait(workspace):
    """The whole busy re-pend transaction, including the attempt status the
    CHECK constraint must allow, then the next claim seeing the count."""
    import psycopg

    file_id = workspace.add_file("busy.txt")
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        job_id, attempt_id, _reservation = _install_running_pipeline_claim(
            conn,
            workspace_id=workspace.id,
            file_id=file_id,
            actor_user_id=workspace.user_id,
        )
        db.release_job_for_provider_busy(cur, job_id, 1, backoff_s=45)
        db.finish_job_attempt(
            cur,
            attempt_id=attempt_id,
            outcome="provider_busy",
            error_category="provider",
            error_code="provider_busy",
        )
        conn.commit()

    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT status, attempts, provider_waits, not_before > now() "
            "FROM jobs WHERE id=%s",
            (job_id,),
        )
        assert cur.fetchone() == ("pending", 0, 1, True)
        cur.execute(
            "SELECT status, error_code FROM ingest_job_attempts WHERE id=%s",
            (attempt_id,),
        )
        assert cur.fetchone() == ("provider_busy", "provider_busy")
        # Once the wait passes, the next claim carries the count with it.
        cur.execute("UPDATE jobs SET not_before=now() WHERE id=%s", (job_id,))
        _isolate_job(cur, job_id)
        claimed = db.claim_job(cur, "ingest", 180)
        conn.commit()
    assert claimed is not None
    assert claimed["id"] == job_id and claimed["provider_waits"] == 1
