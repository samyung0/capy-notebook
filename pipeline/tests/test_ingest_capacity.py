from pipeline.ingest import capacity, worker


def test_role_lock_is_shared_and_released(tmp_path, monkeypatch):
    monkeypatch.setattr(capacity.cfg, "shared_capacity_lock_dir", str(tmp_path))

    first = capacity.try_acquire("ingest")
    assert first is not None
    assert capacity.try_acquire("ingest") is None

    parse = capacity.try_acquire("parse")
    assert parse is not None
    imported = capacity.try_acquire("import")
    assert imported is not None
    assert capacity.try_acquire("import") is None
    imported.release()
    parse.release()
    first.release()

    replacement = capacity.try_acquire("ingest")
    assert replacement is not None
    replacement.release()


def test_unconfigured_lock_keeps_existing_process_capacity(monkeypatch):
    monkeypatch.setattr(capacity.cfg, "shared_capacity_lock_dir", "")

    first = capacity.try_acquire("ingest")
    second = capacity.try_acquire("ingest")
    assert first is not None
    assert second is not None
    first.release()
    second.release()


def test_busy_role_does_not_claim_a_queue_row(monkeypatch):
    def fail_claim(_job_type):
        raise AssertionError("claimed a row")

    monkeypatch.setattr(capacity, "try_acquire", lambda _job_type: None)
    monkeypatch.setattr(worker, "_claim_one", fail_claim)

    job, lease, busy = worker._claim_one_with_capacity("parse")

    assert job is None
    assert lease is None
    assert busy is True


def test_empty_queue_releases_the_shared_role(monkeypatch):
    released = False

    class Lease:
        def release(self):
            nonlocal released
            released = True

    monkeypatch.setattr(capacity, "try_acquire", lambda _job_type: Lease())
    monkeypatch.setattr(worker, "_claim_one", lambda _job_type: None)

    job, lease, busy = worker._claim_one_with_capacity("ingest")

    assert job is None
    assert lease is None
    assert busy is False
    assert released is True
