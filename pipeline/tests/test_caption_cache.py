"""Caption reuse follows current holders; object existence grants no access."""

import json
import secrets

import pytest

from pipeline.ingest import source_text
from pipeline.parse import caption_cache
from pipeline.retrieval import store
from pipeline.store import db

pytestmark = pytest.mark.integration
SHA = "a" * 64


@pytest.fixture
def cache(monkeypatch):
    blobs = {}
    calls = []

    async def describe(_url, _prompt, **_kwargs):
        calls.append(1)
        return f"Image description {len(calls)}"

    monkeypatch.setattr(
        caption_cache.blobstore, "read_bytes", lambda path: blobs.get(path)
    )
    monkeypatch.setattr(
        caption_cache.blobstore,
        "write_bytes",
        lambda path, raw, _mime: blobs.__setitem__(path, raw),
    )
    monkeypatch.setattr(caption_cache.models, "caption_image", describe)
    return blobs, calls


def _job(workspace, file_id: str, workspace_id: str | None = None) -> dict:
    """A running ingest job for the file, as the worker claims it."""
    job_id = "job_" + secrets.token_hex(8)
    payload = {
        "fileId": file_id,
        "workspaceId": workspace_id or workspace.id,
        "actorUserId": workspace.user_id,
        "sourceRevision": 1,
        "sourceETag": "",
    }
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO jobs(id,type,payload,status,attempts,lease_expires_at) VALUES(%s,'ingest',%s::jsonb,'running',1,now()+interval '5 minutes')",
            (job_id, json.dumps(payload)),
        )
    return {"id": job_id, "attempts": 1, "payload": payload}


async def _caption(workspace, file_id: str, workspace_id: str | None = None):
    """Caption the file inside its own ingest job, the only production path."""
    token = db.bind_source_refresh(_job(workspace, file_id, workspace_id))
    try:
        return await caption_cache.caption(
            file_id=file_id,
            image_sha256=SHA,
            data_url="data:image/png;base64,AA==",
            prompt="Describe image",
        )
    finally:
        db.reset_source_refresh(token)


def _donor(workspace, blobs, file_id: str, text: str = "Donor description"):
    """A caption an earlier ingest attached to ``file_id``: (text, path, size)."""
    raw = json.dumps({"text": text}).encode()
    path = f"image-captions/{SHA}/{secrets.token_hex(8)}.json"
    blobs[path] = raw
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO image_caption_associations(id,file_id,image_sha256,caption_blob_path,size_bytes,published) VALUES(%s,%s,%s,%s,%s,true)",
            ("ica_" + secrets.token_hex(8), file_id, SHA, path, len(raw)),
        )
    return text, path, len(raw)


def _other_workspace(workspace, owner: str = "u_1", privacy: str = "private"):
    """Another workspace holding one image file: (workspace id, file id)."""
    ws, file_id = "ws_" + secrets.token_hex(8), "f_" + secrets.token_hex(8)
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO workspaces(id,user_id,name,privacy) VALUES(%s,%s,'Other',%s)",
            (ws, owner, privacy),
        )
        conn.execute(
            "INSERT INTO files(id,workspace_id,name,kind,size_bytes,status,blob_path) VALUES(%s,%s,'image.png','png',20,'ready',%s)",
            (file_id, ws, "sources/" + file_id),
        )
    return ws, file_id


@pytest.mark.parametrize("boundary", ["model", "upload"])
async def test_replaced_source_cannot_attach_a_late_private_caption(
    workspace, cache, monkeypatch, boundary
):
    file_id = workspace.add_file("source.png")
    token = db.bind_source_refresh(_job(workspace, file_id))

    def replace_source():
        with workspace._connect() as conn:
            conn.execute(
                "UPDATE files SET revision=2,blob_path='source/base-b' WHERE id=%s",
                (file_id,),
            )
            conn.execute(
                "DELETE FROM image_caption_associations WHERE file_id=%s", (file_id,)
            )
            conn.execute(
                "UPDATE workspaces SET privacy='public' WHERE id=%s", (workspace.id,)
            )

    original_model = caption_cache.models.caption_image
    original_write = caption_cache.blobstore.write_bytes

    async def describe(*args, **kwargs):
        result = await original_model(*args, **kwargs)
        if boundary == "model":
            replace_source()
        return result

    def write(path, raw, mime):
        original_write(path, raw, mime)
        if boundary == "upload":
            replace_source()

    monkeypatch.setattr(caption_cache.models, "caption_image", describe)
    monkeypatch.setattr(caption_cache.blobstore, "write_bytes", write)
    monkeypatch.setattr(
        source_text, "_encode_image", lambda *_args: "data:image/png;base64,AA=="
    )
    try:
        with pytest.raises(db.SourceSupersededError):
            await source_text.caption_image_source(
                local_path="synthetic",
                name="source.png",
                source_sha256=SHA,
                file_id=file_id,
            )
    finally:
        db.reset_source_refresh(token)
        monkeypatch.setattr(caption_cache.models, "caption_image", original_model)
        monkeypatch.setattr(caption_cache.blobstore, "write_bytes", original_write)
    assert (
        workspace.scalar(
            "SELECT count(*) FROM image_caption_associations WHERE file_id=%s",
            (file_id,),
        )
        == 0
    )
    # A rejected upload keeps cleanup ownership, but grants no resource access.
    abandoned = next(iter(cache[0]))
    assert (
        workspace.scalar(
            "SELECT count(*) FROM artifact_cache WHERE object_path=%s", (abandoned,)
        )
        == 1
    )
    target_ws, target_file = _other_workspace(workspace)
    try:
        fresh = await _caption(workspace, target_file, target_ws)
        assert not fresh[3] and fresh[1] != abandoned
        assert len(cache[1]) == 2
    finally:
        with workspace._connect() as conn:
            conn.execute("DELETE FROM workspaces WHERE id=%s", (target_ws,))


@pytest.mark.parametrize("change", ["revision", "attempt"])
async def test_ordinary_lookup_rejects_replaced_source_or_attempt(
    workspace, cache, change
):
    _donor(workspace, cache[0], workspace.add_file("donor.png"))
    file_id = workspace.add_file("source.png")
    job = _job(workspace, file_id)
    with workspace._connect() as conn:
        if change == "revision":
            conn.execute("UPDATE files SET revision=2 WHERE id=%s", (file_id,))
        else:
            conn.execute("UPDATE jobs SET attempts=2 WHERE id=%s", (job["id"],))
    token = db.bind_source_refresh(job)
    try:
        with pytest.raises(db.SourceSupersededError):
            await caption_cache.lookup(file_id, SHA)
    finally:
        db.reset_source_refresh(token)
    assert (
        workspace.scalar(
            "SELECT count(*) FROM image_caption_associations WHERE file_id=%s",
            (file_id,),
        )
        == 0
    )
    assert not cache[1]


async def test_workspace_reuse_survives_one_holder_and_private_workspaces_do_not_share(
    workspace, cache
):
    original, clone = workspace.add_file("original.png"), workspace.add_file("copy.png")
    first = await _caption(workspace, original)
    second = await _caption(workspace, clone)
    assert second[:3] == first[:3] and second[3]
    # Caption payloads contain only the image description, never containing text.
    assert json.loads(cache[0][first[1]]) == {"text": "Image description 1"}
    assert (
        workspace.scalar(
            "SELECT count(*) FROM artifact_cache WHERE object_path=%s", (first[1],)
        )
        == 0
    )
    with workspace._connect() as conn:
        conn.execute("DELETE FROM files WHERE id=%s", (original,))
    assert (await _caption(workspace, clone))[3]
    other_ws, other_file = _other_workspace(workspace)
    try:
        assert not (await _caption(workspace, other_file, other_ws))[3]
        assert len(cache[1]) == 2
    finally:
        with workspace._connect() as conn:
            conn.execute("DELETE FROM workspaces WHERE id=%s", (other_ws,))


@pytest.mark.parametrize("visibility", ["link", "public"])
async def test_workspace_visibility_is_live_and_retained_associations_keep_their_grant(
    workspace, cache, visibility
):
    user = "u_" + secrets.token_hex(8)
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO users(id,name,email) VALUES(%s,'Other',%s)",
            (user, f"{user}@test.invalid"),
        )
    donor_ws, donor_file = _other_workspace(workspace, user, visibility)
    target, late = workspace.add_file("target.png"), workspace.add_file("late.png")
    try:
        donor = _donor(workspace, cache[0], donor_file)
        assert (await _caption(workspace, target))[:3] == donor
        with workspace._connect() as conn:
            conn.execute(
                "UPDATE workspaces SET privacy='private' WHERE id=%s", (donor_ws,)
            )
            # The target holds its own authorized association. Remove it before
            # testing a new requester, so it cannot itself act as a same-scope donor.
            conn.execute("DELETE FROM files WHERE id=%s", (target,))
        assert not (await _caption(workspace, late))[3]
        assert len(cache[1]) == 1
    finally:
        with workspace._connect() as conn:
            conn.execute("DELETE FROM users WHERE id=%s", (user,))


@pytest.mark.parametrize("state", ["deletion_pending", "deleted"])
async def test_unreadable_owner_cannot_donate_but_prior_target_keeps_its_grant(
    workspace, cache, state
):
    owner = "u_" + secrets.token_hex(8)
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO users(id,name,email) VALUES(%s,'Donor',%s)",
            (owner, owner + "@test.invalid"),
        )
    parent, donor_id = _other_workspace(workspace, owner, "public")
    retained, late = workspace.add_file("retained.png"), workspace.add_file("late.png")
    try:
        original = _donor(workspace, cache[0], donor_id)
        assert (await _caption(workspace, retained))[:3] == original
        donor_content = await store.attach_file_content(
            workspace_id=parent,
            file_id=donor_id,
            content_hash="donor-content",
            source_sha256=SHA,
            pipeline_identity="image-review",
        )
        await store.mark_content_ready(donor_content["content_id"])
        destination = await store.attach_file_content(
            workspace_id=workspace.id,
            file_id=late,
            content_hash="destination-content",
        )
        pin = await store.workspace_embedding_pin(workspace.id)
        donor = await store.find_ready_donor(
            workspace_id=workspace.id,
            source_sha256=SHA,
            pipeline_identity="image-review",
            **pin,
        )
        assert donor is not None
        with workspace._connect() as conn:
            if state == "deletion_pending":
                conn.execute(
                    "UPDATE users SET deletion_requested_at=now(),purge_after=now()+interval '30 days' WHERE id=%s",
                    (owner,),
                )
            else:
                conn.execute(
                    "UPDATE users SET deletion_requested_at=now(),purge_after=now(),deleted_at=now() WHERE id=%s",
                    (owner,),
                )
        # This caption was acquired while the donor was readable. Its own
        # resource reference survives; no new donor access is needed.
        retained_caption = await _caption(workspace, retained)
        assert retained_caption[:3] == original and retained_caption[3]
        assert (
            await store.find_ready_donor(
                workspace_id=workspace.id,
                source_sha256=SHA,
                pipeline_identity="image-review",
                **pin,
            )
            is None
        )
        # A donor selected before closure must fail transfer admission too.
        assert not await store.attach_donor_captions(
            donor_id=donor["id"],
            dest_workspace_id=workspace.id,
            dest_file_id=late,
        )
        assert not await store.copy_content_from_donor(
            donor_id=donor["id"],
            dest_content_id=destination["content_id"],
            dest_workspace_id=workspace.id,
            dest_file_id=late,
            copy_vectors=False,
        )
        with workspace._connect() as conn:
            # Remove the authorized local holder before testing a new grant.
            conn.execute("DELETE FROM files WHERE id=%s", (retained,))
        fresh = await _caption(workspace, late)
        assert not fresh[3] and fresh[0] != original[0]
        assert len(cache[1]) == 1
    finally:
        with workspace._connect() as conn:
            conn.execute("DELETE FROM users WHERE id=%s", (owner,))
