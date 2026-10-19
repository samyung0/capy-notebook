import json
import sys

import boto3
import ingest
import pytest
import store
from pipeline.config import cfg
from pipeline.store import blobstore

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


class Bucket:
    """Records the clients built and the uploads made through them."""

    def __init__(self):
        self.clients, self.uploads = [], []

    def client(self, service, **credentials):
        self.clients.append(credentials)
        return self

    def upload_file(self, path, bucket, key, ExtraArgs):
        self.uploads.append((self.clients[-1]["aws_access_key_id"], bucket, key))


def test_source_upload_uses_only_the_writer_key(tmp_path, monkeypatch):
    """(security regression: library writer key) Retrieval's
    read key never writes the shared bucket."""
    bucket = Bucket()
    monkeypatch.setattr(boto3, "client", bucket.client)
    monkeypatch.setattr(blobstore, "library_object_info", lambda key: None)
    monkeypatch.setattr(
        blobstore, "library_client", lambda: pytest.fail("the read key wrote")
    )
    pdf = tmp_path / "book.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    book = {"sha256": SHA, "manifest": {"pdf_path": str(pdf)}}
    log = tmp_path / "publish.log"
    for name in ingest.WRITER_KEYS:
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError, match="KNOWLEDGE_BASE_B2_WRITER_KEY_ID and"):
        ingest.upload_source(book, log)
    assert bucket.uploads == []
    monkeypatch.setenv("KNOWLEDGE_BASE_B2_WRITER_KEY_ID", "writer-id")
    monkeypatch.setenv("KNOWLEDGE_BASE_B2_WRITER_APP_KEY", "writer-secret")
    ingest.upload_source(book, log)
    assert bucket.clients == [
        {
            "endpoint_url": cfg.knowledge_base_b2_endpoint,
            "region_name": cfg.knowledge_base_b2_region,
            "aws_access_key_id": "writer-id",
            "aws_secret_access_key": "writer-secret",
        }
    ]
    assert bucket.uploads == [
        ("writer-id", cfg.knowledge_base_b2_bucket, f"books/{SHA}.pdf")
    ]


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
