"""Integration tests for the retrieval SQL, against the gateway's real schema.

Docker but no cassette: embeddings are synthetic unit vectors, so every query
below is a pure test of the statements in ``retrieval/store.py`` and of the
schema they assume. That separation matters because a column rename in
``0001_init.sql`` breaks these silently at runtime and nowhere at import time.

Vectors live in a per-width side table, so these exercise the default width the
fixture workspace is pinned to. ``store.vector_table`` is what keeps the
interpolated table name inside the set the schema actually defines.
"""

from __future__ import annotations

import hashlib

import pytest

from pipeline.config import cfg
from pipeline.retrieval import store
from pipeline.retrieval.chunking import tokenize_for_search

pytestmark = pytest.mark.integration


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
                {"page": i + 1, "bbox": [1, 2, 3, 4], "space": "mineru-1000-lefttop"}
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
        embedding_dim=cfg.embedding_dim,
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
        embedding_dim=cfg.embedding_dim,
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
        embedding_dim=cfg.embedding_dim,
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
        embedding_dim=cfg.embedding_dim,
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
        embedding_dim=cfg.embedding_dim,
    )

    row = rows[0]
    assert (row["page_start"], row["page_end"]) == (1, 1)
    assert store.decode_regions(row["regions"])[0]["space"] == "mineru-1000-lefttop"
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
        summary="A summary.",
        outline=[{"title": "Ch 1", "pageStart": 1}],
    )

    outline = await store.workspace_outline(workspace.id)

    assert [c["name"] for c in outline["chapters"]] == ["Biology"]
    by_id = {f["id"]: f for f in outline["files"]}
    assert by_id[filed]["chapter_id"] == chapter and by_id[filed]["chunks"] == 1
    assert by_id[filed]["summary"] == "A summary."
    assert by_id[unfiled]["chapter_id"] is None and by_id[unfiled]["chunks"] == 0


async def test_moving_a_file_between_chapters_marks_both_dirty(workspace):
    """Reorganization invalidates summaries through a trigger rather than a
    handler, because the paths that reorganize files are many."""
    source = workspace.add_chapter("From")
    target = workspace.add_chapter("To")
    file_id = workspace.add_file("a.txt", source)
    await store.set_chapter_summary(source, "clean")
    await store.set_chapter_summary(target, "clean")

    workspace.scalar(
        "UPDATE files SET chapter_id = %s WHERE id = %s RETURNING id", (target, file_id)
    )

    dirty = {row["chapter_id"] for row in await store.dirty_chapters(workspace.id)}
    assert dirty == {source, target}
    assert (
        workspace.scalar(
            "SELECT count(*) FROM jobs WHERE type = 'summaries_rollup' "
            "AND payload->>'workspaceId' = %s",
            (workspace.id,),
        )
        >= 1
    )


async def test_content_ingest_marks_only_its_chapter_dirty(workspace):
    changed = workspace.add_chapter("Changed")
    untouched = workspace.add_chapter("Untouched")
    file_id = workspace.add_file("a.txt", changed)
    workspace.add_file("b.txt", untouched)
    await store.set_chapter_summary(changed, "clean")
    await store.set_chapter_summary(untouched, "clean")

    await store.mark_workspace_dirty(workspace.id, file_id)

    dirty = {row["chapter_id"] for row in await store.dirty_chapters(workspace.id)}
    assert dirty == {changed}


async def test_deleting_a_chapter_does_not_break_its_files(workspace):
    """The chapter FK is ON DELETE SET NULL, so the trigger fires for a chapter
    that no longer exists — it must not try to mark it dirty."""
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
        embedding_dim=cfg.embedding_dim,
    )
    read = await store.read_file_range(file_id=second, start=0, count=1)

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
        claimed = db.claim_job(cur, {"ingest": 180, "summaries_rollup": 60})
        conn.commit()
    assert claimed is None
    assert (
        workspace.scalar("SELECT status FROM jobs WHERE id = %s", (job_id,))
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
        claimed = db.claim_job(cur, {"ingest": 180, "summaries_rollup": 60})
        conn.commit()
    assert claimed is not None
    assert claimed["id"] == job_id
    assert claimed["attempts"] == 2


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


def test_rollup_requeue_supersedes_when_pending_sibling_exists(workspace):
    import json

    from pipeline.store import db

    running = f"job_run_{workspace.id[-6:]}"
    pending = f"job_pend_{workspace.id[-6:]}"
    payload = json.dumps({"workspaceId": workspace.id})
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'summaries_rollup', %s::jsonb, 'running', 1)
        RETURNING id
        """,
        (running, payload),
    )
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status)
        VALUES (%s, 'summaries_rollup', %s::jsonb, 'pending')
        RETURNING id
        """,
        (pending, payload),
    )
    with workspace._connect() as conn:
        cur = conn.cursor()
        outcome = db.requeue_job(
            cur,
            job_id=running,
            job_type="summaries_rollup",
            workspace_id=workspace.id,
            error="chapter failed",
            backoff_s=0,
        )
        conn.commit()
    assert outcome == "superseded"
    assert (
        workspace.scalar("SELECT status FROM jobs WHERE id = %s", (running,)) == "done"
    )


async def test_failed_chapter_rollup_leaves_the_chapter_dirty(workspace, monkeypatch):
    from pipeline.jobs import RetryableError
    from pipeline.retrieval import indexing

    chapter = workspace.add_chapter("Cells")
    file_id = workspace.add_file("a.txt", chapter)
    await _write(workspace, file_id, ["mitochondria"])
    content_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (file_id,)
    )
    await store.upsert_content_summary(
        workspace_id=workspace.id,
        content_id=content_id,
        fingerprint="fp",
        summary="Mitochondria make ATP.",
        outline=[],
    )
    await store.mark_workspace_dirty(workspace.id, file_id)

    async def boom(*_a, **_k):
        raise RuntimeError("provider down")

    monkeypatch.setattr(indexing.models, "complete_text", boom)
    with pytest.raises(RetryableError, match="chapter rollup failed"):
        await indexing.rollup_summaries(workspace.id)

    assert workspace.scalar(
        "SELECT dirty FROM rag_chapter_summaries WHERE chapter_id = %s", (chapter,)
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
    await store.upsert_content_summary(
        workspace_id=workspace.id,
        content_id=donor_id,
        fingerprint="fp",
        summary="Osmosis.",
        outline=[],
    )

    other_id = f"ws_{secrets.token_hex(6)}"
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name, color) VALUES (%s, %s, %s, 'blue')",
            (other_id, workspace.user_id, "Other"),
        )
    other = type(workspace)(workspace.dsn, other_id)
    dest_file = other.add_file("copy.txt")
    donor = await store.find_ready_donor(source_sha256=sha, pipeline_identity=identity)
    assert donor is not None
    assert donor["id"] == donor_id

    pin = await store.workspace_embedding_pin(other.id)
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
    table = store.vector_table(pin["embedding_dim"])
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
    donor = await store.find_ready_donor(source_sha256=sha, pipeline_identity=identity)
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
    pin = await store.workspace_embedding_pin(other.id)
    table = store.vector_table(pin["embedding_dim"])
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


def test_only_the_claiming_attempt_may_write_its_outcome(workspace):
    """A worker whose lease was reclaimed must not overwrite its successor.

    The scenario is a live worker that lost its lease (heartbeat failure, long
    Modal parse) while the reaper re-pended the row and a second worker took it.
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
        successor = db.claim_job(cur, {"ingest": 180, "summaries_rollup": 60})
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


def test_rollup_requeue_folds_when_the_index_rejects_the_row(workspace):
    """A sibling committed mid-statement is invisible to the NOT EXISTS guard.

    READ COMMITTED takes the snapshot at statement start, so the unique pending
    index is the thing that catches this. The requeue has to treat that as the
    fold it is, not raise out of the worker's failure handler.
    """
    import json
    import threading
    import time

    import psycopg

    from pipeline.store import db

    running = f"job_run_{workspace.id[-6:]}"
    sibling = f"job_sib_{workspace.id[-6:]}"
    payload = json.dumps({"workspaceId": workspace.id})
    workspace.scalar(
        """
        INSERT INTO jobs (id, type, payload, status, attempts)
        VALUES (%s, 'summaries_rollup', %s::jsonb, 'running', 1)
        RETURNING id
        """,
        (running, payload),
    )

    # Hold an uncommitted pending sibling: invisible to the guard's snapshot,
    # but the index entry the requeue collides with.
    blocker = psycopg.connect(workspace.dsn)
    blocker.execute(
        "INSERT INTO jobs (id, type, payload, status) VALUES (%s,'summaries_rollup',%s::jsonb,'pending')",
        (sibling, payload),
    )
    outcome: dict[str, object] = {}

    def requeue() -> None:
        started = time.monotonic()
        with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
            outcome["result"] = db.requeue_job(
                cur,
                job_id=running,
                job_type="summaries_rollup",
                workspace_id=workspace.id,
                error="chapter failed",
                backoff_s=0,
            )
            conn.commit()
        outcome["elapsed"] = time.monotonic() - started

    worker_thread = threading.Thread(target=requeue)
    worker_thread.start()
    try:
        # The requeue is now blocked on the sibling's index entry; committing it
        # is what turns that wait into the violation.
        time.sleep(0.5)
        blocker.commit()
        worker_thread.join(timeout=15)
    finally:
        blocker.close()

    assert worker_thread.is_alive() is False
    assert outcome["result"] == "superseded"
    # Waiting on the sibling's index entry is what proves the violation path ran
    # rather than the NOT EXISTS guard seeing a committed sibling.
    assert float(outcome["elapsed"]) > 0.25
    assert workspace.scalar("SELECT status FROM jobs WHERE id=%s", (running,)) == "done"
    assert (
        workspace.scalar(
            "SELECT count(*) FROM jobs WHERE type='summaries_rollup' "
            "AND status='pending' AND payload->>'workspaceId'=%s",
            (workspace.id,),
        )
        == 1
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
        deleted = db.sweep_artifact_cache(
            cur, caption_ttl_days=90, parse_zip_ttl_hours=6
        )
        conn.commit()
    assert deleted == 0
    assert workspace.scalar(
        "SELECT count(*) FROM artifact_cache WHERE source_sha256 = %s", (sha,)
    )
