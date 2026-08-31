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
import secrets

import pytest

from pipeline.config import cfg
from pipeline.retrieval import store
from pipeline.retrieval.chunking import tokenize_for_search
from pipeline.retrieval.usage_extract import NormalizedUsage
from pipeline.store import db

pytestmark = pytest.mark.integration


def test_audio_age_out_and_submission_race_retain_cleanup_identity(workspace):
    import psycopg

    file_id = f"f_{secrets.token_hex(6)}"
    job_id = f"job_{secrets.token_hex(6)}"
    transcription_id = f"at_{secrets.token_hex(6)}"
    provider_call_id = f"pc_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO files (id, workspace_id, user_id, name, kind, blob_path)
            VALUES (%s, %s, %s, 'lecture.mp3', 'audio', 'sources/audio')
            """,
            (file_id, workspace.id, workspace.user_id),
        )
        cur.execute(
            "INSERT INTO jobs (id, type, payload) VALUES (%s, 'ingest', '{}')",
            (job_id,),
        )
        cur.execute(
            """
            INSERT INTO audio_transcriptions (
              id, job_id, file_id, source_sha256, duration_seconds,
              billable_seconds, concurrency_units, rate_version,
              credit_micros_per_second, provider_call_id, status
            ) VALUES (%s,%s,%s,%s,10,10,1,1,250000,%s,'submitting')
            """,
            (transcription_id, job_id, file_id, "ab" * 32, provider_call_id),
        )
        db.fail_audio_transcription(
            cur,
            transcription_id,
            "submission could not be reconciled",
            cleanup_requested=True,
        )
        db.mark_audio_pending(cur, transcription_id, "provider-late")
        cur.execute(
            """
            SELECT provider_transcription_id, status, cleanup_requested
            FROM audio_transcriptions WHERE id=%s
            """,
            (transcription_id,),
        )
        assert cur.fetchone() == ("provider-late", "failed", True)

        candidate = db.claim_audio_cleanup(cur)
        assert candidate is not None
        assert candidate["id"] == transcription_id
        assert candidate["provider_transcription_id"] == "provider-late"
        db.complete_audio_cleanup(cur, transcription_id, provider_call_id)
        cur.execute(
            "SELECT 1 FROM audio_transcriptions WHERE id=%s", (transcription_id,)
        )
        assert cur.fetchone() is None


def test_ingest_provider_call_links_context_and_usage_atomically(workspace):
    import psycopg

    reservation_id = f"cr_{secrets.token_hex(6)}"
    call_id = f"pc_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO provider_sessions (
              id, actor_user_id, workspace_id, trace_id, surface,
              reserved_micros, expires_at
            ) VALUES (%s, %s, %s, 'trace-ingest', 'ingest', 0,
                      now() + interval '30 minutes')
            """,
            (reservation_id, workspace.user_id, workspace.id),
        )
        db.open_provider_call(
            cur,
            reservation_id,
            call_id,
            "llm",
            "ingest_summary",
            "instant",
            context_system_tokens=11,
            context_tool_tokens=7,
            context_conversation_tokens=23,
            context_total_tokens=41,
            context_window_tokens=128_000,
            context_counting_method="test_estimator",
            context_counting_version=1,
        )
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
                   ue.provider_call_id
            FROM provider_calls pc
            JOIN usage_events ue
              ON ue.reservation_id = pc.reservation_id
             AND ue.provider_call_id = pc.id
            WHERE pc.id = %s
            """,
            (call_id,),
        ).fetchone()
        assert row == ("applied", 41, 44, call_id)
        conn.execute("DELETE FROM usage_events WHERE provider_call_id = %s", (call_id,))
        conn.execute("DELETE FROM provider_sessions WHERE id = %s", (reservation_id,))


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
            cur, reservation_id, terminal_call_id, "llm", "terminal", "instant"
        )
        db.open_provider_call(
            cur, reservation_id, terminal_call_id, "llm", "terminal", "instant"
        )
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


async def _write(ws, file_id: str, texts: list[str], *, axis_base: int = 0) -> None:
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
        terms="chlorophyll or absorbs",
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == "Chlorophyll absorbs red light"
    assert rows[0]["file_name"] == "bio.txt"


async def test_vector_half_matches_without_shared_vocabulary(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["alpha", "beta"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(1),
        terms="nothing matches this",
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == "beta"


async def test_cjk_is_retrievable_through_the_bigram_tokenizer(workspace):
    """Postgres' built-in configurations make one token of a Chinese sentence;
    the application-side bigrams are what make this query possible at all."""
    file_id = workspace.add_file("zh.txt")
    await _write(workspace, file_id, ["光合作用把光能转化为化学能", "无关内容"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(999),
        terms="光合 or 合作 or 作用",
        file_ids=None,
        candidates=10,
    )

    assert rows and rows[0]["text"].startswith("光合作用")


async def test_search_is_scoped_to_the_workspace_and_the_file_filter(workspace):
    keep = workspace.add_file("keep.txt")
    drop = workspace.add_file("drop.txt")
    await _write(workspace, keep, ["Chlorophyll absorbs red light"])
    await _write(workspace, drop, ["Chlorophyll absorbs blue light"], axis_base=10)

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(0),
        terms="chlorophyll",
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
        terms="chlorophyll",
        file_ids=None,
        candidates=10,
    )

    row = rows[0]
    assert (row["page_start"], row["page_end"]) == (1, 1)
    assert store.decode_regions(row["regions"])[0]["space"] == "page-1000-topleft"
    assert row["section_path"] == "Ch 1 › Section"


async def test_neighbours_come_back_in_document_order(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["one", "two", "three", "four"])

    rows = await store.neighbor_chunks(file_id=file_id, chunk_idx=2)

    assert [row["text"] for row in rows] == ["two", "three", "four"]


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


# ------------------------------------------------------------------ concepts


async def _concepts(ws, file_id: str, names_to_chunks: dict[str, list[str]]) -> None:
    content_id = ws.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (file_id,)
    )
    await store.replace_content_concepts(
        workspace_id=ws.id,
        content_id=content_id,
        concepts=[
            {
                "id": f"cpt_{file_id}_{i}",
                "name": name,
                "norm": store.normalize_concept(name),
                "chunk_ids": chunk_ids,
            }
            for i, (name, chunk_ids) in enumerate(names_to_chunks.items())
        ],
    )


async def test_a_concept_named_by_two_files_is_one_row(workspace):
    """Co-mention is the whole point of the index, so the same idea in two
    documents must not become two concepts."""
    a = workspace.add_file("a.txt")
    b = workspace.add_file("b.txt")
    await _write(workspace, a, ["alpha"])
    await _write(workspace, b, ["beta"], axis_base=10)
    await _concepts(workspace, a, {"ATP": [f"{a}_c0"]})
    await _concepts(workspace, b, {"  atp  ": [f"{b}_c0"]})

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
        )
        == 1
    )
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concept_mentions m JOIN rag_concepts c "
            "ON c.id = m.concept_id WHERE c.workspace_id = %s",
            (workspace.id,),
        )
        == 2
    )


async def test_related_concepts_reports_co_mention_and_where(workspace):
    a = workspace.add_file("a.txt")
    b = workspace.add_file("b.txt")
    await _write(workspace, a, ["alpha"])
    await _write(workspace, b, ["beta"], axis_base=10)
    await _concepts(workspace, a, {"ATP": [f"{a}_c0"], "Calvin cycle": [f"{a}_c0"]})
    await _concepts(workspace, b, {"ATP": [f"{b}_c0"], "Mitochondria": [f"{b}_c0"]})

    rows = await store.related_concepts(workspace_id=workspace.id, name="atp")

    assert {row["name"] for row in rows} == {"Calvin cycle", "Mitochondria"}
    assert all(row["mentions"] >= 1 for row in rows)


async def test_a_concept_loses_its_row_when_its_last_mention_goes(workspace):
    file_id = workspace.add_file("a.txt")
    await _write(workspace, file_id, ["alpha"])
    await _concepts(workspace, file_id, {"Ephemeral": [f"{file_id}_c0"]})
    await _concepts(workspace, file_id, {})

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
        )
        == 0
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
        terms="chlorophyll",
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
    await _concepts(workspace, file_id, {"ATP": [f"{file_id}_c0"]})
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
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concept_mentions m JOIN rag_chunks c "
            "ON c.id = m.chunk_id WHERE c.content_id = %s",
            (content_id,),
        )
        == 0
    )
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
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


def test_lease_reclaim_fails_after_budget(workspace):
    from pipeline.store import db

    job_id = f"job_{workspace.id[-8:]}"
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
        VALUES (%s, 'ingest', '{}'::jsonb, 'running', 3, now() - interval '1 minute')
        RETURNING id
        """,
        (job_id,),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        reclaimed = db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 3}, backoff_base_s={"ingest": 30}
        )
        conn.commit()
    assert reclaimed[0]["outcome"] == "failed"
    assert (
        workspace.scalar("SELECT status FROM jobs WHERE id = %s", (job_id,)) == "failed"
    )


async def test_donor_copy_reuses_chunks_across_workspaces(workspace):
    import secrets

    import psycopg

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
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s,'ingest',%s::jsonb,'running',2) RETURNING id
        """,
        (
            job_id,
            json.dumps(
                {
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
        "fileId": file_id,
        "workspaceId": workspace.id,
        "sourceRevision": old_revision,
        "sourceETag": old_etag,
        "reservationId": reservation_id,
    }
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'ingest', %s::jsonb, 'running', 1)
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
        worker._record_source_sha(file_id, "a" * 64, old_revision, old_etag)
    with pytest.raises(TerminalError, match="superseded"):
        worker._record_preview_blob(file_id, "previews/a.pdf", old_revision, old_etag)
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
    with pytest.raises(TerminalError, match="superseded"):
        worker._finish_ok(
            file_id,
            "replacement.docx",
            job_id,
            "content-a",
            attempt=1,
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
        (waiter_job, json.dumps({"fileId": waiter_file, "workspaceId": workspace.id})),
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


def test_finishing_a_deleted_file_still_marks_the_job_done(workspace):
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
    assert workspace.scalar("SELECT status FROM jobs WHERE id=%s", (job_id,)) == "done"
    assert (
        workspace.scalar(
            "SELECT count(*) FROM notifications WHERE workspace_id=%s",
            (workspace.id,),
        )
        == 0
    )
