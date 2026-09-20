import json
import sys

import batches
import ingest
import store

SHA = "c" * 64


def fake_runner(exit_codes, trace):
    """A stage runner that runs a real subprocess exiting with the stage's code."""

    def run(book, run_dir, log):
        code = exit_codes.get(log.stem, 0)
        trace.append(log.stem)
        return ingest.run_command(
            [
                sys.executable,
                "-c",
                f"print('stage {log.stem}'); raise SystemExit({code})",
            ],
            log,
        )

    return run


def queue_book(tmp_path):
    run_dir = tmp_path / "runs/b"
    run_dir.mkdir(parents=True)
    return store.add_book(
        SHA,
        "b",
        {"id": "b", "title": "B", "subject_id": "s", "pages": 1, "pdf_path": "x"},
        str(run_dir),
    )


def test_failure_marks_the_stage_and_retry_resumes_from_it(tmp_path, monkeypatch):
    trace = []
    monkeypatch.setattr(ingest, "check_dependencies", lambda stage: None)
    monkeypatch.setattr(
        ingest,
        "STAGE_RUNNERS",
        dict.fromkeys(ingest.STAGES, fake_runner({"topics": 3}, trace)),
    )
    monkeypatch.setattr(ingest, "published_version", lambda run_dir, book_id: 7)
    monkeypatch.setattr(store, "BOOKS_JSON", tmp_path / "books.json")
    store.set_setting("ingest", "running")
    book = queue_book(tmp_path)
    ingest.run_book(book)
    book = store.book(SHA)
    assert book["status"] == "failed" and book["stage"] == "topics"
    assert "topics exited 3" in book["error"] and trace == [
        "parse",
        "figures",
        "topics",
    ]
    runs = store.stage_runs(SHA)
    assert [(r["stage"], r["exit_code"]) for r in runs] == [
        ("parse", 0),
        ("figures", 0),
        ("topics", 3),
    ]
    log = (store.LOGS / "b/topics.log").read_text(encoding="utf-8")
    assert "stage topics" in log and "exit 3" in log
    # retry: the failed stage runs again, nothing before it
    trace.clear()
    ingest.STAGE_RUNNERS["topics"] = fake_runner({}, trace)
    store.set_book(SHA, status="queued", error=None)
    ingest.run_book(store.book(SHA))
    book = store.book(SHA)
    assert trace == ["topics", "transcribe", "tag", "index", "publish"]
    assert (
        book["status"] == "published" and book["stage"] is None and book["version"] == 7
    )
    # publish exported the manifest with its version into books.json
    exported = json.loads((tmp_path / "books.json").read_text(encoding="utf-8"))
    assert [(b["id"], b["version"]) for b in exported["books"]] == [("b", 7)]


def test_pause_finishes_the_current_stage_then_requeues_at_the_next(
    tmp_path, monkeypatch
):
    trace = []
    monkeypatch.setattr(ingest, "check_dependencies", lambda stage: None)

    def pausing(book, run_dir, log):
        trace.append(log.stem)
        if log.stem == "figures":
            store.set_setting("ingest", "paused")
        return 0

    monkeypatch.setattr(ingest, "STAGE_RUNNERS", dict.fromkeys(ingest.STAGES, pausing))
    store.set_setting("ingest", "running")
    ingest.run_book(queue_book(tmp_path))
    book = store.book(SHA)
    assert trace == ["parse", "figures"]
    assert book["status"] == "queued" and book["stage"] == "topics"
    store.remove_book(SHA)  # allowed once paused


def test_a_down_dependency_pauses_the_workflow_with_the_reason(tmp_path, monkeypatch):
    monkeypatch.setattr(
        ingest,
        "check_dependencies",
        lambda stage: (
            "parse refused: capy-kb-parser-v4-pilot down" if stage == "parse" else None
        ),
    )
    monkeypatch.setattr(
        ingest, "STAGE_RUNNERS", dict.fromkeys(ingest.STAGES, lambda *a: 0)
    )
    store.set_setting("ingest", "running")
    ingest.run_book(queue_book(tmp_path))
    book = store.book(SHA)
    assert book["status"] == "queued" and book["stage"] == "parse"
    assert store.setting("ingest") == "paused"
    assert (
        store.setting("ingest_notice") == "parse refused: capy-kb-parser-v4-pilot down"
    )
    assert store.stage_runs(SHA) == []


def test_batch_stages_wait_on_their_task_then_resume_when_the_poll_finds_it_terminal(
    tmp_path, monkeypatch
):
    trace = []
    monkeypatch.setattr(ingest, "check_dependencies", lambda stage: None)
    monkeypatch.setattr(ingest, "published_version", lambda run_dir, book_id: 1)
    monkeypatch.setattr(store, "BOOKS_JSON", tmp_path / "books.json")

    def runner(book, run_dir, log):
        trace.append(log.stem)
        if log.stem in ingest.BATCH_STAGES and store.review_task(SHA, log.stem) is None:
            store.set_review_task(
                SHA,
                log.stem,
                batch_id=f"batch-{log.stem}",
                status="in_progress",
                submitted_at=1.0,
                checked_at=1.0,
                requests=4,
            )
            return ingest.WAITING
        return 0

    monkeypatch.setattr(ingest, "STAGE_RUNNERS", dict.fromkeys(ingest.STAGES, runner))
    store.set_setting("ingest", "running")
    ingest.run_book(queue_book(tmp_path))
    book = store.book(SHA)
    assert book["status"] == "waiting" and book["stage"] == "transcribe"
    assert store.stage_runs(SHA)[-1]["exit_code"] == ingest.WAITING
    # the poll is due (checked_at is old); an in-flight task keeps waiting
    polled = []
    monkeypatch.setattr(
        batches, "poll", lambda sha, stage: polled.append(stage) or "in_progress"
    )
    assert ingest.poll_waiting() and store.book(SHA)["status"] == "waiting"
    monkeypatch.setattr(
        batches, "poll", lambda sha, stage: polled.append(stage) or "completed"
    )
    assert ingest.poll_waiting() and store.book(SHA)["status"] == "queued"
    ingest.run_book(store.book(SHA))
    assert store.book(SHA)["status"] == "waiting" and store.book(SHA)["stage"] == "tag"
    assert ingest.poll_waiting() and store.book(SHA)["status"] == "queued"
    ingest.run_book(store.book(SHA))
    assert trace == [
        "parse",
        "figures",
        "topics",
        "transcribe",
        "transcribe",
        "tag",
        "tag",
        "index",
        "publish",
    ]
    assert polled == ["transcribe", "transcribe", "tag"]
    assert store.book(SHA)["status"] == "published"
    # a task checked within the interval is not polled again
    store.set_book(SHA, status="waiting", stage="tag")
    store.set_review_task(SHA, "tag", checked_at=9e12)
    assert not ingest.poll_waiting()


def test_publish_refuses_while_a_held_chunk_is_undecided(tmp_path):
    run_dir = tmp_path / "runs/b"
    run_dir.mkdir(parents=True)
    (run_dir / "transcribe.json").write_text(
        json.dumps({"held": [{"chunk_id": "chk_1", "decision": None}]}),
        encoding="utf-8",
    )
    log = tmp_path / "publish.log"
    assert ingest.run_publish({"sha256": SHA}, run_dir, log) == 1
    assert "1 held chunks undecided (chk_1)" in log.read_text(encoding="utf-8")


def test_first_content_page_skips_front_matter_and_shared_prefixes():
    chunks = [
        {"section_path": "Table of Contents › 1 Data", "page_start": 3},
        {"section_path": "Preface", "page_start": 7},
        {"section_path": "1 Data collection", "page_start": 9},
        {"section_path": "1 Data collection › 1.1 Case study", "page_start": 10},
    ]
    assert ingest.first_content_page(chunks) == 9  # the chapter opener page
    assert ingest.first_content_page(chunks[:2]) is None
    # the whole book hangs under two stray headings: they are ignored
    nested = [
        {"section_path": "Contents › PREFACE › About OpenStax", "page_start": 5},
        {"section_path": "Contents › PREFACE › Motion", "page_start": 39},
    ] + [
        {
            "section_path": f"Contents › PREFACE › {ch} › {n}.{i} Speed",
            "page_start": 40 + i,
        }
        for n, ch in enumerate(("Motion", "Forces", "Energy"), 1)
        for i in range(10)
    ]
    assert ingest.first_content_page(nested) == 39
