"""Source candidates never replace the published file/index before promotion."""

from __future__ import annotations

import json
import secrets

import pytest

from pipeline.retrieval import store
from pipeline.store import db

pytestmark = pytest.mark.integration


def candidate(workspace, *, format="docx"):
    file_id = workspace.add_file("source.docx" if format == "docx" else "source.txt")
    job_id = "job_" + secrets.token_hex(6)
    payload = {
        "sourceRefresh": True,
        "fileId": file_id,
        "workspaceId": workspace.id,
        "actorUserId": workspace.user_id,
        "sourceRevision": 1,
        "sourceETag": "etag-b",
        "sourceEpoch": 1,
        "sourceCheckpoint": 1,
        "sourceLeaseToken": "lease-b",
    }
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE files SET source_etag='etag-a',indexed=true,content_hash='hash-a',preview_blob_path='previews/a' WHERE id=%s",
            (file_id,),
        )
        conn.execute(
            "INSERT INTO jobs(id,type,payload,status,attempts,lease_expires_at) VALUES(%s,'ingest',%s::jsonb,'running',1,now()+interval '5 minutes')",
            (job_id, json.dumps(payload)),
        )
        conn.execute(
            "INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,checkpoint,state,indexed_state,running_job_id) VALUES(%s,%s,1,%s,1,'state-b','state-a',%s)",
            (file_id, format, "sources/" + file_id, job_id),
        )
        conn.execute(
            "INSERT INTO source_refresh_candidates(file_id,job_id,epoch,checkpoint,lease_token,state,source_blob_path) VALUES(%s,%s,1,1,'lease-b','state-b',%s)",
            (file_id, job_id, "sources/candidate-" + file_id),
        )
    return {"id": job_id, "attempts": 1, "payload": payload}


@pytest.mark.asyncio
async def test_candidate_stages_preview_and_index_without_replacing_published(
    workspace,
):
    job = candidate(workspace)
    file_id = job["payload"]["fileId"]
    old = await store.attach_file_content(
        workspace_id=workspace.id, file_id=file_id, content_hash="hash-a"
    )
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE rag_contents SET status='ready' WHERE id=%s", (old["content_id"],)
        )
    token = db.bind_source_refresh(job)
    try:
        with workspace._connect() as conn, conn.transaction(), conn.cursor() as cur:
            db.require_current_file_source(cur, file_id, 1, "etag-b")
            db.set_file_status(cur, file_id, "processing")
            db.set_file_indexed(cur, file_id, False)
            db.set_file_preview_blob(cur, file_id, "previews/b")
            db.set_file_parse_artifact(
                cur, file_id, "parse/b", "fingerprint-b", "parser-v1"
            )
        new = await store.attach_file_content(
            workspace_id=workspace.id,
            file_id=file_id,
            content_hash="hash-b",
            claim_job_id=job["id"],
            source_revision=1,
            source_etag="etag-b",
        )
        with workspace._connect() as conn:
            assert conn.execute(
                "SELECT status,indexed,preview_blob_path,source_etag,content_hash FROM files WHERE id=%s",
                (file_id,),
            ).fetchone() == ("ready", True, "previews/a", "etag-a", "hash-a")
            assert (
                conn.execute(
                    "SELECT content_id FROM rag_file_contents WHERE file_id=%s",
                    (file_id,),
                ).fetchone()[0]
                == old["content_id"]
            )
            assert conn.execute(
                "SELECT preview_blob_path,parse_artifact_key,content_id FROM source_refresh_candidates WHERE file_id=%s",
                (file_id,),
            ).fetchone() == ("previews/b", "parse/b", new["content_id"])
            with conn.transaction(), conn.cursor() as cur:
                db.discard_source_candidate(
                    cur, job["payload"], job["id"], "parse failed", stale=False
                )
            assert (
                conn.execute(
                    "SELECT count(*) FROM rag_contents WHERE id=%s",
                    (new["content_id"],),
                ).fetchone()[0]
                == 0
            )
            assert (
                conn.execute(
                    "SELECT refresh_error FROM source_documents WHERE file_id=%s",
                    (file_id,),
                ).fetchone()[0]
                == "parse failed"
            )
    finally:
        db.reset_source_refresh(token)


@pytest.mark.parametrize("format,stale", [("docx", True), ("text", False)])
def test_candidate_checkpoint_fence_and_attempt_lease(workspace, format, stale):
    job = candidate(workspace, format=format)
    file_id = job["payload"]["fileId"]
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE source_documents SET checkpoint=2 WHERE file_id=%s", (file_id,)
        )
    token = db.bind_source_refresh(job)
    try:
        with workspace._connect() as conn, conn.transaction(), conn.cursor() as cur:
            if stale:
                with pytest.raises(db.SourceSupersededError):
                    db.require_current_file_source(cur, file_id, 1, "etag-b")
            else:
                db.require_current_file_source(cur, file_id, 1, "etag-b")
        with workspace._connect() as conn:
            conn.execute("UPDATE jobs SET attempts=2 WHERE id=%s", (job["id"],))
        with (
            workspace._connect() as conn,
            conn.transaction(),
            conn.cursor() as cur,
            pytest.raises(db.SourceSupersededError),
        ):
            db.require_current_file_source(cur, file_id, 1, "etag-b")
    finally:
        db.reset_source_refresh(token)


def test_source_candidate_handoff_and_late_upload_cleanup(workspace):
    job = candidate(workspace)
    file_id = job["payload"]["fileId"]
    child = "job_" + secrets.token_hex(6)
    with workspace._connect() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute(
            "INSERT INTO jobs(id,type,payload,status) VALUES(%s,'ingest',%s::jsonb,'pending')",
            (child, json.dumps(job["payload"])),
        )
        db.transfer_source_candidate(cur, job["payload"], job["id"], child)
        assert (
            cur.execute(
                "SELECT running_job_id FROM source_documents WHERE file_id=%s",
                (file_id,),
            ).fetchone()[0]
            == child
        )
        assert (
            cur.execute(
                "SELECT job_id FROM source_refresh_candidates WHERE file_id=%s",
                (file_id,),
            ).fetchone()[0]
            == child
        )
        cur.execute("DELETE FROM files WHERE id=%s", (file_id,))
        assert (
            cur.execute(
                "SELECT count(*) FROM source_refresh_candidates WHERE file_id=%s",
                (file_id,),
            ).fetchone()[0]
            == 0
        )
        assert cur.execute(
            "SELECT not_before>now()+interval '23 hours' FROM pending_blob_deletions WHERE object_path=%s",
            ("sources/candidate-" + file_id,),
        ).fetchone()[0]


@pytest.mark.asyncio
async def test_candidate_donor_captions_stay_unpublished_until_handoff(workspace):
    donor_file = workspace.add_file("donor.docx")
    donor = await store.attach_file_content(
        workspace_id=workspace.id, file_id=donor_file, content_hash="donor-hash"
    )
    digest = "a" * 64
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE rag_contents SET status='ready' WHERE id=%s", (donor["content_id"],)
        )
        conn.execute(
            "INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes) VALUES(%s,%s,%s,'caption/donor',10)",
            ("ica_" + secrets.token_hex(6), donor_file, digest),
        )
    job = candidate(workspace)
    token = db.bind_source_refresh(job)
    try:
        target = await store.attach_file_content(
            workspace_id=workspace.id,
            file_id=job["payload"]["fileId"],
            content_hash="candidate-hash",
            claim_job_id=job["id"],
        )
        assert await store.copy_content_from_donor(
            donor_id=donor["content_id"],
            dest_content_id=target["content_id"],
            dest_workspace_id=workspace.id,
            dest_file_id=job["payload"]["fileId"],
            copy_vectors=False,
        )
        with workspace._connect() as conn:
            assert conn.execute(
                "SELECT image_sha256s FROM source_refresh_candidates WHERE job_id=%s",
                (job["id"],),
            ).fetchone()[0] == [digest]
            assert (
                conn.execute(
                    "SELECT published FROM image_caption_associations WHERE file_id=%s",
                    (job["payload"]["fileId"],),
                ).fetchone()[0]
                is False
            )
    finally:
        db.reset_source_refresh(token)


def test_published_receipt_finishes_expired_job_without_retry(workspace):
    job = candidate(workspace)
    with workspace._connect() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET payload=payload||'{\"sourcePublishedCheckpoint\":1}'::jsonb,lease_expires_at=now()-interval '1 second' WHERE id=%s",
            (job["id"],),
        )
        cur.execute(
            "DELETE FROM source_refresh_candidates WHERE file_id=%s",
            (job["payload"]["fileId"],),
        )
        cur.execute(
            "UPDATE files SET revision=2,source_etag='etag-b' WHERE id=%s",
            (job["payload"]["fileId"],),
        )
        result = db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 2}, backoff_base_s={"ingest": 5}
        )
        assert (
            next(item for item in result if item["id"] == job["id"])["outcome"]
            == "done"
        )
        assert cur.execute(
            "SELECT status,attempts FROM jobs WHERE id=%s", (job["id"],)
        ).fetchone() == ("done", 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", ["same_workspace", "self", "ready_retry"])
async def test_ready_donor_keeps_caption_ownership(workspace, monkeypatch, scenario):
    from pipeline.ingest import worker

    job = candidate(workspace)
    file_id = job["payload"]["fileId"]
    donor_file = file_id if scenario == "self" else workspace.add_file("donor.docx")
    donor = await store.attach_file_content(
        workspace_id=workspace.id, file_id=donor_file, content_hash="ready-hash"
    )
    digest = "c" * 64
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE rag_contents SET status='ready' WHERE id=%s", (donor["content_id"],)
        )
        conn.execute(
            "INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes) VALUES(%s,%s,%s,'captions/ready',10)",
            ("ica_" + secrets.token_hex(6), donor_file, digest),
        )
    token = db.bind_source_refresh(job)
    monkeypatch.setattr(worker, "_finish_ok", lambda *args, **kwargs: True)
    monkeypatch.setattr(worker, "_publish_progress", lambda *args, **kwargs: None)
    monkeypatch.setattr(worker, "_reuse_office_preview", lambda **kwargs: True)

    async def forbid_copy(**kwargs):
        pytest.fail("ready canonical content must not copy chunks onto itself")

    monkeypatch.setattr(store, "copy_content_from_donor", forbid_copy)
    pin = await store.workspace_embedding_pin(workspace.id)
    try:
        if scenario == "ready_retry":
            await store.attach_file_content(
                workspace_id=workspace.id,
                file_id=file_id,
                content_hash="ready-hash",
                claim_job_id=job["id"],
            )
        assert await worker._reuse_donor(
            job=job,
            payload=job["payload"],
            file_id=file_id,
            ws=workspace.id,
            name="source.docx",
            kind="doc",
            route="document_parse",
            donor={"id": donor["content_id"], "content_hash": "ready-hash", **pin},
            identity="ready-test",
            source_sha256="a" * 64,
            preview_blob_path="previews/ready",
        )
        with workspace._connect() as conn:
            assert conn.execute(
                "SELECT image_sha256s FROM source_refresh_candidates WHERE job_id=%s",
                (job["id"],),
            ).fetchone()[0] == [digest]
            assert (
                conn.execute(
                    "SELECT image_sha256 FROM image_caption_associations WHERE file_id=%s",
                    (file_id,),
                ).fetchone()[0]
                == digest
            )
    finally:
        db.reset_source_refresh(token)
